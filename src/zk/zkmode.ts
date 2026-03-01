/**
 * Zero-knowledge mode: blinding insertion (add Z_H·r to committed polys,
 * deg r = QUERIES+1) and the transcript simulator for the ZK tab.
 * M8. Gate Z13.
 * Wording is load-bearing: the simulator is an "illustration of the ZK
 * definition, not a formal proof" — keep that label.
 */
import type { Fp } from './field';
import { polyAdd, polyMul, vanishing } from './poly';
import type { Poly } from './poly';
import type { Params, TranscriptEntry } from './types';
import { createTranscript } from './transcript';

export function blind(p: Poly, n: number, params: Params, rand: () => Fp): Poly {
  if (!params.zk) return p.slice();
  if (!Number.isSafeInteger(n) || n < 1 || (n & (n - 1)) !== 0) {
    throw new Error('blinding domain size must be a positive power of two');
  }
  // deg r = QUERIES + 1 gives Q+1-wise independence for the off-trace openings.
  const r = Array.from({ length: params.queries + 2 }, rand);
  return polyAdd(p, polyMul(vanishing(n), r));
}

function paramsBytes(params: Params): Uint8Array {
  const bytes = new Uint8Array(13);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, params.n, true);
  view.setUint32(4, params.blowup, true);
  view.setUint32(8, params.queries, true);
  bytes[12] = params.zk ? 1 : 0;
  return bytes;
}

/** Deterministic mulberry32 lanes, joined into a field-sized teaching sample. */
function seededFieldSource(seed: number): () => Fp {
  let state = seed >>> 0;
  const nextU32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
  return () => (BigInt(nextU32()) << 32n) | BigInt(nextU32());
}

/**
 * A deterministic no-witness transcript illustration for the ZK tab. It
 * samples opening-shaped field elements and absorbs them under distinct labels;
 * it is deliberately not a verifier-valid simulated proof, because that would
 * need the full public statement and backwards construction of V2–V6.
 */
export async function simulateTranscript(params: Params, seed: number): Promise<TranscriptEntry[]> {
  const transcript = createTranscript('witness-list/zk-simulator/illustration');
  await transcript.absorb('params', paramsBytes(params));
  const seedBytes = new Uint8Array(4);
  new DataView(seedBytes.buffer).setUint32(0, seed >>> 0, true);
  await transcript.absorb('illustration-seed', seedBytes);
  const sample = seededFieldSource(seed);
  for (const label of ['wire-opening', 'z-opening', 'quotient-opening', 'fri-final-value']) {
    await transcript.absorbFp(`simulated-${label}`, sample());
    await transcript.squeezeFp(`simulated-${label}-challenge`);
  }
  return transcript.log;
}
