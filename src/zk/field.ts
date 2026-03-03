/**
 * Goldilocks field F_p, p = 2^64 − 2^32 + 1.
 * IMPLEMENTED (scaffold anchor) — tested against independently computed vectors
 * (regenerable via tools/reference.py).
 *
 * BigInt throughout: correct-by-construction and fast enough at workshop sizes
 * (budget: LDE of 2^13 < 100 ms, measured at M1).
 */

export const P = 18446744069414584321n; // 2^64 - 2^32 + 1
export const GENERATOR = 7n; // verified primitive root
export const TWO_ADICITY = 32; // p - 1 = 2^32 · 3 · 5 · 17 · 257 · 65537

export type Fp = bigint; // invariant: 0 <= x < P

export function mod(x: bigint): Fp {
  const r = x % P;
  return r < 0n ? r + P : r;
}

export function add(a: Fp, b: Fp): Fp {
  const s = a + b;
  return s >= P ? s - P : s;
}

export function sub(a: Fp, b: Fp): Fp {
  const d = a - b;
  return d < 0n ? d + P : d;
}

export function neg(a: Fp): Fp {
  return a === 0n ? 0n : P - a;
}

export function mul(a: Fp, b: Fp): Fp {
  return (a * b) % P;
}

export function pow(base: Fp, e: bigint): Fp {
  let b = base % P;
  let r = 1n;
  let k = e;
  while (k > 0n) {
    if (k & 1n) r = (r * b) % P;
    b = (b * b) % P;
    k >>= 1n;
  }
  return r;
}

/** Fermat inversion. inv(0) throws. */
export function inv(a: Fp): Fp {
  if (a === 0n) throw new Error('inv(0)');
  return pow(a, P - 2n);
}

/**
 * Montgomery batch inversion — one inv + 3(n−1) muls.
 * Used for DEEP quotient denominators.
 */
export function batchInverse(xs: readonly Fp[]): Fp[] {
  const n = xs.length;
  const out = Array.from<Fp>({ length: n }).fill(0n);
  let acc = 1n;
  for (let i = 0; i < n; i++) {
    out[i] = acc;
    const x = xs[i]!;
    if (x === 0n) throw new Error(`batchInverse: zero at ${i}`);
    acc = (acc * x) % P;
  }
  let accInv = inv(acc);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = (out[i]! * accInv) % P;
    accInv = (accInv * xs[i]!) % P;
  }
  return out;
}

/** Generator of the multiplicative subgroup of order 2^k (k ≤ 32). */
export function twoAdicRoot(k: number): Fp {
  if (k < 0 || k > TWO_ADICITY) throw new Error(`no 2^${k} root of unity`);
  return pow(GENERATOR, (P - 1n) >> BigInt(k));
}

/** Uniform field element from a seeded 64-bit draw with rejection. */
export function fromU64Rejecting(draw: () => bigint): Fp {
  for (;;) {
    const x = draw();
    if (x < P) return x;
  }
}
