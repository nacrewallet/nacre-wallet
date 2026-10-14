import { afterEach, describe, expect, it, vi } from 'vitest';

const extensionId = 'a'.repeat(32);
const popupUrl = `chrome-extension://${extensionId}/src/popup/index.html`;
const origin = 'https://nacre.finance';
const popup: chrome.runtime.MessageSender = { id: extensionId, url: popupUrl, origin: `chrome-extension://${extensionId}` };
const site: chrome.runtime.MessageSender = { id: extensionId, url: `${origin}/`, origin,
  documentId: 'website-document', frameId: 0, tab: { id: 42, windowId: 8 } as chrome.tabs.Tab };
type Values = Record<string, unknown>;
type Changes = Record<string, chrome.storage.StorageChange>;

function event() { return { addListener: vi.fn() }; }

// Browser APIs are the only stubbed boundary. Vault encryption, session keys,
// public-address derivation, popup client, identity checks and broker are real.
function fixture() {
  const onChanged = event();
  const emit = (changes: Changes, area: string) => {
    for (const [listener] of onChanged.addListener.mock.calls) {
      (listener as (changes: Changes, area: string) => void)(changes, area);
    }
  };
  const storage = (area: string) => {
    const data: Values = {};
    return {
      setAccessLevel: vi.fn(async () => {}),
      get: vi.fn((keys: string | string[] | null, callback?: (result: Values) => void) => {
        const selected = keys === null ? Object.keys(data) : typeof keys === 'string' ? [keys] : keys;
        const result: Values = {};
        for (const key of selected) if (key in data) result[key] = structuredClone(data[key]);
        callback?.(result);
        return Promise.resolve(result);
      }),
      set: vi.fn((patch: Values, callback?: () => void) => {
        const changes: Changes = {};
        for (const [key, value] of Object.entries(patch)) {
          changes[key] = { oldValue: structuredClone(data[key]), newValue: structuredClone(value) };
          data[key] = structuredClone(value);
        }
        emit(changes, area);
        callback?.();
        return Promise.resolve();
      }),
      remove: vi.fn((keys: string | string[], callback?: () => void) => {
        const changes: Changes = {};
        for (const key of typeof keys === 'string' ? [keys] : keys) {
          if (key in data) { changes[key] = { oldValue: structuredClone(data[key]) }; delete data[key]; }
        }
        emit(changes, area);
        callback?.();
        return Promise.resolve();
      }),
    };
  };
  const contexts = [{ contextType: 'POPUP', documentId: 'native-popup-document', documentUrl: popupUrl,
    documentOrigin: `chrome-extension://${extensionId}`, frameId: 0, tabId: -1, windowId: -1 }] as chrome.runtime.ExtensionContext[];
  const browser = {
    runtime: {
      id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      getManifest: () => ({ content_scripts: [{}] }), getContexts: vi.fn(async () => contexts),
      onMessage: event(), onConnect: event(),
      sendMessage: vi.fn((message: unknown): Promise<Values> => dispatch(message, popup)),
    },
    storage: { local: storage('local'), session: storage('session'), onChanged },
    // The native action bubble owns OS focus, so its parent reports false.
    windows: { get: vi.fn(async (id: number) => ({ id, focused: false })),
      getLastFocused: vi.fn(async () => ({ id: 8, focused: false })), onRemoved: event() },
    tabs: { onUpdated: event(), onRemoved: event() },
    alarms: { clear: vi.fn(async () => true), create: vi.fn(async () => {}), onAlarm: event() },
    action: { openPopup: vi.fn(async () => {}), setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}), setTitle: vi.fn(async () => {}) },
  };
  function dispatch(message: unknown, sender: chrome.runtime.MessageSender): Promise<Values> {
    const listener = browser.runtime.onMessage.addListener.mock.calls[0]?.[0] as
      (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: Values) => void) => boolean;
    return new Promise((resolve, reject) => {
      if (!listener || !listener(message, sender, resolve)) reject(new Error('The background did not handle this message.'));
    });
  }
  return { browser, dispatch };
}

describe('real local wallet connection across popup and background', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shares only the public account after explicit consent, offline with native-popup focus and metadata', async () => {
    vi.resetModules();
    const { browser, dispatch } = fixture();
    const network = vi.fn(async () => { throw new Error('No network or broadcast is permitted by this test.'); });
    vi.stubGlobal('chrome', browser);
    vi.stubGlobal('fetch', network);
    await import('./index');
    const { createWallet, unlockMnemonic, loadMeta } = await import('@/storage/vault');
    const { unlock, isUnlocked, getHD } = await import('@/state/session');
    const { claimApproval, readApproval, approvalCall } = await import('@/dapp/approval-client');
    const { prepareApproval } = await import('@/dapp/payment');
    const { deriveAddress } = await import('@/pearl/wallet');

    // Public BIP-39 vector in an isolated in-memory vault; no user data loaded.
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const password = 'public-test-only-password';
    await createWallet({ mnemonic, password, network: 'mainnet' });
    const recovered = await unlockMnemonic(password);
    expect(recovered).toBe(mnemonic);
    await unlock(recovered!);
    expect(isUnlocked()).toBe(true);
    const meta = await loadMeta();
    const expectedAddress = deriveAddress(getHD()!, 0, 0, 'mainnet').address;
    const accounts = () => dispatch({ type: 'nacre:request', clientId: 'accounts_client_0123456789', args: { method: 'getAccounts' } }, site);

    expect(await accounts()).toEqual({ ok: true, result: [] });
    const created = await dispatch({ type: 'nacre:request', clientId: 'connect_client_0123456789', args: { method: 'connect' } }, site);
    expect(created.ok).toBe(true);
    expect(browser.action.openPopup).toHaveBeenCalledExactlyOnceWith({ windowId: 8 });
    expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '1' });

    const requestId = await claimApproval();
    expect(requestId).toBe(created.requestId);
    const pending = await readApproval(requestId!);
    expect(pending.status).toBe('pending');
    const preview = await prepareApproval(pending);
    expect(preview).toEqual({ kind: 'connect', accountId: meta!.selectedAccountId, label: 'Account 1', address: expectedAddress });
    // Loading the review and deriving an address are not website authorization.
    expect(await accounts()).toEqual({ ok: true, result: [] });
    expect(await dispatch({ type: 'nacre:status', requestId }, site)).toEqual({ ok: true, value: { pending: true } });

    await approvalCall(requestId!, 'connect', { accountId: preview.accountId, address: preview.address });
    expect(await dispatch({ type: 'nacre:status', requestId }, site)).toEqual({ ok: true, value: { pending: false, result: [expectedAddress] } });
    expect(await accounts()).toEqual({ ok: true, result: [expectedAddress] });
    expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
    expect(await claimApproval()).toBeNull();
    expect(browser.windows.getLastFocused).toHaveBeenCalled();
    expect(browser.runtime.sendMessage.mock.calls.some(([message]) =>
      typeof message === 'object' && message !== null && 'action' in message && ['sign', 'broadcast'].includes(String(message.action)))).toBe(false);
    expect(network).not.toHaveBeenCalled();
  });

  it('shares fresh full-account balances after one connection consent, without more prompts, excluding name coins from MAX', async () => {
    vi.resetModules();
    const { browser, dispatch } = fixture();
    vi.stubGlobal('chrome', browser);
    const coins = new Map<string, Array<{ txid: string; vout: number; value: string; blockHeight: number }>>();
    const protectedTxid = 'c'.repeat(64);
    let protectedAddress = '';
    const network = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/explorer/scan') {
        const { addresses } = JSON.parse(String(init?.body)) as { addresses: string[] };
        return Response.json({ results: addresses.map(address => {
          const utxos = coins.get(address) ?? [];
          return { address, used: utxos.length > 0, balance: utxos.reduce((sum, coin) => sum + BigInt(coin.value), 0n).toString(), utxos };
        }) });
      }
      if (url.pathname === '/api/explorer/pns') return Response.json({ names: url.searchParams.get('address') === protectedAddress
        ? [{ name: 'test-only.pns', owned: true, inscTxid: protectedTxid, inscVout: 0 }] : [] });
      if (url.pathname === '/api/explorer/stats') return Response.json({ recommendedFee: 2 });
      if (url.pathname === '/api/explorer/price') return Response.json({ price: null });
      if (url.pathname === '/api/explorer/wallet-history') return Response.json({ transactions: [] });
      throw new Error(`Unexpected network request; broadcasts are forbidden: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', network);
    await import('./index');
    const { createWallet } = await import('@/storage/vault');
    const { unlock, getHD } = await import('@/state/session');
    const { claimApproval, readApproval, approvalCall } = await import('@/dapp/approval-client');
    const { prepareApproval } = await import('@/dapp/payment');
    const { deriveAddress } = await import('@/pearl/wallet');
    const { currentBalanceWatch } = await import('@/state/accounts');

    // Only public test-vector keys and synthetic UTXOs exist in this fixture.
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await createWallet({ mnemonic, password: 'public-test-only-password', network: 'mainnet' });
    await unlock(mnemonic);
    const address = deriveAddress(getHD()!, 0, 0, 'mainnet').address;
    const changeAddress = deriveAddress(getHD()!, 1, 0, 'mainnet').address;
    protectedAddress = deriveAddress(getHD()!, 0, 1, 'mainnet').address;
    coins.set(address, [{ txid: 'a'.repeat(64), vout: 0, value: '200000000', blockHeight: 100 }]);
    coins.set(changeAddress, [{ txid: 'b'.repeat(64), vout: 0, value: '30000000', blockHeight: 100 }]);
    coins.set(protectedAddress, [{ txid: protectedTxid, vout: 0, value: '10000000', blockHeight: 100 }]);
    const balance = () => dispatch({ type: 'nacre:request', clientId: 'balance_read_0123456789', args: { method: 'getBalance' } }, site);
    expect(await balance()).toEqual({ ok: true, result: null });
    expect(browser.action.openPopup).not.toHaveBeenCalled();

    const connection = await dispatch({ type: 'nacre:request', clientId: 'balance_connect_0123456789', args: { method: 'connect' } }, site);
    const connectionId = await claimApproval();
    expect(connectionId).toBe(connection.requestId);
    const localAccount = await prepareApproval(await readApproval(connectionId!));
    const balanceWatch = await currentBalanceWatch(localAccount.accountId, localAccount.address);
    await approvalCall(connectionId!, 'connect', { accountId: localAccount.accountId, address: localAccount.address, balanceAccess: true, balanceWatch });
    expect(network).not.toHaveBeenCalled();
    expect(await balance()).toEqual({ ok: true, result: null });

    const refresh = () => dispatch({ type: 'nacre:request', clientId: 'balance_refresh_0123456789', args: { method: 'getBalance', params: { refresh: true } } }, site);
    const created = await refresh();
    expect(created).toEqual({ ok: true, result: { address, network: 'pearl:mainnet', total: '240000000', spendable: '230000000',
      maxSend: '229999574', estimatedMaxFee: '426', feeRate: '2', feeSource: 'network', updatedAt: expect.any(Number), namesVerified: true } });
    expect(await balance()).toEqual(created);
    coins.set(address, [{ txid: 'd'.repeat(64), vout: 0, value: '250000000', blockHeight: 101 }]);
    expect(await refresh()).toMatchObject({ ok: true, result: { total: '290000000', spendable: '280000000', maxSend: '279999574' } });
    expect(browser.action.openPopup).toHaveBeenCalledTimes(1);
    expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
    expect(await claimApproval()).toBeNull();

    await dispatch({ type: 'nacre:request', clientId: 'balance_disconnect_0123456789', args: { method: 'disconnect' } }, site);
    expect(await balance()).toEqual({ ok: true, result: null });
    expect(await refresh()).toMatchObject({ ok: false, error: { code: 4100 } });
    expect(browser.action.openPopup).toHaveBeenCalledTimes(1);
    expect(network.mock.calls.some(([url]) => String(url).includes('/broadcast'))).toBe(false);
    expect(browser.runtime.sendMessage.mock.calls.some(([message]) =>
      typeof message === 'object' && message !== null && 'action' in message && ['sign', 'broadcast'].includes(String(message.action)))).toBe(false);
  });
});
