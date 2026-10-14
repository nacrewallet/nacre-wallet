import { describe, expect, it, vi } from 'vitest';
import { BALANCE_SCAN_TIMEOUT, RequestBroker, type BrokerState, type Connection } from './broker';
import { NACRE_ORIGIN, type SiteIdentity } from './protocol';
import type { PublicBalance } from './balance-contract';
import { parsePrivateKey, privateKeyToAddress } from '@/pearl/wallet';

const owner: SiteIdentity = { origin: NACRE_ORIGIN, tabId: 5, windowId: 10, documentId: 'site' };
const toolbar = { windowId: 10, documentId: 'toolbar' };
const address = privateKeyToAddress(parsePrivateKey('2'.repeat(64)), 'mainnet');
const watch = { kind: 'single' as const, address, context: 'trusted-popup-test-context' };
async function fixture(scoped = true) {
  let now = 100_000, sequence = 0, selected: string | undefined = 'account', unlocked = true;
  let stored: BrokerState | undefined;
  const snapshot = (): PublicBalance => ({ address, network: 'pearl:mainnet', total: '200000000', spendable: '200000000', maxSend: '199999600', estimatedMaxFee: '400', updatedAt: now, namesVerified: true });
  const deps = { read: async () => structuredClone(stored), write: vi.fn(async (state: BrokerState) => { stored = structuredClone(state); }),
    now: () => now, id: () => `request-${++sequence}`, openApproval: vi.fn(async () => {}), accountId: async () => selected,
    balanceAccountId: async () => unlocked ? selected : undefined, refreshBalance: vi.fn(async (_account: Connection, _signal: AbortSignal) => snapshot()) };
  const broker = new RequestBroker(deps);
  const connect = async (scope = true) => {
    const request = await broker.create(owner, `connect-${++sequence}`, { method: 'connect' });
    await broker.claim(toolbar);
    await broker.approveConnection(request.id, toolbar, { address, accountId: 'account', ...(scope ? { balanceAccess: true as const, balanceWatch: watch } : {}) });
  };
  await connect(scoped); deps.openApproval.mockClear();
  return { broker, deps, snapshot, connect, stored: () => stored!, advance: (ms: number) => { now += ms; },
    select: (id?: string) => { selected = id; }, lock: () => { unlocked = false; }, restart: () => new RequestBroker(deps) };
}

describe('automatic balances under explicit connection consent', () => {
  it('refreshes new data without opening the popup or allocating approval requests', async () => {
    const f = await fixture();
    expect(await f.broker.refreshBalance(owner)).toEqual(f.snapshot());
    f.advance(5_000);
    f.deps.refreshBalance.mockResolvedValueOnce({ ...f.snapshot(), total: '300000000' });
    expect(await f.broker.refreshBalance(owner)).toMatchObject({ total: '300000000', updatedAt: 105_000 });
    expect(f.stored().requests).toHaveLength(1);
    expect(f.deps.openApproval).not.toHaveBeenCalled();
    expect(await f.restart().balance(owner)).toMatchObject({ total: '300000000' });
  });
  it('does not silently upgrade old grants or open consent from polling; explicit connect upgrades once', async () => {
    const f = await fixture(false);
    await expect(f.broker.refreshBalance(owner)).rejects.toMatchObject({ code: 4100 });
    expect(f.deps.refreshBalance).not.toHaveBeenCalled(); expect(f.deps.openApproval).not.toHaveBeenCalled();
    await f.connect();
    expect(await f.broker.refreshBalance(owner)).toEqual(f.snapshot());
    expect(f.deps.openApproval).toHaveBeenCalledTimes(1);
  });
  it('rejects another origin, selected account or locked session without scanning', async () => {
    const f = await fixture();
    await expect(f.broker.refreshBalance({ ...owner, origin: 'https://other.example' })).rejects.toMatchObject({ code: 4100 });
    f.select('other'); await expect(f.broker.refreshBalance(owner)).rejects.toMatchObject({ code: 4100 });
    f.select('account'); f.lock(); await expect(f.broker.refreshBalance(owner)).rejects.toMatchObject({ code: 4100 });
    expect(f.deps.refreshBalance).not.toHaveBeenCalled(); expect(f.deps.openApproval).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent reads within one permitted origin', async () => {
    const f = await fixture(); let finish!: (value: PublicBalance) => void;
    f.deps.refreshBalance.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = f.broker.refreshBalance(owner), second = f.broker.refreshBalance({ ...owner, documentId: 'other-tab' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish(f.snapshot()); expect(await first).toEqual(await second); expect(f.deps.refreshBalance).toHaveBeenCalledTimes(1);
  });
  it.each(['lock', 'disconnect', 'reconnect', 'account'])('drops an in-flight result after %s and cannot revive it from cache', async event => {
    const f = await fixture(); let finish!: (value: PublicBalance) => void;
    f.deps.refreshBalance.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.broker.refreshBalance(owner);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (event === 'lock') { f.lock(); await f.broker.invalidateBalances(); }
    if (event === 'disconnect') await f.broker.disconnect(owner);
    if (event === 'reconnect') await f.connect();
    if (event === 'account') { f.select('other'); await f.broker.invalidateBalances(); f.select('account'); }
    finish(f.snapshot()); expect(await pending).toBeNull(); expect(await f.broker.balance(owner)).toBeNull();
  });
  it('rejects stale or wrong-account scan results and does not replace them with invented zeroes', async () => {
    const f = await fixture();
    f.deps.refreshBalance.mockResolvedValueOnce({ ...f.snapshot(), updatedAt: 0 });
    await expect(f.broker.refreshBalance(owner)).rejects.toThrow(/outdated/);
    f.deps.refreshBalance.mockResolvedValueOnce({ ...f.snapshot(), address: privateKeyToAddress(parsePrivateKey('3'.repeat(64)), 'mainnet') });
    await expect(f.broker.refreshBalance(owner)).rejects.toThrow(/another account/);
    expect(await f.broker.balance(owner)).toBeNull();
  });
  it('suppresses a refreshed result invalidated during its final storage write', async () => {
    const f = await fixture(); const write = f.deps.write.getMockImplementation()!;
    let release!: () => void, writes = 0;
    f.deps.write.mockImplementation(async state => {
      await write(state);
      if (++writes === 4) await new Promise<void>(resolve => { release = resolve; });
    });
    const result = f.broker.refreshBalance(owner);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.lock(); const cleared = f.broker.invalidateBalances();
    release(); expect(await result).toBeNull(); await cleared;
    expect(await f.broker.balance(owner)).toBeNull();
  });
  it('cannot bypass payment approval and refuses refreshing during a pending payment', async () => {
    const f = await fixture(); await f.broker.refreshBalance(owner);
    const payment = await f.broker.create(owner, 'payment', { method: 'sendTransaction', params: { to: address, amount: '1' } });
    await expect(f.broker.beginBroadcast(payment.id, toolbar, 'a'.repeat(64))).rejects.toThrow();
    await expect(f.broker.refreshBalance(owner)).rejects.toMatchObject({ code: -32002 });
    expect(f.deps.refreshBalance).toHaveBeenCalledTimes(1);
  });
  it('times out an entire stalled scan, permits retry and ignores its late result', async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture(); let release!: (snapshot: PublicBalance) => void, signal!: AbortSignal;
      f.deps.refreshBalance.mockImplementationOnce((_account, cancellation) => { signal = cancellation; return new Promise(resolve => { release = resolve; }); });
      const first = f.broker.refreshBalance(owner);
      const failure = expect(first).rejects.toMatchObject({ code: -32000 });
      await vi.advanceTimersByTimeAsync(BALANCE_SCAN_TIMEOUT);
      await failure;
      expect(signal.aborted).toBe(true);
      expect(await f.broker.balance(owner)).toBeNull();
      f.deps.refreshBalance.mockResolvedValueOnce({ ...f.snapshot(), total: '300000000' });
      expect(await f.broker.refreshBalance(owner)).toMatchObject({ total: '300000000' });
      release({ ...f.snapshot(), total: '400000000' });
      await vi.advanceTimersByTimeAsync(0);
      expect(await f.broker.balance(owner)).toMatchObject({ total: '300000000' });
      expect(f.deps.refreshBalance).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.deps.openApproval).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
