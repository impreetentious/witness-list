'use client';

import { useMemo, useState } from 'react';
import { evalAt } from '@/zk/poly';
import { blind, seededFieldSource, simulateTranscript } from '@/zk/zkmode';
import type { TranscriptEntry } from '@/zk/types';
import type { ProofTrace } from '@/zk/types';

function seededValues(start: bigint): () => bigint {
  let value = start;
  return () => value++;
}

export function ZkPanel({ trace, onRunZk }: { trace?: ProofTrace; onRunZk?: () => void }) {
  const [entries, setEntries] = useState<TranscriptEntry[]>();
  const [error, setError] = useState<string>();
  const [histogramZk, setHistogramZk] = useState(true);
  const params = { n: 8, blowup: 8, queries: 4, zk: true };
  const polynomial = [3n, 1n, 4n];
  const first = blind(polynomial, 8, params, seededValues(10n));
  const second = blind(polynomial, 8, params, seededValues(20n));
  const histogram = useMemo(() => {
    const buckets = Array.from({ length: 16 }, () => 0);
    for (let replay = 0; replay < 200; replay++) {
      const candidate = blind(polynomial, 8, { ...params, zk: histogramZk }, seededFieldSource(replay + 1));
      buckets[Number(evalAt(candidate, 7n) & 15n)]!++;
    }
    return buckets;
  }, [histogramZk]);
  const histogramMax = Math.max(...histogram);

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
      <div className="zk-histogram-demo">
        <div className="zk-histogram-heading">
          <div><h3>200 seeded off-domain openings</h3><p>Low-four-bit buckets make the contrast visible; this is a teaching visualization, not a statistical ZK proof.</p></div>
          <label><input type="checkbox" checked={histogramZk} onChange={(event) => setHistogramZk(event.target.checked)} /> blinding on</label>
        </div>
        <div className="zk-histogram" role="img" aria-label={`Histogram of 200 seeded openings with blinding ${histogramZk ? 'on' : 'off'}`}>
          {histogram.map((count, bucket) => <div key={bucket} title={`bucket ${bucket}: ${count}`}><span style={{ height: `${Math.max(2, count / histogramMax * 100)}%` }} /><small>{bucket.toString(16)}</small></div>)}
        </div>
        <p className="mono">{histogramZk ? 'Blinding ON: openings spread across residue buckets.' : 'Blinding OFF: the same opening repeats in one bucket, exposing the visible structure.'}</p>
      </div>
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
