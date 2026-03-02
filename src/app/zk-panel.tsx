'use client';

import { useState } from 'react';
import { evalAt } from '@/zk/poly';
import { blind, simulateTranscript } from '@/zk/zkmode';
import type { TranscriptEntry } from '@/zk/types';

function seededValues(start: bigint): () => bigint {
  let value = start;
  return () => value++;
}

export function ZkPanel() {
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
        while changing off-domain openings. The current full prover remains explicitly
        <strong> unblinded</strong>; this is an inspectable isolated demonstration.
      </p>
      <p className="caveat">
        The simulated transcript below is an <strong>illustration of the ZK definition, not a formal proof</strong>.
        It uses no witness, but it is not presented as a verifier-valid proof until the complete backwards
        simulator and blinded DEEP/FRI pipeline land.
      </p>
      <dl className="zk-ledger">
        <div><dt>Original P(7)</dt><dd>{evalAt(polynomial, 7n).toString()}</dd></div>
        <div><dt>Blinded run A P′(7)</dt><dd>{evalAt(first, 7n).toString()}</dd></div>
        <div><dt>Blinded run B P′(7)</dt><dd>{evalAt(second, 7n).toString()}</dd></div>
        <div><dt>Trace values P(ωⁱ)</dt><dd>unchanged, because Z<sub>H</sub>(ωⁱ) = 0</dd></div>
      </dl>
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
