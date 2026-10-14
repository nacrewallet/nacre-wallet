import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletScan } from '@/pearl/hdwallet';
import type { PendingRequest } from './broker';
import { parsePrivateKey, privateKeyToAddress } from '@/pearl/wallet';
import { buildAndSignTx, importedSigner, quoteSend } from '@/pearl/transaction';
import { formatPearlAmount } from '@/pearl/money';
import { selectFeePolicy, type FeePolicyResult } from '@/pearl/fee-policy';

const mocks = vi.hoisted(() => ({
  unlocked: true, loadMeta: vi.fn(), refresh: vi.fn(), publicAccount: vi.fn(),
  cache: {} as { account: { id: string; label: string } | null; network: string | null; scan: WalletScan | null;
    namesVerified: boolean; protectedOutpoints: Set<string>; feeRate: number | null; feeVerified: boolean; feePolicy: FeePolicyResult | null; lastSync: number; syncErr: string | null },
}));
vi.mock('@/state/session', () => ({ isUnlocked: () => mocks.unlocked }));
vi.mock('@/state/accounts', () => ({ currentPublicAccount: mocks.publicAccount }));
vi.mock('@/state/walletState', () => ({ getCache: () => mocks.cache, refreshWallet: mocks.refresh }));
vi.mock('@/storage/vault', () => ({ loadMeta: mocks.loadMeta }));
import { prepareBalance } from './balance';
import { prepareApproval } from './payment';

const address = privateKeyToAddress(parsePrivateKey('2'.repeat(64)), 'mainnet');
const txids = ['a', 'b', 'c'].map(c => c.repeat(64));
const request = (): PendingRequest => ({ id: 'balance-request', clientId: 'balance-client',
  owner: { origin: 'https://nacre.finance', tabId: 1, windowId: 1, documentId: 'site' },
  args: { method: 'getBalance', params: { refresh: true } }, account: { accountId: 'account-1', address },
  status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 60_000 });

describe('complete account balance and estimated MAX preview', () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.unlocked = true;
    mocks.loadMeta.mockResolvedValue({ network: 'mainnet', selectedAccountId: 'account-1' });
    mocks.publicAccount.mockResolvedValue({ accountId: 'account-1', label: 'Test account', address });
    mocks.cache = { account: { id: 'account-1', label: 'Test account' }, network: 'mainnet',
      scan: { balance: 240_000_000n,
        utxos: [150_000_000n, 80_000_000n, 10_000_000n].map((value, i) => ({ txid: txids[i], vout: 0, value, address, chain: i === 1 ? 1 : 0, index: i, blockHeight: 1 })),
        addresses: [], receiveAddress: address, receiveIndex: 4, nextChangeAddress: address, nextChangeIndex: 2 },
      namesVerified: true, protectedOutpoints: new Set([`${txids[2]}:0`]), feeRate: 2, feeVerified: true, feePolicy: selectFeePolicy({ recommendedFee: 2 }), lastSync: 0, syncErr: null };
    mocks.refresh.mockImplementation(async () => { mocks.cache.lastSync = Date.now(); });
  });

  it('includes receive/change funds, excludes name coins and reserves the fixed-payment two-output fee', async () => {
    const preview = await prepareBalance(request());
    expect(preview.snapshot).toMatchObject({ address, network: 'pearl:mainnet', total: '240000000', spendable: '230000000', maxSend: '229999574', estimatedMaxFee: '426', namesVerified: true });
    expect(preview.snapshot).toMatchObject({ feeRate: '2', feeSource: 'network' });
    expect(Object.keys(preview.snapshot).sort()).toEqual(['address', 'estimatedMaxFee', 'feeRate', 'feeSource', 'maxSend', 'namesVerified', 'network', 'spendable', 'total', 'updatedAt']);
  });
  it('keeps atomic amounts exact above Number.MAX_SAFE_INTEGER', async () => {
    mocks.cache.scan!.balance = 9_007_199_254_740_993n;
    mocks.cache.scan!.utxos = [{ ...mocks.cache.scan!.utxos[0], value: mocks.cache.scan!.balance }];
    const { snapshot } = await prepareBalance(request());
    expect(snapshot.total).toBe('9007199254740993');
    expect(snapshot.maxSend).toBe('9007199254740683');
  });
  it('uses the advertised MAX unchanged through website review and signing with public fixture keys', async () => {
    const { snapshot } = await prepareBalance(request());
    const amount = BigInt(snapshot.maxSend!);
    const payment = await prepareApproval({ ...request(), args: { method: 'sendTransaction', params: { to: address, amount: formatPearlAmount(amount) } } });
    if (payment.kind !== 'payment') throw new Error('Expected payment preview.');
    expect(payment.quote).toMatchObject({ ok: true, amount, fee: BigInt(snapshot.estimatedMaxFee!), change: 0n, inputCount: 2 });
    const built = buildAndSignTx({ signer: importedSigner(parsePrivateKey('2'.repeat(64)), 'mainnet'), network: 'mainnet', recipient: address,
      amount, utxos: payment.scan.utxos, protectedOutpoints: payment.protectedOutpoints, changeAddress: address, feeRate: payment.feeRate });
    expect(built.feeGrains).toBe(payment.quote.fee);
    expect(built.inputCount).toBe(2);
    expect(built.changeGrains).toBe(0n);
    const formerMax = quoteSend({ utxos: payment.scan.utxos, protectedOutpoints: payment.protectedOutpoints, amount: 0n, sendMax: true, feeRate: payment.feeRate });
    expect(quoteSend({ utxos: payment.scan.utxos, protectedOutpoints: payment.protectedOutpoints, amount: formerMax.amount, feeRate: payment.feeRate }).ok).toBe(false);
  });
  it('does not reduce a previously advertised amount when fees increase or spendable coins disappear', async () => {
    const { snapshot } = await prepareBalance(request());
    const payment: PendingRequest = { ...request(), args: { method: 'sendTransaction', params: { to: address, amount: formatPearlAmount(BigInt(snapshot.maxSend!)) } } };
    mocks.cache.feeRate = 3; mocks.cache.feePolicy = selectFeePolicy({ recommendedFee: 3 });
    await expect(prepareApproval(payment)).rejects.toThrow(/Insufficient/);
    mocks.cache.feeRate = 2; mocks.cache.feePolicy = selectFeePolicy({ recommendedFee: 2 }); mocks.cache.protectedOutpoints.add(`${txids[1]}:0`);
    await expect(prepareApproval(payment)).rejects.toThrow(/Insufficient/);
    if (payment.args.method !== 'sendTransaction') throw new Error('Expected payment request.');
    expect(payment.args.params.amount).toBe('2.29999574');
  });
  it('does not label unverified name protection as spendable funds', async () => {
    mocks.cache.namesVerified = false;
    expect((await prepareBalance(request())).snapshot).toMatchObject({ total: '240000000', spendable: null, maxSend: null, estimatedMaxFee: null, namesVerified: false });
  });
  it('uses the same explicit fallback for public MAX and a capped exact payment', async () => {
    mocks.cache.feeVerified = false; mocks.cache.feeRate = null;
    mocks.cache.feePolicy = selectFeePolicy(null);
    const { snapshot } = await prepareBalance(request());
    expect(snapshot).toMatchObject({ spendable: '230000000', maxSend: '229999574', estimatedMaxFee: '426', feeRate: '2', feeSource: 'fallback' });
    const payment = await prepareApproval({ ...request(), args: { method: 'sendTransaction', params: {
      to: address, amount: formatPearlAmount(BigInt(snapshot.maxSend!)), maxTotalDebitAtoms: snapshot.spendable!,
    } } });
    if (payment.kind !== 'payment') throw new Error('Expected payment preview.');
    expect(payment).toMatchObject({ feeRate: 2n, feeSource: 'fallback', quote: { ok: true, amount: 229999574n, fee: 426n, change: 0n } });
    expect(payment.scan.utxos.filter(u => !payment.protectedOutpoints.has(`${u.txid}:${u.vout}`))).toHaveLength(2);
  });
  it('keeps MAX unavailable when a malformed fee input blocks the policy', async () => {
    mocks.cache.feePolicy = selectFeePolicy({ recommendedFee: NaN });
    expect((await prepareBalance(request())).snapshot).toMatchObject({ spendable: '230000000', maxSend: null, estimatedMaxFee: null, feeRate: null, feeSource: null });
  });
  it('rechecks a previously advertised fallback MAX against a newly available higher recommendation', async () => {
    mocks.cache.feePolicy = selectFeePolicy(null);
    const { snapshot } = await prepareBalance(request());
    mocks.cache.feePolicy = selectFeePolicy({ recommendedFee: 3 });
    await expect(prepareApproval({ ...request(), args: { method: 'sendTransaction', params: {
      to: address, amount: formatPearlAmount(BigInt(snapshot.maxSend!)), maxTotalDebitAtoms: snapshot.spendable!,
    } } })).rejects.toThrow(/Insufficient/);
  });
  it('represents a verified empty account as zero without a phantom send fee', async () => {
    mocks.cache.scan!.balance = 0n; mocks.cache.scan!.utxos = [];
    expect((await prepareBalance(request())).snapshot).toMatchObject({ total: '0', spendable: '0', maxSend: '0', estimatedMaxFee: '0' });
  });
  it('rejects a failed or outdated scan instead of sharing stale data', async () => {
    mocks.refresh.mockResolvedValue(undefined);
    await expect(prepareBalance(request())).rejects.toThrow(/Balance unavailable/);
    mocks.refresh.mockImplementation(async () => { mocks.cache.lastSync = Date.now(); mocks.cache.syncErr = 'incomplete scan'; });
    await expect(prepareBalance(request())).rejects.toThrow(/Balance unavailable/);
  });
  it.each([
    () => { mocks.unlocked = false; },
    () => { mocks.cache.account = { id: 'account-2', label: 'Other' }; },
    () => { mocks.cache.network = 'testnet'; },
    () => { mocks.loadMeta.mockResolvedValue({ network: 'mainnet', selectedAccountId: 'account-2' }); },
  ])('rejects wallet state changes during the scan', async change => {
    mocks.refresh.mockImplementation(async () => { mocks.cache.lastSync = Date.now(); change(); });
    await expect(prepareBalance(request())).rejects.toThrow(/state changed/);
  });
  it('requires an existing connection and an unlocked mainnet account', async () => {
    await expect(prepareBalance({ ...request(), account: undefined })).rejects.toThrow(/Connect/);
    mocks.unlocked = false;
    await expect(prepareBalance(request())).rejects.toThrow(/Unlock/);
    mocks.unlocked = true; mocks.loadMeta.mockResolvedValue({ network: 'testnet', selectedAccountId: 'account-1' });
    await expect(prepareBalance(request())).rejects.toThrow(/Reconnect/);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
