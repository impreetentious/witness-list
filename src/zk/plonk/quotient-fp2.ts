/** docs/PROTOCOL-SPEC.md §4.4 — Protocol-v2 PLONK + Plookup constraint composition over Fp². */
import type { Fp } from '../field';
import { mul as mulBase, neg as negBase, twoAdicRoot } from '../field';
import type { Fp2 } from '../fp2';
import { add, embed, fp2One, fp2Zero, isZero, mul, sub } from '../fp2';
import {
  divideByVanishingFp2,
  embedPoly,
  evalFp2,
  fp2PolyAdd,
  fp2PolyMul,
  fp2PolyScale,
  fp2PolySub,
  rotateFp2,
  type Fp2Poly,
} from '../fp2-poly';
import { interpolate } from '../ntt';
import { polyAdd, polyMul, polyScale, polySub } from '../poly';
import type { Poly } from '../poly';
import type { CompiledCircuit, Witness } from '../circuit/compile';
import { selectorPolynomials, sigmaPolynomials } from './arithmetic';
import { buildGrandProductFp2 } from './permutation-fp2';
import { buildLookupGrandProduct, buildLookupWitness, type LookupWitness } from './lookup';

export interface LookupCommittedPolynomials {
  witness: LookupWitness;
  h1?: Poly;
  h2?: Poly;
  z: Fp2Poly;
}

export interface CommittedPolynomialsFp2 {
  a: Poly;
  b: Poly;
  c: Poly;
  z: Fp2Poly;
  lookup?: LookupCommittedPolynomials;
}

export interface ConstraintCompositionFp2 {
  composed: Fp2Poly;
  composedOnH: Fp2[];
  gateOnH: Fp2[];
  copyTransitionOnH: Fp2[];
  copyBoundaryOnH: Fp2[];
  lookupTransitionOnH: Fp2[];
  lookupBoundaryOnH: Fp2[];
}

export interface QuotientResultFp2 {
  chunks: Fp2Poly[];
  remainderOnH: Fp2[];
  exact: boolean;
}

function constant(value: Fp2): Fp2Poly {
  return isZero(value) ? [] : [value];
}
function product3(a: Fp2Poly, b: Fp2Poly, c: Fp2Poly): Fp2Poly {
  return fp2PolyMul(fp2PolyMul(a, b), c);
}

function baseLinear(wire: Fp2Poly, point: Poly, beta: Fp2, gamma: Fp2): Fp2Poly {
  return fp2PolyAdd(fp2PolyAdd(wire, fp2PolyScale(embedPoly(point), beta)), constant(gamma));
}

function lookupFactor(current: Fp2Poly, next: Fp2Poly, beta: Fp2, gamma: Fp2): Fp2Poly {
  return fp2PolyAdd(
    constant(mul(gamma, add(fp2One, beta))),
    fp2PolyAdd(current, fp2PolyScale(next, beta)),
  );
}

export function composeConstraintsFp2(
  circuit: CompiledCircuit,
  witness: Witness,
  publicInputs: Fp[],
  beta: Fp2,
  gamma: Fp2,
  alpha: Fp2,
  committed: CommittedPolynomialsFp2,
): ConstraintCompositionFp2 {
  if (publicInputs.length !== circuit.publicRows)
    throw new Error('Fp² composition public input count mismatch');
  const copy = buildGrandProductFp2(circuit, witness, beta, gamma);
  const lookupWitness = buildLookupWitness(circuit, witness);
  const lookupGrand =
    lookupWitness === undefined ? undefined : buildLookupGrandProduct(lookupWitness, beta, gamma);
  if ((lookupWitness === undefined) !== (committed.lookup === undefined))
    throw new Error('lookup commitments do not match circuit lookup rows');

  const alpha2 = mul(alpha, alpha);
  const alpha3 = mul(alpha2, alpha);
  const alpha4 = mul(alpha3, alpha);
  const gateOnH = Array.from({ length: circuit.n }, () => fp2Zero);
  const copyTransitionOnH = Array.from({ length: circuit.n }, () => fp2Zero);
  const copyBoundaryOnH = Array.from({ length: circuit.n }, () => fp2Zero);
  const lookupTransitionOnH = Array.from({ length: circuit.n }, () => fp2Zero);
  const lookupBoundaryOnH = Array.from({ length: circuit.n }, () => fp2Zero);
  const composedOnH = Array.from({ length: circuit.n }, () => fp2Zero);
  for (let row = 0; row < circuit.n; row++) {
    let gate = add(
      add(
        mul(embed(circuit.qL[row]!), embed(witness.a[row]!)),
        mul(embed(circuit.qR[row]!), embed(witness.b[row]!)),
      ),
      add(
        mul(embed(circuit.qO[row]!), embed(witness.c[row]!)),
        add(
          mul(embed(circuit.qM[row]!), mul(embed(witness.a[row]!), embed(witness.b[row]!))),
          embed(circuit.qC[row]!),
        ),
      ),
    );
    if (row < publicInputs.length) gate = sub(gate, embed(publicInputs[row]!));
    gateOnH[row] = gate;
    copyTransitionOnH[row] = sub(
      mul(copy.z[row]!, copy.numerators[row]!),
      mul(copy.z[(row + 1) % circuit.n]!, copy.denominators[row]!),
    );
    if (row === 0) copyBoundaryOnH[row] = sub(copy.z[0]!, fp2One);
    if (lookupGrand !== undefined) {
      lookupTransitionOnH[row] = sub(
        mul(lookupGrand.z[row]!, lookupGrand.numerators[row]!),
        mul(lookupGrand.z[(row + 1) % circuit.n]!, lookupGrand.denominators[row]!),
      );
      if (row === 0) lookupBoundaryOnH[row] = sub(lookupGrand.z[0]!, fp2One);
    }
    composedOnH[row] = add(
      gate,
      add(
        mul(alpha, copyTransitionOnH[row]!),
        add(
          mul(alpha2, copyBoundaryOnH[row]!),
          add(mul(alpha3, lookupTransitionOnH[row]!), mul(alpha4, lookupBoundaryOnH[row]!)),
        ),
      ),
    );
  }

  const [qL, qR, qO, qM, qC] = selectorPolynomials(circuit).map(embedPoly);
  const a = embedPoly(committed.a);
  const b = embedPoly(committed.b);
  const c = embedPoly(committed.c);
  const gate = fp2PolyAdd(
    fp2PolyAdd(fp2PolyMul(qL!, a), fp2PolyMul(qR!, b)),
    fp2PolyAdd(fp2PolyMul(qO!, c), fp2PolyAdd(fp2PolyMul(qM!, fp2PolyMul(a, b)), qC!)),
  );
  const publicValues = Array.from<Fp>({ length: circuit.n }).fill(0n);
  for (let row = 0; row < publicInputs.length; row++)
    publicValues[row] = negBase(publicInputs[row]!);
  const gateWithPublic = fp2PolyAdd(gate, embedPoly(interpolate(publicValues)));
  const [sA, sB, sC] = sigmaPolynomials(circuit);
  const numerator = product3(
    baseLinear(a, [0n, 1n], beta, gamma),
    baseLinear(b, [0n, 7n], beta, gamma),
    baseLinear(c, [0n, 49n], beta, gamma),
  );
  const denominator = product3(
    baseLinear(a, sA, beta, gamma),
    baseLinear(b, sB, beta, gamma),
    baseLinear(c, sC, beta, gamma),
  );
  const copyTransition = fp2PolySub(
    fp2PolyMul(committed.z, numerator),
    fp2PolyMul(rotateFp2(committed.z, twoAdicRoot(Math.log2(circuit.n))), denominator),
  );
  const l1Values = Array.from<Fp>({ length: circuit.n }).fill(0n);
  l1Values[0] = 1n;
  const l1 = embedPoly(interpolate(l1Values));
  const copyBoundary = fp2PolyMul(l1, fp2PolySub(committed.z, [fp2One]));

  let lookupTransition: Fp2Poly = [];
  let lookupBoundary: Fp2Poly = [];
  if (committed.lookup !== undefined) {
    const qLookup = interpolate(circuit.qLookup);
    const oneMinusQ = polySub([1n], qLookup);
    const fBase = polyAdd(polyMul(qLookup, committed.a), polyScale(oneMinusQ, circuit.lookupDummy));
    const f = embedPoly(fBase);
    const table = embedPoly(interpolate(circuit.lookupTable));
    const omega = twoAdicRoot(Math.log2(circuit.n));
    const rotateBase = (poly: Poly): Fp2Poly =>
      embedPoly(
        poly.map((coefficient, index) => {
          let power = 1n;
          for (let i = 0; i < index; i++) power = mulBase(power, omega);
          return mulBase(coefficient, power);
        }),
      );
    let lookupNumerator: Fp2Poly;
    let lookupDenominator: Fp2Poly;
    if (circuit.lookupMode === 'multiset') {
      const tagBase = polyAdd(
        polyMul(qLookup, interpolate(circuit.lookupTags)),
        polyScale(oneMinusQ, circuit.lookupDummyTag),
      );
      lookupNumerator = fp2PolyAdd(
        constant(gamma),
        fp2PolyAdd(f, fp2PolyScale(embedPoly(tagBase), beta)),
      );
      lookupDenominator = fp2PolyAdd(
        constant(gamma),
        fp2PolyAdd(table, fp2PolyScale(embedPoly(interpolate(circuit.lookupTableTags)), beta)),
      );
    } else {
      const h1 = embedPoly(committed.lookup.h1!);
      const h2 = embedPoly(committed.lookup.h2!);
      lookupNumerator = fp2PolyMul(
        fp2PolyMul(constant(add(fp2One, beta)), fp2PolyAdd(constant(gamma), f)),
        lookupFactor(table, rotateBase(interpolate(circuit.lookupTable)), beta, gamma),
      );
      lookupDenominator = fp2PolyMul(
        lookupFactor(h1, h2, beta, gamma),
        lookupFactor(h2, rotateBase(committed.lookup.h1!), beta, gamma),
      );
    }
    lookupTransition = fp2PolySub(
      fp2PolyMul(committed.lookup.z, lookupNumerator),
      fp2PolyMul(rotateFp2(committed.lookup.z, omega), lookupDenominator),
    );
    lookupBoundary = fp2PolyMul(l1, fp2PolySub(committed.lookup.z, [fp2One]));
  }
  const composed = fp2PolyAdd(
    gateWithPublic,
    fp2PolyAdd(
      fp2PolyScale(copyTransition, alpha),
      fp2PolyAdd(
        fp2PolyScale(copyBoundary, alpha2),
        fp2PolyAdd(fp2PolyScale(lookupTransition, alpha3), fp2PolyScale(lookupBoundary, alpha4)),
      ),
    ),
  );
  return {
    composed,
    composedOnH,
    gateOnH,
    copyTransitionOnH,
    copyBoundaryOnH,
    lookupTransitionOnH,
    lookupBoundaryOnH,
  };
}

export function buildQuotientFp2(
  composed: readonly Fp2[],
  n: number,
  chunkCount: number,
): QuotientResultFp2 {
  const { q, r } = divideByVanishingFp2(composed, n);
  if (q.length > chunkCount * n) throw new Error('Fp² quotient exceeds committed chunk layout');
  const chunks = Array.from({ length: chunkCount }, (_, index) =>
    q.slice(index * n, (index + 1) * n),
  );
  const omega = twoAdicRoot(Math.log2(n));
  let point = 1n;
  const remainderOnH = Array.from({ length: n }, () => fp2Zero);
  for (let row = 0; row < n; row++) {
    remainderOnH[row] = evalFp2(r, embed(point));
    point = mulBase(point, omega);
  }
  return { chunks, remainderOnH, exact: r.every(isZero) };
}
