/** Preset 4: age ≥ 18 through a seven-bit decomposition. */
import type { Fp } from '../../field';
import type { Circuit } from '../ir';
import { PresetBuilder } from './builder';

export interface AgePreset {
  circuit: Circuit;
  ageWire: number;
  bitWires: number[];
}

function buildAge(): AgePreset {
  const builder = new PresetBuilder();
  const ageWire = builder.priv();
  const bitWires = Array.from({ length: 7 }, () => builder.priv());
  const minusOne = builder.constant(-1n);
  const minusEighteen = builder.constant(-18n);
  const powersOfTwo = Array.from({ length: 7 }, (_, bit) => builder.constant(1n << BigInt(bit)));

  const difference = builder.add(ageWire, minusEighteen);
  for (const bit of bitWires) {
    builder.assertZero(builder.mul(bit, builder.add(bit, minusOne)));
  }

  let recomposed = bitWires[0]!;
  for (let bit = 1; bit < bitWires.length; bit++) {
    recomposed = builder.add(recomposed, builder.mul(bitWires[bit]!, powersOfTwo[bit]!));
  }
  builder.assertZero(builder.add(recomposed, builder.mul(difference, minusOne)));
  return { circuit: builder.build('Age over 18', []), ageWire, bitWires };
}

export const agePreset = buildAge();
export const age = agePreset.circuit;

export function ageInputs(ageValue: Fp = 21n): Map<number, Fp> {
  if (ageValue < 18n || ageValue > 145n) {
    throw new Error('Age preset accepts ages in [18, 145] so age − 18 fits in seven bits');
  }
  const inputs = new Map<number, Fp>([[agePreset.ageWire, ageValue]]);
  const offset = ageValue - 18n;
  for (let bit = 0; bit < agePreset.bitWires.length; bit++) {
    inputs.set(agePreset.bitWires[bit]!, (offset >> BigInt(bit)) & 1n);
  }
  return inputs;
}
