// HD wallet multi-address scanning. A result is published only after both
// chains reach the gap limit with complete, internally consistent responses.

import type { HDKey } from '@scure/bip32';
import { deriveAddress, type Derivation } from './wallet';
import type { PearlNetwork } from './network';
import { scanAddresses } from '@/api/client';
import { atomicValue, validateScanResults } from '@/api/scan-validation';

const GAP_LIMIT = 20;
const MAX_INDEX = 500;

export interface ScannedUtxo {
  txid: string; vout: number; value: bigint; blockHeight: number;
  address: string; chain: 0 | 1; index: number;
}

export interface AddressInfo {
  address: string; chain: 0 | 1; index: number; used: boolean; balance: bigint;
}

export interface WalletScan {
  balance:           bigint;
  utxos:             ScannedUtxo[];
  addresses:         AddressInfo[];
  receiveAddress:    string;
  receiveIndex:      number;
  nextChangeAddress: string;
  nextChangeIndex:   number;
}

type PublicDeriver = (chain: 0 | 1, index: number) => { address: string; index: number };
async function scanChain(
  derive: PublicDeriver, chain: 0 | 1, scan: typeof scanAddresses,
): Promise<{ addresses: AddressInfo[]; utxos: ScannedUtxo[] }> {
  const addresses: AddressInfo[] = [];
  const utxos: ScannedUtxo[] = [];
  let index = 0;
  let consecutiveUnused = 0;

  while (consecutiveUnused < GAP_LIMIT && index < MAX_INDEX) {
    const window = Array.from({ length: Math.min(GAP_LIMIT, MAX_INDEX - index) }, (_, i) =>
      derive(chain, index + i),
    );
    const requested = window.map(w => w.address);
    const results = validateScanResults(requested, await scan(requested));
    const byAddr = new Map(results.map(r => [r.address, r]));
    for (const w of window) {
      const r = byAddr.get(w.address)!; // complete coverage was validated above
      const used = r.used;
      addresses.push({
        address: w.address, chain, index: w.index, used,
        balance: BigInt(r.balance),
      });
      for (const u of r.utxos) {
        utxos.push({
          txid: u.txid, vout: u.vout, value: BigInt(u.value),
          blockHeight: u.blockHeight, address: w.address, chain, index: w.index,
        });
      }
      consecutiveUnused = used ? 0 : consecutiveUnused + 1;
    }
    index += window.length;
  }
  if (consecutiveUnused < GAP_LIMIT) throw new Error('Wallet scan limit reached before finding the address gap. The balance is unavailable; use a full wallet scan.');
  return { addresses, utxos };
}

export async function scanWallet(
  hd: HDKey, network: PearlNetwork = 'mainnet', deriv?: Derivation,
): Promise<WalletScan> {
  return scanDerivedWallet((chain, index) => deriveAddress(hd, chain, index, network, deriv));
}

/** Shared complete-gap scanner for signing wallets and public-only account nodes. */
export async function scanDerivedWallet(derive: PublicDeriver, scan: typeof scanAddresses = scanAddresses): Promise<WalletScan> {
  const [ext, chg] = await Promise.all([scanChain(derive, 0, scan), scanChain(derive, 1, scan)]);
  const addresses = [...ext.addresses, ...chg.addresses];
  const utxos     = [...ext.utxos, ...chg.utxos];
  const outpoints = new Set(utxos.map(u => `${u.txid}:${u.vout}`));
  if (outpoints.size !== utxos.length) throw new Error('The explorer returned duplicate wallet coins. Refresh and try again.');
  const balance   = utxos.reduce((s, u) => s + u.value, 0n);
  atomicValue(balance.toString());
  const firstUnusedExt = ext.addresses.find(a => !a.used)!;
  const firstUnusedChg = chg.addresses.find(a => !a.used)!;
  return {
    balance, utxos, addresses,
    receiveAddress:    firstUnusedExt.address,
    receiveIndex:      firstUnusedExt.index,
    nextChangeAddress: firstUnusedChg.address,
    nextChangeIndex:   firstUnusedChg.index,
  };
}

// Scan an imported single-key account: one address, no derivation. Change is
// returned to the same address (an imported key has nowhere else to go).
export async function scanSingleAddress(address: string, scan: typeof scanAddresses = scanAddresses): Promise<WalletScan> {
  const results = validateScanResults([address], await scan([address]));
  const r = results[0];
  const utxos: ScannedUtxo[] = r.utxos.map(u => ({
    txid: u.txid, vout: u.vout, value: BigInt(u.value),
    blockHeight: u.blockHeight, address, chain: 0, index: 0,
  }));
  const balance = utxos.reduce((s, u) => s + u.value, 0n);
  return {
    balance, utxos,
    addresses: [{ address, chain: 0, index: 0, used: r.used, balance }],
    receiveAddress:    address, receiveIndex: 0,
    nextChangeAddress: address, nextChangeIndex: 0,
  };
}
