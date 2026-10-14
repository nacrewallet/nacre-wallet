import { describe, expect, it } from 'vitest';
import { MAX_FEE_RATE } from './money';
import { FALLBACK_FEE_RATE, feeRateForPolicy, selectFeePolicy, type FeeStats } from './fee-policy';

describe('Pearl fee selection', () => {
  it.each([null, undefined, {}, { recommendedFee: null }, { recommendedFee: undefined }])(
    'labels missing recommendations as an explicit fallback: %s', stats => {
      expect(selectFeePolicy(stats)).toEqual({ available: true, rate: FALLBACK_FEE_RATE,
        source: 'fallback', minimumRate: 1n });
    },
  );

  it('uses and rounds a current recommendation upwards, including the observed Blockbook estimate', () => {
    expect(selectFeePolicy({ recommendedFee: 1.01 })).toMatchObject({ available: true, rate: 2n, source: 'network' });
    expect(selectFeePolicy({ recommendedFee: 783.243 })).toMatchObject({ available: true, rate: 784n, source: 'network' });
    expect(selectFeePolicy({ recommendedFee: Number(MAX_FEE_RATE) })).toMatchObject({ available: true, rate: MAX_FEE_RATE });
  });

  it.each([0, -1, NaN, Infinity, -Infinity, '2', true, {}, [], Number.MAX_VALUE, 20_000.01])(
    'blocks an invalid/excessive recommendation instead of replacing it with a cheaper fallback: %s', recommendedFee => {
      expect(selectFeePolicy({ recommendedFee })).toMatchObject({ available: false });
    },
  );

  it.each([false, 2, '2', []])('blocks a malformed stats response: %s', stats => {
    expect(selectFeePolicy(stats as unknown as FeeStats)).toMatchObject({ available: false });
  });

  it('converts the sourced PRL/kB relay floor and respects the grains/vB mempool floor', () => {
    expect(selectFeePolicy({ recommendedFee: null, relayfee: 0.00001, mempoolMinFee: null }))
      .toEqual({ available: true, source: 'fallback', minimumRate: 1n, rate: 2n });
    expect(selectFeePolicy({ recommendedFee: 2, relayfee: 0.000025, mempoolMinFee: 4.1 }))
      .toEqual({ available: true, source: 'network', minimumRate: 5n, rate: 5n });
    expect(selectFeePolicy({ relayfee: 0.00004 }))
      .toEqual({ available: true, source: 'fallback', minimumRate: 4n, rate: 4n });
    expect(selectFeePolicy({ recommendedFee: 3, mempoolMinFee: 3 }))
      .toEqual({ available: true, source: 'network', minimumRate: 4n, rate: 4n });
  });

  it('retains the conservative default floor when reported floors are absent or zero', () => {
    expect(selectFeePolicy({ recommendedFee: 0.1, relayfee: 0, mempoolMinFee: 0 }))
      .toEqual({ available: true, source: 'network', minimumRate: 1n, rate: 1n });
  });

  it('scales relay decimals exactly and rounds genuine fractional floors upward', () => {
    for (let grains = 1; grains <= 100; grains++) {
      expect(selectFeePolicy({ recommendedFee: 1, relayfee: grains / 100_000 }))
        .toMatchObject({ available: true, rate: BigInt(grains) });
    }
    expect(selectFeePolicy({ relayfee: 0.000020000001 })).toMatchObject({ available: true, minimumRate: 3n, rate: 3n });
    expect(selectFeePolicy({ relayfee: 1e-20 })).toMatchObject({ available: true, minimumRate: 1n });
  });

  it.each(['relayfee', 'mempoolMinFee'] as const)('rejects invalid %s even alongside a good recommendation', field => {
    for (const value of [-1, NaN, Infinity, '0.00001', {}, true]) {
      expect(selectFeePolicy({ recommendedFee: 5, [field]: value })).toMatchObject({ available: false });
    }
  });

  it('rejects excessive reported floors, including fractional excess above the ceiling', () => {
    for (const stats of [{ relayfee: 0.200000001 }, { mempoolMinFee: 20_000 }, { mempoolMinFee: 20_000.01 }, { relayfee: Number.MAX_VALUE }]) {
      expect(selectFeePolicy(stats)).toMatchObject({ available: false });
    }
  });
});

describe('fee priorities', () => {
  it('ceilings priority changes and never reduces an observed floor', () => {
    const policy = selectFeePolicy({ recommendedFee: 5, mempoolMinFee: 4.1 });
    expect(feeRateForPolicy(policy, 0.8)).toBe(5n);
    expect(feeRateForPolicy(policy)).toBe(5n);
    expect(feeRateForPolicy(policy, 1.5)).toBe(8n);
    expect(feeRateForPolicy(selectFeePolicy(null), 0.8)).toBe(2n);
    expect(feeRateForPolicy(selectFeePolicy({ recommendedFee: 100 }), 1.1)).toBe(110n);
  });

  it('rejects a priority exceeding the ceiling instead of clamping it', () => {
    expect(() => feeRateForPolicy(selectFeePolicy({ recommendedFee: 20_000 }), 1.5)).toThrow(/safety limit/);
    expect(() => feeRateForPolicy(selectFeePolicy(null), Number.MAX_VALUE)).toThrow(/safety limit/);
  });

  it.each([0, -1, NaN, Infinity])('rejects an invalid priority: %s', multiplier => {
    expect(() => feeRateForPolicy(selectFeePolicy(null), multiplier)).toThrow(/priority/);
  });

  it('does not transform unavailable data into a rate', () => {
    expect(() => feeRateForPolicy(selectFeePolicy({ recommendedFee: -1 }))).toThrow(/recommendation/);
    expect(() => feeRateForPolicy(null)).toThrow(/unavailable/);
  });
});
