'use client';

import { useState } from 'react';
import { compile, generateWitness } from '@/zk/circuit/compile';
import { pythagorean } from '@/zk/circuit/presets/pythagorean';
import { proveIdentityOnly } from '@/zk/plonk/prove';
import { verify, verifyIdentityOnly } from '@/zk/plonk/verify';
import type { CheckResult } from '@/zk/types';

interface PreviewResult {
  identityChecks: CheckResult[];
  fullChecks: CheckResult[];
  nonzeroRemainderRows: number[];
}

export function IdentityPreview() {
  const [result, setResult] = useState<PreviewResult>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);

  async function runPreview(): Promise<void> {
    setRunning(true);
    setError(undefined);
    try {
      const circuit = await compile(pythagorean);
      const trace = await proveIdentityOnly(
        circuit,
        generateWitness(
          pythagorean,
          new Map([
            [1, 5n],
            [2, 3n],
            [3, 4n],
          ]),
        ),
        [5n],
        { n: circuit.n, blowup: 8, queries: 32, zk: false },
      );
      if (trace.proof.version !== 1)
        throw new Error('the identity-only preview produced an unexpected protocol version');
      const [identity, full] = await Promise.all([
        verifyIdentityOnly(circuit, trace.proof),
        verify(circuit, trace.proof),
      ]);
      setResult({
        identityChecks: identity.checks,
        fullChecks: full.checks,
        nonzeroRemainderRows: trace.quotientRemainder.flatMap((value, row) =>
          value === 0n ? [] : [row],
        ),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unknown proving error');
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="identity-preview" aria-labelledby="identity-preview-title">
      <p className="eyebrow">Algebra-only lesson</p>
      <h2 id="identity-preview-title">The identity, before FRI</h2>
      <p>
        This runs the Pythagorean witness (3, 4, 5) through real PLONK row constraints, commitments,
        Fiat–Shamir challenges, and the identity at ζ.
      </p>
      <p className="warning">
        <strong>Unsound alone.</strong> This is the identity-only lesson: it has no DEEP
        composition, FRI, query openings, or low-degree soundness check. The full verifier therefore
        rejects it.
      </p>
      <button type="button" onClick={runPreview} disabled={running}>
        {running ? 'Checking the identity…' : 'Run Identity Preview'}
      </button>
      {error !== undefined && <p className="failure">{error}</p>}
      {result !== undefined && (
        <div className="preview-results">
          <p className="pass">
            Quotient remainder:{' '}
            {result.nonzeroRemainderRows.length === 0
              ? 'zero on every row'
              : `nonzero at rows ${result.nonzeroRemainderRows.join(', ')}`}
          </p>
          <div>
            <h3>Identity-only checks</h3>
            <CheckList checks={result.identityChecks} />
          </div>
          <div>
            <h3>Full verifier status</h3>
            <CheckList checks={result.fullChecks} />
          </div>
        </div>
      )}
    </section>
  );
}

function CheckList({ checks }: { checks: CheckResult[] }) {
  return (
    <ul className="check-list">
      {checks.map((check) => (
        <li key={check.id} className={check.ok ? 'pass' : 'failure'}>
          <span>{check.id}</span> {check.detail}
        </li>
      ))}
    </ul>
  );
}
