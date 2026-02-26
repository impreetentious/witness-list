/**
 * Copy constraints: σ polynomials + grand product Z with running-product log
 * (the telescoping column the UI renders). M4.
 * Gate Z5: hand-built 4-row case telescopes to 1; one broken copy ⇒ Z(end) ≠ 1.
 */
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

export function buildGrandProduct(
  _cc: CompiledCircuit,
  _w: Witness,
  _beta: Fp,
  _gamma: Fp,
): GrandProduct {
  throw new Error('TODO(M4)');
}
