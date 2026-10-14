// Isolated world: a page can request operations, never approve them.
import { CHANNEL, REQUEST_TTL, allowedOrigin, validId, validateRequest, rpcError } from './protocol';
if (window.top === window && allowedOrigin(location.origin, import.meta.env.DEV)) {
  const inFlight = new Set<string>();
  const reply = (id: string, payload: unknown) => window.postMessage({ channel: CHANNEL, direction: 'response', id, ...(payload as object) }, location.origin);
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL || event.data?.direction !== 'request' || !validId(event.data.id)) return;
    const id = event.data.id as string;
    if (inFlight.has(id)) return;
    if (inFlight.size >= 8) { reply(id, { error: { code: -32005, message: 'Too many pending wallet requests.' } }); return; }
    inFlight.add(id);
    try {
      const args = validateRequest(event.data.args);
      const started = await chrome.runtime.sendMessage({ type: 'nacre:request', clientId: id, args });
      if (!started?.ok) { reply(id, { error: started?.error ?? { code: -32603, message: 'The extension could not start this request.' } }); return; }
      if (!started.requestId) { reply(id, { result: started.result }); return; }
      const deadline = Date.now() + REQUEST_TTL + 45_000;
      while (Date.now() < deadline) {
        const status = await chrome.runtime.sendMessage({ type: 'nacre:status', requestId: started.requestId });
        if (!status?.ok) { reply(id, { error: status?.error }); return; }
        if (!status.value.pending) { reply(id, status.value); return; }
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      reply(id, { error: { code: -32002, message: 'The request timed out. Check the wallet before retrying a payment.' } });
    } catch (e) { reply(id, { error: rpcError(e) }); }
    finally { inFlight.delete(id); }
  });
}
