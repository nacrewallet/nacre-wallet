import { getCache, refreshWallet } from '@/state/walletState';
import { isUnlocked } from '@/state/session';
import { currentPublicAccount, type PublicAccount } from '@/state/accounts';
import { loadMeta } from '@/storage/vault';
import { quoteSend, type SendQuote } from '@/pearl/transaction';
import type { WalletScan } from '@/pearl/hdwallet';
import { parsePearlAmount } from '@/pearl/money';
import { feeRateForPolicy } from '@/pearl/fee-policy';
import type { PendingRequest } from './broker';
import { prepareBalance, type BalanceApprovalPreview } from './balance';
import type { Payment } from './protocol';
import { assertTotalDebit, parseTotalDebitCap } from '@/pearl/payment-budget';

export interface ConnectionApprovalPreview extends PublicAccount {
  kind: 'connect';
}
export interface PaymentApprovalPreview extends PublicAccount {
  kind: 'payment'; scan: WalletScan;
  protectedOutpoints: Set<string>; feeRate: bigint; feeSource: 'network' | 'fallback'; quote: SendQuote; payment: Payment;
}
export type ApprovalPreview = ConnectionApprovalPreview | PaymentApprovalPreview | BalanceApprovalPreview;
export async function prepareApproval(request: PendingRequest): Promise<ApprovalPreview> {
  request = structuredClone(request);
  if (request.status !== 'pending' || request.expiresAt <= Date.now()) throw new Error('This wallet request is no longer awaiting approval.');
  if (request.args.method === 'getBalance') return prepareBalance(request);
  if (!isUnlocked()) throw new Error('Unlock Nacre Wallet to continue.');
  const before = await loadMeta();
  if (!before || before.network !== 'mainnet') throw new Error('Website connections currently support Pearl mainnet only.');
  if (request.account && request.account.accountId !== before.selectedAccountId) throw new Error('The selected account changed. Reconnect the website with the account you want to use.');
  if (request.args.method === 'connect') {
    const account = await currentPublicAccount('mainnet');
    const after = await loadMeta();
    if (!isUnlocked() || !after || after.network !== 'mainnet' || after.selectedAccountId !== before.selectedAccountId
      || account.accountId !== before.selectedAccountId) throw new Error('The wallet account, network or lock state changed. Review this request again.');
    return { kind: 'connect', ...account };
  }
  if (request.args.method !== 'sendTransaction') throw new Error('This request does not require a wallet approval.');
  const startedAt = Date.now();
  await refreshWallet();
  const c = getCache();
  const after = await loadMeta();
  if (!isUnlocked() || !after || after.network !== 'mainnet' || c.network !== 'mainnet' || after.selectedAccountId !== before.selectedAccountId || c.account?.id !== before.selectedAccountId) throw new Error('The wallet account, network or lock state changed. Review this request again.');
  if (c.syncErr || !c.scan || c.lastSync < startedAt) throw new Error('The wallet could not refresh its account. Close this request and try again after syncing.');
  if (!c.namesVerified) throw new Error('Name protection could not be verified. Payments are disabled until .pns ownership is checked.');
  if (!c.feePolicy?.available) throw new Error(c.feePolicy?.reason ?? 'The fee estimate is unavailable. Refresh the wallet before approving a payment.');
  const scan = structuredClone(c.scan);
  const protectedOutpoints = new Set(c.protectedOutpoints);
  const feeRate = feeRateForPolicy(c.feePolicy);
  const amount = parsePearlAmount(request.args.params!.amount)!;
  const payment = request.args.params;
  const cap = payment.maxTotalDebitAtoms === undefined ? undefined : parseTotalDebitCap(payment.maxTotalDebitAtoms, amount);
  const quote = quoteSend({ utxos: scan.utxos, protectedOutpoints, amount, feeRate });
  if (!quote.ok) throw new Error(quote.error ?? 'Insufficient spendable PRL for this payment and its network fee. Coins carrying .pns names are excluded.');
  assertTotalDebit(quote.amount, quote.fee, cap);
  return {
    kind: 'payment',
    accountId: c.account.id, label: c.account.label, address: c.scan.receiveAddress,
    scan, protectedOutpoints, feeRate, feeSource: c.feePolicy.source, quote, payment,
  };
}
