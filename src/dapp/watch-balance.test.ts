import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletScan } from '@/pearl/hdwallet';
import type { WalletMeta } from '@/storage/vault';
import type { Connection } from './broker';
import { parsePrivateKey, privateKeyToAddress } from '@/pearl/wallet';
import { balanceContext } from './balance-watch';

const mocks = vi.hoisted(() => ({
  stats: vi.fn(), scanAddresses: vi.fn(), scanSingle: vi.fn(), scanDerived: vi.fn(), names: vi.fn(), protection: vi.fn(),
  blockStats: vi.fn(), blockScan: vi.fn(),
}));
vi.mock('@/api/pearlchain', () => ({ getStats: mocks.stats, scanAddresses: mocks.scanAddresses, pnsOwnedByStrict: mocks.names }));
vi.mock('@/api/blockbook', () => ({ getStats: mocks.blockStats, scanAddresses: mocks.blockScan }));
vi.mock('@/pearl/hdwallet', () => ({ scanSingleAddress: mocks.scanSingle, scanDerivedWallet: mocks.scanDerived }));
vi.mock('@/state/protectedCoins', async importOriginal => ({
  ...await importOriginal<typeof import('@/state/protectedCoins')>(), resolveProtectedCoins: mocks.protection,
}));
import { scanWatchBalance } from './watch-balance';

const address = privateKeyToAddress(parsePrivateKey('2'.repeat(64)), 'mainnet');
const txids = ['a', 'b', 'c'].map(c => c.repeat(64));
const meta: WalletMeta = { version: 2, createdAt: 1, network: 'mainnet', selectedAccountId: 'one',
  accounts: [{ id: 'one', label: 'Public fixture', type: 'imported', address }] };
const account: Connection = { accountId: 'one', address, balanceAccess: true,
  balanceWatch: { kind: 'single', context: balanceContext(meta), address } };
const scan = (): WalletScan => ({ balance: 240000000n,
  utxos: [150000000n, 80000000n, 10000000n].map((value, i) => ({ txid: txids[i], vout: 0, value, address, chain: 0, index: i, blockHeight: 1 })),
  addresses: [], receiveAddress: address, receiveIndex: 0, nextChangeAddress: address, nextChangeIndex: 0 });

describe('public worker balance fee policy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.stats.mockResolvedValue({ recommendedFee: 2 });
    mocks.protection.mockResolvedValue({ verified: true, outpoints: new Set([`${txids[2]}:0`]) });
    mocks.scanSingle.mockImplementation(async (_address, scanner) => { await scanner([address]); return scan(); });
    mocks.scanAddresses.mockResolvedValue([]);
  });

  it('uses a fresh recommendation and protects name coins in fixed-payment MAX', async () => {
    const signal = new AbortController().signal;
    const result = await scanWatchBalance(account, meta, signal);
    expect(result).toMatchObject({ total: '240000000', spendable: '230000000', maxSend: '229999574', estimatedMaxFee: '426', feeRate: '2', feeSource: 'network', namesVerified: true });
    expect(mocks.stats).toHaveBeenCalledExactlyOnceWith('https://pearlchain.live', signal);
    expect(mocks.scanAddresses).toHaveBeenCalledExactlyOnceWith('https://pearlchain.live', [address], signal);
    expect(mocks.protection).toHaveBeenCalledWith('one', [address, address, address], expect.any(Function));
  });
  it.each([null, { recommendedFee: null }])('publishes usable MAX with explicit fallback provenance for missing stats: %j', async stats => {
    mocks.stats.mockResolvedValue(stats);
    expect(await scanWatchBalance(account, meta)).toMatchObject({ spendable: '230000000', maxSend: '229999574', estimatedMaxFee: '426', feeRate: '2', feeSource: 'fallback' });
  });
  it('uses fallback after stats failure and selects a newly available recommendation on the next scan', async () => {
    mocks.stats.mockRejectedValueOnce(new Error('Stats offline')).mockResolvedValue({ recommendedFee: 3 });
    expect(await scanWatchBalance(account, meta)).toMatchObject({ feeRate: '2', feeSource: 'fallback', estimatedMaxFee: '426' });
    expect(await scanWatchBalance(account, meta)).toMatchObject({ feeRate: '3', feeSource: 'network', maxSend: '229999361', estimatedMaxFee: '639' });
  });
  it.each([{ recommendedFee: NaN }, { recommendedFee: 0 }, { recommendedFee: 20001 }, { recommendedFee: '2' }])('keeps spendable known but MAX unavailable for malformed fee inputs: %j', async stats => {
    mocks.stats.mockResolvedValue(stats);
    expect(await scanWatchBalance(account, meta)).toMatchObject({ spendable: '230000000', maxSend: null, estimatedMaxFee: null, feeRate: null, feeSource: null });
  });
  it('does not let fallback fees weaken name protection', async () => {
    mocks.stats.mockResolvedValue(null);
    mocks.protection.mockResolvedValue({ verified: false, outpoints: new Set([`${txids[2]}:0`]) });
    expect(await scanWatchBalance(account, meta)).toMatchObject({ total: '240000000', spendable: null, maxSend: null, estimatedMaxFee: null, namesVerified: false });
  });
  it('never returns fallback balance after a cancelled scan or essential scan failure', async () => {
    const controller = new AbortController();
    controller.abort();
    mocks.stats.mockRejectedValue(new Error('Cancelled stats'));
    await expect(scanWatchBalance(account, meta, controller.signal)).rejects.toThrow();
    mocks.scanSingle.mockRejectedValue(new Error('Partial account scan'));
    await expect(scanWatchBalance(account, meta)).rejects.toThrow(/Partial account scan/);
  });
  it('rejects a changed selected account before requesting any data', async () => {
    await expect(scanWatchBalance(account, { ...meta, selectedAccountId: 'other' })).rejects.toThrow(/selected balance account changed/);
    expect(mocks.stats).not.toHaveBeenCalled();
  });
});
