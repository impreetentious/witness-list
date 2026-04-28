/**
 * docs/PROTOCOL-SPEC.md §12 / 2D — Small, inspectable Poseidon permutation over Goldilocks.
 *
 * This teaching parameterisation uses width 3, rate 2, x^7, eight full rounds
 * and 22 partial rounds. Round constants are deterministically generated from
 * the domain below; tools/reference.py reproduces the public test vectors.
 * It is intentionally not presented as a production hash parameter set.
 */
import { add, inv, mod, mul, pow } from './field';
import type { Fp } from './field';

const POSEIDON_WIDTH = 3;
export const POSEIDON_FULL_ROUNDS = 8;
export const POSEIDON_PARTIAL_ROUNDS = 22;
const POSEIDON_ROUNDS = POSEIDON_FULL_ROUNDS + POSEIDON_PARTIAL_ROUNDS;

const encoder = new TextEncoder();
const cachedRoundConstants = new Map<string, Promise<Fp>>();

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', owned));
}

/**
 * Constants are generated, not transcribed: H("witness/poseidon/r/i")[0..8]
 * in big-endian form reduced modulo p. This keeps a small implementation
 * independently reproducible by the reference script.
 */
function poseidonRoundConstant(round: number, index: number): Promise<Fp> {
  if (!Number.isInteger(round) || round < 0 || round >= POSEIDON_ROUNDS)
    throw new Error(`invalid Poseidon round ${round}`);
  if (!Number.isInteger(index) || index < 0 || index >= POSEIDON_WIDTH)
    throw new Error(`invalid Poseidon state index ${index}`);
  const key = `${round}/${index}`;
  const cached = cachedRoundConstants.get(key);
  if (cached !== undefined) return cached;
  const generated = sha256(encoder.encode(`witness/poseidon/${round}/${index}`)).then((digest) => {
    let value = 0n;
    for (let byte = 0; byte < 8; byte++) value = (value << 8n) | BigInt(digest[byte]!);
    return mod(value);
  });
  cachedRoundConstants.set(key, generated);
  return generated;
}

export async function poseidonRoundConstants(): Promise<Fp[][]> {
  return Promise.all(
    Array.from({ length: POSEIDON_ROUNDS }, (_, round) =>
      Promise.all(
        Array.from({ length: POSEIDON_WIDTH }, (_, index) => poseidonRoundConstant(round, index)),
      ),
    ),
  );
}

/** Cauchy MDS matrix M[i,j] = 1/(i + j + 1), valid over Goldilocks. */
export const POSEIDON_MDS: readonly (readonly Fp[])[] = [
  [1n, inv(2n), inv(3n)],
  [inv(2n), inv(3n), inv(4n)],
  [inv(3n), inv(4n), inv(5n)],
];

function sbox(value: Fp): Fp {
  return pow(value, 7n);
}

export function poseidonMds(state: readonly Fp[]): Fp[] {
  if (state.length !== POSEIDON_WIDTH) throw new Error('Poseidon state width mismatch');
  return POSEIDON_MDS.map((row) =>
    row.reduce((sum, coefficient, index) => add(sum, mul(coefficient, state[index]!)), 0n),
  );
}

/** Applies one full or partial Poseidon round. */
function poseidonRound(state: readonly Fp[], constants: readonly Fp[], full: boolean): Fp[] {
  if (state.length !== POSEIDON_WIDTH || constants.length !== POSEIDON_WIDTH)
    throw new Error('Poseidon round width mismatch');
  const shifted = state.map((value, index) => add(value, constants[index]!));
  const substituted = shifted.map((value, index) => (full || index === 0 ? sbox(value) : value));
  return poseidonMds(substituted);
}

async function poseidonPermute(initial: readonly Fp[]): Promise<Fp[]> {
  if (initial.length !== POSEIDON_WIDTH)
    throw new Error('Poseidon permutation expects a width-3 state');
  const constants = await poseidonRoundConstants();
  let state = initial.slice();
  const halfFull = POSEIDON_FULL_ROUNDS / 2;
  for (let round = 0; round < POSEIDON_ROUNDS; round++) {
    state = poseidonRound(
      state,
      constants[round]!,
      round < halfFull || round >= halfFull + POSEIDON_PARTIAL_ROUNDS,
    );
  }
  return state;
}

/** Two-to-one sponge compression used by the workshop preset and Witness Script. */
export async function poseidonHash(left: Fp, right: Fp): Promise<Fp> {
  return (await poseidonPermute([left, right, 0n]))[0]!;
}
