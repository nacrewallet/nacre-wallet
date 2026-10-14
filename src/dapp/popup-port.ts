// Keep the MV3 worker's popup-close listener alive while the UI is open.
// Opening a port alone does not reset Chromium's service-worker idle timer.
export function maintainPopupPort(): () => void {
  let disposed = false;
  let port: chrome.runtime.Port | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const retry = () => {
    if (!disposed && !reconnect) reconnect = setTimeout(() => { reconnect = undefined; connect(); }, 500);
  };
  const connect = () => {
    if (disposed) return;
    try {
      const next = chrome.runtime.connect({ name: 'popup' });
      port = next;
      next.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (port !== next) return;
        port = undefined;
        retry();
      });
    } catch { retry(); }
  };
  connect();
  const heartbeat = setInterval(() => {
    if (!port) { retry(); return; }
    try { port.postMessage({ type: 'heartbeat' }); } catch { port = undefined; retry(); }
  }, 20_000);
  return () => {
    disposed = true;
    clearInterval(heartbeat);
    if (reconnect) clearTimeout(reconnect);
    port?.disconnect();
  };
}
