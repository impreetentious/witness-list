/**
 * Full prover pipeline, rounds 0–5. M4 (rounds 0–4) + M5 (round 5, FRI).
 * Emits ProofTrace (proof + every intermediate) for the player. Runs in the worker.
 * M4 alone is EXPLICITLY UNSOUND (no low-degree test) — label it everywhere.
 */
import type { Fp } from '../field';
import type { CompiledCircuit, Witness } from '../circuit/compile';
import type { Params, ProofTrace } from '../types';

export function prove(
  _cc: CompiledCircuit,
  _w: Witness,
  _publicInputs: Fp[],
  _params: Params,
  _seed: number,
): Promise<ProofTrace> {
  throw new Error('TODO(M4/M5): rounds');
}
