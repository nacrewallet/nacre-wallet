import { describe, expect, it, vi } from 'vitest';
import { RequestBroker, type BrokerState } from './broker';
import { NACRE_ORIGIN, type RequestArgs, type SiteIdentity } from './protocol';
import { BALANCE_TTL, type PublicBalance } from './balance-contract';
import { parsePrivateKey, privateKeyToAddress } from '@/pearl/wallet';

const owner: SiteIdentity = { origin: NACRE_ORIGIN, tabId: 5, windowId: 10, documentId: 'site-one' };
const toolbar = { windowId: 10, documentId: 'toolbar-one' };
const address = privateKeyToAddress(parsePrivateKey('2'.repeat(64)), 'mainnet');
const args: RequestArgs = { method: 'getBalance', params: { refresh: true } };

async function fixture() {
  let now = 100_000;
  let account: string | undefined = 'account-one';
  let stored: BrokerState | undefined;
  let seq = 0;
  const deps = { read: async () => structuredClone(stored), write: async (s: BrokerState) => { stored = structuredClone(s); },
    now: () => now, id: () => `request-${++seq}`, openApproval: vi.fn(async () => {}), accountId: vi.fn(async () => account) };
  const broker = new RequestBroker(deps);
  const c = await broker.create(owner, 'connect-client', { method: 'connect' });
  await broker.claim(toolbar);
  await broker.approveConnection(c.id, toolbar, { accountId: account!, address });
  const snapshot = (): PublicBalance => ({ address, network: 'pearl:mainnet', total: '200000000', spendable: '150000000', maxSend: '149999600', estimatedMaxFee: '400', updatedAt: now, namesVerified: true });
  const request = async () => { const r = await broker.create(owner, `balance-${++seq}`, args); await broker.claim(toolbar); return r; };
  const approve = async () => { const r = await request(); await broker.approveBalance(r.id, toolbar, account!, snapshot()); return r; };
  return { broker, deps, request, approve, snapshot, stored: () => stored!,
    advance: (ms: number) => { now += ms; }, setAccount: (next?: string) => { account = next; }, restart: () => new RequestBroker(deps) };
}

describe('explicit account balance permission', () => {
  it('never expands an existing address-only grant without consent', async () => {
    const f = await fixture();
    expect(await f.broker.balance(owner)).toBeNull();
    const r = await f.request();
    expect(await f.broker.balance(owner)).toBeNull();
    expect(f.stored().grants[owner.origin].balanceAccess).toBeUndefined();
    await f.broker.approveBalance(r.id, toolbar, 'account-one', f.snapshot());
    expect(await f.broker.balance(owner)).toEqual(f.snapshot());
    expect(await f.broker.status(owner, r.id)).toEqual({ pending: false, result: f.snapshot() });
    expect(await f.restart().balance(owner)).toEqual(f.snapshot());
  });
  it('does not disclose a snapshot to another origin or a changed account', async () => {
    const f = await fixture(); await f.approve();
    expect(await f.broker.balance({ ...owner, origin: 'https://other.example' })).toBeNull();
    f.setAccount('account-two');
    expect(await f.broker.balance(owner)).toBeNull();
    await expect(f.request()).rejects.toThrow(/Connect/);
  });
  it('returns null for stale snapshots, including old request status results', async () => {
    const f = await fixture(); const r = await f.approve();
    f.advance(BALANCE_TTL + 1);
    expect(await f.broker.balance(owner)).toBeNull();
    expect(await f.broker.status(owner, r.id)).toEqual({ pending: false, result: null });
  });
  it('removes access immediately on disconnect and does not revive it from a completed request', async () => {
    const f = await fixture(); const r = await f.approve();
    await f.broker.disconnect(owner);
    expect(await f.broker.balance(owner)).toBeNull();
    expect(await f.broker.status(owner, r.id)).toEqual({ pending: false, result: null });
  });
  it('does not replay completed balance data after all connections are revoked', async () => {
    const f = await fixture(); const r = await f.approve();
    await f.broker.revokeAll();
    expect(await f.restart().balance(owner)).toBeNull();
    expect(await f.broker.status(owner, r.id)).toEqual({ pending: false, result: null });
  });
  it.each(['account-two', undefined])('does not disclose persisted snapshots after worker restart with selected mainnet account %s', async accountId => {
    const f = await fixture(); const r = await f.approve();
    // Undefined is the background account resolver's result on testnet/removal.
    f.setAccount(accountId);
    const restarted = f.restart();
    expect(await restarted.balance(owner)).toBeNull();
    expect(await restarted.status(owner, r.id)).toEqual({ pending: false, result: null });
  });
  it('rejects consent from another toolbar document or after account changes', async () => {
    const f = await fixture(); const r = await f.request();
    await expect(f.broker.approveBalance(r.id, { ...toolbar, documentId: 'forged' }, 'account-one', f.snapshot())).rejects.toThrow(/does not own/);
    f.setAccount('account-two');
    await expect(f.broker.approveBalance(r.id, toolbar, 'account-one', f.snapshot())).rejects.toThrow(/changed/);
    expect(f.stored().grants[owner.origin].balanceAccess).toBeUndefined();
  });
  it('rejects a snapshot for another public address before granting permission', async () => {
    const f = await fixture(); const r = await f.request();
    const other = privateKeyToAddress(parsePrivateKey('3'.repeat(64)), 'mainnet');
    await expect(f.broker.approveBalance(r.id, toolbar, 'account-one', { ...f.snapshot(), address: other })).rejects.toThrow(/different connection/);
    expect(f.stored().grants[owner.origin].balanceAccess).toBeUndefined();
  });
  it('invalidates snapshot and pending balance work across account/lock changes', async () => {
    const f = await fixture(); await f.approve();
    const r = await f.request();
    await f.broker.invalidateBalances();
    expect(await f.broker.balance(owner)).toBeNull();
    await expect(f.broker.approveBalance(r.id, toolbar, 'account-one', f.snapshot())).rejects.toThrow(/no longer/);
  });
  it('blocks a result when invalidation arrives while the account read is pending', async () => {
    const f = await fixture(); await f.approve();
    let release!: (value: string) => void;
    f.deps.accountId.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const result = f.broker.balance(owner);
    for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
    expect(release).toBeTypeOf('function');
    const cleared = f.broker.invalidateBalances();
    release('account-one');
    expect(await result).toBeNull();
    await cleared;
  });
  it.each(['passive', 'status'])('blocks the %s snapshot if invalidated during the final asynchronous storage write', async operation => {
    const f = await fixture(); const request = await f.approve();
    const write = f.deps.write;
    let writes = 0;
    let release!: () => void;
    f.deps.write = async state => {
      await write(state);
      if (++writes === 2) await new Promise<void>(resolve => { release = resolve; });
    };
    const result = operation === 'passive' ? f.broker.balance(owner) : f.broker.status(owner, request.id);
    for (let i = 0; i < 30 && !release; i++) await Promise.resolve();
    expect(release).toBeTypeOf('function');
    const cleared = f.broker.invalidateBalances();
    release();
    expect(await result).toEqual(operation === 'passive' ? null : { pending: false, result: null });
    await cleared;
  });
  it('does not let balance approval grant transaction signing authority', async () => {
    const f = await fixture(); const r = await f.approve();
    await expect(f.broker.beginSigning(r.id, toolbar, 'account-one', '400')).rejects.toThrow(/no longer/);
    await expect(f.broker.beginBroadcast(r.id, toolbar, 'ab'.repeat(32))).rejects.toThrow(/no longer/);
  });
});
