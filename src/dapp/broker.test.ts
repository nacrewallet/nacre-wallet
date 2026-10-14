import { describe, expect, it, vi } from 'vitest';
import { RequestBroker, type BrokerState } from './broker';
import { NACRE_ORIGIN, REQUEST_TTL, type RequestArgs, type SiteIdentity } from './protocol';

const owner: SiteIdentity = { origin: NACRE_ORIGIN, tabId: 5, windowId: 10, documentId: 'document-one' };
const connectArgs: RequestArgs = { method: 'connect' };
const payment: RequestArgs = { method: 'sendTransaction', params: { to: 'validated-public-address', amount: '2.5', orderId: 'order-1' } };
const toolbar = { windowId: 10, documentId: 'toolbar-one' };
const txid = 'ab'.repeat(32);
function fixture() {
  let stored: BrokerState | undefined;
  let now = 100_000;
  let account: string | undefined = 'account-one';
  let sequence = 0;
  const open = vi.fn(async () => {});
  const deps = {
    read: async () => structuredClone(stored),
    write: async (value: BrokerState) => { stored = structuredClone(value); },
    now: () => now, id: () => 'request-id-number-' + ++sequence,
    openApproval: open, accountId: async () => account,
  };
  const broker = new RequestBroker(deps);
  const connect = async () => {
    const r = await broker.create(owner, 'client-connect-1', connectArgs);
    await broker.claim(toolbar);
    await broker.approveConnection(r.id, toolbar, { address: 'public-account-address', accountId: 'account-one' });
    return r;
  };
  const send = async () => { const r = await broker.create(owner, 'client-payment-1', payment); await broker.claim(toolbar); return r; };
  return { broker, connect, send, open, deps, stored: () => stored!, restart: () => new RequestBroker(deps), advance: (ms: number) => { now += ms; }, setAccount: (id?: string) => { account = id; } };
}

describe('durable, user-approved website requests', () => {
  it('distinguishes an ordinary wallet opening from a pending or expired website request', async () => {
    const f = fixture();
    expect(await f.broker.hasPendingApproval()).toBe(false);
    await f.broker.create(owner, 'client-idle-check', connectArgs);
    expect(await f.broker.hasPendingApproval()).toBe(true);
    f.advance(REQUEST_TTL);
    expect(await f.broker.hasPendingApproval()).toBe(false);
    expect(f.stored().requests[0].status).toBe('rejected');
  });
  it('reveals no account until the exact approval window explicitly approves', async () => {
    const f = fixture();
    expect(await f.broker.accounts(owner)).toEqual([]);
    const r = await f.broker.create(owner, 'client-connect-1', connectArgs);
    expect(await f.broker.accounts(owner)).toEqual([]);
    await f.broker.claim(toolbar);
    await expect(f.broker.approveConnection(r.id, { ...toolbar, windowId: 999 }, { address: 'public', accountId: 'account-one' })).rejects.toThrow('does not own');
    await f.broker.approveConnection(r.id, toolbar, { address: 'public', accountId: 'account-one' });
    expect(await f.broker.accounts(owner)).toEqual(['public']);
    expect(await f.broker.status(owner, r.id)).toEqual({ pending: false, result: ['public'] });
  });
  it('refuses payment before connection and on selected account/network change', async () => {
    const f = fixture();
    await expect(f.send()).rejects.toThrow('Connect');
    await f.connect(); f.setAccount('another-account');
    expect(await f.broker.accounts(owner)).toEqual([]);
    await expect(f.send()).rejects.toThrow('Connect');
    f.setAccount(undefined);
    expect(await f.broker.accounts(owner)).toEqual([]);
  });
  it('serializes concurrent request delivery and opens only one approval', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.broker.create(owner, 'client-connect-1', connectArgs), f.broker.create(owner, 'client-connect-1', connectArgs)]);
    expect(a).toEqual(b); expect(f.open).toHaveBeenCalledTimes(1);
    await expect(f.broker.create(owner, 'client-connect-1', payment)).rejects.toThrow('different parameters');
  });
  it('binds polling to origin, tab and document', async () => {
    const f = fixture(); const r = await f.connect();
    for (const other of [{ ...owner, origin: 'https://attacker.test' }, { ...owner, tabId: 6 }, { ...owner, documentId: 'new-document' }]) {
      await expect(f.broker.status(other, r.id)).rejects.toThrow('does not belong');
    }
  });
  it('resumes a pending connect on another click without replacing it or extending expiry', async () => {
    const f = fixture();
    const first = await f.broker.create(owner, 'first-click', connectArgs);
    const expiry = f.stored().requests[0].expiresAt;
    f.advance(1000);
    expect(await f.broker.create(owner, 'second-click', connectArgs)).toEqual(first);
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.stored().requests).toHaveLength(1);
    expect(f.stored().requests[0].expiresAt).toBe(expiry);
    await f.broker.claim(toolbar);
    await f.broker.approveConnection(first.id, toolbar, { address: 'public', accountId: 'account-one' });
    expect(await f.broker.status(owner, first.id)).toEqual({ pending: false, result: ['public'] });
  });
  it('does not let reconnect replace another page request or a pending payment', async () => {
    const f = fixture();
    await f.broker.create(owner, 'first-click', connectArgs);
    await expect(f.broker.create({ ...owner, documentId: 'another-page' }, 'other-click', connectArgs)).rejects.toThrow('in progress');
    await f.broker.disconnect(owner);
    await f.connect();
    await f.send();
    await expect(f.broker.create(owner, 'connect-during-payment', connectArgs)).rejects.toThrow('in progress');
  });
  it('deduplicates order IDs and rejects changing recipient or amount', async () => {
    const f = fixture(); await f.connect(); const r = await f.send();
    expect(await f.broker.create(owner, 'another-client-id', payment)).toEqual(r);
    await expect(f.broker.create(owner, 'replacement-client', { ...payment, params: { ...payment.params!, amount: '7' } })).rejects.toThrow('another payment');
    await expect(f.broker.create({ ...owner, documentId: 'reload' }, 'different-document', payment)).rejects.toThrow('already been requested');
  });

  it('clones a queued payment cap and binds it permanently to the request and order IDs', async () => {
    const f = fixture(); await f.connect();
    const args: RequestArgs = { method: 'sendTransaction', params: { ...payment.params!, maxTotalDebitAtoms: '250000155' } };
    const creating = f.broker.create(owner, 'capped-payment', args);
    args.params.maxTotalDebitAtoms = '999999999';
    const r = await creating; await f.broker.claim(toolbar);
    const saved = await f.broker.getApproval(r.id, toolbar);
    expect(saved.args.params).toHaveProperty('maxTotalDebitAtoms', '250000155');
    if (saved.args.method !== 'sendTransaction') throw new Error('payment fixture');
    saved.args.params.maxTotalDebitAtoms = '999999999';
    await expect(f.broker.create(owner, 'capped-payment', args)).rejects.toThrow(/different parameters/);
    await expect(f.broker.create(owner, 'another-id', args)).rejects.toThrow(/another payment/);
    await expect(f.broker.beginSigning(r.id, toolbar, 'account-one', '156')).rejects.toThrow(/exceed Budget max/);
    expect((await f.broker.getApproval(r.id, toolbar)).status).toBe('pending');
    const approved = await f.broker.beginSigning(r.id, toolbar, 'account-one', '155');
    expect(approved.maxTotalDebitAtoms).toBe('250000155');
    approved.maxTotalDebitAtoms = '999999999';
    expect((await f.broker.getApproval(r.id, toolbar)).args.params).toHaveProperty('maxTotalDebitAtoms', '250000155');
    await f.broker.beginBroadcast(r.id, toolbar, txid);
    expect(f.stored().requests.find(p => p.id === r.id)).toMatchObject({ status: 'broadcasting', fee: '155' });
  });

  it('an expired capped request cannot sign even when its amount still fits the cap', async () => {
    const f = fixture(); await f.connect();
    const args: RequestArgs = { method: 'sendTransaction', params: { ...payment.params!, maxTotalDebitAtoms: '250000155' } };
    const r = await f.broker.create(owner, 'capped-payment', args); await f.broker.claim(toolbar);
    f.advance(REQUEST_TTL);
    await expect(f.broker.beginSigning(r.id, toolbar, 'account-one', '155')).rejects.toThrow(/no longer/);
  });

  it('expiry during asynchronous account verification cannot grant signing or broadcasting', async () => {
    for (const phase of ['signing', 'broadcasting']) {
      const f = fixture(); await f.connect();
      const args: RequestArgs = { method: 'sendTransaction', params: { ...payment.params!, maxTotalDebitAtoms: '250000155' } };
      const r = await f.broker.create(owner, 'capped-payment', args); await f.broker.claim(toolbar);
      if (phase === 'broadcasting') await f.broker.beginSigning(r.id, toolbar, 'account-one', '155');
      f.deps.accountId = async () => { f.advance(REQUEST_TTL); return 'account-one'; };
      await expect(phase === 'signing' ? f.broker.beginSigning(r.id, toolbar, 'account-one', '155') : f.broker.beginBroadcast(r.id, toolbar, txid)).rejects.toThrow(/expired/);
      expect(f.stored().requests.find(item => item.id === r.id)?.status).not.toBe(phase);
    }
  });
  it('blocks simultaneous payments even under different order IDs', async () => {
    const f = fixture(); await f.connect(); await f.send();
    await expect(f.broker.create(owner, 'second-payment', { ...payment, params: { ...payment.params!, orderId: 'order-2' } })).rejects.toThrow('in progress');
  });
  it('expires persisted approval and refuses late signing', async () => {
    const f = fixture(); await f.connect(); const r = await f.send(); f.advance(REQUEST_TTL);
    await expect(f.broker.beginSigning(r.id, toolbar, 'account-one', '155')).rejects.toThrow('no longer');
    expect((await f.broker.status(owner, r.id)).error?.message).toContain('expired');
    expect(f.stored().requests.find(p => p.id === r.id)?.status).toBe('rejected');
  });
  it('rejects requests when their browser window closes or their website navigates', async () => {
    const f = fixture(); const r = await f.broker.create(owner, 'connect-client', connectArgs);
    await f.broker.windowClosed(10);
    expect((await f.broker.status(owner, r.id)).error?.code).toBe(4001);
    const next = await f.broker.create(owner, 'next-connect-client', connectArgs);
    await f.broker.documentClosed(owner.tabId);
    expect((await f.broker.status(owner, next.id)).error?.message).toContain('navigated');
  });
  it('restores a pending approval after worker restart with the same immutable payment', async () => {
    const f = fixture(); await f.connect(); const r = await f.send();
    const next = f.restart();
    expect((await next.getApproval(r.id, toolbar)).args).toEqual(payment);
    expect(await next.beginSigning(r.id, toolbar, 'account-one', '155')).toEqual(payment.params);
  });
  it('never resumes a signing operation after the worker restarts', async () => {
    const f = fixture(); await f.connect(); const r = await f.send();
    await f.broker.beginSigning(r.id, toolbar, 'account-one', '155');
    const next = f.restart();
    await expect(next.beginBroadcast(r.id, toolbar, txid)).rejects.toThrow('no longer authorized');
    expect((await next.status(owner, r.id)).error?.message).toContain('interrupted');
  });
  it('durably records broadcasting before submission, permits only one attempt and preserves uncertainty', async () => {
    const f = fixture(); await f.connect(); const r = await f.send();
    await f.broker.beginSigning(r.id, toolbar, 'account-one', '155');
    await f.broker.beginBroadcast(r.id, toolbar, txid);
    expect(f.stored().requests.find(p => p.id === r.id)).toMatchObject({ status: 'broadcasting', txid });
    await expect(f.broker.beginBroadcast(r.id, toolbar, txid)).rejects.toThrow('no longer authorized');
    const next = f.restart();
    const outcome = await next.status(owner, r.id);
    expect(outcome.error).toMatchObject({ code: -32002, data: { txid } });
    await expect(next.beginBroadcast(r.id, toolbar, txid)).rejects.toThrow('no longer authorized');
  });
  it('finishes a submitted payment even if its approval window closes', async () => {
    const f = fixture(); await f.connect(); const r = await f.send();
    await f.broker.beginSigning(r.id, toolbar, 'account-one', '155');
    await f.broker.beginBroadcast(r.id, toolbar, txid);
    await f.broker.popupClosed(toolbar.documentId); await f.broker.finishBroadcast(r.id, true);
    expect(await f.broker.status(owner, r.id)).toEqual({ pending: false, result: { txid } });
  });
  it('revocation cancels pending approvals and does not expose a stale account', async () => {
    const f = fixture(); await f.connect(); const r = await f.send();
    await f.broker.revoke(NACRE_ORIGIN);
    expect(await f.broker.accounts(owner)).toEqual([]);
    expect((await f.broker.status(owner, r.id)).error?.code).toBe(4001);
    await expect(f.broker.beginSigning(r.id, toolbar, 'account-one', '155')).rejects.toThrow('no longer');
  });
  it('wallet removal revokes all grants and pending requests', async () => {
    const f = fixture(); await f.connect(); const r = await f.send();
    await f.broker.revokeAll();
    expect(await f.broker.connections()).toEqual([]);
    expect((await f.broker.status(owner, r.id)).error?.message).toContain('removed');
  });
  it('persists before opening and keeps a request available when automatic opening is refused', async () => {
    const f = fixture();
    f.open.mockImplementationOnce(async () => {
      expect(f.stored().requests[0].status).toBe('pending');
      throw new Error('Browser policy refused openPopup');
    });
    const r = await f.broker.create(owner, 'manual-open-client', connectArgs);
    expect(f.open).toHaveBeenCalledWith(owner.windowId);
    expect(await f.broker.status(owner, r.id)).toEqual({ pending: true });
    expect(await f.broker.claim({ ...toolbar, windowId: 99 })).toBeNull();
    expect(await f.broker.claim(toolbar)).toBe(r.id);
    await f.broker.approveConnection(r.id, toolbar, { address: 'public', accountId: 'account-one' });
    expect(await f.broker.accounts(owner)).toEqual(['public']);
  });
  it('reopens a pending request and removes authority from the previous popup document', async () => {
    const f = fixture(); const r = await f.broker.create(owner, 'reopen-client', connectArgs);
    await f.broker.claim(toolbar);
    await f.broker.popupClosed(toolbar.documentId);
    expect(await f.broker.status(owner, r.id)).toEqual({ pending: true });
    const reopened = { ...toolbar, documentId: 'toolbar-two' };
    expect(await f.broker.claim(reopened)).toBe(r.id);
    await expect(f.broker.approveConnection(r.id, toolbar, { address: 'public', accountId: 'account-one' })).rejects.toThrow('does not own');
    await f.broker.popupClosed(toolbar.documentId);
    await f.broker.approveConnection(r.id, reopened, { address: 'public', accountId: 'account-one' });
  });
  it('cannot reopen signing after the popup closes and never submits it', async () => {
    const f = fixture(); await f.connect(); const r = await f.send();
    await f.broker.beginSigning(r.id, toolbar, 'account-one', '155');
    await f.broker.popupClosed(toolbar.documentId);
    expect(await f.broker.claim({ ...toolbar, documentId: 'toolbar-two' })).toBeNull();
    expect((await f.broker.status(owner, r.id)).error?.message).toContain('Signing was interrupted');
    await expect(f.broker.beginBroadcast(r.id, toolbar, txid)).rejects.toThrow('no longer authorized');
  });
  it('does not rebind or retry a broadcast when the toolbar is reopened', async () => {
    const f = fixture(); await f.connect(); const r = await f.send();
    await f.broker.beginSigning(r.id, toolbar, 'account-one', '155');
    await f.broker.beginBroadcast(r.id, toolbar, txid);
    await f.broker.popupClosed(toolbar.documentId);
    expect(await f.broker.claim({ ...toolbar, documentId: 'toolbar-two' })).toBeNull();
    expect(f.stored().requests.find(p => p.id === r.id)).toMatchObject({ status: 'broadcasting', txid });
    await expect(f.broker.beginBroadcast(r.id, toolbar, txid)).rejects.toThrow('no longer authorized');
    await f.broker.finishBroadcast(r.id, false);
    expect((await f.broker.status(owner, r.id)).error?.data).toEqual({ txid });
  });
  it('fails closed for a pending request saved by the old separate-window version', async () => {
    const f = fixture(); const r = await f.broker.create(owner, 'old-request-client', connectArgs);
    Reflect.deleteProperty(f.stored().requests[0].owner, 'windowId');
    const next = f.restart();
    expect(await next.claim(toolbar)).toBeNull();
    expect(f.stored().requests.find(p => p.id === r.id)?.error?.message).toContain('predates');
  });
});
