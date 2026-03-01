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
import type { Fp } from '../field';
import { cosetLDE, interpolate, intt, ntt } from '../ntt';
import { evalAt, lagrangeAt, polyAdd, polyDivRem, polyMul, vanishing } from '../poly';
import { buildTree, verifyPath } from '../merkle';
import { createTranscript } from '../transcript';
import { compile, generateWitness } from '../circuit/compile';
import { validate } from '../circuit/ir';
import { pythagorean } from '../circuit/presets/pythagorean';
import { age, ageInputs, agePreset } from '../circuit/presets/age';
import { mimcHash, makeMimcPreset } from '../circuit/presets/mimc';
import { sudoku, sudokuCellWires, sudokuGivens, sudokuInputs } from '../circuit/presets/sudoku';
import { buildGrandProduct } from '../plonk/permutation';
import { buildQuotient, composeConstraints } from '../plonk/quotient';
import { foldLayer } from '../fri/fri';
import { blind, simulateTranscript } from '../zkmode';
import { prove, proveM4 } from '../plonk/prove';
import { verify, verifyM4 } from '../plonk/verify';
import { grindChallenge, tamperLeaf, tamperWitness } from '../attacks';
import { decodeShare, encodeShare } from '../../share/codec';

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
  it('compiles deterministic PLONK rows and preserves the non-propagating tamper hook', async () => {
    const compiled = await compile(pythagorean);
    expect(compiled.n).toBe(32);
    expect(compiled.publicRows).toBe(1);
    expect(compiled.qL[0]).toBe(1n);
    expect(compiled.qO[1]).toBe(P - 1n); // a² output row
    expect(compiled.digest).toHaveLength(32);
    expect(new Set(compiled.sigma)).toHaveLength(3 * compiled.n);

    const inputs = new Map([[1, 5n], [2, 3n], [3, 4n]]);
    const honest = generateWitness(pythagorean, inputs);
    expect(honest.c[1]).toBe(9n);
    expect(honest.c[7]).toBe(0n); // final a² + b² − c² row

    const tampered = generateWitness(pythagorean, inputs, new Map([[4, 10n]]));
    expect(tampered.c[1]).toBe(10n); // overridden a²
    expect(tampered.c[7]).toBe(0n); // downstream sum is intentionally not recomputed
  });

  it('rejects cycles, dangling wires, and use of an assertion as an output wire', () => {
    expect(
      validate({
        name: 'invalid',
        gates: [
          { id: 1, op: 'add', inputs: [2, 3] },
          { id: 2, op: 'add', inputs: [1, 3] },
          { id: 3, op: 'assert0', inputs: [1] },
          { id: 4, op: 'add', inputs: [3, 99] },
        ],
        publicOrder: [],
      }).map((issue) => issue.kind),
    ).toEqual(expect.arrayContaining(['cycle', 'assert-output', 'dangling']));
  });

  it('Z5: 4-row copy case telescopes Z to 1; one broken copy ⇒ Z(end) ≠ 1', () => {
    const n = 4;
    const sigma = Uint32Array.from({ length: 3 * n }, (_, slot) => slot);
    sigma[0] = n + 1; // a₀ and b₁ are two occurrences of one wire
    sigma[n + 1] = 0;
    const compiled = {
      n,
      qL: Array<Fp>(n).fill(0n), qR: Array<Fp>(n).fill(0n), qO: Array<Fp>(n).fill(0n),
      qM: Array<Fp>(n).fill(0n), qC: Array<Fp>(n).fill(0n),
      sigma,
      publicRows: 0,
      digest: new Uint8Array(32),
      rows: Array.from({ length: n }, () => ({ a: null, b: null, c: null })),
    };
    const honest = {
      a: [9n, 0n, 0n, 0n],
      b: [0n, 9n, 0n, 0n],
      c: [0n, 0n, 0n, 0n],
    };
    expect(buildGrandProduct(compiled, honest, 123n, 456n).partials.at(-1)).toBe(1n);

    const broken = { ...honest, b: [0n, 10n, 0n, 0n] };
    expect(buildGrandProduct(compiled, broken, 123n, 456n).partials.at(-1)).not.toBe(1n);
  });
  it('Z11: MiMC-7 vectors are derived from the independent §13 fixtures', async () => {
    await expect(mimcHash(0n)).resolves.toBe(4624267046282251639n);
    await expect(mimcHash(1n)).resolves.toBe(12880888997231784420n);
    await expect(mimcHash(123456789n)).resolves.toBe(13938363197871553720n);
  });

  it('all four presets compile to the documented generic-gate baseline and their structured input maps cover every input wire', async () => {
    const mimc = await makeMimcPreset();
    const [pythagoreanCompiled, sudokuCompiled, mimcCompiled, ageCompiled] = await Promise.all([
      compile(pythagorean),
      compile(sudoku),
      compile(mimc.circuit),
      compile(age),
    ]);
    expect(pythagoreanCompiled.n).toBe(32);
    expect(sudokuCompiled.n).toBe(512); // generic-gate baseline; fusion is a separate M3 follow-up
    expect(mimcCompiled.n).toBe(256);
    expect(ageCompiled.n).toBe(64);
    expect(sudokuGivens).toHaveLength(4);
    expect(sudokuInputs()).toHaveLength(20);
    expect(ageInputs()).toHaveLength(8);
  });
});

describe('M4/M5 gates — protocol', () => {
  it('Z6: exact division yields zero remainder; a row-local violation identifies its row', () => {
    const n = 8;
    const honestComposition = polyMul([3n, 5n, 9n], vanishing(n));
    const honest = buildQuotient(honestComposition, n);
    expect(honest.exact).toBe(true);
    expect(honest.remainderOnH).toEqual(Array<Fp>(n).fill(0n));

    const omega = twoAdicRoot(3);
    let rowZeroBasis = [1n];
    let denominator = 1n;
    for (let row = 1; row < n; row++) {
      const point = pow(omega, BigInt(row));
      rowZeroBasis = polyMul(rowZeroBasis, [neg(point), 1n]);
      denominator = mul(denominator, neg(point));
    }
    rowZeroBasis = rowZeroBasis.map((coefficient) => mul(coefficient, inv(denominator)));
    const tampered = buildQuotient(polyAdd(honestComposition, rowZeroBasis), n);
    expect(tampered.exact).toBe(false);
    expect(
      tampered.remainderOnH
        .map((value, row) => ({ value, row }))
        .filter(({ value }) => value !== 0n)
        .map(({ row }) => row),
    ).toEqual([0]);

    // The same invariant must arise from a real compiled circuit and the actual
    // non-propagating witness tamper hook — not just a constructed polynomial.
    return compile(pythagorean).then((compiled) => {
      const inputs = new Map([[1, 5n], [2, 3n], [3, 4n]]);
      const honestComposition = composeConstraints(
        compiled,
        generateWitness(pythagorean, inputs),
        [5n],
        123n,
        456n,
        789n,
      );
      expect(buildQuotient(honestComposition.composed, compiled.n).exact).toBe(true);

      const tamperedComposition = composeConstraints(
        compiled,
        generateWitness(pythagorean, inputs, new Map([[4, 10n]])),
        [5n],
        123n,
        456n,
        789n,
      );
      const tamperedResult = buildQuotient(tamperedComposition.composed, compiled.n);
      expect(tamperedResult.exact).toBe(false);
      expect(tamperedResult.remainderOnH).toEqual(tamperedComposition.composedOnH);
    });
  });
  it('Z7: FRI fold-of-evaluations equals evaluation-of-folded-polynomial', () => {
    fc.assert(
      fc.property(
        fc.array(fpArb, { minLength: 8, maxLength: 8 }),
        fpArb,
        (coefficients, beta) => {
          const layer = cosetLDE(coefficients, 2);
          const folded = foldLayer(layer, beta, 7n);
          const foldedCoefficients = Array.from(
            { length: Math.ceil(coefficients.length / 2) },
            (_, index) => add(coefficients[2 * index] ?? 0n, mul(beta, coefficients[2 * index + 1] ?? 0n)),
          );
          const outputRoot = twoAdicRoot(3);
          let outputPoint = mul(7n, 7n); // the folded domain is (7·H)² = 7²·H²
          const expected = Array.from({ length: folded.length }, () => {
            const value = evalAt(foldedCoefficients, outputPoint);
            outputPoint = mul(outputPoint, outputRoot);
            return value;
          });
          expect(folded).toEqual(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('M4 proves the ζ identity but full verification rejects its explicitly unsound no-FRI proof', async () => {
    const compiled = await compile(pythagorean);
    const trace = await proveM4(
      compiled,
      generateWitness(pythagorean, new Map([[1, 5n], [2, 3n], [3, 4n]])),
      [5n],
      { n: compiled.n, blowup: 8, queries: 32, zk: false },
      42,
    );
    expect(trace.quotientRemainder).toEqual(Array<Fp>(compiled.n).fill(0n));
    const partial = await verifyM4(compiled, trace.proof);
    expect(partial.ok).toBe(true);
    const full = await verify(compiled, trace.proof);
    expect(full.ok).toBe(false);
    expect(full.checks.find((check) => check.id === 'V3')?.ok).toBe(false);

    const tamperedProof = {
      ...trace.proof,
      openings: trace.proof.openings.map((opening) =>
        opening.label === 'a' ? { ...opening, value: add(opening.value, 1n) } : opening,
      ),
    };
    expect((await verifyM4(compiled, tamperedProof)).checks.find((check) => check.id === 'V2')?.ok).toBe(false);
  });
  it('M5: a committed DEEP/FRI proof verifies V1–V7, while a changed leaf fails V3', async () => {
    const compiled = await compile(pythagorean);
    const trace = await prove(
      compiled,
      generateWitness(pythagorean, new Map([[1, 5n], [2, 3n], [3, 4n]])),
      [5n],
      { n: compiled.n, blowup: 8, queries: 4, zk: false },
      42,
    );
    const verified = await verify(compiled, trace.proof);
    expect(verified.ok).toBe(true);
    expect(verified.checks.every((check) => check.ok)).toBe(true);

    const firstQuery = trace.proof.queries[0]!;
    const tampered = {
      ...trace.proof,
      queries: trace.proof.queries.map((query, index) => index === 0
        ? { ...query, leaves: { ...query.leaves, wires: [add(firstQuery.leaves.wires![0]!, 1n), ...firstQuery.leaves.wires!.slice(1)] } }
        : query),
    };
    const tamperedResult = await verify(compiled, tampered);
    expect(tamperedResult.ok).toBe(false);
    expect(tamperedResult.checks.find((check) => check.id === 'V3')?.ok).toBe(false);
  });
  it('Z9: shared A1/A2 attack functions fail at V2/V3 for every preset across 20 replays', async () => {
    const mimc = await makeMimcPreset();
    const mimcPreimage = 123456789n;
    const mimcDigest = await mimcHash(mimcPreimage);
    const cases: Array<{ circuit: typeof pythagorean; inputs: Map<number, Fp>; publicInputs: Fp[]; override: Map<number, Fp> }> = [
      { circuit: pythagorean, inputs: new Map([[1, 5n], [2, 3n], [3, 4n]]), publicInputs: [5n], override: new Map([[4, 10n]]) },
      {
        circuit: sudoku,
        inputs: sudokuInputs(),
        publicInputs: sudokuGivens.map((given) => given.value),
        override: new Map([[sudokuCellWires[0]![0]!, 2n]]),
      },
      {
        circuit: mimc.circuit,
        inputs: new Map([[mimc.preimageWire, mimcPreimage], [mimc.digestWire, mimcDigest]]),
        publicInputs: [mimcDigest],
        override: new Map([[mimc.preimageWire, mimcPreimage + 1n]]),
      },
      { circuit: age, inputs: ageInputs(), publicInputs: [], override: new Map([[agePreset.ageWire, 17n]]) },
    ];
    for (const { circuit, inputs, publicInputs, override } of cases) {
      const compiled = await compile(circuit);
      const params = { n: compiled.n, blowup: 8, queries: 2, zk: false };
      for (let seed = 0; seed < 20; seed++) {
        const a1 = await tamperWitness(circuit, inputs, override, params, seed);
        const a1Result = await verify(compiled, a1.proof);
        expect(a1Result.ok, `${circuit.name}, A1, seed ${seed}`).toBe(false);
        expect(a1Result.checks.find((check) => check.id === 'V2')?.ok, `${circuit.name}, A1, seed ${seed}`).toBe(false);

        const honest = await prove(compiled, generateWitness(circuit, inputs), publicInputs, params, seed);
        const a2Result = await verify(compiled, tamperLeaf(honest, honest.proof.queries[0]!.index).proof);
        expect(a2Result.ok, `${circuit.name}, A2, seed ${seed}`).toBe(false);
        expect(a2Result.checks.find((check) => check.id === 'V3')?.ok, `${circuit.name}, A2, seed ${seed}`).toBe(false);
      }
    }
  }, 90_000);
  it('Z8: every preset proves and verifies all seven checks across 20 deterministic replays', async () => {
    const mimc = await makeMimcPreset();
    const mimcPreimage = 123456789n;
    const cases: Array<{ circuit: typeof pythagorean; inputs: Map<number, Fp>; publicInputs: Fp[] }> = [
      { circuit: pythagorean, inputs: new Map([[1, 5n], [2, 3n], [3, 4n]]), publicInputs: [5n] },
      { circuit: sudoku, inputs: sudokuInputs(), publicInputs: sudokuGivens.map((given) => given.value) },
      {
        circuit: mimc.circuit,
        inputs: new Map([[mimc.preimageWire, mimcPreimage], [mimc.digestWire, await mimcHash(mimcPreimage)]]),
        publicInputs: [await mimcHash(mimcPreimage)],
      },
      { circuit: age, inputs: ageInputs(), publicInputs: [] },
    ];
    for (const { circuit, inputs, publicInputs } of cases) {
      const compiled = await compile(circuit);
      for (let seed = 0; seed < 20; seed++) {
        const trace = await prove(
          compiled,
          generateWitness(circuit, inputs),
          publicInputs,
          { n: compiled.n, blowup: 8, queries: 2, zk: false },
          seed,
        );
        const result = await verify(compiled, trace.proof);
        expect(result.ok, `${circuit.name}, seed ${seed}`).toBe(true);
        expect(result.checks.every((check) => check.ok), `${circuit.name}, seed ${seed}`).toBe(true);
      }
    }
  }, 30_000);
  it('Z12 smoke: the shared A3 prover can grind a Q=1 forged proof through the real verifier', async () => {
    const result = await grindChallenge(
      pythagorean,
      new Map([[1, 5n], [2, 3n], [3, 4n]]),
      1,
      32,
    );
    expect(result.succeeded).toBe(true);
    expect(result.attempts).toBeGreaterThanOrEqual(1);
    expect(result.attempts).toBeLessThanOrEqual(32);
  });
  it('Z10: fixed proof input has a frozen share-wire fingerprint', async () => {
    const compiled = await compile(pythagorean);
    const proof = (await prove(
      compiled,
      generateWitness(pythagorean, new Map([[1, 5n], [2, 3n], [3, 4n]])),
      [5n],
      { n: compiled.n, blowup: 8, queries: 4, zk: false },
      42,
    )).proof;
    const wire = await encodeShare({ circuit: pythagorean, publicInputs: [5n], proof }, false);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(wire)));
    const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(fingerprint).toBe('d3dcada69ffeeb2a314d658c7552594af45a059f9e5cad4ce45c21df4482b401');
  });
  it.todo('Z12: grinding — Q=1 succeeds median ~8 attempts, Q=2 ~64 (within 3× over 200 trials)');
});

describe('M8/M9 gates — ZK & sharing', () => {
  it('Z13: blinding changes off-trace openings across seeds; disabled blinding repeats', () => {
    const polynomial = [3n, 1n, 4n];
    const params = { n: 8, blowup: 8, queries: 4, zk: true };
    const first = blind(polynomial, 8, params, (() => {
      let value = 10n;
      return () => value++;
    })());
    const second = blind(polynomial, 8, params, (() => {
      let value = 20n;
      return () => value++;
    })());
    expect(evalAt(first, 7n)).not.toBe(evalAt(second, 7n));
    expect(blind(polynomial, 8, { ...params, zk: false }, () => 99n)).toEqual(polynomial);
  });

  it('ZK transcript illustration is deterministic and requires no witness input', async () => {
    const params = { n: 8, blowup: 8, queries: 4, zk: true };
    const [first, second, other] = await Promise.all([
      simulateTranscript(params, 7),
      simulateTranscript(params, 7),
      simulateTranscript(params, 8),
    ]);
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    expect(first.some((entry) => entry.label === 'simulated-wire-opening')).toBe(true);
  });

  it('Z14: share codec round-trips a circuit and proof through #p and #pu', async () => {
    const compiled = await compile(pythagorean);
    const proof = (await prove(
      compiled,
      generateWitness(pythagorean, new Map([[1, 5n], [2, 3n], [3, 4n]])),
      [5n],
      { n: compiled.n, blowup: 8, queries: 2, zk: false },
      42,
    )).proof;
    const payload = { circuit: pythagorean, publicInputs: [5n], proof };
    const fallback = await encodeShare(payload, false);
    expect(fallback.startsWith('#pu=')).toBe(true);
    expect(await decodeShare(fallback)).toEqual(payload);

    const compressed = await encodeShare(payload, true);
    expect(compressed.startsWith('#p=') || compressed.startsWith('#pu=')).toBe(true);
    expect(await decodeShare(compressed)).toEqual(payload);
  });
});
