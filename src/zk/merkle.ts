/**
 * SHA-256 Merkle tree over LDE evaluations (WebCrypto, async). M2.
 * Leaf i = H(domainSep ‖ i ‖ eval bytes LE). Wire polys share composite leaves (a‖b‖c).
 */
import type { Fp } from './field';
import type { MerklePath, MerkleRoot } from './types';

export interface MerkleTree {
  root: MerkleRoot;
  depth: number;
  path(leafIndex: number): MerklePath;
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

/** The proof wire format encodes field values as fixed-width, unsigned little-endian bytes. */
function fpBytes(value: Fp): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n || value < 0n) throw new Error('Merkle leaf contains a non-field value');
  return bytes;
}

function u32le(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`Merkle index ${value} cannot be encoded as u32`);
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

async function hash(bytes: Uint8Array): Promise<Uint8Array> {
  // WebCrypto's current typings require an ArrayBuffer-backed view (not a
  // possibly SharedArrayBuffer-backed Uint8Array), so make that ownership explicit.
  const input = new Uint8Array(bytes.length);
  input.set(bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

async function hashLeaf(leaf: Fp[], leafIndex: number, domainSep: string): Promise<Uint8Array> {
  return hash(
    concatBytes([
      encoder.encode(domainSep),
      u32le(leafIndex),
      ...leaf.map((value) => fpBytes(value)),
    ]),
  );
}

async function hashNode(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return hash(concatBytes([left, right]));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function assertLeafCount(leafCount: number): void {
  if (!Number.isSafeInteger(leafCount) || leafCount < 1 || (leafCount & (leafCount - 1)) !== 0) {
    throw new Error('Merkle tree needs a non-empty power-of-two number of leaves');
  }
}

export async function buildTree(leaves: Fp[][], domainSep: string): Promise<MerkleTree> {
  assertLeafCount(leaves.length);
  const levels: Uint8Array[][] = [
    await Promise.all(leaves.map((leaf, index) => hashLeaf(leaf, index, domainSep))),
  ];

  while (levels[levels.length - 1]!.length > 1) {
    const previous = levels[levels.length - 1]!;
    const parents = new Array<Uint8Array>(previous.length >> 1);
    for (let i = 0; i < previous.length; i += 2) {
      parents[i >> 1] = await hashNode(previous[i]!, previous[i + 1]!);
    }
    levels.push(parents);
  }

  return {
    root: { bytes: levels[levels.length - 1]![0]!.slice() },
    depth: levels.length - 1,
    path(leafIndex: number): MerklePath {
      if (!Number.isSafeInteger(leafIndex) || leafIndex < 0 || leafIndex >= leaves.length) {
        throw new Error(`Merkle leaf ${leafIndex} is outside this tree`);
      }
      let index = leafIndex;
      const siblings: Uint8Array[] = [];
      for (let layer = 0; layer < levels.length - 1; layer++) {
        siblings.push(levels[layer]![index ^ 1]!.slice());
        index >>= 1;
      }
      return { leafIndex, siblings };
    },
  };
}

export async function verifyPath(
  root: MerkleRoot,
  leaf: Fp[],
  path: MerklePath,
  domainSep: string,
): Promise<boolean> {
  if (!Number.isSafeInteger(path.leafIndex) || path.leafIndex < 0 || root.bytes.length !== 32) {
    return false;
  }
  let current = await hashLeaf(leaf, path.leafIndex, domainSep);
  let index = path.leafIndex;
  for (const sibling of path.siblings) {
    if (sibling.length !== 32) return false;
    current = (index & 1) === 0
      ? await hashNode(current, sibling)
      : await hashNode(sibling, current);
    index >>= 1;
  }
  return sameBytes(current, root.bytes);
}
