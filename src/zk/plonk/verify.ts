/**
 * Checklist-shaped verifier: returns per-check results (V1–V7), never a bare
 * boolean — the checklist is both the UI and the negative-test oracle.
 * M4 (V1–V2) + M5 (V3–V7).
 */
import { GENERATOR, P, add, mul, pow, sub } from '../field';
import type { Fp } from '../field';
import { evalAt, lagrangeAt, vanishing } from '../poly';
import { createTranscript } from '../transcript';
import type { AnyProof, CheckResult, ProofV1, VerifyResult } from '../types';
import type { QueryOpeningV1 } from '../types';
import type { CompiledCircuit } from '../circuit/compile';
import { publicInputAt, selectorPolynomials, selectorsAt, sigmaPolynomials, zetaIsInLdeCoset, zetaIsInTraceDomain } from './arithmetic';
import { verifyPath } from '../merkle';
import { deepCompositionAt, domainPoint, foldPair } from '../fri/fri';
import { friInitialDegreeBound, quotientChunkCount, quotientChunkLabels } from './chunks';
import { encodeGrindingNonce, verifyGrindingNonce } from '../grinding';
import { verifyFp2 } from './verify-fp2';

function paramsBytes(proof: ProofV1): Uint8Array {
  const grindingBits = proof.params.grindingBits ?? 0;
  const bytes = new Uint8Array(grindingBits === 0 ? 13 : 14);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, proof.params.n, true);
  view.setUint32(4, proof.params.blowup, true);
  view.setUint32(8, proof.params.queries, true);
  bytes[12] = proof.params.zk ? 1 : 0;
  if (grindingBits > 0) bytes[13] = grindingBits;
  return bytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function openingMap(proof: ProofV1): Map<string, Fp> {
  return new Map(proof.openings.map(({ label, value }) => [label, value]));
}

function unavailable(id: CheckResult['id'], detail: string): CheckResult {
  return { id, ok: false, detail };
}

/** Replay M4's transcript and check V1/V2/V7 without claiming FRI soundness. */
export async function verifyM4(circuit: CompiledCircuit, proof: ProofV1): Promise<VerifyResult> {
  const checks: CheckResult[] = [];
  const paramsOk = proof.version === 1
    && proof.params.n === circuit.n
    && proof.params.blowup > 0
    && (proof.params.blowup & (proof.params.blowup - 1)) === 0
    && !proof.params.zk
    && proof.publicInputs.length === circuit.publicRows;
  checks.push({ id: 'V7', ok: paramsOk, detail: paramsOk ? 'M4 parameters match the compiled circuit.' : 'M4 parameters are invalid or unsupported.' });
  if (!paramsOk || !sameBytes(proof.circuitDigest, circuit.digest)) {
    checks.unshift({ id: 'V1', ok: false, detail: 'Transcript replay cannot start: circuit digest or parameters differ.' });
    checks.splice(1, 0, { id: 'V2', ok: false, detail: 'Identity was not evaluated because transcript replay failed.' });
    return { ok: false, checks };
  }

  const transcript = createTranscript('witness-list/plonk-m4/unsound');
  await transcript.absorb('params', paramsBytes(proof));
  await transcript.absorb('circuit-digest', circuit.digest);
  for (const input of proof.publicInputs) await transcript.absorbFp('public-input', input);
  await transcript.absorb('wires-root', proof.wiresRoot.bytes);
  const beta = await transcript.squeezeFp('beta');
  const gamma = await transcript.squeezeFp('gamma');
  await transcript.absorb('z-root', proof.zRoot.bytes);
  const alpha = await transcript.squeezeFp('alpha');
  for (const root of proof.tRoots) await transcript.absorb('t-root', root.bytes);

  let zeta = 0n;
  for (;;) {
    zeta = await transcript.squeezeFp('zeta');
    if (zetaIsInTraceDomain(zeta, circuit.n)) continue;
    if (zetaIsInLdeCoset(zeta, circuit.n, proof.params.blowup)) continue;
    break;
  }
  const openings = openingMap(proof);
  const required = ['a', 'b', 'c', 's-a', 's-b', 's-c', 'z', 'z-omega', 't-lo', 't-mid', 't-hi'];
  const transcriptOk = proof.tRoots.length === 3 && required.every((label) => openings.has(label));
  if (transcriptOk) for (const opening of proof.openings) await transcript.absorbFp(`opening-${opening.label}`, opening.value);
  checks.unshift({ id: 'V1', ok: transcriptOk, detail: transcriptOk ? 'Replayed the canonical M4 Fiat–Shamir transcript.' : 'Missing a required M4 opening.' });
  if (!transcriptOk) {
    checks.splice(1, 0, { id: 'V2', ok: false, detail: 'Identity cannot be evaluated because an opening is missing.' });
    return { ok: false, checks };
  }

  const selectorValues = selectorsAt(selectorPolynomials(circuit), zeta);
  const qL = selectorValues[0]!;
  const qR = selectorValues[1]!;
  const qO = selectorValues[2]!;
  const qM = selectorValues[3]!;
  const qC = selectorValues[4]!;
  const sigmaValues = sigmaPolynomials(circuit).map((polynomial) => evalAt(polynomial, zeta));
  const sA = sigmaValues[0]!;
  const sB = sigmaValues[1]!;
  const sC = sigmaValues[2]!;
  const a = openings.get('a')!;
  const b = openings.get('b')!;
  const c = openings.get('c')!;
  const z = openings.get('z')!;
  const zOmega = openings.get('z-omega')!;
  const product3 = (x: Fp, y: Fp, zValue: Fp): Fp => mul(mul(x, y), zValue);
  const numerator = product3(
    add(add(a, mul(beta, zeta)), gamma),
    add(add(b, mul(beta, mul(7n, zeta))), gamma),
    add(add(c, mul(beta, mul(49n, zeta))), gamma),
  );
  const denominator = product3(
    add(add(a, mul(beta, sA)), gamma),
    add(add(b, mul(beta, sB)), gamma),
    add(add(c, mul(beta, sC)), gamma),
  );
  const gate = add(
    add(mul(qL, a), mul(qR, b)),
    add(mul(qO, c), add(mul(qM, mul(a, b)), qC)),
  );
  const pi = publicInputAt(proof.publicInputs, circuit.n, zeta);
  const transition = sub(mul(z, numerator), mul(zOmega, denominator));
  const boundary = mul(lagrangeAt(0, circuit.n, zeta), sub(z, 1n));
  const left = add(add(gate, pi), add(mul(alpha, transition), mul(mul(alpha, alpha), boundary)));
  const zetaN = pow(zeta, BigInt(circuit.n));
  const quotient = quotientAtZeta(openings, quotientChunkLabels(proof.tRoots.length), zetaN);
  const right = mul(quotient, evalAt(vanishing(circuit.n), zeta));
  const identityOk = left === right;
  checks.splice(1, 0, {
    id: 'V2',
    ok: identityOk,
    detail: identityOk
      ? `M4 main identity holds at ζ: ${left} = ${right}.`
      : `M4 main identity fails at ζ: ${left} ≠ ${right}.`,
  });
  return { ok: checks.every((check) => check.ok), checks };
}

function quotientAtZeta(openings: Map<string, Fp>, labels: readonly string[], zetaN: Fp): Fp {
  let value = 0n;
  let power = 1n;
  for (const label of labels) {
    const chunk = openings.get(label);
    if (chunk === undefined) throw new Error(`missing quotient opening ${label}`);
    value = add(value, mul(power, chunk));
    power = mul(power, zetaN);
  }
  return value;
}

/**
 * Full verifier entry point. Until M5 lands, it deliberately rejects an M4
 * proof after surfacing its real V1/V2 result: no one can mistake it for sound.
 */
export async function verify(circuit: CompiledCircuit, proof: AnyProof): Promise<VerifyResult> {
  return proof.version === 2 ? verifyFp2(circuit, proof) : verifyV1(circuit, proof);
}

async function verifyV1(circuit: CompiledCircuit, proof: ProofV1): Promise<VerifyResult> {
  const expectedChunks = quotientChunkCount(proof.params);
  const quotientLabels = quotientChunkLabels(expectedChunks);
  const requiredOpenings = ['a', 'b', 'c', 's-a', 's-b', 's-c', 'z', 'z-omega', ...quotientLabels];
  const expectedRoots = expectedFriRootCount(friInitialDegreeBound(proof.params));
  const grindingBits = proof.params.grindingBits ?? 0;
  const grindingParamsOk = Number.isSafeInteger(grindingBits) && grindingBits >= 0 && grindingBits <= 24
    && (grindingBits === 0 ? proof.grindingNonce === undefined : Number.isSafeInteger(proof.grindingNonce) && proof.grindingNonce! >= 0 && proof.grindingNonce! <= 0xffffffff);
  const paramsOk = proof.version === 1
    && proof.params.n === circuit.n
    && proof.params.blowup > 0
    && (proof.params.blowup & (proof.params.blowup - 1)) === 0
    && proof.publicInputs.length === circuit.publicRows
    && proof.tRoots.length === expectedChunks
    && proof.friLayerRoots.length === expectedRoots
    && proof.friFinalCoeffs.length === 8
    && proof.queries.length === proof.params.queries
    && grindingParamsOk
    && allFieldElements(proof.publicInputs)
    && allFieldElements(proof.openings.map((opening) => opening.value))
    && allFieldElements(proof.friFinalCoeffs);
  const v7: CheckResult = {
    id: 'V7',
    ok: paramsOk,
    detail: paramsOk ? 'Parameters and FRI shape match the compiled circuit.' : 'Parameters, field encoding, or FRI shape are invalid.',
  };
  if (!paramsOk || !sameBytes(proof.circuitDigest, circuit.digest)) {
    return {
      ok: false,
      checks: [
        { id: 'V1', ok: false, detail: 'Transcript replay cannot start: circuit digest or parameters differ.' },
        { id: 'V2', ok: false, detail: 'Identity was not evaluated because transcript replay failed.' },
        unavailable('V3', 'Merkle queries were not evaluated because transcript replay failed.'),
        unavailable('V4', 'DEEP composition was not evaluated because transcript replay failed.'),
        unavailable('V5', 'FRI folds were not evaluated because transcript replay failed.'),
        unavailable('V6', 'Final FRI polynomial was not evaluated because transcript replay failed.'),
        v7,
      ],
    };
  }

  const openings = openingMap(proof);
  const openingLabelsAreCanonical = proof.openings.length === requiredOpenings.length
    && new Set(proof.openings.map((opening) => opening.label)).size === requiredOpenings.length
    && requiredOpenings.every((label) => openings.has(label));
  if (!openingLabelsAreCanonical) {
    return failedFullTranscript(v7, 'The proof is missing or duplicates a required opening.');
  }

  const transcript = createTranscript('witness-list/plonk-v1');
  await transcript.absorb('params', paramsBytes(proof));
  await transcript.absorb('circuit-digest', circuit.digest);
  for (const input of proof.publicInputs) await transcript.absorbFp('public-input', input);
  await transcript.absorb('wires-root', proof.wiresRoot.bytes);
  const beta = await transcript.squeezeFp('beta');
  const gamma = await transcript.squeezeFp('gamma');
  await transcript.absorb('z-root', proof.zRoot.bytes);
  const alpha = await transcript.squeezeFp('alpha');
  for (const root of proof.tRoots) await transcript.absorb('t-root', root.bytes);
  const zeta = await squeezeZeta(transcript, proof, circuit);
  for (const opening of proof.openings) await transcript.absorbFp(`opening-${opening.label}`, opening.value);
  const rho = await transcript.squeezeFp('rho');
  const foldBetas: Fp[] = [];
  for (let layer = 0; layer < proof.friLayerRoots.length; layer++) {
    await transcript.absorb(`fri-root-${layer}`, proof.friLayerRoots[layer]!.bytes);
    if (layer + 1 < proof.friLayerRoots.length) foldBetas.push(await transcript.squeezeFp(`fri-beta-${layer}`));
  }
  for (const coefficient of proof.friFinalCoeffs) await transcript.absorbFp('fri-final-coeff', coefficient);
  let grindingOk = true;
  if (grindingBits > 0) {
    const nonce = proof.grindingNonce!;
    const challenge = await transcript.workDigest('fri-grinding');
    grindingOk = await verifyGrindingNonce(challenge, grindingBits, nonce);
    await transcript.absorb('fri-grinding-nonce', encodeGrindingNonce(nonce));
  }
  const expectedQueryIndices = Array.from<number>({ length: proof.params.queries }).fill(0);
  for (let query = 0; query < expectedQueryIndices.length; query++) {
    expectedQueryIndices[query] = await transcript.squeezeIndex('fri-query-index', circuit.n * proof.params.blowup);
  }

  const sigma = sigmaPolynomials(circuit);
  const sigmaOpeningsMatch = openings.get('s-a') === evalAt(sigma[0]!, zeta)
    && openings.get('s-b') === evalAt(sigma[1]!, zeta)
    && openings.get('s-c') === evalAt(sigma[2]!, zeta);
  const queryIndicesMatch = proof.queries.every((query, index) => query.index === expectedQueryIndices[index]!);
  const v1: CheckResult = {
    id: 'V1',
    ok: sigmaOpeningsMatch && queryIndicesMatch && grindingOk,
    detail: sigmaOpeningsMatch && queryIndicesMatch && grindingOk
      ? 'Replayed the canonical Fiat–Shamir transcript, including FRI challenges, optional grinding, and query indices.'
      : grindingOk
        ? 'Transcript-bound opening or query index differs from the canonical replay.'
        : 'The post-commitment grinding nonce does not meet its advertised work factor.',
  };

  const v2 = identityCheck(circuit, proof, openings, beta, gamma, alpha, zeta);
  const v3 = await verifyMerkleQueries(proof, expectedQueryIndices);
  const v4 = verifyDeepQueries(proof, openings, rho, zeta);
  const v5 = verifyFriFolds(proof, foldBetas);
  const v6 = verifyFinalFri(proof);
  const checks = [v1, v2, v3, v4, v5, v6, v7];
  return { ok: checks.every((check) => check.ok), checks };
}

function allFieldElements(values: readonly Fp[]): boolean {
  return values.every((value) => value >= 0n && value < P);
}

function expectedFriRootCount(initialDegreeBound: number): number {
  let degreeBound = initialDegreeBound;
  let roots = 1;
  while (degreeBound > 8) {
    degreeBound = Math.ceil(degreeBound / 2);
    roots++;
  }
  return roots;
}

async function squeezeZeta(
  transcript: ReturnType<typeof createTranscript>,
  proof: ProofV1,
  circuit: CompiledCircuit,
): Promise<Fp> {
  for (;;) {
    const zeta = await transcript.squeezeFp('zeta');
    if (zetaIsInTraceDomain(zeta, circuit.n)) continue;
    if (zetaIsInLdeCoset(zeta, circuit.n, proof.params.blowup)) continue;
    return zeta;
  }
}

function failedFullTranscript(v7: CheckResult, detail: string): VerifyResult {
  return {
    ok: false,
    checks: [
      { id: 'V1', ok: false, detail },
      { id: 'V2', ok: false, detail: 'Identity was not evaluated because transcript replay failed.' },
      unavailable('V3', 'Merkle queries were not evaluated because transcript replay failed.'),
      unavailable('V4', 'DEEP composition was not evaluated because transcript replay failed.'),
      unavailable('V5', 'FRI folds were not evaluated because transcript replay failed.'),
      unavailable('V6', 'Final FRI polynomial was not evaluated because transcript replay failed.'),
      v7,
    ],
  };
}

function identityCheck(
  circuit: CompiledCircuit,
  proof: ProofV1,
  openings: Map<string, Fp>,
  beta: Fp,
  gamma: Fp,
  alpha: Fp,
  zeta: Fp,
): CheckResult {
  const selectorValues = selectorsAt(selectorPolynomials(circuit), zeta);
  const [qL, qR, qO, qM, qC] = selectorValues;
  const [sA, sB, sC] = sigmaPolynomials(circuit).map((polynomial) => evalAt(polynomial, zeta));
  const a = openings.get('a')!;
  const b = openings.get('b')!;
  const c = openings.get('c')!;
  const z = openings.get('z')!;
  const zOmega = openings.get('z-omega')!;
  const product3 = (x: Fp, y: Fp, zValue: Fp): Fp => mul(mul(x, y), zValue);
  const numerator = product3(
    add(add(a, mul(beta, zeta)), gamma),
    add(add(b, mul(beta, mul(7n, zeta))), gamma),
    add(add(c, mul(beta, mul(49n, zeta))), gamma),
  );
  const denominator = product3(
    add(add(a, mul(beta, sA!)), gamma),
    add(add(b, mul(beta, sB!)), gamma),
    add(add(c, mul(beta, sC!)), gamma),
  );
  const gate = add(
    add(mul(qL!, a), mul(qR!, b)),
    add(mul(qO!, c), add(mul(qM!, mul(a, b)), qC!)),
  );
  const pi = publicInputAt(proof.publicInputs, circuit.n, zeta);
  const transition = sub(mul(z, numerator), mul(zOmega, denominator));
  const boundary = mul(lagrangeAt(0, circuit.n, zeta), sub(z, 1n));
  const left = add(add(gate, pi), add(mul(alpha, transition), mul(mul(alpha, alpha), boundary)));
  const zetaN = pow(zeta, BigInt(circuit.n));
  const quotient = quotientAtZeta(openings, quotientChunkLabels(proof.tRoots.length), zetaN);
  const right = mul(quotient, evalAt(vanishing(circuit.n), zeta));
  return {
    id: 'V2',
    ok: left === right,
    detail: left === right ? `Main identity holds at ζ: ${left} = ${right}.` : `Main identity fails at ζ: ${left} ≠ ${right}.`,
  };
}

function leaf(query: QueryOpeningV1, label: string, arity: number): Fp[] | undefined {
  const value = query.leaves[label];
  return value !== undefined && value.length === arity && allFieldElements(value) ? value : undefined;
}

function openingPath(query: QueryOpeningV1, label: string, expectedIndex: number) {
  const path = query.paths[label];
  return path !== undefined && path.leafIndex === expectedIndex ? path : undefined;
}

async function verifyMerkleQueries(proof: ProofV1, expectedIndices: readonly number[]): Promise<CheckResult> {
  const size = proof.params.n * proof.params.blowup;
  for (let queryIndex = 0; queryIndex < proof.queries.length; queryIndex++) {
    const query = proof.queries[queryIndex]!;
    const index = expectedIndices[queryIndex]!;
    const rotated = (index + proof.params.blowup) % size;
    const checks: Array<[boolean, string]> = [];
    const wires = leaf(query, 'wires', 3);
    const z = leaf(query, 'z', 1);
    const zOmega = leaf(query, 'z-omega', 1);
    const wirePath = openingPath(query, 'wires', index);
    const zPath = openingPath(query, 'z', index);
    const zOmegaPath = openingPath(query, 'z-omega', rotated);
    checks.push([wires !== undefined && wirePath !== undefined && await verifyPath(proof.wiresRoot, wires, wirePath, 'wires'), 'wire']);
    checks.push([z !== undefined && zPath !== undefined && await verifyPath(proof.zRoot, z, zPath, 'z'), 'Z']);
    checks.push([zOmega !== undefined && zOmegaPath !== undefined && await verifyPath(proof.zRoot, zOmega, zOmegaPath, 'z'), 'Z(ωx)']);
    for (const [chunk, label] of quotientChunkLabels(proof.tRoots.length).entries()) {
      const value = leaf(query, label, 1);
      const path = openingPath(query, label, index);
      checks.push([value !== undefined && path !== undefined && await verifyPath(proof.tRoots[chunk]!, value, path, label), label]);
    }

    let layerIndex = index;
    for (let layer = 0; layer < proof.friLayerRoots.length - 1; layer++) {
      const fri = query.friLayers[layer];
      const layerSize = size >> layer;
      const pair = layerIndex < (layerSize >> 1) ? layerIndex : layerIndex - (layerSize >> 1);
      const sibling = pair + (layerSize >> 1);
      const pathsPresent = fri !== undefined && fri.atPath.leafIndex === pair && fri.siblingPath.leafIndex === sibling;
      checks.push([
        pathsPresent && allFieldElements([fri.at, fri.sibling])
          && await verifyPath(proof.friLayerRoots[layer]!, [fri.at], fri.atPath, `fri-${layer}`)
          && await verifyPath(proof.friLayerRoots[layer]!, [fri.sibling], fri.siblingPath, `fri-${layer}`),
        `FRI layer ${layer}`,
      ]);
      layerIndex = pair;
    }
    const final = query.finalLayer;
    const finalRoot = proof.friLayerRoots[proof.friLayerRoots.length - 1]!;
    checks.push([
      final !== undefined && final.path.leafIndex === layerIndex && allFieldElements([final.value])
        && await verifyPath(finalRoot, [final.value], final.path, `fri-${proof.friLayerRoots.length - 1}`),
      'final FRI layer',
    ]);
    const failure = checks.find(([ok]) => !ok);
    if (failure !== undefined) {
      return { id: 'V3', ok: false, detail: `Merkle opening failed for ${failure[1]} at query ${queryIndex}.`, locus: { query: queryIndex } };
    }
  }
  return { id: 'V3', ok: true, detail: `Verified all committed openings for ${proof.queries.length} FRI queries.` };
}

function friValueAt(query: QueryOpeningV1, layer: number, index: number, layerSize: number): Fp | undefined {
  const opening = query.friLayers[layer];
  if (opening === undefined) return undefined;
  const half = layerSize >> 1;
  const pair = index < half ? index : index - half;
  if (opening.atPath.leafIndex !== pair || opening.siblingPath.leafIndex !== pair + half) return undefined;
  return index < half ? opening.at : opening.sibling;
}

function verifyDeepQueries(proof: ProofV1, openings: Map<string, Fp>, rho: Fp, zeta: Fp): CheckResult {
  const size = proof.params.n * proof.params.blowup;
  const quotientLabels = quotientChunkLabels(proof.tRoots.length);
  const claimed = [
    openings.get('a')!, openings.get('b')!, openings.get('c')!, openings.get('z')!,
    openings.get('z-omega')!, ...quotientLabels.map((label) => openings.get(label)!),
  ];
  for (let queryIndex = 0; queryIndex < proof.queries.length; queryIndex++) {
    const query = proof.queries[queryIndex]!;
    const wires = leaf(query, 'wires', 3);
    const z = leaf(query, 'z', 1);
    const zOmega = leaf(query, 'z-omega', 1);
    const chunks = quotientLabels.map((label) => leaf(query, label, 1));
    if ([wires, z, zOmega, ...chunks].some((value) => value === undefined)) {
      return { id: 'V4', ok: false, detail: `DEEP opening is malformed at query ${queryIndex}.`, locus: { query: queryIndex } };
    }
    const expected = deepCompositionAt(
      domainPoint(query.index, size), zeta, rho,
      [wires![0]!, wires![1]!, wires![2]!, z![0]!, zOmega![0]!, ...chunks.map((chunk) => chunk![0]!)],
      claimed,
    );
    const first = proof.friLayerRoots.length === 1
      ? query.finalLayer.value
      : friValueAt(query, 0, query.index, size);
    if (first !== expected) {
      return { id: 'V4', ok: false, detail: `DEEP composition disagrees with FRI layer 0 at query ${queryIndex}.`, locus: { query: queryIndex } };
    }
  }
  return { id: 'V4', ok: true, detail: 'Every queried DEEP value matches the committed FRI layer 0.' };
}

function verifyFriFolds(proof: ProofV1, betas: readonly Fp[]): CheckResult {
  const initialSize = proof.params.n * proof.params.blowup;
  for (let queryIndex = 0; queryIndex < proof.queries.length; queryIndex++) {
    const query = proof.queries[queryIndex]!;
    let index = query.index;
    let size = initialSize;
    let shift = GENERATOR;
    for (let layer = 0; layer < betas.length; layer++) {
      const opening = query.friLayers[layer];
      const pair = index < (size >> 1) ? index : index - (size >> 1);
      if (opening === undefined) {
        return { id: 'V5', ok: false, detail: `Missing FRI layer ${layer} at query ${queryIndex}.`, locus: { query: queryIndex, layer } };
      }
      const folded = foldPair(opening.at, opening.sibling, betas[layer]!, domainPoint(pair, size, shift));
      index = pair;
      size >>= 1;
      shift = mul(shift, shift);
      const next = layer + 1 === betas.length
        ? query.finalLayer.value
        : friValueAt(query, layer + 1, index, size);
      if (next !== folded) {
        return { id: 'V5', ok: false, detail: `FRI fold fails at query ${queryIndex}, layer ${layer}.`, locus: { query: queryIndex, layer } };
      }
    }
  }
  return { id: 'V5', ok: true, detail: 'All queried FRI fold equations hold.' };
}

function verifyFinalFri(proof: ProofV1): CheckResult {
  const finalSize = (proof.params.n * proof.params.blowup) >> (proof.friLayerRoots.length - 1);
  let shift = GENERATOR;
  for (let layer = 1; layer < proof.friLayerRoots.length; layer++) shift = mul(shift, shift);
  for (let queryIndex = 0; queryIndex < proof.queries.length; queryIndex++) {
    const query = proof.queries[queryIndex]!;
    let index = query.index;
    for (let layer = 0; layer < proof.friLayerRoots.length - 1; layer++) {
      const half = (proof.params.n * proof.params.blowup) >> (layer + 1);
      index = index < half ? index : index - half;
    }
    if (evalAt(proof.friFinalCoeffs, domainPoint(index, finalSize, shift)) !== query.finalLayer.value) {
      return { id: 'V6', ok: false, detail: `Final degree-<8 polynomial disagrees at query ${queryIndex}.`, locus: { query: queryIndex } };
    }
  }
  return { id: 'V6', ok: true, detail: 'Final FRI polynomial has degree < 8 and matches every queried final leaf.' };
}
