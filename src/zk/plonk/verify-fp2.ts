/** docs/PROTOCOL-SPEC.md §4.8 — Checklist verifier for protocol wire v2 (Fp² + Plookup). */
import { GENERATOR, P, mul as mulBase, pow as powBase, twoAdicRoot } from '../field';
import type { Fp } from '../field';
import type { Fp2 } from '../fp2';
import {
  add,
  embed,
  equal,
  format,
  fp2,
  fp2One,
  fp2Zero,
  isCanonical,
  mul,
  pow,
  sub,
} from '../fp2';
import { evalBaseAtFp2, evalFp2, lagrangeFp2, publicInputAtFp2 } from '../fp2-poly';
import { createTranscript } from '../transcript';
import type { CheckResult, Proof, QueryOpening, VerifyResult } from '../types';
import type { CompiledCircuit } from '../circuit/compile';
import { selectorPolynomials, sigmaPolynomials } from './arithmetic';
import { quotientChunkCount, quotientChunkLabels, friInitialDegreeBound } from './chunks';
import { hasLookups } from './lookup';
import { verifyPath } from '../merkle';
import { domainPoint } from '../fri/fri';
import { deepCompositionAtFp2, foldPairFp2 } from '../fri/fri-fp2';
import { encodeGrindingNonce, verifyGrindingNonce } from '../grinding';
import { interpolate } from '../ntt';
import { paramsAreSupported } from './params';

function paramsBytes(proof: Proof): Uint8Array {
  const bits = proof.params.grindingBits ?? 0;
  const bytes = new Uint8Array(bits === 0 ? 13 : 14);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, proof.params.n, true);
  view.setUint32(4, proof.params.blowup, true);
  view.setUint32(8, proof.params.queries, true);
  bytes[12] = proof.params.zk ? 1 : 0;
  if (bits > 0) bytes[13] = bits;
  return bytes;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectedFriRootCount(bound: number): number {
  let roots = 1;
  while (bound > 8) {
    bound = Math.ceil(bound / 2);
    roots++;
  }
  return roots;
}

function unavailable(id: CheckResult['id'], detail: string): CheckResult {
  return { id, ok: false, detail };
}

function failure(v7: CheckResult, detail: string): VerifyResult {
  return {
    ok: false,
    checks: [
      { id: 'V1', ok: false, detail },
      {
        id: 'V2',
        ok: false,
        detail: 'Identity was not evaluated because transcript replay failed.',
      },
      unavailable('V3', 'Merkle queries were not evaluated.'),
      unavailable('V4', 'DEEP composition was not evaluated.'),
      unavailable('V5', 'FRI folds were not evaluated.'),
      unavailable('V6', 'Final FRI polynomial was not evaluated.'),
      v7,
    ],
  };
}

function openingMap(proof: Proof): Map<string, Fp2> {
  return new Map(proof.openings.map(({ label, value }) => [label, value]));
}

async function squeezeZeta(
  transcript: ReturnType<typeof createTranscript>,
  proof: Proof,
): Promise<Fp2> {
  const size = BigInt(proof.params.n * proof.params.blowup);
  for (;;) {
    const zeta = await transcript.squeezeFp2('zeta');
    if (zeta.c1 !== 0n) return zeta;
    if (powBase(zeta.c0, BigInt(proof.params.n)) === 1n) continue;
    if (powBase(zeta.c0, size) === powBase(GENERATOR, size)) continue;
    return zeta;
  }
}

export async function verifyFp2(circuit: CompiledCircuit, proof: Proof): Promise<VerifyResult> {
  const baseParamsOk = paramsAreSupported(proof.params, circuit.n);
  if (!baseParamsOk) {
    const v7: CheckResult = {
      id: 'V7',
      ok: false,
      detail: 'Protocol-v2 parameters are outside the supported range.',
    };
    return failure(v7, 'Transcript replay cannot start: protocol-v2 parameters are unsupported.');
  }
  const lookup = hasLookups(circuit);
  const chunks = quotientChunkCount(proof.params);
  const quotientLabels = quotientChunkLabels(chunks);
  const lookupLabels = lookup
    ? [
        ...(circuit.lookupMode === 'membership'
          ? ['lookup-h1', 'lookup-h1-omega', 'lookup-h2', 'lookup-h2-omega']
          : []),
        'lookup-z',
        'lookup-z-omega',
      ]
    : [];
  const required = [
    'a',
    'b',
    'c',
    's-a',
    's-b',
    's-c',
    'z',
    'z-omega',
    ...quotientLabels,
    ...lookupLabels,
  ];
  const bits = proof.params.grindingBits ?? 0;
  const grindingShape =
    Number.isSafeInteger(bits) &&
    bits >= 0 &&
    bits <= 24 &&
    (bits === 0
      ? proof.grindingNonce === undefined
      : Number.isSafeInteger(proof.grindingNonce) &&
        proof.grindingNonce! >= 0 &&
        proof.grindingNonce! <= 0xffffffff);
  const paramsOk =
    proof.version === 2 &&
    baseParamsOk &&
    proof.publicInputs.length === circuit.publicRows &&
    proof.publicInputs.every((value) => value >= 0n && value < P) &&
    proof.tRoots.length === chunks &&
    proof.friLayerRoots.length === expectedFriRootCount(friInitialDegreeBound(proof.params)) &&
    proof.friFinalCoeffs.length === 8 &&
    proof.friFinalCoeffs.every(isCanonical) &&
    proof.openings.every((opening) => isCanonical(opening.value)) &&
    proof.queries.length === proof.params.queries &&
    lookup === (proof.lookupRoots !== undefined) &&
    (proof.lookupRoots === undefined ||
      (proof.lookupRoots.mode === circuit.lookupMode &&
        (circuit.lookupMode === 'membership'
          ? proof.lookupRoots.h1Root !== undefined && proof.lookupRoots.h2Root !== undefined
          : proof.lookupRoots.h1Root === undefined && proof.lookupRoots.h2Root === undefined))) &&
    grindingShape;
  const v7: CheckResult = {
    id: 'V7',
    ok: paramsOk,
    detail: paramsOk
      ? 'Protocol-v2 Fp², lookup, and FRI shapes match the circuit.'
      : 'Protocol-v2 parameter, extension encoding, lookup, or FRI shape is invalid.',
  };
  if (!paramsOk || !sameBytes(proof.circuitDigest, circuit.digest))
    return failure(
      v7,
      'Transcript replay cannot start: circuit digest or protocol-v2 parameters differ.',
    );
  const openings = openingMap(proof);
  if (
    proof.openings.length !== required.length ||
    new Set(proof.openings.map((opening) => opening.label)).size !== required.length ||
    !required.every((label) => openings.has(label))
  ) {
    return failure(v7, 'The proof is missing or duplicates a canonical Fp² opening.');
  }

  const transcript = createTranscript('witness-list/plonk-v2/fp2-plookup');
  await transcript.absorb('params', paramsBytes(proof));
  await transcript.absorb('circuit-digest', circuit.digest);
  for (const input of proof.publicInputs) await transcript.absorbFp('public-input', input);
  await transcript.absorb('wires-root', proof.wiresRoot.bytes);
  if (proof.lookupRoots?.mode === 'membership') {
    await transcript.absorb('lookup-h1-root', proof.lookupRoots.h1Root!.bytes);
    await transcript.absorb('lookup-h2-root', proof.lookupRoots.h2Root!.bytes);
  }
  const beta = await transcript.squeezeFp2('beta');
  const gamma = await transcript.squeezeFp2('gamma');
  await transcript.absorb('z-root', proof.zRoot.bytes);
  if (proof.lookupRoots !== undefined)
    await transcript.absorb('lookup-z-root', proof.lookupRoots.zRoot.bytes);
  const alpha = await transcript.squeezeFp2('alpha');
  for (const root of proof.tRoots) await transcript.absorb('t-root', root.bytes);
  const zeta = await squeezeZeta(transcript, proof);
  for (const opening of proof.openings)
    await transcript.absorbFp2(`opening-${opening.label}`, opening.value);
  const rho = await transcript.squeezeFp2('rho');
  const foldBetas: Fp2[] = [];
  for (let layer = 0; layer < proof.friLayerRoots.length; layer++) {
    await transcript.absorb(`fri-root-${layer}`, proof.friLayerRoots[layer]!.bytes);
    if (layer + 1 < proof.friLayerRoots.length)
      foldBetas.push(await transcript.squeezeFp2(`fri-beta-${layer}`));
  }
  for (const coefficient of proof.friFinalCoeffs)
    await transcript.absorbFp2('fri-final-coeff', coefficient);
  let grindingOk = true;
  if (bits > 0) {
    const nonce = proof.grindingNonce!;
    grindingOk = await verifyGrindingNonce(
      await transcript.workDigest('fri-grinding'),
      bits,
      nonce,
    );
    await transcript.absorb('fri-grinding-nonce', encodeGrindingNonce(nonce));
  }
  const expectedIndices: number[] = [];
  for (let query = 0; query < proof.params.queries; query++)
    expectedIndices.push(
      await transcript.squeezeIndex('fri-query-index', circuit.n * proof.params.blowup),
    );
  const sigma = sigmaPolynomials(circuit);
  const sigmaOk =
    equal(openings.get('s-a')!, evalBaseAtFp2(sigma[0], zeta)) &&
    equal(openings.get('s-b')!, evalBaseAtFp2(sigma[1], zeta)) &&
    equal(openings.get('s-c')!, evalBaseAtFp2(sigma[2], zeta));
  const queryIndicesOk = proof.queries.every(
    (query, index) => query.index === expectedIndices[index],
  );
  const v1: CheckResult = {
    id: 'V1',
    ok: sigmaOk && queryIndicesOk && grindingOk,
    detail:
      sigmaOk && queryIndicesOk && grindingOk
        ? 'Replayed canonical Fp² challenges, lookup roots, FRI folds, optional grinding, and query indices.'
        : grindingOk
          ? 'An Fp² transcript-bound opening or query index differs from replay.'
          : 'The transcript-bound grinding nonce is invalid.',
  };
  const v2 = identityCheck(circuit, proof, openings, beta, gamma, alpha, zeta);
  const v3 = await verifyMerkleQueries(proof, expectedIndices, lookup);
  const v4 = verifyDeepQueries(proof, openings, rho, zeta, lookup);
  const v5 = verifyFriFolds(proof, foldBetas);
  const v6 = verifyFinalFri(proof);
  const checks = [v1, v2, v3, v4, v5, v6, v7];
  return { ok: checks.every((check) => check.ok), checks };
}

function product3(a: Fp2, b: Fp2, c: Fp2): Fp2 {
  return mul(mul(a, b), c);
}
function lookupFactor(gamma: Fp2, beta: Fp2, current: Fp2, next: Fp2): Fp2 {
  return add(mul(gamma, add(fp2One, beta)), add(current, mul(beta, next)));
}

function identityCheck(
  circuit: CompiledCircuit,
  proof: Proof,
  openings: Map<string, Fp2>,
  beta: Fp2,
  gamma: Fp2,
  alpha: Fp2,
  zeta: Fp2,
): CheckResult {
  const selectors = selectorPolynomials(circuit).map((poly) => evalBaseAtFp2(poly, zeta));
  const sigmas = sigmaPolynomials(circuit).map((poly) => evalBaseAtFp2(poly, zeta));
  const qL = selectors[0]!,
    qR = selectors[1]!,
    qO = selectors[2]!,
    qM = selectors[3]!,
    qC = selectors[4]!;
  const sA = sigmas[0]!,
    sB = sigmas[1]!,
    sC = sigmas[2]!;
  const a = openings.get('a')!,
    b = openings.get('b')!,
    c = openings.get('c')!,
    z = openings.get('z')!,
    zOmega = openings.get('z-omega')!;
  const numerator = product3(
    add(add(a, mul(beta, zeta)), gamma),
    add(add(b, mul(beta, mul(embed(7n), zeta))), gamma),
    add(add(c, mul(beta, mul(embed(49n), zeta))), gamma),
  );
  const denominator = product3(
    add(add(a, mul(beta, sA)), gamma),
    add(add(b, mul(beta, sB)), gamma),
    add(add(c, mul(beta, sC)), gamma),
  );
  const gate = add(add(mul(qL, a), mul(qR, b)), add(mul(qO, c), add(mul(qM, mul(a, b)), qC)));
  const pi = publicInputAtFp2(proof.publicInputs, circuit.n, zeta);
  const copyTransition = sub(mul(z, numerator), mul(zOmega, denominator));
  const copyBoundary = mul(lagrangeFp2(0, circuit.n, zeta), sub(z, fp2One));
  let lookupTransition = fp2Zero;
  let lookupBoundary = fp2Zero;
  if (proof.lookupRoots !== undefined) {
    const omegaZeta = mul(zeta, embed(twoAdicRoot(Math.log2(circuit.n))));
    const qLookup = evalBaseAtFp2(interpolateSelector(circuit.qLookup), zeta);
    const f = add(mul(qLookup, a), mul(sub(fp2One, qLookup), embed(circuit.lookupDummy)));
    const table = evalBaseAtFp2(interpolateSelector(circuit.lookupTable), zeta);
    const lookupZ = openings.get('lookup-z')!,
      lookupZOmega = openings.get('lookup-z-omega')!;
    let lookupNumerator: Fp2;
    let lookupDenominator: Fp2;
    if (circuit.lookupMode === 'multiset') {
      const tags = evalBaseAtFp2(interpolateSelector(circuit.lookupTags), zeta);
      const tableTags = evalBaseAtFp2(interpolateSelector(circuit.lookupTableTags), zeta);
      const fTag = add(
        mul(qLookup, tags),
        mul(sub(fp2One, qLookup), embed(circuit.lookupDummyTag)),
      );
      lookupNumerator = add(gamma, add(f, mul(beta, fTag)));
      lookupDenominator = add(gamma, add(table, mul(beta, tableTags)));
    } else {
      const tableOmega = evalBaseAtFp2(interpolateSelector(circuit.lookupTable), omegaZeta);
      const h1 = openings.get('lookup-h1')!,
        h1Omega = openings.get('lookup-h1-omega')!;
      const h2 = openings.get('lookup-h2')!;
      lookupNumerator = mul(
        mul(add(fp2One, beta), add(gamma, f)),
        lookupFactor(gamma, beta, table, tableOmega),
      );
      lookupDenominator = mul(
        lookupFactor(gamma, beta, h1, h2),
        lookupFactor(gamma, beta, h2, h1Omega),
      );
    }
    lookupTransition = sub(mul(lookupZ, lookupNumerator), mul(lookupZOmega, lookupDenominator));
    lookupBoundary = mul(lagrangeFp2(0, circuit.n, zeta), sub(lookupZ, fp2One));
  }
  const alpha2 = mul(alpha, alpha),
    alpha3 = mul(alpha2, alpha),
    alpha4 = mul(alpha3, alpha);
  const left = add(
    add(gate, pi),
    add(
      mul(alpha, copyTransition),
      add(
        mul(alpha2, copyBoundary),
        add(mul(alpha3, lookupTransition), mul(alpha4, lookupBoundary)),
      ),
    ),
  );
  const zetaN = pow(zeta, BigInt(circuit.n));
  let quotient = fp2Zero,
    power = fp2One;
  for (const label of quotientChunkLabels(proof.tRoots.length)) {
    quotient = add(quotient, mul(power, openings.get(label)!));
    power = mul(power, zetaN);
  }
  const right = mul(quotient, sub(zetaN, fp2One));
  const ok = equal(left, right);
  return {
    id: 'V2',
    ok,
    detail: ok
      ? `Fp² PLONK${proof.lookupRoots === undefined ? '' : ' + Plookup'} identity holds at ζ: ${format(left)}.`
      : `Fp² identity fails: ${format(left)} ≠ ${format(right)}.`,
  };
}

const interpolateSelector = interpolate;

function canonicalLeaf(query: QueryOpening, label: string, arity: number): Fp[] | undefined {
  const leaf = query.leaves[label];
  return leaf !== undefined &&
    leaf.length === arity &&
    leaf.every((value) => value >= 0n && value < P)
    ? leaf
    : undefined;
}
function pathAt(query: QueryOpening, label: string, index: number) {
  const path = query.paths[label];
  return path?.leafIndex === index ? path : undefined;
}

async function verifyMerkleQueries(
  proof: Proof,
  expected: readonly number[],
  lookup: boolean,
): Promise<CheckResult> {
  const size = proof.params.n * proof.params.blowup;
  for (let qi = 0; qi < proof.queries.length; qi++) {
    const query = proof.queries[qi]!,
      index = expected[qi]!,
      rotated = (index + proof.params.blowup) % size;
    const roots: Array<[string, number, number, { bytes: Uint8Array }, string]> = [
      ['wires', 3, index, proof.wiresRoot, 'wires'],
      ['z', 2, index, proof.zRoot, 'z2'],
      ['z-omega', 2, rotated, proof.zRoot, 'z2'],
      ...quotientChunkLabels(proof.tRoots.length).map(
        (label, chunk) =>
          [label, 2, index, proof.tRoots[chunk]!, label] as [
            string,
            number,
            number,
            { bytes: Uint8Array },
            string,
          ],
      ),
    ];
    if (lookup && proof.lookupRoots!.mode === 'membership')
      roots.push(
        ['lookup-h1', 1, index, proof.lookupRoots!.h1Root!, 'lookup-h1'],
        ['lookup-h1-omega', 1, rotated, proof.lookupRoots!.h1Root!, 'lookup-h1'],
        ['lookup-h2', 1, index, proof.lookupRoots!.h2Root!, 'lookup-h2'],
        ['lookup-h2-omega', 1, rotated, proof.lookupRoots!.h2Root!, 'lookup-h2'],
      );
    if (lookup)
      roots.push(
        ['lookup-z', 2, index, proof.lookupRoots!.zRoot, 'lookup-z2'],
        ['lookup-z-omega', 2, rotated, proof.lookupRoots!.zRoot, 'lookup-z2'],
      );
    for (const [label, arity, leafIndex, root, domain] of roots) {
      const leaf = canonicalLeaf(query, label, arity),
        path = pathAt(query, label, leafIndex);
      if (
        leaf === undefined ||
        path === undefined ||
        !(await verifyPath(root, leaf, path, domain, size))
      )
        return {
          id: 'V3',
          ok: false,
          detail: `Merkle opening failed for ${label} at query ${qi}.`,
          locus: { query: qi },
        };
    }
    let layerIndex = index;
    for (let layer = 0; layer < proof.friLayerRoots.length - 1; layer++) {
      const opening = query.friLayers[layer],
        layerSize = size >> layer,
        pair = layerIndex < layerSize >> 1 ? layerIndex : layerIndex - (layerSize >> 1),
        sibling = pair + (layerSize >> 1);
      if (
        opening === undefined ||
        !isCanonical(opening.at) ||
        !isCanonical(opening.sibling) ||
        opening.atPath.leafIndex !== pair ||
        opening.siblingPath.leafIndex !== sibling ||
        !(await verifyPath(
          proof.friLayerRoots[layer]!,
          [opening.at.c0, opening.at.c1],
          opening.atPath,
          `fri2-${layer}`,
          layerSize,
        )) ||
        !(await verifyPath(
          proof.friLayerRoots[layer]!,
          [opening.sibling.c0, opening.sibling.c1],
          opening.siblingPath,
          `fri2-${layer}`,
          layerSize,
        ))
      )
        return {
          id: 'V3',
          ok: false,
          detail: `Fp² FRI Merkle opening failed at query ${qi}, layer ${layer}.`,
          locus: { query: qi, layer },
        };
      layerIndex = pair;
    }
    const final = query.finalLayer,
      finalLayer = proof.friLayerRoots.length - 1;
    if (
      !isCanonical(final.value) ||
      final.path.leafIndex !== layerIndex ||
      !(await verifyPath(
        proof.friLayerRoots[finalLayer]!,
        [final.value.c0, final.value.c1],
        final.path,
        `fri2-${finalLayer}`,
        size >> finalLayer,
      ))
    )
      return {
        id: 'V3',
        ok: false,
        detail: `Final Fp² FRI opening failed at query ${qi}.`,
        locus: { query: qi },
      };
  }
  return {
    id: 'V3',
    ok: true,
    detail: `Verified all base/Fp²${lookup ? '/lookup' : ''} commitments for ${proof.queries.length} queries.`,
  };
}

function fp2FromLeaf(query: QueryOpening, label: string): Fp2 | undefined {
  const value = canonicalLeaf(query, label, 2);
  return value === undefined ? undefined : fp2(value[0]!, value[1]!);
}
function baseFromLeaf(query: QueryOpening, label: string): Fp2 | undefined {
  const value = canonicalLeaf(query, label, 1);
  return value === undefined ? undefined : embed(value[0]!);
}
function friAt(query: QueryOpening, layer: number, index: number, size: number): Fp2 | undefined {
  const opening = query.friLayers[layer];
  if (opening === undefined) return undefined;
  const half = size >> 1;
  return index < half ? opening.at : opening.sibling;
}

function verifyDeepQueries(
  proof: Proof,
  openings: Map<string, Fp2>,
  rho: Fp2,
  zeta: Fp2,
  lookup: boolean,
): CheckResult {
  const size = proof.params.n * proof.params.blowup;
  const labels = [
    'a',
    'b',
    'c',
    'z',
    'z-omega',
    ...quotientChunkLabels(proof.tRoots.length),
    ...(lookup
      ? [
          ...(proof.lookupRoots!.mode === 'membership'
            ? ['lookup-h1', 'lookup-h1-omega', 'lookup-h2', 'lookup-h2-omega']
            : []),
          'lookup-z',
          'lookup-z-omega',
        ]
      : []),
  ];
  const claims = labels.map((label) => openings.get(label)!);
  for (let qi = 0; qi < proof.queries.length; qi++) {
    const query = proof.queries[qi]!;
    const wires = canonicalLeaf(query, 'wires', 3);
    if (wires === undefined)
      return {
        id: 'V4',
        ok: false,
        detail: `Malformed wire leaf at query ${qi}.`,
        locus: { query: qi },
      };
    const values: Array<Fp2 | undefined> = [
      embed(wires[0]!),
      embed(wires[1]!),
      embed(wires[2]!),
      fp2FromLeaf(query, 'z'),
      fp2FromLeaf(query, 'z-omega'),
      ...quotientChunkLabels(proof.tRoots.length).map((label) => fp2FromLeaf(query, label)),
    ];
    if (lookup && proof.lookupRoots!.mode === 'membership')
      values.push(
        baseFromLeaf(query, 'lookup-h1'),
        baseFromLeaf(query, 'lookup-h1-omega'),
        baseFromLeaf(query, 'lookup-h2'),
        baseFromLeaf(query, 'lookup-h2-omega'),
      );
    if (lookup) values.push(fp2FromLeaf(query, 'lookup-z'), fp2FromLeaf(query, 'lookup-z-omega'));
    if (values.some((value) => value === undefined))
      return {
        id: 'V4',
        ok: false,
        detail: `Malformed DEEP leaf at query ${qi}.`,
        locus: { query: qi },
      };
    const expected = deepCompositionAtFp2(
      domainPoint(query.index, size),
      zeta,
      rho,
      values as Fp2[],
      claims,
    );
    const first =
      proof.friLayerRoots.length === 1
        ? query.finalLayer.value
        : friAt(query, 0, query.index, size);
    if (first === undefined || !equal(first, expected))
      return {
        id: 'V4',
        ok: false,
        detail: `Fp² DEEP composition disagrees at query ${qi}.`,
        locus: { query: qi },
      };
  }
  return { id: 'V4', ok: true, detail: 'Every queried Fp² DEEP value matches FRI layer 0.' };
}

function verifyFriFolds(proof: Proof, betas: readonly Fp2[]): CheckResult {
  const initialSize = proof.params.n * proof.params.blowup;
  for (let qi = 0; qi < proof.queries.length; qi++) {
    const query = proof.queries[qi]!;
    let index = query.index,
      size = initialSize,
      shift = GENERATOR;
    for (let layer = 0; layer < betas.length; layer++) {
      const opening = query.friLayers[layer];
      if (opening === undefined)
        return {
          id: 'V5',
          ok: false,
          detail: `Missing Fp² FRI layer ${layer}.`,
          locus: { query: qi, layer },
        };
      const pair = index < size >> 1 ? index : index - (size >> 1);
      const folded = foldPairFp2(
        opening.at,
        opening.sibling,
        betas[layer]!,
        domainPoint(pair, size, shift),
      );
      index = pair;
      size >>= 1;
      shift = mulBase(shift, shift);
      const next =
        layer + 1 === betas.length ? query.finalLayer.value : friAt(query, layer + 1, index, size);
      if (next === undefined || !equal(next, folded))
        return {
          id: 'V5',
          ok: false,
          detail: `Fp² FRI fold fails at query ${qi}, layer ${layer}.`,
          locus: { query: qi, layer },
        };
    }
  }
  return { id: 'V5', ok: true, detail: 'All queried Fp² FRI fold equations hold.' };
}

function verifyFinalFri(proof: Proof): CheckResult {
  const finalSize = (proof.params.n * proof.params.blowup) >> (proof.friLayerRoots.length - 1);
  let shift = GENERATOR;
  for (let layer = 1; layer < proof.friLayerRoots.length; layer++) shift = mulBase(shift, shift);
  for (let qi = 0; qi < proof.queries.length; qi++) {
    let index = proof.queries[qi]!.index;
    for (let layer = 0; layer < proof.friLayerRoots.length - 1; layer++) {
      const half = (proof.params.n * proof.params.blowup) >> (layer + 1);
      index = index < half ? index : index - half;
    }
    if (
      !equal(
        evalFp2(proof.friFinalCoeffs, embed(domainPoint(index, finalSize, shift))),
        proof.queries[qi]!.finalLayer.value,
      )
    )
      return {
        id: 'V6',
        ok: false,
        detail: `Final Fp² degree-<8 polynomial disagrees at query ${qi}.`,
        locus: { query: qi },
      };
  }
  return {
    id: 'V6',
    ok: true,
    detail: 'Final Fp² FRI polynomial has degree < 8 and matches every query.',
  };
}
