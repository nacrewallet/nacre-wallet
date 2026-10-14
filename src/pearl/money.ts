// Payment amounts stay decimal strings / bigint until display-only fiat conversion.
// In particular, never repair a pasted value by deleting characters or rounding it.
export function parsePearlAmount(input: string): bigint | null {
  const value = input.trim().replace(',', '.');
  if (value.length > 100 || !/^(?:\d+(?:\.\d{0,8})?|\.\d{1,8})$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole || '0') * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

export function formatPearlAmount(grains: bigint): string {
  const sign = grains < 0n ? '-' : '';
  const value = grains < 0n ? -grains : grains;
  const fraction = String(value % 100_000_000n).padStart(8, '0').replace(/0+$/, '');
  return `${sign}${value / 100_000_000n}${fraction ? `.${fraction}` : ''}`;
}

// Matches the ceiling shipped in Pearl Wallet 1.3.3. Invalid/missing explorer
// recommendations fall back to 1 grain/vB; the signing layer enforces limits too.
export const MAX_FEE_RATE = 20_000n;
export const MAX_NETWORK_FEE = 1_000_000_000n;

export function recommendedFeeRate(value: number | null | undefined, multiplier = 1): bigint {
  const rate = value != null && Number.isFinite(value) && value > 0 ? value : 1;
  const factor = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  return BigInt(Math.max(1, Math.min(Number(MAX_FEE_RATE), Math.round(rate * factor))));
}
