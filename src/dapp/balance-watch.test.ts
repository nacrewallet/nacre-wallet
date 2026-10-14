import { describe, expect, it } from 'vitest';
import { mnemonicToHDKey, deriveAddress, parsePrivateKey, privateKeyToAddress } from '@/pearl/wallet';
import type { WalletMeta } from '@/storage/vault';
import { balanceContext, publicAccountAddress, publicAccountNode, validateBalanceWatch } from './balance-watch';

const hd = await mnemonicToHDKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const meta: WalletMeta = { version: 2, createdAt: 1, network: 'mainnet', selectedAccountId: 'one', accounts: [{ id: 'one', label: 'Fixture', type: 'hd', coinType: 0, account: 3 }] };
const privateNode = hd.derive("m/86'/0'/3'");
const address = deriveAddress(hd, 0, 0, 'mainnet', { coinType: 0, account: 3 }).address;
const watch = { kind: 'hd', context: balanceContext(meta), accountXpub: privateNode.publicExtendedKey };

describe('trusted public scan descriptor', () => {
  it('derives matching receive and change addresses without retaining any private child key', () => {
    const node = publicAccountNode(watch.accountXpub);
    expect(node.privateKey).toBeNull();
    for (const chain of [0, 1] as const) for (const index of [0, 19, 499]) {
      expect(publicAccountAddress(node, chain, index)).toBe(deriveAddress(hd, chain, index, 'mainnet', { coinType: 0, account: 3 }).address);
      expect(node.deriveChild(chain).deriveChild(index).privateKey).toBeNull();
    }
    expect(validateBalanceWatch(watch, address, meta)).toEqual(watch);
  });
  it('refuses private/master/chain nodes, unknown fields or an unrelated address', () => {
    for (const xpub of [privateNode.privateExtendedKey, hd.publicExtendedKey, privateNode.deriveChild(0).publicExtendedKey, 'xpub-invalid']) {
      expect(() => validateBalanceWatch({ ...watch, accountXpub: xpub }, address, meta)).toThrow();
    }
    expect(() => validateBalanceWatch({ ...watch, arbitrary: 'extra' }, address, meta)).toThrow();
    expect(() => validateBalanceWatch(watch, deriveAddress(hd, 0, 1).address, meta)).toThrow();
    expect(() => publicAccountAddress(publicAccountNode(watch.accountXpub), 0, 500)).toThrow();
  });
  it('binds the complete account and backend metadata but permits label/autolock changes', () => {
    for (const patch of [{ network: 'testnet' }, { createdAt: 2 }, { explorerUrl: 'https://different.example' }, { explorerMode: 'blockbook' },
      { accounts: [{ ...meta.accounts[0], account: 2 }] }, { accounts: [{ ...meta.accounts[0], seedId: 'changed' }] }]) {
      expect(() => validateBalanceWatch(watch, address, { ...meta, ...patch } as WalletMeta)).toThrow();
    }
    expect(validateBalanceWatch(watch, address, { ...meta, autoLockMins: 10, accounts: [{ ...meta.accounts[0], label: 'New label' }] })).toEqual(watch);
  });
  it('limits imported-key watches to the account public address, with no private-key decryption', () => {
    const importedAddress = privateKeyToAddress(parsePrivateKey('2'.repeat(64)), 'mainnet');
    const imported: WalletMeta = { ...meta, accounts: [{ id: 'one', label: 'Single', type: 'imported', address: importedAddress }] };
    const single = { kind: 'single', context: balanceContext(imported), address: importedAddress };
    expect(validateBalanceWatch(single, importedAddress, imported)).toEqual(single);
    expect(() => validateBalanceWatch(single, address, imported)).toThrow();
    expect(() => validateBalanceWatch({ ...single, context: balanceContext(meta) }, address, meta)).toThrow();
  });
});
