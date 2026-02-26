/**
 * Checklist-shaped verifier: returns per-check results (V1–V7), never a bare
 * boolean — the checklist is both the UI and the negative-test oracle.
 * M4 (V1–V2) + M5 (V3–V7).
 */
import type { CompiledCircuit } from '../circuit/compile';
import type { Proof, VerifyResult } from '../types';

export function verify(_cc: CompiledCircuit, _proof: Proof): Promise<VerifyResult> {
  throw new Error('TODO(M4/M5): checks V1–V7');
}
