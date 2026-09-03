/**
 * Full prover pipeline, rounds 0–5. docs/PROTOCOL-SPEC.md §4.6.
 * Emits ProofTrace (proof + bounded player payloads) from the worker.
 * The identity-only lesson path is EXPLICITLY UNSOUND ALONE (no low-degree
 * test) — label it everywhere.
 */
import type { Fp } from '../field';
import type { CompiledCircuit, Witness } from '../circuit/compile';
import { cosetEvaluate, cosetLDE, interpolate } from '../ntt';
import { buildTree } from '../merkle';
import type { MerkleTree } from '../merkle';
import { evalAt } from '../poly';
import { createTranscript } from '../transcript';
import type { MerkleRoot, Params, ProofV1, ProofTrace } from '../types';
import { composeConstraints, buildQuotient } from './quotient';
import { omegaTimes, sigmaPolynomials, zetaIsInLdeCoset, zetaIsInTraceDomain } from './arithmetic';
import { buildGrandProduct } from './permutation';
import { hasLookups } from './lookup';
import { buildFri, deepCompositionAt, domainPoint } from '../fri/fri';
import { blind, seededFieldSource } from '../zkmode';
import { friInitialDegreeBound, quotientChunkCount, quotientChunkLabel } from './chunks';
import { paramsAreSupported } from './params';
import { proveFp2 } from './prove-fp2';

export function prove(
  circuit: CompiledCircuit,
  witness: Witness,
  publicInputs: Fp[],
  params: Params,
  seed: number,
): Promise<ProofTrace> {
  return proveFp2(circuit, witness, publicInputs, params, seed, false);
}

/**
 * Attack-lab-only path: commits the quotient even when exact division failed.
 * This intentionally produces a well-formed but invalid proof so the shared
 * A1 malicious prover can demonstrate V2 catching its false identity.
 */
export function proveForcedPastRemainder(
  circuit: CompiledCircuit,
  witness: Witness,
  publicInputs: Fp[],
  params: Params,
  seed: number,
): Promise<ProofTrace> {
  return proveFp2(circuit, witness, publicInputs, params, seed, true);
}

export async function proveV1ForCompatibility(
  circuit: CompiledCircuit,
  witness: Witness,
  publicInputs: Fp[],
  params: Params,
  seed: number,
  forcePastRemainder = false,
): Promise<ProofTrace> {
  if (!paramsAreSupported(params, circuit.n))
    throw new Error('proof parameters are outside the supported protocol range');
  // Wire v1 has no lookup commitment or constraint term, so a v1 proof would
  // silently drop the circuit's lookup gates. verifyV1 refuses the same pairing.
  if (hasLookups(circuit))
    throw new Error('protocol wire v1 cannot express a circuit with lookup gates');
  const transcript = createTranscript('witness-list/plonk-v1');
  await transcript.absorb('params', paramsBytes(params));
  await transcript.absorb('circuit-digest', circuit.digest);
  for (const input of publicInputs) await transcript.absorbFp('public-input', input);

  const random = seededFieldSource(seed);
  const a = blind(interpolate(witness.a), circuit.n, params, random);
  const b = blind(interpolate(witness.b), circuit.n, params, random);
  const c = blind(interpolate(witness.c), circuit.n, params, random);
  const ldeSize = circuit.n * params.blowup;
  const wires = await commitWirePolynomials(a, b, c, params.blowup, ldeSize);
  await transcript.absorb('wires-root', wires.tree.root.bytes);
  const beta = await transcript.squeezeFp('beta');
  const gamma = await transcript.squeezeFp('gamma');

  const grandProduct = buildGrandProduct(circuit, witness, beta, gamma);
  const zCoefficients = blind(interpolate(grandProduct.z), circuit.n, params, random);
  const z = await commitPolynomial(zCoefficients, params.blowup, 'z', ldeSize);
  await transcript.absorb('z-root', z.tree.root.bytes);
  const alpha = await transcript.squeezeFp('alpha');

  const composition = composeConstraints(circuit, witness, publicInputs, beta, gamma, alpha, {
    a,
    b,
    c,
    z: zCoefficients,
  });
  const quotient = buildQuotient(composition.composed, circuit.n, quotientChunkCount(params));
  if (!quotient.exact && !forcePastRemainder) {
    const rows = quotient.remainderOnH.flatMap((value, row) => (value === 0n ? [] : [row]));
    throw new Error(`constraint composition has nonzero remainder on rows ${rows.join(', ')}`);
  }
  const quotientCommitments = await Promise.all(
    quotient.chunks.map((chunk, index) =>
      commitPolynomial(padded(chunk, circuit.n), params.blowup, quotientChunkLabel(index), ldeSize),
    ),
  );
  for (const commitment of quotientCommitments)
    await transcript.absorb('t-root', commitment.tree.root.bytes);

  const zeta = await squeezeZeta(transcript, params);
  const [sA, sB, sC] = sigmaPolynomials(circuit);
  const openingPairs: Array<[string, Fp]> = [
    ['a', evalAt(a, zeta)],
    ['b', evalAt(b, zeta)],
    ['c', evalAt(c, zeta)],
    ['s-a', evalAt(sA, zeta)],
    ['s-b', evalAt(sB, zeta)],
    ['s-c', evalAt(sC, zeta)],
    ['z', evalAt(zCoefficients, zeta)],
    ['z-omega', evalAt(zCoefficients, omegaTimes(zeta, circuit.n))],
    ...quotient.chunks.map(
      (chunk, index) => [quotientChunkLabel(index), evalAt(chunk, zeta)] as [string, Fp],
    ),
  ];
  const openings: ProofV1['openings'] = openingPairs.map(([label, value]) => ({ label, value }));
  for (const opening of openings)
    await transcript.absorbFp(`opening-${opening.label}`, opening.value);
  const rho = await transcript.squeezeFp('rho');

  const claimed = [
    openingPairs[0]![1],
    openingPairs[1]![1],
    openingPairs[2]![1],
    openingPairs[6]![1],
    openingPairs[7]![1],
    ...quotient.chunks.map((_, index) => openingPairs[8 + index]![1]),
  ];
  const deepValues = Array.from<Fp>({ length: ldeSize }).fill(0n);
  for (let index = 0; index < ldeSize; index++) {
    const rotatedZIndex = (index + params.blowup) % ldeSize;
    deepValues[index] = deepCompositionAt(
      domainPoint(index, ldeSize),
      zeta,
      rho,
      [
        wires.evaluations[index]![0]!,
        wires.evaluations[index]![1]!,
        wires.evaluations[index]![2]!,
        z.evaluations[index]![0]!,
        z.evaluations[rotatedZIndex]![0]!,
        ...quotientCommitments.map((commitment) => commitment.evaluations[index]![0]!),
      ],
      claimed,
    );
  }
  const fri = await buildFri(
    deepValues,
    friInitialDegreeBound(params),
    transcript,
    params.queries,
    params.grindingBits ?? 0,
  );
  const queries = fri.queries.map((query) => {
    const index = query.index;
    const rotatedZIndex = (index + params.blowup) % ldeSize;
    return {
      ...query,
      leaves: {
        wires: wires.evaluations[index]!.slice(),
        z: z.evaluations[index]!.slice(),
        'z-omega': z.evaluations[rotatedZIndex]!.slice(),
        ...Object.fromEntries(
          quotientCommitments.map((commitment, chunk) => [
            quotientChunkLabel(chunk),
            commitment.evaluations[index]!.slice(),
          ]),
        ),
      },
      paths: {
        wires: wires.tree.path(index),
        z: z.tree.path(index),
        'z-omega': z.tree.path(rotatedZIndex),
        ...Object.fromEntries(
          quotientCommitments.map((commitment, chunk) => [
            quotientChunkLabel(chunk),
            commitment.tree.path(index),
          ]),
        ),
      },
    };
  });
  const proof: ProofV1 = {
    version: 1,
    params,
    circuitDigest: circuit.digest.slice(),
    publicInputs: publicInputs.slice(),
    wiresRoot: wires.tree.root,
    zRoot: z.tree.root,
    tRoots: quotientCommitments.map((commitment) => commitment.tree.root),
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
      beta,
      gamma,
      alpha,
      zeta,
      rho,
      witness: { a: witness.a.slice(), b: witness.b.slice(), c: witness.c.slice() },
      wirePolynomials: { a: a.slice(), b: b.slice(), c: c.slice() },
      grandProduct: { partials: grandProduct.partials.slice() },
    },
    quotientRemainder: quotient.remainderOnH,
  };
}

function paramsBytes(params: Params): Uint8Array {
  const grindingBits = params.grindingBits ?? 0;
  if (!Number.isSafeInteger(grindingBits) || grindingBits < 0 || grindingBits > 24)
    throw new Error('invalid grinding bits');
  const bytes = new Uint8Array(grindingBits === 0 ? 13 : 14);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, params.n, true);
  view.setUint32(4, params.blowup, true);
  view.setUint32(8, params.queries, true);
  bytes[12] = params.zk ? 1 : 0;
  if (grindingBits > 0) bytes[13] = grindingBits;
  return bytes;
}

function padded(coefficients: Fp[], n: number): Fp[] {
  if (coefficients.length > n)
    throw new Error('identity-only quotient chunk exceeds trace-domain degree bound');
  return [...coefficients, ...Array<Fp>(n - coefficients.length).fill(0n)];
}

async function commitment(
  coefficients: Fp[],
  blowup: number,
  domainSep: string,
): Promise<MerkleRoot> {
  const evaluations = cosetLDE(coefficients, blowup);
  return (
    await buildTree(
      evaluations.map((value) => [value]),
      domainSep,
    )
  ).root;
}

async function wireCommitment(a: Fp[], b: Fp[], c: Fp[], blowup: number): Promise<MerkleRoot> {
  const aLde = cosetLDE(a, blowup);
  const bLde = cosetLDE(b, blowup);
  const cLde = cosetLDE(c, blowup);
  return (
    await buildTree(
      aLde.map((value, index) => [value, bLde[index]!, cLde[index]!]),
      'wires',
    )
  ).root;
}

interface CommittedPolynomial {
  evaluations: Fp[][];
  tree: MerkleTree;
}

async function commitPolynomial(
  coefficients: Fp[],
  blowup: number,
  domainSep: string,
  domainSize?: number,
): Promise<CommittedPolynomial> {
  const evaluations = (
    domainSize === undefined
      ? cosetLDE(coefficients, blowup)
      : cosetEvaluate(coefficients, domainSize)
  ).map((value) => [value]);
  return { evaluations, tree: await buildTree(evaluations, domainSep) };
}

async function commitWirePolynomials(
  a: Fp[],
  b: Fp[],
  c: Fp[],
  blowup: number,
  domainSize?: number,
): Promise<CommittedPolynomial> {
  const evaluate = (coefficients: Fp[]) =>
    domainSize === undefined
      ? cosetLDE(coefficients, blowup)
      : cosetEvaluate(coefficients, domainSize);
  const aLde = evaluate(a);
  const bLde = evaluate(b);
  const cLde = evaluate(c);
  const evaluations = aLde.map((value, index) => [value, bLde[index]!, cLde[index]!]);
  return { evaluations, tree: await buildTree(evaluations, 'wires') };
}

async function squeezeZeta(
  transcript: ReturnType<typeof createTranscript>,
  params: Params,
): Promise<Fp> {
  for (;;) {
    const zeta = await transcript.squeezeFp('zeta');
    if (zetaIsInTraceDomain(zeta, params.n)) continue;
    if (zetaIsInLdeCoset(zeta, params.n, params.blowup)) continue;
    return zeta;
  }
}

/**
 * Identity-only lesson: real rounds 0–4 and V2 opening data, but no DEEP/FRI
 * low-degree proof. It must never be accepted as a sound proof;
 * verifyIdentityOnly says so in its result and full verify() rejects the
 * unavailable V3–V6 checks.
 */
export async function proveIdentityOnly(
  circuit: CompiledCircuit,
  witness: Witness,
  publicInputs: Fp[],
  params: Params,
): Promise<ProofTrace> {
  if (!paramsAreSupported(params, circuit.n))
    throw new Error('identity-only proof parameters are outside the supported protocol range');
  if (params.zk)
    throw new Error(
      'the identity-only path does not combine blinding with its unsound opening path',
    );
  if ((params.grindingBits ?? 0) !== 0)
    throw new Error('the identity-only path has no FRI query phase in which to bind grinding work');
  if (hasLookups(circuit))
    throw new Error('the identity-only path cannot express a circuit with lookup gates');

  const transcript = createTranscript('witness-list/plonk-identity-only/unsound');
  await transcript.absorb('params', paramsBytes(params));
  await transcript.absorb('circuit-digest', circuit.digest);
  for (const input of publicInputs) await transcript.absorbFp('public-input', input);

  const a = interpolate(witness.a);
  const b = interpolate(witness.b);
  const c = interpolate(witness.c);
  const wiresRoot = await wireCommitment(a, b, c, params.blowup);
  await transcript.absorb('wires-root', wiresRoot.bytes);
  const beta = await transcript.squeezeFp('beta');
  const gamma = await transcript.squeezeFp('gamma');

  // Build Z explicitly from the shared permutation recurrence after β,γ.
  const grandProduct = buildGrandProduct(circuit, witness, beta, gamma);
  const zCoefficients = interpolate(grandProduct.z);
  const zRoot = await commitment(zCoefficients, params.blowup, 'z');
  await transcript.absorb('z-root', zRoot.bytes);
  const alpha = await transcript.squeezeFp('alpha');

  const composition = composeConstraints(circuit, witness, publicInputs, beta, gamma, alpha);
  const quotient = buildQuotient(composition.composed, circuit.n);
  if (!quotient.exact) {
    const rows = quotient.remainderOnH.flatMap((value, row) => (value === 0n ? [] : [row]));
    throw new Error(
      `identity-only constraint composition has nonzero remainder on rows ${rows.join(', ')}`,
    );
  }
  const tRoots = await Promise.all([
    commitment(padded(quotient.tLo, circuit.n), params.blowup, 't-lo'),
    commitment(padded(quotient.tMid, circuit.n), params.blowup, 't-mid'),
    commitment(padded(quotient.tHi, circuit.n), params.blowup, 't-hi'),
  ]);
  for (const root of tRoots) await transcript.absorb('t-root', root.bytes);

  const zeta = await squeezeZeta(transcript, params);
  const [sA, sB, sC] = sigmaPolynomials(circuit);
  const openingPairs: Array<[string, Fp]> = [
    ['a', evalAt(a, zeta)],
    ['b', evalAt(b, zeta)],
    ['c', evalAt(c, zeta)],
    ['s-a', evalAt(sA, zeta)],
    ['s-b', evalAt(sB, zeta)],
    ['s-c', evalAt(sC, zeta)],
    ['z', evalAt(zCoefficients, zeta)],
    ['z-omega', evalAt(zCoefficients, omegaTimes(zeta, circuit.n))],
    ['t-lo', evalAt(quotient.tLo, zeta)],
    ['t-mid', evalAt(quotient.tMid, zeta)],
    ['t-hi', evalAt(quotient.tHi, zeta)],
  ];
  const openings: ProofV1['openings'] = openingPairs.map(([label, value]) => ({ label, value }));
  for (const opening of openings)
    await transcript.absorbFp(`opening-${opening.label}`, opening.value);

  const proof: ProofV1 = {
    version: 1,
    params,
    circuitDigest: circuit.digest.slice(),
    publicInputs: publicInputs.slice(),
    wiresRoot,
    zRoot,
    tRoots,
    openings,
    friLayerRoots: [],
    friFinalCoeffs: [],
    queries: [],
  };
  return {
    proof,
    transcript: transcript.log,
    stages: {},
    quotientRemainder: quotient.remainderOnH,
  };
}
