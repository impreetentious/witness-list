'use client';

import { useEffect, useMemo, useState } from 'react';
import { compile, generateWitness } from '@/zk/circuit/compile';
import { pythagorean } from '@/zk/circuit/presets/pythagorean';
import { prove } from '@/zk/plonk/prove';
import { verify } from '@/zk/plonk/verify';
import { decodeShare, encodeShare } from '@/share/codec';
import type { CheckResult, ProofTrace } from '@/zk/types';

interface Stage {
  title: string;
  sentence: string;
  math: string;
}

/** Each player stage has plain language, exact math, and live data. */
const stages: Stage[] = [
  { title: '0 · Circuit', sentence: 'The visible graph fixes the statement before a proof exists.', math: 'digest = H(circuit || selectors || σ)' },
  { title: '1 · Witness fill', sentence: 'Private inputs fill the three wire columns without being sent as trace rows.', math: 'w = (a, b, c) over H' },
  { title: '2 · Interpolation', sentence: 'Each row column becomes one polynomial of degree below n.', math: 'A(ωⁱ) = aᵢ,  deg A < n' },
  { title: '3 · Commit wires', sentence: 'Wire LDE values are hashed into one composite Merkle tree.', math: 'root_w = Merkle(LDE(A) || LDE(B) || LDE(C))' },
  { title: '4 · β, γ', sentence: 'Fiat–Shamir fixes copy-constraint challenges after the wire commitment.', math: 'β, γ ← H(transcript)' },
  { title: '5 · Grand product Z', sentence: 'The copy permutation telescopes when repeated wire slots agree.', math: 'Z(ωx) = Z(x) · f(x) / f′(x)' },
  { title: '6 · Commit Z', sentence: 'The running product is committed before the quotient challenge.', math: 'root_Z = Merkle(LDE(Z))' },
  { title: '7 · α', sentence: 'One challenge combines gate, transition, and boundary constraints.', math: 'C = gate + α·transition + α²·boundary' },
  { title: '8 · Compose and divide', sentence: 'A true statement has zero remainder when C is divided by Xⁿ − 1.', math: 't(X) = C(X) / (Xⁿ − 1)' },
  { title: '9 · Commit t', sentence: 'The quotient chunks are committed independently.', math: 't = t₀ + Xⁿt₁ + X²ⁿt₂' },
  { title: '10 · ζ openings', sentence: 'The verifier samples an off-domain point and receives claimed evaluations.', math: 'ζ ∉ H ∪ D' },
  { title: '11 · Identity at ζ', sentence: 'The main PLONK equation is checked at the unpredictable point.', math: 'C(ζ) = t(ζ)·(ζⁿ − 1)' },
  { title: '12 · DEEP composition', sentence: 'All claimed openings are reduced to one quotient-valued polynomial.', math: 'D(X) = Σ ρⁱ(Pᵢ(X) − Pᵢ(ζ)) / (X − ζ)' },
  { title: '13 · FRI cascade', sentence: 'Committed folds halve the degree bound layer by layer.', math: 'f′(x²) = (f(x)+f(−x))/2 + β(f(x)−f(−x))/(2x)' },
  { title: '14 · Queries', sentence: 'Post-commitment indices walk Merkle paths and every fold pair.', math: 'q ← H(transcript) mod |D|' },
  { title: '15 · Verify', sentence: 'The verifier sees only the proof and reports its checklist, never a bare boolean.', math: 'V1 ∧ V2 ∧ V3 ∧ V4 ∧ V5 ∧ V6 ∧ V7' },
];

type FullStages = {
  beta: bigint;
  gamma: bigint;
  alpha: bigint;
  zeta: bigint;
  rho: bigint;
  witness: { a: bigint[]; b: bigint[]; c: bigint[] };
  wirePolynomials: { a: bigint[]; b: bigint[]; c: bigint[] };
  grandProduct: { values: bigint[]; partials: bigint[] };
  quotient: { tLo: bigint[]; tMid: bigint[]; tHi: bigint[] };
};

function stageData(index: number, trace: ProofTrace, checks: CheckResult[]): Array<[string, string]> {
  const live = trace.stages as unknown as FullStages;
  const root = (bytes: Uint8Array): string => Array.from(bytes.slice(0, 6), (byte) => byte.toString(16).padStart(2, '0')).join('') + '…';
  const sample = (values: bigint[]): string => values.slice(0, 6).join(', ') + (values.length > 6 ? ' …' : '');
  switch (index) {
    case 0: return [['Trace rows n', String(trace.proof.params.n)], ['Circuit digest', root(trace.proof.circuitDigest)]];
    case 1: return [['a rows', sample(live.witness.a)], ['b rows', sample(live.witness.b)], ['c rows', sample(live.witness.c)]];
    case 2: return [['deg A', String(live.wirePolynomials.a.length - 1)], ['deg B', String(live.wirePolynomials.b.length - 1)], ['deg C', String(live.wirePolynomials.c.length - 1)]];
    case 3: return [['Wire root', root(trace.proof.wiresRoot.bytes)], ['LDE size', String(trace.proof.params.n * trace.proof.params.blowup)]];
    case 4: return [['β', String(live.beta)], ['γ', String(live.gamma)]];
    case 5: return [['Z partial products', sample(live.grandProduct.partials)], ['Z final', String(live.grandProduct.partials.at(-1) ?? 0n)]];
    case 6: return [['Z root', root(trace.proof.zRoot.bytes)]];
    case 7: return [['α', String(live.alpha)]];
    case 8: return [['Remainder rows', trace.quotientRemainder.flatMap((value, row) => value === 0n ? [] : [row]).join(', ') || 'zero on every row']];
    case 9: return trace.proof.tRoots.map((tree, chunk) => [`t${chunk} root`, root(tree.bytes)]);
    case 10: return [['ζ', String(live.zeta)], ...trace.proof.openings.slice(0, 4).map((opening) => [opening.label, String(opening.value)] as [string, string])];
    case 11: return trace.proof.openings.slice(4).map((opening) => [opening.label, String(opening.value)] as [string, string]);
    case 12: return [['ρ', String(live.rho)], ['Committed values batched', 'a, b, c, Z, Z(ω·), t₀, t₁, t₂']];
    case 13: return [['FRI roots', String(trace.proof.friLayerRoots.length)], ['Final coefficients', sample(trace.proof.friFinalCoeffs)]];
    case 14: return trace.proof.queries.map((query, queryIndex) => [`query ${queryIndex}`, `D[${query.index}], ${query.friLayers.length} folds`]);
    case 15: return checks.map((check) => [check.id, check.ok ? `pass — ${check.detail}` : `fail — ${check.detail}`]);
    default: return [];
  }
}

export function ProtocolPlayer() {
  const [trace, setTrace] = useState<ProofTrace>();
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [current, setCurrent] = useState(0);
  const [autoplay, setAutoplay] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [shareStatus, setShareStatus] = useState<string>();

  useEffect(() => {
    if (!autoplay || trace === undefined) return;
    const timer = window.setInterval(() => setCurrent((stage) => stage >= stages.length - 1 ? 0 : stage + 1), 2200);
    return () => window.clearInterval(timer);
  }, [autoplay, trace]);

  useEffect(() => {
    let cancelled = false;
    async function verifySharedFragment(): Promise<void> {
      if (!/^#p(u)?=/.test(window.location.hash)) return;
      try {
        const payload = await decodeShare(window.location.hash);
        const circuit = await compile(payload.circuit);
        const result = await verify(circuit, payload.proof);
        if (cancelled) return;
        setChecks(result.checks);
        setShareStatus(result.ok
          ? 'Verify-only mode: this page verified the shared proof locally and never received a witness.'
          : 'Verify-only mode: the shared proof failed its local verifier checklist.');
        setCurrent(15);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? `Could not verify shared proof: ${caught.message}` : 'Could not verify shared proof.');
      }
    }
    void verifySharedFragment();
    return () => { cancelled = true; };
  }, []);

  async function run(): Promise<void> {
    setRunning(true);
    setError(undefined);
    try {
      const circuit = await compile(pythagorean);
      const proofTrace = await prove(
        circuit,
        generateWitness(pythagorean, new Map([[1, 5n], [2, 3n], [3, 4n]])),
        [5n],
        { n: circuit.n, blowup: 8, queries: 8, zk: false },
        42,
      );
      const result = await verify(circuit, proofTrace.proof);
      setTrace(proofTrace);
      setChecks(result.checks);
      setCurrent(0);
      setShareStatus('Local proof generated. Share it to open directly in verify-only mode.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unknown player error');
    } finally {
      setRunning(false);
    }
  }

  async function share(): Promise<void> {
    if (trace === undefined) return;
    try {
      const fragment = await encodeShare({ circuit: pythagorean, publicInputs: [5n], proof: trace.proof });
      const url = `${window.location.href.split('#')[0]}${fragment}`;
      window.history.replaceState(null, '', fragment);
      if (navigator.clipboard !== undefined) await navigator.clipboard.writeText(url);
      setShareStatus(navigator.clipboard === undefined ? 'Share fragment placed in this URL.' : 'Share URL copied. A recipient opens directly in verify-only mode.');
    } catch (caught) {
      setError(caught instanceof Error ? `Could not encode share URL: ${caught.message}` : 'Could not encode share URL.');
    }
  }

  const liveData = useMemo(() => trace === undefined ? [] : stageData(current, trace, checks), [checks, current, trace]);
  const stage = stages[current]!;
  return (
    <section className="protocol-player" aria-labelledby="player-title">
      <div className="player-heading">
        <div>
          <p className="eyebrow">M7 protocol player</p>
          <h2 id="player-title">Walk the proof, one exact operation at a time</h2>
        </div>
        <button type="button" onClick={run} disabled={running}>{running ? 'Preparing trace…' : 'Generate Replayable Trace'}</button>
      </div>
      <div className="stage-rail" aria-label="Protocol stages">
        {stages.map((candidate, index) => (
          <button key={candidate.title} type="button" className={index === current ? 'active' : ''} onClick={() => setCurrent(index)} aria-current={index === current ? 'step' : undefined}>
            {index}
          </button>
        ))}
      </div>
      <article className="stage-card">
        <p className="eyebrow">{stage.title}</p>
        <h3>{stage.sentence}</h3>
        <p className="stage-math">{stage.math}</p>
        {trace === undefined
          ? <p className="mono">Generate the deterministic Pythagorean trace to inspect live values.</p>
          : <dl className="live-data">{liveData.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      </article>
      <div className="player-controls">
        <button type="button" onClick={() => setCurrent((stageIndex) => Math.max(0, stageIndex - 1))} disabled={current === 0}>Previous</button>
        <button type="button" onClick={() => setCurrent((stageIndex) => Math.min(stages.length - 1, stageIndex + 1))} disabled={current === stages.length - 1}>Next</button>
        <label><input type="checkbox" checked={autoplay} onChange={(event) => setAutoplay(event.target.checked)} /> autoplay</label>
        <button type="button" onClick={share} disabled={trace === undefined}>Share Proof</button>
      </div>
      {shareStatus !== undefined && <p className="share-status">{shareStatus}</p>}
      {error !== undefined && <p className="failure">{error}</p>}
    </section>
  );
}
