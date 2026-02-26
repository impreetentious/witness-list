/**
 * Coefficient-form polynomial ops. M1.
 * A Poly is Fp[] with poly[i] the x^i coefficient; trailing zeros trimmed.
 */
import type { Fp } from './field';

export type Poly = Fp[];

export function polyAdd(_a: Poly, _b: Poly): Poly {
  throw new Error('TODO(M1)');
}

export function polyMul(_a: Poly, _b: Poly): Poly {
  throw new Error('TODO(M1): schoolbook < 64, NTT-based above');
}

/** Division with remainder. The quotient gate (Z6) depends on exactness detection. */
export function polyDivRem(_a: Poly, _b: Poly): { q: Poly; r: Poly } {
  throw new Error('TODO(M1)');
}

/** Z_H = x^n − 1; on the LDE coset it never vanishes. */
export function vanishing(_n: number): Poly {
  throw new Error('TODO(M1)');
}

/** Barycentric L_i(ζ) = (ω^i/n)·(ζ^n−1)/(ζ−ω^i) — used by the verifier for PI(ζ). */
export function lagrangeAt(_i: number, _n: number, _zeta: Fp): Fp {
  throw new Error('TODO(M1)');
}

export function evalAt(_p: Poly, _x: Fp): Fp {
  throw new Error('TODO(M1): Horner');
}
