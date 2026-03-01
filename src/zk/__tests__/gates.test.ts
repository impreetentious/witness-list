/**
 * The honesty gates. Z1/Z2 are REAL now (field.ts is implemented);
 * fixture values were computed by an independent Python implementation
 * (tools/reference.py) before any TypeScript existed. The rest are it.todo,
 * converted milestone by milestone.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  P,
  add,
  batchInverse,
  inv,
  mod,
  mul,
  neg,
  pow,
  sub,
  twoAdicRoot,
} from '../field';
import { cosetLDE, interpolate, intt, ntt } from '../ntt';
import { evalAt, lagrangeAt, polyAdd, polyDivRem, polyMul, vanishing } from '../poly';
import { buildTree, verifyPath } from '../merkle';
import { createTranscript } from '../transcript';

const fpArb = fc.bigInt({ min: 0n, max: P - 1n });
const fpNonZeroArb = fc.bigInt({ min: 1n, max: P - 1n });

describe('Z1: field laws (property fuzz)', () => {
  it('addition/multiplication laws', () => {
    fc.assert(
      fc.property(fpArb, fpArb, fpArb, (a, b, c) => {
        expect(add(a, b)).toBe(add(b, a));
        expect(mul(a, b)).toBe(mul(b, a));
        expect(add(add(a, b), c)).toBe(add(a, add(b, c)));
        expect(mul(mul(a, b), c)).toBe(mul(a, mul(b, c)));
        expect(mul(a, add(b, c))).toBe(add(mul(a, b), mul(a, c)));
        expect(add(a, neg(a))).toBe(0n);
        expect(sub(a, b)).toBe(add(a, neg(b)));
      }),
      { numRuns: 300 },
    );
  });

  it('inverses and Fermat', () => {
    fc.assert(
      fc.property(fpNonZeroArb, (a) => {
        expect(mul(a, inv(a))).toBe(1n);
        expect(pow(a, P - 1n)).toBe(1n);
      }),
      { numRuns: 100 },
    );
  });

  it('batchInverse matches inv', () => {
    fc.assert(
      fc.property(fc.array(fpNonZeroArb, { minLength: 1, maxLength: 40 }), (xs) => {
        const batch = batchInverse(xs);
        xs.forEach((x, i) => expect(batch[i]).toBe(inv(x)));
      }),
      { numRuns: 50 },
    );
  });
});

describe('Z2: fixed vectors (independently computed)', () => {
  it('mul/add vectors', () => {
    const a = 16045690981402826360n;
    const b = 14627333967224062753n;
    expect(mul(a, b)).toBe(11964319653047658634n);
    expect(add(a, b)).toBe(12226280879212304792n);
  });

  it('inv(7), pow vector, mod of negatives', () => {
    expect(inv(7n)).toBe(2635249152773512046n);
    expect(pow(3n, 1000000007n)).toBe(16525317176295360948n);
    expect(mod(-1n)).toBe(P - 1n);
  });

  it('2-adic roots: values and orders', () => {
    expect(twoAdicRoot(3)).toBe(18446744069397807105n); // ω₈
    expect(twoAdicRoot(16)).toBe(6115771955107415310n); // ω₂¹⁶
    const w = twoAdicRoot(13);
    expect(pow(w, 1n << 13n)).toBe(1n);
    expect(pow(w, 1n << 12n)).not.toBe(1n);
    // 7 is a QNR: 7^((p-1)/2) = p-1 (x²−7 irreducible ⇒ shelf extension well-defined)
    expect(pow(7n, (P - 1n) >> 1n)).toBe(P - 1n);
  });
});

describe('M1 gates — poly & NTT', () => {
  it('Z3: iNTT∘NTT = id for n = 2..2^13; NTT matches naive DFT for n ≤ 64', () => {
    for (let logN = 1; logN <= 13; logN++) {
      const n = 1 << logN;
      const values = Array.from({ length: n }, (_, i) => BigInt((i + 1) * (logN + 3)));
      expect(intt(ntt(values))).toEqual(values);
      expect(interpolate(ntt(values))).toEqual(values);
    }

    for (const n of [2, 4, 8, 16, 32, 64]) {
      const values = Array.from({ length: n }, (_, i) => BigInt(i * i + 3 * i + 1));
      const omega = twoAdicRoot(Math.log2(n));
      const expected = values.map((_, row) =>
        values.reduce((sum, value, column) => add(sum, mul(value, pow(omega, BigInt(row * column)))), 0n),
      );
      expect(ntt(values)).toEqual(expected);
    }
  });

  it('Z4: multiplication/division round-trip and barycentric L_i(ζ) match direct evaluation', () => {
    fc.assert(
      fc.property(
        fc.array(fpArb, { minLength: 0, maxLength: 12 }),
        fc.array(fpArb, { minLength: 0, maxLength: 12 }),
        fpNonZeroArb,
        fc.array(fpArb, { minLength: 0, maxLength: 6 }),
        (q, divisorTail, divisorLead, remainderCoeffs) => {
          const divisor = [...divisorTail, divisorLead];
          const remainder = remainderCoeffs.slice(0, Math.max(0, divisor.length - 1));
          const dividend = polyAdd(polyMul(q, divisor), remainder);
          const result = polyDivRem(dividend, divisor);
          expect(polyAdd(polyMul(result.q, divisor), result.r)).toEqual(dividend);
          expect(result.r.length).toBeLessThan(divisor.length);
        },
      ),
      { numRuns: 100 },
    );

    const n = 8;
    const omega = twoAdicRoot(3);
    const zeta = 7n;
    for (let i = 0; i < n; i++) {
      let basis = [1n];
      let denominator = 1n;
      const point = pow(omega, BigInt(i));
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const other = pow(omega, BigInt(j));
        basis = polyMul(basis, [neg(other), 1n]);
        denominator = mul(denominator, sub(point, other));
      }
      const direct = mul(evalAt(basis, zeta), inv(denominator));
      expect(lagrangeAt(i, n, zeta)).toBe(direct);
      expect(evalAt(vanishing(n), zeta)).toBe(sub(pow(zeta, 8n), 1n));
    }
  });

  it('M1 bench: coset LDE of 2^13 coeffs < 100 ms', () => {
    const coeffs = Array.from({ length: 1 << 13 }, (_, i) => BigInt(i + 1));
    const startedAt = performance.now();
    const evaluations = cosetLDE(coeffs, 8);
    const elapsedMs = performance.now() - startedAt;
    expect(evaluations).toHaveLength(1 << 16);
    expect(elapsedMs).toBeLessThan(100);
  });
});

describe('M2 gates — Merkle commitments & Fiat–Shamir transcript', () => {
  it('Merkle paths bind the domain-separated leaf index and composite field leaf', async () => {
    const leaves = Array.from({ length: 8 }, (_, i) => [BigInt(i + 1), BigInt((i + 1) ** 2)]);
    const tree = await buildTree(leaves, 'wires');
    expect(tree.depth).toBe(3);

    for (let i = 0; i < leaves.length; i++) {
      expect(await verifyPath(tree.root, leaves[i]!, tree.path(i), 'wires')).toBe(true);
    }

    expect(await verifyPath(tree.root, [999n, 1n], tree.path(3), 'wires')).toBe(false);
    expect(await verifyPath(tree.root, leaves[3]!, tree.path(3), 'different-domain')).toBe(false);
  });

  it('Fiat–Shamir transcript replays byte-for-byte and domain separates challenges', async () => {
    async function replay(label: string) {
      const transcript = createTranscript('witness-list/v1');
      await transcript.absorb('params', new Uint8Array([32, 8, 32]));
      await transcript.absorbFp('public-input', 5n);
      const beta = await transcript.squeezeFp(label);
      const index = await transcript.squeezeIndex('query-index', 4096);
      return { beta, index, log: transcript.log };
    }

    const first = await replay('beta');
    const second = await replay('beta');
    const differentLabel = await replay('gamma');
    expect(first).toEqual(second);
    expect(first.beta).not.toBe(differentLabel.beta);
    expect(first.beta).toBeGreaterThanOrEqual(0n);
    expect(first.beta).toBeLessThan(P);
    expect(first.index).toBeGreaterThanOrEqual(0);
    expect(first.index).toBeLessThan(4096);
  });
});

describe('M3 gates — arithmetization', () => {
  it.todo('Z5: 4-row copy case telescopes Z to 1; one broken copy ⇒ Z(end) ≠ 1');
  it.todo('Z11: MiMC(0)=4624267046282251639, MiMC(1)=12880888997231784420, MiMC(123456789)=13938363197871553720');
  it.todo('compiled row counts (pythagorean 2^5, sudoku 2^8, mimc 2^8, age 2^5)');
});

describe('M4/M5 gates — protocol', () => {
  it.todo('Z6: honest witness ⇒ quotient remainder 0 on H; tampered cell ⇒ nonzero exactly at affected rows');
  it.todo('Z7: FRI fold property layer-by-layer for random low-degree polys');
  it.todo('Z8: E2E — 4 presets × 20 seeds prove→verify ok, all checks V1–V7 green');
  it.todo('Z9: NEGATIVE SUITE — A1→V2 fails, A2→V3 fails at expected query, A3 statistics (the product promise)');
  it.todo('Z10: golden transcript — fixed seed ⇒ byte-identical proof fixture');
  it.todo('Z12: grinding — Q=1 succeeds median ~8 attempts, Q=2 ~64 (within 3× over 200 trials)');
});

describe('M8/M9 gates — ZK & sharing', () => {
  it.todo('Z13: blinding ON ⇒ openings differ across seeds for same witness; OFF ⇒ repeat');
  it.todo('Z14: share codec round-trip for circuit+proof, both #p and #pu paths');
});
