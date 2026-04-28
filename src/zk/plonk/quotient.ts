/**
 * Constraint composition C(x) and quotient t = C / Z_H with exact-division check —
 * the pedagogical heart: nonzero remainder rows ARE "the equation that catches you".
 * docs/PROTOCOL-SPEC.md §4.4. Gate Z6.
 */
import { add, mul, neg, sub, twoAdicRoot } from '../field';
import type { Fp } from '../field';
import { evalAt, polyAdd, polyDivRem, polyMul, polyScale, polySub, vanishing } from '../poly';
import type { Poly } from '../poly';
import type { CompiledCircuit, Witness } from '../circuit/compile';
import { buildGrandProduct, permutationFactors } from './permutation';
import { interpolate } from '../ntt';
import { selectorPolynomials, sigmaPolynomials } from './arithmetic';

export interface QuotientResult {
  tLo: Poly;
  tMid: Poly;
  tHi: Poly;
  /** Positional chunks, including deterministic zero-padded trailing chunks in ZK mode. */
  chunks: Poly[];
  /** remainder evaluations over H — all zero iff the witness satisfies the circuit */
  remainderOnH: Fp[];
  exact: boolean;
}

export interface ConstraintComposition {
  /** C evaluated on H: these are the exact rows highlighted by cheat mode. */
  composedOnH: Fp[];
  gateOnH: Fp[];
  transitionOnH: Fp[];
  boundaryOnH: Fp[];
  composed: Poly;
}

export interface CommittedPolynomials {
  a: Poly;
  b: Poly;
  c: Poly;
  z: Poly;
}

/**
 * Compose the PLONK gate, copy-transition, and boundary relations directly on
 * H, then interpolate C. The identity alone is unsound without the low-degree
 * commitments and FRI checks (docs/PROTOCOL-SPEC.md §4.4).
 */
export function composeConstraints(
  circuit: CompiledCircuit,
  witness: Witness,
  publicInputs: Fp[],
  beta: Fp,
  gamma: Fp,
  alpha: Fp,
  committed?: CommittedPolynomials,
): ConstraintComposition {
  if (publicInputs.length !== circuit.publicRows) {
    throw new Error(
      `expected ${circuit.publicRows} public inputs, received ${publicInputs.length}`,
    );
  }
  const grandProduct = buildGrandProduct(circuit, witness, beta, gamma);
  const { numerators, denominators } = permutationFactors(circuit, witness, beta, gamma);
  const alphaSquared = mul(alpha, alpha);
  const gateOnH = Array.from<Fp>({ length: circuit.n }).fill(0n);
  const transitionOnH = Array.from<Fp>({ length: circuit.n }).fill(0n);
  const boundaryOnH = Array.from<Fp>({ length: circuit.n }).fill(0n);
  const composedOnH = Array.from<Fp>({ length: circuit.n }).fill(0n);

  for (let row = 0; row < circuit.n; row++) {
    let gate = add(
      add(mul(circuit.qL[row]!, witness.a[row]!), mul(circuit.qR[row]!, witness.b[row]!)),
      add(
        mul(circuit.qO[row]!, witness.c[row]!),
        mul(circuit.qM[row]!, mul(witness.a[row]!, witness.b[row]!)),
      ),
    );
    gate = add(gate, circuit.qC[row]!);
    if (row < circuit.publicRows) gate = sub(gate, publicInputs[row]!);
    gateOnH[row] = gate;
    transitionOnH[row] = sub(
      mul(grandProduct.z[row]!, numerators[row]!),
      mul(grandProduct.z[(row + 1) % circuit.n]!, denominators[row]!),
    );
    if (row === 0) boundaryOnH[row] = sub(grandProduct.z[0]!, 1n);
    composedOnH[row] = add(
      gate,
      add(mul(alpha, transitionOnH[row]!), mul(alphaSquared, boundaryOnH[row]!)),
    );
  }
  const wirePolynomials = [witness.a, witness.b, witness.c].map(interpolate);
  const a = committed?.a ?? wirePolynomials[0]!;
  const b = committed?.b ?? wirePolynomials[1]!;
  const c = committed?.c ?? wirePolynomials[2]!;
  const z = committed?.z ?? interpolate(grandProduct.z);
  const selectorPolys = selectorPolynomials(circuit);
  const qL = selectorPolys[0]!;
  const qR = selectorPolys[1]!;
  const qO = selectorPolys[2]!;
  const qM = selectorPolys[3]!;
  const qC = selectorPolys[4]!;
  const sigmaPolys = sigmaPolynomials(circuit);
  const sA = sigmaPolys[0]!;
  const sB = sigmaPolys[1]!;
  const sC = sigmaPolys[2]!;
  const identityA: Poly = [0n, 1n];
  const identityB: Poly = [0n, 7n];
  const identityC: Poly = [0n, 49n];
  const constant = (value: Fp): Poly => (value === 0n ? [] : [value]);
  const linearFactor = (wire: Poly, idOrSigma: Poly): Poly =>
    polyAdd(polyAdd(wire, polyScale(idOrSigma, beta)), constant(gamma));
  const product3 = (left: Poly, middle: Poly, right: Poly): Poly =>
    polyMul(polyMul(left, middle), right);
  const gate = polyAdd(
    polyAdd(polyMul(qL, a), polyMul(qR, b)),
    polyAdd(polyMul(qO, c), polyAdd(polyMul(qM, polyMul(a, b)), qC)),
  );
  const publicInputValues = Array.from<Fp>({ length: circuit.n }).fill(0n);
  for (let row = 0; row < publicInputs.length; row++)
    publicInputValues[row] = neg(publicInputs[row]!);
  const gateWithPublicInputs = polyAdd(gate, interpolate(publicInputValues));
  const numerator = product3(
    linearFactor(a, identityA),
    linearFactor(b, identityB),
    linearFactor(c, identityC),
  );
  const denominator = product3(linearFactor(a, sA), linearFactor(b, sB), linearFactor(c, sC));
  const omega = twoAdicRoot(Math.log2(circuit.n));
  let omegaPower = 1n;
  const zOmega = z.map((coefficient) => {
    const scaled = mul(coefficient, omegaPower);
    omegaPower = mul(omegaPower, omega);
    return scaled;
  });
  const transition = polySub(polyMul(z, numerator), polyMul(zOmega, denominator));
  const l1Values = Array.from<Fp>({ length: circuit.n }).fill(0n);
  l1Values[0] = 1n;
  const boundary = polyMul(interpolate(l1Values), polySub(z, [1n]));
  const composed = polyAdd(
    gateWithPublicInputs,
    polyAdd(polyScale(transition, alpha), polyScale(boundary, alphaSquared)),
  );
  return { composedOnH, gateOnH, transitionOnH, boundaryOnH, composed };
}

export function buildQuotient(
  composed: Poly, // gate + PI + α·transition + α²·boundary
  n: number,
  chunkCount = 3,
): QuotientResult {
  if (!Number.isSafeInteger(n) || n < 1 || (n & (n - 1)) !== 0) {
    throw new Error('quotient domain size must be a positive power of two');
  }
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 3)
    throw new Error('quotient needs at least three chunks');
  const { q, r } = polyDivRem(composed, vanishing(n));
  const omega = twoAdicRoot(Math.log2(n));
  const remainderOnH = Array.from<Fp>({ length: n }).fill(0n);
  let point = 1n;
  for (let row = 0; row < n; row++) {
    remainderOnH[row] = evalAt(r, point);
    point = mul(point, omega);
  }

  const chunks = Array.from({ length: chunkCount }, (_, chunk) =>
    q.slice(chunk * n, (chunk + 1) * n),
  );
  if (q.length > chunkCount * n) throw new Error('quotient exceeds its committed chunk layout');
  return {
    tLo: chunks[0]!,
    tMid: chunks[1]!,
    tHi: chunks[2]!,
    chunks,
    remainderOnH,
    exact: r.length === 0,
  };
}
