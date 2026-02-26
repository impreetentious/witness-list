/** Circuit graph IR + validation. M3 (types now — they anchor the canvas). */

export type GateOp = 'pub' | 'priv' | 'const' | 'add' | 'mul' | 'assert0';

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
}

export type ValidationIssue =
  | { kind: 'cycle'; gateIds: number[] }
  | { kind: 'arity'; gateId: number }
  | { kind: 'dangling'; gateId: number; input: number };

export function validate(_c: Circuit): ValidationIssue[] {
  throw new Error('TODO(M3): toposort-based validation');
}
