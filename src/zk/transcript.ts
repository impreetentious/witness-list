/**
 * Fiat–Shamir transcript: SHA-256 hash chain, domain-separated labels,
 * rejection-sampled field draws, logged for the timeline UI. M2.
 * Gate Z10 freezes the byte format via a golden proof fixture.
 */
import { P } from './field';
import type { Fp } from './field';
import type { Fp2 } from './fp2';
import { fp2 } from './fp2';
import type { TranscriptEntry } from './types';

export interface Transcript {
  absorb(label: string, bytes: Uint8Array): Promise<void>;
  absorbFp(label: string, x: Fp): Promise<void>;
  absorbFp2(label: string, x: Fp2): Promise<void>;
  /** uniform field element via 8-byte LE draws with rejection ≥ p */
  squeezeFp(label: string): Promise<Fp>;
  /** Uniform extension element from two independently rejection-sampled limbs. */
  squeezeFp2(label: string): Promise<Fp2>;
  /** query index draws: 4 bytes mod domainSize (bias 2^-32, displayed in-app) */
  squeezeIndex(label: string, domainSize: number): Promise<number>;
  /** Transcript-bound digest used by the optional anti-grinding proof of work. */
  workDigest(label: string): Promise<Uint8Array>;
  readonly log: TranscriptEntry[];
}

const encoder = new TextEncoder();

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function u64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function fpBytes(value: Fp): Uint8Array {
  if (value < 0n || value >= P) throw new Error('transcript absorbed a non-field value');
  return u64le(value);
}

function fromLittleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
  return value;
}

async function hash(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(bytes.length);
  input.set(bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

export function createTranscript(protocolTag: string): Transcript {
  const protocolBytes = encoder.encode(protocolTag);
  const log: TranscriptEntry[] = [
    { kind: 'absorb', label: 'protocol', bytes: protocolBytes.slice() },
  ];
  let state = hash(concatBytes([encoder.encode('protocol'), protocolBytes]));
  let squeezeCounter = 0n;

  async function absorb(label: string, bytes: Uint8Array): Promise<void> {
    const previous = state;
    const absorbed = bytes.slice();
    state = (async () => hash(concatBytes([await previous, encoder.encode(label), absorbed])))();
    await state;
    log.push({ kind: 'absorb', label, bytes: absorbed });
  }

  async function squeezeBytes(label: string, byteLength: number): Promise<Uint8Array> {
    const current = await state;
    const counter = squeezeCounter++;
    return (
      await hash(
        concatBytes([current, encoder.encode('squeeze'), encoder.encode(label), u64le(counter)]),
      )
    ).slice(0, byteLength);
  }

  return {
    absorb,
    async absorbFp(label: string, value: Fp): Promise<void> {
      await absorb(label, fpBytes(value));
    },
    async absorbFp2(label: string, value: Fp2): Promise<void> {
      await absorb(label, concatBytes([fpBytes(value.c0), fpBytes(value.c1)]));
    },
    async squeezeFp(label: string): Promise<Fp> {
      for (;;) {
        const value = fromLittleEndian(await squeezeBytes(label, 8));
        if (value < P) {
          log.push({ kind: 'squeeze', label, value });
          return value;
        }
      }
    },
    async squeezeFp2(label: string): Promise<Fp2> {
      const limb = async (suffix: string): Promise<Fp> => {
        for (;;) {
          const value = fromLittleEndian(await squeezeBytes(`${label}-${suffix}`, 8));
          if (value < P) return value;
        }
      };
      const value = fp2(await limb('c0'), await limb('c1'));
      log.push({ kind: 'squeeze', label, extensionValue: value });
      return value;
    },
    async squeezeIndex(label: string, domainSize: number): Promise<number> {
      if (!Number.isSafeInteger(domainSize) || domainSize < 1 || domainSize > 0x100000000) {
        throw new Error('squeezeIndex: domain size must be in [1, 2^32]');
      }
      const bytes = await squeezeBytes(label, 4);
      const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        0,
        true,
      );
      log.push({ kind: 'squeeze', label, bytes: bytes.slice() });
      return value % domainSize;
    },
    async workDigest(label: string): Promise<Uint8Array> {
      const current = await state;
      return hash(concatBytes([current, encoder.encode('work'), encoder.encode(label)]));
    },
    get log(): TranscriptEntry[] {
      return log;
    },
  };
}
