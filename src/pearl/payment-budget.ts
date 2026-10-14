const MAX_ATOMS = 0x7fffffffffffffffn;

/** API budgets are exact integer grains, never PRL decimals or JS numbers. */
export function parseTotalDebitCap(value: unknown, amount: bigint): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) throw new Error('Budget max must be a canonical positive integer in PRL grains.');
  const cap = BigInt(value);
  if (cap > MAX_ATOMS || amount <= 0n || cap < amount) throw new Error('Budget max must cover the requested amount and be within the supported range.');
  return cap;
}

/** Apply to the reviewed plan and actual transaction before any signature. */
export function assertTotalDebit(amount: bigint, fee: bigint, cap?: bigint, approvedFee?: bigint): void {
  if (typeof amount !== 'bigint' || typeof fee !== 'bigint' || amount <= 0n || fee < 0n) throw new Error('Invalid transaction amount or network fee.');
  if (approvedFee !== undefined && fee !== approvedFee) throw new Error('The network fee differs from your approval. Review this payment again.');
  if (cap !== undefined && (typeof cap !== 'bigint' || cap < amount || cap > MAX_ATOMS || amount + fee > cap)) {
    throw new Error('The payment and network fee exceed Budget max. Nothing was signed or submitted.');
  }
}
