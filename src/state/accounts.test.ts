import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HDKey } from '@scure/bip32';
import type { HdAccountDescriptor } from '@/storage/vault';
import { deriveAddress, mnemonicToHDKey, parsePrivateKey, privateKeyToAddress } from '@/pearl/wallet';

const mocks = vi.hoisted(() => ({
  hd: null as HDKey | null,
  mnemonic: null as string | null,
  selectedAccount: vi.fn(), getSeedMnemonic: vi.fn(), getImportedKey: vi.fn(), loadMeta: vi.fn(),
  scanWallet: vi.fn(), scanSingleAddress: vi.fn(),
}));
vi.mock('@/storage/vault', async importOriginal => {
  const original = await importOriginal<typeof import('@/storage/vault')>();
  return { ...original, selectedAccount: mocks.selectedAccount, getSeedMnemonic: mocks.getSeedMnemonic, getImportedKey: mocks.getImportedKey, loadMeta: mocks.loadMeta };
});
vi.mock('./session', () => ({ getHD: () => mocks.hd, getMnemonic: () => mocks.mnemonic }));
vi.mock('@/pearl/hdwallet', () => ({ scanWallet: mocks.scanWallet, scanSingleAddress: mocks.scanSingleAddress }));
import { currentPublicAccount, currentBalanceWatch } from './accounts';
import { publicAccountAddress, publicAccountNode } from '@/dapp/balance-watch';

// Public BIP-39 test vectors only. Never load a user vault or transmit a secret.
const masterPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const importedPhrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const masterHD = await mnemonicToHDKey(masterPhrase);
const importedHD = await mnemonicToHDKey(importedPhrase);
const account: HdAccountDescriptor = { id: 'hd-1', label: 'Account 1', type: 'hd', coinType: 0, account: 0 };

describe('offline selected public account', () => {
  const network = vi.fn(async () => { throw new Error('Network access is forbidden in local address derivation.'); });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.hd = masterHD;
    mocks.mnemonic = masterPhrase;
    mocks.selectedAccount.mockResolvedValue(account);
    mocks.getSeedMnemonic.mockResolvedValue(importedPhrase);
    vi.stubGlobal('fetch', network);
  });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    expect(mocks.scanWallet).not.toHaveBeenCalled();
    expect(mocks.scanSingleAddress).not.toHaveBeenCalled();
    expect(mocks.getImportedKey).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('returns the stable primary public address of the selected HD account', async () => {
    const actual = await currentPublicAccount('mainnet');
    expect(actual).toEqual({ accountId: account.id, label: account.label,
      address: deriveAddress(masterHD, 0, 0, 'mainnet', { coinType: 0, account: 0 }).address });
    expect(Object.keys(actual).sort()).toEqual(['accountId', 'address', 'label']);
    expect(mocks.getSeedMnemonic).not.toHaveBeenCalled();
  });

  it('respects a different HD account and detected import derivation', async () => {
    mocks.selectedAccount.mockResolvedValue({ ...account, coinType: 1, account: 3 });
    expect((await currentPublicAccount('mainnet')).address).toBe(deriveAddress(masterHD, 0, 0, 'mainnet', { coinType: 1, account: 3 }).address);
  });

  it('derives the selected imported-seed address locally without sharing its seed', async () => {
    mocks.selectedAccount.mockResolvedValue({ ...account, seedId: 'seed-2', account: 2 });
    const result = await currentPublicAccount('mainnet');
    expect(result.address).toBe(deriveAddress(importedHD, 0, 0, 'mainnet', { coinType: 0, account: 2 }).address);
    expect(mocks.getSeedMnemonic).toHaveBeenCalledExactlyOnceWith('seed-2', masterPhrase);
    expect(Object.keys(result).sort()).toEqual(['accountId', 'address', 'label']);
  });

  it('uses an imported key account public address without opening the private key', async () => {
    const address = privateKeyToAddress(parsePrivateKey('2'.repeat(64)), 'mainnet');
    mocks.selectedAccount.mockResolvedValue({ id: 'key-1', label: 'Imported account', type: 'imported', address });
    expect(await currentPublicAccount('mainnet')).toEqual({ accountId: 'key-1', label: 'Imported account', address });
    expect(mocks.getSeedMnemonic).not.toHaveBeenCalled();
  });

  it('rejects an imported key address belonging to another network', async () => {
    const address = privateKeyToAddress(parsePrivateKey('2'.repeat(64)), 'testnet');
    mocks.selectedAccount.mockResolvedValue({ id: 'key-1', label: 'Imported account', type: 'imported', address });
    await expect(currentPublicAccount('mainnet')).rejects.toThrow(/requested network/);
  });

  it('rejects a locked wallet without reading its account descriptor', async () => {
    mocks.hd = null;
    await expect(currentPublicAccount('mainnet')).rejects.toThrow(/locked/);
    expect(mocks.selectedAccount).not.toHaveBeenCalled();
  });

  it('rejects missing selected account or unavailable imported seed', async () => {
    mocks.selectedAccount.mockResolvedValueOnce(null);
    await expect(currentPublicAccount('mainnet')).rejects.toThrow(/No account/);
    mocks.selectedAccount.mockResolvedValue({ ...account, seedId: 'seed-2' });
    mocks.getSeedMnemonic.mockResolvedValue(null);
    await expect(currentPublicAccount('mainnet')).rejects.toThrow(/Could not open/);
  });

  it.each(['lock', 'new-session'])('rejects %s while an imported seed is opening', async change => {
    mocks.selectedAccount.mockResolvedValue({ ...account, seedId: 'seed-2' });
    mocks.getSeedMnemonic.mockImplementation(async () => {
      mocks.hd = change === 'lock' ? null : importedHD;
      return importedPhrase;
    });
    await expect(currentPublicAccount('mainnet')).rejects.toThrow(/lock state changed/);
  });

  it('creates a public-only scan descriptor for an imported seed with its own derivation', async () => {
    const selected = { ...account, seedId: 'seed-2', account: 2 };
    mocks.loadMeta.mockResolvedValue({ createdAt: 1, network: 'mainnet', selectedAccountId: selected.id, accounts: [selected] });
    const address = deriveAddress(importedHD, 0, 0, 'mainnet', { coinType: 0, account: 2 }).address;
    const watch = await currentBalanceWatch(selected.id, address);
    expect(watch.kind).toBe('hd');
    if (watch.kind !== 'hd') throw new Error('Expected public HD descriptor.');
    const node = publicAccountNode(watch.accountXpub);
    expect(node.privateKey).toBeNull();
    expect(publicAccountAddress(node, 1, 4)).toBe(deriveAddress(importedHD, 1, 4, 'mainnet', { coinType: 0, account: 2 }).address);
    expect(JSON.stringify(watch)).not.toContain(importedPhrase);
    expect(JSON.stringify(watch)).not.toContain(masterPhrase);
  });

  it('drops a scan descriptor when the selected account, backend or session changes during derivation', async () => {
    const selected = { ...account, seedId: 'seed-2' };
    const meta = { createdAt: 1, network: 'mainnet', selectedAccountId: selected.id, accounts: [selected] };
    const address = deriveAddress(importedHD, 0, 0, 'mainnet', { coinType: 0, account: 0 }).address;
    for (const change of ['backend', 'account', 'lock']) {
      mocks.hd = masterHD; mocks.loadMeta.mockResolvedValue(meta);
      mocks.getSeedMnemonic.mockImplementation(async () => {
        if (change === 'lock') mocks.hd = null;
        else mocks.loadMeta.mockResolvedValue({ ...meta, ...(change === 'backend' ? { explorerMode: 'blockbook' } : { selectedAccountId: 'other' }) });
        return importedPhrase;
      });
      await expect(currentBalanceWatch(selected.id, address)).rejects.toThrow();
    }
  });
});
