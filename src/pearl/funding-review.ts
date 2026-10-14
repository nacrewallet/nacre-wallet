import type { ScannedUtxo } from './hdwallet';

// Capture the public facts that determine input selection, change and fees.
// Array order and confirmation height can change without changing a payment.
// Values remain exact decimal bigint strings, including above 2^53.
export function fundingFingerprint(
  utxos: readonly ScannedUtxo[], protectedOutpoints: ReadonlySet<string>, destinations: readonly string[],
): string {
  const inputs = utxos.map(u => JSON.stringify([
    u.txid.toLowerCase(), u.vout, u.value.toString(), u.address, u.chain, u.index,
  ])).sort();
  const protectedKeys = [...protectedOutpoints].map(key => key.toLowerCase()).sort();
  return JSON.stringify([inputs, protectedKeys, destinations]);
}

export function assertReviewedFunding(reviewed: string, current: string): void {
  if (current !== reviewed) throw new Error('Your coins, name protection or destination changed. Review this transaction again.');
}
