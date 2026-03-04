'use client';

import type { Fp2 } from '@/zk/fp2';
import { formatFieldDecimal, formatFieldHex } from './format-field';

/** Hoverable field element: thin-spaced decimal visible, hex in the title. */
export function FieldElement({ value }: { value: bigint | Fp2 }) {
  return (
    <span className="field-element" title={formatFieldHex(value)}>
      {formatFieldDecimal(value)}
    </span>
  );
}
