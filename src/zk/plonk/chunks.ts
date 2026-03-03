/** Quotient commitment layout shared by prover and verifier. */
import type { Params } from '../types';

const BASE_LABELS = ['t-lo', 't-mid', 't-hi'] as const;

export function quotientChunkLabel(index: number): string {
  if (index < 0 || !Number.isSafeInteger(index)) throw new Error('invalid quotient chunk index');
  return BASE_LABELS[index] ?? `t-${index}`;
}

export function quotientChunkLabels(count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 3) throw new Error('a quotient needs at least three chunks');
  return Array.from({ length: count }, (_, index) => quotientChunkLabel(index));
}

/**
 * Blinding lifts wire and grand-product degree by Q+1. The transition relation
 * can therefore need extra positional quotient chunks; committing zero-padded
 * trailing chunks gives verifier and prover one deterministic layout.
 */
export function quotientChunkCount(params: Params): number {
  if (!params.zk) return 3;
  const composedDegreeBound = 4 * params.n + 4 * params.queries + 4;
  const quotientCoefficientCount = composedDegreeBound - params.n + 1;
  return Math.max(3, Math.ceil(quotientCoefficientCount / params.n));
}

/** The DEEP polynomial degree is the highest blinded committed polynomial degree. */
export function friInitialDegreeBound(params: Params): number {
  return params.zk ? params.n + params.queries + 1 : params.n;
}
