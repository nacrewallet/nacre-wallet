import { describe, expect, it, vi } from 'vitest';
import { requireToolbarIdentity } from './toolbar-auth';

const extensionId = 'a'.repeat(32);
const popupUrl = `chrome-extension://${extensionId}/src/popup/index.html`;
// Native Chromium popup messages have id/url/origin, but no tab/frame/document.
const sender: chrome.runtime.MessageSender = { id: extensionId, url: popupUrl, origin: `chrome-extension://${extensionId}` };
const documentId = 'popup-document';

function fixture(contextWindow = -1) {
  const contexts = [{ contextType: 'POPUP', documentId, documentUrl: popupUrl,
    frameId: 0, tabId: -1, windowId: contextWindow }] as chrome.runtime.ExtensionContext[];
  const runtime = { id: extensionId, getContexts: vi.fn(async () => contexts) };
  const windows = {
    get: vi.fn(async (id: number) => ({ id, focused: true } as chrome.windows.Window)),
    getLastFocused: vi.fn(async () => ({ id: 8, focused: true } as chrome.windows.Window)),
  };
  return { runtime, windows, contexts };
}

describe('native toolbar window resolution', () => {
  it('authenticates real Chromium popup metadata with windowId -1 and no sender.tab', async () => {
    const browser = fixture();
    expect(await requireToolbarIdentity(sender, popupUrl, browser)).toEqual({ documentId, windowId: 8 });
    expect(browser.runtime.getContexts).toHaveBeenCalledWith({ documentUrls: [popupUrl] });
    expect(browser.windows.getLastFocused).toHaveBeenCalledOnce();
    expect(browser.windows.get).not.toHaveBeenCalled();
  });

  it('uses a concrete context window directly when a browser provides it', async () => {
    const browser = fixture(12);
    expect(await requireToolbarIdentity(sender, popupUrl, browser)).toEqual({ documentId, windowId: 12 });
    expect(browser.windows.get).toHaveBeenCalledWith(12);
    expect(browser.windows.getLastFocused).not.toHaveBeenCalled();
  });

  it.each([
    { id: -1, focused: true }, { focused: true },
  ])('fails closed when the last browser window has no valid identity: %j', async window => {
    const browser = fixture();
    browser.windows.getLastFocused.mockResolvedValue(window as chrome.windows.Window);
    await expect(requireToolbarIdentity(sender, popupUrl, browser)).rejects.toThrow('browser window');
  });

  it.each([-1, 8])('accepts the native popup when its parent browser reports focused=false (context window %s)', async contextWindow => {
    const browser = fixture(contextWindow);
    browser.windows.getLastFocused.mockResolvedValue({ id: 8, focused: false } as chrome.windows.Window);
    browser.windows.get.mockResolvedValue({ id: 8, focused: false } as chrome.windows.Window);
    expect(await requireToolbarIdentity(sender, popupUrl, browser)).toEqual({ documentId, windowId: 8 });
  });

  it('never lets focused browser metadata authenticate a forged tab or child document', async () => {
    for (const patch of [{ contextType: 'TAB' }, { frameId: 2 }, { documentId: undefined }, { documentUrl: popupUrl + '?forged' }]) {
      const browser = fixture();
      Object.assign(browser.contexts[0], patch);
      await expect(requireToolbarIdentity(sender, popupUrl, browser)).rejects.toThrow();
      expect(browser.windows.getLastFocused).not.toHaveBeenCalled();
    }
  });

  it.each([
    { origin: 'https://evil.example' }, { origin: 'null' }, { id: 'b'.repeat(32) },
    { url: popupUrl + '?forged=1' }, { frameId: 0 },
    { tab: { id: 99, windowId: 8 } as chrome.tabs.Tab },
    { documentId: 'wrong-document' }, { documentId: '' },
  ])('rejects incompatible sender metadata without using a fallback: %j', async patch => {
    const browser = fixture();
    await expect(requireToolbarIdentity({ ...sender, ...patch }, popupUrl, browser)).rejects.toThrow();
    expect(browser.windows.getLastFocused).not.toHaveBeenCalled();
  });

  it.each(['TAB', 'POPUP', 'SIDE_PANEL', 'OFFSCREEN_DOCUMENT', 'DEVELOPER_TOOLS'])('rejects an ambiguous URL shared with %s', async contextType => {
    const browser = fixture();
    browser.contexts.push({ ...browser.contexts[0], contextType, documentId: 'another-document' } as chrome.runtime.ExtensionContext);
    await expect(requireToolbarIdentity(sender, popupUrl, browser)).rejects.toThrow();
    expect(browser.windows.getLastFocused).not.toHaveBeenCalled();
  });

  it('rejects a same-URL child frame alongside the native popup', async () => {
    const browser = fixture();
    browser.contexts.push({ ...browser.contexts[0], frameId: 9, documentId: 'child-document' });
    await expect(requireToolbarIdentity(sender, popupUrl, browser)).rejects.toThrow();
  });

  it('keeps exact browser-supplied document identity when another context exists', async () => {
    const browser = fixture();
    browser.contexts.push({ ...browser.contexts[0], contextType: 'TAB' as chrome.runtime.ContextType, documentId: 'tab-document' });
    expect(await requireToolbarIdentity({ ...sender, documentId }, popupUrl, browser)).toEqual({ documentId, windowId: 8 });
    await expect(requireToolbarIdentity({ ...sender, documentId: 'tab-document' }, popupUrl, browser)).rejects.toThrow();
  });

  it('rejects a mismatching concrete popup window', async () => {
    const browser = fixture(12);
    browser.windows.get.mockResolvedValue({ id: 8, focused: true } as chrome.windows.Window);
    await expect(requireToolbarIdentity(sender, popupUrl, browser)).rejects.toThrow();
  });
});
