import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockbookFeeRate } from './fee-estimate';
import { getStats } from './pearlchain';
import { selectFeePolicy } from '@/pearl/fee-policy';

afterEach(() => vi.unstubAllGlobals());
describe('public PRL fee sources', () => {
  it('converts PRL/kB exactly and always rounds fractional grains upward', () => {
    expect(blockbookFeeRate('0.00001')).toBe(1);
    expect(blockbookFeeRate('0.00783243')).toBe(784);
    expect(blockbookFeeRate('0.0000200000000000001')).toBe(3);
    expect(blockbookFeeRate('-1')).toBeNull();
    for (const value of ['0', '-2', '0.2junk', 'Infinity', {}, undefined]) expect(blockbookFeeRate(value)).toBeNaN();
    expect(selectFeePolicy({recommendedFee:blockbookFeeRate('0.2000000001')})).toMatchObject({available:false});
  });
  function responses(primary: unknown, estimate: unknown, chain = 'mainnet', inSync = true) {
    const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith('/api/explorer/stats') ? primary
      : url.endsWith('/estimatefee/2') ? {result:estimate} : {backend:{chain,blocks:124292},blockbook:{inSync}}));
    vi.stubGlobal('fetch', fetcher); return fetcher;
  }
  it('uses the second estimator when the primary recommendation is null, preserving observed floors', async () => {
    responses({recommendedFee:null,relayfee:0.00001,mempoolMinFee:900},'0.00783243');
    const stats = await getStats('https://pearlchain.live');
    expect(stats).toMatchObject({recommendedFee:784,relayfee:0.00001,mempoolMinFee:900});
    expect(selectFeePolicy(stats)).toMatchObject({available:true,source:'network',rate:901n});
  });
  it.each([2, 25000, -2, 'invalid'])('never replaces explicit primary recommendation %s', async rate => {
    const fetcher=responses({recommendedFee:rate},'0.00001');
    expect((await getStats('https://pearlchain.live'))?.recommendedFee).toBe(rate);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([['testnet',true],['mainnet',false]])('does not use an unverified alternate chain/sync state', async (chain,inSync) => {
    responses({recommendedFee:null},'0.00783243',chain as string,inSync as boolean);
    expect((await getStats('https://pearlchain.live'))?.recommendedFee).toBeNull();
  });
  it('uses the explicit fallback only when both estimators lack a rate', async () => {
    responses({recommendedFee:null},'-1');
    expect(selectFeePolicy(await getStats('https://pearlchain.live'))).toMatchObject({available:true,source:'fallback',rate:2n});
  });
  it('blocks malformed alternate data instead of silently falling back', async () => {
    responses({recommendedFee:null},'bad');
    expect(selectFeePolicy(await getStats('https://pearlchain.live'))).toMatchObject({available:false});
  });
  it('blocks syntactically malformed primary data instead of treating it as an absent estimate', async () => {
    const fetcher = vi.fn(async () => new Response('{broken', {status:200}));
    vi.stubGlobal('fetch', fetcher);
    expect(selectFeePolicy(await getStats('https://pearlchain.live'))).toMatchObject({available:false});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('never applies the mainnet alternate to a custom backend', async () => {
    const fetcher=responses({recommendedFee:null},'0.00783243');
    await getStats('https://custom.example'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
