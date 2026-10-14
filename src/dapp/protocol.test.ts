import { describe, it, expect } from 'vitest';
import { allowedOrigin, NACRE_ORIGIN, validateRequest, validId, siteIdentity, isExtensionPopup, toolbarIdentity } from './protocol';
import { privateKeyToAddress, parsePrivateKey } from '@/pearl/wallet';

const address = privateKeyToAddress(parsePrivateKey('2222222222222222222222222222222222222222222222222222222222222222'), 'mainnet');
const extensionId = 'a'.repeat(32);
const sender = (): chrome.runtime.MessageSender => ({
  id: extensionId, frameId: 0, documentId: 'document-123',
  url: `${NACRE_ORIGIN}/swap`, origin: NACRE_ORIGIN,
  tab: { id: 42, windowId: 8 } as chrome.tabs.Tab,
});

describe('native-payment request boundary', () => {
  it('supports passive balance reads and explicit refresh, with no arbitrary address/account selector', () => {
    expect(validateRequest({ method: 'getBalance' })).toEqual({ method: 'getBalance' });
    expect(validateRequest({ method: 'getBalance', params: { refresh: true } })).toEqual({ method: 'getBalance', params: { refresh: true } });
    for (const params of [{ refresh: 'yes' }, { refresh: true, address }, { accountId: 'account-2' }, { refresh: true, network: 'testnet' }]) {
      expect(() => validateRequest({ method: 'getBalance', params })).toThrow();
    }
  });
  it('canonicalizes an exact decimal without losing a grain beyond Number.MAX_SAFE_INTEGER', () => {
    const payment = validateRequest({ method: 'sendTransaction', params: { to: address, amount: '90071992.54740993', orderId: 'order_123' } });
    expect(payment.params).toEqual({ to: address, amount: '90071992.54740993', orderId: 'order_123' });
  });

  it('retains an optional exact integer budget through validation without converting via Number', () => {
    const payment = validateRequest({ method: 'sendTransaction', params: { to: address, amount: '90071992.54740993', maxTotalDebitAtoms: '9007199254741993' } });
    expect(payment.params).toEqual({ to: address, amount: '90071992.54740993', maxTotalDebitAtoms: '9007199254741993' });
    expect(validateRequest({ method: 'sendTransaction', params: { to: address, amount: '1' } }).params).not.toHaveProperty('maxTotalDebitAtoms');
  });

  it.each([0, 100000000, null, undefined, '', '0', '01', '-1', '100000000.0', '1e8', ' 100000000', '99999999', '9223372036854775808'])('rejects malformed or insufficient total debit budget %s', maxTotalDebitAtoms => {
    expect(() => validateRequest({ method: 'sendTransaction', params: { to: address, amount: '1', maxTotalDebitAtoms } })).toThrow(/Budget max/);
  });

  it.each([0.1, '1e3', '1,5', '-1', '0', '0.00000546', '1.000000001', '1x', 'NaN', '01', '92233720369'])('rejects malformed, dust or unsupported amount %s', amount => {
    expect(() => validateRequest({ method: 'sendTransaction', params: { to: address, amount } })).toThrow();
  });

  it('does not accept signing primitives, raw transactions or extra fields from a website', () => {
    for (const method of ['signMessage', 'signTransaction', 'signPsbt', 'wallet_unlock']) expect(() => validateRequest({ method })).toThrow();
    expect(() => validateRequest({ method: 'sendTransaction', params: { to: address, amount: '1', hex: 'deadbeef' } })).toThrow();
    expect(() => validateRequest({ method: 'connect', params: {} })).toThrow();
    expect(() => validateRequest({ method: 'connect', origin: NACRE_ORIGIN })).toThrow();
  });

  it('rejects testnet destinations and an order ID containing path or HTML syntax', () => {
    const testnet = privateKeyToAddress(parsePrivateKey('2222222222222222222222222222222222222222222222222222222222222222'), 'testnet');
    expect(() => validateRequest({ method: 'sendTransaction', params: { to: testnet, amount: '1' } })).toThrow();
    expect(() => validateRequest({ method: 'sendTransaction', params: { to: address, amount: '1', orderId: '../<script>' } })).toThrow();
  });
});

describe('website and approval identity', () => {
  it('allows only the exact production origin; localhost requires a development build', () => {
    expect(NACRE_ORIGIN).toBe('https://nacre.finance');
    expect(allowedOrigin(NACRE_ORIGIN, false)).toBe(true);
    for (const origin of [`${NACRE_ORIGIN}.evil.example`, 'https://evil.example', 'http://localhost:3000', 'https://pearl-passage.flairxflair.chatgpt.site', 'https://www.nacre.finance', 'http://nacre.finance', 'https://nacre.finance:8443']) expect(allowedOrigin(origin, false)).toBe(false);
    expect(allowedOrigin('http://localhost:3000', true)).toBe(true);
  });

  it('uses the browser sender metadata and binds the top-level document', () => {
    expect(siteIdentity(sender(), extensionId, false)).toEqual({ origin: NACRE_ORIGIN, tabId: 42, windowId: 8, documentId: 'document-123' });
    for (const patch of [
      { frameId: 1 }, { id: 'b'.repeat(32) }, { documentId: undefined },
      { origin: 'https://evil.example' }, { url: 'https://evil.example' }, { tab: undefined },
    ]) expect(() => siteIdentity({ ...sender(), ...patch }, extensionId, false)).toThrow();
  });

  it('website/content-script messages cannot impersonate the extension approval UI', () => {
    expect(isExtensionPopup(sender(), extensionId)).toBe(false);
    expect(isExtensionPopup({ id: extensionId, frameId: 0, url: `chrome-extension://${extensionId}/src/popup/index.html?approval=test` }, extensionId)).toBe(true);
    expect(isExtensionPopup({ id: extensionId, frameId: 0, url: `chrome-extension://${extensionId}/another.html` }, extensionId)).toBe(false);
  });

  it('bounds request IDs and rejects prototype-like or path-shaped input', () => {
    expect(validId('request_0123456789')).toBe(true);
    for (const id of ['__proto__', '../request_0123456789', 'x'.repeat(81), 42, null]) expect(validId(id)).toBe(false);
  });
  it('authenticates a toolbar POPUP when the browser provides a document ID', () => {
    const url = `chrome-extension://${extensionId}/src/popup/index.html`;
    const popupSender: chrome.runtime.MessageSender = { id: extensionId, url, documentId: 'toolbar-document' };
    const context = { contextType: 'POPUP', documentId: 'toolbar-document', documentUrl: url, windowId: 8, frameId: 0 } as chrome.runtime.ExtensionContext;
    expect(toolbarIdentity(popupSender, [context], extensionId, url)).toEqual({ windowId: 8, documentId: 'toolbar-document' });
    // Chromium's interactive runtime test explicitly expects windowId: -1 for
    // an action popup. The background resolves its browser window separately.
    expect(toolbarIdentity(popupSender, [{ ...context, windowId: -1 }], extensionId, url)).toEqual({ windowId: -1, documentId: 'toolbar-document' });
    for (const changed of [
      { contextType: 'TAB' }, { documentId: 'other-document' },
      { documentUrl: url + '?nacreApproval=forged' }, { frameId: 1 }, { windowId: -2 }, { windowId: undefined },
    ]) expect(() => toolbarIdentity(popupSender, [{ ...context, ...changed } as chrome.runtime.ExtensionContext], extensionId, url)).toThrow();
    expect(() => toolbarIdentity({ ...popupSender, url: url + '?nacreApproval=forged' }, [context], extensionId, url)).toThrow();
    expect(toolbarIdentity({ ...popupSender, documentId: undefined }, [context], extensionId, url)).toEqual({ windowId: 8, documentId: 'toolbar-document' });
    expect(() => toolbarIdentity(popupSender, [], extensionId, url)).toThrow();
  });
});
