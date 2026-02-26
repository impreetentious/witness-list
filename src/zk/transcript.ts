/**
 * Fiat–Shamir transcript: SHA-256 hash chain, domain-separated labels,
 * rejection-sampled field draws, logged for the timeline UI. M2.
 * Gate Z10 freezes the byte format via a golden proof fixture.
 */
import type { Fp } from './field';
import type { TranscriptEntry } from './types';

export interface Transcript {
  absorb(label: string, bytes: Uint8Array): Promise<void>;
  absorbFp(label: string, x: Fp): Promise<void>;
  /** uniform field element via 8-byte LE draws with rejection ≥ p */
  squeezeFp(label: string): Promise<Fp>;
  /** query index draws: 4 bytes mod domainSize (bias 2^-32, displayed in-app) */
  squeezeIndex(label: string, domainSize: number): Promise<number>;
  readonly log: TranscriptEntry[];
}

export function createTranscript(_protocolTag: string): Transcript {
  throw new Error('TODO(M2)');
}
