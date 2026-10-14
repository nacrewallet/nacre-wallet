import { currentPublicAccount, type PublicAccount } from '@/state/accounts';
import { isUnlocked } from '@/state/session';
import { getCache, refreshWallet } from '@/state/walletState';
import { loadMeta } from '@/storage/vault';
import { quoteFixedAmountMax } from '@/pearl/transaction';
import { feeRateForPolicy } from '@/pearl/fee-policy';
import { protectedValue } from '@/state/protectedCoins';
import { validatePublicBalance, type PublicBalance } from './balance-contract';
import type { PendingRequest } from './broker';

export interface BalanceApprovalPreview extends PublicAccount {
  kind: 'balance';
  snapshot: PublicBalance;
}

export async function prepareBalance(request: PendingRequest): Promise<BalanceApprovalPreview> {
  if (request.args.method !== 'getBalance' || !request.account) throw new Error('Connect an account before requesting its balance.');
  if (!isUnlocked()) throw new Error('Unlock Nacre Wallet to refresh your balance.');
  const before = await loadMeta();
  if (before?.network !== 'mainnet' || before.selectedAccountId !== request.account.accountId) throw new Error('The selected account or network changed. Reconnect the website.');
  const publicAccount = await currentPublicAccount('mainnet');
  if (publicAccount.accountId !== before.selectedAccountId) throw new Error('The selected account changed. Review this request again.');
  const startedAt = Date.now();
  await refreshWallet();
  const cache = getCache();
  const after = await loadMeta();
  if (!isUnlocked() || after?.network !== 'mainnet' || after.selectedAccountId !== before.selectedAccountId
    || cache.network !== 'mainnet' || cache.account?.id !== before.selectedAccountId) throw new Error('The wallet account, network or lock state changed. Review this request again.');
  if (cache.syncErr || !cache.scan || cache.lastSync < startedAt) throw new Error('Balance unavailable. The wallet could not complete its account scan. Retry when the explorer is available.');

  let spendable: string | null = null;
  let maxSend: string | null = null;
  let estimatedMaxFee: string | null = null;
  const policy = cache.feePolicy;
  if (cache.namesVerified) {
    spendable = (cache.scan.balance - protectedValue(cache.scan.utxos, cache.protectedOutpoints)).toString();
    // Match sendTransaction's fixed-amount planner, including its conservative
    // recipient+change fee. The wallet's one-output sendMax is a different flow.
    if (policy?.available) {
      const quote = quoteFixedAmountMax({ utxos: cache.scan.utxos, protectedOutpoints: cache.protectedOutpoints,
        feeRate: feeRateForPolicy(policy) });
      if (!quote.error) {
        maxSend = quote.ok ? quote.amount.toString() : '0';
        estimatedMaxFee = quote.ok ? quote.fee.toString() : '0';
      }
    }
  }
  const snapshot = validatePublicBalance({
    // Keep the public address already approved for this connection. HD balance
    // includes the complete selected account, not only this receive address.
    address: request.account.address, network: 'pearl:mainnet',
    total: cache.scan.balance.toString(), spendable, maxSend, estimatedMaxFee,
    feeRate: policy?.available ? policy.rate.toString() : null, feeSource: policy?.available ? policy.source : null,
    updatedAt: cache.lastSync, namesVerified: cache.namesVerified,
  }, Date.now());
  return { kind: 'balance', accountId: publicAccount.accountId, label: publicAccount.label, address: snapshot.address, snapshot };
}
