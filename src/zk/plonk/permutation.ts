/**
 * Copy constraints: σ polynomials + grand product Z with running-product log
 * (the telescoping column the UI renders). docs/PROTOCOL-SPEC.md §4.3.
 * Gate Z5: hand-built 4-row case telescopes to 1; one broken copy ⇒ Z(end) ≠ 1.
 */
import { add, inv, mul, twoAdicRoot } from '../field';
import type { Fp } from '../field';
import type { CompiledCircuit, Witness } from '../circuit/compile';

export const K1: Fp = 7n; // b-slot coset shift (order of 7 is p−1 > n ⇒ cosets disjoint)
export const K2: Fp = 49n; // c-slot coset shift

export interface GrandProduct {
  /** Z evaluated over H (Z[0] = 1) */
  z: Fp[];
  /** per-row partial products — the telescoping visualization payload */
  partials: Fp[];
}

export interface PermutationFactors {
  numerators: Fp[];
  denominators: Fp[];
}

function slotPoint(slot: number, n: number, powers: Fp[]): Fp {
  if (slot < n) return powers[slot]!;
  if (slot < 2 * n) return mul(K1, powers[slot - n]!);
  if (slot < 3 * n) return mul(K2, powers[slot - 2 * n]!);
  throw new Error(`sigma references slot ${slot} outside 3n`);
}

function product3(a: Fp, b: Fp, c: Fp): Fp {
  return mul(mul(a, b), c);
}

function powersOnH(n: number): Fp[] {
  const omega = twoAdicRoot(Math.log2(n));
  const powers = Array.from<Fp>({ length: n }).fill(0n);
  powers[0] = 1n;
  for (let i = 1; i < n; i++) powers[i] = mul(powers[i - 1]!, omega);
  return powers;
}

function assertCompatible(cc: CompiledCircuit, witness: Witness): void {
  const { n } = cc;
  if ((n & (n - 1)) !== 0 || n < 1) throw new Error('permutation needs a power-of-two row domain');
  if (witness.a.length !== n || witness.b.length !== n || witness.c.length !== n) {
    throw new Error('witness dimensions do not match the compiled circuit');
  }
  if (cc.sigma.length !== 3 * n) throw new Error('sigma must map exactly 3n slots');
}

/** Numerator/denominator factors for the transition constraint in docs/PROTOCOL-SPEC.md §4.3. */
export function permutationFactors(
  cc: CompiledCircuit,
  witness: Witness,
  beta: Fp,
  gamma: Fp,
): PermutationFactors {
  assertCompatible(cc, witness);
  const { n } = cc;
  const powers = powersOnH(n);
  const numerators = Array.from<Fp>({ length: n }).fill(0n);
  const denominators = Array.from<Fp>({ length: n }).fill(0n);
  for (let row = 0; row < n; row++) {
    const idA = powers[row]!;
    const idB = mul(K1, idA);
    const idC = mul(K2, idA);
    numerators[row] = product3(
      add(add(witness.a[row]!, mul(beta, idA)), gamma),
      add(add(witness.b[row]!, mul(beta, idB)), gamma),
      add(add(witness.c[row]!, mul(beta, idC)), gamma),
    );
    denominators[row] = product3(
      add(add(witness.a[row]!, mul(beta, slotPoint(cc.sigma[row]!, n, powers))), gamma),
      add(add(witness.b[row]!, mul(beta, slotPoint(cc.sigma[n + row]!, n, powers))), gamma),
      add(add(witness.c[row]!, mul(beta, slotPoint(cc.sigma[2 * n + row]!, n, powers))), gamma),
    );
  }
  return { numerators, denominators };
}

export function buildGrandProduct(
  cc: CompiledCircuit,
  witness: Witness,
  beta: Fp,
  gamma: Fp,
): GrandProduct {
  assertCompatible(cc, witness);
  const { n } = cc;
  const { numerators, denominators } = permutationFactors(cc, witness, beta, gamma);

  const z = Array.from<Fp>({ length: n }).fill(0n);
  const partials = Array.from<Fp>({ length: n }).fill(0n);
  z[0] = 1n;
  let running = 1n;
  for (let row = 0; row < n; row++) {
    const denominator = denominators[row]!;
    if (denominator === 0n) throw new Error(`grand product denominator is zero at row ${row}`);
    running = mul(running, mul(numerators[row]!, inv(denominator)));
    partials[row] = running;
    if (row + 1 < n) z[row + 1] = running;
  }
  return { z, partials };
}
