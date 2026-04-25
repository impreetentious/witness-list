/**
 * The three canned malicious provers — shared verbatim between the cheat-mode UI
 * and the negative test suite (Z9): the demo IS the test. docs/PROTOCOL-SPEC.md §6.3. M5.
 *
 * A1 tamperWitness  -> caught by V2 (identity at ζ) — after the stage-8 remainder banner
 * A2 tamperLeaf     -> caught by V3 (Merkle path) at a specific query
 * A3 grindChallenge -> statistics: succeeds ~2^bits attempts vs weakened verifier (Z12)
 */
import { GENERATOR, add, inv, mod, mul, pow, sub, twoAdicRoot } from './field';
import type { Fp } from './field';
import type { Circuit } from './circuit/ir';
import { cosetLDE, interpolate } from './ntt';
import { buildTree } from './merkle';
import type { MerkleTree } from './merkle';
import { evalAt } from './poly';
import { createTranscript } from './transcript';
import type { Params, ProofTrace, ProofV1, QueryOpening, QueryOpeningV1 } from './types';
import { compile, generateWitness } from './circuit/compile';
import { proveForcedPastRemainder } from './plonk/prove';
import { buildGrandProduct } from './plonk/permutation';
import { buildQuotient, composeConstraints } from './plonk/quotient';
import {
  omegaTimes,
  sigmaPolynomials,
  zetaIsInLdeCoset,
  zetaIsInTraceDomain,
} from './plonk/arithmetic';
import { buildFri, deepCompositionAt, domainPoint, interpolateCoset } from './fri/fri';
import { verify } from './plonk/verify';

export const A3_BLOWUP = 8;

export async function tamperWitness(
  circuit: Circuit,
  inputs: Map<number, Fp>,
  overrides: Map<number, Fp>,
  params: Params,
  seed: number,
): Promise<ProofTrace> {
  const compiled = await compile(circuit);
  const publicInputs = circuit.publicOrder.map((wire) => {
    const value = inputs.get(wire);
    if (value === undefined) throw new Error(`attack A1 is missing public input wire ${wire}`);
    return mod(value);
  });
  return proveForcedPastRemainder(
    compiled,
    generateWitness(circuit, inputs, overrides),
    publicInputs,
    params,
    seed,
  );
}

/**
 * A2 changes a value after its root has been absorbed. The caller selects an
 * actually queried LDE index (the player does this from its query inspector),
 * so the shared verifier deterministically names V3 as the catch.
 */
export function tamperLeaf(trace: ProofTrace, leafIndex: number): ProofTrace {
  const queryIndex = trace.proof.queries.findIndex((query) => query.index === leafIndex);
  if (queryIndex < 0)
    throw new Error(`attack A2 needs a queried leaf index; ${leafIndex} was not queried`);
  const query = trace.proof.queries[queryIndex]!;
  const wires = query.leaves.wires;
  if (wires === undefined || wires.length !== 3)
    throw new Error('attack A2 proof has no composite wire leaf');
  const proof =
    trace.proof.version === 1
      ? {
          ...trace.proof,
          queries: trace.proof.queries.map((candidate, index) =>
            index !== queryIndex
              ? candidate
              : {
                  ...candidate,
                  leaves: {
                    ...candidate.leaves,
                    wires: [add(wires[0]!, 1n), wires[1]!, wires[2]!],
                  },
                },
          ) as QueryOpeningV1[],
        }
      : {
          ...trace.proof,
          queries: trace.proof.queries.map((candidate, index) =>
            index !== queryIndex
              ? candidate
              : {
                  ...candidate,
                  leaves: {
                    ...candidate.leaves,
                    wires: [add(wires[0]!, 1n), wires[1]!, wires[2]!],
                  },
                },
          ) as QueryOpening[],
        };
  return { ...trace, proof };
}

interface CommittedValues {
  evaluations: Fp[][];
  tree: MerkleTree;
}

interface GrindingContext {
  circuit: Awaited<ReturnType<typeof compile>>;
  params: Params;
  publicInputs: Fp[];
  zeta: Fp;
  openings: ProofV1['openings'];
  wires: CommittedValues;
  z: CommittedValues;
  t: [CommittedValues, CommittedValues, CommittedValues];
}

function paramsBytes(params: Params): Uint8Array {
  const bytes = new Uint8Array(13);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, params.n, true);
  view.setUint32(4, params.blowup, true);
  view.setUint32(8, params.queries, true);
  bytes[12] = params.zk ? 1 : 0;
  return bytes;
}

function padded(coefficients: Fp[], n: number): Fp[] {
  if (coefficients.length > n)
    throw new Error('attack quotient chunk exceeds trace-domain degree bound');
  return [...coefficients, ...Array<Fp>(n - coefficients.length).fill(0n)];
}

async function commitPolynomial(
  coefficients: Fp[],
  blowup: number,
  domainSep: string,
): Promise<CommittedValues> {
  const evaluations = cosetLDE(coefficients, blowup).map((value) => [value]);
  return { evaluations, tree: await buildTree(evaluations, domainSep) };
}

async function commitWires(a: Fp[], b: Fp[], c: Fp[], blowup: number): Promise<CommittedValues> {
  const aLde = cosetLDE(a, blowup);
  const bLde = cosetLDE(b, blowup);
  const cLde = cosetLDE(c, blowup);
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

/** Rebuild the ordinary commitments and transcript state up to the ζ openings. */
async function createGrindingContext(
  circuit: Circuit,
  inputs: Map<number, Fp>,
  params: Params,
): Promise<GrindingContext> {
  const compiled = await compile(circuit);
  if (params.n !== compiled.n || params.zk)
    throw new Error('attack A3 needs an unblinded parameter set matching its circuit');
  const publicInputs = circuit.publicOrder.map((wire) => {
    const value = inputs.get(wire);
    if (value === undefined) throw new Error(`attack A3 is missing public input wire ${wire}`);
    return mod(value);
  });
  const witness = generateWitness(circuit, inputs);
  const a = interpolate(witness.a);
  const b = interpolate(witness.b);
  const c = interpolate(witness.c);
  const wires = await commitWires(a, b, c, params.blowup);
  const transcript = createTranscript('witness-list/plonk-v1');
  await transcript.absorb('params', paramsBytes(params));
  await transcript.absorb('circuit-digest', compiled.digest);
  for (const input of publicInputs) await transcript.absorbFp('public-input', input);
  await transcript.absorb('wires-root', wires.tree.root.bytes);
  const beta = await transcript.squeezeFp('beta');
  const gamma = await transcript.squeezeFp('gamma');
  const zCoefficients = interpolate(buildGrandProduct(compiled, witness, beta, gamma).z);
  const z = await commitPolynomial(zCoefficients, params.blowup, 'z');
  await transcript.absorb('z-root', z.tree.root.bytes);
  const alpha = await transcript.squeezeFp('alpha');
  const quotient = buildQuotient(
    composeConstraints(compiled, witness, publicInputs, beta, gamma, alpha).composed,
    compiled.n,
  );
  if (!quotient.exact) throw new Error('attack A3 needs an honest statement as its starting point');
  const t = (await Promise.all([
    commitPolynomial(padded(quotient.tLo, compiled.n), params.blowup, 't-lo'),
    commitPolynomial(padded(quotient.tMid, compiled.n), params.blowup, 't-mid'),
    commitPolynomial(padded(quotient.tHi, compiled.n), params.blowup, 't-hi'),
  ])) as [CommittedValues, CommittedValues, CommittedValues];
  for (const commitment of t) await transcript.absorb('t-root', commitment.tree.root.bytes);
  const zeta = await squeezeZeta(transcript, params);
  const [sA, sB, sC] = sigmaPolynomials(compiled);
  const openingPairs: Array<[string, Fp]> = [
    ['a', evalAt(a, zeta)],
    ['b', evalAt(b, zeta)],
    ['c', evalAt(c, zeta)],
    ['s-a', evalAt(sA, zeta)],
    ['s-b', evalAt(sB, zeta)],
    ['s-c', evalAt(sC, zeta)],
    ['z', evalAt(zCoefficients, zeta)],
    ['z-omega', evalAt(zCoefficients, omegaTimes(zeta, compiled.n))],
    ['t-lo', evalAt(quotient.tLo, zeta)],
    ['t-mid', evalAt(quotient.tMid, zeta)],
    ['t-hi', evalAt(quotient.tHi, zeta)],
  ];
  const openings: ProofV1['openings'] = openingPairs.map(([label, value]) => ({ label, value }));
  return { circuit: compiled, params, publicInputs, zeta, openings, wires, z, t };
}

/** Recreate the transcript through rho after changing only the claimed t chunks. */
async function transcriptToRho(
  context: GrindingContext,
  openings: ProofV1['openings'],
): Promise<Fp> {
  const transcript = createTranscript('witness-list/plonk-v1');
  await transcript.absorb('params', paramsBytes(context.params));
  await transcript.absorb('circuit-digest', context.circuit.digest);
  for (const input of context.publicInputs) await transcript.absorbFp('public-input', input);
  await transcript.absorb('wires-root', context.wires.tree.root.bytes);
  await transcript.squeezeFp('beta');
  await transcript.squeezeFp('gamma');
  await transcript.absorb('z-root', context.z.tree.root.bytes);
  await transcript.squeezeFp('alpha');
  for (const commitment of context.t) await transcript.absorb('t-root', commitment.tree.root.bytes);
  const zeta = await squeezeZeta(transcript, context.params);
  if (zeta !== context.zeta)
    throw new Error('attack A3 transcript replay diverged before openings');
  for (const opening of openings)
    await transcript.absorbFp(`opening-${opening.label}`, opening.value);
  return transcript.squeezeFp('rho');
}

async function forgedGrindingProof(context: GrindingContext, nonce: number): Promise<ProofV1> {
  const openingByLabel = new Map(context.openings.map((opening) => [opening.label, opening.value]));
  // Preserve V2 while lying about both quotient chunks: t_lo + ζ^n·t_mid
  // stays fixed, but the DEEP claims (and therefore the FRI root) vary.
  const delta = BigInt(nonce + 1);
  const zetaN = pow(context.zeta, BigInt(context.circuit.n));
  openingByLabel.set('t-lo', add(openingByLabel.get('t-lo')!, delta));
  openingByLabel.set('t-mid', sub(openingByLabel.get('t-mid')!, mul(delta, inv(zetaN))));
  const openings = context.openings.map((opening) => ({
    label: opening.label,
    value: openingByLabel.get(opening.label)!,
  }));
  const rho = await transcriptToRho(context, openings);
  const claims = [
    openingByLabel.get('a')!,
    openingByLabel.get('b')!,
    openingByLabel.get('c')!,
    openingByLabel.get('z')!,
    openingByLabel.get('z-omega')!,
    openingByLabel.get('t-lo')!,
    openingByLabel.get('t-mid')!,
    openingByLabel.get('t-hi')!,
  ];
  const ldeSize = context.circuit.n * context.params.blowup;
  const offset = nonce % context.params.blowup;
  const sampleValues = Array.from<Fp>({ length: context.circuit.n }).fill(0n);
  for (let row = 0; row < context.circuit.n; row++) {
    const index = offset + row * context.params.blowup;
    const rotatedZIndex = (index + context.params.blowup) % ldeSize;
    sampleValues[row] = deepCompositionAt(
      domainPoint(index, ldeSize),
      context.zeta,
      rho,
      [
        context.wires.evaluations[index]![0]!,
        context.wires.evaluations[index]![1]!,
        context.wires.evaluations[index]![2]!,
        context.z.evaluations[index]![0]!,
        context.z.evaluations[rotatedZIndex]![0]!,
        context.t[0].evaluations[index]![0]!,
        context.t[1].evaluations[index]![0]!,
        context.t[2].evaluations[index]![0]!,
      ],
      claims,
    );
  }
  const ldeRoot = twoAdicRoot(Math.log2(ldeSize));
  const sampleShift = mul(GENERATOR, pow(ldeRoot, BigInt(offset)));
  const fakeCoefficients = interpolateCoset(sampleValues, sampleShift);
  const fakeValues = cosetLDE(padded(fakeCoefficients, context.circuit.n), context.params.blowup);

  // Reconstruct the transcript once more: buildFri must derive its challenges
  // from the exact altered openings, then bind its own roots before queries.
  const transcript = createTranscript('witness-list/plonk-v1');
  await transcript.absorb('params', paramsBytes(context.params));
  await transcript.absorb('circuit-digest', context.circuit.digest);
  for (const input of context.publicInputs) await transcript.absorbFp('public-input', input);
  await transcript.absorb('wires-root', context.wires.tree.root.bytes);
  await transcript.squeezeFp('beta');
  await transcript.squeezeFp('gamma');
  await transcript.absorb('z-root', context.z.tree.root.bytes);
  await transcript.squeezeFp('alpha');
  for (const commitment of context.t) await transcript.absorb('t-root', commitment.tree.root.bytes);
  await squeezeZeta(transcript, context.params);
  for (const opening of openings)
    await transcript.absorbFp(`opening-${opening.label}`, opening.value);
  await transcript.squeezeFp('rho');
  const fri = await buildFri(fakeValues, context.circuit.n, transcript, context.params.queries);
  const queries = fri.queries.map((query) => {
    const index = query.index;
    const rotatedZIndex = (index + context.params.blowup) % ldeSize;
    return {
      ...query,
      leaves: {
        wires: context.wires.evaluations[index]!.slice(),
        z: context.z.evaluations[index]!.slice(),
        'z-omega': context.z.evaluations[rotatedZIndex]!.slice(),
        't-lo': context.t[0].evaluations[index]!.slice(),
        't-mid': context.t[1].evaluations[index]!.slice(),
        't-hi': context.t[2].evaluations[index]!.slice(),
      },
      paths: {
        wires: context.wires.tree.path(index),
        z: context.z.tree.path(index),
        'z-omega': context.z.tree.path(rotatedZIndex),
        't-lo': context.t[0].tree.path(index),
        't-mid': context.t[1].tree.path(index),
        't-hi': context.t[2].tree.path(index),
      },
    };
  });
  return {
    version: 1,
    params: context.params,
    circuitDigest: context.circuit.digest.slice(),
    publicInputs: context.publicInputs.slice(),
    wiresRoot: context.wires.tree.root,
    zRoot: context.z.tree.root,
    tRoots: context.t.map((commitment) => commitment.tree.root),
    openings,
    friLayerRoots: fri.roots,
    friFinalCoeffs: fri.finalCoeffs,
    queries,
  };
}

/**
 * A3 uses an actual forged proof, not a random counter. Each candidate FRI
 * polynomial agrees with the real DEEP values on exactly one of `blowup`
 * LDE cosets. With Q queries it can pass only when every derived index falls
 * in that selected coset: approximately (1/blowup)^Q (docs/PROTOCOL-SPEC.md §4.11).
 */
export async function grindChallenge(
  circuit: Circuit,
  inputs: Map<number, Fp>,
  weakQueries: number,
  maxAttempts: number,
): Promise<{ attempts: number; succeeded: boolean }> {
  if (!Number.isSafeInteger(weakQueries) || weakQueries < 1)
    throw new Error('attack A3 needs at least one query');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw new Error('attack A3 needs a positive attempt budget');
  const compiled = await compile(circuit);
  const context = await createGrindingContext(circuit, inputs, {
    n: compiled.n,
    blowup: A3_BLOWUP,
    queries: weakQueries,
    zk: false,
  });
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const proof = await forgedGrindingProof(context, attempt);
    if ((await verify(context.circuit, proof)).ok)
      return { attempts: attempt + 1, succeeded: true };
  }
  return { attempts: maxAttempts, succeeded: false };
}

/**
 * Deterministic geometric samples for the selected-coset part of A3. The real
 * forged-proof path above is exercised by the Z12 smoke gate; this lightweight
 * companion makes the 200-trial rate assertion practical in normal CI.
 */
export function sampleGrindingAttempts(
  weakQueries: number,
  trials: number,
  seed = 0x51a3,
): number[] {
  if (!Number.isSafeInteger(weakQueries) || weakQueries < 1)
    throw new Error('A3 samples need at least one query');
  if (!Number.isSafeInteger(trials) || trials < 1)
    throw new Error('A3 samples need a positive trial count');
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
  return Array.from({ length: trials }, () => {
    let attempts = 0;
    for (;;) {
      attempts++;
      let selected = true;
      for (let query = 0; query < weakQueries; query++) {
        if (next() % A3_BLOWUP !== 0) selected = false;
      }
      if (selected) return attempts;
    }
  });
}
