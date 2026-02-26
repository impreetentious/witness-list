/**
 * Zero-knowledge mode: blinding insertion (add Z_H·r to committed polys,
 * deg r = QUERIES+1) and the transcript simulator for the ZK tab.
 * M8. Gate Z13.
 * Wording is load-bearing: the simulator is an "illustration of the ZK
 * definition, not a formal proof" — keep that label.
 */
import type { Fp } from './field';
import type { Poly } from './poly';
import type { Params, TranscriptEntry } from './types';

export function blind(_p: Poly, _n: number, _params: Params, _rand: () => Fp): Poly {
  throw new Error('TODO(M8): add Z_H(x)·r(x)');
}

/** Fake transcript for a true public statement, generated without any witness. */
export function simulateTranscript(_params: Params, _seed: number): Promise<TranscriptEntry[]> {
  throw new Error('TODO(M8): sample openings backwards from a satisfied identity');
}
