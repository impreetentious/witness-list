/** Fp² DEEP-FRI used by protocol wire v2. */
import { GENERATOR, inv as invBase, mul as mulBase } from '../field';
import type { Fp } from '../field';
import type { Fp2 } from '../fp2';
import { add, embed, fp2Zero, inv, mul, sub } from '../fp2';
import { interpolateCoset, domainPoint } from './fri';
import { buildTree } from '../merkle';
import type { MerkleTree } from '../merkle';
import type { QueryOpening } from '../types';
import type { Transcript } from '../transcript';
import { encodeGrindingNonce, findGrindingNonce, validateGrindingBits } from '../grinding';

interface FriLayerFp2 {
  values: Fp2[];
  tree: MerkleTree;
  shift: Fp;
}

export interface BuiltFriFp2 {
  roots: { bytes: Uint8Array }[];
  finalCoeffs: Fp2[];
  grindingNonce?: number;
  queries: QueryOpening[];
}

const FINAL_DEGREE_BOUND = 8;

function assertPowerOfTwo(length: number): void {
  if (!Number.isSafeInteger(length) || length < 1 || (length & (length - 1)) !== 0) throw new Error('Fp² FRI layer must be a positive power of two');
}

export function foldPairFp2(atX: Fp2, atNegativeX: Fp2, beta: Fp2, x: Fp): Fp2 {
  const inverseTwo = embed(invBase(2n));
  const even = mul(add(atX, atNegativeX), inverseTwo);
  const odd = mul(mul(sub(atX, atNegativeX), inverseTwo), embed(invBase(x)));
  return add(even, mul(beta, odd));
}

export function foldLayerFp2(layer: readonly Fp2[], beta: Fp2, shift: Fp): Fp2[] {
  assertPowerOfTwo(layer.length);
  if (layer.length < 2) throw new Error('Fp² FRI fold needs at least two values');
  const half = layer.length >> 1;
  return Array.from({ length: half }, (_, index) =>
    foldPairFp2(layer[index]!, layer[index + half]!, beta, domainPoint(index, layer.length, shift)),
  );
}

export function deepCompositionAtFp2(
  x: Fp,
  zeta: Fp2,
  rho: Fp2,
  valuesAtX: readonly Fp2[],
  claimedValues: readonly Fp2[],
): Fp2 {
  if (valuesAtX.length !== claimedValues.length || valuesAtX.length < 8) throw new Error('Fp² DEEP composition needs matching committed evaluations');
  const denominatorInverse = inv(sub(embed(x), zeta));
  let rhoPower = embed(1n);
  let composition = fp2Zero;
  for (let index = 0; index < valuesAtX.length; index++) {
    composition = add(composition, mul(rhoPower, mul(sub(valuesAtX[index]!, claimedValues[index]!), denominatorInverse)));
    rhoPower = mul(rhoPower, rho);
  }
  return composition;
}

function interpolateCosetFp2(values: readonly Fp2[], shift: Fp): Fp2[] {
  const c0 = interpolateCoset(values.map((value) => value.c0), shift);
  const c1 = interpolateCoset(values.map((value) => value.c1), shift);
  let coefficients = Array.from({ length: Math.max(c0.length, c1.length) }, (_, index) => ({ c0: c0[index] ?? 0n, c1: c1[index] ?? 0n }));
  while (coefficients.length > 0 && coefficients.at(-1)!.c0 === 0n && coefficients.at(-1)!.c1 === 0n) coefficients = coefficients.slice(0, -1);
  return coefficients;
}

function canonicalPairIndex(index: number, length: number): number {
  const half = length >> 1;
  return index < half ? index : index - half;
}

export async function buildFriFp2(
  initialValues: readonly Fp2[],
  initialDegreeBound: number,
  transcript: Transcript,
  queries: number,
  grindingBits = 0,
): Promise<BuiltFriFp2> {
  assertPowerOfTwo(initialValues.length);
  if (!Number.isSafeInteger(initialDegreeBound) || initialDegreeBound < 1) throw new Error('Fp² FRI degree bound must be positive');
  if (!Number.isSafeInteger(queries) || queries < 1) throw new Error('Fp² FRI query count must be positive');
  validateGrindingBits(grindingBits);

  const layers: FriLayerFp2[] = [];
  let values = initialValues.slice();
  let shift = GENERATOR;
  let degreeBound = initialDegreeBound;
  let tree = await buildTree(values.map((value) => [value.c0, value.c1]), 'fri2-0');
  layers.push({ values, tree, shift });
  await transcript.absorb('fri-root-0', tree.root.bytes);
  while (degreeBound > FINAL_DEGREE_BOUND) {
    const layerIndex = layers.length - 1;
    values = foldLayerFp2(values, await transcript.squeezeFp2(`fri-beta-${layerIndex}`), shift);
    shift = mulBase(shift, shift);
    degreeBound = Math.ceil(degreeBound / 2);
    tree = await buildTree(values.map((value) => [value.c0, value.c1]), `fri2-${layers.length}`);
    layers.push({ values, tree, shift });
    await transcript.absorb(`fri-root-${layers.length - 1}`, tree.root.bytes);
  }

  const final = interpolateCosetFp2(layers.at(-1)!.values, layers.at(-1)!.shift);
  if (final.length > FINAL_DEGREE_BOUND) throw new Error('Fp² FRI final polynomial exceeds degree bound');
  const finalCoeffs = [...final, ...Array.from({ length: FINAL_DEGREE_BOUND - final.length }, () => fp2Zero)];
  for (const coefficient of finalCoeffs) await transcript.absorbFp2('fri-final-coeff', coefficient);

  let grindingNonce: number | undefined;
  if (grindingBits > 0) {
    grindingNonce = await findGrindingNonce(await transcript.workDigest('fri-grinding'), grindingBits);
    await transcript.absorb('fri-grinding-nonce', encodeGrindingNonce(grindingNonce));
  }

  const queryOpenings: QueryOpening[] = [];
  for (let query = 0; query < queries; query++) {
    const index = await transcript.squeezeIndex('fri-query-index', initialValues.length);
    let layerIndex = index;
    const friLayers: QueryOpening['friLayers'] = [];
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
    const finalLayer = layers.at(-1)!;
    queryOpenings.push({ index, leaves: {}, paths: {}, friLayers, finalLayer: { value: finalLayer.values[layerIndex]!, path: finalLayer.tree.path(layerIndex) } });
  }
  return { roots: layers.map((layer) => layer.tree.root), finalCoeffs, grindingNonce, queries: queryOpenings };
}
