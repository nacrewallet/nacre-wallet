import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletScan } from '@/pearl/hdwallet';
import type { PendingRequest } from './broker';
import { selectFeePolicy, type FeePolicyResult } from '@/pearl/fee-policy';

const mocks = vi.hoisted(() => ({
  unlocked: true,
  cache: {} as {
    account: { id: string; label: string } | null;
    scan: WalletScan | null;
    namesVerified: boolean;
    protectedOutpoints: Set<string>;
    feeRate: number | null;
    feeVerified: boolean;
    feePolicy: FeePolicyResult | null;
    network: string | null;
    lastSync: number;
    syncErr: string | null;
  },
  loadMeta: vi.fn(), refresh: vi.fn(), publicAccount: vi.fn(), getCache: vi.fn(),
}));
vi.mock('@/state/session', () => ({ isUnlocked: () => mocks.unlocked }));
vi.mock('@/state/walletState', () => ({ getCache: mocks.getCache, refreshWallet: mocks.refresh }));
vi.mock('@/state/accounts', () => ({ currentPublicAccount: mocks.publicAccount }));
vi.mock('@/storage/vault', () => ({ loadMeta: mocks.loadMeta }));
import { prepareApproval } from './payment';

const address = 'public-address-used-only-in-quote';
const txid = 'ab'.repeat(32);
function request(method: 'connect' | 'sendTransaction' = 'sendTransaction'): PendingRequest {
  return {
    id: 'mock-request', clientId: 'mock-client',
    owner: { origin: 'https://nacre.finance', tabId: 1, windowId: 10, documentId: 'document' },
    args: method === 'connect' ? { method } : { method, params: { to: address, amount: '1.00000001' } },
    account: method === 'connect' ? undefined : { accountId: 'account-1', address },
    createdAt: Date.now(), expiresAt: Date.now() + 60_000, status: 'pending',
  };
}

describe('approval preparation boundaries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.unlocked = true;
    mocks.cache = {
      account: { id: 'account-1', label: 'Public test account' },
      scan: {
        balance: 200_000_000n,
        utxos: [{ txid, vout: 0, value: 200_000_000n, address, chain: 0, index: 0, blockHeight: 1 }],
        addresses: [], receiveAddress: address, receiveIndex: 0, nextChangeAddress: address, nextChangeIndex: 1,
      },
      namesVerified: true, protectedOutpoints: new Set(), feeRate: 2, feeVerified: true, feePolicy: selectFeePolicy({ recommendedFee: 2 }), network: 'mainnet', lastSync: 0, syncErr: null,
    };
    mocks.loadMeta.mockResolvedValue({ network: 'mainnet', selectedAccountId: 'account-1' });
    mocks.refresh.mockImplementation(async () => { mocks.cache.lastSync = Date.now(); });
    mocks.getCache.mockImplementation(() => mocks.cache);
    mocks.publicAccount.mockResolvedValue({ accountId: 'account-1', label: 'Public test account', address });
  });

  it('prepares an exact amount and clones its reviewed coin snapshot', async () => {
    const preview = await prepareApproval(request());
    if (preview.kind !== 'payment') throw new Error('Expected a payment preview.');
    expect(preview.quote).toMatchObject({ ok: true, amount: 100_000_001n, fee: 310n });
    mocks.cache.scan!.utxos[0].value = 1n;
    mocks.cache.protectedOutpoints.add(`${txid}:0`);
    expect(preview.scan.utxos[0].value).toBe(200_000_000n);
    expect(preview.protectedOutpoints.size).toBe(0);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.publicAccount).not.toHaveBeenCalled();
  });

  it('accepts amount plus fee exactly at the cap and rejects a fee increase on re-review', async () => {
    const r = request();
    if (r.args.method !== 'sendTransaction') throw new Error('payment fixture');
    r.args.params.maxTotalDebitAtoms = '100000311';
    const preview = await prepareApproval(r);
    if (preview.kind !== 'payment') throw new Error('payment preview');
    expect(preview.payment.maxTotalDebitAtoms).toBe('100000311');
    expect(preview.quote.amount + preview.quote.fee).toBe(100000311n);
    mocks.cache.feeRate = 3; mocks.cache.feePolicy = selectFeePolicy({ recommendedFee: 3 });
    await expect(prepareApproval(r)).rejects.toThrow(/exceed Budget max/);
  });

  it('does not allow a mutable request to lift its cap during wallet refresh', async () => {
    const r = request();
    if (r.args.method !== 'sendTransaction') throw new Error('payment fixture');
    r.args.params.maxTotalDebitAtoms = '100000001';
    mocks.refresh.mockImplementation(async () => {
      mocks.cache.lastSync = Date.now();
      if (r.args.method === 'sendTransaction') r.args.params.maxTotalDebitAtoms = '999999999';
    });
    await expect(prepareApproval(r)).rejects.toThrow(/exceed Budget max/);
  });

  it('counts dust change absorbed into the network fee against the cap', async () => {
    const r = request();
    if (r.args.method !== 'sendTransaction') throw new Error('payment fixture');
    r.args.params.maxTotalDebitAtoms = '100000311';
    mocks.cache.scan!.utxos[0].value = 100000511n;
    await expect(prepareApproval(r)).rejects.toThrow(/exceed Budget max/);
  });

  it('does not refresh or prepare a locked wallet', async () => {
    mocks.unlocked = false;
    await expect(prepareApproval(request())).rejects.toThrow(/Unlock/);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('rejects testnet and a different account before preparing a payment', async () => {
    mocks.loadMeta.mockResolvedValueOnce({ network: 'testnet', selectedAccountId: 'account-1' });
    await expect(prepareApproval(request())).rejects.toThrow(/mainnet/);
    mocks.loadMeta.mockResolvedValueOnce({ network: 'mainnet', selectedAccountId: 'account-2' });
    await expect(prepareApproval(request())).rejects.toThrow(/selected account changed/);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('rejects an account change during refresh', async () => {
    mocks.loadMeta.mockResolvedValueOnce({ network: 'mainnet', selectedAccountId: 'account-1' });
    mocks.loadMeta.mockResolvedValueOnce({ network: 'mainnet', selectedAccountId: 'account-2' });
    await expect(prepareApproval(request())).rejects.toThrow(/account, network or lock state changed/);
  });

  it('rejects a lock during refresh', async () => {
    mocks.refresh.mockImplementation(async () => { mocks.unlocked = false; mocks.cache.lastSync = Date.now(); });
    await expect(prepareApproval(request())).rejects.toThrow(/account, network or lock state changed/);
  });

  it('rejects stale or failed sync instead of approving cached coins', async () => {
    mocks.refresh.mockResolvedValue(undefined);
    await expect(prepareApproval(request())).rejects.toThrow(/could not refresh/);
    mocks.refresh.mockImplementation(async () => { mocks.cache.lastSync = Date.now(); mocks.cache.syncErr = 'offline'; });
    await expect(prepareApproval(request())).rejects.toThrow(/could not refresh/);
  });

  it('blocks a payment when name protection is unverified', async () => {
    mocks.cache.namesVerified = false;
    await expect(prepareApproval(request())).rejects.toThrow(/Name protection could not be verified/);
  });
  it('prepares missing recommendation payments with explicit fallback provenance', async () => {
    mocks.cache.feeVerified = false; mocks.cache.feeRate = null;
    mocks.cache.feePolicy = selectFeePolicy(null);
    expect(await prepareApproval(request())).toMatchObject({ kind: 'payment', feeRate: 2n, feeSource: 'fallback', quote: { amount: 100000001n, fee: 310n } });
  });
  it('enforces Budget max and name protection with fallback fees', async () => {
    mocks.cache.feePolicy = selectFeePolicy(null);
    const r = request();
    if (r.args.method !== 'sendTransaction') throw new Error('payment fixture');
    r.args.params.maxTotalDebitAtoms = '100000310';
    await expect(prepareApproval(r)).rejects.toThrow(/exceed Budget max/);
    mocks.cache.namesVerified = false;
    await expect(prepareApproval(request())).rejects.toThrow(/Name protection/);
  });
  it.each([null, selectFeePolicy({ recommendedFee: NaN }), selectFeePolicy({ recommendedFee: 20001 })])('blocks a payment with an unavailable policy: %j', async policy => {
    mocks.cache.feePolicy = policy;
    await expect(prepareApproval(request())).rejects.toThrow(/fee/i);
  });

  it('excludes protected coins even when the total balance could fund the payment', async () => {
    mocks.cache.protectedOutpoints.add(`${txid}:0`);
    await expect(prepareApproval(request())).rejects.toThrow(/Insufficient spendable PRL/);
  });

  it('prepares a connection while offline without refreshing coins or inspecting cache', async () => {
    mocks.cache.namesVerified = false;
    mocks.cache.scan = null;
    mocks.cache.syncErr = 'Explorer offline';
    mocks.refresh.mockRejectedValue(new Error('Network unavailable'));
    const preview = await prepareApproval(request('connect'));
    expect(preview).toEqual({ kind: 'connect', accountId: 'account-1', label: 'Public test account', address });
    expect(mocks.publicAccount).toHaveBeenCalledExactlyOnceWith('mainnet');
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.getCache).not.toHaveBeenCalled();
  });

  it.each([
    { network: 'mainnet', selectedAccountId: 'account-2' },
    { network: 'testnet', selectedAccountId: 'account-1' },
    null,
  ])('rejects changed account/network metadata after local address derivation: %j', async after => {
    mocks.loadMeta.mockResolvedValueOnce({ network: 'mainnet', selectedAccountId: 'account-1' }).mockResolvedValueOnce(after);
    await expect(prepareApproval(request('connect'))).rejects.toThrow(/account, network or lock state changed/);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('rejects a local address derived from a different account even if selection changed back', async () => {
    mocks.publicAccount.mockResolvedValue({ accountId: 'account-2', label: 'Other account', address });
    await expect(prepareApproval(request('connect'))).rejects.toThrow(/account, network or lock state changed/);
  });

  it('rejects a lock while deriving the connection address', async () => {
    mocks.publicAccount.mockImplementation(async () => {
      mocks.unlocked = false;
      return { accountId: 'account-1', label: 'Public test account', address };
    });
    await expect(prepareApproval(request('connect'))).rejects.toThrow(/account, network or lock state changed/);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('does not derive an address for a locked wallet or a testnet connection', async () => {
    mocks.unlocked = false;
    await expect(prepareApproval(request('connect'))).rejects.toThrow(/Unlock/);
    mocks.unlocked = true;
    mocks.loadMeta.mockResolvedValue({ network: 'testnet', selectedAccountId: 'account-1' });
    await expect(prepareApproval(request('connect'))).rejects.toThrow(/mainnet/);
    expect(mocks.publicAccount).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
