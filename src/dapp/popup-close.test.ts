import { describe, expect, it, vi } from 'vitest';
import { trackPopupClose } from './popup-close';

const extensionId = 'a'.repeat(32);
const popupUrl = `chrome-extension://${extensionId}/src/popup/index.html`;
const sender = { id: extensionId, url: popupUrl, origin: `chrome-extension://${extensionId}` };
const context = { contextType: 'POPUP', documentId: 'retained-document', documentUrl: popupUrl,
  frameId: 0, tabId: -1, windowId: -1 } as chrome.runtime.ExtensionContext;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function fixture() {
  const port = { sender, onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() } };
  const runtime = { id: extensionId, getContexts: vi.fn(async () => [context]) };
  const closed = vi.fn(async () => {});
  trackPopupClose(port as unknown as chrome.runtime.Port, popupUrl, closed, runtime);
  return { runtime, closed,
    heartbeat: () => port.onMessage.addListener.mock.calls[0][0](),
    disconnect: () => port.onDisconnect.addListener.mock.calls[0][0](),
  };
}

describe('native popup close tracking without sender.documentId', () => {
  it('retains the actual browser document and closes only when it disappears', async () => {
    const f = fixture();
    await flush();
    f.runtime.getContexts.mockResolvedValue([]);
    f.disconnect();
    await flush();
    expect(f.runtime.getContexts).toHaveBeenLastCalledWith({ documentIds: [context.documentId] });
    expect(f.closed).toHaveBeenCalledExactlyOnceWith(context.documentId);
  });

  it('does not close an existing popup when its port reconnects', async () => {
    const f = fixture();
    await flush();
    f.disconnect();
    await flush();
    expect(f.closed).not.toHaveBeenCalled();
  });

  it('does not interpret a failed context lookup as a closed document', async () => {
    const f = fixture();
    await flush();
    f.runtime.getContexts.mockRejectedValue(new Error('Transient API failure'));
    f.disconnect();
    await flush();
    expect(f.closed).not.toHaveBeenCalled();
  });

  it('retries failed registration discovery on a heartbeat while still alive', async () => {
    const runtime = { id: extensionId, getContexts: vi.fn().mockRejectedValueOnce(new Error('Starting')).mockResolvedValue([context]) };
    const port = { sender, onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() } };
    const closed = vi.fn(async () => {});
    trackPopupClose(port as unknown as chrome.runtime.Port, popupUrl, closed, runtime);
    await flush();
    port.onMessage.addListener.mock.calls[0][0]();
    await flush();
    runtime.getContexts.mockResolvedValue([]);
    port.onDisconnect.addListener.mock.calls[0][0]();
    await flush();
    expect(closed).toHaveBeenCalledExactlyOnceWith(context.documentId);
  });

  it('never captures another document from a lookup resolving after disconnect', async () => {
    let resolve!: (contexts: chrome.runtime.ExtensionContext[]) => void;
    const firstLookup = new Promise<chrome.runtime.ExtensionContext[]>(done => { resolve = done; });
    const runtime = { id: extensionId, getContexts: vi.fn().mockReturnValueOnce(firstLookup).mockResolvedValue([{ ...context, documentId: 'new-popup-document' }]) };
    const port = { sender, onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() } };
    const closed = vi.fn(async () => {});
    trackPopupClose(port as unknown as chrome.runtime.Port, popupUrl, closed, runtime);
    port.onDisconnect.addListener.mock.calls[0][0]();
    resolve([{ ...context, documentId: 'new-popup-document' }]);
    await flush();
    port.onMessage.addListener.mock.calls[0][0]();
    expect(runtime.getContexts).toHaveBeenCalledTimes(2);
    expect(closed).not.toHaveBeenCalled();
  });
  it.each(['failed', 'still-running'])('allows lock-on-close without inventing a document when registration is %s', async state => {
    const runtime = { id: extensionId, getContexts: vi.fn() };
    if (state === 'failed') runtime.getContexts.mockRejectedValueOnce(new Error('Worker starting'));
    else runtime.getContexts.mockReturnValueOnce(new Promise(() => {}));
    runtime.getContexts.mockResolvedValue([]);
    const port = { sender, onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() } };
    const closed = vi.fn(async () => {});
    trackPopupClose(port as unknown as chrome.runtime.Port, popupUrl, closed, runtime);
    await flush();
    port.onDisconnect.addListener.mock.calls[0][0]();
    await flush();
    expect(runtime.getContexts).toHaveBeenLastCalledWith({ documentUrls: [popupUrl] });
    expect(closed).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
