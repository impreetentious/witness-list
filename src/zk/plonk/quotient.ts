/**
 * Constraint composition C(x) and quotient t = C / Z_H with exact-division check —
 * the pedagogical heart: nonzero remainder rows ARE "the equation that catches you".
 * M4. Gate Z6.
 */
import type { Fp } from '../field';
import type { Poly } from '../poly';

export interface QuotientResult {
  tLo: Poly;
  tMid: Poly;
  tHi: Poly;
  /** remainder evaluations over H — all zero iff the witness satisfies the circuit */
  remainderOnH: Fp[];
  exact: boolean;
}

export function buildQuotient(
  _composed: Poly, // gate + PI + α·transition + α²·boundary
  _n: number,
): QuotientResult {
  throw new Error('TODO(M4): divide by Z_H, split into 3 chunks');
}
