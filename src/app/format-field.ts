/**
 * Field-element display formatting for inspectors and live payloads.
 * Thin-space decimal grouping + hex for hover titles (docs/PROTOCOL-SPEC.md §6.5 polish).
 * UI-only — not part of the wire format or `src/zk/` kernel.
 */

import type { Fp2 } from '@/zk/fp2';

/** Unicode thin space (U+2009) — groups digits without looking like a thousands comma. */
export const THIN_SPACE = '\u2009';

export function formatFpDecimal(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
  return negative ? `-${grouped}` : grouped;
}

export function formatFpHex(value: bigint): string {
  const negative = value < 0n;
  const hex = (negative ? -value : value).toString(16);
  return `${negative ? '-' : ''}0x${hex}`;
}

export function formatFieldDecimal(value: bigint | Fp2): string {
  if (typeof value === 'bigint') return formatFpDecimal(value);
  return `${formatFpDecimal(value.c0)} + ${formatFpDecimal(value.c1)}u`;
}

export function formatFieldHex(value: bigint | Fp2): string {
  if (typeof value === 'bigint') return formatFpHex(value);
  return `${formatFpHex(value.c0)} + ${formatFpHex(value.c1)}u`;
}
