'use client';

import { useEffect, useState } from 'react';
import { CircuitCanvas } from '@/canvas/circuit-canvas';
import { ProtocolPlayer } from '@/player/protocol-player';
import { decodeShare, encodeShare } from '@/share/codec';
import { tamperLeaf, tamperWitness } from '@/zk/attacks';
import { compile } from '@/zk/circuit/compile';
import type { Circuit, Gate } from '@/zk/circuit/ir';
import { age, ageInputs, agePreset } from '@/zk/circuit/presets/age';
import { mimcHash, makeMimcPreset } from '@/zk/circuit/presets/mimc';
import { pythagorean, pythagoreanInputs } from '@/zk/circuit/presets/pythagorean';
import {
  sudoku,
  sudokuCellWires,
  sudokuGivens,
  sudokuInputs,
  sudokuSolution,
} from '@/zk/circuit/presets/sudoku';
import {
  sudoku9,
  sudoku9CellWires,
  sudoku9Givens,
  sudoku9Inputs,
  sudoku9Solution,
} from '@/zk/circuit/presets/sudoku9';
import { verify } from '@/zk/plonk/verify';
import type { CheckResult, Params, ProofTrace } from '@/zk/types';
import { grindInWorker, proveInWorker } from '@/workers/prover-client';
import { SecurityReadout } from './security-readout';
import { CourseMode } from './course-mode';
import { WitnessScriptEditor } from './witness-script-editor';
import { ZkPanel } from './zk-panel';
import type { CompiledWitnessScript } from '@/script/witness-script';
import { lessons, type Lesson } from '@/course/lessons';

type PresetId = 'pythagorean' | 'sudoku' | 'sudoku9' | 'mimc' | 'age' | 'canvas' | 'script';

/** Default FRI query count — matches docs/PROTOCOL-SPEC.md §4.7 / §4.11 teaching-scale readout. */
const DEFAULT_QUERIES = 32;

function parseCourseDeepLink(hash: string): { lessonId?: string; stage?: number } {
  if (/^#p(u)?=/.test(hash)) return {};
  const lesson = /^#lesson=([\w-]+)$/.exec(hash);
  if (lesson !== null) return { lessonId: lesson[1] };
  const stage = /^#stage=(\d+)$/.exec(hash);
  if (stage !== null) return { stage: Number(stage[1]) };
  return {};
}
interface ScriptSession {
  compiled: CompiledWitnessScript;
  sourceValues: Map<string, string>;
}

interface Session {
  id: PresetId;
  title: string;
  circuit: Circuit;
  values: Map<number, string>;
  mimc?: { preimage: number; digest: number };
  script?: ScriptSession;
}

const pythagoreanValues = new Map(
  pythagoreanInputs.fields.map((field) => [field.wire, field.default.toString()]),
);

function initialSession(): Session {
  return {
    id: 'pythagorean',
    title: pythagorean.name,
    circuit: pythagorean,
    values: new Map(pythagoreanValues),
  };
}

function inputGates(circuit: Circuit): Gate[] {
  return circuit.gates
    .filter((gate) => gate.op === 'pub' || gate.op === 'priv')
    .sort((left, right) => left.id - right.id);
}

function genericValues(circuit: Circuit): Map<number, string> {
  return new Map(inputGates(circuit).map((gate) => [gate.id, '0']));
}

function scriptSession(
  compiled: CompiledWitnessScript,
  sourceValues: Record<string, bigint>,
): Session {
  const derived = compiled.deriveInputs(sourceValues);
  return {
    id: 'script',
    title: `${compiled.program.name} (Witness Script)`,
    circuit: compiled.circuit,
    values: new Map([...derived].map(([wire, value]) => [wire, value.toString()])),
    script: {
      compiled,
      sourceValues: new Map(
        Object.entries(sourceValues).map(([name, value]) => [name, value.toString()]),
      ),
    },
  };
}

async function loadPreset(id: Exclude<PresetId, 'canvas'>): Promise<Session> {
  if (id === 'pythagorean') return initialSession();
  if (id === 'sudoku')
    return {
      id,
      title: sudoku.name,
      circuit: sudoku,
      values: new Map([...sudokuInputs()].map(([wire, value]) => [wire, value.toString()])),
    };
  if (id === 'sudoku9')
    return {
      id,
      title: sudoku9.name,
      circuit: sudoku9,
      values: new Map([...sudoku9Inputs()].map(([wire, value]) => [wire, value.toString()])),
    };
  if (id === 'age')
    return {
      id,
      title: age.name,
      circuit: age,
      values: new Map([...ageInputs()].map(([wire, value]) => [wire, value.toString()])),
    };
  const preset = await makeMimcPreset();
  const preimage = 123456789n;
  return {
    id,
    title: preset.circuit.name,
    circuit: preset.circuit,
    values: new Map([
      [preset.preimageWire, preimage.toString()],
      [preset.digestWire, (await mimcHash(preimage)).toString()],
    ]),
    mimc: { preimage: preset.preimageWire, digest: preset.digestWire },
  };
}

function parseValues(values: Map<number, string>): Map<number, bigint> {
  return new Map(
    [...values].map(([wire, value]) => {
      if (!/^-?\d+$/.test(value.trim()))
        throw new Error(`Wire ${wire} needs an integer field value.`);
      return [wire, BigInt(value)];
    }),
  );
}

export function Workshop() {
  const [session, setSession] = useState<Session>(initialSession);
  const [loadingPreset, setLoadingPreset] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [trace, setTrace] = useState<ProofTrace>();
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [error, setError] = useState<string>();
  const [shareStatus, setShareStatus] = useState<string>();
  const [attackStatus, setAttackStatus] = useState<string>();
  const [zk, setZk] = useState(false);
  const [queries, setQueries] = useState(DEFAULT_QUERIES);
  const [grindingBits, setGrindingBits] = useState(0);
  const [seed, setSeed] = useState(42);
  const [lastParams, setLastParams] = useState<Params>({
    n: 32,
    blowup: 8,
    queries: DEFAULT_QUERIES,
    zk: false,
  });
  const [verifyOnly, setVerifyOnly] = useState(false);
  const [focusStage, setFocusStage] = useState<number>();
  const [focusToken, setFocusToken] = useState(0);
  const [activeLessonId, setActiveLessonId] = useState<string>();
  const readoutParams: Params = { ...lastParams, queries, grindingBits, zk };

  function openLesson(lesson: Lesson, writeHash = true): void {
    setVerifyOnly(false);
    setFocusStage(lesson.stage);
    setFocusToken((token) => token + 1);
    setActiveLessonId(lesson.id);
    if (writeHash && !/^#p(u)?=/.test(window.location.hash)) {
      window.history.replaceState(null, '', `#lesson=${lesson.id}`);
    }
    window.requestAnimationFrame(() => {
      document
        .getElementById('protocol-player')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function openStage(stage: number, writeHash = true): void {
    setVerifyOnly(false);
    setFocusStage(stage);
    setFocusToken((token) => token + 1);
    setActiveLessonId(undefined);
    if (writeHash && !/^#p(u)?=/.test(window.location.hash)) {
      window.history.replaceState(null, '', `#stage=${stage}`);
    }
    window.requestAnimationFrame(() => {
      document
        .getElementById('protocol-player')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  useEffect(() => {
    let cancelled = false;
    async function loadSharedProof(): Promise<void> {
      if (/^#p(u)?=/.test(window.location.hash)) {
        try {
          const payload = await decodeShare(window.location.hash);
          const compiled = await compile(payload.circuit);
          const result = await verify(compiled, payload.proof);
          if (cancelled) return;
          const values = genericValues(payload.circuit);
          payload.circuit.publicOrder.forEach((wire, index) =>
            values.set(wire, payload.publicInputs[index]!.toString()),
          );
          setSession({
            id: 'canvas',
            title: `${payload.circuit.name} (shared)`,
            circuit: payload.circuit,
            values,
          });
          // Verify-only payloads carry the lean Proof, not a prover trace — stage 15
          // still runs the checklist from `checks` without ever materializing a witness.
          setTrace({ proof: payload.proof, transcript: [], stages: {}, quotientRemainder: [] });
          setChecks(result.checks);
          setLastParams(payload.proof.params);
          setVerifyOnly(true);
          setFocusStage(15);
          setFocusToken((token) => token + 1);
          setActiveLessonId(undefined);
          setShareStatus(
            result.ok
              ? 'Verify-only mode: this browser checked V1–V7 from the shared proof and never received a witness.'
              : 'Verify-only mode: the shared proof failed its local verifier checklist.',
          );
        } catch (caught) {
          if (!cancelled)
            setError(
              caught instanceof Error
                ? `Could not verify shared proof: ${caught.message}`
                : 'Could not verify shared proof.',
            );
        }
        return;
      }
      const link = parseCourseDeepLink(window.location.hash);
      if (link.lessonId !== undefined) {
        const lesson = lessons.find((entry) => entry.id === link.lessonId);
        if (lesson !== undefined) openLesson(lesson, false);
        return;
      }
      if (link.stage !== undefined && Number.isFinite(link.stage)) openStage(link.stage, false);
    }
    void loadSharedProof();
    return () => {
      cancelled = true;
    };
  }, []);

  function updateValue(wire: number, value: string): void {
    setSession((current) => ({ ...current, values: new Map(current.values).set(wire, value) }));
  }

  function updateAge(value: string): void {
    updateValue(agePreset.ageWire, value);
  }

  function updateScriptValue(name: string, value: string): void {
    if (!/^-?\d+$/.test(value.trim()) || session.script === undefined) return;
    try {
      const sourceValues = new Map(session.script.sourceValues).set(name, value);
      const values = Object.fromEntries(
        [...sourceValues].map(([key, entry]) => [key, BigInt(entry)]),
      );
      const derived = session.script.compiled.deriveInputs(values);
      setSession((current) =>
        current.script === undefined
          ? current
          : {
              ...current,
              values: new Map([...derived].map(([wire, entry]) => [wire, entry.toString()])),
              script: { ...current.script, sourceValues },
            },
      );
      setError(undefined);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not update the Witness Script input.',
      );
    }
  }

  function useScript(compiled: CompiledWitnessScript, sourceValues: Record<string, bigint>): void {
    try {
      setSession(scriptSession(compiled, sourceValues));
      setTrace(undefined);
      setChecks([]);
      setError(undefined);
      setAttackStatus(undefined);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not load the compiled Witness Script.',
      );
    }
  }

  async function choosePreset(id: Exclude<PresetId, 'canvas'>): Promise<void> {
    setLoadingPreset(true);
    setError(undefined);
    try {
      setSession(await loadPreset(id));
      setTrace(undefined);
      setChecks([]);
      setAttackStatus(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load this preset.');
    } finally {
      setLoadingPreset(false);
    }
  }

  async function updateMimcPreimage(value: string): Promise<void> {
    updateValue(session.mimc?.preimage ?? -1, value);
    if (session.mimc === undefined || !/^\d+$/.test(value)) return;
    try {
      const digest = await mimcHash(BigInt(value));
      setSession((current) =>
        current.mimc === undefined
          ? current
          : {
              ...current,
              values: new Map(current.values).set(current.mimc.digest, digest.toString()),
            },
      );
    } catch {
      // The normal prover validation reports invalid input in-context.
    }
  }

  async function proveSelected(forceZk?: boolean): Promise<void> {
    setRunning(true);
    setError(undefined);
    setAttackStatus(undefined);
    setShareStatus(undefined);
    try {
      const inputMap = parseValues(session.values);
      const compiled = await compile(session.circuit);
      const proofZk = forceZk ?? zk;
      const params = { n: compiled.n, blowup: 8, queries, zk: proofZk, grindingBits };
      setLastParams(params);
      const result = await proveInWorker(session.circuit, inputMap, params, seed, setProgress);
      setTrace(result.trace);
      setChecks(result.result.checks);
      setProgress(undefined);
      setSeed((current) => current + 1);
      setShareStatus(
        proofZk
          ? 'Blinded proof generated in a worker and verified locally. The ledger below describes its teaching-scale ZK surface.'
          : 'Unblinded proof generated in a worker and verified locally.',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not generate the proof.');
      setProgress(undefined);
    } finally {
      setRunning(false);
    }
  }

  async function runTamperWitness(): Promise<void> {
    setRunning(true);
    setError(undefined);
    try {
      const target = session.circuit.gates.find((gate) => gate.op === 'add' || gate.op === 'mul');
      if (target === undefined)
        throw new Error('This circuit has no arithmetic wire to tamper with.');
      const compiled = await compile(session.circuit);
      const params = { n: compiled.n, blowup: 8, queries, zk: false };
      const attack = await tamperWitness(
        session.circuit,
        parseValues(session.values),
        new Map([[target.id, 1n]]),
        params,
        seed,
      );
      const result = await verify(compiled, attack.proof);
      setTrace(attack);
      setChecks(result.checks);
      setAttackStatus(
        `A1 changed computed wire ${target.id} after witness generation. The exact nonzero quotient rows are highlighted in the trace table; V2 rejects the proof.`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not run the witness-tamper attack.',
      );
    } finally {
      setRunning(false);
    }
  }

  async function runTamperLeaf(): Promise<void> {
    if (trace === undefined) return;
    setRunning(true);
    setError(undefined);
    try {
      const compiled = await compile(session.circuit);
      const attack = tamperLeaf(trace, trace.proof.queries[0]!.index);
      const result = await verify(compiled, attack.proof);
      setTrace(attack);
      setChecks(result.checks);
      setAttackStatus(
        'A2 edited an authenticated leaf after commitment. V3 names the failed Merkle opening.',
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not run the committed-leaf attack.',
      );
    } finally {
      setRunning(false);
    }
  }

  async function runGrind(): Promise<void> {
    setRunning(true);
    setError(undefined);
    try {
      const result = await grindInWorker(
        session.circuit,
        parseValues(session.values),
        1,
        32,
        setProgress,
      );
      const workPerAttempt = 2 ** grindingBits;
      const projectedWork = result.attempts * workPerAttempt;
      setAttackStatus(
        `A3 used the same malicious prover as CI: ${result.succeeded ? 'a forged Q=1 proof passed' : 'no forged proof passed'} after ${result.attempts} query-fishing attempts. At Q=1 its selected-coset strategy succeeds about once per eight attempts. With the selected 2^${grindingBits} work factor, replaying those attempts would require roughly ${projectedWork.toLocaleString()} nonce trials instead of ${result.attempts}.`,
      );
      setProgress(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not run the grinding demo.');
      setProgress(undefined);
    } finally {
      setRunning(false);
    }
  }

  async function share(): Promise<void> {
    if (trace === undefined) return;
    setShareStatus('Encoding proof URL…');
    setError(undefined);
    try {
      const publicInputs = session.circuit.publicOrder.map((wire) => {
        const value = parseValues(session.values).get(wire);
        if (value === undefined) throw new Error(`missing public input wire ${wire}`);
        return value;
      });
      const fragment = await encodeShare({
        circuit: session.circuit,
        publicInputs,
        proof: trace.proof,
      });
      const url = `${window.location.href.split('#')[0]}${fragment}`;
      window.history.replaceState(null, '', fragment);
      if (navigator.clipboard !== undefined) await navigator.clipboard.writeText(url);
      setShareStatus(
        navigator.clipboard === undefined
          ? 'Verify-only fragment placed in this URL.'
          : 'Verify-only proof URL copied to the clipboard.',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not encode this share URL.');
    }
  }

  return (
    <div className="workshop">
      <header className="workshop-hero">
        <p className="eyebrow">Witness List · v1 workshop</p>
        <h1>Write a claim, prove it, try to cheat.</h1>
        <p>
          Start with a five-line Witness Script or a visual circuit. Every path runs in this
          browser. The proof is transparent and teaching-scale; its displayed soundness estimate is
          conjectured, never a production-security claim. Default FRI queries are 32 — the live
          §4.11 readout tracks whatever count you select.
        </p>
      </header>
      <section className="workshop-toolbar" aria-label="Claim and proving controls">
        <div className="preset-picker">
          <span>Claim</span>
          {(['pythagorean', 'sudoku', 'sudoku9', 'mimc', 'age'] as const).map((id) => (
            <button
              key={id}
              type="button"
              className={session.id === id ? 'active' : ''}
              disabled={loadingPreset}
              onClick={() => void choosePreset(id)}
            >
              {id === 'mimc'
                ? 'MiMC preimage'
                : id === 'age'
                  ? 'Age ≥ 18'
                  : id === 'sudoku9'
                    ? 'Sudoku 9×9'
                    : id === 'sudoku'
                      ? 'Sudoku 4×4'
                      : 'Pythagorean'}
            </button>
          ))}
        </div>
        <label>
          FRI queries{' '}
          <select value={queries} onChange={(event) => setQueries(Number(event.target.value))}>
            <option value={4}>4</option>
            <option value={8}>8</option>
            <option value={16}>16</option>
            <option value={32}>32</option>
          </select>
        </label>
        <label>
          anti-grinding{' '}
          <select
            value={grindingBits}
            onChange={(event) => setGrindingBits(Number(event.target.value))}
          >
            <option value={0}>off</option>
            <option value={4}>2⁴ work</option>
            <option value={8}>2⁸ work</option>
            <option value={12}>2¹² work</option>
          </select>
        </label>
        <label className="zk-toggle">
          <input type="checkbox" checked={zk} onChange={(event) => setZk(event.target.checked)} />{' '}
          blinded teaching mode
        </label>
      </section>
      {loadingPreset && <p className="mono">Deriving the selected preset and its input mapping…</p>}
      <div className="workshop-ide" aria-label="Workshop workbench">
        <aside className="workshop-pane workshop-pane-author" aria-label="Author pane">
          <p className="pane-label">Author</p>
          <WitnessScriptEditor onUseScript={useScript} />
          <CourseMode
            onOpenLesson={(lesson) => openLesson(lesson)}
            activeLessonId={activeLessonId}
          />
          <StructuredInputs
            session={session}
            onChange={updateValue}
            onAgeChange={updateAge}
            onMimcChange={updateMimcPreimage}
            onScriptChange={updateScriptValue}
          />
        </aside>
        <section className="workshop-pane workshop-pane-circuit" aria-label="Circuit pane">
          <p className="pane-label">Circuit</p>
          <CircuitCanvas
            circuit={session.circuit}
            onUseCircuit={(circuit) => {
              setSession({
                id: 'canvas',
                title: circuit.name,
                circuit,
                values: genericValues(circuit),
              });
              setTrace(undefined);
              setChecks([]);
            }}
          />
        </section>
        <aside className="workshop-pane workshop-pane-bound" aria-label="Bound pane">
          <p className="pane-label">Bound</p>
          <SecurityReadout params={readoutParams} />
        </aside>
        <section
          className="workshop-pane workshop-pane-player"
          aria-label="Protocol player pane"
          id="protocol-player"
        >
          <p className="pane-label">Protocol</p>
          {progress !== undefined && (
            <p className="worker-progress" role="status">
              Worker: {progress}
            </p>
          )}
          <ProtocolPlayer
            trace={trace}
            checks={checks}
            running={running}
            focusStage={verifyOnly ? 15 : focusStage}
            focusToken={focusToken}
            preferVerifierView={verifyOnly}
            onRun={() => {
              setVerifyOnly(false);
              void proveSelected();
            }}
            onShare={() => void share()}
            onAttackWitness={() => {
              setVerifyOnly(false);
              void runTamperWitness();
            }}
            onAttackLeaf={() => {
              setVerifyOnly(false);
              void runTamperLeaf();
            }}
            onGrind={() => {
              setVerifyOnly(false);
              void runGrind();
            }}
            shareStatus={shareStatus}
            error={error}
            attackStatus={attackStatus}
          />
        </section>
        <section className="workshop-pane workshop-pane-zk" aria-label="ZK ledger pane">
          <p className="pane-label">ZK ledger</p>
          <ZkPanel
            trace={trace}
            onRunZk={() => {
              setZk(true);
              void proveSelected(true);
            }}
          />
        </section>
      </div>
    </div>
  );
}

function StructuredInputs({
  session,
  onChange,
  onAgeChange,
  onMimcChange,
  onScriptChange,
}: {
  session: Session;
  onChange: (wire: number, value: string) => void;
  onAgeChange: (value: string) => void;
  onMimcChange: (value: string) => void;
  onScriptChange: (name: string, value: string) => void;
}) {
  if (session.id === 'script' && session.script !== undefined)
    return (
      <section className="structured-inputs">
        <p className="eyebrow">Witness Script inputs</p>
        <h2>{session.title}</h2>
        <div className="input-row">
          {[...session.script.compiled.inputs.entries()].map(([name, wire]) => (
            <label key={name}>
              {name} <span className="mono">(wire {wire})</span>
              <input
                value={session.script?.sourceValues.get(name) ?? ''}
                inputMode="numeric"
                onChange={(event) => onScriptChange(name, event.target.value)}
              />
            </label>
          ))}
        </div>
        <p className="mono">
          Inclusive ranges compile to the circuit’s fixed lookup table. The proof uses the same
          worker, verifier, and share format as a canvas claim.
        </p>
      </section>
    );
  if (session.id === 'sudoku')
    return (
      <section className="structured-inputs">
        <p className="eyebrow">Structured witness input</p>
        <h2>4×4 Sudoku solution</h2>
        <div className="sudoku-grid">
          {sudokuCellWires.flatMap((row, rowIndex) =>
            row.map((wire, columnIndex) => (
              <label key={wire}>
                <span>
                  r{rowIndex + 1}c{columnIndex + 1}
                  {sudokuGivens.some(
                    (given) => given.row === rowIndex && given.column === columnIndex,
                  )
                    ? ' · public given'
                    : ''}
                </span>
                <input
                  value={
                    session.values.get(wire) ?? sudokuSolution[rowIndex]![columnIndex]!.toString()
                  }
                  inputMode="numeric"
                  onChange={(event) => onChange(wire, event.target.value)}
                />
              </label>
            )),
          )}
        </div>
        <p className="mono">
          Rows, columns, and 2×2 boxes constrain a private completed grid; the four labelled givens
          are public statement inputs.
        </p>
      </section>
    );
  if (session.id === 'sudoku9')
    return (
      <section className="structured-inputs">
        <p className="eyebrow">Protocol-v2 lookup preset</p>
        <h2>9×9 Sudoku solution</h2>
        <div className="sudoku-grid sudoku-grid-9">
          {sudoku9CellWires.flatMap((row, rowIndex) =>
            row.map((wire, columnIndex) => (
              <label key={wire}>
                <span>
                  r{rowIndex + 1}c{columnIndex + 1}
                  {sudoku9Givens.some(
                    (given) => given.row === rowIndex && given.column === columnIndex,
                  )
                    ? ' · public'
                    : ''}
                </span>
                <input
                  value={
                    session.values.get(wire) ?? sudoku9Solution[rowIndex]![columnIndex]!.toString()
                  }
                  inputMode="numeric"
                  onChange={(event) => onChange(wire, event.target.value)}
                />
              </label>
            )),
          )}
        </div>
        <p className="mono">
          One tagged Fp² grand product binds all 27 row, column, and 3×3-box multisets to fixed
          copies of 1…9.
        </p>
      </section>
    );
  if (session.id === 'age')
    return (
      <section className="structured-inputs">
        <p className="eyebrow">Structured witness input</p>
        <h2>Age ≥ 18</h2>
        <label className="range-input">
          age{' '}
          <input
            type="range"
            min="18"
            max="145"
            value={session.values.get(agePreset.ageWire) ?? '21'}
            onChange={(event) => onAgeChange(event.target.value)}
          />
          <output>{session.values.get(agePreset.ageWire) ?? '21'}</output>
        </label>
        <p className="mono">
          A protocol-bound Plookup table constrains the private age to the inclusive range 18…145
          without auxiliary bit witnesses.
        </p>
      </section>
    );
  if (session.id === 'mimc' && session.mimc !== undefined)
    return (
      <section className="structured-inputs">
        <p className="eyebrow">Structured witness input</p>
        <h2>MiMC-7 preimage</h2>
        <label>
          private preimage{' '}
          <input
            value={session.values.get(session.mimc.preimage) ?? ''}
            inputMode="numeric"
            onChange={(event) => void onMimcChange(event.target.value)}
          />
        </label>
        <label>
          public digest <input value={session.values.get(session.mimc.digest) ?? ''} readOnly />
        </label>
        <p className="mono">
          The public digest updates from the selected preimage using the same 32-round MiMC-7
          function as the circuit.
        </p>
      </section>
    );
  if (session.id === 'pythagorean')
    return (
      <section className="structured-inputs">
        <p className="eyebrow">Structured witness input</p>
        <h2>Pythagorean triple</h2>
        <div className="input-row">
          {pythagoreanInputs.fields.map((field) => (
            <label key={field.wire}>
              {field.label}
              <input
                value={session.values.get(field.wire) ?? field.default.toString()}
                inputMode="numeric"
                onChange={(event) => onChange(field.wire, event.target.value)}
              />
            </label>
          ))}
        </div>
        <p className="mono">{pythagoreanInputs.callout}</p>
      </section>
    );
  return (
    <section className="structured-inputs">
      <p className="eyebrow">Canvas inputs</p>
      <h2>{session.title}</h2>
      <div className="input-row">
        {inputGates(session.circuit).map((gate) => (
          <label key={gate.id}>
            wire {gate.id} ({gate.op})
            <input
              value={session.values.get(gate.id) ?? '0'}
              inputMode="numeric"
              onChange={(event) => onChange(gate.id, event.target.value)}
            />
          </label>
        ))}
      </div>
      {session.circuit.provenance?.kind === 'witness-script' && (
        <details className="shared-script">
          <summary>Shared Witness Script provenance</summary>
          <pre>{session.circuit.provenance.source}</pre>
        </details>
      )}
      <p className="mono">
        Canvas circuits expose each public and private input explicitly. Compile the canvas before
        proving it.
      </p>
    </section>
  );
}
