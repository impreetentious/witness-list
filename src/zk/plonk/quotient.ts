/**
 * Constraint composition C(x) and quotient t = C / Z_H with exact-division check —
 * the pedagogical heart: nonzero remainder rows ARE "the equation that catches you".
 * M4. Gate Z6.
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

/**
 * Compose the PLONK gate, copy-transition, and boundary relations directly on
 * H, then interpolate C. This is M4 foundation work only — it is unsound
 * without the later low-degree commitments and FRI checks.
 */
export function composeConstraints(
  circuit: CompiledCircuit,
  witness: Witness,
  publicInputs: Fp[],
  beta: Fp,
  gamma: Fp,
  alpha: Fp,
): ConstraintComposition {
  if (publicInputs.length !== circuit.publicRows) {
    throw new Error(`expected ${circuit.publicRows} public inputs, received ${publicInputs.length}`);
  }
  const grandProduct = buildGrandProduct(circuit, witness, beta, gamma);
  const { numerators, denominators } = permutationFactors(circuit, witness, beta, gamma);
  const alphaSquared = mul(alpha, alpha);
  const gateOnH = new Array<Fp>(circuit.n);
  const transitionOnH = new Array<Fp>(circuit.n);
  const boundaryOnH = new Array<Fp>(circuit.n).fill(0n);
  const composedOnH = new Array<Fp>(circuit.n);

  for (let row = 0; row < circuit.n; row++) {
    let gate = add(
      add(mul(circuit.qL[row]!, witness.a[row]!), mul(circuit.qR[row]!, witness.b[row]!)),
      add(mul(circuit.qO[row]!, witness.c[row]!), mul(circuit.qM[row]!, mul(witness.a[row]!, witness.b[row]!))),
    );
    gate = add(gate, circuit.qC[row]!);
    if (row < circuit.publicRows) gate = sub(gate, publicInputs[row]!);
    gateOnH[row] = gate;
    transitionOnH[row] = sub(
      mul(grandProduct.z[row]!, numerators[row]!),
      mul(grandProduct.z[(row + 1) % circuit.n]!, denominators[row]!),
    );
    if (row === 0) boundaryOnH[row] = sub(grandProduct.z[0]!, 1n);
    composedOnH[row] = add(gate, add(mul(alpha, transitionOnH[row]!), mul(alphaSquared, boundaryOnH[row]!)));
  }
  const wirePolynomials = [witness.a, witness.b, witness.c].map(interpolate);
  const a = wirePolynomials[0]!;
  const b = wirePolynomials[1]!;
  const c = wirePolynomials[2]!;
  const z = interpolate(grandProduct.z);
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
  const constant = (value: Fp): Poly => value === 0n ? [] : [value];
  const linearFactor = (wire: Poly, idOrSigma: Poly): Poly =>
    polyAdd(polyAdd(wire, polyScale(idOrSigma, beta)), constant(gamma));
  const product3 = (left: Poly, middle: Poly, right: Poly): Poly => polyMul(polyMul(left, middle), right);
  const gate = polyAdd(
    polyAdd(polyMul(qL, a), polyMul(qR, b)),
    polyAdd(polyMul(qO, c), polyAdd(polyMul(qM, polyMul(a, b)), qC)),
  );
  const publicInputValues = new Array<Fp>(circuit.n).fill(0n);
  for (let row = 0; row < publicInputs.length; row++) publicInputValues[row] = neg(publicInputs[row]!);
  const gateWithPublicInputs = polyAdd(gate, interpolate(publicInputValues));
  const numerator = product3(linearFactor(a, identityA), linearFactor(b, identityB), linearFactor(c, identityC));
  const denominator = product3(linearFactor(a, sA), linearFactor(b, sB), linearFactor(c, sC));
  const omega = twoAdicRoot(Math.log2(circuit.n));
  let omegaPower = 1n;
  const zOmega = z.map((coefficient) => {
    const scaled = mul(coefficient, omegaPower);
    omegaPower = mul(omegaPower, omega);
    return scaled;
  });
  const transition = polySub(polyMul(z, numerator), polyMul(zOmega, denominator));
  const l1Values = new Array<Fp>(circuit.n).fill(0n);
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
): QuotientResult {
  if (!Number.isSafeInteger(n) || n < 1 || (n & (n - 1)) !== 0) {
    throw new Error('quotient domain size must be a positive power of two');
  }
  const { q, r } = polyDivRem(composed, vanishing(n));
  const omega = twoAdicRoot(Math.log2(n));
  const remainderOnH = new Array<Fp>(n);
  let point = 1n;
  for (let row = 0; row < n; row++) {
    remainderOnH[row] = evalAt(r, point);
    point = mul(point, omega);
  }

  // v1's unblinded composition has degree below 3n. The later prover adds its
  // documented blinding slack before committing these same positional chunks.
  return {
    tLo: q.slice(0, n),
    tMid: q.slice(n, 2 * n),
    tHi: q.slice(2 * n, 3 * n),
    remainderOnH,
    exact: r.length === 0,
  };
}
