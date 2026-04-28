/** docs/PROTOCOL-SPEC.md §12 / 2D — Prover-side Poseidon Merkle tree for workshop-scale field leaves. */
import type { Fp } from './field';
import { poseidonHash } from './poseidon';

export interface PoseidonMerklePath {
  leafIndex: number;
  siblings: Fp[];
}

export interface PoseidonMerkleTree {
  root: Fp;
  leaves: readonly Fp[];
  layers: readonly (readonly Fp[])[];
  open(index: number): PoseidonMerklePath;
}

function validateLeaves(leaves: readonly Fp[]): void {
  if (leaves.length === 0 || (leaves.length & (leaves.length - 1)) !== 0) {
    throw new Error('Poseidon Merkle leaves must have a nonzero power-of-two length');
  }
}

/** Internal-node compression, identical to Witness Script's merkle_path call. */
async function poseidonNodeHash(left: Fp, right: Fp): Promise<Fp> {
  return poseidonHash(left, right);
}

export async function buildPoseidonTree(leaves: readonly Fp[]): Promise<PoseidonMerkleTree> {
  validateLeaves(leaves);
  // Leaves are already field elements; callers may pre-hash structured data.
  const layers: Fp[][] = [leaves.slice()];
  while (layers.at(-1)!.length > 1) {
    const current = layers.at(-1)!;
    layers.push(
      await Promise.all(
        Array.from({ length: current.length / 2 }, (_, index) =>
          poseidonNodeHash(current[index * 2]!, current[index * 2 + 1]!),
        ),
      ),
    );
  }
  return {
    root: layers.at(-1)![0]!,
    leaves: leaves.slice(),
    layers,
    open(index: number): PoseidonMerklePath {
      if (!Number.isSafeInteger(index) || index < 0 || index >= leaves.length)
        throw new Error('Poseidon Merkle opening index out of range');
      let cursor = index;
      const siblings: Fp[] = [];
      for (const layer of layers.slice(0, -1)) {
        siblings.push(layer[cursor ^ 1]!);
        cursor >>= 1;
      }
      return { leafIndex: index, siblings };
    },
  };
}

export async function verifyPoseidonPath(
  root: Fp,
  leaf: Fp,
  path: PoseidonMerklePath,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(path.leafIndex) ||
    path.leafIndex < 0 ||
    path.leafIndex >= 2 ** path.siblings.length
  )
    return false;
  let cursor = path.leafIndex;
  let value = leaf;
  for (const sibling of path.siblings) {
    value =
      (cursor & 1) === 0
        ? await poseidonNodeHash(value, sibling)
        : await poseidonNodeHash(sibling, value);
    cursor >>= 1;
  }
  return value === root;
}
