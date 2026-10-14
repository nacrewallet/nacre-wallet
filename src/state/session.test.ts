import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  listener: undefined as undefined | ((c: Record<string, {newValue?: unknown}>, area: string) => void),
  deferSet: false, pendingSet: undefined as undefined | (() => void),
}));
const derivation = vi.hoisted(() => ({ derive: vi.fn() }));
vi.mock('@/pearl/wallet', () => ({ mnemonicToHDKey: derivation.derive }));
vi.stubGlobal('chrome', {
  storage: {
    onChanged: { addListener: (fn: typeof storage.listener) => { storage.listener = fn; } },
    local: { get: (_keys: unknown, cb: (v: unknown) => void) => cb({}) },
    session: {
      get: (_keys: unknown, cb: (v: unknown) => void) => cb({ ...storage.data }),
      set: (values: Record<string, unknown>, cb: () => void) => {
        const complete = () => { Object.assign(storage.data, values); cb(); };
        if (storage.deferSet) storage.pendingSet = complete;
        else complete();
      },
      remove: (keys: string[], cb: () => void) => { for (const key of keys) delete storage.data[key]; storage.listener?.({ 'pearl.session.mnemonic': {} }, 'session'); cb(); },
    },
  },
  alarms: { clear: async () => true, create: () => {} },
});
const session = await import('./session');
describe('open-popup key revocation', () => {
  beforeEach(async () => {
    await session.lock();
    storage.deferSet = false;
    storage.pendingSet = undefined;
    derivation.derive.mockReset().mockResolvedValue({ privateKey: new Uint8Array(32) });
  });
  it('revokes in-memory signer when the background auto-lock removes the session', async () => {
    await session.unlock('test-only-mocked-key');
    expect(session.isUnlocked()).toBe(true);
    delete storage.data['pearl.session.mnemonic'];
    storage.listener?.({ 'pearl.session.mnemonic': {} }, 'session');
    expect(session.getHD()).toBeNull();
    expect(session.getMnemonic()).toBeNull();
    expect(await session.restoreFromSession()).toBe(false);
  });
  it('does not revoke on unrelated storage events', async () => {
    await session.unlock('test-only-mocked-key');
    storage.listener?.({ 'pearl.theme': {newValue:'dark'} }, 'local');
    expect(session.isUnlocked()).toBe(true);
  });

  it('restores an unchanged stored session', async () => {
    storage.data['pearl.session.mnemonic'] = 'test-only-mocked-key';
    expect(await session.restoreFromSession()).toBe(true);
    expect(session.getMnemonic()).toBe('test-only-mocked-key');
  });

  it('does not restore keys when auto-lock removes the session during derivation', async () => {
    let complete!: (value: object) => void;
    derivation.derive.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    storage.data['pearl.session.mnemonic'] = 'test-only-mocked-key';
    const restoring = session.restoreFromSession();
    await Promise.resolve();
    expect(derivation.derive).toHaveBeenCalledOnce();
    delete storage.data['pearl.session.mnemonic'];
    storage.listener?.({ 'pearl.session.mnemonic': {} }, 'session');
    complete({ privateKey: new Uint8Array(32) });
    expect(await restoring).toBe(false);
    expect(session.getHD()).toBeNull();
    expect(session.getMnemonic()).toBeNull();
    expect(session.getUnlockedAt()).toBe(0);
  });

  it('revalidates storage even when its removal event has not arrived', async () => {
    let complete!: (value: object) => void;
    derivation.derive.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    storage.data['pearl.session.mnemonic'] = 'test-only-mocked-key';
    const restoring = session.restoreFromSession();
    await Promise.resolve();
    delete storage.data['pearl.session.mnemonic'];
    complete({ privateKey: new Uint8Array(32) });
    expect(await restoring).toBe(false);
    expect(session.isUnlocked()).toBe(false);
  });

  it('rejects an unlock completed after an explicit lock without persisting keys', async () => {
    let complete!: (value: object) => void;
    derivation.derive.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const unlocking = session.unlock('test-only-mocked-key');
    const rejected = expect(unlocking).rejects.toThrow(/interrupted/);
    await session.lock();
    complete({ privateKey: new Uint8Array(32) });
    await rejected;
    expect(session.getHD()).toBeNull();
    expect(session.getMnemonic()).toBeNull();
    expect(storage.data['pearl.session.mnemonic']).toBeUndefined();
  });

  it('clears a stale storage write that completes after the wallet was locked', async () => {
    storage.deferSet = true;
    const unlocking = session.unlock('test-only-mocked-key');
    const rejected = expect(unlocking).rejects.toThrow(/interrupted/);
    await Promise.resolve();
    expect(storage.pendingSet).toBeTypeOf('function');
    await session.lock();
    storage.pendingSet!();
    await rejected;
    expect(session.isUnlocked()).toBe(false);
    expect(storage.data['pearl.session.mnemonic']).toBeUndefined();
  });

  it('does not let an obsolete failed restore delete a newly unlocked session', async () => {
    let fail!: (reason: Error) => void;
    derivation.derive.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    storage.data['pearl.session.mnemonic'] = 'old-test-only-key';
    const restoring = session.restoreFromSession();
    await Promise.resolve();
    await session.unlock('new-test-only-key');
    fail(new Error('old derivation failed'));
    expect(await restoring).toBe(false);
    expect(session.getMnemonic()).toBe('new-test-only-key');
    expect(storage.data['pearl.session.mnemonic']).toBe('new-test-only-key');
  });
});
