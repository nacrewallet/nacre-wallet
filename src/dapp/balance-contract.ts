import { isValidAddress } from '@/pearl/address';
import { MAX_FEE_RATE } from '@/pearl/money';
import { isRecord, ProviderError } from './protocol';

export const BALANCE_TTL = 60_000;
// All amounts are unsigned base-10 integers in grains (1 PRL = 100000000).
// A null value means unavailable, never a zero balance or a permission grant.
export interface PublicBalance {
  address: string;
  network: 'pearl:mainnet';
  total: string;
  spendable: string | null;
  // Conservative fixed-amount sendTransaction estimate, not wallet sendMax.
  maxSend: string | null;
  estimatedMaxFee: string | null;
  // Optional paired fields for compatibility with earlier provider snapshots.
  feeRate?: string | null; // integer grains/vB
  feeSource?: 'network' | 'fallback' | null;
  updatedAt: number;
  namesVerified: boolean;
}
const atomic = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,29})$/.test(value);

export function validatePublicBalance(value: unknown, now: number): PublicBalance {
  if (!isRecord(value) || Object.keys(value).some(k => !['address', 'network', 'total', 'spendable', 'maxSend', 'estimatedMaxFee', 'feeRate', 'feeSource', 'updatedAt', 'namesVerified'].includes(k))
    || typeof value.address !== 'string' || !isValidAddress(value.address, 'mainnet') || value.network !== 'pearl:mainnet'
    || !atomic(value.total) || typeof value.namesVerified !== 'boolean'
    || !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) > now || now - (value.updatedAt as number) > BALANCE_TTL) {
    throw new ProviderError(-32602, 'The wallet balance is invalid or outdated. Refresh it in Nacre Wallet.');
  }
  const hasFeeDetails = Object.hasOwn(value, 'feeRate') || Object.hasOwn(value, 'feeSource');
  if (hasFeeDetails && ((value.feeSource !== null && value.feeSource !== 'network' && value.feeSource !== 'fallback')
    || (value.feeSource === null ? value.feeRate !== null || value.maxSend !== null
      : !atomic(value.feeRate) || BigInt(value.feeRate) < 1n || BigInt(value.feeRate) > MAX_FEE_RATE))) {
    throw new ProviderError(-32602, 'The wallet fee estimate is inconsistent.');
  }
  const optionalAmounts = [value.spendable, value.maxSend, value.estimatedMaxFee];
  if (optionalAmounts.some(v => v !== null && !atomic(v))
    || (!value.namesVerified && optionalAmounts.some(v => v !== null))
    || (value.spendable !== null && BigInt(value.spendable as string) > BigInt(value.total))
    || ((value.maxSend === null) !== (value.estimatedMaxFee === null))
    || (value.maxSend !== null && (value.spendable === null
      || BigInt(value.maxSend as string) + BigInt(value.estimatedMaxFee as string) > BigInt(value.spendable as string)))) {
    throw new ProviderError(-32602, 'The wallet balance breakdown is inconsistent.');
  }
  return value as unknown as PublicBalance;
}

export function freshBalance(value: PublicBalance | undefined, address: string, now: number): PublicBalance | null {
  if (!value || value.address !== address) return null;
  try { return validatePublicBalance(value, now); } catch { return null; }
}
