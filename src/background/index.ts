// MV3 worker: public request state and one-shot submission. Keys stay in the
// trusted toolbar popup. Approvals belong to one browser-verified document.
import { RequestBroker, type BrokerState } from '@/dapp/broker';
import { ProviderError, isExtensionPopup, isRecord, rpcError, siteIdentity, validId, validateRequest } from '@/dapp/protocol';
import { requireToolbarIdentity } from '@/dapp/toolbar-auth';
import { trackPopupClose } from '@/dapp/popup-close';
import { isValidAddress } from '@/pearl/address';
import { MAX_NETWORK_FEE } from '@/pearl/money';
import { balanceContext, validateBalanceWatch } from '@/dapp/balance-watch';
import { scanWatchBalance } from '@/dapp/watch-balance';
import type { WalletMeta } from '@/storage/vault';

const SESSION_KEY = 'pearl.session.mnemonic';
const AUTOLOCK_ALARM = 'pearl.autolock';
const BROKER_KEY = 'nacre.dapp.session.v1';
const REQUEST_ALARM = 'nacre.request-expiry';
const popupUrl = chrome.runtime.getURL('src/popup/index.html');
const isPopup = (sender: chrome.runtime.MessageSender) => isExtensionPopup(sender, chrome.runtime.id, popupUrl);
const nativeOnlyFirefox = popupUrl.startsWith('moz-extension:') && !chrome.runtime.getManifest().content_scripts?.length;
const requireToolbar = (sender: chrome.runtime.MessageSender) => requireToolbarIdentity(sender, popupUrl);
async function restrictStorage(area: chrome.storage.LocalStorageArea | chrome.storage.SessionStorageArea) {
  if (typeof area.setAccessLevel === 'function') await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  else if (!nativeOnlyFirefox) throw new Error('Trusted storage access controls are required by the connector.');
}
const trustedStorage = Promise.all([restrictStorage(chrome.storage.local), restrictStorage(chrome.storage.session)]);
const currentAccount = async (): Promise<string | undefined> => {
  const data = await chrome.storage.local.get('pearlchain.wallet.meta');
  const meta = data['pearlchain.wallet.meta'];
  return meta?.network === 'mainnet' && typeof meta.selectedAccountId === 'string' ? meta.selectedAccountId : undefined;
};
const unlockedAccount = async (): Promise<string | undefined> => {
  const session = await chrome.storage.session.get(SESSION_KEY);
  return typeof session[SESSION_KEY] === 'string' ? currentAccount() : undefined;
};
let badge: string | undefined;
const broker = new RequestBroker({
  read: async () => { await trustedStorage; return (await chrome.storage.session.get(BROKER_KEY))[BROKER_KEY] as BrokerState | undefined; },
  write: async state => {
    await chrome.storage.session.set({ [BROKER_KEY]: state });
    const nextBadge = state.requests.some(r => r.status === 'pending') ? '1' : '';
    if (nextBadge !== badge) {
      // If automatic opening is refused, the icon remains a discoverable entry.
      await Promise.all([
        chrome.action.setBadgeText({ text: nextBadge }),
        chrome.action.setBadgeBackgroundColor({ color: '#c9cad4' }),
        chrome.action.setTitle({ title: nextBadge ? 'Nacre Wallet — request waiting: click to review' : 'Nacre Wallet' }),
      ]).then(() => { badge = nextBadge; }, () => {});
    }
    if (nextBadge) await chrome.alarms.create(REQUEST_ALARM, { periodInMinutes: 1 });
  },
  now: () => Date.now(), id: () => crypto.randomUUID(), accountId: currentAccount,
  balanceAccountId: unlockedAccount,
  refreshBalance: async (account, signal) => {
    const meta = (await chrome.storage.local.get('pearlchain.wallet.meta'))['pearlchain.wallet.meta'] as WalletMeta;
    const context = balanceContext(meta);
    const snapshot = await scanWatchBalance(account, meta, signal);
    const after = (await chrome.storage.local.get('pearlchain.wallet.meta'))['pearlchain.wallet.meta'] as WalletMeta;
    if (balanceContext(after) !== context || await unlockedAccount() !== account.accountId) throw new ProviderError(4100, 'The wallet account, network or lock state changed.');
    return snapshot;
  },
  openApproval: async windowId => {
    // Chrome 127+: native action bubble, anchored by Chrome to its toolbar icon.
    // Never create or close a separate OS/browser window for a wallet request.
    await chrome.action.openPopup({ windowId });
  },
});
async function requireUnlocked(): Promise<void> {
  if (typeof (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] !== 'string') throw new ProviderError(4100, 'Unlock the wallet to approve this request.');
}
async function handleMessage(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await trustedStorage;
  if (!isRecord(message)) throw new ProviderError(-32602, 'Invalid wallet message.');
  if (message.type === 'nacre:request' || message.type === 'nacre:status') {
    const owner = siteIdentity(sender, chrome.runtime.id, import.meta.env.DEV);
    if (message.type === 'nacre:status') {
      if (!validId(message.requestId)) throw new ProviderError(-32602, 'Invalid request ID.');
      return { ok: true, value: await broker.status(owner, message.requestId) };
    }
    if (!validId(message.clientId)) throw new ProviderError(-32602, 'Invalid request ID.');
    const args = validateRequest(message.args);
    if (args.method === 'getAccounts') return { ok: true, result: await broker.accounts(owner) };
    if (args.method === 'disconnect') return { ok: true, result: await broker.disconnect(owner) };
    if (args.method === 'getBalance' && !args.params?.refresh) return { ok: true, result: await broker.balance(owner) };
    if (args.method === 'getBalance') return { ok: true, result: await broker.refreshBalance(owner) };
    const created = await broker.create(owner, message.clientId, args);
    return { ok: true, requestId: created.id };
  }
  if (message.type === 'nacre:claim-approval') {
    if (nativeOnlyFirefox && isPopup(sender)) return { ok: true, value: null };
    if (!isPopup(sender) || sender.url !== popupUrl) throw new ProviderError(4100, 'Only Nacre Wallet can check website requests.');
    // Opening the wallet normally is not a website approval. Avoid asking for
    // approval-context identity when there is no pending request to claim.
    if (!await broker.hasPendingApproval()) return { ok: true, value: null };
    return { ok: true, value: await broker.claim(await requireToolbar(sender)) };
  }
  if (message.type === 'nacre:connections') {
    if (nativeOnlyFirefox && isPopup(sender)) return { ok: true, value: [] };
    await requireToolbar(sender);
    if (message.action === 'list') return { ok: true, value: await broker.connections() };
    if (message.action === 'revoke' && typeof message.origin === 'string') { await broker.revoke(message.origin); return { ok: true }; }
  }
  if (message.type !== 'nacre:approval' || !validId(message.requestId)) throw new ProviderError(4100, 'Unauthorized approval message.');
  const id = message.requestId;
  const identity = await requireToolbar(sender);
  if (message.action === 'read') return { ok: true, value: await broker.getApproval(id, identity) };
  if (message.action === 'reject') { await broker.reject(id, identity); return { ok: true }; }
  await requireUnlocked();
  if (message.action === 'connect') {
    if (typeof message.address !== 'string' || !isValidAddress(message.address, 'mainnet') || typeof message.accountId !== 'string') throw new ProviderError(-32602, 'Invalid account.');
    const meta = (await chrome.storage.local.get('pearlchain.wallet.meta'))['pearlchain.wallet.meta'] as WalletMeta;
    const balanceGrant = message.balanceAccess === true ? { balanceAccess: true as const, balanceWatch: validateBalanceWatch(message.balanceWatch, message.address, meta) } : {};
    await broker.approveConnection(id, identity, { address: message.address, accountId: message.accountId, ...balanceGrant });
    return { ok: true };
  }
  if (message.action === 'balance') {
    if (typeof message.accountId !== 'string') throw new ProviderError(-32602, 'Invalid balance account.');
    await broker.approveBalance(id, identity, message.accountId, message.snapshot);
    return { ok: true };
  }
  if (message.action === 'sign') {
    if (typeof message.accountId !== 'string' || typeof message.fee !== 'string' || !/^\d{1,12}$/.test(message.fee) || BigInt(message.fee) > MAX_NETWORK_FEE) throw new ProviderError(-32602, 'Invalid payment approval.');
    return { ok: true, value: await broker.beginSigning(id, identity, message.accountId, message.fee) };
  }
  if (message.action === 'broadcast') {
    if (typeof message.hex !== 'string' || !/^(?:[0-9a-f]{2}){50,200000}$/.test(message.hex) || typeof message.txid !== 'string' || !/^[0-9a-f]{64}$/.test(message.txid)) throw new ProviderError(-32602, 'Invalid signed transaction.');
    // The marker reaches storage BEFORE any HTTP request. Never retry on restart.
    await broker.beginBroadcast(id, identity, message.txid);
    let confirmed = false;
    try {
      // Mainnet-only and fixed broadcaster. The website cannot supply an endpoint.
      const response = await fetch('https://pearlchain.live/api/explorer/broadcast', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hex: message.hex }), signal: AbortSignal.timeout(25_000),
      });
      const result: unknown = await response.json();
      confirmed = response.ok && isRecord(result) && result.txid === message.txid;
    } catch { /* Ambiguous outcomes preserve the computed txid. No retry. */ }
    await broker.finishBroadcast(id, confirmed);
    if (!confirmed) throw new ProviderError(-32002, 'Submission outcome is unknown. Check this transaction before retrying.', { txid: message.txid });
    return { ok: true, value: { txid: message.txid } };
  }
  throw new ProviderError(4200, 'Unknown approval action.');
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isRecord(message) || typeof message.type !== 'string' || !message.type.startsWith('nacre:')) return false;
  void handleMessage(message, sender).then(sendResponse, error => sendResponse({ ok: false, error: rpcError(error) }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === AUTOLOCK_ALARM) void chrome.storage.session.remove(SESSION_KEY);
  if (alarm.name === REQUEST_ALARM) void broker.sweep().catch(() => {});
});
chrome.windows.onRemoved.addListener(id => { void broker.windowClosed(id).catch(() => {}); });
chrome.tabs.onRemoved.addListener(id => { void broker.documentClosed(id).catch(() => {}); });
chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'loading' || info.url) void broker.documentClosed(id).catch(() => {}); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['pearlchain.wallet.meta'] && !changes['pearlchain.wallet.meta'].newValue) void broker.revokeAll().catch(() => {});
  const metaChange = area === 'local' ? changes['pearlchain.wallet.meta'] : undefined;
  if (metaChange) {
    let changed = true;
    try { changed = balanceContext(metaChange.oldValue) !== balanceContext(metaChange.newValue); } catch { /* Removal or invalid metadata revokes in-flight reads. */ }
    if (changed) void broker.invalidateBalances().catch(() => {});
  }
  if (area === 'session' && changes[SESSION_KEY]) void broker.invalidateBalances().catch(() => {});
  if (area === 'local' && ['pearlchain.wallet.v1', 'pearlchain.wallet.seeds', 'pearlchain.wallet.imported'].some(key => key in changes)) void broker.invalidateBalances().catch(() => {});
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'popup' || !port.sender || !isPopup(port.sender)) return;
  const onClosed = async (documentId?: string) => {
    if (documentId) await broker.popupClosed(documentId);
    await trustedStorage;
    const data = await chrome.storage.local.get('pearlchain.wallet.meta');
    if (data['pearlchain.wallet.meta']?.autoLockMins === 0) await chrome.storage.session.remove(SESSION_KEY);
  };
  if (nativeOnlyFirefox) port.onDisconnect.addListener(() => { void onClosed().catch(() => {}); });
  else trackPopupClose(port, popupUrl, onClosed);
});
