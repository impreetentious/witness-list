/**
 * Coefficient-form polynomial ops. docs/PROTOCOL-SPEC.md §4.2, §4.4.
 * A Poly is Fp[] with poly[i] the x^i coefficient; trailing zeros trimmed.
 */
import { P, add, inv, mul, pow, sub, twoAdicRoot } from './field';
import type { Fp } from './field';

export type Poly = Fp[];

function trim(p: Poly): Poly {
  let end = p.length;
  while (end > 0 && p[end - 1] === 0n) end--;
  return p.slice(0, end);
}

export function polyAdd(a: Poly, b: Poly): Poly {
  const out = Array.from<Fp>({ length: Math.max(a.length, b.length) }).fill(0n);
  for (let i = 0; i < out.length; i++) out[i] = add(a[i] ?? 0n, b[i] ?? 0n);
  return trim(out);
}

export function polyScale(p: Poly, scalar: Fp): Poly {
  if (scalar === 0n || p.length === 0) return [];
  return trim(p.map((coefficient) => mul(coefficient, scalar)));
}

export function polySub(a: Poly, b: Poly): Poly {
  const out = Array.from<Fp>({ length: Math.max(a.length, b.length) }).fill(0n);
  for (let i = 0; i < out.length; i++) out[i] = sub(a[i] ?? 0n, b[i] ?? 0n);
  return trim(out);
}

/** Coefficient-form multiplication. Workshop circuits stay small enough for schoolbook multiplication. */
export function polyMul(a: Poly, b: Poly): Poly {
  if (a.length === 0 || b.length === 0) return [];
  const out = Array.from<Fp>({ length: a.length + b.length - 1 }).fill(0n);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      out[i + j] = add(out[i + j]!, mul(a[i]!, b[j]!));
    }
  }
  return trim(out);
}

/** Division with remainder. The quotient gate (Z6) depends on exactness detection. */
export function polyDivRem(a: Poly, b: Poly): { q: Poly; r: Poly } {
  const divisor = trim(b);
  if (divisor.length === 0) throw new Error('polyDivRem: division by zero polynomial');

  const remainder = trim(a);
  if (remainder.length < divisor.length) return { q: [], r: remainder };

  const quotient = Array.from<Fp>({ length: remainder.length - divisor.length + 1 }).fill(0n);
  const divisorLeadInv = inv(divisor[divisor.length - 1]!);
  while (remainder.length >= divisor.length) {
    const degreeDelta = remainder.length - divisor.length;
    const factor = mul(remainder[remainder.length - 1]!, divisorLeadInv);
    quotient[degreeDelta] = factor;
    for (let i = 0; i < divisor.length; i++) {
      const target = degreeDelta + i;
      remainder[target] = sub(remainder[target]!, mul(factor, divisor[i]!));
    }
    while (remainder.length > 0 && remainder[remainder.length - 1] === 0n) remainder.pop();
  }
  return { q: trim(quotient), r: remainder };
}

/** Z_H = x^n − 1; on the LDE coset it never vanishes (docs/PROTOCOL-SPEC.md §4.2). */
export function vanishing(n: number): Poly {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('vanishing: n must be positive');
  const out = Array.from<Fp>({ length: n + 1 }).fill(0n);
  out[0] = P - 1n;
  out[n] = 1n;
  return out;
}

/** Barycentric L_i(ζ) = (ω^i/n)·(ζ^n−1)/(ζ−ω^i) — used by the verifier for PI(ζ). */
export function lagrangeAt(i: number, n: number, zeta: Fp): Fp {
  if (!Number.isSafeInteger(n) || n < 1 || (n & (n - 1)) !== 0) {
    throw new Error('lagrangeAt: n must be a positive power of two');
  }
  if (!Number.isSafeInteger(i) || i < 0 || i >= n) {
    throw new Error(`lagrangeAt: i=${i} is outside H`);
  }
  const omega = twoAdicRoot(Math.log2(n));
  const point = pow(omega, BigInt(i));
  const denominator = sub(zeta, point);
  if (denominator === 0n) throw new Error('lagrangeAt: zeta must lie outside H');
  const numerator = mul(point, sub(pow(zeta, BigInt(n)), 1n));
  return mul(mul(numerator, inv(BigInt(n))), inv(denominator));
}

export function evalAt(p: Poly, x: Fp): Fp {
  let value = 0n;
  for (let i = p.length - 1; i >= 0; i--) value = add(mul(value, x), p[i]!);
  return value;
}
