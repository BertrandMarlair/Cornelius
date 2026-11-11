import { readFileSync } from 'node:fs';
import type { MachineStatus } from '../shared/types.js';

/**
 * Largeur de l’image où chercher les visages, sur toutes les machines. YuNet est entraîné
 * pour ~640 px : sur une image 1080p, un visage proche tombait sous le seuil de détection
 * (0,73-0,80 au lieu de 0,92-0,94) et des doublons fantômes apparaissaient. La
 * reconnaissance, elle, reste faite sur l’image entière.
 */
export const FACE_DETECTION_WIDTH = 640;

/** Raison affichée là où la vision et le générateur d’images locaux sont retirés. */
export function smallMachineReason(machine: MachineStatus): string {
  return machine.board?.startsWith('Raspberry Pi')
    ? 'Non proposé sur Raspberry Pi : la machine est trop juste.'
    : 'Non proposé sur cette machine, déclarée petite (CORNELIUS_SMALL_MACHINE).';
}

function boardModel(): string | null {
  try {
    // Le device tree termine le nom par un octet nul.
    return readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Raspberry Pi (4, 5 et leurs variantes) : petite machine. CORNELIUS_SMALL_MACHINE impose 1 ou 0,
 * comme dans scripts/lib.sh qui en tient compte à l’installation.
 */
export function detectMachine(
  env: NodeJS.ProcessEnv = process.env,
  readBoard: () => string | null = boardModel,
  arch: string = process.arch,
): MachineStatus {
  const board = readBoard();
  const forced = (env.CORNELIUS_SMALL_MACHINE ?? '').trim().toLowerCase();
  const small = ['1', 'true', 'oui', 'yes'].includes(forced)
    ? true
    : ['0', 'false', 'non', 'no'].includes(forced)
      ? false
      : !!board?.startsWith('Raspberry Pi');
  return { arch, board, small };
}
