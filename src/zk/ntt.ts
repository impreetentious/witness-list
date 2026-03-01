/**
 * Radix-2 NTT/iNTT over Goldilocks + coset LDE (blowup 8). M1.
 * Gate Z3: iNTT∘NTT = id up to 2^13; NTT = naive DFT for n ≤ 64.
 */
import { GENERATOR, P, inv, mul, pow, twoAdicRoot } from './field';
import type { Fp } from './field';

function log2PowerOfTwo(n: number, name: string): number {
  if (!Number.isSafeInteger(n) || n < 1 || (n & (n - 1)) !== 0) {
    throw new Error(`${name}: length must be a positive power of two`);
  }
  return Math.log2(n);
}

/** Reorder an array into the bit-reversed order expected by iterative NTTs. */
function bitReverse(a: Fp[]): void {
  for (let i = 1, j = 0; i < a.length; i++) {
    let bit = a.length >> 1;
    while ((j & bit) !== 0) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) [a[i], a[j]] = [a[j]!, a[i]!];
  }
}

function transform(input: Fp[], root: Fp): Fp[] {
  const a = input.slice();
  const n = a.length;
  bitReverse(a);

  for (let width = 2; width <= n; width <<= 1) {
    const step = pow(root, BigInt(n / width));
    const half = width >> 1;
    for (let start = 0; start < n; start += width) {
      let twiddle = 1n;
      for (let offset = 0; offset < half; offset++) {
        const left = a[start + offset]!;
        const right = mul(a[start + offset + half]!, twiddle);
        a[start + offset] = left + right >= P
          ? left + right - P
          : left + right;
        a[start + offset + half] = left >= right
          ? left - right
          : left - right + P;
        twiddle = mul(twiddle, step);
      }
    }
  }
  return a;
}

/** In-place iterative Cooley–Tukey over subgroup of size a.length (power of two). */
export function ntt(a: Fp[]): Fp[] {
  const k = log2PowerOfTwo(a.length, 'ntt');
  return transform(a, twoAdicRoot(k));
}

export function intt(a: Fp[]): Fp[] {
  const k = log2PowerOfTwo(a.length, 'intt');
  const values = transform(a, inv(twoAdicRoot(k)));
  const nInv = inv(BigInt(a.length));
  return values.map((value) => mul(value, nInv));
}

/** Evaluate coeffs on the coset g·⟨ω'⟩ of size n·blowup: scale coeffs by g^i, then NTT. */
export function cosetLDE(coeffs: Fp[], blowup: number): Fp[] {
  log2PowerOfTwo(coeffs.length, 'cosetLDE');
  log2PowerOfTwo(blowup, 'cosetLDE blowup');
  const domainSize = coeffs.length * blowup;
  if (!Number.isSafeInteger(domainSize)) throw new Error('cosetLDE: domain too large');

  const shifted = new Array<Fp>(domainSize).fill(0n);
  let generatorPower = 1n;
  for (let i = 0; i < coeffs.length; i++) {
    shifted[i] = mul(coeffs[i]!, generatorPower);
    generatorPower = mul(generatorPower, GENERATOR);
  }
  return ntt(shifted);
}

/** Interpolate values over H (size n) back to coefficients. */
export function interpolate(valuesOnH: Fp[]): Fp[] {
  return intt(valuesOnH);
}
