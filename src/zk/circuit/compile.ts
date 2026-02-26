/**
 * Circuit graph -> PLONK rows (a,b,c + selectors + σ) and witness generation.
 * M3.
 */
import type { Fp } from '../field';
import type { Circuit } from './ir';

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
}

export interface Witness {
  a: Fp[];
  b: Fp[];
  c: Fp[];
}

export function compile(_c: Circuit): CompiledCircuit {
  throw new Error('TODO(M3): rows/selectors/σ');
}

/**
 * Forward evaluation over the toposort. `overrides` applies AFTER evaluation
 * with no re-propagation — the tamper hook (cheat mode A1).
 */
export function generateWitness(
  _c: Circuit,
  _inputs: Map<number, Fp>,
  _overrides?: Map<number, Fp>,
): Witness {
  throw new Error('TODO(M3)');
}
