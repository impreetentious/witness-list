import { describe, expect, it } from 'vitest';
import { fp2 } from '../../zk/fp2';
import {
  THIN_SPACE,
  formatFieldDecimal,
  formatFieldHex,
  formatFpDecimal,
  formatFpHex,
} from '../format-field';

describe('field display formatting', () => {
  it('groups decimal limbs with thin spaces', () => {
    expect(formatFpDecimal(1_234_567_890_123_456_789n)).toBe(
      `1${THIN_SPACE}234${THIN_SPACE}567${THIN_SPACE}890${THIN_SPACE}123${THIN_SPACE}456${THIN_SPACE}789`,
    );
    expect(formatFpDecimal(42n)).toBe('42');
    expect(formatFpDecimal(0n)).toBe('0');
  });

  it('exposes exact hex for hover titles', () => {
    expect(formatFpHex(255n)).toBe('0xff');
    expect(formatFpHex(0n)).toBe('0x0');
  });

  it('formats Fp² as paired limbs', () => {
    const value = fp2(1_000n, 2n);
    expect(formatFieldDecimal(value)).toBe(`1${THIN_SPACE}000 + 2u`);
    expect(formatFieldHex(value)).toBe('0x3e8 + 0x2u');
  });
});
