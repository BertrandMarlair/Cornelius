import { reportDiagnostic } from '../diagnostics';
import { BROWSER_CAMERA_MAX_BYTES } from '../../shared/camera';

export const JPEG_QUALITY_MAX = 0.7;
export const JPEG_QUALITY_MIN = 0.35;
/** Un bilan du flux caméra par minute dans les journaux : de quoi comprendre un flux saccadé. */
export const CAMERA_STATS_MS = 60_000;

export type CameraStats = {
  since: number;
  sent: number;
  acked: number;
  oversized: number;
  grabFailures: number;
  reconnects: number;
  lastSentAt: number;
  maxGapMs: number;
  maxAckMs: number;
  encodeMs: number;
};

export function newCameraStats(now = Date.now()): CameraStats {
  return {
    since: now,
    sent: 0,
    acked: 0,
    oversized: 0,
    grabFailures: 0,
    reconnects: 0,
    lastSentAt: 0,
    maxGapMs: 0,
    maxAckMs: 0,
    encodeMs: 0,
  };
}

/**
 * Qualité JPEG suivante : nettement plus basse quand l’image dépasse la taille admise, un peu
 * plus haute quand elle tient largement, jamais hors de [JPEG_QUALITY_MIN, JPEG_QUALITY_MAX].
 */
export function nextJpegQuality(quality: number, size: number): number {
  const next =
    size > BROWSER_CAMERA_MAX_BYTES
      ? quality - 0.1
      : size < BROWSER_CAMERA_MAX_BYTES * 0.5
        ? quality + 0.02
        : quality;
  return Math.round(Math.min(JPEG_QUALITY_MAX, Math.max(JPEG_QUALITY_MIN, next)) * 100) / 100;
}

export function recordSent(stats: CameraStats, now: number): void {
  if (stats.lastSentAt) stats.maxGapMs = Math.max(stats.maxGapMs, now - stats.lastSentAt);
  stats.lastSentAt = now;
  stats.sent++;
}

export function recordAck(stats: CameraStats, ms: number): void {
  stats.acked++;
  stats.maxAckMs = Math.max(stats.maxAckMs, ms);
}

export function reportCameraStats(
  stats: CameraStats,
  context: { hidden: boolean; quality: number; width: number; height: number },
): void {
  const seconds = Math.max(1, (Date.now() - stats.since) / 1000);
  const { since: _since, lastSentAt: _last, ...counts } = stats;
  // Le schéma des diagnostics n’a que des champs texte : le bilan voyage dans message.
  const summary = new Error(
    JSON.stringify({ fps: Math.round((stats.sent / seconds) * 10) / 10, ...counts, ...context }),
  );
  summary.name = 'stats';
  reportDiagnostic('info', 'flux caméra du miroir', summary);
}
