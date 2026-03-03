'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CheckResult, ProofTrace } from '@/zk/types';

interface Stage {
  title: string;
  sentence: string;
  math: string;
}

const stages: Stage[] = [
  { title: '0 · Circuit', sentence: 'The chosen graph fixes the public statement before a proof exists.', math: 'digest = H(circuit || selectors || σ)' },
  { title: '1 · Witness fill', sentence: 'Private inputs fill the three wire columns; these rows are never sent directly.', math: 'w = (a, b, c) over H' },
  { title: '2 · Interpolation', sentence: 'Every trace column becomes a polynomial below its committed degree bound.', math: 'A(ωⁱ) = aᵢ' },
  { title: '3 · Commit wires', sentence: 'LDE values of the wire polynomials are hashed into one composite Merkle root.', math: 'root_w = Merkle(LDE(A) || LDE(B) || LDE(C))' },
  { title: '4 · β, γ', sentence: 'Fiat–Shamir fixes copy-constraint challenges after wire commitment.', math: 'β, γ ← H(transcript)' },
  { title: '5 · Grand product Z', sentence: 'The copy permutation telescopes when repeated wire slots agree.', math: 'Z(ωx) = Z(x) · f(x) / f′(x)' },
  { title: '6 · Commit Z', sentence: 'The running product is committed before the quotient challenge.', math: 'root_Z = Merkle(LDE(Z))' },
  { title: '7 · α', sentence: 'One challenge combines gate, transition, and boundary constraints.', math: 'C = gate + α·transition + α²·boundary' },
  { title: '8 · Divide by Z_H', sentence: 'A true statement has zero remainder; a cheat highlights its nonzero rows.', math: 't(X) = C(X) / (Xⁿ − 1)' },
  { title: '9 · Commit t', sentence: 'Positional quotient chunks are committed before ζ is sampled.', math: 't = Σ Xⁱⁿ·tᵢ' },
  { title: '10 · ζ openings', sentence: 'The verifier samples an off-domain point and receives claimed evaluations.', math: 'ζ ∉ H ∪ D' },
  { title: '11 · Identity at ζ', sentence: 'The main PLONK equation is checked at the unpredictable point.', math: 'C(ζ) = t(ζ)·(ζⁿ − 1)' },
  { title: '12 · DEEP composition', sentence: 'Committed openings reduce to one quotient-valued polynomial.', math: 'D(X) = Σ ρⁱ(Pᵢ(X) − Pᵢ(ζ)) / (X − ζ)' },
  { title: '13 · FRI cascade', sentence: 'Committed folds halve the degree bound layer by layer.', math: 'f′(x²) = even(f) + β·odd(f)' },
  { title: '14 · Queries', sentence: 'Post-commitment indices authenticate every required value and fold pair.', math: 'q ← H(transcript) mod |D|' },
  { title: '15 · Verify', sentence: 'The verifier sees a proof, not a witness, and reports V1–V7.', math: 'V1 ∧ V2 ∧ V3 ∧ V4 ∧ V5 ∧ V6 ∧ V7' },
];

type LiveStages = {
  beta?: bigint;
  gamma?: bigint;
  alpha?: bigint;
  zeta?: bigint;
  rho?: bigint;
  witness?: { a: bigint[]; b: bigint[]; c: bigint[] };
  wirePolynomials?: { a: bigint[]; b: bigint[]; c: bigint[] };
  grandProduct?: { partials: bigint[] };
  quotient?: { chunks: bigint[][] };
};

export interface ProtocolPlayerProps {
  trace?: ProofTrace;
  checks: CheckResult[];
  running: boolean;
  onRun: () => void;
  onShare: () => void;
  onAttackWitness: () => void;
  onAttackLeaf: () => void;
  onGrind: () => void;
  shareStatus?: string;
  error?: string;
  attackStatus?: string;
}

function root(bytes: Uint8Array): string {
  return `${Array.from(bytes.slice(0, 8), (value) => value.toString(16).padStart(2, '0')).join('')}…`;
}

function stageForTranscriptLabel(label: string): number {
  if (label.includes('wires')) return 3;
  if (label === 'beta' || label === 'gamma') return 4;
  if (label.includes('z-root')) return 6;
  if (label === 'alpha') return 7;
  if (label.includes('t-root')) return 9;
  if (label === 'zeta' || label.includes('opening')) return 10;
  if (label === 'rho') return 12;
  if (label.includes('fri-root') || label.includes('fri-beta') || label.includes('fri-final')) return 13;
  if (label.includes('query')) return 14;
  return 0;
}

export function ProtocolPlayer({
  trace,
  checks,
  running,
  onRun,
  onShare,
  onAttackWitness,
  onAttackLeaf,
  onGrind,
  shareStatus,
  error,
  attackStatus,
}: ProtocolPlayerProps) {
  const [current, setCurrent] = useState(0);
  const [autoplay, setAutoplay] = useState(false);
  const [verifierView, setVerifierView] = useState(false);
  const [poly, setPoly] = useState<'a' | 'b' | 'c'>('a');
  const [queryIndex, setQueryIndex] = useState(0);
  const live = trace?.stages as LiveStages | undefined;
  const stage = stages[current]!;

  useEffect(() => {
    if (!autoplay || trace === undefined) return;
    const timer = window.setInterval(() => setCurrent((index) => index >= stages.length - 1 ? 0 : index + 1), 2200);
    return () => window.clearInterval(timer);
  }, [autoplay, trace]);

  const selectedQuery = trace?.proof.queries[Math.min(queryIndex, Math.max(0, (trace?.proof.queries.length ?? 1) - 1))];
  const coefficients = live?.wirePolynomials?.[poly] ?? [];
  const rows = live?.witness;
  const liveData = useMemo(() => {
    if (trace === undefined) return [] as Array<[string, string]>;
    if (current === 3) return [['wire root', root(trace.proof.wiresRoot.bytes)], ['LDE size', String(trace.proof.params.n * trace.proof.params.blowup)]];
    if (current === 4) return [['β', String(live?.beta ?? '')], ['γ', String(live?.gamma ?? '')]];
    if (current === 5) return [['Z partial products', (live?.grandProduct?.partials ?? []).slice(0, 8).join(', ')], ['Z final', String(live?.grandProduct?.partials?.at(-1) ?? '')]];
    if (current === 7) return [['α', String(live?.alpha ?? '')]];
    if (current === 8) return [['nonzero remainder rows', trace.quotientRemainder.flatMap((value, row) => value === 0n ? [] : [row]).join(', ') || 'none']];
    if (current === 9) return trace.proof.tRoots.map((value, index) => [`t${index} root`, root(value.bytes)]);
    if (current === 10) return [['ζ', String(live?.zeta ?? '')], ...trace.proof.openings.slice(0, 6).map((opening) => [opening.label, String(opening.value)] as [string, string])];
    if (current === 12) return [['ρ', String(live?.rho ?? '')], ['committed values batched', String(trace.proof.openings.length - 3)]];
    if (current === 13) return [['FRI roots', String(trace.proof.friLayerRoots.length)], ['final coefficients', trace.proof.friFinalCoeffs.slice(0, 8).join(', ')]];
    if (current === 14) return trace.proof.queries.map((query, index) => [`query ${index}`, `D[${query.index}], ${query.friLayers.length} folds`]);
    if (current === 15) return checks.map((check) => [check.id, `${check.ok ? 'pass' : 'fail'} — ${check.detail}`]);
    return [['trace rows n', String(trace.proof.params.n)], ['circuit digest', root(trace.proof.circuitDigest)]];
  }, [checks, current, live, trace]);

  return (
    <section className="protocol-player" aria-labelledby="player-title">
      <div className="player-heading">
        <div>
          <p className="eyebrow">M7 protocol player</p>
          <h2 id="player-title">Walk the proof, one exact operation at a time</h2>
        </div>
        <button type="button" onClick={onRun} disabled={running}>{running ? 'Preparing trace…' : 'Prove Selected Claim'}</button>
      </div>
      <div className="mode-bar">
        <label><input type="checkbox" checked={verifierView} onChange={(event) => setVerifierView(event.target.checked)} /> what the verifier sees</label>
        <label><input type="checkbox" checked={autoplay} onChange={(event) => setAutoplay(event.target.checked)} /> autoplay</label>
      </div>
      <div className="stage-rail" aria-label="Protocol stages">
        {stages.map((candidate, index) => <button key={candidate.title} type="button" className={index === current ? 'active' : ''} onClick={() => setCurrent(index)}>{index}</button>)}
      </div>
      <article className="stage-card">
        <p className="eyebrow">{stage.title}</p>
        <h3>{stage.sentence}</h3>
        <p className="stage-math">{stage.math}</p>
        {trace === undefined
          ? <p className="mono">Choose a preset or compile a canvas, then generate a replayable proof trace.</p>
          : <dl className="live-data">{liveData.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      </article>
      <div className="player-controls">
        <button type="button" onClick={() => setCurrent((index) => Math.max(0, index - 1))} disabled={current === 0}>Previous</button>
        <button type="button" onClick={() => setCurrent((index) => Math.min(stages.length - 1, index + 1))} disabled={current === stages.length - 1}>Next</button>
        <button type="button" onClick={onShare} disabled={trace === undefined}>Share Proof</button>
        <button type="button" onClick={onAttackWitness} disabled={running}>Cheat: Tamper Witness</button>
        <button type="button" onClick={onAttackLeaf} disabled={running || trace === undefined}>Cheat: Edit Leaf</button>
        <button type="button" onClick={onGrind} disabled={running}>Attack A3: Grind Q=1</button>
      </div>
      {shareStatus !== undefined && <p className="share-status">{shareStatus}</p>}
      {attackStatus !== undefined && <p className="caveat">{attackStatus}</p>}
      {error !== undefined && <p className="failure">{error}</p>}
      {trace !== undefined && (
        <div className="inspectors" aria-label="Proof inspectors">
          {!verifierView && rows !== undefined && <TraceInspector a={rows.a} b={rows.b} c={rows.c} remainder={trace.quotientRemainder} />}
          <PolynomialInspector coefficients={coefficients} poly={poly} onPoly={setPoly} />
          <MerkleInspector roots={[['wires', trace.proof.wiresRoot.bytes], ['Z', trace.proof.zRoot.bytes], ...trace.proof.tRoots.map((tree, index) => [`t${index}`, tree.bytes] as [string, Uint8Array])]} query={selectedQuery} queryIndex={queryIndex} queryCount={trace.proof.queries.length} onQuery={setQueryIndex} />
          <FriInspector roots={trace.proof.friLayerRoots.map((tree) => tree.bytes)} />
          <TranscriptInspector entries={trace.transcript} onJump={(label) => setCurrent(stageForTranscriptLabel(label))} />
        </div>
      )}
    </section>
  );
}

function TraceInspector({ a, b, c, remainder }: { a: bigint[]; b: bigint[]; c: bigint[]; remainder: bigint[] }) {
  return <article className="inspector"><h3>Trace table</h3><div className="trace-scroll"><table><thead><tr><th>row</th><th>a</th><th>b</th><th>c</th><th>C(ωⁱ)</th></tr></thead><tbody>{a.slice(0, 128).map((value, row) => <tr key={row} className={remainder[row] === 0n ? '' : 'bad-row'}><td>{row}</td><td>{value}</td><td>{b[row]}</td><td>{c[row]}</td><td>{remainder[row]}</td></tr>)}</tbody></table></div></article>;
}

function PolynomialInspector({ coefficients, poly, onPoly }: { coefficients: bigint[]; poly: 'a' | 'b' | 'c'; onPoly: (poly: 'a' | 'b' | 'c') => void }) {
  const max = coefficients.reduce((highest, value) => value > highest ? value : highest, 1n);
  return <article className="inspector"><h3>Polynomial inspector</h3><div className="inspector-tabs">{(['a', 'b', 'c'] as const).map((name) => <button key={name} type="button" className={name === poly ? 'active' : ''} onClick={() => onPoly(name)}>{name}(X)</button>)}</div><div className="poly-bars">{coefficients.slice(0, 64).map((value, index) => <span key={index} title={`coefficient ${index}: ${value}`} style={{ height: `${Math.max(3, Number((value * 100n) / max))}%` }} />)}</div><p className="mono">coefficients 0…{Math.max(0, coefficients.length - 1)}; hover a bar for its exact field value.</p></article>;
}

function MerkleInspector({ roots, query, queryIndex, queryCount, onQuery }: { roots: [string, Uint8Array][]; query: ProofTrace['proof']['queries'][number] | undefined; queryIndex: number; queryCount: number; onQuery: (index: number) => void }) {
  return <article className="inspector"><h3>Merkle commitments</h3><dl className="root-list">{roots.map(([label, bytes]) => <div key={label}><dt>{label}</dt><dd>{root(bytes)}</dd></div>)}</dl>{query !== undefined && <><label>Query <select value={queryIndex} onChange={(event) => onQuery(Number(event.target.value))}>{Array.from({ length: queryCount }, (_, index) => <option key={index} value={index}>{index}</option>)}</select></label><p className="mono">D[{query.index}] opens {Object.keys(query.paths).join(', ')}; path depths: {Object.entries(query.paths).map(([label, path]) => `${label}=${path.siblings.length}`).join(', ')}.</p></>}</article>;
}

function FriInspector({ roots }: { roots: Uint8Array[] }) {
  return <article className="inspector"><h3>FRI folding cascade</h3><ol className="fri-cascade">{roots.map((bytes, index) => <li key={index}><strong>L{index}</strong><span>{root(bytes)}</span><small>degree bound halves after this commitment</small></li>)}</ol></article>;
}

function TranscriptInspector({ entries, onJump }: { entries: ProofTrace['transcript']; onJump: (label: string) => void }) {
  return <article className="inspector transcript-inspector"><h3>Transcript timeline</h3><div>{entries.map((entry, index) => <button key={`${entry.kind}-${entry.label}-${index}`} type="button" onClick={() => onJump(entry.label)}><code>{entry.kind}</code> {entry.label}</button>)}</div></article>;
}
