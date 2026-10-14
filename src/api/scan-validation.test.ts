import { afterEach, describe, expect, it, vi } from 'vitest';
import { atomicValue, validateScanResults } from './scan-validation';
import * as pearlchain from './pearlchain';
import * as blockbook from './blockbook';

const coin = { txid: 'a'.repeat(64), vout: 0, value: '9007199254740993', blockHeight: 100 };
const row = { address: 'synthetic-address', used: true, balance: coin.value, utxos: [coin] };
const empty = { address: row.address, used: false, balance: '0', utxos: [] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('strict explorer scan data', () => {
  it('retains atomic precision beyond the safe Number range', () => {
    expect(validateScanResults([row.address], [row])[0].balance).toBe('9007199254740993');
    expect(atomicValue(row.balance)).toBe(9007199254740993n);
  });
  it.each([undefined, null, [], [{ ...empty, address: 'foreign' }], [empty, empty], [{ ...empty, used: undefined }]])('rejects missing, foreign, duplicated or malformed address coverage %#', value => {
    expect(() => validateScanResults([row.address], value)).toThrow(/invalid wallet scan/);
  });
  it.each(['-1', '1.2', '1e3', '01', '9223372036854775808', 100, NaN, null])('rejects invalid atomic values: %s', value => {
    expect(() => atomicValue(value)).toThrow();
  });
  it('requires agreement between address balance, usage and coins', () => {
    for (const invalid of [{ ...row, balance: '0' }, { ...row, used: false }, { ...row, utxos: [] }]) {
      expect(() => validateScanResults([row.address], [invalid])).toThrow();
    }
  });
  it('rejects malformed and duplicate outpoints, including across addresses/case', () => {
    for (const malformed of [{ ...coin, vout: -1 }, { ...coin, vout: 0x100000000 }, { ...coin, value: '0' },
      { ...coin, txid: 'invalid' }, { ...coin, blockHeight: 1.5 }]) {
      expect(() => validateScanResults([row.address], [{ ...row, utxos: [malformed] }])).toThrow();
    }
    expect(() => validateScanResults([row.address, 'second'], [row, { ...row, address: 'second', utxos: [{ ...coin, txid: coin.txid.toUpperCase() }] }])).toThrow();
  });
  it('distinguishes a verified unused address from a failed Pearlchain request', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ results: [empty] }))
      .mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({ results: [] }))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(json({}));
    vi.stubGlobal('fetch', fetcher);
    expect(await pearlchain.scanAddresses('https://synthetic.example', [row.address])).toEqual([empty]);
    await expect(pearlchain.scanAddresses('https://synthetic.example', [row.address])).rejects.toThrow(/503/);
    await expect(pearlchain.scanAddresses('https://synthetic.example', [row.address])).rejects.toThrow();
    await expect(pearlchain.scanAddresses('https://synthetic.example', [row.address])).rejects.toThrow(/offline/);
    await expect(pearlchain.getUtxos('https://synthetic.example', row.address)).rejects.toThrow();
  });
  it('treats malformed ownership data as unknown, not unprotected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ names: [{ owned: true }] }))
      .mockResolvedValueOnce(json({ names: [] })));
    expect(await pearlchain.pnsOwnedByStrict('https://synthetic.example', row.address)).toBeNull();
    expect(await pearlchain.pnsOwnedByStrict('https://synthetic.example', row.address)).toBeNull();
    expect(await pearlchain.pnsOwnedByStrict('https://synthetic.example', row.address)).toEqual([]);
  });
  it('rejects a failed Blockbook probe instead of inventing an unused address', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 503)));
    await expect(blockbook.scanAddresses('https://synthetic.example', [row.address])).rejects.toThrow(/503/);
    await expect(blockbook.getUtxos('https://synthetic.example', row.address)).rejects.toThrow(/503/);
  });
  it('requests mempool-aware Blockbook details and keeps exact balance precision', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ address: row.address, balance: '9007199254740994', unconfirmedBalance: '-1', txs: 2, unconfirmedTxs: 1 }))
      .mockResolvedValueOnce(json([{ txid: coin.txid, vout: 0, value: coin.value, height: 100, confirmations: 1 }]));
    vi.stubGlobal('fetch', fetcher);
    expect(await blockbook.scanAddresses('https://synthetic.example', [row.address])).toEqual([row]);
    expect(fetcher.mock.calls[0][0]).toContain('details=txids&page=1&pageSize=1');
  });
  it('does not omit a newly funded address whose only receipt is unconfirmed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ address: row.address, balance: '0', unconfirmedBalance: '1', txs: 0, unconfirmedTxs: 1 }))
      .mockResolvedValueOnce(json([{ txid: coin.txid, vout: 0, value: '1', confirmations: 0 }])));
    const [result] = await blockbook.scanAddresses('https://synthetic.example', [row.address]);
    expect(result).toEqual({ address: row.address, used: true, balance: '1', utxos: [{ ...coin, value: '1', blockHeight: 0 }] });
  });
});
