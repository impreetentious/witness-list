/**
 * docs/PROTOCOL-SPEC.md §4.9 / 2E — Fiat–Shamir grinding deterrent. A prover finds a nonce whose hash with the
 * post-commitment transcript challenge has k leading zero bits; the verifier
 * recomputes that one inexpensive check before deriving FRI query indices.
 */

function nonceBytes(nonce: number): Uint8Array {
  if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce > 0xffffffff)
    throw new Error('grinding nonce must be a u32');
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, nonce, true);
  return bytes;
}

async function hash(challenge: Uint8Array, nonce: number): Promise<Uint8Array> {
  const input = new Uint8Array(challenge.length + 4);
  input.set(challenge);
  input.set(nonceBytes(nonce), challenge.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

export function leadingZeroBits(bytes: Uint8Array): number {
  let total = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      total += 8;
      continue;
    }
    for (let bit = 7; bit >= 0; bit--) {
      if ((byte & (1 << bit)) !== 0) return total;
      total++;
    }
  }
  return total;
}

export function validateGrindingBits(bits: number): void {
  if (!Number.isSafeInteger(bits) || bits < 0 || bits > 24) {
    throw new Error('grinding bits must be an integer between 0 and 24');
  }
}

export async function verifyGrindingNonce(
  challenge: Uint8Array,
  bits: number,
  nonce: number,
): Promise<boolean> {
  validateGrindingBits(bits);
  return bits === 0 || leadingZeroBits(await hash(challenge, nonce)) >= bits;
}

export async function findGrindingNonce(challenge: Uint8Array, bits: number): Promise<number> {
  validateGrindingBits(bits);
  if (bits === 0) return 0;
  for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
    if (await verifyGrindingNonce(challenge, bits, nonce)) return nonce;
  }
  throw new Error('no grinding nonce found in u32 space');
}

export function encodeGrindingNonce(nonce: number): Uint8Array {
  return nonceBytes(nonce);
}
