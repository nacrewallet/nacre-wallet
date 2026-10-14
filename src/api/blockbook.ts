// Blockbook v2 adapter. Trezor's open-source Bitcoin-fork indexer; the Pearl
// instance lives at https://blockbook.pearlresearch.ai (no auth).
// Ported from pearlchain-mobile/src/api/blockbook.ts unchanged in behaviour.

import type {
  AddressData, AddressTx, ExplorerStats, PriceData, ScanResult, TxDetail,
  TxVin, TxVout, UtxoDto,
} from './types';
import { atomicValue, validateScanResults, validateUtxos } from './scan-validation';
import { blockbookFeeRate } from './fee-estimate';

interface BBInfo {
  blockbook?: { coin?: string; bestHeight?: number; inSync?: boolean; mempoolSize?: number };
  backend?:   { chain?: string; blocks?: number; difficulty?: string; subversion?: string };
}
interface BBTxInput  {
  txid?: string; vout?: number; n?: number;
  addresses?: string[]; isAddress?: boolean;
  value?: string; coinbase?: string;
}
interface BBTxOutput { value: string; n: number; addresses?: string[]; isAddress?: boolean; hex?: string }
interface BBTx {
  txid: string; vin: BBTxInput[]; vout: BBTxOutput[];
  blockHash?: string; blockHeight?: number; confirmations?: number; blockTime?: number;
  size?: number; vsize?: number; fees?: string;
}
interface BBAddress {
  address: string; balance?: string;
  totalReceived?: string; totalSent?: string;
  unconfirmedBalance?: string; unconfirmedTxs?: number;
  txs?: number; transactions?: BBTx[]; txids?: string[];
  page?: number; totalPages?: number; itemsOnPage?: number;
}
interface BBUtxo { txid: string; vout: number; value: string; height?: number; confirmations: number }

async function timedFetch(url: string, opts: RequestInit = {}, ms = 12_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { cache: 'no-store', ...opts, signal: opts.signal ? AbortSignal.any([ctrl.signal, opts.signal]) : ctrl.signal }); }
  finally { clearTimeout(t); }
}

function num(v: string | number | undefined | null): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const x = Number(v); return Number.isFinite(x) ? x : 0;
}

export async function getStats(baseUrl: string, signal?: AbortSignal): Promise<ExplorerStats | null> {
  try {
    const [infoR, feeR] = await Promise.allSettled([
      timedFetch(`${baseUrl}/api/v2/`, { signal }),
      timedFetch(`${baseUrl}/api/v2/estimatefee/2`, { signal }),
    ]);
    if (infoR.status !== 'fulfilled' || !infoR.value.ok) return null;
    const info = (await infoR.value.json()) as BBInfo;
    if (info.backend?.chain !== 'mainnet' || info.blockbook?.inSync !== true) return null;
    let recommendedFee: number | null = null;
    if (feeR.status === 'fulfilled' && feeR.value.ok) {
      try {
        const d = (await feeR.value.json()) as { result?: unknown };
        recommendedFee = blockbookFeeRate(d?.result);
      } catch { recommendedFee = NaN; }
    }
    return {
      blockHeight: info.backend?.blocks ?? info.blockbook?.bestHeight ?? null,
      networkHashPs: null,
      difficulty: info.backend?.difficulty != null ? Number(info.backend.difficulty) : null,
      recommendedFee, mempoolMinFee: null, mintedPct: null,
    };
  } catch { return null; }
}

export async function getUtxos(baseUrl: string, addr: string, signal?: AbortSignal): Promise<UtxoDto[]> {
  const r = await timedFetch(`${baseUrl}/api/v2/utxo/${encodeURIComponent(addr)}`, { signal });
  if (!r.ok) throw new Error(`The explorer could not load wallet coins (HTTP ${r.status}).`);
  const list = await r.json() as BBUtxo[];
  if (!Array.isArray(list)) throw new Error('The explorer returned invalid wallet coins.');
  return validateUtxos(list.map(u => {
    if (!u || !Number.isSafeInteger(u.confirmations) || u.confirmations < 0 || (u.confirmations > 0 && u.height == null)) {
      throw new Error('The explorer returned invalid wallet coin confirmations.');
    }
    return { txid: u.txid, vout: u.vout, value: u.value, blockHeight: u.height ?? 0 };
  }));
}

export async function scanAddresses(baseUrl: string, addresses: string[], signal?: AbortSignal): Promise<ScanResult[]> {
  if (addresses.length === 0) return [];
  const results = await Promise.all(addresses.map(async (addr) => {
    // Basic details omit the mempool balance. Request the smallest txid page
    // so the balance includes pending spends/receipts, just like /utxo.
    const r = await timedFetch(`${baseUrl}/api/v2/address/${encodeURIComponent(addr)}?details=txids&page=1&pageSize=1`, { signal });
    if (!r.ok) throw new Error(`The explorer could not scan this wallet (HTTP ${r.status}).`);
    const meta = await r.json() as BBAddress;
    if (!meta || meta.address !== addr || !Number.isSafeInteger(meta.txs) || meta.txs! < 0
      || !Number.isSafeInteger(meta.unconfirmedTxs) || meta.unconfirmedTxs! < 0
      || typeof meta.unconfirmedBalance !== 'string' || !/^-?(0|[1-9]\d{0,18})$/.test(meta.unconfirmedBalance)) {
      throw new Error('The explorer returned incomplete wallet address data.');
    }
    const confirmed = atomicValue(meta.balance);
    const pending = meta.unconfirmedBalance.startsWith('-')
      ? -atomicValue(meta.unconfirmedBalance.slice(1)) : atomicValue(meta.unconfirmedBalance);
    const balance = atomicValue((confirmed + pending).toString());
    const used = meta.txs! > 0 || meta.unconfirmedTxs! > 0;
    const utxos = used ? await getUtxos(baseUrl, addr, signal) : [];
    return { address: addr, used, balance: balance.toString(), utxos };
  }));
  return validateScanResults(addresses, results);
}

function netForAddrs(tx: BBTx, addrSet: Set<string>): { received: number; sent: number } {
  let received = 0, sent = 0;
  for (const o of tx.vout ?? []) if (o.addresses?.some((a) => addrSet.has(a))) received += num(o.value);
  for (const i of tx.vin  ?? []) if (i.addresses?.some((a) => addrSet.has(a))) sent     += num(i.value);
  return { received, sent };
}

function txToAddressTx(tx: BBTx, addrSet: Set<string>): AddressTx {
  const { received, sent } = netForAddrs(tx, addrSet);
  const net = received - sent;
  return {
    txid: tx.txid,
    time: tx.blockTime ?? null,
    blockHeight: tx.blockHeight ?? null,
    confirmed: (tx.confirmations ?? 0) > 0,
    received, sent, net,
    direction: net > 0 ? 'in' : net < 0 ? 'out' : 'self',
  };
}

export async function getAddress(baseUrl: string, addr: string, page = 0): Promise<AddressData | null> {
  try {
    const url = `${baseUrl}/api/v2/address/${encodeURIComponent(addr)}?details=txs&page=${page + 1}&pageSize=50`;
    const r = await timedFetch(url);
    if (!r.ok) return null;
    const d = (await r.json()) as BBAddress;
    const addrSet = new Set([addr]);
    const transactions = (d.transactions ?? []).map((t) => txToAddressTx(t, addrSet));
    return {
      address: d.address, balance: num(d.balance),
      txTotal: d.txs ?? transactions.length,
      utxoCount: 0, firstTime: null, lastTime: transactions[0]?.time ?? null,
      page, pageSize: 50, transactions,
    };
  } catch { return null; }
}

export async function getTx(baseUrl: string, txid: string): Promise<TxDetail | null> {
  try {
    const r = await timedFetch(`${baseUrl}/api/v2/tx/${encodeURIComponent(txid)}`);
    if (!r.ok) return null;
    const tx = (await r.json()) as BBTx;
    const isCoinbase = (tx.vin ?? []).some((v) => v.coinbase != null);
    const vin:  TxVin[]  = (tx.vin  ?? []).map((v) => ({ isCoinbase: v.coinbase != null, address: v.addresses?.[0] ?? null, value: v.value != null ? num(v.value) : null }));
    const vout: TxVout[] = (tx.vout ?? []).map((v) => ({ n: v.n, address: v.addresses?.[0] ?? null, value: num(v.value) }));
    return {
      txid: tx.txid,
      blockHeight: tx.blockHeight ?? null,
      blockTime: tx.blockTime ?? null,
      confirmations: tx.confirmations ?? null,
      fee: tx.fees != null ? num(tx.fees) : null,
      isCoinbase, vin, vout,
    };
  } catch { return null; }
}

export async function broadcastTx(baseUrl: string, hex: string): Promise<{ txid?: string; error?: string }> {
  try {
    const r = await fetch(`${baseUrl}/api/v2/sendtx/`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: hex,
    });
    const text = await r.text();
    let data: { result?: string; error?: { message?: string } | string } | null = null;
    try { data = text ? JSON.parse(text) : null; } catch {
      return { error: `Network/gateway error (HTTP ${r.status}). Your transaction may or may not have been sent — check the explorer before retrying.` };
    }
    const errMsg = (data?.error && typeof data.error === 'object') ? data.error.message
                  : typeof data?.error === 'string' ? data.error : undefined;
    if (!r.ok) return { error: errMsg ?? `Broadcast failed (HTTP ${r.status}).` };
    if (data?.result) return { txid: data.result };
    return { error: errMsg ?? 'Broadcast failed (no txid).' };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function getPrice(): Promise<PriceData | null> { return null; }

export async function getWalletHistory(baseUrl: string, addresses: string[]): Promise<AddressTx[] | null> {
  if (addresses.length === 0) return [];
  try {
    const results = await Promise.allSettled(addresses.map(async (addr) => {
      const r = await timedFetch(`${baseUrl}/api/v2/address/${encodeURIComponent(addr)}?details=txs&page=1&pageSize=25`);
      if (!r.ok) return null;
      return (await r.json()) as BBAddress;
    }));
    const seen = new Map<string, BBTx>();
    for (const res of results) {
      if (res.status !== 'fulfilled' || !res.value) continue;
      for (const tx of res.value.transactions ?? []) if (!seen.has(tx.txid)) seen.set(tx.txid, tx);
    }
    const addrSet = new Set(addresses);
    return Array.from(seen.values())
      .sort((a, b) => (b.blockHeight ?? 0) - (a.blockHeight ?? 0))
      .slice(0, 50)
      .map((tx) => txToAddressTx(tx, addrSet));
  } catch { return null; }
}
