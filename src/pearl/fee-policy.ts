import { MAX_FEE_RATE } from './money';

// Wallet policy, not a live network recommendation. See docs/TRANSACTION-FEES.md.
export const FALLBACK_FEE_RATE = 2n;
export const DEFAULT_RELAY_FEE_RATE = 1n;

export interface FeeStats {
  recommendedFee?: unknown; // grains/vB, normalized by the backend adapter
  mempoolMinFee?: unknown;  // grains/vB in the Pearlchain explorer response
  relayfee?: unknown;       // PRL/kB in the Pearl node/explorer response
}

export type FeePolicySource = 'network' | 'fallback';
export type FeePolicyResult = {
  available: true;
  rate: bigint;
  source: FeePolicySource;
  minimumRate: bigint;
} | {
  available: false;
  reason: string;
};

const unavailable = (reason: string): FeePolicyResult => ({ available: false, reason });

// Decimal scaling avoids an extra grain from floating-point multiplication,
// e.g. a PRL/kB value whose exact decimal conversion is an integer grains/vB.
function ceilDecimalRate(value: number, scalePower = 0, multiple = 1n): bigint {
  const [coefficient, exponent = '0'] = value.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const digits = BigInt(whole + fraction) * multiple;
  const power = Number(exponent) - fraction.length + scalePower;
  if (power >= 0) return digits * 10n ** BigInt(power);
  const divisor = 10n ** BigInt(-power);
  return (digits + divisor - 1n) / divisor;
}

function validRate(value: unknown, allowZero: boolean): value is number {
  return typeof value === 'number' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
}

/**
 * Choose a quote rate from fresh public data. A missing estimate may use the
 * explicit fallback; malformed/high estimates never silently become cheaper.
 * Fresh UTXOs, name protection and approval freshness remain caller obligations.
 */
export function selectFeePolicy(stats: FeeStats | null | undefined): FeePolicyResult {
  if (stats != null && (typeof stats !== 'object' || Array.isArray(stats))) {
    return unavailable('The explorer returned invalid fee information. Refresh before sending.');
  }

  let minimumRate = DEFAULT_RELAY_FEE_RATE;
  for (const [value, scalePower, label] of [
    [stats?.relayfee, 5, 'relay'],
    [stats?.mempoolMinFee, 0, 'mempool'],
  ] as const) {
    if (value == null) continue;
    if (!validRate(value, true)) {
      return unavailable(`The explorer returned an invalid ${label} fee floor. Refresh before sending.`);
    }
    let floor = ceilDecimalRate(value, scalePower);
    // The node can reject rates equal to its last eviction rate while full.
    // Stay strictly above a positive published mempool floor, even if integral.
    if (label === 'mempool' && value > 0 && Number(floor) === value) floor++;
    if (floor > MAX_FEE_RATE) {
      return unavailable('The network fee floor exceeds the wallet safety limit. Try again later.');
    }
    if (floor > minimumRate) minimumRate = floor;
  }

  const recommendation = stats?.recommendedFee;
  if (recommendation == null) {
    return { available: true, source: 'fallback', minimumRate,
      rate: minimumRate > FALLBACK_FEE_RATE ? minimumRate : FALLBACK_FEE_RATE };
  }
  if (!validRate(recommendation, false)) {
    return unavailable('The explorer returned an invalid fee recommendation. Refresh before sending.');
  }
  const rate = ceilDecimalRate(recommendation);
  if (rate > MAX_FEE_RATE) {
    return unavailable('The recommended fee exceeds the wallet safety limit. Try again later.');
  }
  return { available: true, source: 'network', minimumRate,
    rate: rate > minimumRate ? rate : minimumRate };
}

/** Apply a wallet priority multiplier without going below an observed floor. */
export function feeRateForPolicy(policy: FeePolicyResult | null | undefined, multiplier = 1): bigint {
  if (!policy?.available) throw new Error(policy?.reason ?? 'Fee information is unavailable. Refresh before sending.');
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new Error('Invalid fee priority.');
  if (typeof policy.rate !== 'bigint' || typeof policy.minimumRate !== 'bigint'
    || policy.minimumRate < DEFAULT_RELAY_FEE_RATE || policy.rate < policy.minimumRate
    || policy.rate > MAX_FEE_RATE) throw new Error('Invalid fee policy.');
  const rate = ceilDecimalRate(multiplier, 0, policy.rate);
  if (rate > MAX_FEE_RATE) {
    throw new Error('The selected fee exceeds the wallet safety limit. Choose a lower priority.');
  }
  return rate > policy.minimumRate ? rate : policy.minimumRate;
}
