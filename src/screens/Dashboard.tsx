import { useEffect, useState } from 'react';
import { lock } from '@/state/session';
import { getCache, refreshWallet } from '@/state/walletState';
import { formatPearlAmount } from '@/pearl/money';
import { shortAddr, fmtUsd, timeAgo } from '@/ui/format';
import { toast } from '@/ui/Toast';
import { AccountSwitcher } from '@/ui/AccountSwitcher';
import { PriceChart } from '@/ui/PriceChart';
import { LockIcon, SendIcon, ReceiveIcon, CopyIcon, RefreshIcon } from '@/ui/icons';
import prlUrl from '@/assets/prl.svg';

export interface TxClickArgs {
  txid: string; net: number; direction: 'in' | 'out' | 'self'; time: number | null; blockHeight: number | null;
}
interface DashboardProps { onSend: () => void; onReceive: () => void; onLocked: () => void; onAddAccount: () => void; }
const SWAP_URL = 'https://nacre.finance/';

export function Dashboard({ onSend, onReceive, onLocked, onAddAccount }: DashboardProps) {
  const [, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let active = true;
    const sync = () => refreshWallet().then(() => { if (active) setTick(t => t + 1); });
    const update = () => { if (active) setTick(t => t + 1); };
    window.addEventListener('nacre:wallet-updated', update);
    void sync();
    const id = window.setInterval(sync, 30_000);
    return () => { active = false; clearInterval(id); window.removeEventListener('nacre:wallet-updated', update); };
  }, []);
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try { await refreshWallet(); setTick(t => t + 1); }
    finally { setRefreshing(false); }
  }
  const c = getCache();
  const pearl = c.scan ? formatPearlAmount(c.scan.balance) : '—';
  const usd = c.scan && c.priceUsd != null ? Number(c.scan.balance) / 1e8 * c.priceUsd : null;
  const address = c.scan?.receiveAddress ?? '';
  async function copyAddress() {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    toast('Address copied');
  }
  async function openSwap() {
    try { await chrome.tabs.create({ url: SWAP_URL }); }
    catch { toast('Unable to open Nacre Swap. Please try again.'); }
  }
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="wallet-header">
        <AccountSwitcher onChanged={refresh} onAddAccount={onAddAccount} />
        <button onClick={async () => { await lock(); onLocked(); }} className="icon-badge tap w-8 h-8" aria-label="Lock wallet" title="Lock wallet"><LockIcon size={15} /></button>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <section className="balance-section" aria-label="Wallet balance">
          <div className="balance-label">Total balance</div>
          <div className="balance-value"><strong title={pearl}>{pearl}</strong><span>PRL</span></div>
          <div className="balance-fiat">{usd != null ? `≈ $${fmtUsd(usd)} USD` : c.scan ? 'USD value unavailable' : c.syncErr ? 'Network unavailable. Try refreshing.' : 'Syncing your wallet…'}</div>
          <button className="address-chip" onClick={copyAddress} disabled={!address} aria-label="Copy your Pearl address"><span className="font-mono">{address ? shortAddr(address, 9, 6) : 'Loading address…'}</span><CopyIcon size={11} /></button>
        </section>
        <div className="wallet-actions">
          <button onClick={onReceive} className="wallet-action tap"><ReceiveIcon /><span>Receive</span></button>
          <button onClick={onSend} disabled={!c.scan || c.scan.balance === 0n} className="wallet-action tap"><SendIcon /><span>Send</span></button>
          <button onClick={openSwap} className="wallet-action swap tap" aria-label="Swap on Nacre, opens in a new tab"><RefreshIcon /><span>Swap</span></button>
        </div>
        <section className="asset-section" aria-label="Assets">
          <div className="section-caption"><span>Your assets</span><span>Pearl network</span></div>
          <div className="asset-row">
            <img src={prlUrl} alt="" className="asset-icon" />
            <div className="min-w-0 flex-1"><div className="asset-row-title">Pearl</div><div className="asset-row-sub">Native PRL</div></div>
            <div className="text-right min-w-0 max-w-[175px]"><div className="asset-row-amount truncate" title={`${pearl} PRL`}>{pearl} PRL</div><div className="asset-row-sub">{usd != null ? `$${fmtUsd(usd)}` : '—'}</div></div>
          </div>
        </section>
        <section className="wallet-market" aria-label="Pearl market">
          <PriceChart priceUsd={c.priceUsd ?? null} />
          <div className="sync-note"><RefreshIcon size={10} className={refreshing ? 'spin' : ''} /><span>{refreshing ? 'Syncing…' : c.syncErr ? 'Connection interrupted' : c.lastSync ? `Updated ${timeAgo(Math.floor(c.lastSync / 1000))}` : 'Waiting for network'}</span><button disabled={refreshing} onClick={refresh}>Refresh</button></div>
        </section>
      </div>
    </div>
  );
}
