'use client';

import { useState } from 'react';
import { grindChallenge, tamperLeaf, tamperWitness } from '@/zk/attacks';
import { compile, generateWitness } from '@/zk/circuit/compile';
import { pythagorean } from '@/zk/circuit/presets/pythagorean';
import { prove } from '@/zk/plonk/prove';
import { verify } from '@/zk/plonk/verify';
import type { CheckResult, ProofTrace } from '@/zk/types';

const inputs = new Map([[1, 5n], [2, 3n], [3, 4n]]);

export function M5Preview() {
  const [trace, setTrace] = useState<ProofTrace>();
  const [checks, setChecks] = useState<CheckResult[]>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [grindResult, setGrindResult] = useState<{ attempts: number; succeeded: boolean }>();

  async function withRun(action: () => Promise<void>): Promise<void> {
    setRunning(true);
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unknown proving error');
    } finally {
      setRunning(false);
    }
  }

  async function proveHonest(): Promise<void> {
    await withRun(async () => {
      const circuit = await compile(pythagorean);
      const proofTrace = await prove(
        circuit,
        generateWitness(pythagorean, inputs),
        [5n],
        { n: circuit.n, blowup: 8, queries: 8, zk: false },
        42,
      );
      setTrace(proofTrace);
      setChecks((await verify(circuit, proofTrace.proof)).checks);
    });
  }

  async function editCommittedLeaf(): Promise<void> {
    if (trace === undefined) return;
    await withRun(async () => {
      const circuit = await compile(pythagorean);
      const attack = tamperLeaf(trace, trace.proof.queries[0]!.index);
      setChecks((await verify(circuit, attack.proof)).checks);
    });
  }

  async function forceTamperedWitness(): Promise<void> {
    await withRun(async () => {
      const circuit = await compile(pythagorean);
      const attack = await tamperWitness(
        pythagorean,
        inputs,
        new Map([[4, 10n]]),
        { n: circuit.n, blowup: 8, queries: 8, zk: false },
        42,
      );
      setChecks((await verify(circuit, attack.proof)).checks);
    });
  }

  async function grindWeakChallenge(): Promise<void> {
    await withRun(async () => {
      const result = await grindChallenge(pythagorean, inputs, 1, 32);
      setGrindResult(result);
    });
  }

  return (
    <section className="m5-preview" aria-labelledby="m5-preview-title">
      <p className="eyebrow">M5 protocol preview</p>
      <h2 id="m5-preview-title">A complete, inspectable verifier checklist</h2>
      <p>
        Prove the Pythagorean statement 3² + 4² = 5². This runs committed wire,
        permutation, and quotient polynomials through DEEP composition and FRI before
        checking V1–V7 locally.
      </p>
      <p className="caveat">
        Teaching-scale only: this uses base-field challenges and eight FRI queries here.
        Its soundness estimate is <strong>conjectured</strong>, not a production-security claim;
        zero-knowledge blinding is not yet integrated into this proof path.
      </p>
      <div className="preview-actions">
        <button type="button" onClick={proveHonest} disabled={running}>
          {running ? 'Proving…' : 'Run Full Proof'}
        </button>
        <button type="button" onClick={forceTamperedWitness} disabled={running}>
          Force a Tampered Witness
        </button>
        <button type="button" onClick={editCommittedLeaf} disabled={running || trace === undefined}>
          Edit a Committed Leaf
        </button>
        <button type="button" onClick={grindWeakChallenge} disabled={running}>
          Grind a Weak Q=1 Check
        </button>
      </div>
      {grindResult !== undefined && (
        <p className={grindResult.succeeded ? 'pass' : 'failure'}>
          A3 {grindResult.succeeded ? 'slipped the forged proof through' : 'did not find a passing forged proof'} after {grindResult.attempts} attempt{grindResult.attempts === 1 ? '' : 's'}.
          {' '}At Q=1, the selected-coset strategy has an approximately 1/8 chance per attempt; the full parameter set uses more queries.
        </p>
      )}
      {error !== undefined && <p className="failure">{error}</p>}
      {checks !== undefined && <CheckList checks={checks} />}
    </section>
  );
}

function CheckList({ checks }: { checks: CheckResult[] }) {
  return (
    <ul className="check-list" aria-label="Verifier checks">
      {checks.map((check) => (
        <li key={check.id} className={check.ok ? 'pass' : 'failure'}>
          <span>{check.id}</span> {check.detail}
        </li>
      ))}
    </ul>
  );
}
