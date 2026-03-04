/** Preset 4: age ≥ 18 through a protocol-bound lookup range. */
import type { Fp } from '../../field';
import type { Circuit } from '../ir';
import { PresetBuilder } from './builder';

export interface AgePreset {
  circuit: Circuit;
  ageWire: number;
  /** Retained for caller compatibility; v2 lookup ranges need no auxiliary bits. */
  bitWires: number[];
}

function buildAge(): AgePreset {
  const builder = new PresetBuilder();
  const ageWire = builder.priv();
  builder.lookup(ageWire);
  const lookupTable = Array.from({ length: 128 }, (_, offset) => BigInt(18 + offset));
  return { circuit: builder.build('Age over 18', [], lookupTable), ageWire, bitWires: [] };
}

export const agePreset = buildAge();
export const age = agePreset.circuit;

export function ageInputs(ageValue: Fp = 21n): Map<number, Fp> {
  if (ageValue < 18n || ageValue > 145n) {
    throw new Error('Age preset accepts ages in the inclusive lookup table [18, 145]');
  }
  return new Map<number, Fp>([[agePreset.ageWire, ageValue]]);
}
