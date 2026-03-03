/** Copy-permutation grand product over Fp² challenges (protocol v2). */
import type { Fp } from '../field';
import { mul as mulBase, twoAdicRoot } from '../field';
import type { Fp2 } from '../fp2';
import { add, embed, fp2One, inv, isZero, mul } from '../fp2';
import type { CompiledCircuit, Witness } from '../circuit/compile';
import { K1, K2 } from './permutation';

export interface PermutationFactorsFp2 { numerators: Fp2[]; denominators: Fp2[] }
export interface GrandProductFp2 extends PermutationFactorsFp2 { z: Fp2[]; partials: Fp2[] }

function powersOnH(n: number): Fp[] {
  const omega = twoAdicRoot(Math.log2(n));
  const powers = Array.from<Fp>({ length: n }).fill(0n);
  powers[0] = 1n;
  for (let row = 1; row < n; row++) powers[row] = mulBase(powers[row - 1]!, omega);
  return powers;
}

function slotPoint(slot: number, n: number, powers: readonly Fp[]): Fp {
  if (slot < n) return powers[slot]!;
  if (slot < 2 * n) return mulBase(K1, powers[slot - n]!);
  if (slot < 3 * n) return mulBase(K2, powers[slot - 2 * n]!);
  throw new Error('Fp² permutation slot outside 3n');
}

function factor(wire: Fp, beta: Fp2, point: Fp, gamma: Fp2): Fp2 {
  return add(add(embed(wire), mul(beta, embed(point))), gamma);
}

export function permutationFactorsFp2(circuit: CompiledCircuit, witness: Witness, beta: Fp2, gamma: Fp2): PermutationFactorsFp2 {
  const powers = powersOnH(circuit.n);
  const numerators = Array.from({ length: circuit.n }, () => fp2One);
  const denominators = Array.from({ length: circuit.n }, () => fp2One);
  for (let row = 0; row < circuit.n; row++) {
    const x = powers[row]!;
    numerators[row] = mul(mul(
      factor(witness.a[row]!, beta, x, gamma),
      factor(witness.b[row]!, beta, mulBase(K1, x), gamma),
    ), factor(witness.c[row]!, beta, mulBase(K2, x), gamma));
    denominators[row] = mul(mul(
      factor(witness.a[row]!, beta, slotPoint(circuit.sigma[row]!, circuit.n, powers), gamma),
      factor(witness.b[row]!, beta, slotPoint(circuit.sigma[circuit.n + row]!, circuit.n, powers), gamma),
    ), factor(witness.c[row]!, beta, slotPoint(circuit.sigma[2 * circuit.n + row]!, circuit.n, powers), gamma));
  }
  return { numerators, denominators };
}

export function buildGrandProductFp2(circuit: CompiledCircuit, witness: Witness, beta: Fp2, gamma: Fp2): GrandProductFp2 {
  const { numerators, denominators } = permutationFactorsFp2(circuit, witness, beta, gamma);
  const z = Array.from({ length: circuit.n }, () => fp2One);
  const partials = Array.from({ length: circuit.n }, () => fp2One);
  let running = fp2One;
  for (let row = 0; row < circuit.n; row++) {
    if (isZero(denominators[row]!)) throw new Error(`Fp² grand-product denominator is zero at row ${row}`);
    running = mul(running, mul(numerators[row]!, inv(denominators[row]!)));
    partials[row] = running;
    if (row + 1 < circuit.n) z[row + 1] = running;
  }
  return { z, partials, numerators, denominators };
}
