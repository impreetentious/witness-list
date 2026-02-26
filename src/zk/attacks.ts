/**
 * The three canned malicious provers — shared verbatim between the cheat-mode UI
 * and the negative test suite (Z9): the demo IS the test. M5.
 *
 * A1 tamperWitness  -> caught by V2 (identity at ζ) — after the stage-8 remainder banner
 * A2 tamperLeaf     -> caught by V3 (Merkle path) at a specific query
 * A3 grindChallenge -> statistics: succeeds ~2^bits attempts vs weakened verifier (Z12)
 */
import type { Fp } from './field';
import type { Circuit } from './circuit/ir';
import type { Params, ProofTrace } from './types';

export function tamperWitness(
  _c: Circuit,
  _inputs: Map<number, Fp>,
  _overrides: Map<number, Fp>,
  _params: Params,
  _seed: number,
): Promise<ProofTrace> {
  throw new Error('TODO(M5): honest pipeline over tampered witness, forced past remainder check');
}

export function tamperLeaf(_trace: ProofTrace, _leafIndex: number): ProofTrace {
  throw new Error('TODO(M5): post-commit leaf edit');
}

export function grindChallenge(
  _c: Circuit,
  _inputs: Map<number, Fp>,
  _weakQueries: number,
  _maxAttempts: number,
): Promise<{ attempts: number; succeeded: boolean }> {
  throw new Error('TODO(M5): seed retry loop vs weakened verifier, attempt counter for the UI');
}
