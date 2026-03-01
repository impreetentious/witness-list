/**
 * Constraint composition C(x) and quotient t = C / Z_H with exact-division check —
 * the pedagogical heart: nonzero remainder rows ARE "the equation that catches you".
 * M4. Gate Z6.
 */
import { mul, twoAdicRoot } from '../field';
import type { Fp } from '../field';
import { evalAt, polyDivRem, vanishing } from '../poly';
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
  composed: Poly, // gate + PI + α·transition + α²·boundary
  n: number,
): QuotientResult {
  if (!Number.isSafeInteger(n) || n < 1 || (n & (n - 1)) !== 0) {
    throw new Error('quotient domain size must be a positive power of two');
  }
  const { q, r } = polyDivRem(composed, vanishing(n));
  const omega = twoAdicRoot(Math.log2(n));
  const remainderOnH = new Array<Fp>(n);
  let point = 1n;
  for (let row = 0; row < n; row++) {
    remainderOnH[row] = evalAt(r, point);
    point = mul(point, omega);
  }

  // v1's unblinded composition has degree below 3n. The later prover adds its
  // documented blinding slack before committing these same positional chunks.
  return {
    tLo: q.slice(0, n),
    tMid: q.slice(n, 2 * n),
    tHi: q.slice(2 * n, 3 * n),
    remainderOnH,
    exact: r.length === 0,
  };
}
