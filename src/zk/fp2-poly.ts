/** docs/PROTOCOL-SPEC.md §4.4 — Polynomial helpers over Fp². Domains remain base-field roots of unity. */
import type { Fp } from './field';
import { inv as invBase, mul as mulBase, neg as negBase, twoAdicRoot } from './field';
import type { Fp2 } from './fp2';
import { add, embed, equal, fp2One, fp2Zero, inv, isZero, mul, sub } from './fp2';
import { cosetEvaluate, interpolate } from './ntt';
import { polyDivRem, vanishing } from './poly';

export type Fp2Poly = Fp2[];

function trim(poly: Fp2Poly): Fp2Poly {
  let end = poly.length;
  while (end > 0 && isZero(poly[end - 1]!)) end--;
  return poly.slice(0, end);
}

export function fp2PolyAdd(left: readonly Fp2[], right: readonly Fp2[]): Fp2Poly {
  return trim(
    Array.from({ length: Math.max(left.length, right.length) }, (_, index) =>
      add(left[index] ?? fp2Zero, right[index] ?? fp2Zero),
    ),
  );
}

export function fp2PolySub(left: readonly Fp2[], right: readonly Fp2[]): Fp2Poly {
  return trim(
    Array.from({ length: Math.max(left.length, right.length) }, (_, index) =>
      sub(left[index] ?? fp2Zero, right[index] ?? fp2Zero),
    ),
  );
}

export function fp2PolyScale(poly: readonly Fp2[], scalar: Fp2): Fp2Poly {
  return isZero(scalar) ? [] : trim(poly.map((coefficient) => mul(coefficient, scalar)));
}

export function fp2PolyMul(left: readonly Fp2[], right: readonly Fp2[]): Fp2Poly {
  if (left.length === 0 || right.length === 0) return [];
  const output = Array.from({ length: left.length + right.length - 1 }, () => fp2Zero);
  for (let i = 0; i < left.length; i++) {
    for (let j = 0; j < right.length; j++)
      output[i + j] = add(output[i + j]!, mul(left[i]!, right[j]!));
  }
  return trim(output);
}

export function embedPoly(poly: readonly Fp[]): Fp2Poly {
  return poly.map(embed);
}

export function interpolateFp2(values: readonly Fp2[]): Fp2Poly {
  const c0 = interpolate(values.map((value) => value.c0));
  const c1 = interpolate(values.map((value) => value.c1));
  return trim(
    Array.from({ length: Math.max(c0.length, c1.length) }, (_, index) => ({
      c0: c0[index] ?? 0n,
      c1: c1[index] ?? 0n,
    })),
  );
}

export function cosetEvaluateFp2(coefficients: readonly Fp2[], domainSize: number): Fp2[] {
  const c0 = cosetEvaluate(
    coefficients.map((value) => value.c0),
    domainSize,
  );
  const c1 = cosetEvaluate(
    coefficients.map((value) => value.c1),
    domainSize,
  );
  return c0.map((value, index) => ({ c0: value, c1: c1[index]! }));
}

export function evalFp2(poly: readonly Fp2[], point: Fp2): Fp2 {
  let value = fp2Zero;
  for (let index = poly.length - 1; index >= 0; index--)
    value = add(mul(value, point), poly[index]!);
  return value;
}

export function evalBaseAtFp2(poly: readonly Fp[], point: Fp2): Fp2 {
  let value = fp2Zero;
  for (let index = poly.length - 1; index >= 0; index--)
    value = add(mul(value, point), embed(poly[index]!));
  return value;
}

/** Divide an Fp² polynomial by X^n-1 componentwise. */
export function divideByVanishingFp2(poly: readonly Fp2[], n: number): { q: Fp2Poly; r: Fp2Poly } {
  const divisor = vanishing(n);
  const c0 = polyDivRem(
    poly.map((value) => value.c0),
    divisor,
  );
  const c1 = polyDivRem(
    poly.map((value) => value.c1),
    divisor,
  );
  const q = trim(
    Array.from({ length: Math.max(c0.q.length, c1.q.length) }, (_, index) => ({
      c0: c0.q[index] ?? 0n,
      c1: c1.q[index] ?? 0n,
    })),
  );
  const r = trim(
    Array.from({ length: Math.max(c0.r.length, c1.r.length) }, (_, index) => ({
      c0: c0.r[index] ?? 0n,
      c1: c1.r[index] ?? 0n,
    })),
  );
  return { q, r };
}

export function rotateFp2(poly: readonly Fp2[], omega: Fp): Fp2Poly {
  let power = 1n;
  return poly.map((coefficient) => {
    const result = mul(coefficient, embed(power));
    power = mulBase(power, omega);
    return result;
  });
}

export function lagrangeFp2(row: number, n: number, point: Fp2): Fp2 {
  if (!Number.isSafeInteger(row) || row < 0 || row >= n)
    throw new Error('Fp² Lagrange row outside domain');
  const omega = twoAdicRoot(Math.log2(n));
  let omegaRow = 1n;
  for (let index = 0; index < row; index++) omegaRow = mulBase(omegaRow, omega);
  const numerator = sub(fp2Pow(point, BigInt(n)), fp2One);
  const denominator = sub(point, embed(omegaRow));
  return mul(embed(mulBase(omegaRow, invBase(BigInt(n)))), mul(numerator, inv(denominator)));
}

function fp2Pow(base: Fp2, exponent: bigint): Fp2 {
  let result = fp2One;
  let value = base;
  let power = exponent;
  while (power > 0n) {
    if ((power & 1n) === 1n) result = mul(result, value);
    value = mul(value, value);
    power >>= 1n;
  }
  return result;
}

export function publicInputAtFp2(publicInputs: readonly Fp[], n: number, point: Fp2): Fp2 {
  let value = fp2Zero;
  for (let row = 0; row < publicInputs.length; row++) {
    value = add(value, mul(embed(negBase(publicInputs[row]!)), lagrangeFp2(row, n, point)));
  }
  return value;
}

export function fp2PolyEqual(left: readonly Fp2[], right: readonly Fp2[]): boolean {
  const a = trim(left.slice());
  const b = trim(right.slice());
  return a.length === b.length && a.every((value, index) => equal(value, b[index]!));
}
