/** docs/PROTOCOL-SPEC.md §4.6 — Full protocol-v2 prover: Fp² challenges + bound Plookup + Fp² DEEP-FRI. */
import type { Fp } from '../field';
import { mul as mulBase, twoAdicRoot } from '../field';
import type { Fp2 } from '../fp2';
import { embed, fp2, isZero, mul } from '../fp2';
import {
  cosetEvaluateFp2,
  evalBaseAtFp2,
  evalFp2,
  interpolateFp2,
  type Fp2Poly,
} from '../fp2-poly';
import type { CompiledCircuit, Witness } from '../circuit/compile';
import { cosetEvaluate, interpolate } from '../ntt';
import type { Poly } from '../poly';
import { buildTree } from '../merkle';
import type { MerkleTree } from '../merkle';
import { createTranscript } from '../transcript';
import type { Params, Proof, ProofTrace } from '../types';
import { blind, blindFp2, seededFieldSource } from '../zkmode';
import { selectorPolynomials, sigmaPolynomials } from './arithmetic';
import { buildGrandProductFp2 } from './permutation-fp2';
import { buildLookupGrandProduct, buildLookupWitness } from './lookup';
import { buildQuotientFp2, composeConstraintsFp2 } from './quotient-fp2';
import { quotientChunkCount, quotientChunkLabel, friInitialDegreeBound } from './chunks';
import { buildFriFp2, deepCompositionAtFp2 } from '../fri/fri-fp2';
import { domainPoint } from '../fri/fri';

interface CommittedBase {
  evaluations: Fp[][];
  tree: MerkleTree;
}

interface CommittedFp2 {
  evaluations: Fp[][];
  values: Fp2[];
  tree: MerkleTree;
}

async function commitBase(poly: Poly, size: number, label: string): Promise<CommittedBase> {
  const evaluations = cosetEvaluate(poly, size).map((value) => [value]);
  return { evaluations, tree: await buildTree(evaluations, label) };
}

async function commitFp2(poly: Fp2Poly, size: number, label: string): Promise<CommittedFp2> {
  const values = cosetEvaluateFp2(poly, size);
  const evaluations = values.map((value) => [value.c0, value.c1]);
  return { values, evaluations, tree: await buildTree(evaluations, label) };
}

async function commitWires(a: Poly, b: Poly, c: Poly, size: number): Promise<CommittedBase> {
  const aLde = cosetEvaluate(a, size);
  const bLde = cosetEvaluate(b, size);
  const cLde = cosetEvaluate(c, size);
  const evaluations = aLde.map((value, index) => [value, bLde[index]!, cLde[index]!]);
  return { evaluations, tree: await buildTree(evaluations, 'wires') };
}

function paramsBytes(params: Params): Uint8Array {
  const grindingBits = params.grindingBits ?? 0;
  const bytes = new Uint8Array(grindingBits === 0 ? 13 : 14);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, params.n, true);
  view.setUint32(4, params.blowup, true);
  view.setUint32(8, params.queries, true);
  bytes[12] = params.zk ? 1 : 0;
  if (grindingBits > 0) bytes[13] = grindingBits;
  return bytes;
}

function padded(poly: Fp2Poly, n: number): Fp2Poly {
  if (poly.length > n) throw new Error('Fp² quotient chunk exceeds trace-domain bound');
  return [...poly, ...Array.from({ length: n - poly.length }, () => fp2(0n, 0n))];
}

async function squeezeZeta(
  transcript: ReturnType<typeof createTranscript>,
  params: Params,
): Promise<Fp2> {
  const domainSize = BigInt(params.n * params.blowup);
  for (;;) {
    const zeta = await transcript.squeezeFp2('zeta');
    if (zeta.c1 !== 0n) return zeta;
    let trace = 1n;
    for (let index = 0; index < params.n; index++) trace = mulBase(trace, zeta.c0);
    if (trace === 1n) continue;
    let lde = 1n;
    for (let index = 0n; index < domainSize; index++) lde = mulBase(lde, zeta.c0);
    let generator = 1n;
    for (let index = 0n; index < domainSize; index++) generator = mulBase(generator, 7n);
    if (lde === generator) continue;
    return zeta;
  }
}

export async function proveFp2(
  circuit: CompiledCircuit,
  witness: Witness,
  publicInputs: Fp[],
  params: Params,
  seed: number,
  forcePastRemainder: boolean,
): Promise<ProofTrace> {
  if (params.n !== circuit.n || params.blowup < 1 || (params.blowup & (params.blowup - 1)) !== 0)
    throw new Error('proof parameters do not match compiled circuit');
  const transcript = createTranscript('witness-list/plonk-v2/fp2-plookup');
  await transcript.absorb('params', paramsBytes(params));
  await transcript.absorb('circuit-digest', circuit.digest);
  for (const input of publicInputs) await transcript.absorbFp('public-input', input);
  const random = seededFieldSource(seed);
  const a = blind(interpolate(witness.a), circuit.n, params, random);
  const b = blind(interpolate(witness.b), circuit.n, params, random);
  const c = blind(interpolate(witness.c), circuit.n, params, random);
  const size = circuit.n * params.blowup;
  const wires = await commitWires(a, b, c, size);
  await transcript.absorb('wires-root', wires.tree.root.bytes);

  const lookupWitness = buildLookupWitness(circuit, witness);
  let h1: Poly | undefined;
  let h2: Poly | undefined;
  let h1Commitment: CommittedBase | undefined;
  let h2Commitment: CommittedBase | undefined;
  if (lookupWitness?.mode === 'membership') {
    h1 = blind(interpolate(lookupWitness.h1!), circuit.n, params, random);
    h2 = blind(interpolate(lookupWitness.h2!), circuit.n, params, random);
    [h1Commitment, h2Commitment] = await Promise.all([
      commitBase(h1, size, 'lookup-h1'),
      commitBase(h2, size, 'lookup-h2'),
    ]);
    await transcript.absorb('lookup-h1-root', h1Commitment.tree.root.bytes);
    await transcript.absorb('lookup-h2-root', h2Commitment.tree.root.bytes);
  }

  const beta = await transcript.squeezeFp2('beta');
  const gamma = await transcript.squeezeFp2('gamma');
  const copyGrand = buildGrandProductFp2(circuit, witness, beta, gamma);
  const zPoly = blindFp2(interpolateFp2(copyGrand.z), circuit.n, params, random);
  const z = await commitFp2(zPoly, size, 'z2');
  await transcript.absorb('z-root', z.tree.root.bytes);

  const lookupGrand =
    lookupWitness === undefined ? undefined : buildLookupGrandProduct(lookupWitness, beta, gamma);
  const lookupZPoly =
    lookupGrand === undefined
      ? undefined
      : blindFp2(interpolateFp2(lookupGrand.z), circuit.n, params, random);
  const lookupZ =
    lookupZPoly === undefined ? undefined : await commitFp2(lookupZPoly, size, 'lookup-z2');
  if (lookupZ !== undefined) await transcript.absorb('lookup-z-root', lookupZ.tree.root.bytes);

  const alpha = await transcript.squeezeFp2('alpha');
  const composition = composeConstraintsFp2(circuit, witness, publicInputs, beta, gamma, alpha, {
    a,
    b,
    c,
    z: zPoly,
    ...(lookupWitness === undefined
      ? {}
      : {
          lookup: {
            witness: lookupWitness,
            ...(h1 === undefined ? {} : { h1, h2: h2! }),
            z: lookupZPoly!,
          },
        }),
  });
  const quotient = buildQuotientFp2(composition.composed, circuit.n, quotientChunkCount(params));
  if (!quotient.exact && !forcePastRemainder) {
    const rows = quotient.remainderOnH.flatMap((value, row) => (isZero(value) ? [] : [row]));
    throw new Error(`constraint composition has nonzero Fp² remainder on rows ${rows.join(', ')}`);
  }
  const t = await Promise.all(
    quotient.chunks.map((chunk, index) =>
      commitFp2(padded(chunk, circuit.n), size, quotientChunkLabel(index)),
    ),
  );
  for (const commitment of t) await transcript.absorb('t-root', commitment.tree.root.bytes);

  const zeta = await squeezeZeta(transcript, params);
  const omegaZeta = mul(zeta, embed(twoAdicRoot(Math.log2(circuit.n))));
  const [sA, sB, sC] = sigmaPolynomials(circuit);
  const openingPairs: Array<[string, Fp2]> = [
    ['a', evalBaseAtFp2(a, zeta)],
    ['b', evalBaseAtFp2(b, zeta)],
    ['c', evalBaseAtFp2(c, zeta)],
    ['s-a', evalBaseAtFp2(sA, zeta)],
    ['s-b', evalBaseAtFp2(sB, zeta)],
    ['s-c', evalBaseAtFp2(sC, zeta)],
    ['z', evalFp2(zPoly, zeta)],
    ['z-omega', evalFp2(zPoly, omegaZeta)],
    ...quotient.chunks.map(
      (chunk, index) => [quotientChunkLabel(index), evalFp2(chunk, zeta)] as [string, Fp2],
    ),
  ];
  if (lookupWitness?.mode === 'membership')
    openingPairs.push(
      ['lookup-h1', evalBaseAtFp2(h1!, zeta)],
      ['lookup-h1-omega', evalBaseAtFp2(h1!, omegaZeta)],
      ['lookup-h2', evalBaseAtFp2(h2!, zeta)],
      ['lookup-h2-omega', evalBaseAtFp2(h2!, omegaZeta)],
    );
  if (lookupWitness !== undefined)
    openingPairs.push(
      ['lookup-z', evalFp2(lookupZPoly!, zeta)],
      ['lookup-z-omega', evalFp2(lookupZPoly!, omegaZeta)],
    );
  const openings = openingPairs.map(([label, value]) => ({ label, value }));
  for (const opening of openings)
    await transcript.absorbFp2(`opening-${opening.label}`, opening.value);
  const rho = await transcript.squeezeFp2('rho');
  const claimMap = new Map(openingPairs);
  const baseClaimLabels = [
    'a',
    'b',
    'c',
    'z',
    'z-omega',
    ...quotient.chunks.map((_, index) => quotientChunkLabel(index)),
  ];
  const lookupClaimLabels =
    lookupWitness === undefined
      ? []
      : [
          ...(lookupWitness.mode === 'membership'
            ? ['lookup-h1', 'lookup-h1-omega', 'lookup-h2', 'lookup-h2-omega']
            : []),
          'lookup-z',
          'lookup-z-omega',
        ];
  const claimed = [...baseClaimLabels, ...lookupClaimLabels].map((label) => claimMap.get(label)!);
  const deepValues = Array.from({ length: size }, () => fp2(0n, 0n));
  for (let index = 0; index < size; index++) {
    const rotated = (index + params.blowup) % size;
    const values = [
      ...wires.evaluations[index]!.map(embed),
      z.values[index]!,
      z.values[rotated]!,
      ...t.map((commitment) => commitment.values[index]!),
    ];
    if (lookupWitness?.mode === 'membership')
      values.push(
        embed(h1Commitment!.evaluations[index]![0]!),
        embed(h1Commitment!.evaluations[rotated]![0]!),
        embed(h2Commitment!.evaluations[index]![0]!),
        embed(h2Commitment!.evaluations[rotated]![0]!),
      );
    if (lookupWitness !== undefined)
      values.push(lookupZ!.values[index]!, lookupZ!.values[rotated]!);
    deepValues[index] = deepCompositionAtFp2(domainPoint(index, size), zeta, rho, values, claimed);
  }
  const fri = await buildFriFp2(
    deepValues,
    friInitialDegreeBound(params),
    transcript,
    params.queries,
    params.grindingBits ?? 0,
  );
  const queries = fri.queries.map((query) => {
    const index = query.index;
    const rotated = (index + params.blowup) % size;
    return {
      ...query,
      leaves: {
        wires: wires.evaluations[index]!.slice(),
        z: z.evaluations[index]!.slice(),
        'z-omega': z.evaluations[rotated]!.slice(),
        ...Object.fromEntries(
          t.map((commitment, chunk) => [
            quotientChunkLabel(chunk),
            commitment.evaluations[index]!.slice(),
          ]),
        ),
        ...(lookupWitness?.mode !== 'membership'
          ? {}
          : {
              'lookup-h1': h1Commitment!.evaluations[index]!.slice(),
              'lookup-h1-omega': h1Commitment!.evaluations[rotated]!.slice(),
              'lookup-h2': h2Commitment!.evaluations[index]!.slice(),
              'lookup-h2-omega': h2Commitment!.evaluations[rotated]!.slice(),
            }),
        ...(lookupWitness === undefined
          ? {}
          : {
              'lookup-z': lookupZ!.evaluations[index]!.slice(),
              'lookup-z-omega': lookupZ!.evaluations[rotated]!.slice(),
            }),
      },
      paths: {
        wires: wires.tree.path(index),
        z: z.tree.path(index),
        'z-omega': z.tree.path(rotated),
        ...Object.fromEntries(
          t.map((commitment, chunk) => [quotientChunkLabel(chunk), commitment.tree.path(index)]),
        ),
        ...(lookupWitness?.mode !== 'membership'
          ? {}
          : {
              'lookup-h1': h1Commitment!.tree.path(index),
              'lookup-h1-omega': h1Commitment!.tree.path(rotated),
              'lookup-h2': h2Commitment!.tree.path(index),
              'lookup-h2-omega': h2Commitment!.tree.path(rotated),
            }),
        ...(lookupWitness === undefined
          ? {}
          : {
              'lookup-z': lookupZ!.tree.path(index),
              'lookup-z-omega': lookupZ!.tree.path(rotated),
            }),
      },
    };
  });
  const proof: Proof = {
    version: 2,
    params,
    circuitDigest: circuit.digest.slice(),
    publicInputs: publicInputs.slice(),
    wiresRoot: wires.tree.root,
    zRoot: z.tree.root,
    tRoots: t.map((commitment) => commitment.tree.root),
    ...(lookupWitness === undefined
      ? {}
      : {
          lookupRoots: {
            mode: lookupWitness.mode,
            ...(lookupWitness.mode === 'membership'
              ? { h1Root: h1Commitment!.tree.root, h2Root: h2Commitment!.tree.root }
              : {}),
            zRoot: lookupZ!.tree.root,
          },
        }),
    openings,
    friLayerRoots: fri.roots,
    friFinalCoeffs: fri.finalCoeffs,
    ...(fri.grindingNonce === undefined ? {} : { grindingNonce: fri.grindingNonce }),
    queries,
  };
  return {
    proof,
    transcript: transcript.log,
    stages: {
      milestone: forcePastRemainder
        ? 'Attack A1 — forced past a nonzero Fp² quotient remainder; V2 must reject'
        : 'Protocol v2 — Fp² PLONK/DEEP/FRI with bound Plookup',
      seed,
      beta,
      gamma,
      alpha,
      zeta,
      rho,
      witness: { a: witness.a.slice(), b: witness.b.slice(), c: witness.c.slice() },
      wirePolynomials: { a: a.slice(), b: b.slice(), c: c.slice() },
      grandProduct: { values: copyGrand.z, partials: copyGrand.partials },
      ...(lookupGrand === undefined
        ? {}
        : {
            lookupGrandProduct: {
              mode: lookupWitness!.mode,
              partials: lookupGrand.partials,
              h1: lookupWitness!.h1,
              h2: lookupWitness!.h2,
            },
          }),
      quotient: { chunks: quotient.chunks },
      selectors: selectorPolynomials(circuit),
      composedOnH: composition.composedOnH,
      friLayers: fri.roots.length,
    },
    quotientRemainder: quotient.remainderOnH,
  };
}
