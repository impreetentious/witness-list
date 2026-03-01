/**
 * Circuit graph -> PLONK rows (a,b,c + selectors + σ) and witness generation.
 * M3.
 */
import { P, add, mod, mul } from '../field';
import type { Fp } from '../field';
import { validate } from './ir';
import type { Circuit, Gate } from './ir';

interface CompiledRow {
  a: number | null;
  b: number | null;
  c: number | null;
}

export interface CompiledCircuit {
  n: number; // rows, power of two
  qL: Fp[];
  qR: Fp[];
  qO: Fp[];
  qM: Fp[];
  qC: Fp[];
  /** σ over 3n slots; slot ids on H, k1·H, k2·H with k1=7, k2=49 */
  sigma: Uint32Array;
  publicRows: number;
  digest: Uint8Array; // SHA-256 of canonical serialization, absorbed in round 0
  /** Gate output ids occupying each PLONK row; null means an independent padding slot. */
  rows: CompiledRow[];
}

export interface Witness {
  a: Fp[];
  b: Fp[];
  c: Fp[];
}

function assertValid(circuit: Circuit): void {
  const issues = validate(circuit);
  if (issues.length > 0) throw new Error(`Invalid circuit: ${JSON.stringify(issues)}`);
}

function topologicalOrder(circuit: Circuit): Gate[] {
  const byId = new Map(circuit.gates.map((gate) => [gate.id, gate]));
  const visited = new Set<number>();
  const ordered: Gate[] = [];
  function visit(gateId: number): void {
    if (visited.has(gateId)) return;
    const gate = byId.get(gateId);
    if (gate === undefined) throw new Error(`missing gate ${gateId}`);
    visited.add(gateId);
    for (const input of gate.inputs) visit(input);
    ordered.push(gate);
  }
  for (const gate of circuit.gates) visit(gate.id);
  return ordered;
}

function nextPowerOfTwo(value: number): number {
  // v1 presets intentionally begin at 2^5 rows, even
  // when their arithmetic rows would fit in a smaller domain.
  let n = 32;
  while (n < value) n *= 2;
  return n;
}

function buildRows(circuit: Circuit): { rows: CompiledRow[]; selectors: { qL: Fp[]; qR: Fp[]; qO: Fp[]; qM: Fp[]; qC: Fp[] } } {
  assertValid(circuit);
  const rows: CompiledRow[] = circuit.publicOrder.map((gateId) => ({ a: gateId, b: null, c: null }));
  const qL: Fp[] = circuit.publicOrder.map(() => 1n);
  const qR: Fp[] = circuit.publicOrder.map(() => 0n);
  const qO: Fp[] = circuit.publicOrder.map(() => 0n);
  const qM: Fp[] = circuit.publicOrder.map(() => 0n);
  const qC: Fp[] = circuit.publicOrder.map(() => 0n);

  for (const gate of topologicalOrder(circuit)) {
    switch (gate.op) {
      case 'pub':
      case 'priv':
        break;
      case 'const':
        rows.push({ a: null, b: null, c: gate.id });
        qL.push(0n); qR.push(0n); qO.push(P - 1n); qM.push(0n); qC.push(mod(gate.value!));
        break;
      case 'add':
        rows.push({ a: gate.inputs[0]!, b: gate.inputs[1]!, c: gate.id });
        qL.push(1n); qR.push(1n); qO.push(P - 1n); qM.push(0n); qC.push(0n);
        break;
      case 'mul':
        rows.push({ a: gate.inputs[0]!, b: gate.inputs[1]!, c: gate.id });
        qL.push(0n); qR.push(0n); qO.push(P - 1n); qM.push(1n); qC.push(0n);
        break;
      case 'assert0':
        rows.push({ a: gate.inputs[0]!, b: null, c: null });
        qL.push(1n); qR.push(0n); qO.push(0n); qM.push(0n); qC.push(0n);
        break;
    }
  }

  const n = nextPowerOfTwo(rows.length);
  while (rows.length < n) {
    rows.push({ a: null, b: null, c: null });
    qL.push(0n); qR.push(0n); qO.push(0n); qM.push(0n); qC.push(0n);
  }
  return { rows, selectors: { qL, qR, qO, qM, qC } };
}

function buildSigma(rows: CompiledRow[]): Uint32Array {
  const n = rows.length;
  const classes = new Map<string, number[]>();
  const addSlot = (wireId: number | null, slot: number): void => {
    const key = wireId === null ? `slot:${slot}` : `wire:${wireId}`;
    const slots = classes.get(key) ?? [];
    slots.push(slot);
    classes.set(key, slots);
  };
  for (let row = 0; row < n; row++) {
    const entry = rows[row]!;
    addSlot(entry.a, row);
    addSlot(entry.b, n + row);
    addSlot(entry.c, 2 * n + row);
  }

  const sigma = new Uint32Array(3 * n);
  for (const slots of classes.values()) {
    for (let i = 0; i < slots.length; i++) sigma[slots[i]!] = slots[(i + 1) % slots.length]!;
  }
  return sigma;
}

function canonicalBytes(circuit: Circuit, compiled: Omit<CompiledCircuit, 'digest'>): Uint8Array {
  const canonical = {
    name: circuit.name,
    gates: [...circuit.gates]
      .sort((a, b) => a.id - b.id)
      .map((gate) => ({ id: gate.id, op: gate.op, inputs: gate.inputs, value: gate.value?.toString() })),
    publicOrder: circuit.publicOrder,
    qL: compiled.qL.map(String),
    qR: compiled.qR.map(String),
    qO: compiled.qO.map(String),
    qM: compiled.qM.map(String),
    qC: compiled.qC.map(String),
    sigma: Array.from(compiled.sigma),
  };
  return new TextEncoder().encode(JSON.stringify(canonical));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(bytes.length);
  input.set(bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/** Compile the graph into deterministic PLONK rows and a circuit-bound digest. */
export async function compile(circuit: Circuit): Promise<CompiledCircuit> {
  const { rows, selectors } = buildRows(circuit);
  const compiledWithoutDigest = {
    n: rows.length,
    ...selectors,
    sigma: buildSigma(rows),
    publicRows: circuit.publicOrder.length,
    rows,
  };
  return { ...compiledWithoutDigest, digest: await sha256(canonicalBytes(circuit, compiledWithoutDigest)) };
}

/**
 * Forward evaluation over the toposort. `overrides` applies AFTER evaluation
 * with no re-propagation — the tamper hook (cheat mode A1).
 */
export function generateWitness(
  circuit: Circuit,
  inputs: Map<number, Fp>,
  overrides: Map<number, Fp> = new Map(),
): Witness {
  const { rows } = buildRows(circuit);
  const values = new Map<number, Fp>();
  for (const gate of topologicalOrder(circuit)) {
    const input = (index: number): Fp => {
      const value = values.get(gate.inputs[index]!);
      if (value === undefined) throw new Error(`gate ${gate.id} reads an uncomputed input`);
      return value;
    };
    let value: Fp;
    switch (gate.op) {
      case 'pub':
      case 'priv': {
        const supplied = inputs.get(gate.id);
        if (supplied === undefined) throw new Error(`missing ${gate.op} input for gate ${gate.id}`);
        value = mod(supplied);
        break;
      }
      case 'const':
        value = mod(gate.value!);
        break;
      case 'add':
        value = add(input(0), input(1));
        break;
      case 'mul':
        value = mul(input(0), input(1));
        break;
      case 'assert0':
        value = 0n;
        break;
    }
    values.set(gate.id, value);
  }

  for (const [wireId, value] of overrides) {
    if (!values.has(wireId)) throw new Error(`override names no circuit wire: ${wireId}`);
    values.set(wireId, mod(value));
  }

  const valueAt = (wireId: number | null): Fp => wireId === null ? 0n : values.get(wireId)!;
  return {
    a: rows.map((row) => valueAt(row.a)),
    b: rows.map((row) => valueAt(row.b)),
    c: rows.map((row) => valueAt(row.c)),
  };
}
