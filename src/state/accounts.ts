// Resolves the *currently selected* account into the things the rest of the app
// needs: a wallet scan, a signer, and (for export) its private key. Bridges the
// vault's account descriptors with the in-session secrets — the master HD key
// for primary HD accounts, an opened imported seed for seed accounts, and the
// sealed key for imported single-key accounts.

import {
  selectedAccount, accountDerivation, getImportedKey, getSeedMnemonic,
  type AccountDescriptor, type HdAccountDescriptor,
} from '@/storage/vault';
import { getHD, getMnemonic } from './session';
import { scanWallet, scanSingleAddress, type WalletScan } from '@/pearl/hdwallet';
import { hdSigner, importedSigner, type AccountSigner } from '@/pearl/transaction';
import { mnemonicToHDKey, getPrivateKey, deriveAddress } from '@/pearl/wallet';
import { isValidAddress } from '@/pearl/address';
import { bytesToHex } from '@/pearl/bytes';
import type { HDKey } from '@scure/bip32';
import type { PearlNetwork } from '@/pearl/network';
import { loadMeta } from '@/storage/vault';
import { balanceContext, validateBalanceWatch, type BalanceWatch } from '@/dapp/balance-watch';

// The HD key an HD account derives from: the in-session master, or an imported
// seed opened on demand with the master mnemonic.
async function hdForAccount(acc: HdAccountDescriptor): Promise<HDKey> {
  if (!acc.seedId) {
    const hd = getHD();
    if (!hd) throw new Error('Wallet is locked.');
    return hd;
  }
  const master = getMnemonic();
  if (!master) throw new Error('Wallet is locked.');
  const phrase = await getSeedMnemonic(acc.seedId, master);
  if (!phrase) throw new Error('Could not open the imported seed.');
  return mnemonicToHDKey(phrase);
}

export interface PublicAccount {
  accountId: string;
  label: string;
  address: string;
}

// A website connection needs one stable public address, not a wallet scan.
// Receive #0 is local for every HD account, including an imported seed. A
// single-key account already stores its public address; do not decrypt its key.
export async function currentPublicAccount(network: PearlNetwork): Promise<PublicAccount> {
  const sessionHD = getHD();
  if (!sessionHD) throw new Error('Wallet is locked.');
  const acc = await selectedAccount();
  if (!acc) throw new Error('No account selected.');
  const address = acc.type === 'imported'
    ? acc.address
    : deriveAddress(await hdForAccount(acc), 0, 0, network, accountDerivation(acc) ?? undefined).address;
  // Imported-seed decryption/derivation can finish after a lock or re-unlock.
  // Never return information derived under an obsolete wallet session.
  if (getHD() !== sessionHD) throw new Error('The wallet lock state changed. Review this request again.');
  if (!isValidAddress(address, network)) throw new Error('The selected account address does not match the requested network.');
  return { accountId: acc.id, label: acc.label, address };
}

/** Produced only inside the approving popup; the worker receives no signing key. */
export async function currentBalanceWatch(accountId: string, address: string): Promise<BalanceWatch> {
  const hd = getHD(), before = await loadMeta();
  if (!hd || !before || before.selectedAccountId !== accountId) throw new Error('The wallet account or lock state changed.');
  const context = balanceContext(before), account = before.accounts.find(item => item.id === accountId)!;
  const watch: BalanceWatch = account.type === 'imported' ? { kind: 'single', address: account.address, context }
    : { kind: 'hd', accountXpub: (await hdForAccount(account)).derive(`m/86'/${account.coinType}'/${account.account}'`).publicExtendedKey, context };
  const after = await loadMeta();
  if (getHD() !== hd || !after || balanceContext(after) !== context) throw new Error('The wallet account or lock state changed.');
  return validateBalanceWatch(watch, address, after);
}

export async function scanCurrentAccount(network: PearlNetwork, capturedAccount?: AccountDescriptor): Promise<WalletScan> {
  const acc = capturedAccount ?? await selectedAccount();
  if (!acc) throw new Error('No account selected.');
  if (acc.type === 'imported') {
    if (!isValidAddress(acc.address, network)) throw new Error('The selected account address does not match the requested network.');
    return scanSingleAddress(acc.address);
  }
  const hd = await hdForAccount(acc);
  return scanWallet(hd, network, accountDerivation(acc) ?? undefined);
}

export async function buildCurrentSigner(network: PearlNetwork): Promise<AccountSigner> {
  const acc = await selectedAccount();
  if (!acc) throw new Error('No account selected.');

  if (acc.type === 'hd') {
    const hd = await hdForAccount(acc);
    return hdSigner(hd, network, accountDerivation(acc) ?? undefined);
  }

  const mnemonic = getMnemonic();
  if (!mnemonic) throw new Error('Wallet is locked.');
  const priv = await getImportedKey(acc.id, mnemonic);
  if (!priv) throw new Error('Could not open the imported key.');
  return importedSigner(priv, network);
}

// Export the private key for the selected account. For an imported account
// that's its single key; for an HD account it's the key of its primary
// (receive #0) address — the recovery phrase still backs up every address.
export async function exportCurrentPrivateKey(network: PearlNetwork): Promise<{ address: string; hex: string }> {
  const acc = await selectedAccount();
  if (!acc) throw new Error('No account selected.');

  if (acc.type === 'imported') {
    const mnemonic = getMnemonic();
    if (!mnemonic) throw new Error('Wallet is locked.');
    const priv = await getImportedKey(acc.id, mnemonic);
    if (!priv) throw new Error('Could not open the imported key.');
    return { address: acc.address, hex: bytesToHex(priv) };
  }

  const hd    = await hdForAccount(acc);
  const deriv = accountDerivation(acc) ?? undefined;
  const priv  = getPrivateKey(hd, 0, 0, network, deriv);
  return { address: deriveAddress(hd, 0, 0, network, deriv).address, hex: bytesToHex(priv) };
}
