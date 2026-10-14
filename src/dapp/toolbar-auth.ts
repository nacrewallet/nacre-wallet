import { ProviderError, toolbarIdentity, type ApprovalIdentity } from './protocol';

interface ToolbarBrowser {
  runtime: Pick<typeof chrome.runtime, 'id' | 'getContexts'>;
  windows: Pick<typeof chrome.windows, 'get' | 'getLastFocused'>;
}

export async function resolveToolbarDocument(
  sender: chrome.runtime.MessageSender,
  popupUrl: string,
  runtime: ToolbarBrowser['runtime'] = chrome.runtime,
): Promise<ApprovalIdentity> {
  if (typeof runtime.getContexts !== 'function') {
    throw new ProviderError(4100, 'This browser cannot verify website requests. Use a supported Chrome version.');
  }
  const contexts = await runtime.getContexts({
    // Do not pre-filter to POPUP: without sender.documentId we must reject an
    // ambiguous exact URL shared by a popup and any other extension context.
    documentUrls: [popupUrl],
  });
  return toolbarIdentity(sender, contexts, runtime.id, popupUrl);
}

// Runtime contexts authenticate the extension document; the last active browser
// identifies its parent window. Neither value comes from a website message.
export async function requireToolbarIdentity(
  sender: chrome.runtime.MessageSender,
  popupUrl: string,
  browser: ToolbarBrowser = chrome,
): Promise<ApprovalIdentity> {
  const identity = await resolveToolbarDocument(sender, popupUrl, browser.runtime);
  // Chrome's genuine action popup currently has windowId -1. Do not pass that
  // sentinel to windows.get() or discard this authenticated popup. A background
  // getLastFocused() supplies the browser window. Do NOT require focused=true:
  // Chromium's WindowControllerList documents that a native popup can own focus
  // instead of its parent browser. The live POPUP document and broker's exact
  // requesting-window binding provide the approval boundary.
  const window = identity.windowId === -1
    ? await browser.windows.getLastFocused()
    : await browser.windows.get(identity.windowId);
  if (!Number.isInteger(window.id) || window.id! < 0
    || (identity.windowId >= 0 && window.id !== identity.windowId)) {
    throw new ProviderError(4100, 'The browser window for this wallet request is unavailable.');
  }
  return { documentId: identity.documentId, windowId: window.id! };
}
