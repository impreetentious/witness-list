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
import { sudoku, sudokuCellWires, sudokuGivens, sudokuInputs, sudokuSolution } from '@/zk/circuit/presets/sudoku';
import { verify } from '@/zk/plonk/verify';
import type { CheckResult, Params, ProofTrace } from '@/zk/types';
import { grindInWorker, proveInWorker } from '@/workers/prover-client';
import { SecurityReadout } from './security-readout';
import { ZkPanel } from './zk-panel';

type PresetId = 'pythagorean' | 'sudoku' | 'mimc' | 'age' | 'canvas';

interface Session {
  id: PresetId;
  title: string;
  circuit: Circuit;
  values: Map<number, string>;
  mimc?: { preimage: number; digest: number };
}

const pythagoreanValues = new Map(pythagoreanInputs.fields.map((field) => [field.wire, field.default.toString()]));

function initialSession(): Session {
  return { id: 'pythagorean', title: pythagorean.name, circuit: pythagorean, values: new Map(pythagoreanValues) };
}

function inputGates(circuit: Circuit): Gate[] {
  return circuit.gates.filter((gate) => gate.op === 'pub' || gate.op === 'priv').sort((left, right) => left.id - right.id);
}

function genericValues(circuit: Circuit): Map<number, string> {
  return new Map(inputGates(circuit).map((gate) => [gate.id, '0']));
}

async function loadPreset(id: Exclude<PresetId, 'canvas'>): Promise<Session> {
  if (id === 'pythagorean') return initialSession();
  if (id === 'sudoku') return {
    id,
    title: sudoku.name,
    circuit: sudoku,
    values: new Map([...sudokuInputs()].map(([wire, value]) => [wire, value.toString()])),
  };
  if (id === 'age') return {
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
    values: new Map([[preset.preimageWire, preimage.toString()], [preset.digestWire, (await mimcHash(preimage)).toString()]]),
    mimc: { preimage: preset.preimageWire, digest: preset.digestWire },
  };
}

function parseValues(values: Map<number, string>): Map<number, bigint> {
  return new Map([...values].map(([wire, value]) => {
    if (!/^-?\d+$/.test(value.trim())) throw new Error(`Wire ${wire} needs an integer field value.`);
    return [wire, BigInt(value)];
  }));
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
  const [queries, setQueries] = useState(8);
  const [seed, setSeed] = useState(42);
  const [lastParams, setLastParams] = useState<Params>({ n: 32, blowup: 8, queries: 8, zk: false });

  useEffect(() => {
    let cancelled = false;
    async function loadSharedProof(): Promise<void> {
      if (!/^#p(u)?=/.test(window.location.hash)) return;
      try {
        const payload = await decodeShare(window.location.hash);
        const compiled = await compile(payload.circuit);
        const result = await verify(compiled, payload.proof);
        if (cancelled) return;
        const values = genericValues(payload.circuit);
        payload.circuit.publicOrder.forEach((wire, index) => values.set(wire, payload.publicInputs[index]!.toString()));
        setSession({ id: 'canvas', title: `${payload.circuit.name} (shared)`, circuit: payload.circuit, values });
        setTrace({ proof: payload.proof, transcript: [], stages: {}, quotientRemainder: [] });
        setChecks(result.checks);
        setLastParams(payload.proof.params);
        setShareStatus(result.ok
          ? 'Verify-only mode: this browser checked V1–V7 from the shared proof and never received a witness.'
          : 'Verify-only mode: the shared proof failed its local verifier checklist.');
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? `Could not verify shared proof: ${caught.message}` : 'Could not verify shared proof.');
      }
    }
    void loadSharedProof();
    return () => { cancelled = true; };
  }, []);

  function updateValue(wire: number, value: string): void {
    setSession((current) => ({ ...current, values: new Map(current.values).set(wire, value) }));
  }

  function updateAge(value: string): void {
    if (!/^\d+$/.test(value)) {
      updateValue(agePreset.ageWire, value);
      return;
    }
    const ageValue = BigInt(value);
    if (ageValue < 18n || ageValue > 145n) {
      updateValue(agePreset.ageWire, value);
      return;
    }
    const next = new Map(session.values).set(agePreset.ageWire, value);
    const offset = ageValue - 18n;
    agePreset.bitWires.forEach((wire, bit) => next.set(wire, String((offset >> BigInt(bit)) & 1n)));
    setSession((current) => ({ ...current, values: next }));
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
      setSession((current) => current.mimc === undefined ? current : {
        ...current,
        values: new Map(current.values).set(current.mimc.digest, digest.toString()),
      });
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
      const params = { n: compiled.n, blowup: 8, queries, zk: proofZk };
      setLastParams(params);
      const result = await proveInWorker(session.circuit, inputMap, params, seed, setProgress);
      setTrace(result.trace);
      setChecks(result.result.checks);
      setProgress(undefined);
      setSeed((current) => current + 1);
      setShareStatus(proofZk
        ? 'Blinded proof generated in a worker and verified locally. The ledger below describes its teaching-scale ZK surface.'
        : 'Unblinded proof generated in a worker and verified locally.');
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
      if (target === undefined) throw new Error('This circuit has no arithmetic wire to tamper with.');
      const compiled = await compile(session.circuit);
      const params = { n: compiled.n, blowup: 8, queries, zk: false };
      const attack = await tamperWitness(session.circuit, parseValues(session.values), new Map([[target.id, 1n]]), params, seed);
      const result = await verify(compiled, attack.proof);
      setTrace(attack);
      setChecks(result.checks);
      setAttackStatus(`A1 changed computed wire ${target.id} after witness generation. The exact nonzero quotient rows are highlighted in the trace table; V2 rejects the proof.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not run the witness-tamper attack.');
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
      setAttackStatus('A2 edited an authenticated leaf after commitment. V3 names the failed Merkle opening.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not run the committed-leaf attack.');
    } finally {
      setRunning(false);
    }
  }

  async function runGrind(): Promise<void> {
    setRunning(true);
    setError(undefined);
    try {
      const result = await grindInWorker(session.circuit, parseValues(session.values), 1, 32, setProgress);
      setAttackStatus(`A3 used the same malicious prover as CI: ${result.succeeded ? 'a forged Q=1 proof passed' : 'no forged proof passed'} after ${result.attempts} attempts. At Q=1 its selected-coset strategy succeeds about once per eight attempts.`);
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
      const fragment = await encodeShare({ circuit: session.circuit, publicInputs, proof: trace.proof });
      const url = `${window.location.href.split('#')[0]}${fragment}`;
      window.history.replaceState(null, '', fragment);
      if (navigator.clipboard !== undefined) await navigator.clipboard.writeText(url);
      setShareStatus(navigator.clipboard === undefined ? 'Verify-only fragment placed in this URL.' : 'Verify-only proof URL copied to the clipboard.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not encode this share URL.');
    }
  }

  return (
    <div className="workshop">
      <header className="workshop-hero">
        <p className="eyebrow">Witness List · v1 workshop</p>
        <h1>Build a claim, prove it, try to cheat.</h1>
        <p>Every path runs in this browser. The proof is transparent and teaching-scale; its displayed soundness estimate is conjectured, never a production-security claim.</p>
      </header>
      <section className="workshop-toolbar" aria-label="Claim and proving controls">
        <div className="preset-picker"><span>Claim</span>{(['pythagorean', 'sudoku', 'mimc', 'age'] as const).map((id) => <button key={id} type="button" className={session.id === id ? 'active' : ''} disabled={loadingPreset} onClick={() => void choosePreset(id)}>{id === 'mimc' ? 'MiMC preimage' : id === 'age' ? 'Age ≥ 18' : id === 'sudoku' ? 'Sudoku 4×4' : 'Pythagorean'}</button>)}</div>
        <label>FRI queries <select value={queries} onChange={(event) => setQueries(Number(event.target.value))}><option value={4}>4</option><option value={8}>8</option><option value={16}>16</option><option value={32}>32</option></select></label>
        <label className="zk-toggle"><input type="checkbox" checked={zk} onChange={(event) => setZk(event.target.checked)} /> blinded teaching mode</label>
      </section>
      {loadingPreset && <p className="mono">Deriving the selected preset and its input mapping…</p>}
      <StructuredInputs session={session} onChange={updateValue} onAgeChange={updateAge} onMimcChange={updateMimcPreimage} />
      <CircuitCanvas circuit={session.circuit} onUseCircuit={(circuit) => {
        setSession({ id: 'canvas', title: circuit.name, circuit, values: genericValues(circuit) });
        setTrace(undefined);
        setChecks([]);
      }} />
      <SecurityReadout params={lastParams} />
      {progress !== undefined && <p className="worker-progress" role="status">Worker: {progress}</p>}
      <ProtocolPlayer trace={trace} checks={checks} running={running} onRun={() => void proveSelected()} onShare={() => void share()} onAttackWitness={() => void runTamperWitness()} onAttackLeaf={() => void runTamperLeaf()} onGrind={() => void runGrind()} shareStatus={shareStatus} error={error} attackStatus={attackStatus} />
      <ZkPanel trace={trace} onRunZk={() => { setZk(true); void proveSelected(true); }} />
    </div>
  );
}

function StructuredInputs({ session, onChange, onAgeChange, onMimcChange }: { session: Session; onChange: (wire: number, value: string) => void; onAgeChange: (value: string) => void; onMimcChange: (value: string) => void }) {
  if (session.id === 'sudoku') return <section className="structured-inputs"><p className="eyebrow">Structured witness input</p><h2>4×4 Sudoku solution</h2><div className="sudoku-grid">{sudokuCellWires.flatMap((row, rowIndex) => row.map((wire, columnIndex) => <label key={wire}><span>r{rowIndex + 1}c{columnIndex + 1}{sudokuGivens.some((given) => given.row === rowIndex && given.column === columnIndex) ? ' · public given' : ''}</span><input value={session.values.get(wire) ?? sudokuSolution[rowIndex]![columnIndex]!.toString()} inputMode="numeric" onChange={(event) => onChange(wire, event.target.value)} /></label>))}</div><p className="mono">Rows, columns, and 2×2 boxes constrain a private completed grid; the four labelled givens are public statement inputs.</p></section>;
  if (session.id === 'age') return <section className="structured-inputs"><p className="eyebrow">Structured witness input</p><h2>Age ≥ 18</h2><label className="range-input">age <input type="range" min="18" max="145" value={session.values.get(agePreset.ageWire) ?? '21'} onChange={(event) => onAgeChange(event.target.value)} /><output>{session.values.get(agePreset.ageWire) ?? '21'}</output></label><p className="mono">The seven private bits of age − 18 update with the slider, exposing the bit-decomposition range argument.</p></section>;
  if (session.id === 'mimc' && session.mimc !== undefined) return <section className="structured-inputs"><p className="eyebrow">Structured witness input</p><h2>MiMC-7 preimage</h2><label>private preimage <input value={session.values.get(session.mimc.preimage) ?? ''} inputMode="numeric" onChange={(event) => void onMimcChange(event.target.value)} /></label><label>public digest <input value={session.values.get(session.mimc.digest) ?? ''} readOnly /></label><p className="mono">The public digest updates from the selected preimage using the same 32-round MiMC-7 function as the circuit.</p></section>;
  if (session.id === 'pythagorean') return <section className="structured-inputs"><p className="eyebrow">Structured witness input</p><h2>Pythagorean triple</h2><div className="input-row">{pythagoreanInputs.fields.map((field) => <label key={field.wire}>{field.label}<input value={session.values.get(field.wire) ?? field.default.toString()} inputMode="numeric" onChange={(event) => onChange(field.wire, event.target.value)} /></label>)}</div><p className="mono">{pythagoreanInputs.callout}</p></section>;
  return <section className="structured-inputs"><p className="eyebrow">Canvas inputs</p><h2>{session.title}</h2><div className="input-row">{inputGates(session.circuit).map((gate) => <label key={gate.id}>wire {gate.id} ({gate.op})<input value={session.values.get(gate.id) ?? '0'} inputMode="numeric" onChange={(event) => onChange(gate.id, event.target.value)} /></label>)}</div><p className="mono">Canvas circuits expose each public and private input explicitly. Compile the canvas before proving it.</p></section>;
}
