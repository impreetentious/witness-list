/**
 * Radix-2 NTT/iNTT over Goldilocks + coset LDE (blowup 8). M1.
 * Gate Z3: iNTT∘NTT = id up to 2^13; NTT = naive DFT for n ≤ 64.
 */
import type { Fp } from './field';

/** In-place iterative Cooley–Tukey over subgroup of size a.length (power of two). */
export function ntt(_a: Fp[]): Fp[] {
  throw new Error('TODO(M1): bit-reversal + butterflies, roots from twoAdicRoot');
}

export function intt(_a: Fp[]): Fp[] {
  throw new Error('TODO(M1): inverse roots + n^-1 scale');
}

/** Evaluate coeffs on the coset g·⟨ω'⟩ of size n·blowup: scale coeffs by g^i, then NTT. */
export function cosetLDE(_coeffs: Fp[], _blowup: number): Fp[] {
  throw new Error('TODO(M1)');
}

/** Interpolate values over H (size n) back to coefficients. */
export function interpolate(_valuesOnH: Fp[]): Fp[] {
  throw new Error('TODO(M1): iNTT');
}
