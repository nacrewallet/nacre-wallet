import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HDKey } from '@scure/bip32';
import type { ScanResult } from '@/api/types';

const mocks = vi.hoisted(() => ({ scan: vi.fn() }));
vi.mock('@/api/client', () => ({ scanAddresses: mocks.scan }));
vi.mock('./wallet', () => ({ deriveAddress: (_hd: HDKey, chain: number, index: number) => ({ address: `synthetic-${chain}-${index}`, chain, index }) }));
import { scanSingleAddress, scanWallet } from './hdwallet';
const hd = {} as HDKey;
const empty = (address: string): ScanResult => ({ address, used: false, balance: '0', utxos: [] });
const funded = (address: string, txid = 'a'.repeat(64)): ScanResult => ({ address, used: true, balance: '1', utxos: [{ txid, vout: 0, value: '1', blockHeight: 1 }] });

describe('complete HD address discovery', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.scan.mockImplementation(async (addresses: string[]) => addresses.map(empty)); });
  it('returns verified zero only when both gap windows are fully answered', async () => {
    const result = await scanWallet(hd);
    expect(result.balance).toBe(0n);
    expect(result.addresses).toHaveLength(40);
    expect(result.receiveAddress).toBe('synthetic-0-0');
    expect(result.nextChangeAddress).toBe('synthetic-1-0');
  });
  it('rejects a partial HD window or imported address response', async () => {
    mocks.scan.mockImplementation(async (addresses: string[]) => addresses.slice(1).map(empty));
    await expect(scanWallet(hd)).rejects.toThrow(/invalid wallet scan/);
    await expect(scanSingleAddress('synthetic-imported')).rejects.toThrow(/invalid wallet scan/);
  });
  it('extends the window after usage and includes the final funded address', async () => {
    mocks.scan.mockImplementation(async (addresses: string[]) => addresses.map(a => a === 'synthetic-0-19' ? funded(a) : empty(a)));
    const result = await scanWallet(hd);
    expect(result.balance).toBe(1n);
    expect(result.addresses).toHaveLength(60);
    expect(result.utxos[0].index).toBe(19);
  });
  it('rejects cap exhaustion even if all returned rows are valid', async () => {
    mocks.scan.mockImplementation(async (addresses: string[]) => addresses.map(a => ({ ...empty(a), used: true })));
    await expect(scanWallet(hd)).rejects.toThrow(/scan limit reached/);
  });
  it('rejects an outpoint repeated across address windows', async () => {
    mocks.scan.mockImplementation(async (addresses: string[]) => addresses.map(a => ['synthetic-0-19', 'synthetic-0-20'].includes(a) ? funded(a) : empty(a)));
    await expect(scanWallet(hd)).rejects.toThrow(/duplicate wallet coins/);
  });
  it('rejects an outpoint repeated across receive/change chains', async () => {
    mocks.scan.mockImplementation(async (addresses: string[]) => addresses.map(a => ['synthetic-0-0', 'synthetic-1-0'].includes(a) ? funded(a) : empty(a)));
    await expect(scanWallet(hd)).rejects.toThrow(/duplicate wallet coins/);
  });
});
