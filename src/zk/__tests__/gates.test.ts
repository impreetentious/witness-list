/**
 * The honesty gates — docs/PROTOCOL-SPEC.md §9. Field fixtures were computed by
 * the independent Python implementation in tools/reference.py; every gate below
 * is executable in the node-only protocol suite.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { proveInWorker, grindInWorker } from '../../workers/prover-client';
import fc from 'fast-check';
import { P, add, batchInverse, inv, mod, mul, neg, pow, sub, twoAdicRoot } from '../field';
import type { Fp } from '../field';
import { cosetLDE, interpolate, intt, ntt } from '../ntt';
import { evalAt, lagrangeAt, polyAdd, polyDivRem, polyMul, vanishing } from '../poly';
import { buildTree, verifyPath } from '../merkle';
import { createTranscript } from '../transcript';
import { compile, generateWitness, MAX_TRACE_ROWS } from '../circuit/compile';
import { validate } from '../circuit/ir';
import { pythagorean } from '../circuit/presets/pythagorean';
import { age, ageInputs, agePreset } from '../circuit/presets/age';
import { mimcHash, makeMimcPreset } from '../circuit/presets/mimc';
import { sudoku, sudokuCellWires, sudokuGivens, sudokuInputs } from '../circuit/presets/sudoku';
import {
  sudoku9,
  sudoku9CellWires,
  sudoku9Givens,
  sudoku9Inputs,
} from '../circuit/presets/sudoku9';
import { buildGrandProduct } from '../plonk/permutation';
import { buildQuotient, composeConstraints } from '../plonk/quotient';
import { foldLayer } from '../fri/fri';
import { blind, simulateTranscript } from '../zkmode';
import { prove, proveIdentityOnly, proveV1ForCompatibility } from '../plonk/prove';
import { verify, verifyIdentityOnly } from '../plonk/verify';
import { grindChallenge, sampleGrindingAttempts, tamperLeaf, tamperWitness } from '../attacks';
import { decodeShare, decodeShareFileBytes, encodeShare, shareFileName } from '../../share/codec';
import {
  add as addFp2,
  embed,
  equal as equalFp2,
  fp2,
  fp2One,
  inv as invFp2,
  mul as mulFp2,
  nonResidueIsValid,
  pow as powFp2,
} from '../fp2';
import { POSEIDON_MDS, poseidonHash, poseidonMds } from '../poseidon';
import { buildPoseidonTree, verifyPoseidonPath } from '../poseidon-merkle';
import {
  compileWitnessScript,
  parseWitnessScript,
  printWitnessScript,
  WitnessScriptError,
} from '../../script/witness-script';
import { witnessScriptExamples } from '../../script/examples';
import { findGrindingNonce, leadingZeroBits, verifyGrindingNonce } from '../grinding';

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
      { numRuns: 1000 },
    );
  });

  it('inverses and Fermat', () => {
    fc.assert(
      fc.property(fpNonZeroArb, (a) => {
        expect(mul(a, inv(a))).toBe(1n);
        expect(pow(a, P - 1n)).toBe(1n);
      }),
      { numRuns: 1000 },
    );
  });

  it('batchInverse matches inv', () => {
    fc.assert(
      fc.property(fc.array(fpNonZeroArb, { minLength: 1, maxLength: 40 }), (xs) => {
        const batch = batchInverse(xs);
        xs.forEach((x, i) => expect(batch[i]).toBe(inv(x)));
      }),
      { numRuns: 1000 },
    );
  });
});

it('rejects a circuit whose power-of-two trace domain exceeds the teaching limit', async () => {
  await expect(
    compile({
      name: 'oversized trace',
      // `const` rather than `priv`: witness declarations emit no trace row
      // (compile.ts treats `pub`/`priv` as declarations only), so a circuit of
      // 4097 `priv` gates compiles to a 32-row trace and never reaches the
      // guard this test exists to prove. `const` is the cheapest row-emitting
      // op — arity 0 with a required `value`.
      gates: Array.from({ length: MAX_TRACE_ROWS + 1 }, (_, id) => ({
        id: id + 1,
        op: 'const' as const,
        inputs: [],
        value: 0n,
      })),
      publicOrder: [],
    }),
  ).rejects.toThrow(new RegExp(`${MAX_TRACE_ROWS}`));
});

describe('Z2: fixed vectors (independently computed — docs/PROTOCOL-SPEC.md §13)', () => {
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

describe('Polynomial and NTT gates', () => {
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
        values.reduce(
          (sum, value, column) => add(sum, mul(value, pow(omega, BigInt(row * column)))),
          0n,
        ),
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

  it('NTT budget: coset LDE of 2^13 coeffs < 100 ms', () => {
    const coeffs = Array.from({ length: 1 << 13 }, (_, i) => BigInt(i + 1));
    const startedAt = performance.now();
    const evaluations = cosetLDE(coeffs, 8);
    const elapsedMs = performance.now() - startedAt;
    expect(evaluations).toHaveLength(1 << 16);
    expect(elapsedMs).toBeLessThan(100);
  });
});

describe('Merkle commitment and Fiat–Shamir transcript gates', () => {
  it('Merkle paths bind the domain-separated leaf index and composite field leaf', async () => {
    const leaves = Array.from({ length: 8 }, (_, i) => [BigInt(i + 1), BigInt((i + 1) ** 2)]);
    const tree = await buildTree(leaves, 'wires');
    expect(tree.depth).toBe(3);

    for (let i = 0; i < leaves.length; i++) {
      expect(await verifyPath(tree.root, leaves[i]!, tree.path(i), 'wires')).toBe(true);
    }

    expect(await verifyPath(tree.root, [999n, 1n], tree.path(3), 'wires')).toBe(false);
    expect(await verifyPath(tree.root, leaves[3]!, tree.path(3), 'different-domain')).toBe(false);
    expect(
      await verifyPath(
        tree.root,
        leaves[3]!,
        { ...tree.path(3), siblings: [...tree.path(3).siblings, new Uint8Array(32)] },
        'wires',
        leaves.length,
      ),
    ).toBe(false);
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

describe('Arithmetization gates', () => {
  it('compiles deterministic PLONK rows and preserves the non-propagating tamper hook', async () => {
    const compiled = await compile(pythagorean);
    expect(compiled.n).toBe(32);
    expect(compiled.publicRows).toBe(1);
    expect(compiled.qL[0]).toBe(1n);
    expect(compiled.qO[1]).toBe(P - 1n); // a² output row
    expect(compiled.digest).toHaveLength(32);
    expect(new Set(compiled.sigma)).toHaveLength(3 * compiled.n);

    const inputs = new Map([
      [1, 5n],
      [2, 3n],
      [3, 4n],
    ]);
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
      qL: Array<Fp>(n).fill(0n),
      qR: Array<Fp>(n).fill(0n),
      qO: Array<Fp>(n).fill(0n),
      qM: Array<Fp>(n).fill(0n),
      qC: Array<Fp>(n).fill(0n),
      qLookup: Array<Fp>(n).fill(0n),
      lookupTags: Array<Fp>(n).fill(0n),
      lookupTable: Array<Fp>(n).fill(0n),
      lookupTableTags: Array<Fp>(n).fill(0n),
      lookupMode: 'membership' as const,
      lookupDummy: 0n,
      lookupDummyTag: 0n,
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
    expect(sudokuCompiled.n).toBe(512); // documented generic-gate baseline (§12)
    expect(mimcCompiled.n).toBe(256);
    expect(ageCompiled.n).toBe(128);
    expect(sudokuGivens).toHaveLength(4);
    expect(sudokuInputs()).toHaveLength(20);
    expect(ageInputs()).toHaveLength(1);
  });
});

describe('Protocol gates', () => {
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
      const inputs = new Map([
        [1, 5n],
        [2, 3n],
        [3, 4n],
      ]);
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
      fc.property(fc.array(fpArb, { minLength: 8, maxLength: 8 }), fpArb, (coefficients, beta) => {
        const layer = cosetLDE(coefficients, 2);
        const folded = foldLayer(layer, beta, 7n);
        const foldedCoefficients = Array.from(
          { length: Math.ceil(coefficients.length / 2) },
          (_, index) =>
            add(coefficients[2 * index] ?? 0n, mul(beta, coefficients[2 * index + 1] ?? 0n)),
        );
        const outputRoot = twoAdicRoot(3);
        let outputPoint = mul(7n, 7n); // the folded domain is (7·H)² = 7²·H²
        const expected = Array.from({ length: folded.length }, () => {
          const value = evalAt(foldedCoefficients, outputPoint);
          outputPoint = mul(outputPoint, outputRoot);
          return value;
        });
        expect(folded).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });

  it('the identity-only path proves the ζ identity but full verification rejects its explicitly unsound no-FRI proof', async () => {
    const compiled = await compile(pythagorean);
    const trace = await proveIdentityOnly(
      compiled,
      generateWitness(
        pythagorean,
        new Map([
          [1, 5n],
          [2, 3n],
          [3, 4n],
        ]),
      ),
      [5n],
      { n: compiled.n, blowup: 8, queries: 32, zk: false },
    );
    expect(trace.quotientRemainder).toEqual(Array<Fp>(compiled.n).fill(0n));
    if (trace.proof.version !== 1)
      throw new Error('the identity-only path returned an unexpected protocol version');
    const partial = await verifyIdentityOnly(compiled, trace.proof);
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
    expect(
      (await verifyIdentityOnly(compiled, tamperedProof)).checks.find((check) => check.id === 'V2')
        ?.ok,
    ).toBe(false);
  });
  it('a committed DEEP/FRI proof verifies V1–V7, while a changed leaf fails V3', async () => {
    const compiled = await compile(pythagorean);
    const trace = await prove(
      compiled,
      generateWitness(
        pythagorean,
        new Map([
          [1, 5n],
          [2, 3n],
          [3, 4n],
        ]),
      ),
      [5n],
      { n: compiled.n, blowup: 8, queries: 4, zk: false },
      42,
    );
    const verified = await verify(compiled, trace.proof);
    expect(verified.ok).toBe(true);
    expect(verified.checks.every((check) => check.ok)).toBe(true);
    if (trace.proof.version !== 2)
      throw new Error('the full prover returned an unexpected protocol version');

    const firstQuery = trace.proof.queries[0]!;
    const tampered = {
      ...trace.proof,
      queries: trace.proof.queries.map((query, index) =>
        index === 0
          ? {
              ...query,
              leaves: {
                ...query.leaves,
                wires: [
                  add(firstQuery.leaves.wires![0]!, 1n),
                  ...firstQuery.leaves.wires!.slice(1),
                ],
              },
            }
          : query,
      ),
    };
    const tamperedResult = await verify(compiled, tampered);
    expect(tamperedResult.ok).toBe(false);
    expect(tamperedResult.checks.find((check) => check.id === 'V3')?.ok).toBe(false);
  });

  it('rejects unsupported verifier parameters before deriving proof shapes', async () => {
    const compiled = await compile(pythagorean);
    const trace = await prove(
      compiled,
      generateWitness(
        pythagorean,
        new Map([
          [1, 5n],
          [2, 3n],
          [3, 4n],
        ]),
      ),
      [5n],
      { n: compiled.n, blowup: 8, queries: 1, zk: false },
      23,
    );
    for (const params of [
      { ...trace.proof.params, queries: 0 },
      { ...trace.proof.params, queries: Number.MAX_SAFE_INTEGER },
      { ...trace.proof.params, blowup: 4 },
    ]) {
      const result = await verify(compiled, { ...trace.proof, params });
      expect(result.ok).toBe(false);
      expect(result.checks.find((check) => check.id === 'V7')?.ok).toBe(false);
    }
  });
  it('Z9: shared A1/A2 attack functions fail at V2/V3 for every preset across deterministic replays', async () => {
    const mimc = await makeMimcPreset();
    const mimcPreimage = 123456789n;
    const mimcDigest = await mimcHash(mimcPreimage);
    const cases: Array<{
      circuit: typeof pythagorean;
      inputs: Map<number, Fp>;
      publicInputs: Fp[];
      override: Map<number, Fp>;
      seeds: number;
    }> = [
      {
        circuit: pythagorean,
        inputs: new Map([
          [1, 5n],
          [2, 3n],
          [3, 4n],
        ]),
        publicInputs: [5n],
        override: new Map([[4, 10n]]),
        seeds: 20,
      },
      {
        circuit: sudoku,
        inputs: sudokuInputs(),
        publicInputs: sudokuGivens.map((given) => given.value),
        override: new Map([[sudokuCellWires[0]![0]!, 2n]]),
        seeds: 20,
      },
      {
        circuit: mimc.circuit,
        inputs: new Map([
          [mimc.preimageWire, mimcPreimage],
          [mimc.digestWire, mimcDigest],
        ]),
        publicInputs: [mimcDigest],
        override: new Map([[mimc.preimageWire, mimcPreimage + 1n]]),
        seeds: 20,
      },
      {
        circuit: age,
        inputs: ageInputs(),
        publicInputs: [],
        override: new Map([[agePreset.ageWire, 17n]]),
        seeds: 20,
      },
      // 9×9 is covered with fewer seeds here; denser honest/attack coverage lives under Z20.
      {
        circuit: sudoku9,
        inputs: sudoku9Inputs(),
        publicInputs: sudoku9Givens.map((given) => given.value),
        override: new Map([[sudoku9CellWires[0]![2]!, 3n]]),
        seeds: 3,
      },
    ];
    for (const { circuit, inputs, publicInputs, override, seeds } of cases) {
      const compiled = await compile(circuit);
      const params = { n: compiled.n, blowup: 8, queries: 2, zk: false };
      for (let seed = 0; seed < seeds; seed++) {
        const a1 = await tamperWitness(circuit, inputs, override, params, seed);
        const a1Result = await verify(compiled, a1.proof);
        expect(a1Result.ok, `${circuit.name}, A1, seed ${seed}`).toBe(false);
        expect(
          a1Result.checks.find((check) => check.id === 'V2')?.ok,
          `${circuit.name}, A1, seed ${seed}`,
        ).toBe(false);

        const honest = await prove(
          compiled,
          generateWitness(circuit, inputs),
          publicInputs,
          params,
          seed,
        );
        const a2Result = await verify(
          compiled,
          tamperLeaf(honest, honest.proof.queries[0]!.index).proof,
        );
        expect(a2Result.ok, `${circuit.name}, A2, seed ${seed}`).toBe(false);
        expect(
          a2Result.checks.find((check) => check.id === 'V3')?.ok,
          `${circuit.name}, A2, seed ${seed}`,
        ).toBe(false);
      }
    }
  }, 120_000);
  it('Z8: every preset proves and verifies all seven checks across deterministic replays', async () => {
    const mimc = await makeMimcPreset();
    const mimcPreimage = 123456789n;
    const cases: Array<{
      circuit: typeof pythagorean;
      inputs: Map<number, Fp>;
      publicInputs: Fp[];
      seeds: number;
    }> = [
      {
        circuit: pythagorean,
        inputs: new Map([
          [1, 5n],
          [2, 3n],
          [3, 4n],
        ]),
        publicInputs: [5n],
        seeds: 20,
      },
      {
        circuit: sudoku,
        inputs: sudokuInputs(),
        publicInputs: sudokuGivens.map((given) => given.value),
        seeds: 20,
      },
      {
        circuit: mimc.circuit,
        inputs: new Map([
          [mimc.preimageWire, mimcPreimage],
          [mimc.digestWire, await mimcHash(mimcPreimage)],
        ]),
        publicInputs: [await mimcHash(mimcPreimage)],
        seeds: 20,
      },
      { circuit: age, inputs: ageInputs(), publicInputs: [], seeds: 20 },
      {
        circuit: sudoku9,
        inputs: sudoku9Inputs(),
        publicInputs: sudoku9Givens.map((given) => given.value),
        seeds: 3,
      },
    ];
    for (const { circuit, inputs, publicInputs, seeds } of cases) {
      const compiled = await compile(circuit);
      for (let seed = 0; seed < seeds; seed++) {
        const trace = await prove(
          compiled,
          generateWitness(circuit, inputs),
          publicInputs,
          { n: compiled.n, blowup: 8, queries: 2, zk: false },
          seed,
        );
        const result = await verify(compiled, trace.proof);
        expect(result.ok, `${circuit.name}, seed ${seed}`).toBe(true);
        expect(
          result.checks.every((check) => check.ok),
          `${circuit.name}, seed ${seed}`,
        ).toBe(true);
      }
    }
  }, 120_000);
  it('Z12 smoke: the shared A3 prover can grind a Q=1 forged proof through the real verifier', async () => {
    const result = await grindChallenge(
      pythagorean,
      new Map([
        [1, 5n],
        [2, 3n],
        [3, 4n],
      ]),
      1,
      32,
    );
    expect(result.succeeded).toBe(true);
    expect(result.attempts).toBeGreaterThanOrEqual(1);
    expect(result.attempts).toBeLessThanOrEqual(32);
  });
  it('Z10: fixed proof input has a frozen share-wire fingerprint', async () => {
    const compiled = await compile(pythagorean);
    const proof = (
      await proveV1ForCompatibility(
        compiled,
        generateWitness(
          pythagorean,
          new Map([
            [1, 5n],
            [2, 3n],
            [3, 4n],
          ]),
        ),
        [5n],
        { n: compiled.n, blowup: 8, queries: 4, zk: false },
        42,
      )
    ).proof;
    const wire = await encodeShare({ circuit: pythagorean, publicInputs: [5n], proof }, false);
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(wire)),
    );
    const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(fingerprint).toBe('d3dcada69ffeeb2a314d658c7552594af45a059f9e5cad4ce45c21df4482b401');
  });
  it('Z12: selected-coset grinding has the expected mean work over 200 deterministic trials', () => {
    const mean = (values: number[]): number =>
      values.reduce((total, value) => total + value, 0) / values.length;
    const q1 = mean(sampleGrindingAttempts(1, 200));
    const q2 = mean(sampleGrindingAttempts(2, 200));
    // The geometric means are 8 and 64. The full forged-proof path is covered
    // by the smoke gate above; this distribution gate keeps ordinary CI bounded.
    expect(q1).toBeGreaterThan(8 / 3);
    expect(q1).toBeLessThan(8 * 3);
    expect(q2).toBeGreaterThan(64 / 3);
    expect(q2).toBeLessThan(64 * 3);
  });
});

describe('Z15: quadratic extension challenges', () => {
  it('uses the independently verified non-residue and embeds the base field faithfully', () => {
    expect(nonResidueIsValid()).toBe(true);
    expect(equalFp2(embed(123n), fp2(123n, 0n))).toBe(true);
    expect(equalFp2(mulFp2(embed(3n), embed(5n)), embed(15n))).toBe(true);
  });

  it('satisfies multiplication, inversion, and Fermat over Fp²', () => {
    fc.assert(
      fc.property(fpArb, fpArb, fpNonZeroArb, fpArb, (a, b, c, d) => {
        const left = fp2(a, b);
        const right = fp2(c, d);
        expect(equalFp2(mulFp2(left, right), mulFp2(right, left))).toBe(true);
        if (a !== 0n || b !== 0n) expect(equalFp2(mulFp2(left, invFp2(left)), fp2One)).toBe(true);
      }),
      { numRuns: 120 },
    );
    const value = fp2(11n, 29n);
    // |Fp²*| = p² - 1, so this is the extension-field Fermat law.
    expect(equalFp2(powFp2(value, P * P - 1n), fp2One)).toBe(true);
    expect(equalFp2(addFp2(value, fp2(1n, 0n)), fp2(12n, 29n))).toBe(true);
  });

  it('Z19: propagates every protocol and FRI challenge through the v2 proof wire', async () => {
    const compiled = await compile(pythagorean);
    const trace = await prove(
      compiled,
      generateWitness(
        pythagorean,
        new Map([
          [1, 5n],
          [2, 3n],
          [3, 4n],
        ]),
      ),
      [5n],
      { n: compiled.n, blowup: 8, queries: 2, zk: false },
      31,
    );
    expect(trace.proof.version).toBe(2);
    for (const label of ['beta', 'gamma', 'alpha', 'zeta', 'rho', 'fri-beta-0']) {
      expect(
        trace.transcript.find((entry) => entry.kind === 'squeeze' && entry.label === label)
          ?.extensionValue,
        label,
      ).toBeDefined();
    }
    expect((await verify(compiled, trace.proof)).ok).toBe(true);
  });

  it('Z19: protocol-v1 compatibility shares still decode and verify', async () => {
    const compiled = await compile(pythagorean);
    const proof = (
      await proveV1ForCompatibility(
        compiled,
        generateWitness(
          pythagorean,
          new Map([
            [1, 5n],
            [2, 3n],
            [3, 4n],
          ]),
        ),
        [5n],
        { n: compiled.n, blowup: 8, queries: 2, zk: false },
        19,
      )
    ).proof;
    expect(proof.version).toBe(1);
    const shared = await decodeShare(
      await encodeShare({ circuit: pythagorean, publicInputs: [5n], proof }, false),
    );
    expect(shared.proof.version).toBe(1);
    expect((await verify(await compile(shared.circuit), shared.proof)).ok).toBe(true);

    // Compatibility must not become a soundness bypass: wire v1 has no lookup
    // argument, so pairing a v1 proof with a lookup circuit would report V1-V7
    // green while every lookup-constrained wire stayed unconstrained.
    const ranged = await compileWitnessScript(
      'claim RangedV1 {\n  private x: field;\n  range x in 0..3;\n}',
    );
    const lookupCircuit = await compile(ranged.circuit);
    expect(lookupCircuit.n).toBe(compiled.n);
    await expect(
      proveV1ForCompatibility(
        lookupCircuit,
        generateWitness(ranged.circuit, ranged.deriveInputs({ x: 2n })),
        [],
        { n: lookupCircuit.n, blowup: 8, queries: 2, zk: false },
        19,
      ),
    ).rejects.toThrow(/lookup gates/);
    const paired = await verify(lookupCircuit, {
      ...proof,
      publicInputs: [],
      circuitDigest: lookupCircuit.digest.slice(),
    });
    expect(paired.ok).toBe(false);
    expect(paired.checks.find((check) => check.id === 'V7')?.ok).toBe(false);
  });
});

describe('Z20: bound lookups and multiset Sudoku', () => {
  it('proves Plookup membership and rejects an out-of-table age', async () => {
    const compiled = await compile(age);
    const params = { n: compiled.n, blowup: 8, queries: 1, zk: false };
    const honest = await prove(compiled, generateWitness(age, ageInputs(21n)), [], params, 9);
    expect((await verify(compiled, honest.proof)).ok).toBe(true);
    const shared = await decodeShare(
      await encodeShare({ circuit: age, publicInputs: [], proof: honest.proof }, false),
    );
    expect((await verify(await compile(shared.circuit), shared.proof)).ok).toBe(true);
    const forged = await tamperWitness(
      age,
      ageInputs(21n),
      new Map([[agePreset.ageWire, 17n]]),
      params,
      9,
    );
    expect(
      (await verify(compiled, forged.proof)).checks.find((check) => check.id === 'V2')?.ok,
    ).toBe(false);
  });

  it('binds every 9×9 row, column, and box as a tagged multiset', async () => {
    const compiled = await compile(sudoku9);
    expect(compiled.n).toBe(512);
    const publicInputs = sudoku9Givens.map((given) => given.value);
    const params = { n: compiled.n, blowup: 8, queries: 1, zk: false };
    const honest = await prove(
      compiled,
      generateWitness(sudoku9, sudoku9Inputs()),
      publicInputs,
      params,
      12,
    );
    expect((await verify(compiled, honest.proof)).ok).toBe(true);
    expect(
      (
        await verify(compiled, tamperLeaf(honest, honest.proof.queries[0]!.index).proof)
      ).checks.find((check) => check.id === 'V3')?.ok,
    ).toBe(false);
    const forged = await tamperWitness(
      sudoku9,
      sudoku9Inputs(),
      new Map([[sudoku9CellWires[0]![2]!, 3n]]),
      params,
      12,
    );
    expect(
      (await verify(compiled, forged.proof)).checks.find((check) => check.id === 'V2')?.ok,
    ).toBe(false);
  }, 30_000);
});

describe('Z16: Poseidon workshop hash', () => {
  it('matches the independently regenerated reference vectors', async () => {
    await expect(poseidonHash(0n, 0n)).resolves.toBe(13593260552114296815n);
    await expect(poseidonHash(1n, 2n)).resolves.toBe(18371212222320491351n);
  });

  it('uses an invertible Cauchy MDS layer', () => {
    const transformed = poseidonMds([3n, 1n, 4n]);
    expect(transformed).toHaveLength(3);
    expect(POSEIDON_MDS.flat()).toHaveLength(9);
    expect(transformed).not.toEqual([3n, 1n, 4n]);
  });

  it('builds and authenticates an optional prover-side Poseidon Merkle tree', async () => {
    const tree = await buildPoseidonTree([3n, 5n, 8n, 13n]);
    const path = tree.open(2);
    expect(await verifyPoseidonPath(tree.root, 8n, path)).toBe(true);
    expect(await verifyPoseidonPath(tree.root, 9n, path)).toBe(false);
    await expect(buildPoseidonTree([1n, 2n, 3n])).rejects.toThrow(/power-of-two/);
  });
});

describe('Z16: post-commitment grinding deterrent', () => {
  it('finds and checks transcript-bound SHA-256 work', async () => {
    const challenge = new Uint8Array(32).fill(7);
    const nonce = await findGrindingNonce(challenge, 6);
    expect(await verifyGrindingNonce(challenge, 6, nonce)).toBe(true);
    expect(leadingZeroBits(new Uint8Array([0, 0, 0x20]))).toBe(18);
  });

  it('binds the nonce before FRI query derivation', async () => {
    const compiled = await compile(pythagorean);
    const trace = await prove(
      compiled,
      generateWitness(
        pythagorean,
        new Map([
          [1, 5n],
          [2, 3n],
          [3, 4n],
        ]),
      ),
      [5n],
      { n: compiled.n, blowup: 8, queries: 2, zk: false, grindingBits: 4 },
      9,
    );
    expect(trace.proof.grindingNonce).toBeTypeOf('number');
    expect((await verify(compiled, trace.proof)).ok).toBe(true);
    const tampered = { ...trace.proof, grindingNonce: trace.proof.grindingNonce! + 1 };
    expect((await verify(compiled, tampered)).checks.find((check) => check.id === 'V1')?.ok).toBe(
      false,
    );
  });
});

describe('Z17: Witness Script', () => {
  it('property-checks canonical pretty-print and parse idempotence', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...witnessScriptExamples.map((example) => example.source)),
        (source) => {
          const once = printWitnessScript(parseWitnessScript(source));
          expect(printWitnessScript(parseWitnessScript(once))).toBe(once);
        },
      ),
    );
  });

  it.each(witnessScriptExamples)(
    'parses and lowers $title into the existing circuit IR',
    async (example) => {
      const compiledScript = await compileWitnessScript(example.source);
      const compiledCircuit = await compile(compiledScript.circuit);
      const inputs = compiledScript.deriveInputs(example.inputs);
      const publicInputs = compiledScript.circuit.publicOrder.map((wire) => inputs.get(wire)!);
      const trace = await prove(
        compiledCircuit,
        generateWitness(compiledScript.circuit, inputs),
        publicInputs,
        { n: compiledCircuit.n, blowup: 8, queries: 2, zk: false },
        17,
      );
      expect((await verify(compiledCircuit, trace.proof)).ok, example.title).toBe(true);
    },
    30_000,
  );

  it('freezes the gallery and every standard-library lowering at reviewed gate counts', async () => {
    const expected = new Map([
      ['pythagorean', 11],
      ['sudoku4', 195],
      ['age', 2],
      ['mimc', 199],
      ['poseidon', 917],
      ['merkle', 1758],
    ]);
    for (const example of witnessScriptExamples) {
      expect((await compileWitnessScript(example.source)).circuit.gates.length, example.id).toBe(
        expected.get(example.id),
      );
    }
  });

  it('seeds every declared input and bounds only the ranges it can check before proving', async () => {
    // A freshly authored claim must be openable without the previously selected
    // example's input names, and a ranged input must default inside its range.
    const custom = await compileWitnessScript(
      'claim Custom {\n  public total: field;\n  private p: field;\n  assert p * p == total;\n}',
    );
    expect(custom.defaultInputs).toEqual({ total: 0n, p: 0n });
    expect([...custom.deriveInputs(custom.defaultInputs).values()]).toEqual([0n, 0n]);
    const ranged = await compileWitnessScript(
      'claim Ranged {\n  private years: field;\n  range years in 21..99;\n}',
    );
    expect(ranged.defaultInputs).toEqual({ years: 21n });
    expect(ranged.deriveInputs(ranged.defaultInputs).size).toBe(1);
    expect(() => ranged.deriveInputs({ years: 20n })).toThrow(/21\.\.99/);

    // A range may target a let binding: it has no source value to pre-check, so
    // the lookup gate is what enforces it — and it must actually do so.
    const derived = await compileWitnessScript(
      'claim LetRange {\n  private x: field;\n  let y = x + x;\n  range y in 0..15;\n}',
    );
    const circuit = await compile(derived.circuit);
    const params = { n: circuit.n, blowup: 8, queries: 4, zk: false };
    const inside = derived.deriveInputs({ x: 3n });
    const honest = await prove(circuit, generateWitness(derived.circuit, inside), [], params, 5);
    expect((await verify(circuit, honest.proof)).ok).toBe(true);
    await expect(
      prove(
        circuit,
        generateWitness(derived.circuit, derived.deriveInputs({ x: 9n })),
        [],
        params,
        5,
      ),
    ).rejects.toThrow(/nonzero Fp² remainder/);
  }, 30_000);

  it('supports bounded loop constants and reports source-local syntax errors', async () => {
    const source = `claim Loop {
      private x: field;
      let total = x;
      for i in 1..3 { assert i * x == i * total; }
    }`;
    expect(parseWitnessScript(source).name).toBe('Loop');
    const compiled = await compileWitnessScript(source);
    expect(compiled.circuit.gates.length).toBeGreaterThan(3);
    expect(() => parseWitnessScript('claim Broken { private x: field assert x == 0; }')).toThrow(
      WitnessScriptError,
    );
  });

  it('refuses bounds that would unroll past the workshop trace limit', async () => {
    // The editor compiles on idle, on the main thread, so an unbounded unroll has
    // to fail as a diagnostic rather than as a frozen page.
    await expect(
      compileWitnessScript(
        'claim Runaway { private x: field; for i in 0..200000 { assert x == x; } }',
      ),
    ).rejects.toThrow(WitnessScriptError);
    await expect(
      compileWitnessScript(
        'claim EmptyRunaway { private x: field; for i in 0..900000000 { } assert x == x; }',
      ),
    ).rejects.toThrow(/iterations/);
    await expect(
      compileWitnessScript(
        'claim NestedRunaway { private x: field; for i in 0..100000 { for j in 0..100000 { } } assert x == x; }',
      ),
    ).rejects.toThrow(/iterations/);
    await expect(
      compileWitnessScript('claim WideRange { private x: field; range x in 0..3000000; }'),
    ).rejects.toThrow(/lookup table larger than/);
  });

  it('reruns the shared negative attacks against a script-authored circuit', async () => {
    const script = await compileWitnessScript(witnessScriptExamples[0]!.source);
    const inputs = script.deriveInputs(witnessScriptExamples[0]!.inputs);
    const compiled = await compile(script.circuit);
    const params = { n: compiled.n, blowup: 8, queries: 2, zk: false };
    for (const seed of [3, 11]) {
      const target = script.circuit.gates.find((gate) => gate.op === 'mul')!;
      const a1 = await tamperWitness(
        script.circuit,
        inputs,
        new Map([[target.id, 1n]]),
        params,
        seed,
      );
      expect((await verify(compiled, a1.proof)).checks.find((check) => check.id === 'V2')?.ok).toBe(
        false,
      );
      const honest = await prove(
        compiled,
        generateWitness(script.circuit, inputs),
        [5n],
        params,
        seed,
      );
      const a2 = tamperLeaf(honest, honest.proof.queries[0]!.index);
      expect((await verify(compiled, a2.proof)).checks.find((check) => check.id === 'V3')?.ok).toBe(
        false,
      );
    }
  });
});

describe('Zero-knowledge and sharing gates', () => {
  it('Z13: blinding changes off-trace openings across seeds; disabled blinding repeats', async () => {
    const polynomial = [3n, 1n, 4n];
    const params = { n: 8, blowup: 8, queries: 4, zk: true };
    const first = blind(
      polynomial,
      8,
      params,
      (() => {
        let value = 10n;
        return () => value++;
      })(),
    );
    const second = blind(
      polynomial,
      8,
      params,
      (() => {
        let value = 20n;
        return () => value++;
      })(),
    );
    expect(evalAt(first, 7n)).not.toBe(evalAt(second, 7n));
    expect(blind(polynomial, 8, { ...params, zk: false }, () => 99n)).toEqual(polynomial);

    const compiled = await compile(pythagorean);
    const inputs = new Map([
      [1, 5n],
      [2, 3n],
      [3, 4n],
    ]);
    const proofParams = { n: compiled.n, blowup: 8, queries: 2, zk: true };
    const [runA, runB] = await Promise.all([
      prove(compiled, generateWitness(pythagorean, inputs), [5n], proofParams, 7),
      prove(compiled, generateWitness(pythagorean, inputs), [5n], proofParams, 8),
    ]);
    expect((await verify(compiled, runA.proof)).ok).toBe(true);
    expect((await verify(compiled, runB.proof)).ok).toBe(true);
    expect(runA.proof.openings.find((opening) => opening.label === 'a')?.value).not.toBe(
      runB.proof.openings.find((opening) => opening.label === 'a')?.value,
    );
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
    const proof = (
      await prove(
        compiled,
        generateWitness(
          pythagorean,
          new Map([
            [1, 5n],
            [2, 3n],
            [3, 4n],
          ]),
        ),
        [5n],
        { n: compiled.n, blowup: 8, queries: 2, zk: false },
        42,
      )
    ).proof;
    const payload = { circuit: pythagorean, publicInputs: [5n], proof };
    const fallback = await encodeShare(payload, false);
    expect(fallback.startsWith('#pu=')).toBe(true);
    expect(await decodeShare(fallback)).toEqual(payload);
    expect(await decodeShareFileBytes(new TextEncoder().encode(fallback))).toEqual(payload);
    await expect(decodeShareFileBytes(new TextEncoder().encode(fallback + '\n'))).rejects.toThrow();
    await expect(decodeShareFileBytes(Uint8Array.of(239, 187, 191))).rejects.toThrow('ASCII');
    await expect(decodeShareFileBytes(new Uint8Array(4_000_001))).rejects.toThrow('limit');
    await expect(decodeShareFileBytes(new Uint8Array(4_000_000))).rejects.toThrow('share URL');
    expect(shareFileName({ ...payload, circuit: { ...pythagorean, name: 'CON' } })).toBe(
      '_CON.txt',
    );
    expect(shareFileName({ ...payload, circuit: { ...pythagorean, name: 'a/b\\c? .' } })).toBe(
      'a_b_c_.txt',
    );
    expect(shareFileName({ ...payload, circuit: { ...pythagorean, name: ' .' } })).toMatch(
      /^[a-f0-9]{64}\.txt$/,
    );
    const tampered = { ...payload, proof: { ...proof, wiresRoot: { bytes: new Uint8Array(32) } } };
    const candidate = await decodeShareFileBytes(
      new TextEncoder().encode(await encodeShare(tampered, false)),
    );
    expect((await verify(compiled, candidate.proof)).ok).toBe(false);
    await expect(decodeShare('#pu=A')).rejects.toThrow('truncated');
    await expect(decodeShare('#pu=AB')).rejects.toThrow('trailing bits');
    await expect(decodeShare('#p=AAAA')).rejects.toThrow();

    const mismatched = JSON.parse(
      Buffer.from(fallback.slice('#pu='.length), 'base64url').toString('utf8'),
    ) as { publicInputs: string[] };
    mismatched.publicInputs[0] = '6';
    await expect(
      decodeShare(`#pu=${Buffer.from(JSON.stringify(mismatched)).toString('base64url')}`),
    ).rejects.toThrow('public inputs do not match');

    const oversizedPath = JSON.parse(
      Buffer.from(fallback.slice('#pu='.length), 'base64url').toString('utf8'),
    ) as {
      proof: { queries: Array<{ paths: Record<string, { siblings: string[] }> }> };
    };
    Object.values(oversizedPath.proof.queries[0]!.paths)[0]!.siblings = Array.from(
      { length: 33 },
      () => 'A'.repeat(43),
    );
    await expect(
      decodeShare(`#pu=${Buffer.from(JSON.stringify(oversizedPath)).toString('base64url')}`),
    ).rejects.toThrow('invalid Merkle path');
    await expect(decodeShare(`#pu=${'A'.repeat(4_000_001)}`)).rejects.toThrow('size limit');

    const compressed = await encodeShare(payload, true);
    expect(compressed.startsWith('#p=') || compressed.startsWith('#pu=')).toBe(true);
    expect(await decodeShare(compressed)).toEqual(payload);
  });

  it('Z18: canonical Witness Script provenance changes the digest and leaves the frozen v1 fingerprint untouched when absent', async () => {
    const script = await compileWitnessScript(witnessScriptExamples[0]!.source);
    const inputs = script.deriveInputs(witnessScriptExamples[0]!.inputs);
    const compiled = await compile(script.circuit);
    const proof = (
      await prove(
        compiled,
        generateWitness(script.circuit, inputs),
        [5n],
        { n: compiled.n, blowup: 8, queries: 2, zk: false },
        31,
      )
    ).proof;
    const payload = { circuit: script.circuit, publicInputs: [5n], proof };
    expect(await decodeShare(await encodeShare(payload, false))).toEqual(payload);

    const changedSource = {
      ...script.circuit,
      provenance: {
        kind: 'witness-script' as const,
        source: `${script.circuit.provenance!.source}\n`,
      },
    };
    expect(await compile(changedSource).then((result) => result.digest)).not.toEqual(
      compiled.digest,
    );
    expect(
      (await verify(await compile(changedSource), proof)).checks.find((check) => check.id === 'V1')
        ?.ok,
    ).toBe(false);

    // Provenance-free circuit keeps the frozen protocol-v1 share fingerprint (Z10).
    expect(pythagorean.provenance).toBeUndefined();
    const v1Compiled = await compile(pythagorean);
    const v1Proof = (
      await proveV1ForCompatibility(
        v1Compiled,
        generateWitness(
          pythagorean,
          new Map([
            [1, 5n],
            [2, 3n],
            [3, 4n],
          ]),
        ),
        [5n],
        { n: v1Compiled.n, blowup: 8, queries: 4, zk: false },
        42,
      )
    ).proof;
    const wire = await encodeShare(
      { circuit: pythagorean, publicInputs: [5n], proof: v1Proof },
      false,
    );
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(wire)),
    );
    const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(fingerprint).toBe('d3dcada69ffeeb2a314d658c7552594af45a059f9e5cad4ce45c21df4482b401');
  });
});

describe('proof worker request ownership', () => {
  class FakeWorker extends EventTarget {
    static instances: FakeWorker[] = [];
    static dispatchFails = false;
    terminate = vi.fn();
    postMessage = vi.fn(() => {
      if (FakeWorker.dispatchFails) throw new Error('dispatch failed');
    });
    constructor() {
      super();
      FakeWorker.instances.push(this);
    }
    respond(data: unknown) {
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
  }
  const params = { n: 32, blowup: 8, queries: 2, zk: false };
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.instances = [];
    FakeWorker.dispatchFails = false;
  });
  it('pre-aborted requests create no worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const controller = new AbortController();
    controller.abort();
    await expect(
      proveInWorker(pythagorean, new Map(), params, 42, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it('cancels both proving and grinding exactly once and suppresses late progress/results', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    for (const action of ['prove', 'grind']) {
      const controller = new AbortController();
      const progress = vi.fn();
      const pending =
        action === 'prove'
          ? proveInWorker(pythagorean, new Map(), params, 42, progress, controller.signal)
          : grindInWorker(pythagorean, new Map(), 1, 32, progress, controller.signal);
      const worker = FakeWorker.instances.at(-1)!;
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await rejected;
      worker.respond({ id: 1, kind: 'progress', stage: 'late' });
      worker.respond({ id: 1, kind: 'proof', trace: {}, result: { ok: true, checks: [] } });
      controller.abort();
      expect(progress).not.toHaveBeenCalled();
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
    const next = grindInWorker(pythagorean, new Map(), 1, 32);
    FakeWorker.instances.at(-1)!.respond({ id: 1, kind: 'grind', attempts: 2, succeeded: true });
    expect(await next).toMatchObject({ attempts: 2, succeeded: true });
  });
  it('releases the dedicated worker on dispatch, runtime, decode and terminal errors', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    for (const mode of ['dispatch', 'error', 'messageerror', 'terminal', 'success']) {
      FakeWorker.dispatchFails = mode === 'dispatch';
      const pending = grindInWorker(pythagorean, new Map(), 1, 32);
      const worker = FakeWorker.instances.at(-1)!;
      const outcome =
        mode === 'success'
          ? expect(pending).resolves.toMatchObject({ attempts: 1 })
          : expect(pending).rejects.toThrow();
      if (mode === 'error') worker.dispatchEvent(new Event('error'));
      if (mode === 'messageerror') worker.dispatchEvent(new Event('messageerror'));
      if (mode === 'terminal') worker.respond({ id: 1, kind: 'error', message: 'failed' });
      if (mode === 'success')
        worker.respond({ id: 1, kind: 'grind', attempts: 1, succeeded: false });
      await outcome;
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
  });
});
