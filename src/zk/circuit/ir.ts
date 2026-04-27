/** Circuit graph IR + validation. docs/PROTOCOL-SPEC.md §5. */

export type GateOp = 'pub' | 'priv' | 'const' | 'add' | 'mul' | 'assert0' | 'lookup';

export interface Gate {
  id: number;
  op: GateOp;
  /** gate-output ids feeding this gate (arity: inputs 0, const 0, add/mul 2, assert0 1) */
  inputs: number[];
  /** const only */
  value?: bigint;
  /** hand-authored canvas position (presets) */
  pos?: { x: number; y: number };
}

export interface Circuit {
  name: string;
  gates: Gate[];
  /** public-input gate ids in row order (pinned to first ℓ rows) */
  publicOrder: number[];
  /** Optional authoring provenance; when present it is bound into the circuit digest. */
  provenance?: { kind: 'witness-script'; source: string };
  /** One fixed table per teaching circuit; lookup gates constrain their input to it. */
  lookupTable?: bigint[];
  /** Membership is Plookup; multiset additionally binds one tag per query/table entry. */
  lookupMode?: 'membership' | 'multiset';
  lookupTableTags?: bigint[];
}

export type ValidationIssue =
  | { kind: 'cycle'; gateIds: number[] }
  | { kind: 'arity'; gateId: number }
  | { kind: 'constant'; gateId: number }
  | { kind: 'dangling'; gateId: number; input: number }
  | { kind: 'duplicate'; gateId: number }
  | { kind: 'public'; gateId: number }
  | { kind: 'assert-output'; gateId: number; consumer: number }
  | { kind: 'lookup'; gateId: number };

const expectedArity: Record<GateOp, number> = {
  pub: 0,
  priv: 0,
  const: 0,
  add: 2,
  mul: 2,
  assert0: 1,
  lookup: 1,
};

/** Validate graph shape before the compiler performs its deterministic toposort. */
export function validate(c: Circuit): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const gatesById = new Map<number, Gate>();
  for (const gate of c.gates) {
    if (gatesById.has(gate.id)) issues.push({ kind: 'duplicate', gateId: gate.id });
    else gatesById.set(gate.id, gate);
    if (gate.inputs.length !== expectedArity[gate.op])
      issues.push({ kind: 'arity', gateId: gate.id });
    if (gate.op === 'const' && gate.value === undefined)
      issues.push({ kind: 'constant', gateId: gate.id });
    if (gate.op === 'lookup' && (c.lookupTable === undefined || c.lookupTable.length === 0))
      issues.push({ kind: 'lookup', gateId: gate.id });
  }
  if (c.lookupTable !== undefined) {
    const canonical = new Set(c.lookupTable.map(String));
    if (
      c.lookupTable.length === 0 ||
      (c.lookupMode !== 'multiset' && canonical.size !== c.lookupTable.length)
    )
      issues.push({ kind: 'lookup', gateId: -1 });
  }
  if (c.lookupMode === 'multiset' && c.lookupTableTags?.length !== c.lookupTable?.length)
    issues.push({ kind: 'lookup', gateId: -1 });

  const publicIds = new Set<number>();
  for (const gateId of c.publicOrder) {
    if (publicIds.has(gateId) || gatesById.get(gateId)?.op !== 'pub') {
      issues.push({ kind: 'public', gateId });
    }
    publicIds.add(gateId);
  }
  for (const gate of c.gates) {
    if (gate.op === 'pub' && !publicIds.has(gate.id))
      issues.push({ kind: 'public', gateId: gate.id });
  }

  for (const gate of c.gates) {
    for (const input of gate.inputs) {
      const producer = gatesById.get(input);
      if (producer === undefined) issues.push({ kind: 'dangling', gateId: gate.id, input });
      else if (producer.op === 'assert0' || producer.op === 'lookup') {
        // An assert row has no constrained output slot. Treat it as a terminal statement,
        // rather than silently introducing an unconstrained wire into the circuit.
        issues.push({ kind: 'assert-output', gateId: input, consumer: gate.id });
      }
    }
  }

  const state = new Map<number, 'visiting' | 'done'>();
  const stack: number[] = [];
  const seenCycles = new Set<string>();
  function visit(gateId: number): void {
    if (state.get(gateId) === 'done') return;
    if (state.get(gateId) === 'visiting') {
      const start = stack.indexOf(gateId);
      const cycle = [...stack.slice(start), gateId];
      const key = cycle.join(',');
      if (!seenCycles.has(key)) {
        issues.push({ kind: 'cycle', gateIds: cycle });
        seenCycles.add(key);
      }
      return;
    }
    const gate = gatesById.get(gateId);
    if (gate === undefined) return;
    state.set(gateId, 'visiting');
    stack.push(gateId);
    for (const input of gate.inputs) visit(input);
    stack.pop();
    state.set(gateId, 'done');
  }
  for (const gate of c.gates) visit(gate.id);

  return issues;
}
