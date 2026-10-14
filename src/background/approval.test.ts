import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NACRE_ORIGIN } from '@/dapp/protocol';
import { parsePrivateKey, privateKeyToAddress } from '@/pearl/wallet';

const extensionId = 'a'.repeat(32);
const popupUrl = `chrome-extension://${extensionId}/src/popup/index.html`;
const address = privateKeyToAddress(parsePrivateKey('2'.repeat(64)), 'mainnet');
const site: chrome.runtime.MessageSender = { id: extensionId, frameId: 0, documentId: 'site-document',
  url: `${NACRE_ORIGIN}/`, origin: NACRE_ORIGIN, tab: { id: 42, windowId: 8 } as chrome.tabs.Tab };
const popupDocumentId = 'toolbar-document';
const popup: chrome.runtime.MessageSender = { id: extensionId, url: popupUrl, origin: `chrome-extension://${extensionId}` };

function event() { return { addListener: vi.fn() }; }
function storage(initial: Record<string, unknown> = {}) {
  const values = structuredClone(initial);
  return {
    setAccessLevel: vi.fn(async () => {}),
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(values[key]) })),
    set: vi.fn(async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); }),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
}
function fixture() {
  const contexts = [{ contextType: 'POPUP', documentId: popupDocumentId, documentUrl: popupUrl,
    frameId: 0, tabId: -1, windowId: -1 }] as chrome.runtime.ExtensionContext[];
  return {
    runtime: { id: extensionId, getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      getContexts: vi.fn(async () => contexts), getManifest: () => ({ content_scripts: [{}] }), onMessage: event(), onConnect: event() },
    windows: { get: vi.fn(async (id: number) => ({ id, focused: true })),
      // Native popup owns OS focus; parent browser can report false throughout.
      getLastFocused: vi.fn(async () => ({ id: 8, focused: false })), onRemoved: event() },
    tabs: { onRemoved: event(), onUpdated: event() },
    action: { openPopup: vi.fn(async () => {}), setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}), setTitle: vi.fn(async () => {}) },
    storage: { local: storage({ 'pearlchain.wallet.meta': { network: 'mainnet', selectedAccountId: 'account-1' } }),
      session: storage({ 'pearl.session.mnemonic': 'test-session-placeholder' }), onChanged: event() },
    alarms: { create: vi.fn(async () => {}), onAlarm: event() },
  };
}

describe('background connection approval with Chromium popup metadata', () => {
  let browser: ReturnType<typeof fixture>;
  let message: (data: unknown, sender: chrome.runtime.MessageSender) => Promise<Record<string, unknown>>;
  beforeEach(async () => {
    vi.resetModules();
    browser = fixture();
    vi.stubGlobal('chrome', browser);
    await import('./index');
    const listener = browser.runtime.onMessage.addListener.mock.calls[0][0] as
      (data: unknown, sender: chrome.runtime.MessageSender, response: (value: Record<string, unknown>) => void) => boolean;
    message = (data, sender) => new Promise(resolve => { listener(data, sender, resolve); });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('completes a connection with popup-owned focus and no sender document/frame/tab metadata', async () => {
    const created = await message({ type: 'nacre:request', clientId: 'client_0123456789', args: { method: 'connect' } }, site);
    expect(created.ok).toBe(true);
    expect(browser.action.openPopup).toHaveBeenCalledWith({ windowId: 8 });
    expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '1' });
    expect(await message({ type: 'nacre:claim-approval' }, popup)).toEqual({ ok: true, value: created.requestId });
    const review = await message({ type: 'nacre:approval', requestId: created.requestId, action: 'read' }, popup);
    expect(review).toMatchObject({ ok: true, value: { args: { method: 'connect' }, owner: { origin: NACRE_ORIGIN, windowId: 8 } } });
    expect(await message({ type: 'nacre:approval', requestId: created.requestId, action: 'connect', address, accountId: 'account-1' }, popup)).toEqual({ ok: true });
    expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
    expect(await message({ type: 'nacre:status', requestId: created.requestId }, site)).toEqual({ ok: true, value: { pending: false, result: [address] } });
  });

  it('opens an idle wallet without checking popup capability or showing a website error', async () => {
    browser.runtime.getContexts.mockRejectedValue(new Error('API unavailable'));
    expect(await message({ type: 'nacre:claim-approval' }, popup)).toEqual({ ok: true, value: null });
    expect(browser.runtime.getContexts).not.toHaveBeenCalled();
  });

  it('clears the discovery error after the pending request expires', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await message({ type: 'nacre:request', clientId: 'client_0123456789', args: { method: 'connect' } }, site);
      browser.runtime.getContexts.mockRejectedValue(new Error('API unavailable'));
      expect(await message({ type: 'nacre:claim-approval' }, popup)).toMatchObject({ ok: false });
      browser.runtime.getContexts.mockClear();
      clock.mockReturnValue(now + 6 * 60_000);
      expect(await message({ type: 'nacre:claim-approval' }, popup)).toEqual({ ok: true, value: null });
      expect(browser.runtime.getContexts).not.toHaveBeenCalled();
      expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
    } finally { clock.mockRestore(); }
  });

  it.each([
    { origin: 'https://evil.example' }, { documentId: 'unrelated-document' }, { documentId: '' },
    { frameId: 0 }, { tab: { id: 99, windowId: 8 } as chrome.tabs.Tab },
  ])('rejects mismatched browser sender data while keeping the request pending: %j', async patch => {
    await message({ type: 'nacre:request', clientId: 'client_0123456789', args: { method: 'connect' } }, site);
    expect(await message({ type: 'nacre:claim-approval' }, { ...popup, ...patch })).toMatchObject({ ok: false, error: { code: 4100 } });
    expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '1' });
  });

  it('rejects ambiguous same-URL contexts even if one is a real popup', async () => {
    await message({ type: 'nacre:request', clientId: 'client_0123456789', args: { method: 'connect' } }, site);
    browser.runtime.getContexts.mockResolvedValue([
      { contextType: 'POPUP', documentId: popupDocumentId, documentUrl: popupUrl, frameId: 0, tabId: -1, windowId: -1 },
      { contextType: 'TAB', documentId: 'tab-document', documentUrl: popupUrl, frameId: 0, tabId: 99, windowId: 8 },
    ] as chrome.runtime.ExtensionContext[]);
    expect(await message({ type: 'nacre:claim-approval' }, popup)).toMatchObject({ ok: false, error: { code: 4100, message: 'Close other Nacre Wallet tabs or windows, then retry this request.' } });
    expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '1' });
  });

  it('does not let a popup from another focused browser window claim the request', async () => {
    await message({ type: 'nacre:request', clientId: 'client_0123456789', args: { method: 'connect' } }, site);
    browser.windows.getLastFocused.mockResolvedValue({ id: 12, focused: true });
    expect(await message({ type: 'nacre:claim-approval', windowId: 8 }, popup)).toEqual({ ok: true, value: null });
    expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '1' });
  });

  it('rejects an ordinary extension tab and retains pending approval for the genuine popup', async () => {
    await message({ type: 'nacre:request', clientId: 'client_0123456789', args: { method: 'connect' } }, site);
    browser.runtime.getContexts.mockResolvedValue([{ contextType: 'TAB', documentId: popupDocumentId, documentUrl: popupUrl,
      frameId: 0, tabId: 99, windowId: 8 }] as chrome.runtime.ExtensionContext[]);
    expect(await message({ type: 'nacre:claim-approval' }, popup)).toMatchObject({ ok: false, error: { code: 4100 } });
    expect(browser.action.setBadgeText).toHaveBeenLastCalledWith({ text: '1' });
  });
});
