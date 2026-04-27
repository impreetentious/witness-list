/**
 * Batch DEEP-FRI: composition over the LDE coset, halving folds, layer commits,
 * queries with path walks. docs/PROTOCOL-SPEC.md §4.6 (round 5) + §4.7.
 * Gate Z7 (fold property), Z8/Z9 (E2E + attacks), Z12 (grinding stats).
 */
import { GENERATOR, add, inv, mul, pow, sub, twoAdicRoot } from '../field';
import type { Fp } from '../field';
import { intt } from '../ntt';
import { buildTree } from '../merkle';
import type { MerkleTree } from '../merkle';
import type { QueryOpeningV1 } from '../types';
import type { Transcript } from '../transcript';
import { encodeGrindingNonce, findGrindingNonce, validateGrindingBits } from '../grinding';

interface FriLayer {
  values: Fp[];
  tree: MerkleTree;
  /** The first point of this layer's multiplicative coset. */
  shift: Fp;
}

export interface BuiltFri {
  roots: { bytes: Uint8Array }[];
  finalCoeffs: Fp[];
  grindingNonce?: number;
  queries: QueryOpeningV1[];
}

const FINAL_DEGREE_BOUND = 8;

function log2PowerOfTwo(length: number, name: string): number {
  if (!Number.isSafeInteger(length) || length < 1 || (length & (length - 1)) !== 0) {
    throw new Error(`${name} must be a positive power of two`);
  }
  return Math.log2(length);
}

/** D_i = shift · <ω_i>, ordered in the same radix-2 order as the NTT. */
export function domainPoint(index: number, length: number, shift: Fp = GENERATOR): Fp {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new Error(`FRI domain index ${index} is outside its layer`);
  }
  return mul(shift, pow(twoAdicRoot(log2PowerOfTwo(length, 'FRI domain length')), BigInt(index)));
}

/** fold: L' (x²) = (L(x)+L(−x))/2 + β·(L(x)−L(−x))/(2x) — docs/PROTOCOL-SPEC.md §4.7 */
export function foldLayer(_layer: Fp[], _beta: Fp, _domainShift: Fp): Fp[] {
  const { length } = _layer;
  if (length < 2 || (length & (length - 1)) !== 0) {
    throw new Error('FRI fold needs an even power-of-two layer');
  }
  const half = length >> 1;
  const omega = twoAdicRoot(Math.log2(length));
  const inverseTwo = inv(2n);
  const folded = Array.from<Fp>({ length: half }).fill(0n);
  let x = _domainShift;
  for (let index = 0; index < half; index++) {
    const atX = _layer[index]!;
    const atNegativeX = _layer[index + half]!;
    const even = mul(add(atX, atNegativeX), inverseTwo);
    const odd = mul(mul(sub(atX, atNegativeX), inverseTwo), inv(x));
    folded[index] = add(even, mul(_beta, odd));
    x = mul(x, omega);
  }
  return folded;
}

/** The FRI fold at one canonical x/-x pair, used by both prover and verifier. */
export function foldPair(atX: Fp, atNegativeX: Fp, beta: Fp, x: Fp): Fp {
  const inverseTwo = inv(2n);
  const even = mul(add(atX, atNegativeX), inverseTwo);
  const odd = mul(mul(sub(atX, atNegativeX), inverseTwo), inv(x));
  return add(even, mul(beta, odd));
}

/**
 * Batch DEEP composition for every committed polynomial evaluation. The first
 * five values are a, b, c, Z(x), Z(ωx); the remainder are positional quotient
 * chunks. Blinded proofs can carry more than the three unblinded chunks.
 */
export function deepCompositionAt(
  x: Fp,
  zeta: Fp,
  rho: Fp,
  valuesAtX: readonly Fp[],
  claimedValues: readonly Fp[],
): Fp {
  if (valuesAtX.length < 8 || valuesAtX.length !== claimedValues.length) {
    throw new Error('DEEP composition needs matching committed evaluations');
  }
  const denominator = sub(x, zeta);
  if (denominator === 0n) throw new Error('DEEP query point must differ from zeta');
  const denominatorInverse = inv(denominator);
  let rhoPower = 1n;
  let composition = 0n;
  for (let index = 0; index < valuesAtX.length; index++) {
    composition = add(
      composition,
      mul(rhoPower, mul(sub(valuesAtX[index]!, claimedValues[index]!), denominatorInverse)),
    );
    rhoPower = mul(rhoPower, rho);
  }
  return composition;
}

/**
 * Interpolate values on shift·H, undoing the coefficient scaling used by the
 * coset NTT. This is the clear final polynomial in docs/PROTOCOL-SPEC.md §4.7.
 */
export function interpolateCoset(values: Fp[], shift: Fp): Fp[] {
  const coefficients = intt(values);
  const shiftInverse = inv(shift);
  let power = 1n;
  const output = coefficients.map((coefficient) => {
    const unshifted = mul(coefficient, power);
    power = mul(power, shiftInverse);
    return unshifted;
  });
  let end = output.length;
  while (end > 0 && output[end - 1] === 0n) end--;
  return output.slice(0, end);
}

function canonicalPairIndex(index: number, length: number): number {
  const half = length >> 1;
  return index < half ? index : index - half;
}

/** Build the committed folding cascade, absorb it, then derive all query paths. */
export async function buildFri(
  initialValues: Fp[],
  initialDegreeBound: number,
  transcript: Transcript,
  queries: number,
  grindingBits = 0,
): Promise<BuiltFri> {
  if (!Number.isSafeInteger(initialDegreeBound) || initialDegreeBound < 1) {
    throw new Error('FRI degree bound must be positive');
  }
  if (!Number.isSafeInteger(queries) || queries < 1)
    throw new Error('FRI query count must be positive');
  validateGrindingBits(grindingBits);
  log2PowerOfTwo(initialValues.length, 'FRI initial layer');

  const layers: FriLayer[] = [];
  let values = initialValues.slice();
  let shift = GENERATOR;
  let degreeBound = initialDegreeBound;
  let tree = await buildTree(
    values.map((value) => [value]),
    'fri-0',
  );
  layers.push({ values, tree, shift });
  await transcript.absorb('fri-root-0', tree.root.bytes);

  while (degreeBound > FINAL_DEGREE_BOUND) {
    const layerIndex = layers.length - 1;
    const beta = await transcript.squeezeFp(`fri-beta-${layerIndex}`);
    values = foldLayer(values, beta, shift);
    shift = mul(shift, shift);
    degreeBound = Math.ceil(degreeBound / 2);
    tree = await buildTree(
      values.map((value) => [value]),
      `fri-${layers.length}`,
    );
    layers.push({ values, tree, shift });
    await transcript.absorb(`fri-root-${layers.length - 1}`, tree.root.bytes);
  }

  const finalCoeffs = interpolateCoset(
    layers[layers.length - 1]!.values,
    layers[layers.length - 1]!.shift,
  );
  if (finalCoeffs.length > FINAL_DEGREE_BOUND) {
    throw new Error(
      `FRI final polynomial has degree bound ${finalCoeffs.length - 1}, expected < ${FINAL_DEGREE_BOUND}`,
    );
  }
  // A fixed-width encoding binds both the coefficients and their degree bound.
  const finalPadded = [
    ...finalCoeffs,
    ...Array<Fp>(FINAL_DEGREE_BOUND - finalCoeffs.length).fill(0n),
  ];
  for (const coefficient of finalPadded) await transcript.absorbFp('fri-final-coeff', coefficient);

  let grindingNonce: number | undefined;
  if (grindingBits > 0) {
    grindingNonce = await findGrindingNonce(
      await transcript.workDigest('fri-grinding'),
      grindingBits,
    );
    await transcript.absorb('fri-grinding-nonce', encodeGrindingNonce(grindingNonce));
  }

  const queryOpenings: QueryOpeningV1[] = [];
  for (let query = 0; query < queries; query++) {
    const index = await transcript.squeezeIndex('fri-query-index', initialValues.length);
    let layerIndex = index;
    const friLayers: QueryOpeningV1['friLayers'] = [];
    for (let level = 0; level < layers.length - 1; level++) {
      const layer = layers[level]!;
      const pairIndex = canonicalPairIndex(layerIndex, layer.values.length);
      const siblingIndex = pairIndex + (layer.values.length >> 1);
      friLayers.push({
        at: layer.values[pairIndex]!,
        sibling: layer.values[siblingIndex]!,
        atPath: layer.tree.path(pairIndex),
        siblingPath: layer.tree.path(siblingIndex),
      });
      layerIndex = pairIndex;
    }
    const finalLayer = layers[layers.length - 1]!;
    queryOpenings.push({
      index,
      leaves: {},
      paths: {},
      friLayers,
      finalLayer: { value: finalLayer.values[layerIndex]!, path: finalLayer.tree.path(layerIndex) },
    });
  }
  return {
    roots: layers.map((layer) => layer.tree.root),
    finalCoeffs: finalPadded,
    grindingNonce,
    queries: queryOpenings,
  };
}
