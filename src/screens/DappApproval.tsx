import { useEffect, useRef, useState } from 'react';
import { approvalCall, readApproval } from '@/dapp/approval-client';
import type { PendingRequest } from '@/dapp/broker';
import { prepareApproval, type ApprovalPreview } from '@/dapp/payment';
import { ProviderError, type Payment } from '@/dapp/protocol';
import { formatPearlAmount, parsePearlAmount } from '@/pearl/money';
import { buildAndSignTx } from '@/pearl/transaction';
import { buildCurrentSigner, currentBalanceWatch } from '@/state/accounts';
import { isUnlocked } from '@/state/session';
import { loadMeta } from '@/storage/vault';
import { parseTotalDebitCap } from '@/pearl/payment-budget';
import { ScreenHeader } from '@/ui/ScreenHeader';

export function DappApproval({ requestId, onDone }: { requestId: string; onDone?: () => void }) {
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [preview, setPreview] = useState<ApprovalPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [txid, setTxid] = useState('');
  const busyRef = useRef(false);
  const expired = request ? request.expiresAt <= Date.now() : false;
  const finish = () => { onDone?.(); window.close(); };
  useEffect(() => {
    let stopped = false;
    void (async () => {
      const r = await readApproval(requestId);
      if (!r || stopped) return;
      setRequest(r);
      if (r.status !== 'pending') {
        if (r.txid) setTxid(r.txid);
        throw new Error(r.error?.message ?? 'This request has already been handled.');
      }
      const p = await prepareApproval(r);
      if (!stopped) setPreview(p);
    })().catch(e => { if (!stopped) setError((e as Error).message); });
    const expiry = setInterval(() => {
      void readApproval(requestId).then(r => {
        if (!stopped && !busyRef.current && r.status === 'rejected') { setRequest(r); setError(r.error?.message ?? 'This request is no longer active.'); setPreview(null); }
      }).catch(() => {});
    }, 2_000);
    return () => { stopped = true; clearInterval(expiry); };
  }, [requestId]);

  async function reject() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await approvalCall(requestId, 'reject'); finish(); }
    catch (e) { setError((e as Error).message); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function approve() {
    if (!request || !preview || busyRef.current || expired) return;
    busyRef.current = true; setBusy(true); setError('');
    let signingStarted = false;
    try {
      const fresh = await prepareApproval(request);
      if (fresh.kind !== preview.kind || fresh.accountId !== preview.accountId
        || (fresh.kind === 'connect' && fresh.address !== preview.address)
        || (fresh.kind === 'payment' && preview.kind === 'payment'
          && (fresh.quote.fee !== preview.quote.fee || fresh.quote.amount !== preview.quote.amount || fresh.feeRate !== preview.feeRate || fresh.feeSource !== preview.feeSource || JSON.stringify(fresh.payment) !== JSON.stringify(preview.payment)))) {
        setPreview(fresh); setError('Account details or the network fee changed. Review the updated information and approve again.'); return;
      }
      if (fresh.kind === 'connect') {
        const balanceWatch = await currentBalanceWatch(fresh.accountId, fresh.address);
        await approvalCall(requestId, 'connect', { accountId: fresh.accountId, address: fresh.address, balanceAccess: true, balanceWatch });
        setDone(true); return;
      }
      if (fresh.kind === 'balance') {
        await approvalCall(requestId, 'balance', { accountId: fresh.accountId, snapshot: fresh.snapshot });
        setDone(true); return;
      }
      const payment = await approvalCall<Payment>(requestId, 'sign', { accountId: fresh.accountId, fee: fresh.quote.fee.toString() });
      signingStarted = true;
      if (JSON.stringify(payment) !== JSON.stringify(request.args.params)) throw new Error('The payment details changed. This request was stopped.');
      const signer = await buildCurrentSigner('mainnet');
      const meta = await loadMeta();
      if (!isUnlocked() || meta?.network !== 'mainnet' || meta.selectedAccountId !== fresh.accountId) throw new Error('The wallet account, network or lock state changed.');
      if (request.expiresAt <= Date.now()) throw new Error('This wallet request expired before signing. Nothing was signed or submitted.');
      const amount = parsePearlAmount(payment.amount)!;
      const maxTotalDebitAtoms = payment.maxTotalDebitAtoms === undefined ? undefined : parseTotalDebitCap(payment.maxTotalDebitAtoms, amount);
      const tx = buildAndSignTx({ signer, network: 'mainnet', recipient: payment.to, amount, utxos: fresh.scan.utxos, protectedOutpoints: fresh.protectedOutpoints, changeAddress: fresh.scan.nextChangeAddress, feeRate: fresh.feeRate, maxTotalDebitAtoms, approvedFee: fresh.quote.fee });
      if (tx.feeGrains !== fresh.quote.fee) throw new Error('The transaction fee differs from your approval. Nothing was submitted.');
      setTxid(tx.txid);
      await approvalCall(requestId, 'broadcast', { txid: tx.txid, hex: tx.hex });
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ProviderError && e.data?.txid) setTxid(e.data.txid);
      if (signingStarted) { setPreview(null); await approvalCall(requestId, 'reject').catch(() => {}); }
    } finally { busyRef.current = false; setBusy(false); }
  }
  const payment = request?.args.method === 'sendTransaction' ? request.args.params : undefined;
  const balanceRequest = request?.args.method === 'getBalance';
  return <div className="h-full flex flex-col">
    <ScreenHeader title={done ? 'Request completed' : payment ? 'Review payment' : balanceRequest ? 'Share account balance' : 'Connect to Nacre'} onBack={() => { if (done) finish(); else void reject(); }} />
    <main className="flex-1 overflow-auto px-4 py-5 space-y-4">
      <p className="text-xs uppercase tracking-widest text-pearl-400">Pearl mainnet · Website request</p>
      {request && <div className="rounded-2xl border border-ink-600 bg-ink-800 p-4 space-y-2"><p className="text-xs text-pearl-400">Requesting website</p><p className="text-sm font-medium break-all">{request.owner.origin}</p></div>}
      {!request && !error && <p role="status">Loading wallet request…</p>}
      {done ? <p role="status" className="text-sm">{payment ? 'Your signed payment was submitted to Pearl. Network confirmation is still pending.' : balanceRequest ? 'Your account balance was shared. No payment was signed or sent.' : 'The website can now see your public address and update your account balance while the wallet is unlocked. Every payment still needs your approval.'}</p> : <>
        {preview && <div className="space-y-2"><p className="text-sm font-medium">{preview.label}</p><p className="text-xs break-all text-pearl-400">{request?.account?.address ?? preview.address}</p></div>}
        {payment ? <div className="rounded-2xl border border-ink-600 p-4 space-y-4">
          <div><p className="text-xs text-pearl-400">You send</p><p className="text-2xl font-semibold break-all">{payment.amount} PRL</p></div>
          <div><p className="text-xs text-pearl-400">Recipient</p><p className="text-xs break-all select-text">{payment.to}</p></div>
          {payment.orderId && <div><p className="text-xs text-pearl-400">Order reference supplied by website</p><p className="text-xs break-all">{payment.orderId}</p></div>}
          {preview?.kind === 'payment' && <><div className="flex justify-between gap-4 text-sm"><span>Network fee</span><span>{formatPearlAmount(preview.quote.fee)} PRL</span></div><div className="flex justify-between gap-4 text-sm font-semibold"><span>Total</span><span>{formatPearlAmount(preview.quote.amount + preview.quote.fee)} PRL</span></div></>}
          {preview?.kind === 'payment' && <p className="text-xs text-pearl-400">{preview.feeSource === 'fallback' ? `Fallback estimate: ${preview.feeRate} grains/vB. The explorer fee recommendation is unavailable; confirmation time may vary.` : `Explorer fee estimate: ${preview.feeRate} grains/vB.`}</p>}
          {payment.maxTotalDebitAtoms !== undefined && <div className="flex justify-between gap-4 text-sm"><span>Budget max</span><span>{formatPearlAmount(BigInt(payment.maxTotalDebitAtoms))} PRL</span></div>}
          <p className="text-xs text-pearl-400">This transfers native PRL. Verify the full address and amount. Approval does not guarantee a swap or delivery of any other asset.</p>
        </div> : balanceRequest ? <div className="space-y-3">
          <p className="text-sm text-pearl-400">Allow this website to read the total and spendable balance of your selected Pearl account, including its receive and change addresses. This does not authorize payments.</p>
          {preview?.kind === 'balance' && <div className="rounded-2xl border border-ink-600 p-4 space-y-3 text-sm">
            <div className="flex justify-between gap-3"><span>Total balance</span><span>{formatPearlAmount(BigInt(preview.snapshot.total))} PRL</span></div>
            <div className="flex justify-between gap-3"><span>Spendable before fee</span><span>{preview.snapshot.spendable === null ? 'Unavailable' : `${formatPearlAmount(BigInt(preview.snapshot.spendable))} PRL`}</span></div>
            <div className="flex justify-between gap-3"><span>Estimated maximum</span><span>{preview.snapshot.maxSend === null ? 'Unavailable' : `${formatPearlAmount(BigInt(preview.snapshot.maxSend))} PRL`}</span></div>
            {!preview.snapshot.namesVerified && <p className="text-xs text-pearl-400">Name protection could not be verified. Spendable balance and maximum are unavailable.</p>}
            {preview.snapshot.feeSource === 'fallback' && <p className="text-xs text-pearl-400">Maximum uses a fallback fee estimate of {preview.snapshot.feeRate} grains/vB because the explorer recommendation is unavailable.</p>}
            <p className="text-xs text-pearl-400">A temporary snapshot of this account. Name coins are excluded from spendable funds. Network fees may change.</p>
          </div>}
        </div> : request && <p className="text-sm text-pearl-400">Share your public address and allow automatic balance updates for this account while your wallet is unlocked. This includes receive and change addresses. Every payment needs a separate approval. Your recovery phrase and private keys stay in the wallet.</p>}
        {!preview && !error && request && <p role="status" className="text-sm text-pearl-400">{payment || balanceRequest ? 'Refreshing the account and checking spendable coins…' : 'Preparing your public address…'}</p>}
      </>}
      {error && <p role="alert" className="text-sm text-red-400 break-words">{error}</p>}
      {txid && <div className="space-y-2"><p className="text-xs text-pearl-400">Transaction ID · check before retrying</p><a className="text-xs underline break-all" href={'https://pearlchain.live/explorer/tx/' + txid} target="_blank" rel="noreferrer">{txid}</a></div>}
    </main>
    <footer className="p-4 border-t border-ink-700 flex gap-3">
      {done ? <button className="pearl-btn w-full min-h-11" onClick={finish}>Done</button> : <><button className="nacre-btn-secondary flex-1 min-h-11" onClick={() => void reject()} disabled={busy}>Reject</button><button className="pearl-btn flex-1 min-h-11" onClick={() => void approve()} disabled={busy || !preview || expired}>{busy ? 'Processing…' : payment ? 'Approve payment' : balanceRequest ? 'Share balance' : 'Connect'}</button></>}
    </footer>
  </div>;
}
