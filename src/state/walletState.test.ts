import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HDKey } from '@scure/bip32';
import type { WalletMeta } from '@/storage/vault';
import type { WalletScan } from '@/pearl/hdwallet';

const mocks = vi.hoisted(() => ({
  hd: {} as HDKey | null, meta: null as WalletMeta | null, base: 'https://synthetic.example',
  mode: 'pearlchain' as 'pearlchain' | 'blockbook',
  loadMeta: vi.fn(), scan: vi.fn(), stats: vi.fn(), price: vi.fn(), history: vi.fn(), protected: vi.fn(),
}));
vi.mock('./session', () => ({ getHD: () => mocks.hd }));
vi.mock('./accounts', () => ({ scanCurrentAccount: mocks.scan }));
vi.mock('@/storage/vault', () => ({ loadMeta: mocks.loadMeta }));
vi.mock('./protectedCoins', () => ({ resolveProtectedCoins: mocks.protected }));
vi.mock('@/api/client', () => ({ getStats: mocks.stats, getPrice: mocks.price, getWalletHistory: mocks.history,
  pnsOwnedByStrict: vi.fn(), getBaseUrl: () => mocks.base, getBackendMode: () => mocks.mode }));
let state: typeof import('./walletState');
let storageChanged: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;
const account = { id: 'account-a', label: 'Synthetic A', type: 'hd' as const, coinType: 0, account: 0 };
const other = { ...account, id: 'account-b', account: 1 };
const initialMeta = (): WalletMeta => ({ version: 2, createdAt: 1, network: 'mainnet', selectedAccountId: account.id, accounts: [account, other] });
const scan = (balance = 5n): WalletScan => ({ balance, utxos: [{ txid: 'a'.repeat(64), vout: 0, value: balance, blockHeight: 1, address: 'synthetic-address', chain: 0, index: 0 }],
  addresses: [{ address: 'synthetic-address', chain: 0, index: 0, used: true, balance }], receiveAddress: 'synthetic-next', receiveIndex: 1,
  nextChangeAddress: 'synthetic-change', nextChangeIndex: 0 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

beforeAll(async () => {
  vi.stubGlobal('chrome', { storage: { onChanged: { addListener: (fn: typeof storageChanged) => { storageChanged = fn; } } } });
  state = await import('./walletState');
});
beforeEach(() => {
  vi.resetAllMocks();
  state.clearCache();
  mocks.hd = {} as HDKey;
  mocks.meta = initialMeta();
  mocks.base = 'https://synthetic.example';
  mocks.mode = 'pearlchain';
  mocks.loadMeta.mockImplementation(async () => structuredClone(mocks.meta));
  mocks.scan.mockResolvedValue(scan());
  mocks.stats.mockResolvedValue({ recommendedFee: 1 });
  mocks.price.mockResolvedValue(null);
  mocks.history.mockResolvedValue(null);
  mocks.protected.mockResolvedValue({ outpoints: new Set(), verified: true });
});
afterEach(() => state.clearCache());

describe('wallet snapshot lifecycle', () => {
  it('publishes an account/network-bound snapshot without waiting for market/history', async () => {
    mocks.price.mockReturnValue(new Promise(() => {}));
    mocks.history.mockReturnValue(new Promise(() => {}));
    await state.refreshWallet();
    expect(state.getCache()).toMatchObject({ scan: { balance: 5n }, account, network: 'mainnet', feeRate: 1, feeVerified: true, namesVerified: true, syncErr: null });
    expect(state.getCache().lastSync).toBeGreaterThan(0);
    expect(mocks.scan).toHaveBeenCalledExactlyOnceWith('mainnet', account);
  });
  it('coalesces overlapping scans for the same account/session', async () => {
    const pending = deferred<WalletScan>();
    mocks.scan.mockReturnValue(pending.promise);
    const first = state.refreshWallet();
    const second = state.refreshWallet();
    await flush();
    expect(mocks.scan).toHaveBeenCalledTimes(1);
    pending.resolve(scan());
    await Promise.all([first, second]);
    expect(state.getCache().scan?.balance).toBe(5n);
  });
  it('clears old successful balances after an essential scan failure', async () => {
    await state.refreshWallet();
    mocks.scan.mockRejectedValue(new Error('Partial scan'));
    await state.refreshWallet();
    expect(state.getCache()).toMatchObject({ scan: null, lastSync: 0, feeRate: null, feeVerified: false, namesVerified: false, syncErr: 'Partial scan' });
  });
  it.each([null, { recommendedFee: NaN }, { recommendedFee: 0 }, { recommendedFee: 20_001 }])('keeps fee availability separate from known balance: %j', stats => {
    mocks.stats.mockResolvedValue(stats);
    return state.refreshWallet().then(() => {
      expect(state.getCache()).toMatchObject({ scan: { balance: 5n }, feeVerified: false, feeRate: null });
    });
  });
  it.each([null, { recommendedFee: null }])('publishes fallback availability without calling it a verified recommendation: %j', async stats => {
    mocks.stats.mockResolvedValue(stats);
    await state.refreshWallet();
    expect(state.getCache()).toMatchObject({ feeVerified: false, feeRate: null, feePolicy: { available: true, rate: 2n, source: 'fallback' } });
  });
  it('uses fallback after a failed stats request without reviving an older recommendation', async () => {
    await state.refreshWallet();
    mocks.stats.mockRejectedValue(new Error('Stats unavailable'));
    await state.refreshWallet();
    expect(state.getCache()).toMatchObject({ feeVerified: false, feeRate: null, feePolicy: { available: true, rate: 2n, source: 'fallback' } });
  });
  it.each([{ recommendedFee: NaN }, { recommendedFee: -1 }, { recommendedFee: 20001 }, { recommendedFee: '2' }])('blocks malformed fee recommendations instead of silently falling back: %j', async stats => {
    mocks.stats.mockResolvedValue(stats);
    await state.refreshWallet();
    expect(state.getCache()).toMatchObject({ feePolicy: { available: false } });
  });
  it('publishes total balance but marks spendability unknown when name verification fails', async () => {
    mocks.protected.mockResolvedValue({ outpoints: new Set(['a'.repeat(64) + ':0']), verified: false });
    await state.refreshWallet();
    expect(state.getCache()).toMatchObject({ scan: { balance: 5n }, namesVerified: false });
    expect(state.getCache().protectedOutpoints.size).toBe(1);
  });
  it.each(['account', 'network', 'backend', 'session', 'descriptor'] as const)('does not publish an obsolete %s scan', async change => {
    const pending = deferred<WalletScan>();
    mocks.scan.mockReturnValue(pending.promise);
    const refreshing = state.refreshWallet();
    await flush();
    if (change === 'account') mocks.meta!.selectedAccountId = other.id;
    if (change === 'network') mocks.meta!.network = 'testnet';
    if (change === 'backend') mocks.base = 'https://different.example';
    if (change === 'session') mocks.hd = {} as HDKey;
    if (change === 'descriptor') mocks.meta!.accounts[0] = { ...account, seedId: 'different-seed' };
    pending.resolve(scan());
    await refreshing;
    expect(state.getCache().scan).toBeNull();
    expect(state.getCache().lastSync).toBe(0);
  });
  it('does not overwrite the new account with a delayed old-account failure', async () => {
    const old = deferred<WalletScan>();
    mocks.scan.mockReturnValueOnce(old.promise).mockResolvedValue(scan(12n));
    const first = state.refreshWallet();
    await flush();
    mocks.meta!.selectedAccountId = other.id;
    await state.refreshWallet();
    old.reject(new Error('Old failure'));
    await first;
    expect(state.getCache()).toMatchObject({ account: other, scan: { balance: 12n }, syncErr: null });
  });
  it('invalidates on A to B to A selection changes, even if the old response matches A', async () => {
    const pending = deferred<WalletScan>();
    mocks.scan.mockReturnValue(pending.promise);
    const refreshing = state.refreshWallet();
    await flush();
    const a = structuredClone(mocks.meta);
    const b = { ...a!, selectedAccountId: other.id };
    storageChanged({ 'pearlchain.wallet.meta': { oldValue: a, newValue: b } }, 'local');
    storageChanged({ 'pearlchain.wallet.meta': { oldValue: b, newValue: a } }, 'local');
    pending.resolve(scan());
    await refreshing;
    expect(state.getCache().scan).toBeNull();
  });
  it('discards delayed optional data after switching accounts', async () => {
    const price = deferred<{ price: number }>();
    const history = deferred<unknown[]>();
    mocks.price.mockReturnValueOnce(price.promise).mockResolvedValue({ price: 2 });
    mocks.history.mockReturnValueOnce(history.promise).mockResolvedValue([]);
    await state.refreshWallet();
    mocks.meta!.selectedAccountId = other.id;
    await state.refreshWallet();
    await flush();
    price.resolve({ price: 100 });
    history.resolve([{ txid: 'old-account-history' }]);
    await flush();
    expect(state.getCache()).toMatchObject({ account: other, priceUsd: 2, txs: [] });
  });
  it('immediately clears cached amounts when the HD session disappears', async () => {
    await state.refreshWallet();
    mocks.hd = null;
    expect(state.getCache().scan).toBeNull();
  });
  it('clears on an explicit cache reset while an explorer response is in flight', async () => {
    const pending = deferred<WalletScan>();
    mocks.scan.mockReturnValue(pending.promise);
    const refreshing = state.refreshWallet();
    await flush();
    state.clearCache();
    pending.resolve(scan());
    await refreshing;
    expect(state.getCache().scan).toBeNull();
  });
});
