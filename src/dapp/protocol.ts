// Public provider protocol. Never import wallet state or key material here.
import { isValidAddress } from '@/pearl/address';
import { parsePearlAmount, formatPearlAmount } from '@/pearl/money';
import { DUST_LIMIT } from '@/pearl/network';
import { parseTotalDebitCap } from '@/pearl/payment-budget';

export const NACRE_ORIGIN = 'https://nacre.finance';
export const DEV_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'];
export const REQUEST_TTL = 5 * 60_000;
export const CHANNEL = 'nacre-wallet:v1';
export type Method = 'connect' | 'getAccounts' | 'disconnect' | 'sendTransaction' | 'getBalance';
export interface Payment { to: string; amount: string; orderId?: string; maxTotalDebitAtoms?: string }
export type RequestArgs = { method: 'sendTransaction'; params: Payment }
  | { method: 'getBalance'; params?: { refresh: boolean } }
  | { method: 'connect' | 'getAccounts' | 'disconnect'; params?: never };
export interface RpcError { code: number; message: string; data?: { txid: string } }
export class ProviderError extends Error {
  constructor(public code: number, message: string, public data?: { txid: string }) { super(message); }
}
export function rpcError(error: unknown): RpcError {
  return error instanceof ProviderError
    ? { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) }
    : { code: -32603, message: 'The wallet could not complete this request.' };
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
}
export function allowedOrigin(origin: string, development: boolean): boolean {
  return origin === NACRE_ORIGIN || (development && DEV_ORIGINS.includes(origin));
}
export function validateRequest(value: unknown): RequestArgs {
  if (!isRecord(value) || Object.keys(value).some(k => k !== 'method' && k !== 'params')) {
    throw new ProviderError(-32602, 'Expected { method, params? }.');
  }
  if (!['connect', 'getAccounts', 'disconnect', 'sendTransaction', 'getBalance'].includes(String(value.method))) {
    throw new ProviderError(4200, 'This wallet method is not supported.');
  }
  const method = value.method as Method;
  if (method === 'getBalance') {
    if (value.params === undefined) return { method };
    if (!isRecord(value.params) || Object.keys(value.params).some(k => k !== 'refresh') || typeof value.params.refresh !== 'boolean') {
      throw new ProviderError(-32602, 'Expected getBalance params: { refresh: boolean }.');
    }
    return { method, params: { refresh: value.params.refresh } };
  }
  if (method !== 'sendTransaction') {
    if (value.params !== undefined) throw new ProviderError(-32602, 'This method does not accept parameters.');
    return { method };
  }
  const p = value.params;
  if (!isRecord(p) || Object.keys(p).some(k => !['to', 'amount', 'orderId', 'maxTotalDebitAtoms'].includes(k))) {
    throw new ProviderError(-32602, 'Expected a native PRL payment: { to, amount, orderId?, maxTotalDebitAtoms? }.');
  }
  if (typeof p.to !== 'string' || p.to.length > 100 || !isValidAddress(p.to, 'mainnet')) {
    throw new ProviderError(-32602, 'The recipient must be a valid Pearl mainnet address.');
  }
  // API values are exact decimal strings, never locale-formatted numbers.
  if (typeof p.amount !== 'string' || !/^(0|[1-9]\d{0,10})(\.\d{1,8})?$/.test(p.amount)) {
    throw new ProviderError(-32602, 'Amount must be a positive PRL decimal string with at most 8 decimal places.');
  }
  const grains = parsePearlAmount(p.amount);
  if (grains === null || grains <= DUST_LIMIT || grains > 0x7fffffffffffffffn) {
    throw new ProviderError(-32602, 'The payment amount is outside the supported range.');
  }
  if (p.orderId !== undefined && (typeof p.orderId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(p.orderId))) {
    throw new ProviderError(-32602, 'orderId must contain 1–100 letters, digits, hyphens or underscores.');
  }
  let cap: string | undefined;
  if (Object.prototype.hasOwnProperty.call(p, 'maxTotalDebitAtoms')) {
    try { cap = parseTotalDebitCap(p.maxTotalDebitAtoms, grains).toString(); }
    catch (error) { throw new ProviderError(-32602, (error as Error).message); }
  }
  return { method, params: { to: p.to.toLowerCase(), amount: formatPearlAmount(grains), ...(p.orderId ? { orderId: p.orderId as string } : {}), ...(cap !== undefined ? { maxTotalDebitAtoms: cap } : {}) } };
}

export interface SiteIdentity { origin: string; tabId: number; windowId: number; documentId: string }
export function siteIdentity(sender: chrome.runtime.MessageSender, extensionId: string, development: boolean): SiteIdentity {
  if (sender.id !== extensionId || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.tab?.windowId) || !sender.documentId || !sender.url) {
    throw new ProviderError(4100, 'Only an allowed top-level website can use Nacre Wallet.');
  }
  let origin: string;
  try { origin = new URL(sender.url).origin; } catch { throw new ProviderError(4100, 'Invalid website origin.'); }
  if (!allowedOrigin(origin, development) || sender.origin !== origin) throw new ProviderError(4100, 'This website is not allowed to use Nacre Wallet.');
  return { origin, tabId: sender.tab!.id!, windowId: sender.tab!.windowId, documentId: sender.documentId };
}

export interface ApprovalIdentity { windowId: number; documentId: string }

// A URL by itself is not an approval capability: the same HTML can be opened
// in an ordinary tab. Chromium omits tab/frame/document metadata from native
// popup messages, so that shape must map to exactly ONE browser-reported frame
// at this exact URL, and that frame must be a top-level POPUP. Never infer an
// identity from a client-supplied ID or choose one among ambiguous contexts.
export function toolbarIdentity(
  sender: chrome.runtime.MessageSender,
  contexts: chrome.runtime.ExtensionContext[],
  extensionId: string,
  popupUrl: string,
): ApprovalIdentity {
  const expectedOrigin = `chrome-extension://${extensionId}`;
  if (!isExtensionPopup(sender, extensionId, popupUrl) || sender.url !== popupUrl
    || (sender.origin !== undefined && sender.origin !== expectedOrigin)) {
    throw new ProviderError(4100, 'Only the Nacre toolbar popup can approve this request.');
  }
  let candidates: chrome.runtime.ExtensionContext[];
  if (sender.documentId !== undefined) {
    // A supplied but invalid/mismatching document ID never uses the fallback.
    candidates = contexts.filter(c => !!sender.documentId && c.documentId === sender.documentId && c.documentUrl === popupUrl);
  } else {
    if (sender.tab !== undefined || sender.frameId !== undefined) {
      throw new ProviderError(4100, 'Only the Nacre toolbar popup can approve this request.');
    }
    // The caller must pass ALL matching contexts, not a POPUP-only query. An
    // ordinary tab, child frame, side panel or second popup makes this ambiguous.
    candidates = contexts.filter(c => c.documentUrl === popupUrl);
    if (candidates.length > 1) {
      throw new ProviderError(4100, 'Close other Nacre Wallet tabs or windows, then retry this request.');
    }
  }
  const context = candidates.length === 1 ? candidates[0] : undefined;
  if (!context || context.contextType !== 'POPUP' || context.frameId !== 0 || !context.documentId
    || !Number.isInteger(context.windowId) || context.windowId < -1) {
    throw new ProviderError(4100, 'This document is not an active Nacre toolbar popup.');
  }
  // Chromium reports -1 for a toolbar bubble: its WebContents is not a tab
  // inside the browser window. The background must resolve this sentinel from
  // the focused browser window before this identity can enter the broker.
  return { documentId: context.documentId, windowId: context.windowId };
}
export function isExtensionPopup(sender: chrome.runtime.MessageSender, extensionId: string, popupUrl = `chrome-extension://${extensionId}/src/popup/index.html`): boolean {
  if (sender.id !== extensionId || !sender.url || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  try {
    const url = new URL(sender.url);
    const expected = new URL(popupUrl);
    return ['chrome-extension:', 'moz-extension:'].includes(expected.protocol) && url.protocol === expected.protocol && url.hostname === expected.hostname && url.pathname === expected.pathname;
  } catch { return false; }
}
