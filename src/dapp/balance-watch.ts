// Extension-internal public scan capability. Never exposed to website messages.
import { HDKey } from '@scure/bip32';
import { isValidAddress, pubkeyToTaprootAddress } from '@/pearl/address';
import type { WalletMeta } from '@/storage/vault';

export type BalanceWatch = { kind: 'hd'; accountXpub: string; context: string }
  | { kind: 'single'; address: string; context: string };

export function balanceContext(meta: WalletMeta | null | undefined): string {
  const account = meta?.accounts?.find(item => item.id === meta.selectedAccountId);
  if (!meta || meta.network !== 'mainnet' || !account) throw new Error('Select a Pearl mainnet account.');
  return JSON.stringify([meta.createdAt, meta.network, meta.explorerUrl ?? 'https://pearlchain.live', meta.explorerMode ?? 'pearlchain',
    account.id, account.type, account.type === 'hd' ? [account.coinType, account.account, account.seedId ?? null] : account.address]);
}

export function publicAccountNode(xpub: string): HDKey {
  if (typeof xpub !== 'string' || xpub.length > 120 || !xpub.startsWith('xpub')) throw new Error('Invalid public account node.');
  const node = HDKey.fromExtendedKey(xpub);
  if (node.privateKey || node.depth !== 3 || !node.publicKey) throw new Error('A public account node is required.');
  return node;
}

export function publicAccountAddress(node: HDKey, chain: 0 | 1, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 500) throw new Error('Invalid public address index.');
  const publicKey = node.deriveChild(chain).deriveChild(index).publicKey;
  if (!publicKey) throw new Error('Public address unavailable.');
  return pubkeyToTaprootAddress(publicKey.slice(1), 'mainnet');
}

export function validateBalanceWatch(value: unknown, address: string, meta: WalletMeta): BalanceWatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Reconnect to allow automatic balance updates.');
  const watch = value as BalanceWatch;
  const fields = watch.kind === 'hd' ? ['kind', 'accountXpub', 'context'] : ['kind', 'address', 'context'];
  if (Object.keys(watch).length !== fields.length || fields.some(key => !Object.hasOwn(watch, key)) || watch.context !== balanceContext(meta)) throw new Error('The selected wallet account or network changed.');
  const account = meta.accounts.find(item => item.id === meta.selectedAccountId)!;
  if (watch.kind === 'single') {
    if (account.type !== 'imported' || watch.address !== account.address || watch.address !== address || !isValidAddress(address, 'mainnet')) throw new Error('The public balance account changed.');
  } else if (watch.kind === 'hd') {
    if (account.type !== 'hd' || publicAccountAddress(publicAccountNode(watch.accountXpub), 0, 0) !== address) throw new Error('The public balance account changed.');
  } else throw new Error('Invalid public balance account.');
  return structuredClone(watch);
}
