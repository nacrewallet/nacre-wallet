// Send flow: paste address + amount + fee, review, sign & broadcast.

import { useState, useEffect } from 'react';
import { isValidAddress } from '@/pearl/address';
import { parsePaymentUri, formatPearl, grainsToPearl, type PearlNetwork } from '@/pearl/network';
import { parsePearlAmount, formatPearlAmount } from '@/pearl/money';
import { feeRateForPolicy } from '@/pearl/fee-policy';
import { buildAndSignTx, quoteSend } from '@/pearl/transaction';
import { broadcastTx, resolvePns } from '@/api/client';
import { getCache, refreshWallet } from '@/state/walletState';
import { protectedValue } from '@/state/protectedCoins';
import { buildCurrentSigner } from '@/state/accounts';
import { loadMeta, selectedAccount } from '@/storage/vault';
import type { ScannedUtxo } from '@/pearl/hdwallet';
import { fmtUsd } from '@/ui/format';
import { toast } from '@/ui/Toast';
import { ScreenHeader } from '@/ui/ScreenHeader';

type Step = 'form' | 'review' | 'broadcast';
interface ReviewedPayment {
  accountId: string; network: PearlNetwork; recipient: string; pnsName: string | null;
  amount: bigint; fee: bigint; change: bigint; feeRate: bigint; feeTier: number; sendMax: boolean;
  feeSource: 'network' | 'fallback';
  utxos: ScannedUtxo[]; protectedOutpoints: Set<string>; changeAddress: string;
}
function inputFingerprint(utxos: ScannedUtxo[]): string {
  return utxos.map(u => [u.txid, u.vout, u.value.toString(), u.address, u.chain, u.index].join(':')).sort().join('|');
}

interface FeeTier { label: string; mult: number }
const TIERS: FeeTier[] = [
  { label: 'Economic', mult: 0.8 },
  { label: 'Standard', mult: 1.0 },
  { label: 'Priority', mult: 1.5 },
];

interface SendProps {
  onBack:     () => void;
  onSent:     (txid: string) => void;
  onPickContact: () => void;
  initialRecipient?: string;
  initialAmount?:    string;
}

export function Send({ onBack, onSent, onPickContact, initialRecipient, initialAmount }: SendProps) {
  const [step, setStep] = useState<Step>('form');
  const [reviewed, setReviewed] = useState<ReviewedPayment | null>(null);
  const [recipient, setRecip]   = useState(initialRecipient ?? '');
  const [amount, setAmount]     = useState(initialAmount ?? '');
  const [sendMax, setSendMax] = useState(false);
  const [, setRevision] = useState(0);
  const [refreshingNames, setRefreshingNames] = useState(false);
  const [tierIdx, setTierIdx]   = useState(1);
  const [busy, setBusy]         = useState(false);
  const [pns, setPns]           = useState<{ name: string; address: string } | null>(null);
  const [pnsChecking, setPnsChk] = useState(false);

  // Resolve a typed .pns name → address (debounced). Raw prl1p… addresses skip it.
  useEffect(() => {
    setPns(null);
    const raw = recipient.trim().toLowerCase();
    if (raw === '' || raw.startsWith('prl1') || raw.startsWith('tprl1')) { setPns(null); setPnsChk(false); return; }
    const name = raw.replace(/\.pns$/, '');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) { setPns(null); setPnsChk(false); return; }
    let cancelled = false;
    setPnsChk(true);
    const t = setTimeout(async () => {
      const addr = await resolvePns(name);
      if (!cancelled) { setPns(addr ? { name, address: addr } : null); setPnsChk(false); }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [recipient]);

  function onPasteRecipient(v: string) {
    setPns(null);
    const parsed = parsePaymentUri(v);
    if (parsed) {
      setRecip(parsed.address);
      const exactAmount = new URLSearchParams(v.split('?')[1] ?? '').get('amount');
      if (exactAmount !== null) { setAmount(exactAmount); setSendMax(false); }
    } else {
      setRecip(v);
    }
  }

  const c = getCache();
  // A resolved .pns name sends to its address; otherwise use what was typed.
  const normalizedName = recipient.trim().toLowerCase().replace(/\.pns$/, '');
  const resolvedPns = pns && pns.name === normalizedName && !pnsChecking ? pns : null;
  const effectiveRecipient = resolvedPns?.address ?? recipient.trim();
  const addrValid = !pnsChecking && isValidAddress(effectiveRecipient);
  const parsedAmount = parsePearlAmount(amount);
  const nameValue = protectedValue(c.scan?.utxos ?? [], c.protectedOutpoints);
  const balance = (c.scan?.balance ?? 0n) - nameValue;
  function rateFor(i: number): bigint | null {
    try { return c.feePolicy?.available ? feeRateForPolicy(c.feePolicy, TIERS[i].mult) : null; }
    catch { return null; }
  }
  function quoteFor(i: number): ReturnType<typeof quoteSend> {
    try {
      const feeRate = rateFor(i);
      if (feeRate === null) throw new Error(c.feePolicy && !c.feePolicy.available ? c.feePolicy.reason : 'This fee estimate is unavailable. Refresh the wallet or choose another tier.');
      return quoteSend({ utxos: c.scan?.utxos ?? [], protectedOutpoints: c.protectedOutpoints, amount: parsedAmount ?? 0n, feeRate, sendMax });
    } catch (error) {
      return { ok: false, amount: 0n, fee: 0n, change: 0n, inputCount: 0, spendable: balance, shortfall: 0n, error: error instanceof Error ? error.message : 'Unable to estimate this transaction.' };
    }
  }
  const quote = quoteFor(tierIdx);
  const amountGrains = quote.amount;
  const amountValid = amountGrains > 0n && (sendMax || parsedAmount !== null);
  const hasFunds = amountValid && quote.ok && c.namesVerified;
  const feeRate = rateFor(tierIdx);
  const feeEst = quote.fee;
  function estFeeGrains(i: number): bigint { return quoteFor(i).fee; }

  // USD helpers — null when price not yet loaded.
  const priceUsd = c.priceUsd ?? null;
  const usdOf    = (grains: bigint): number | null =>
    priceUsd != null ? grainsToPearl(grains) * priceUsd : null;
  const amountUsd  = amountValid ? usdOf(amountGrains) : null;
  const balanceUsd = usdOf(balance);
  const feeUsd     = usdOf(feeEst);

  async function reviewPayment() {
    if (!hasFunds || !addrValid || busy) return;
    setBusy(true);
    try {
      const startedAt = Date.now();
      await refreshWallet();
      const [meta, account] = await Promise.all([loadMeta(), selectedAccount()]);
      const latest = getCache();
      if (!latest.scan || latest.syncErr || latest.lastSync < startedAt || !latest.namesVerified || !account || latest.account?.id !== account.id || latest.network !== meta?.network) throw new Error('Your account could not be refreshed. Refresh the wallet and review again.');
      if (!latest.feePolicy?.available) throw new Error(latest.feePolicy?.reason ?? 'The fee estimate is unavailable. Refresh the wallet.');
      const currentRate = feeRateForPolicy(latest.feePolicy, TIERS[tierIdx].mult);
      const currentQuote = quoteSend({ utxos: latest.scan.utxos, protectedOutpoints: latest.protectedOutpoints, amount: parsedAmount ?? 0n, feeRate: currentRate, sendMax });
      if (!currentQuote.ok) throw new Error(currentQuote.error || 'Unable to prepare this payment.');
      setReviewed({ accountId: account.id, network: meta?.network ?? 'mainnet', recipient: effectiveRecipient, pnsName: resolvedPns?.name ?? null,
        amount: currentQuote.amount, fee: currentQuote.fee, change: currentQuote.change, feeRate: currentRate, feeTier: tierIdx, sendMax,
        feeSource: latest.feePolicy.source,
        utxos: latest.scan.utxos.map(u => ({ ...u })), protectedOutpoints: new Set(latest.protectedOutpoints),
        changeAddress: latest.scan.nextChangeAddress || latest.scan.receiveAddress });
      setStep('review');
    } catch (error) { toast(error instanceof Error ? error.message : 'Unable to review payment.'); }
    finally { setBusy(false); }
  }

  async function doSend() {
    if (!reviewed || busy) return;
    setBusy(true);
    try {
      const [meta, account] = await Promise.all([loadMeta(), selectedAccount()]);
      if (account?.id !== reviewed.accountId || (meta?.network ?? 'mainnet') !== reviewed.network) throw new Error('Your account changed. Review this payment again.');
      const startedAt = Date.now();
      await refreshWallet();
      const signer = await buildCurrentSigner(reviewed.network);
      const [checkedAccount, checkedMeta] = await Promise.all([selectedAccount(), loadMeta()]);
      const latest = getCache();
      if (checkedAccount?.id !== reviewed.accountId || (checkedMeta?.network ?? 'mainnet') !== reviewed.network || latest.network !== reviewed.network || latest.account?.id !== reviewed.accountId || !latest.scan || latest.syncErr || latest.lastSync < startedAt || !latest.namesVerified) throw new Error('Your account or name protection changed. Review this payment again.');
      if (!latest.feePolicy?.available || latest.feePolicy.source !== reviewed.feeSource) throw new Error('The fee estimate changed. Review this payment again.');
      const currentRate = feeRateForPolicy(latest.feePolicy, TIERS[reviewed.feeTier].mult);
      const currentQuote = quoteSend({ utxos: latest.scan.utxos, protectedOutpoints: latest.protectedOutpoints, amount: reviewed.amount, feeRate: currentRate, sendMax: reviewed.sendMax });
      if (!currentQuote.ok || currentQuote.amount !== reviewed.amount || currentQuote.fee !== reviewed.fee || currentQuote.change !== reviewed.change || currentRate !== reviewed.feeRate || inputFingerprint(latest.scan.utxos) !== inputFingerprint(reviewed.utxos) || [...latest.protectedOutpoints].sort().join('|') !== [...reviewed.protectedOutpoints].sort().join('|') || (latest.scan.nextChangeAddress || latest.scan.receiveAddress) !== reviewed.changeAddress) throw new Error('Your balance or network fee changed. Review this payment again.');
      const tx = buildAndSignTx({ signer, network: reviewed.network, recipient: reviewed.recipient, amount: reviewed.amount, sendMax: reviewed.sendMax,
        utxos: reviewed.utxos, protectedOutpoints: reviewed.protectedOutpoints, feeRate: reviewed.feeRate, changeAddress: reviewed.changeAddress });
      if (tx.feeGrains !== reviewed.fee || tx.changeGrains !== reviewed.change) throw new Error('The payment no longer matches your review. Please try again.');
      setStep('broadcast');
      const res = await broadcastTx(tx.hex);
      if (res.txid) {
        toast('Payment sent');
        await refreshWallet();
        onSent(res.txid);
      } else { throw new Error(res.error ?? 'Broadcast failed. Please try again.'); }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to send this payment.');
      setReviewed(null);
      setStep('form');
    } finally { setBusy(false); }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ScreenHeader title="Send PRL" onBack={() => step === 'form' ? onBack() : setStep('form')} />

      {step === 'form' && (
        <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-pearl-600 font-semibold flex justify-between items-center">
              <span>Recipient</span>
              <button
                onClick={onPickContact}
                className="text-[11px] text-pearl-500 hover:text-pearl-200 underline decoration-pearl-700"
                type="button"
              >From contacts</button>
            </span>
            <input
              value={recipient}
              onChange={(e) => onPasteRecipient(e.target.value)}
              placeholder="prl1p…, name.pns, or pearl: URI"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              className="mt-1 w-full bg-ink-900 border border-ink-700 rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-pearl-700 text-pearl-200"
            />
            {pns ? (
              <div className="text-xs text-emerald-700 dark:text-emerald-400 mt-1 font-mono break-all">✓ {pns.name}.pns → {pns.address.slice(0, 14)}…{pns.address.slice(-6)}</div>
            ) : pnsChecking ? (
              <div className="text-xs text-pearl-600 mt-1">resolving .pns…</div>
            ) : recipient && !addrValid ? (
              <div className="text-xs text-rose-700 dark:text-rose-400 mt-1">
                {!/^t?prl1/i.test(recipient.trim()) && /^[a-z0-9][a-z0-9-]{0,62}(\.pns)?$/i.test(recipient.trim()) ? 'No .pns name found' : 'Invalid Pearl address'}
              </div>
            ) : null}
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-pearl-600 font-semibold flex justify-between items-center">
              <span>Amount</span>
              <button
                onClick={() => { if (c.scan) setSendMax(true); }}
                className="text-[11px] text-pearl-500 hover:text-pearl-200 underline decoration-pearl-700"
                type="button"
              >MAX</button>
            </span>
            <div className="mt-1 flex">
              <input
                value={sendMax ? formatPearlAmount(amountGrains) : amount}
                onChange={(e) => { setSendMax(false); setAmount(e.target.value); }}
                placeholder="0.0"
                inputMode="decimal"
                className="flex-1 bg-ink-900 border border-ink-700 rounded-l-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-pearl-700 text-pearl-200"
              />
              <span className="px-3 py-2.5 bg-ink-800 border border-ink-700 rounded-r-lg text-sm text-pearl-400">PRL</span>
            </div>
            <div className="text-xs text-pearl-600 mt-1 flex justify-between">
              <span>
                {nameValue > 0n ? 'Spendable' : 'Balance'}: {c.scan ? formatPearl(balance, 4) : '—'}
                {balanceUsd != null && (
                  <span className="text-pearl-500 ml-1">≈ ${fmtUsd(balanceUsd)}</span>
                )}
              </span>
              {amountUsd != null && (
                <span className="text-pearl-500">≈ ${fmtUsd(amountUsd)}</span>
              )}
            </div>
            {amount && !sendMax && parsedAmount === null && <div className="text-xs text-rose-700 dark:text-rose-400 mt-1">Enter a valid amount with up to 8 decimal places.</div>}
            {(amount || sendMax) && !quote.ok && <div className="text-xs text-rose-700 dark:text-rose-400 mt-1">{quote.error || 'Insufficient balance, including the network fee.'}</div>}
            {nameValue > 0n && (
              <div className="text-xs text-pearl-600 mt-1">{formatPearl(nameValue, 4)} PRL sits on coins that hold your .pns names and stays put.</div>
            )}
            {c.scan && !c.namesVerified && (
              <div className="text-xs text-amber-700 dark:text-amber-400 mt-1">Sending is paused until your protected .pns coins can be checked.
                <button className="underline ml-1" disabled={refreshingNames} onClick={async () => { setRefreshingNames(true); try { await refreshWallet(); setRevision(v => v + 1); } finally { setRefreshingNames(false); } }}>{refreshingNames ? 'Checking…' : 'Try again'}</button></div>
            )}
          </label>

          <div>
            <div className="text-[11px] uppercase tracking-wider text-pearl-600 mb-1.5 font-semibold">Fee</div>
            <div className="grid grid-cols-3 gap-2">
              {TIERS.map((t, i) => {
                const est = estFeeGrains(i);
                const available = rateFor(i) !== null;
                return (
                  <button
                    key={t.label}
                    disabled={!available}
                    onClick={() => setTierIdx(i)}
                    className={`seg tap rounded-lg py-2 px-2 text-xs flex flex-col items-center gap-0.5 ${i === tierIdx ? 'seg-on' : ''}`}
                  >
                    <span>{t.label}</span>
                    <span className="font-mono text-[10px] text-pearl-500">
                      {available ? `~${formatPearlAmount(est)}` : 'Unavailable'}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="text-[11px] text-pearl-600 mt-1.5 flex justify-between">
              <span>{feeRate === null ? 'Fee unavailable' : `${feeRate} grains/vB`}</span>
              <span>
                Est. fee: <span className="text-pearl-400 font-mono">{formatPearlAmount(feeEst)} PRL</span>
                {feeUsd != null && <span className="text-pearl-500 ml-1">≈ ${fmtUsd(feeUsd)}</span>}
              </span>
            </div>
            {c.feePolicy?.available && <p className="text-[11px] text-pearl-600 mt-1.5">{c.feePolicy.source === 'fallback' ? 'Fallback fee estimate: the explorer recommendation is unavailable. Confirmation time may vary.' : 'Fee tiers use the explorer fee estimate.'}</p>}
          </div>

          <button
            disabled={!addrValid || !hasFunds || busy}
            onClick={reviewPayment}
            className="pearl-btn rounded-xl py-3 text-sm mt-auto"
          >
            Review &amp; send
          </button>
        </div>
      )}

      {step === 'review' && reviewed && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
            <div className="bg-ink-900 border border-ink-700 rounded-xl p-4 space-y-3 text-sm">
              {/* Full address — wraps onto multiple lines, monospace, full hex. */}
              <div>
                <div className="text-pearl-600 text-[11px] uppercase tracking-wider font-semibold mb-1">To</div>
                {reviewed.pnsName && <div className="text-xs text-emerald-700 dark:text-emerald-400 font-semibold mb-0.5">{reviewed.pnsName}.pns</div>}
                <div className="font-mono text-xs text-pearl-200 break-all leading-relaxed">
                  {reviewed.recipient}
                </div>
              </div>
              <Row label="Amount"      value={`${formatPearlAmount(reviewed.amount)} PRL`}
                   sub={usdOf(reviewed.amount) != null ? `≈ $${fmtUsd(usdOf(reviewed.amount)!)}` : undefined} />
              <Row label="Network fee" value={`${formatPearlAmount(reviewed.fee)} PRL (${TIERS[reviewed.feeTier].label})`}
                   sub={usdOf(reviewed.fee) != null ? `≈ $${fmtUsd(usdOf(reviewed.fee)!)}` : undefined} />
              <Row label="Fee rate"    value={`${String(reviewed.feeRate)} grains/vB`} mono />
              <Row label="Fee source" value={reviewed.feeSource === 'fallback' ? 'Fallback estimate' : 'Explorer estimate'} />
            </div>
            <p className="text-xs text-pearl-600 leading-relaxed">
              Pearl transactions are final once mined (~3 min). Double-check the address above before signing.
            </p>
          </div>
          <div className="px-5 pt-2 pb-4 border-t border-ink-700 shrink-0">
            <button
              disabled={busy}
              onClick={doSend}
              className="pearl-btn rounded-xl py-3 text-sm w-full"
            >
              {busy ? 'Signing…' : 'Sign & broadcast'}
            </button>
          </div>
        </div>
      )}

      {step === 'broadcast' && (
        <div className="p-5 flex-1 flex items-center justify-center text-sm text-pearl-500">
          Broadcasting…
        </div>
      )}
    </div>
  );
}

function Row({ label, value, sub, mono }: { label: string; value: string; sub?: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-pearl-600 text-[11px] uppercase tracking-wider font-semibold shrink-0 pt-0.5">{label}</span>
      <div className="text-right">
        <div className={`text-pearl-200 ${mono ? 'font-mono' : ''} break-all`}>{value}</div>
        {sub && <div className="text-[11px] text-pearl-500 font-mono mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}
