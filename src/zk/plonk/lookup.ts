/** Plookup-style sorted-concatenation grand product for protocol v2. */
import type { Fp } from '../field';
import type { Fp2 } from '../fp2';
import { add, embed, fp2One, inv, isZero, mul } from '../fp2';
import type { CompiledCircuit, Witness } from '../circuit/compile';

export interface LookupWitness {
  mode: 'membership' | 'multiset';
  f: Fp[];
  fTags: Fp[];
  table: Fp[];
  tableTags: Fp[];
  h1?: Fp[];
  h2?: Fp[];
}

export interface LookupGrandProduct {
  z: Fp2[];
  partials: Fp2[];
  numerators: Fp2[];
  denominators: Fp2[];
}

export function hasLookups(circuit: CompiledCircuit): boolean {
  return circuit.qLookup.some((value) => value === 1n);
}

export function buildLookupWitness(circuit: CompiledCircuit, witness: Witness): LookupWitness | undefined {
  if (!hasLookups(circuit)) return undefined;
  const f = circuit.qLookup.map((selector, row) => selector === 1n ? witness.a[row]! : circuit.lookupDummy);
  const fTags = circuit.qLookup.map((selector, row) => selector === 1n ? circuit.lookupTags[row]! : circuit.lookupDummyTag);
  const table = circuit.lookupTable.slice();
  const tableTags = circuit.lookupTableTags.slice();
  if (circuit.lookupMode === 'multiset') return { mode: 'multiset', f, fTags, table, tableTags };
  const sorted = [...f, ...table].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return {
    mode: 'membership', f, fTags, table, tableTags,
    h1: Array.from({ length: circuit.n }, (_, index) => sorted[index * 2]!),
    h2: Array.from({ length: circuit.n }, (_, index) => sorted[index * 2 + 1]!),
  };
}

function productFactor(gamma: Fp2, beta: Fp2, current: Fp, next: Fp): Fp2 {
  return add(mul(gamma, add(fp2One, beta)), add(embed(current), mul(beta, embed(next))));
}

/**
 * Z(ωx)/Z(x) = (1+β)(γ+f)(γ(1+β)+t+βt') /
 *              ((γ(1+β)+h1+βh2)(γ(1+β)+h2+βh1')).
 */
export function buildLookupGrandProduct(witness: LookupWitness, beta: Fp2, gamma: Fp2): LookupGrandProduct {
  const n = witness.f.length;
  const numerators = Array.from({ length: n }, () => fp2One);
  const denominators = Array.from({ length: n }, () => fp2One);
  for (let row = 0; row < n; row++) {
    const next = (row + 1) % n;
    if (witness.mode === 'multiset') {
      const query = add(embed(witness.f[row]!), mul(beta, embed(witness.fTags[row]!)));
      const table = add(embed(witness.table[row]!), mul(beta, embed(witness.tableTags[row]!)));
      numerators[row] = add(gamma, query);
      denominators[row] = add(gamma, table);
      continue;
    }
    numerators[row] = mul(
      mul(add(fp2One, beta), add(gamma, embed(witness.f[row]!))),
      productFactor(gamma, beta, witness.table[row]!, witness.table[next]!),
    );
    denominators[row] = mul(
      productFactor(gamma, beta, witness.h1![row]!, witness.h2![row]!),
      productFactor(gamma, beta, witness.h2![row]!, witness.h1![next]!),
    );
  }
  const z = Array.from({ length: n }, () => fp2One);
  const partials = Array.from({ length: n }, () => fp2One);
  let running = fp2One;
  for (let row = 0; row < n; row++) {
    if (isZero(denominators[row]!)) throw new Error(`lookup grand-product denominator is zero at row ${row}`);
    running = mul(running, mul(numerators[row]!, inv(denominators[row]!)));
    partials[row] = running;
    if (row + 1 < n) z[row + 1] = running;
  }
  return { z, partials, numerators, denominators };
}
