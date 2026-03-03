'use client';

import { useState } from 'react';
import { evalAt } from '@/zk/poly';
import { blind, simulateTranscript } from '@/zk/zkmode';
import type { TranscriptEntry } from '@/zk/types';
import type { ProofTrace } from '@/zk/types';

function seededValues(start: bigint): () => bigint {
  let value = start;
  return () => value++;
}

export function ZkPanel({ trace, onRunZk }: { trace?: ProofTrace; onRunZk?: () => void }) {
  const [entries, setEntries] = useState<TranscriptEntry[]>();
  const [error, setError] = useState<string>();
  const params = { n: 8, blowup: 8, queries: 4, zk: true };
  const polynomial = [3n, 1n, 4n];
  const first = blind(polynomial, 8, params, seededValues(10n));
  const second = blind(polynomial, 8, params, seededValues(20n));

  async function simulate(): Promise<void> {
    setError(undefined);
    try {
      setEntries(await simulateTranscript(params, 42));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the transcript illustration.');
    }
  }

  return (
    <section className="zk-panel" aria-labelledby="zk-title">
      <p className="eyebrow">M8 ZK ledger</p>
      <h2 id="zk-title">What the verifier learns — and what this build does not yet claim</h2>
      <p>
        Blinding adds Z<sub>H</sub>(X)·r(X), so it leaves every trace-domain constraint unchanged
        while changing off-domain openings. Blinded proofs use additional positional quotient chunks and
        a matching FRI degree bound; the verifier checks that full path locally.
      </p>
      <p className="caveat">
        The sampled no-witness transcript below remains an <strong>illustration of the ZK definition, not a formal proof</strong>.
        It is deliberately separate from the verifier-valid blinded proof, so the UI never overclaims a simulator proof.
      </p>
      <dl className="zk-ledger">
        <div><dt>Original P(7)</dt><dd>{evalAt(polynomial, 7n).toString()}</dd></div>
        <div><dt>Blinded run A P′(7)</dt><dd>{evalAt(first, 7n).toString()}</dd></div>
        <div><dt>Blinded run B P′(7)</dt><dd>{evalAt(second, 7n).toString()}</dd></div>
        <div><dt>Trace values P(ωⁱ)</dt><dd>unchanged, because Z<sub>H</sub>(ωⁱ) = 0</dd></div>
      </dl>
      {trace?.proof.params.zk === true
        ? <p className="pass">This replay is blinded: {trace.proof.tRoots.length} quotient commitments and {trace.proof.friLayerRoots.length} FRI layers are bound into the verified proof.</p>
        : <><p className="mono">No blinded replay is selected. Generate one to compare its off-domain proof openings.</p>{onRunZk !== undefined && <button type="button" onClick={onRunZk}>Generate Blinded Replay</button>}</>}
      <button type="button" onClick={simulate}>Sample No-Witness Transcript Illustration</button>
      {error !== undefined && <p className="failure">{error}</p>}
      {entries !== undefined && (
        <ul className="transcript-ledger">
          {entries.map((entry, index) => (
            <li key={`${entry.kind}-${entry.label}-${index}`}>
              <code>{entry.kind}</code> {entry.label}{entry.value === undefined ? '' : ` → ${entry.value}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
