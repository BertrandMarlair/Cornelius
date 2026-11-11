# Surveillance : relance le serveur ou la perception s'ils se sont arrêtés (plantage, mémoire),
# tant que Cornelius est censé tourner. scripts\start.ps1 l'arme (fichier d'état),
# scripts\stop.ps1 la désarme : un arrêt voulu n'est jamais annulé.
# Usage (tâche planifiée « Cornelius - Surveillance », au démarrage de Windows) :
#   powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\watch.ps1 [-IntervalSeconds 15]
[CmdletBinding()]
param(
  [int]$IntervalSeconds = 15,
  # Échecs de /api/health d'affilée avant de relancer un serveur vivant mais bloqué.
  [int]$UnhealthyChecks = 4
)

. (Join-Path $PSScriptRoot 'lib.ps1')
Initialize-CorneliusDirs

$WatchLog = Join-Path $LogDir 'watch.log'
function Write-WatchLog([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $WatchLog -Value $line -Encoding UTF8
}

# Le journal d'erreurs du processus mort est gardé : il dit pourquoi il est tombé.
function Save-CrashLog([string]$Name) {
  $source = Join-Path $LogDir "$Name.err.log"
  if (Test-Path -LiteralPath $source) {
    $target = Join-Path $LogDir ('{0}.crash-{1}.log' -f $Name, (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Copy-Item -LiteralPath $source -Destination $target -Force
    # Seulement les dix derniers.
    Get-ChildItem -LiteralPath $LogDir -Filter "$Name.crash-*.log" |
      Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | Remove-Item -Force
  }
}

function Test-CorneliusHealthy([int]$Port) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 5
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

Write-WatchLog 'Surveillance démarrée.'
$failures = 0
# Un processus absent n'est relancé qu'au deuxième contrôle d'affilée : un arrêt ou un
# démarrage en cours a le temps de poser ou de retirer le fichier d'état.
$backendMissing = 0
$perceptionMissing = 0
while ($true) {
  Start-Sleep -Seconds $IntervalSeconds
  try {
    # Pas de fichier d'état : arrêté volontairement, ou démarrage/mise à jour en cours.
    if (-not (Test-Path -LiteralPath $StateFile)) {
      $failures = $backendMissing = $perceptionMissing = 0
      continue
    }
    $state = Get-CorneliusState
    $port = Get-CorneliusPort
    $changed = $false

    $backendPid = Get-CorneliusPortOwner -Port $port
    if ($backendPid -le 0 -and ++$backendMissing -lt 2) {
      # Premier constat : on attend le contrôle suivant.
    } elseif ($backendPid -le 0 -and (Test-Path -LiteralPath $StateFile)) {
      $backendMissing = 0
      Save-CrashLog 'backend'
      Write-WatchLog "Serveur arrêté : relance."
      $node = Resolve-CorneliusNode
      $null = Start-CorneliusBackend -State $state -Port $port -Node $node
      $failures = 0
      $changed = $true
    } elseif (Test-CorneliusHealthy -Port $port) {
      $failures = $backendMissing = 0
    } elseif (++$failures -ge $UnhealthyChecks) {
      Save-CrashLog 'backend'
      Write-WatchLog "Serveur sans réponse ($failures contrôles) : relance."
      Stop-CorneliusTree -ProcessId $backendPid | Out-Null
      Start-Sleep -Seconds 2
      $node = Resolve-CorneliusNode
      $null = Start-CorneliusBackend -State $state -Port $port -Node $node
      $failures = 0
      $changed = $true
    }

    $perceptionDown = $state.ContainsKey('perception') -and @(Get-CorneliusWorkerPids).Count -eq 0
    if (-not $perceptionDown) {
      $perceptionMissing = 0
    } elseif (++$perceptionMissing -ge 2 -and (Test-Path -LiteralPath $StateFile)) {
      $perceptionMissing = 0
      Save-CrashLog 'perception'
      Write-WatchLog 'Perception arrêtée : relance.'
      Start-CorneliusPerception -State $state
      $changed = $true
    }

    if ($changed) { Set-CorneliusState -State $state }
  } catch {
    Write-WatchLog ("Erreur de surveillance : " + $_.Exception.Message)
  }
}
