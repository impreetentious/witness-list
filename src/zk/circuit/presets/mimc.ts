/** Preset 3: MiMC-7 preimage. Constants derive from docs/PROTOCOL-SPEC.md §7 at runtime. */
import { add, mod, pow } from '../../field';
import type { Fp } from '../../field';
import type { Circuit } from '../ir';
import { PresetBuilder } from './builder';

const encoder = new TextEncoder();
const constants = new Map<number, Promise<Fp>>();

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(bytes.length);
  input.set(bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/** c₀ = 0; cᵢ = SHA-256("witness/mimc/i")[0..8] interpreted big-endian, mod p. */
export function mimcConstant(round: number): Promise<Fp> {
  if (!Number.isInteger(round) || round < 0 || round >= 32)
    throw new Error(`invalid MiMC round ${round}`);
  const existing = constants.get(round);
  if (existing !== undefined) return existing;
  const value =
    round === 0
      ? Promise.resolve(0n)
      : sha256(encoder.encode(`witness/mimc/${round}`)).then((digest) => {
          let firstEightBytes = 0n;
          for (let i = 0; i < 8; i++)
            firstEightBytes = (firstEightBytes << 8n) | BigInt(digest[i]!);
          return mod(firstEightBytes);
        });
  constants.set(round, value);
  return value;
}

export async function mimcHash(input: Fp): Promise<Fp> {
  let state = input;
  for (let round = 0; round < 32; round++) state = pow(add(state, await mimcConstant(round)), 7n);
  return add(state, input);
}

export interface MimcPreset {
  circuit: Circuit;
  preimageWire: number;
  digestWire: number;
}

/** Build the circuit asynchronously because the domain-separated constants use WebCrypto. */
export async function makeMimcPreset(): Promise<MimcPreset> {
  const builder = new PresetBuilder();
  const digestWire = builder.pub();
  const preimageWire = builder.priv();
  let state = preimageWire;
  for (let round = 0; round < 32; round++) {
    const constant = builder.constant(await mimcConstant(round));
    const shifted = builder.add(state, constant);
    const squared = builder.mul(shifted, shifted);
    const fourth = builder.mul(squared, squared);
    const sixth = builder.mul(fourth, squared);
    state = builder.mul(sixth, shifted);
  }
  const output = builder.add(state, preimageWire);
  const minusOne = builder.constant(-1n);
  const difference = builder.add(output, builder.mul(digestWire, minusOne));
  builder.assertZero(difference);
  return { circuit: builder.build('MiMC-7 preimage', [digestWire]), preimageWire, digestWire };
}
