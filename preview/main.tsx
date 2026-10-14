// Isolated, in-memory UI harness. No real addresses are imported, no real RPC
// requests leave this page, and broadcast is unconditionally rejected.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';

type Listener = (...args: unknown[]) => void;
function event() { const listeners = new Set<Listener>(); return { addListener: (fn: Listener) => listeners.add(fn), removeListener: (fn: Listener) => listeners.delete(fn), emit: (...args: unknown[]) => listeners.forEach(fn => fn(...args)) }; }
const changed = event();
function area(name: string) {
  const data: Record<string, unknown> = {};
  return {
    get: (keys: string | string[] | null, cb?: (value: Record<string, unknown>) => void) => { const result = keys === null ? { ...data } : Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, data[key]])); cb?.(result); return Promise.resolve(result); },
    set: (values: Record<string, unknown>, cb?: () => void) => { const changes: Record<string, unknown> = {}; for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: data[key], newValue: value }; data[key] = value; } changed.emit(changes, name); cb?.(); return Promise.resolve(); },
    remove: (keys: string | string[], cb?: () => void) => { const changes: Record<string, unknown> = {}; for (const key of typeof keys === 'string' ? [keys] : keys) { changes[key] = { oldValue: data[key] }; delete data[key]; } changed.emit(changes, name); cb?.(); return Promise.resolve(); },
    setAccessLevel: () => Promise.resolve(),
  };
}
Object.defineProperty(globalThis, 'chrome', { value: {
  storage: { local: area('local'), session: area('session'), onChanged: changed },
  runtime: { id: 'nacre-ui-preview', connect: () => ({ disconnect() {}, postMessage() {}, onDisconnect: event() }), getURL: (p: string) => `${location.origin}/${p}`, sendMessage: async (message: { type: string; action?: string; requestId?: string }) => {
    if (message.type === 'nacre:claim-approval') return { ok: true, value: new URLSearchParams(location.search).get('nacreApproval') };
    if (message.type === 'nacre:connections' && message.action === 'list') return { ok: true, value: [] };
    if (message.type === 'nacre:approval' && message.action === 'read') return { ok: true, value: { id: message.requestId, clientId: 'preview', owner: { origin: 'https://nacre.finance', tabId: 1, documentId: 'preview' }, args: { method: 'connect' }, status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 300000 } };
    return { ok: false, error: { message: 'Signing and approval are disabled in this isolated preview.' } };
  }, onMessage: event() },
  alarms: { clear: async () => true, create() {}, onAlarm: event() },
  tabs: { create: ({ url }: {url:string}) => window.open(url, '_blank', 'noopener') },
  windows: { getCurrent: async () => ({ id: 1 }), remove: async () => {} },
} });
const browserFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin === location.origin) return browserFetch(input, init);
  if (url.pathname.includes('broadcast')) return Response.json({ error: 'Broadcast disabled in UI preview.' }, { status: 403 });
  if (url.pathname.endsWith('/scan')) { const body = JSON.parse(String(init?.body ?? '{}')); return Response.json({ results: (body.addresses ?? []).map((address: string) => ({ address, used: false, balance: '0', utxos: [] })) }); }
  if (url.pathname.includes('/pns')) return Response.json({ names: [], owned: [] });
  if (url.pathname.endsWith('/wallet-history')) return Response.json({ transactions: [] });
  if (url.pathname.includes('/utxos/')) return Response.json({ utxos: [] });
  if (url.pathname.endsWith('/stats')) return Response.json({ recommendedFee: 1 });
  if (url.pathname.includes('/price-history')) return Response.json({ points: [] });
  // Store artwork shows an empty account at $0.00, not a live market quote.
  // This fixture is enabled only for local artwork; no price chart is provided.
  if (url.pathname.endsWith('/price')) return Response.json({ price: new URLSearchParams(location.search).get('artwork') === '1' ? 1 : null });
  return Response.json({ transactions: [], balance: '0', txCount: 0 });
};
document.documentElement.classList.add('dark');
const view = new URLSearchParams(location.search).get('view');
if (view === 'dashboard' || view === 'send') {
  const { createWallet } = await import('../src/storage/vault');
  const { unlock } = await import('../src/state/session');
  // Public BIP-39 test vector; ephemeral storage, never a wallet for real funds.
  const vector = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  await createWallet({ mnemonic: vector, password: 'UI-preview-only-0000' });
  await unlock(vector);
}
const { App } = await import('../src/popup/App');
if (view === 'send') {
  const { refreshWallet } = await import('../src/state/walletState');
  const { Send } = await import('../src/screens/Send');
  await refreshWallet();
  // Empty, unfunded form for store screenshots. Real send/review UI, with the
  // same in-memory fixture and blocked network boundary as the dashboard.
  createRoot(document.getElementById('root')!).render(<React.StrictMode><div className="popup-shell flex flex-col">
    <Send onBack={() => { location.href = '/preview/index.html?view=dashboard'; }} onSent={() => {}} onPickContact={() => {}} />
  </div></React.StrictMode>);
} else {
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
}
