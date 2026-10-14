// Read-only worker scanner. Public account nodes only; no session/key imports.
import * as pearl from '@/api/pearlchain';
import * as blockbook from '@/api/blockbook';
import { scanDerivedWallet, scanSingleAddress } from '@/pearl/hdwallet';
import { quoteFixedAmountMax } from '@/pearl/transaction';
import { feeRateForPolicy, selectFeePolicy } from '@/pearl/fee-policy';
import { protectedValue, resolveProtectedCoins } from '@/state/protectedCoins';
import type { WalletMeta } from '@/storage/vault';
import { publicAccountAddress, publicAccountNode, validateBalanceWatch } from './balance-watch';
import { validatePublicBalance, type PublicBalance } from './balance-contract';
import type { Connection } from './broker';

export async function scanWatchBalance(account: Connection, meta: WalletMeta, signal?: AbortSignal): Promise<PublicBalance> {
  if (meta.selectedAccountId !== account.accountId) throw new Error('The selected balance account changed.');
  const watch = validateBalanceWatch(account.balanceWatch, account.address, meta);
  const base = (meta.explorerUrl || 'https://pearlchain.live').replace(/\/+$/, '');
  const backend = meta.explorerMode === 'blockbook' ? blockbook : pearl;
  const scanner = (addresses: string[]) => backend.scanAddresses(base, addresses, signal);
  const publicNode = watch.kind === 'hd' ? publicAccountNode(watch.accountXpub) : null;
  const [scan, stats] = await Promise.all([
    watch.kind === 'single' ? scanSingleAddress(watch.address, scanner)
      : scanDerivedWallet((chain, index) => ({ address: publicAccountAddress(publicNode!, chain, index), index }), scanner),
    backend.getStats(base, signal).catch(() => null),
  ]);
  const protection = await resolveProtectedCoins(account.accountId, scan.utxos.map(coin => coin.address),
    address => meta.explorerMode === 'blockbook' ? Promise.resolve(null) : pearl.pnsOwnedByStrict(base, address, signal));
  signal?.throwIfAborted();
  const policy = selectFeePolicy(stats);
  let spendable: string | null = null, maxSend: string | null = null, estimatedMaxFee: string | null = null;
  if (protection.verified) {
    spendable = (scan.balance - protectedValue(scan.utxos, protection.outpoints)).toString();
    if (policy.available) {
      const quote = quoteFixedAmountMax({ utxos: scan.utxos, protectedOutpoints: protection.outpoints, feeRate: feeRateForPolicy(policy) });
      if (!quote.error) { maxSend = quote.ok ? quote.amount.toString() : '0'; estimatedMaxFee = quote.ok ? quote.fee.toString() : '0'; }
    }
  }
  const now = Date.now();
  return validatePublicBalance({ address: account.address, network: 'pearl:mainnet', total: scan.balance.toString(), spendable, maxSend, estimatedMaxFee,
    feeRate: policy.available ? policy.rate.toString() : null, feeSource: policy.available ? policy.source : null,
    updatedAt: now, namesVerified: protection.verified }, now);
}
