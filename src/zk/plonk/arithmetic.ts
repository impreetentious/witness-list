/** Shared PLONK evaluation helpers. docs/PROTOCOL-SPEC.md §§4.2–4.3, 4.8. */
import { GENERATOR, add, mul, neg, pow, twoAdicRoot } from '../field';
import type { Fp } from '../field';
import { evalAt, lagrangeAt } from '../poly';
import type { Poly } from '../poly';
import { interpolate } from '../ntt';
import type { CompiledCircuit } from '../circuit/compile';
import { K1, K2 } from './permutation';

function domainPowers(n: number): Fp[] {
  const omega = twoAdicRoot(Math.log2(n));
  const powers = Array.from<Fp>({ length: n }).fill(0n);
  powers[0] = 1n;
  for (let row = 1; row < n; row++) powers[row] = mul(powers[row - 1]!, omega);
  return powers;
}

function slotPoint(slot: number, n: number, powers: Fp[]): Fp {
  if (slot < n) return powers[slot]!;
  if (slot < 2 * n) return mul(K1, powers[slot - n]!);
  if (slot < 3 * n) return mul(K2, powers[slot - 2 * n]!);
  throw new Error(`sigma references slot ${slot} outside 3n`);
}

export function selectorPolynomials(circuit: CompiledCircuit): Poly[] {
  return [circuit.qL, circuit.qR, circuit.qO, circuit.qM, circuit.qC].map(interpolate);
}

export function sigmaPolynomials(circuit: CompiledCircuit): [Poly, Poly, Poly] {
  const powers = domainPowers(circuit.n);
  const values = [0, 1, 2].map((column) =>
    Array.from({ length: circuit.n }, (_, row) =>
      slotPoint(circuit.sigma[column * circuit.n + row]!, circuit.n, powers),
    ),
  );
  return [interpolate(values[0]!), interpolate(values[1]!), interpolate(values[2]!)];
}

/** PI(ζ) is verifier-owned and recomputed barycentrically. docs/PROTOCOL-SPEC.md §4.3. */
export function publicInputAt(publicInputs: readonly Fp[], n: number, zeta: Fp): Fp {
  let value = 0n;
  for (let row = 0; row < publicInputs.length; row++) {
    value = add(value, mul(neg(publicInputs[row]!), lagrangeAt(row, n, zeta)));
  }
  return value;
}

export function omegaTimes(zeta: Fp, n: number): Fp {
  return mul(twoAdicRoot(Math.log2(n)), zeta);
}

export function zetaIsInTraceDomain(zeta: Fp, n: number): boolean {
  return pow(zeta, BigInt(n)) === 1n;
}

export function zetaIsInLdeCoset(zeta: Fp, n: number, blowup: number): boolean {
  const size = BigInt(n * blowup);
  return pow(zeta, size) === pow(GENERATOR, size);
}

export function selectorsAt(selectorPolys: readonly Poly[], zeta: Fp): Fp[] {
  return selectorPolys.map((polynomial) => evalAt(polynomial, zeta));
}
