import type { CharKind } from '../../protocol.ts';
import type { MovementController, MoveStats } from '../movement.ts';
import { archer } from './archer.ts';
import { knight } from './knight.ts';

export interface Kit {
  controller: MovementController;
  hp: number;
  /** Multiplier on knockback taken. Light characters get launched, heavy ones barely budge. */
  knockTaken: number;
  /** Body mass when shoving against enemies and teammates. */
  mass: number;
  stats: MoveStats;
}

/** Adding a character = a controller in this folder + an entry here + a CHAR_INFO entry. */
export const KITS: Record<CharKind, Kit> = {
  archer: {
    controller: archer,
    hp: 85,
    knockTaken: 1.2,
    mass: 0.8,
    stats: { speed: 100, atkCd: 8, abCd: 90, abMax: 2, specCd: 150, specMax: 2, drawTicks: 45, guardMax: 0 },
  },
  knight: {
    controller: knight,
    hp: 140,
    knockTaken: 0.75,
    mass: 1.8,
    stats: { speed: 80, atkCd: 14, abCd: 100, abMax: 2, specCd: 1, specMax: 0, drawTicks: 1, guardMax: 100 },
  },
};

export const kitOf = (k: CharKind | undefined) => KITS[k ?? 'archer'] ?? KITS.archer;
