// In-memory balance snapshots. Essential scan/protection data is published
// atomically; optional market/history requests cannot delay that publication.
import type { HDKey } from '@scure/bip32';
import type { WalletScan } from '@/pearl/hdwallet';
import type { PearlNetwork } from '@/pearl/network';
import { selectFeePolicy, type FeePolicyResult } from '@/pearl/fee-policy';
import { getHD } from './session';
import { scanCurrentAccount } from './accounts';
import { getStats, getPrice, getWalletHistory, pnsOwnedByStrict, getBaseUrl, getBackendMode } from '@/api/client';
import { resolveProtectedCoins } from './protectedCoins';
import type { AddressTx, BackendMode } from '@/api/client';
import { loadMeta, type WalletMeta, type AccountDescriptor } from '@/storage/vault';

interface CacheState {
  scan: WalletScan | null;
  account: AccountDescriptor | null;
  network: PearlNetwork | null;
  priceUsd: number | null;
  feeRate: number | null;
  feeVerified: boolean;
  feePolicy: FeePolicyResult | null;
  txs: AddressTx[];
  lastSync: number;
  syncErr: string | null;
  protectedOutpoints: Set<string>;
  namesVerified: boolean;
}

const empty = (): CacheState => ({
  scan: null, account: null, network: null, priceUsd: null, feeRate: null, feeVerified: false, feePolicy: null,
  txs: [], lastSync: 0, syncErr: null, protectedOutpoints: new Set(), namesVerified: false,
});
const cache = empty();
interface Context {
  hd: HDKey; account: AccountDescriptor; network: PearlNetwork;
  metaKey: string; baseUrl: string; mode: BackendMode;
}
let generation = 0;
let cacheContext: Context | null = null;
let active: { context: Context; promise: Promise<void> } | null = null;

// Labels and auto-lock preferences do not change which coins an account owns.
function metaKey(meta: WalletMeta | null | undefined): string {
  const account = meta?.accounts?.find(a => a.id === meta.selectedAccountId);
  if (!meta || !account || !['mainnet', 'testnet'].includes(meta.network)) throw new Error('No valid wallet account selected.');
  return JSON.stringify([meta.createdAt, meta.network, meta.explorerUrl, meta.explorerMode,
    account.id, account.type, account.type === 'hd'
      ? [account.coinType, account.account, account.seedId]
      : account.address]);
}

function notify(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('nacre:wallet-updated'));
}

function reset(emit: boolean): void {
  generation++;
  active = null;
  cacheContext = null;
  Object.assign(cache, empty());
  if (emit) notify();
}

export function clearCache(): void { reset(true); }

export function getCache(): CacheState {
  if (cacheContext && (getHD() !== cacheContext.hd || getBaseUrl() !== cacheContext.baseUrl || getBackendMode() !== cacheContext.mode)) reset(false);
  return cache;
}

function sameContext(a: Context, b: Context): boolean {
  return a.hd === b.hd && a.metaKey === b.metaKey && a.baseUrl === b.baseUrl && a.mode === b.mode;
}

async function current(context: Context, revision: number): Promise<boolean> {
  if (revision !== generation) return false;
  let valid = getHD() === context.hd && getBaseUrl() === context.baseUrl && getBackendMode() === context.mode;
  if (valid) {
    try { valid = metaKey(await loadMeta()) === context.metaKey; }
    catch { valid = false; }
  }
  if (revision !== generation) return false;
  valid = valid && getHD() === context.hd && getBaseUrl() === context.baseUrl && getBackendMode() === context.mode;
  if (!valid) reset(true);
  return valid;
}

async function optionalData(context: Context, revision: number, scan: WalletScan): Promise<void> {
  // These updates are independent and each checks ownership after its await.
  await Promise.allSettled([
    (async () => {
      const price = await getPrice();
      if (!await current(context, revision)) return;
      cache.priceUsd = typeof price?.price === 'number' && Number.isFinite(price.price) && price.price > 0 ? price.price : null;
      notify();
    })(),
    (async () => {
      const history = await getWalletHistory(scan.addresses.map(a => a.address));
      if (!await current(context, revision)) return;
      if (Array.isArray(history)) cache.txs = history;
      notify();
    })(),
  ]);
}

async function refresh(context: Context, revision: number): Promise<void> {
  try {
    const [scan, stats] = await Promise.all([
      scanCurrentAccount(context.network, context.account),
      getStats().catch(() => null),
    ]);
    if (!await current(context, revision)) return;
    const protection = await resolveProtectedCoins(context.account.id, scan.utxos.map(u => u.address), pnsOwnedByStrict);
    if (!await current(context, revision)) return;
    const feePolicy = selectFeePolicy(stats);
    const feeVerified = feePolicy.available && feePolicy.source === 'network';
    Object.assign(cache, {
      scan, account: context.account, network: context.network,
      protectedOutpoints: protection.outpoints, namesVerified: protection.verified,
      feeRate: feeVerified ? stats!.recommendedFee : null, feeVerified, feePolicy, lastSync: Date.now(), syncErr: null,
    });
    notify();
    void optionalData(context, revision, scan);
  } catch (error) {
    if (!await current(context, revision)) return;
    // A failed refresh must not leave an older balance looking current.
    Object.assign(cache, empty(), { account: context.account, network: context.network,
      syncErr: error instanceof Error ? error.message : 'The wallet balance is unavailable. Try refreshing.' });
    notify();
  }
}

export async function refreshWallet(): Promise<void> {
  const hd = getHD();
  if (!hd) { clearCache(); return; }
  const started = generation;
  let context: Context;
  try {
    const meta = await loadMeta();
    const key = metaKey(meta);
    context = { hd, account: { ...meta!.accounts.find(a => a.id === meta!.selectedAccountId)! },
      network: meta!.network, metaKey: key, baseUrl: getBaseUrl(), mode: getBackendMode() };
  } catch (error) {
    if (started === generation && getHD() === hd) {
      reset(false);
      cache.syncErr = error instanceof Error ? error.message : 'The wallet account is unavailable.';
      notify();
    }
    return;
  }
  if (getHD() !== hd) return;
  if (active && sameContext(active.context, context)) return active.promise;
  if (started !== generation) return;
  if (!cacheContext || !sameContext(cacheContext, context)) Object.assign(cache, empty());
  cacheContext = context;
  const revision = ++generation;
  const promise = refresh(context, revision);
  active = { context, promise };
  try { await promise; }
  finally { if (active?.promise === promise) active = null; }
}

// Invalidate at the change event too: an A -> B -> A switch must not revive a
// scan that began before either selection change (same for lock/re-unlock).
if (typeof chrome !== 'undefined') chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && 'pearl.session.mnemonic' in changes) { clearCache(); return; }
  if (area !== 'local') return;
  if ('pearlchain.wallet.v1' in changes || 'pearlchain.wallet.seeds' in changes || 'pearlchain.wallet.imported' in changes) {
    clearCache(); return;
  }
  const changed = changes['pearlchain.wallet.meta'];
  if (changed) {
    try { if (metaKey(changed.oldValue) === metaKey(changed.newValue)) return; }
    catch { /* A removed or invalid descriptor also invalidates the cache. */ }
    clearCache();
  }
});
