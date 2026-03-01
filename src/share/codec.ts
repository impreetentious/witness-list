/**
 * Versioned share payload codec. The short `#p=` path uses browser-native
 * deflate-raw when available; `#pu=` is an always-available uncompressed
 * fallback. Gate Z14.
 */
import type { Circuit, Gate, GateOp } from '../zk/circuit/ir';
import type { Fp } from '../zk/field';
import type { MerklePath, MerkleRoot, Proof, QueryOpening } from '../zk/types';

export interface SharePayload {
  circuit: Circuit;
  publicInputs: Fp[];
  proof: Proof;
}

interface EncodedPath {
  leafIndex: number;
  siblings: string[];
}

interface EncodedQuery {
  index: number;
  leaves: Record<string, string[]>;
  paths: Record<string, EncodedPath>;
  friLayers: { at: string; sibling: string; atPath: EncodedPath; siblingPath: EncodedPath }[];
  finalLayer: { value: string; path: EncodedPath };
}

interface EncodedProof {
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
  queries: EncodedQuery[];
}

interface EncodedPayload {
  version: 1;
  circuit: { name: string; gates: { id: number; op: GateOp; inputs: number[]; value?: string; pos?: { x: number; y: number } }[]; publicOrder: number[] };
  publicInputs: string[];
  proof: EncodedProof;
}

const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

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
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('share payload contains an invalid base64url symbol');
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
  if (!Number.isSafeInteger(path.leafIndex) || path.leafIndex < 0 || !Array.isArray(path.siblings)) {
    throw new Error('invalid Merkle path');
  }
  const siblings = path.siblings.map(base64UrlToBytes);
  if (siblings.some((sibling) => sibling.length !== 32)) throw new Error('Merkle sibling must be 32 bytes');
  return { leafIndex: path.leafIndex, siblings };
}

function encodeQuery(query: QueryOpening): EncodedQuery {
  return {
    index: query.index,
    leaves: Object.fromEntries(Object.entries(query.leaves).map(([label, values]) => [label, values.map(String)])),
    paths: Object.fromEntries(Object.entries(query.paths).map(([label, path]) => [label, encodePath(path)])),
    friLayers: query.friLayers.map((layer) => ({
      at: layer.at.toString(), sibling: layer.sibling.toString(), atPath: encodePath(layer.atPath), siblingPath: encodePath(layer.siblingPath),
    })),
    finalLayer: { value: query.finalLayer.value.toString(), path: encodePath(query.finalLayer.path) },
  };
}

function decodeFp(value: string): Fp {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('field element is not an unsigned decimal integer');
  return BigInt(value);
}

function decodeQuery(query: EncodedQuery): QueryOpening {
  if (!Number.isSafeInteger(query.index) || query.index < 0) throw new Error('invalid query index');
  return {
    index: query.index,
    leaves: Object.fromEntries(Object.entries(query.leaves).map(([label, values]) => [label, values.map(decodeFp)])),
    paths: Object.fromEntries(Object.entries(query.paths).map(([label, path]) => [label, decodePath(path)])),
    friLayers: query.friLayers.map((layer) => ({
      at: decodeFp(layer.at), sibling: decodeFp(layer.sibling), atPath: decodePath(layer.atPath), siblingPath: decodePath(layer.siblingPath),
    })),
    finalLayer: { value: decodeFp(query.finalLayer.value), path: decodePath(query.finalLayer.path) },
  };
}

function encodePayload(payload: SharePayload): EncodedPayload {
  return {
    version: 1,
    circuit: {
      name: payload.circuit.name,
      gates: payload.circuit.gates.map((gate) => ({
        id: gate.id, op: gate.op, inputs: gate.inputs.slice(), value: gate.value?.toString(), pos: gate.pos === undefined ? undefined : { ...gate.pos },
      })),
      publicOrder: payload.circuit.publicOrder.slice(),
    },
    publicInputs: payload.publicInputs.map(String),
    proof: {
      version: 1,
      params: { ...payload.proof.params },
      circuitDigest: bytesToBase64Url(payload.proof.circuitDigest),
      publicInputs: payload.proof.publicInputs.map(String),
      wiresRoot: encodeRoot(payload.proof.wiresRoot),
      zRoot: encodeRoot(payload.proof.zRoot),
      tRoots: payload.proof.tRoots.map(encodeRoot),
      openings: payload.proof.openings.map((opening) => ({ label: opening.label, value: opening.value.toString() })),
      friLayerRoots: payload.proof.friLayerRoots.map(encodeRoot),
      friFinalCoeffs: payload.proof.friFinalCoeffs.map(String),
      queries: payload.proof.queries.map(encodeQuery),
    },
  };
}

function decodePayload(encoded: EncodedPayload): SharePayload {
  if (encoded.version !== 1 || encoded.proof.version !== 1) throw new Error('unsupported share payload version');
  if (!Array.isArray(encoded.circuit.gates) || !Array.isArray(encoded.circuit.publicOrder)) throw new Error('invalid circuit payload');
  const gates: Gate[] = encoded.circuit.gates.map((gate) => ({
    id: gate.id,
    op: gate.op,
    inputs: gate.inputs.slice(),
    value: gate.value === undefined ? undefined : BigInt(gate.value),
    pos: gate.pos === undefined ? undefined : { ...gate.pos },
  }));
  const proof: Proof = {
    version: 1,
    params: { ...encoded.proof.params },
    circuitDigest: base64UrlToBytes(encoded.proof.circuitDigest),
    publicInputs: encoded.proof.publicInputs.map(decodeFp),
    wiresRoot: decodeRoot(encoded.proof.wiresRoot),
    zRoot: decodeRoot(encoded.proof.zRoot),
    tRoots: encoded.proof.tRoots.map(decodeRoot),
    openings: encoded.proof.openings.map((opening) => ({ label: opening.label, value: decodeFp(opening.value) })),
    friLayerRoots: encoded.proof.friLayerRoots.map(decodeRoot),
    friFinalCoeffs: encoded.proof.friFinalCoeffs.map(decodeFp),
    queries: encoded.proof.queries.map(decodeQuery),
  };
  if (proof.circuitDigest.length !== 32) throw new Error('circuit digest must be 32 bytes');
  return {
    circuit: { name: encoded.circuit.name, gates, publicOrder: encoded.circuit.publicOrder.slice() },
    publicInputs: encoded.publicInputs.map(decodeFp),
    proof,
  };
}

async function compress(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof CompressionStream === 'undefined') return undefined;
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  await writer.write(owned);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

async function decompress(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('this environment cannot decode compressed share URLs');
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  await writer.write(owned);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/** Encode a fragment. `compressPayload=false` explicitly produces the #pu fallback. */
export async function encodeShare(payload: SharePayload, compressPayload = true): Promise<string> {
  const json = JSON.stringify(encodePayload(payload));
  const plain = new TextEncoder().encode(json);
  const compressed = compressPayload ? await compress(plain) : undefined;
  return compressed === undefined ? `#pu=${bytesToBase64Url(plain)}` : `#p=${bytesToBase64Url(compressed)}`;
}

export async function decodeShare(fragment: string): Promise<SharePayload> {
  const match = /^#(p|pu)=([A-Za-z0-9_-]+)$/.exec(fragment);
  if (match === null) throw new Error('share URL needs a #p= or #pu= payload');
  const bytes = base64UrlToBytes(match[2]!);
  const plain = match[1] === 'p' ? await decompress(bytes) : bytes;
  let encoded: unknown;
  try {
    encoded = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('share payload is not valid JSON');
  }
  return decodePayload(encoded as EncodedPayload);
}
