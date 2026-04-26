'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FieldElement } from '@/app/field-element';
import {
  formatFieldDecimal,
  formatFieldHex,
  formatFpDecimal,
  formatFpHex,
} from '@/app/format-field';
import type { CheckResult, ProofTrace } from '@/zk/types';
import type { Fp2 } from '@/zk/fp2';

interface Stage {
  title: string;
  sentence: string;
  math: string;
}

const stages: Stage[] = [
  {
    title: '0 · Circuit',
    sentence: 'The chosen graph fixes the public statement before a proof exists.',
    math: 'digest = H(circuit || selectors || σ)',
  },
  {
    title: '1 · Witness fill',
    sentence: 'Private inputs fill the three wire columns; these rows are never sent directly.',
    math: 'w = (a, b, c) over H',
  },
  {
    title: '2 · Interpolation',
    sentence: 'Every trace column becomes a polynomial below its committed degree bound.',
    math: 'A(ωⁱ) = aᵢ',
  },
  {
    title: '3 · Commit wires',
    sentence: 'LDE values of the wire polynomials are hashed into one composite Merkle root.',
    math: 'root_w = Merkle(LDE(A) || LDE(B) || LDE(C))',
  },
  {
    title: '4 · β, γ',
    sentence: 'Fiat–Shamir fixes Fp² challenges for copy and optional lookup constraints.',
    math: 'β, γ ← Fp²(transcript)',
  },
  {
    title: '5 · Grand products',
    sentence: 'Copy and lookup products telescope only when their committed relations agree.',
    math: 'Z(ωx) = Z(x) · numerator(x) / denominator(x)',
  },
  {
    title: '6 · Commit Z',
    sentence: 'The running product is committed before the quotient challenge.',
    math: 'root_Z = Merkle(LDE(Z))',
  },
  {
    title: '7 · α',
    sentence: 'One challenge combines gate, transition, and boundary constraints.',
    math: 'C = gate + α·transition + α²·boundary',
  },
  {
    title: '8 · Divide by Z_H',
    sentence: 'A true statement has zero remainder; a cheat highlights its nonzero rows.',
    math: 't(X) = C(X) / (Xⁿ − 1)',
  },
  {
    title: '9 · Commit t',
    sentence: 'Positional quotient chunks are committed before ζ is sampled.',
    math: 't = Σ Xⁱⁿ·tᵢ',
  },
  {
    title: '10 · ζ openings',
    sentence: 'The verifier samples an off-domain point and receives claimed evaluations.',
    math: 'ζ ∉ H ∪ D',
  },
  {
    title: '11 · Identity at ζ',
    sentence: 'The main PLONK equation is checked at the unpredictable point.',
    math: 'C(ζ) = t(ζ)·(ζⁿ − 1)',
  },
  {
    title: '12 · DEEP composition',
    sentence: 'Committed openings reduce to one quotient-valued polynomial.',
    math: 'D(X) = Σ ρⁱ(Pᵢ(X) − Pᵢ(ζ)) / (X − ζ)',
  },
  {
    title: '13 · FRI cascade',
    sentence: 'Committed folds halve the degree bound layer by layer.',
    math: 'f′(x²) = even(f) + β·odd(f)',
  },
  {
    title: '14 · Queries',
    sentence: 'Post-commitment indices authenticate every required value and fold pair.',
    math: 'q ← H(transcript) mod |D|',
  },
  {
    title: '15 · Verify',
    sentence: 'The verifier sees a proof, not a witness, and reports V1–V7.',
    math: 'V1 ∧ V2 ∧ V3 ∧ V4 ∧ V5 ∧ V6 ∧ V7',
  },
];

type LiveStages = {
  beta?: bigint | Fp2;
  gamma?: bigint | Fp2;
  alpha?: bigint | Fp2;
  zeta?: bigint | Fp2;
  rho?: bigint | Fp2;
  witness?: { a: bigint[]; b: bigint[]; c: bigint[] };
  wirePolynomials?: { a: bigint[]; b: bigint[]; c: bigint[] };
  grandProduct?: { partials: Array<bigint | Fp2> };
  lookupGrandProduct?: {
    mode: 'membership' | 'multiset';
    partials: Fp2[];
    h1?: bigint[];
    h2?: bigint[];
  };
};

function field(value: bigint | Fp2 | undefined): string {
  if (value === undefined) return '';
  return formatFieldDecimal(value);
}

function fieldTitle(value: bigint | Fp2 | undefined): string {
  if (value === undefined) return '';
  return formatFieldHex(value);
}

function nonzero(value: bigint | Fp2): boolean {
  return typeof value === 'bigint' ? value !== 0n : value.c0 !== 0n || value.c1 !== 0n;
}

function FieldText({ value }: { value: bigint | Fp2 | undefined }): ReactNode {
  if (value === undefined) return null;
  return <FieldElement value={value} />;
}

export interface ProtocolPlayerProps {
  trace?: ProofTrace;
  checks: CheckResult[];
  running: boolean;
  /** When set (e.g. verify-only share load or course deep link), jump the player to this stage. */
  focusStage?: number;
  /** Prefer the verifier-only inspector surface (no witness columns). */
  preferVerifierView?: boolean;
  /** Stable key so repeated deep-links to the same stage still retarget the rail. */
  focusToken?: number;
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
  if (label.includes('fri-root') || label.includes('fri-beta') || label.includes('fri-final'))
    return 13;
  if (label.includes('query')) return 14;
  return 0;
}

export function ProtocolPlayer({
  trace,
  checks,
  running,
  focusStage,
  preferVerifierView = false,
  focusToken = 0,
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
  const [verifierView, setVerifierView] = useState(preferVerifierView);
  const [poly, setPoly] = useState<'a' | 'b' | 'c'>('a');
  const [queryIndex, setQueryIndex] = useState(0);
  const live = trace?.stages as LiveStages | undefined;
  const stage = stages[current]!;

  useEffect(() => {
    if (focusStage === undefined) return;
    setCurrent(Math.max(0, Math.min(stages.length - 1, focusStage)));
    if (preferVerifierView) setVerifierView(true);
  }, [focusStage, focusToken, preferVerifierView, trace?.proof.circuitDigest]);

  useEffect(() => {
    if (!autoplay || trace === undefined) return;
    const timer = window.setInterval(
      () => setCurrent((index) => (index >= stages.length - 1 ? 0 : index + 1)),
      2200,
    );
    return () => window.clearInterval(timer);
  }, [autoplay, trace]);

  const selectedQuery =
    trace?.proof.queries[Math.min(queryIndex, Math.max(0, (trace?.proof.queries.length ?? 1) - 1))];
  const coefficients = live?.wirePolynomials?.[poly] ?? [];
  const rows = live?.witness;
  const liveData = useMemo((): Array<[string, ReactNode]> => {
    if (trace === undefined) return [];
    if (current === 3)
      return [
        ['wire root', root(trace.proof.wiresRoot.bytes)],
        ['LDE size', String(trace.proof.params.n * trace.proof.params.blowup)],
      ];
    if (current === 4)
      return [
        ['β', <FieldText key="beta" value={live?.beta} />],
        ['γ', <FieldText key="gamma" value={live?.gamma} />],
      ];
    if (current === 5) {
      const partials = live?.grandProduct?.partials ?? [];
      return [
        [
          'copy Z partial products',
          <span
            key="z"
            className="field-list"
            title={partials.slice(0, 8).map(fieldTitle).join(', ')}
          >
            {partials.slice(0, 8).map(field).join(', ')}
          </span>,
        ],
        ['lookup argument', live?.lookupGrandProduct?.mode ?? 'not used'],
        [
          'lookup Z final',
          <FieldText key="zl" value={live?.lookupGrandProduct?.partials.at(-1)} />,
        ],
      ];
    }
    if (current === 7) return [['α', <FieldText key="alpha" value={live?.alpha} />]];
    if (current === 8)
      return [
        [
          'nonzero remainder rows',
          trace.quotientRemainder
            .flatMap((value, row) => (nonzero(value) ? [row] : []))
            .join(', ') || 'none',
        ],
      ];
    if (current === 9)
      return trace.proof.tRoots.map((value, index) => [`t${index} root`, root(value.bytes)]);
    if (current === 10)
      return [
        ['ζ', <FieldText key="zeta" value={live?.zeta} />],
        ...trace.proof.openings
          .slice(0, 6)
          .map(
            (opening) =>
              [opening.label, <FieldElement key={opening.label} value={opening.value} />] as [
                string,
                ReactNode,
              ],
          ),
      ];
    if (current === 12)
      return [
        ['ρ', <FieldText key="rho" value={live?.rho} />],
        ['committed values batched', String(trace.proof.openings.length - 3)],
      ];
    if (current === 13) {
      const coeffs = trace.proof.friFinalCoeffs.slice(0, 8);
      return [
        ['FRI roots', String(trace.proof.friLayerRoots.length)],
        [
          'final coefficients',
          <span key="fri" className="field-list" title={coeffs.map(fieldTitle).join(', ')}>
            {coeffs.map(field).join(', ')}
          </span>,
        ],
      ];
    }
    if (current === 14)
      return [
        ...(trace.proof.grindingNonce === undefined
          ? []
          : [['anti-grinding nonce', String(trace.proof.grindingNonce)] as [string, ReactNode]]),
        ...trace.proof.queries.map(
          (query, index) =>
            [`query ${index}`, `D[${query.index}], ${query.friLayers.length} folds`] as [
              string,
              ReactNode,
            ],
        ),
      ];
    if (current === 15)
      return checks.map((check) => [check.id, `${check.ok ? 'pass' : 'fail'} — ${check.detail}`]);
    return [
      ['trace rows n', String(trace.proof.params.n)],
      ['circuit digest', root(trace.proof.circuitDigest)],
    ];
  }, [checks, current, live, trace]);

  return (
    <section className="protocol-player" aria-labelledby="player-title">
      <div className="player-heading">
        <div>
          <p className="eyebrow">Protocol player</p>
          <h2 id="player-title">Walk the proof, one exact operation at a time</h2>
        </div>
        <button type="button" onClick={onRun} disabled={running}>
          {running ? 'Preparing trace…' : 'Prove Selected Claim'}
        </button>
      </div>
      <div className="mode-bar">
        <label>
          <input
            type="checkbox"
            checked={verifierView}
            onChange={(event) => setVerifierView(event.target.checked)}
          />{' '}
          what the verifier sees
        </label>
        <label>
          <input
            type="checkbox"
            checked={autoplay}
            onChange={(event) => setAutoplay(event.target.checked)}
          />{' '}
          autoplay
        </label>
      </div>
      <div className="stage-rail" aria-label="Protocol stages">
        {stages.map((candidate, index) => (
          <button
            key={candidate.title}
            type="button"
            className={index === current ? 'active' : ''}
            onClick={() => setCurrent(index)}
          >
            {index}
          </button>
        ))}
      </div>
      <article className="stage-card">
        <p className="eyebrow">{stage.title}</p>
        <h3>{stage.sentence}</h3>
        <p className="stage-math">{stage.math}</p>
        {trace === undefined ? (
          <p className="mono">
            Choose a preset or compile a canvas, then generate a replayable proof trace.
          </p>
        ) : (
          <dl className="live-data">
            {liveData.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </article>
      <div className="player-controls">
        <button
          type="button"
          onClick={() => setCurrent((index) => Math.max(0, index - 1))}
          disabled={current === 0}
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => setCurrent((index) => Math.min(stages.length - 1, index + 1))}
          disabled={current === stages.length - 1}
        >
          Next
        </button>
        <button type="button" onClick={onShare} disabled={trace === undefined}>
          Share Proof
        </button>
        <button type="button" onClick={onAttackWitness} disabled={running}>
          Cheat: Tamper Witness
        </button>
        <button type="button" onClick={onAttackLeaf} disabled={running || trace === undefined}>
          Cheat: Edit Leaf
        </button>
        <button type="button" onClick={onGrind} disabled={running}>
          Attack A3: Grind Q=1
        </button>
      </div>
      {shareStatus !== undefined && <p className="share-status">{shareStatus}</p>}
      {attackStatus !== undefined && <p className="caveat">{attackStatus}</p>}
      {error !== undefined && <p className="failure">{error}</p>}
      {trace !== undefined && (
        <div className="inspectors" aria-label="Proof inspectors">
          {!verifierView && rows !== undefined && (
            <TraceInspector a={rows.a} b={rows.b} c={rows.c} remainder={trace.quotientRemainder} />
          )}
          <PolynomialInspector coefficients={coefficients} poly={poly} onPoly={setPoly} />
          <MerkleInspector
            roots={[
              ['wires', trace.proof.wiresRoot.bytes],
              ['Z', trace.proof.zRoot.bytes],
              ...trace.proof.tRoots.map(
                (tree, index) => [`t${index}`, tree.bytes] as [string, Uint8Array],
              ),
            ]}
            query={selectedQuery}
            queryIndex={queryIndex}
            queryCount={trace.proof.queries.length}
            onQuery={setQueryIndex}
          />
          <ProofSizeInspector trace={trace} />
          <FriInspector roots={trace.proof.friLayerRoots.map((tree) => tree.bytes)} />
          {live?.lookupGrandProduct !== undefined && (
            <LookupInspector lookup={live.lookupGrandProduct} />
          )}
          <TranscriptInspector
            entries={trace.transcript}
            onJump={(label) => setCurrent(stageForTranscriptLabel(label))}
          />
        </div>
      )}
    </section>
  );
}

function LookupInspector({ lookup }: { lookup: NonNullable<LiveStages['lookupGrandProduct']> }) {
  const partials = lookup.partials.slice(0, 12);
  const h1 = lookup.h1?.slice(0, 12) ?? [];
  const h2 = lookup.h2?.slice(0, 12) ?? [];
  return (
    <article className="inspector">
      <h3>Lookup grand product</h3>
      <p>
        <strong>
          {lookup.mode === 'membership'
            ? 'Plookup sorted concatenation'
            : 'Tagged multiset equality'}
        </strong>
      </p>
      <p className="mono field-list" title={partials.map(fieldTitle).join(' · ')}>
        Z partials: {partials.map(field).join(' · ')}
      </p>
      {lookup.h1 !== undefined && (
        <p className="mono">
          h₁:{' '}
          <span className="field-list" title={h1.map(formatFpHex).join(', ')}>
            {h1.map(formatFpDecimal).join(', ')}
          </span>
          <br />
          h₂:{' '}
          <span className="field-list" title={h2.map(formatFpHex).join(', ')}>
            {h2.map(formatFpDecimal).join(', ')}
          </span>
        </p>
      )}
    </article>
  );
}

function TraceInspector({
  a,
  b,
  c,
  remainder,
}: {
  a: bigint[];
  b: bigint[];
  c: bigint[];
  remainder: ProofTrace['quotientRemainder'];
}) {
  const pageSize = 128;
  const pageCount = Math.max(1, Math.ceil(a.length / pageSize));
  const firstBadRow = remainder.findIndex((value) =>
    typeof value === 'bigint' ? value !== 0n : value.c0 !== 0n || value.c1 !== 0n,
  );
  const [page, setPage] = useState(firstBadRow < 0 ? 0 : Math.floor(firstBadRow / pageSize));
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (firstBadRow >= 0) setPage(Math.floor(firstBadRow / pageSize));
  }, [firstBadRow]);
  const start = Math.min(page, pageCount - 1) * pageSize;
  const visible = a.slice(start, start + pageSize);
  return (
    <article className="inspector">
      <h3>Trace table</h3>
      {pageCount > 1 && (
        <div className="trace-window-controls">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            disabled={page === 0}
          >
            Previous rows
          </button>
          <span className="mono">
            rows {start}–{Math.min(a.length - 1, start + pageSize - 1)} of {a.length}
          </span>
          <button
            type="button"
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            disabled={page >= pageCount - 1}
          >
            Next rows
          </button>
        </div>
      )}
      <div ref={scrollRef} className="trace-scroll" role="region" aria-label="Witness trace table">
        <div className="trace-scroll-actions">
          <button type="button" onClick={() => scrollRef.current?.scrollBy({ top: -160 })}>
            Scroll up
          </button>
          <button type="button" onClick={() => scrollRef.current?.scrollBy({ top: 160 })}>
            Scroll down
          </button>
          <button type="button" onClick={() => scrollRef.current?.scrollBy({ left: -240 })}>
            Scroll left
          </button>
          <button type="button" onClick={() => scrollRef.current?.scrollBy({ left: 240 })}>
            Scroll right
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>row</th>
              <th>a</th>
              <th>b</th>
              <th>c</th>
              <th>C(ωⁱ)</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((value, index) => {
              const row = start + index;
              const r = remainder[row];
              const bad =
                r !== undefined && (typeof r === 'bigint' ? r !== 0n : r.c0 !== 0n || r.c1 !== 0n);
              const bValue = b[row] ?? 0n;
              const cValue = c[row] ?? 0n;
              return (
                <tr key={row} className={bad ? 'bad-row' : ''}>
                  <td>{row}</td>
                  <td>
                    <FieldElement value={value} />
                  </td>
                  <td>
                    <FieldElement value={bValue} />
                  </td>
                  <td>
                    <FieldElement value={cValue} />
                  </td>
                  <td>{r === undefined ? '—' : <FieldElement value={r} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function PolynomialInspector({
  coefficients,
  poly,
  onPoly,
}: {
  coefficients: bigint[];
  poly: 'a' | 'b' | 'c';
  onPoly: (poly: 'a' | 'b' | 'c') => void;
}) {
  const max = coefficients.reduce((highest, value) => (value > highest ? value : highest), 1n);
  return (
    <article className="inspector">
      <h3>Polynomial inspector</h3>
      <div className="inspector-tabs">
        {(['a', 'b', 'c'] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={name === poly ? 'active' : ''}
            onClick={() => onPoly(name)}
          >
            {name}(X)
          </button>
        ))}
      </div>
      <div className="poly-bars">
        {coefficients.slice(0, 64).map((value, index) => (
          <span
            key={index}
            title={`coefficient ${index}: ${formatFpDecimal(value)} (${formatFpHex(value)})`}
            style={{ height: `${Math.max(3, Number((value * 100n) / max))}%` }}
          />
        ))}
      </div>
      <p className="mono">
        coefficients 0…{Math.max(0, coefficients.length - 1)}; hover a bar for thin-spaced decimal
        and hex.
      </p>
    </article>
  );
}

function MerkleInspector({
  roots,
  query,
  queryIndex,
  queryCount,
  onQuery,
}: {
  roots: [string, Uint8Array][];
  query: ProofTrace['proof']['queries'][number] | undefined;
  queryIndex: number;
  queryCount: number;
  onQuery: (index: number) => void;
}) {
  return (
    <article className="inspector">
      <h3>Merkle commitments</h3>
      <dl className="root-list">
        {roots.map(([label, bytes]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{root(bytes)}</dd>
          </div>
        ))}
      </dl>
      {query !== undefined && (
        <>
          <label>
            Query{' '}
            <select value={queryIndex} onChange={(event) => onQuery(Number(event.target.value))}>
              {Array.from({ length: queryCount }, (_, index) => (
                <option key={index} value={index}>
                  {index}
                </option>
              ))}
            </select>
          </label>
          <p className="mono">
            D[{query.index}] opens {Object.keys(query.paths).join(', ')}; path depths:{' '}
            {Object.entries(query.paths)
              .map(([label, path]) => `${label}=${path.siblings.length}`)
              .join(', ')}
            .
          </p>
        </>
      )}
    </article>
  );
}

function FriInspector({ roots }: { roots: Uint8Array[] }) {
  return (
    <article className="inspector">
      <h3>FRI folding cascade</h3>
      <ol className="fri-cascade">
        {roots.map((bytes, index) => (
          <li key={index}>
            <strong>L{index}</strong>
            <span>{root(bytes)}</span>
            <small>degree bound halves after this commitment</small>
          </li>
        ))}
      </ol>
    </article>
  );
}

function ProofSizeInspector({ trace }: { trace: ProofTrace }) {
  const jsonBytes = new TextEncoder().encode(
    JSON.stringify(trace.proof, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  ).length;
  const lookupRootCount =
    trace.proof.version === 2 && trace.proof.lookupRoots !== undefined
      ? 1 +
        Number(trace.proof.lookupRoots.h1Root !== undefined) +
        Number(trace.proof.lookupRoots.h2Root !== undefined)
      : 0;
  const merkleBytes =
    (2 + lookupRootCount + trace.proof.tRoots.length + trace.proof.friLayerRoots.length) * 32;
  const openingBytes = trace.proof.openings.length * (trace.proof.version === 2 ? 16 : 8);
  const queryBytes = trace.proof.queries.reduce(
    (total, query) =>
      total +
      Object.values(query.leaves).flat().length * 8 +
      Object.values(query.paths).reduce((paths, path) => paths + path.siblings.length * 32, 0),
    0,
  );
  return (
    <article className="inspector">
      <h3>Proof-size panel</h3>
      <dl className="root-list">
        <div>
          <dt>proof wire JSON</dt>
          <dd>{jsonBytes.toLocaleString()} bytes</dd>
        </div>
        <div>
          <dt>roots</dt>
          <dd>{merkleBytes.toLocaleString()} bytes</dd>
        </div>
        <div>
          <dt>claimed openings</dt>
          <dd>{openingBytes.toLocaleString()} bytes</dd>
        </div>
        <div>
          <dt>query leaf/path payload</dt>
          <dd>{queryBytes.toLocaleString()}+ bytes</dd>
        </div>
      </dl>
      <p className="mono">
        The exact exported size includes URL encoding and compression; this panel exposes the
        components before transport.
      </p>
    </article>
  );
}

function TranscriptInspector({
  entries,
  onJump,
}: {
  entries: ProofTrace['transcript'];
  onJump: (label: string) => void;
}) {
  return (
    <article className="inspector transcript-inspector">
      <h3>Transcript timeline</h3>
      <div>
        {entries.map((entry, index) => (
          <button
            key={`${entry.kind}-${entry.label}-${index}`}
            type="button"
            title={
              entry.extensionValue === undefined ? undefined : fieldTitle(entry.extensionValue)
            }
            onClick={() => onJump(entry.label)}
          >
            <code>{entry.kind}</code> {entry.label}
            {entry.extensionValue === undefined ? (
              ''
            ) : (
              <>
                {' '}
                = <FieldElement value={entry.extensionValue} />
              </>
            )}
          </button>
        ))}
      </div>
    </article>
  );
}
