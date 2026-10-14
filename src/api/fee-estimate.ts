// Blockbook estimatefee returns PRL/kB. Preserve decimal precision and round UP
// to integer grains/vB; malformed rates must not become a cheaper fallback.
export function blockbookFeeRate(value: unknown): number | null {
  if (value === '-1' || value === null) return null; // estimator has no sample
  if (typeof value !== 'string' || value.length > 48 || !/^(?:0|[1-9]\d*)(?:\.\d{1,32})?$/.test(value)) return NaN;
  const [whole, fraction = ''] = value.split('.');
  const divisor = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction) * 100_000n;
  if (numerator === 0n) return NaN;
  const rate = (numerator + divisor - 1n) / divisor;
  return Number(rate); // policy rejects anything above its bounded ceiling
}
