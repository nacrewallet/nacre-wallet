import { describe, it, expect } from 'vitest';
import { parsePearlAmount, formatPearlAmount, recommendedFeeRate, MAX_FEE_RATE } from './money';

describe('exact payment amounts', () => {
  it('round-trips grains beyond the JavaScript safe integer without rounding', () => {
    const amount = '90071992.54740993';
    const grains = parsePearlAmount(amount);
    expect(grains).toBe(9_007_199_254_740_993n);
    expect(formatPearlAmount(grains!)).toBe(amount);
  });

  it('accepts one grain and a decimal comma without silently changing precision', () => {
    expect(parsePearlAmount('0,00000001')).toBe(1n);
    expect(parsePearlAmount('.5')).toBe(50_000_000n);
    expect(parsePearlAmount('1.')).toBe(100_000_000n);
    expect(formatPearlAmount(100_000_001n)).toBe('1.00000001');
  });

  it.each(['', '.', '-1', '1e3', '1.2.3', '1,234.56', 'NaN', 'Infinity', '0.000000009', '12 PRL'])(
    'rejects ambiguous or over-precise amount %s instead of repairing it', value => {
      expect(parsePearlAmount(value)).toBeNull();
    },
  );
});

describe('untrusted fee recommendations', () => {
  it('never converts invalid or unsafe recommendation numbers directly to bigint', () => {
    for (const invalid of [null, undefined, NaN, Infinity, -1]) expect(recommendedFeeRate(invalid)).toBe(1n);
    expect(recommendedFeeRate(Number.MAX_VALUE, 1.5)).toBe(MAX_FEE_RATE);
    expect(recommendedFeeRate(10, 1.5)).toBe(15n);
    expect(recommendedFeeRate(1, 0.8)).toBe(1n);
  });
});
