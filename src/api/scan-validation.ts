import type { ScanResult, UtxoDto } from './types';

const MAX_VALUE = 0x7fffffffffffffffn;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (): never => { throw new Error('The explorer returned an incomplete or invalid wallet scan. Refresh and try again.'); };

export function atomicValue(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(value)) return invalid();
  const amount = BigInt(value);
  if (amount > MAX_VALUE) return invalid();
  return amount;
}

export function validateUtxos(value: unknown): UtxoDto[] {
  if (!Array.isArray(value)) return invalid();
  const seen = new Set<string>();
  return value.map(item => {
    if (!record(item) || typeof item.txid !== 'string' || !/^[a-fA-F0-9]{64}$/.test(item.txid)
      || !Number.isSafeInteger(item.vout) || (item.vout as number) < 0 || (item.vout as number) > 0xffffffff
      || !Number.isSafeInteger(item.blockHeight) || (item.blockHeight as number) < 0) return invalid();
    if (atomicValue(item.value) === 0n) return invalid();
    const txid = item.txid.toLowerCase();
    const key = `${txid}:${item.vout}`;
    if (seen.has(key)) return invalid();
    seen.add(key);
    return { txid, vout: item.vout as number, value: item.value as string, blockHeight: item.blockHeight as number };
  });
}

// The endpoint must answer every requested address exactly once. Missing rows
// are unavailable data, never evidence that an address is unused or empty.
export function validateScanResults(addresses: string[], value: unknown): ScanResult[] {
  const expected = new Set(addresses);
  if (expected.size !== addresses.length || !Array.isArray(value) || value.length !== expected.size) return invalid();
  const outpoints = new Set<string>();
  const results = value.map(item => {
    if (!record(item) || typeof item.address !== 'string' || !expected.delete(item.address) || typeof item.used !== 'boolean') return invalid();
    const balance = atomicValue(item.balance);
    const utxos = validateUtxos(item.utxos);
    let total = 0n;
    for (const utxo of utxos) {
      const key = `${utxo.txid}:${utxo.vout}`;
      if (outpoints.has(key)) return invalid();
      outpoints.add(key);
      total += BigInt(utxo.value);
    }
    if (total !== balance || (!item.used && (balance !== 0n || utxos.length > 0))) return invalid();
    return { address: item.address, used: item.used, balance: item.balance as string, utxos };
  });
  if (expected.size) return invalid();
  return results;
}
