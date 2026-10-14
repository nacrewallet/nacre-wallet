import { resolveToolbarDocument } from './toolbar-auth';

// Retain the browser-verified document while the port is alive. Do not discover
// a document after disconnect: a different popup could already have opened.
export function trackPopupClose(
  port: chrome.runtime.Port,
  popupUrl: string,
  onClosed: (documentId?: string) => Promise<void>,
  runtime: Pick<typeof chrome.runtime, 'id' | 'getContexts'> = chrome.runtime,
): void {
  let documentId: string | undefined;
  let resolving = false;
  let disconnected = false;
  const resolve = () => {
    if (disconnected || resolving || documentId || !port.sender) return;
    resolving = true;
    void resolveToolbarDocument(port.sender, popupUrl, runtime).then(identity => {
      if (!disconnected) documentId = identity.documentId;
    }, () => { /* Retry transient discovery failures on the next heartbeat. */ })
      .finally(() => { resolving = false; });
  };
  resolve();
  port.onMessage.addListener(resolve);
  port.onDisconnect.addListener(() => {
    disconnected = true;
    const retainedDocumentId = documentId;
    void runtime.getContexts(retainedDocumentId ? { documentIds: [retainedDocumentId] } : { documentUrls: [popupUrl] }).then(async contexts => {
      // Reconnects and React remounts can disconnect a port while its popup is
      // still alive. Only disappearance of the retained document means close.
      if (retainedDocumentId ? contexts.some(c => c.documentId === retainedDocumentId)
        : contexts.some(c => c.documentUrl === popupUrl && c.contextType === 'POPUP')) return;
      // A quick close or failed registration can leave no retained identity.
      // With no live popup, lock-on-close may run, but no broker document is
      // inferred from this lookup or cancelled on behalf of another popup.
      await onClosed(retainedDocumentId);
    }).catch(() => { /* API failure is not evidence that a document closed. */ });
  });
}
