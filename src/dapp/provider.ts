// Website MAIN world: public messages only, no extension APIs or secrets.
import { CHANNEL, REQUEST_TTL } from './protocol';
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const pending = new Map<string, Pending>();
const error = (code: number, message: string, data?: unknown) => Object.assign(new Error(message), { code, ...(data ? { data } : {}) });
if (window.top === window && !Object.prototype.hasOwnProperty.call(window, 'nacre')) {
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL || event.data?.direction !== 'response') return;
    const entry = pending.get(event.data.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(event.data.id);
    if (event.data.error) entry.reject(error(event.data.error.code, event.data.error.message, event.data.error.data));
    else entry.resolve(event.data.result);
  });
  Object.defineProperty(window, 'nacre', { enumerable: true, writable: false, configurable: false, value: Object.freeze({
    isNacre: true as const, version: '1', features: Object.freeze(['getBalance', 'balanceOnConnect', 'totalDebitCap', 'feeEstimates']),
    request(args: { method: string; params?: unknown }): Promise<unknown> {
      if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.method !== 'string') return Promise.reject(error(-32602, 'Expected { method, params? }.'));
      if (pending.size >= 8) return Promise.reject(error(-32005, 'Too many pending wallet requests.'));
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(error(-32002, 'The wallet request timed out. For payments, check the wallet before retrying.')); }, REQUEST_TTL + 60_000);
        pending.set(id, { resolve, reject, timer });
        try { window.postMessage({ channel: CHANNEL, direction: 'request', id, args }, location.origin); }
        catch { clearTimeout(timer); pending.delete(id); reject(error(-32602, 'Request parameters must be serializable.')); }
      });
    },
  }) });
  window.dispatchEvent(new Event('nacre#initialized'));
}
