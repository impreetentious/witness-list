/**
 * Protocol data types — the Proof (what the verifier sees) vs the ProofTrace
 * (Proof + every intermediate artifact, for the player).
 * The separation is the pedagogy: the UI's "what the verifier actually sees"
 * toggle greys out everything not in Proof.
 */
import type { Fp } from './field';

export interface Params {
  /** trace rows, power of two */
  n: number;
  /** LDE blowup (v1: 8) */
  blowup: number;
  /** FRI queries (v1: 32) */
  queries: number;
  /** ZK blinding on/off */
  zk: boolean;
}

export interface MerkleRoot {
  bytes: Uint8Array; // 32
}

export interface MerklePath {
  leafIndex: number;
  siblings: Uint8Array[]; // bottom-up
}

export interface QueryOpening {
  index: number; // position in D_0
  /** composite wire leaf (a,b,c) + Z + t-chunk leaves at index (and FRI sibling positions) */
  leaves: Record<string, Fp[]>;
  paths: Record<string, MerklePath>;
  /**
   * Per non-final FRI layer, the canonical x/-x pair and both authenticated
   * paths. A Merkle sibling hash is not an opening of the sibling value, so
   * both paths are necessary for the fold check.
   */
  friLayers: {
    at: Fp;
    sibling: Fp;
    atPath: MerklePath;
    siblingPath: MerklePath;
  }[];
  /** Authenticated final-layer value, checked against the clear degree-<8 polynomial. */
  finalLayer: { value: Fp; path: MerklePath };
}

export interface Proof {
  version: 1;
  params: Params;
  circuitDigest: Uint8Array;
  publicInputs: Fp[];
  wiresRoot: MerkleRoot;
  zRoot: MerkleRoot;
  tRoots: MerkleRoot[]; // t_lo, t_mid, t_hi
  /** claimed evaluations at ζ (and Z at ωζ) in fixed order */
  openings: { label: string; value: Fp }[];
  friLayerRoots: MerkleRoot[];
  friFinalCoeffs: Fp[]; // deg < 8
  queries: QueryOpening[];
}

export type CheckId = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7';

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  /** human sentence + the live numbers, for the checklist UI */
  detail: string;
  /** where it broke (query index, row, layer) when !ok */
  locus?: { query?: number; row?: number; layer?: number };
}

export interface VerifyResult {
  ok: boolean;
  checks: CheckResult[];
}

export interface TranscriptEntry {
  kind: 'absorb' | 'squeeze';
  label: string;
  bytes?: Uint8Array;
  value?: Fp;
}

/** Everything the player renders. Proof ⊂ ProofTrace, structurally. */
export interface ProofTrace {
  proof: Proof;
  transcript: TranscriptEntry[];
  /** stage payloads keyed by player stage id */
  stages: Record<string, unknown>;
  /** quotient remainder per row — zero iff honest; the cheat-mode red rows */
  quotientRemainder: Fp[];
}
