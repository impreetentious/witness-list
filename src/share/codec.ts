/**
 * Versioned share payload codec. The short `#p=` path uses browser-native
 * deflate-raw when available; `#pu=` is an always-available uncompressed
 * fallback. docs/PROTOCOL-SPEC.md §8, gate Z14.
 */
import type { Circuit, Gate, GateOp } from '../zk/circuit/ir';
import { P } from '../zk/field';
import type { Fp } from '../zk/field';
import { fp2 } from '../zk/fp2';
import type { Fp2 } from '../zk/fp2';
import type {
  AnyProof,
  MerklePath,
  MerkleRoot,
  Proof,
  ProofV1,
  QueryOpening,
  QueryOpeningV1,
} from '../zk/types';

export interface SharePayload {
  circuit: Circuit;
  publicInputs: Fp[];
  proof: AnyProof;
}

interface EncodedPath {
  leafIndex: number;
  siblings: string[];
}

interface EncodedQueryV1 {
  index: number;
  leaves: Record<string, string[]>;
  paths: Record<string, EncodedPath>;
  friLayers: { at: string; sibling: string; atPath: EncodedPath; siblingPath: EncodedPath }[];
  finalLayer: { value: string; path: EncodedPath };
}

interface EncodedFp2 {
  c0: string;
  c1: string;
}

interface EncodedQuery {
  index: number;
  leaves: Record<string, string[]>;
  paths: Record<string, EncodedPath>;
  friLayers: {
    at: EncodedFp2;
    sibling: EncodedFp2;
    atPath: EncodedPath;
    siblingPath: EncodedPath;
  }[];
  finalLayer: { value: EncodedFp2; path: EncodedPath };
}

interface EncodedProofV1 {
  version: 1;
  params: Proof['params'];
  circuitDigest: string;
  publicInputs: string[];
  wiresRoot: string;
  zRoot: string;
  tRoots: string[];
  openings: { label: string; value: string }[];
  friLayerRoots: string[];
  friFinalCoeffs: string[];
  grindingNonce?: number;
  queries: EncodedQueryV1[];
}

interface EncodedProof {
  version: 2;
  params: Proof['params'];
  circuitDigest: string;
  publicInputs: string[];
  wiresRoot: string;
  zRoot: string;
  tRoots: string[];
  lookupRoots?: {
    mode: 'membership' | 'multiset';
    h1Root?: string;
    h2Root?: string;
    zRoot: string;
  };
  openings: { label: string; value: EncodedFp2 }[];
  friLayerRoots: string[];
  friFinalCoeffs: EncodedFp2[];
  grindingNonce?: number;
  queries: EncodedQuery[];
}

interface EncodedPayload {
  version: 1;
  circuit: {
    name: string;
    gates: {
      id: number;
      op: GateOp;
      inputs: number[];
      value?: string;
      pos?: { x: number; y: number };
    }[];
    publicOrder: number[];
    provenance?: Circuit['provenance'];
    lookupTable?: string[];
    lookupMode?: Circuit['lookupMode'];
    lookupTableTags?: string[];
  };
  publicInputs: string[];
  proof: EncodedProofV1 | EncodedProof;
}

const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const MAX_ENCODED_CHARACTERS = 4_000_000;
const MAX_DECOMPRESSED_BYTES = 8_000_000;

function bytesToBase64Url(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const hasB = index + 1 < bytes.length;
    const hasC = index + 2 < bytes.length;
    const b = hasB ? bytes[index + 1]! : 0;
    const c = hasC ? bytes[index + 2]! : 0;
    output += base64UrlAlphabet[a >> 2]!;
    output += base64UrlAlphabet[((a & 0x03) << 4) | (b >> 4)]!;
    if (hasB) output += base64UrlAlphabet[((b & 0x0f) << 2) | (c >> 6)]!;
    if (hasC) output += base64UrlAlphabet[c & 0x3f]!;
  }
  return output;
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('share payload is not base64url');
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const a = base64UrlAlphabet.indexOf(value[index]!);
    const b = base64UrlAlphabet.indexOf(value[index + 1]!);
    const c = index + 2 < value.length ? base64UrlAlphabet.indexOf(value[index + 2]!) : 0;
    const d = index + 3 < value.length ? base64UrlAlphabet.indexOf(value[index + 3]!) : 0;
    if (a < 0 || b < 0 || c < 0 || d < 0)
      throw new Error('share payload contains an invalid base64url symbol');
    bytes.push((a << 2) | (b >> 4));
    if (index + 2 < value.length) bytes.push(((b & 0x0f) << 4) | (c >> 2));
    if (index + 3 < value.length) bytes.push(((c & 0x03) << 6) | d);
  }
  return Uint8Array.from(bytes);
}

function encodeRoot(root: MerkleRoot): string {
  return bytesToBase64Url(root.bytes);
}

function decodeRoot(value: string): MerkleRoot {
  const bytes = base64UrlToBytes(value);
  if (bytes.length !== 32) throw new Error('Merkle root must be 32 bytes');
  return { bytes };
}

function encodePath(path: MerklePath): EncodedPath {
  return { leafIndex: path.leafIndex, siblings: path.siblings.map(bytesToBase64Url) };
}

function decodePath(path: EncodedPath): MerklePath {
  if (
    !Number.isSafeInteger(path.leafIndex) ||
    path.leafIndex < 0 ||
    path.leafIndex > 0xffffffff ||
    !Array.isArray(path.siblings) ||
    path.siblings.length > 32
  ) {
    throw new Error('invalid Merkle path');
  }
  const siblings = path.siblings.map(base64UrlToBytes);
  if (siblings.some((sibling) => sibling.length !== 32))
    throw new Error('Merkle sibling must be 32 bytes');
  return { leafIndex: path.leafIndex, siblings };
}

function encodeQueryV1(query: QueryOpeningV1): EncodedQueryV1 {
  return {
    index: query.index,
    leaves: Object.fromEntries(
      Object.entries(query.leaves).map(([label, values]) => [label, values.map(String)]),
    ),
    paths: Object.fromEntries(
      Object.entries(query.paths).map(([label, path]) => [label, encodePath(path)]),
    ),
    friLayers: query.friLayers.map((layer) => ({
      at: layer.at.toString(),
      sibling: layer.sibling.toString(),
      atPath: encodePath(layer.atPath),
      siblingPath: encodePath(layer.siblingPath),
    })),
    finalLayer: {
      value: query.finalLayer.value.toString(),
      path: encodePath(query.finalLayer.path),
    },
  };
}

function encodeFp2(value: Fp2): EncodedFp2 {
  return { c0: value.c0.toString(), c1: value.c1.toString() };
}

function encodeQuery(query: QueryOpening): EncodedQuery {
  return {
    index: query.index,
    leaves: Object.fromEntries(
      Object.entries(query.leaves).map(([label, values]) => [label, values.map(String)]),
    ),
    paths: Object.fromEntries(
      Object.entries(query.paths).map(([label, path]) => [label, encodePath(path)]),
    ),
    friLayers: query.friLayers.map((layer) => ({
      at: encodeFp2(layer.at),
      sibling: encodeFp2(layer.sibling),
      atPath: encodePath(layer.atPath),
      siblingPath: encodePath(layer.siblingPath),
    })),
    finalLayer: {
      value: encodeFp2(query.finalLayer.value),
      path: encodePath(query.finalLayer.path),
    },
  };
}

function decodeFp(value: string): Fp {
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new Error('field element is not an unsigned decimal integer');
  const decoded = BigInt(value);
  if (decoded >= P) throw new Error('field element is outside the canonical field range');
  return decoded;
}

function decodeFp2(value: EncodedFp2): Fp2 {
  return fp2(decodeFp(value.c0), decodeFp(value.c1));
}

/**
 * Proof parameters arrive from a URL like everything else here, so they get the
 * same treatment as field elements and roots. `verify` re-checks them against
 * the compiled circuit; this only guarantees the app never renders a shape it
 * cannot reason about (an absent `n`, a negative query count) while reporting
 * why a shared proof failed.
 */
function decodeParams(params: unknown): Proof['params'] {
  const { n, blowup, queries, zk, grindingBits } = (params ?? {}) as Partial<Proof['params']>;
  const positive = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
  if (
    !positive(n) ||
    !positive(blowup) ||
    !positive(queries) ||
    typeof zk !== 'boolean' ||
    (grindingBits !== undefined &&
      (!Number.isSafeInteger(grindingBits) || grindingBits < 0 || grindingBits > 24))
  ) {
    throw new Error('share payload has invalid proof parameters');
  }
  return { n, blowup, queries, zk, ...(grindingBits === undefined ? {} : { grindingBits }) };
}

function decodeQueryV1(query: EncodedQueryV1): QueryOpeningV1 {
  if (!Number.isSafeInteger(query.index) || query.index < 0) throw new Error('invalid query index');
  return {
    index: query.index,
    leaves: Object.fromEntries(
      Object.entries(query.leaves).map(([label, values]) => [label, values.map(decodeFp)]),
    ),
    paths: Object.fromEntries(
      Object.entries(query.paths).map(([label, path]) => [label, decodePath(path)]),
    ),
    friLayers: query.friLayers.map((layer) => ({
      at: decodeFp(layer.at),
      sibling: decodeFp(layer.sibling),
      atPath: decodePath(layer.atPath),
      siblingPath: decodePath(layer.siblingPath),
    })),
    finalLayer: {
      value: decodeFp(query.finalLayer.value),
      path: decodePath(query.finalLayer.path),
    },
  };
}

function decodeQuery(query: EncodedQuery): QueryOpening {
  if (!Number.isSafeInteger(query.index) || query.index < 0) throw new Error('invalid query index');
  return {
    index: query.index,
    leaves: Object.fromEntries(
      Object.entries(query.leaves).map(([label, values]) => [label, values.map(decodeFp)]),
    ),
    paths: Object.fromEntries(
      Object.entries(query.paths).map(([label, path]) => [label, decodePath(path)]),
    ),
    friLayers: query.friLayers.map((layer) => ({
      at: decodeFp2(layer.at),
      sibling: decodeFp2(layer.sibling),
      atPath: decodePath(layer.atPath),
      siblingPath: decodePath(layer.siblingPath),
    })),
    finalLayer: {
      value: decodeFp2(query.finalLayer.value),
      path: decodePath(query.finalLayer.path),
    },
  };
}

function encodePayload(payload: SharePayload): EncodedPayload {
  const proof =
    payload.proof.version === 1
      ? {
          version: 1 as const,
          params: { ...payload.proof.params },
          circuitDigest: bytesToBase64Url(payload.proof.circuitDigest),
          publicInputs: payload.proof.publicInputs.map(String),
          wiresRoot: encodeRoot(payload.proof.wiresRoot),
          zRoot: encodeRoot(payload.proof.zRoot),
          tRoots: payload.proof.tRoots.map(encodeRoot),
          openings: payload.proof.openings.map((opening) => ({
            label: opening.label,
            value: opening.value.toString(),
          })),
          friLayerRoots: payload.proof.friLayerRoots.map(encodeRoot),
          friFinalCoeffs: payload.proof.friFinalCoeffs.map(String),
          ...(payload.proof.grindingNonce === undefined
            ? {}
            : { grindingNonce: payload.proof.grindingNonce }),
          queries: payload.proof.queries.map(encodeQueryV1),
        }
      : {
          version: 2 as const,
          params: { ...payload.proof.params },
          circuitDigest: bytesToBase64Url(payload.proof.circuitDigest),
          publicInputs: payload.proof.publicInputs.map(String),
          wiresRoot: encodeRoot(payload.proof.wiresRoot),
          zRoot: encodeRoot(payload.proof.zRoot),
          tRoots: payload.proof.tRoots.map(encodeRoot),
          ...(payload.proof.lookupRoots === undefined
            ? {}
            : {
                lookupRoots: {
                  mode: payload.proof.lookupRoots.mode,
                  ...(payload.proof.lookupRoots.h1Root === undefined
                    ? {}
                    : { h1Root: encodeRoot(payload.proof.lookupRoots.h1Root) }),
                  ...(payload.proof.lookupRoots.h2Root === undefined
                    ? {}
                    : { h2Root: encodeRoot(payload.proof.lookupRoots.h2Root) }),
                  zRoot: encodeRoot(payload.proof.lookupRoots.zRoot),
                },
              }),
          openings: payload.proof.openings.map((opening) => ({
            label: opening.label,
            value: encodeFp2(opening.value),
          })),
          friLayerRoots: payload.proof.friLayerRoots.map(encodeRoot),
          friFinalCoeffs: payload.proof.friFinalCoeffs.map(encodeFp2),
          ...(payload.proof.grindingNonce === undefined
            ? {}
            : { grindingNonce: payload.proof.grindingNonce }),
          queries: payload.proof.queries.map(encodeQuery),
        };
  return {
    version: 1,
    circuit: {
      name: payload.circuit.name,
      gates: payload.circuit.gates.map((gate) => ({
        id: gate.id,
        op: gate.op,
        inputs: gate.inputs.slice(),
        value: gate.value?.toString(),
        pos: gate.pos === undefined ? undefined : { ...gate.pos },
      })),
      publicOrder: payload.circuit.publicOrder.slice(),
      ...(payload.circuit.provenance === undefined
        ? {}
        : { provenance: { ...payload.circuit.provenance } }),
      ...(payload.circuit.lookupTable === undefined
        ? {}
        : { lookupTable: payload.circuit.lookupTable.map(String) }),
      ...(payload.circuit.lookupMode === undefined
        ? {}
        : { lookupMode: payload.circuit.lookupMode }),
      ...(payload.circuit.lookupTableTags === undefined
        ? {}
        : { lookupTableTags: payload.circuit.lookupTableTags.map(String) }),
    },
    publicInputs: payload.publicInputs.map(String),
    proof,
  };
}

function decodePayload(encoded: EncodedPayload): SharePayload {
  if (encoded.version !== 1 || (encoded.proof.version !== 1 && encoded.proof.version !== 2))
    throw new Error('unsupported share payload version');
  if (!Array.isArray(encoded.circuit.gates) || !Array.isArray(encoded.circuit.publicOrder))
    throw new Error('invalid circuit payload');
  const gates: Gate[] = encoded.circuit.gates.map((gate) => ({
    id: gate.id,
    op: gate.op,
    inputs: gate.inputs.slice(),
    value: gate.value === undefined ? undefined : BigInt(gate.value),
    pos: gate.pos === undefined ? undefined : { ...gate.pos },
  }));
  const proof: AnyProof =
    encoded.proof.version === 1
      ? ({
          version: 1,
          params: decodeParams(encoded.proof.params),
          circuitDigest: base64UrlToBytes(encoded.proof.circuitDigest),
          publicInputs: encoded.proof.publicInputs.map(decodeFp),
          wiresRoot: decodeRoot(encoded.proof.wiresRoot),
          zRoot: decodeRoot(encoded.proof.zRoot),
          tRoots: encoded.proof.tRoots.map(decodeRoot),
          openings: encoded.proof.openings.map((opening) => ({
            label: opening.label,
            value: decodeFp(opening.value),
          })),
          friLayerRoots: encoded.proof.friLayerRoots.map(decodeRoot),
          friFinalCoeffs: encoded.proof.friFinalCoeffs.map(decodeFp),
          ...(encoded.proof.grindingNonce === undefined
            ? {}
            : { grindingNonce: encoded.proof.grindingNonce }),
          queries: encoded.proof.queries.map(decodeQueryV1),
        } satisfies ProofV1)
      : ({
          version: 2,
          params: decodeParams(encoded.proof.params),
          circuitDigest: base64UrlToBytes(encoded.proof.circuitDigest),
          publicInputs: encoded.proof.publicInputs.map(decodeFp),
          wiresRoot: decodeRoot(encoded.proof.wiresRoot),
          zRoot: decodeRoot(encoded.proof.zRoot),
          tRoots: encoded.proof.tRoots.map(decodeRoot),
          ...(encoded.proof.lookupRoots === undefined
            ? {}
            : {
                lookupRoots: {
                  mode: encoded.proof.lookupRoots.mode,
                  ...(encoded.proof.lookupRoots.h1Root === undefined
                    ? {}
                    : { h1Root: decodeRoot(encoded.proof.lookupRoots.h1Root) }),
                  ...(encoded.proof.lookupRoots.h2Root === undefined
                    ? {}
                    : { h2Root: decodeRoot(encoded.proof.lookupRoots.h2Root) }),
                  zRoot: decodeRoot(encoded.proof.lookupRoots.zRoot),
                },
              }),
          openings: encoded.proof.openings.map((opening) => ({
            label: opening.label,
            value: decodeFp2(opening.value),
          })),
          friLayerRoots: encoded.proof.friLayerRoots.map(decodeRoot),
          friFinalCoeffs: encoded.proof.friFinalCoeffs.map(decodeFp2),
          ...(encoded.proof.grindingNonce === undefined
            ? {}
            : { grindingNonce: encoded.proof.grindingNonce }),
          queries: encoded.proof.queries.map(decodeQuery),
        } satisfies Proof);
  if (proof.circuitDigest.length !== 32) throw new Error('circuit digest must be 32 bytes');
  const provenance = encoded.circuit.provenance;
  if (
    provenance !== undefined &&
    (provenance.kind !== 'witness-script' || typeof provenance.source !== 'string')
  ) {
    throw new Error('invalid circuit provenance');
  }
  const publicInputs = encoded.publicInputs.map(decodeFp);
  if (
    publicInputs.length !== encoded.circuit.publicOrder.length ||
    publicInputs.length !== proof.publicInputs.length ||
    publicInputs.some((value, index) => value !== proof.publicInputs[index])
  ) {
    throw new Error('shared public inputs do not match the proof statement');
  }
  return {
    circuit: {
      name: encoded.circuit.name,
      gates,
      publicOrder: encoded.circuit.publicOrder.slice(),
      ...(provenance === undefined ? {} : { provenance: { ...provenance } }),
      ...(encoded.circuit.lookupTable === undefined
        ? {}
        : { lookupTable: encoded.circuit.lookupTable.map(decodeFp) }),
      ...(encoded.circuit.lookupMode === undefined
        ? {}
        : { lookupMode: encoded.circuit.lookupMode }),
      ...(encoded.circuit.lookupTableTags === undefined
        ? {}
        : { lookupTableTags: encoded.circuit.lookupTableTags.map(decodeFp) }),
    },
    publicInputs,
    proof,
  };
}

async function compress(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof CompressionStream === 'undefined') return undefined;
  try {
    const compressStream = async (): Promise<Uint8Array> => {
      const stream = new CompressionStream('deflate-raw');
      // Begin consuming before writing: TransformStream backpressure otherwise
      // deadlocks some browsers on a large proof URL.
      const compressed = new Response(stream.readable)
        .arrayBuffer()
        .then((buffer) => new Uint8Array(buffer));
      const writer = stream.writable.getWriter();
      const owned = new Uint8Array(bytes.length);
      owned.set(bytes);
      await writer.write(owned);
      await writer.close();
      return compressed;
    };
    // A browser that exposes CompressionStream but never drains it must still
    // produce the interoperable #pu fallback rather than leave Share disabled.
    const fallback = new Promise<undefined>((resolve) =>
      globalThis.setTimeout(() => resolve(undefined), 1_000),
    );
    return await Promise.race([compressStream(), fallback]);
  } catch {
    return undefined;
  }
}

async function decompress(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined')
    throw new Error('this environment cannot decode compressed share URLs');
  const stream = new DecompressionStream('deflate-raw');
  // Begin consuming before writing for the same backpressure reason as encode,
  // and stop before an attacker-controlled compressed fragment can expand
  // without bound in the browser.
  const plain = (async (): Promise<Uint8Array> => {
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DECOMPRESSED_BYTES) {
        await reader.cancel();
        throw new Error('decompressed share payload exceeds the size limit');
      }
      chunks.push(value);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  })();
  const writer = stream.writable.getWriter();
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  const writing = (async (): Promise<void> => {
    await writer.write(owned);
    await writer.close();
  })();
  const [output] = await Promise.all([plain, writing]);
  return output;
}

/** Encode a fragment. `compressPayload=false` explicitly produces the #pu fallback. */
export async function encodeShare(payload: SharePayload, compressPayload = true): Promise<string> {
  const json = JSON.stringify(encodePayload(payload));
  const plain = new TextEncoder().encode(json);
  if (plain.byteLength > MAX_DECOMPRESSED_BYTES)
    throw new Error('share payload exceeds the size limit');
  const compressed = compressPayload ? await compress(plain) : undefined;
  return compressed === undefined
    ? `#pu=${bytesToBase64Url(plain)}`
    : `#p=${bytesToBase64Url(compressed)}`;
}

export async function decodeShare(fragment: string): Promise<SharePayload> {
  if (fragment.length > MAX_ENCODED_CHARACTERS)
    throw new Error('encoded share payload exceeds the size limit');
  const match = /^#(p|pu)=([A-Za-z0-9_-]+)$/.exec(fragment);
  if (match === null) throw new Error('share URL needs a #p= or #pu= payload');
  const bytes = base64UrlToBytes(match[2]!);
  const plain = match[1] === 'p' ? await decompress(bytes) : bytes;
  if (plain.byteLength > MAX_DECOMPRESSED_BYTES)
    throw new Error('share payload exceeds the size limit');
  let encoded: unknown;
  try {
    encoded = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('share payload is not valid JSON');
  }
  return decodePayload(encoded as EncodedPayload);
}
