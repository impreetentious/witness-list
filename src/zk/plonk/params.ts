/** Supported teaching-scale protocol parameters. docs/PROTOCOL-SPEC.md §4.11. */
import type { Params } from '../types';

export function paramsAreSupported(params: Params, circuitSize: number): boolean {
  return (
    Number.isSafeInteger(params.n) &&
    params.n === circuitSize &&
    params.blowup === 8 &&
    Number.isSafeInteger(params.queries) &&
    params.queries >= 1 &&
    params.queries <= 32 &&
    typeof params.zk === 'boolean'
  );
}
