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

export function buildTree(_leaves: Fp[][], _domainSep: string): Promise<MerkleTree> {
  throw new Error('TODO(M2)');
}

export function verifyPath(
  _root: MerkleRoot,
  _leaf: Fp[],
  _path: MerklePath,
  _domainSep: string,
): Promise<boolean> {
  throw new Error('TODO(M2)');
}
