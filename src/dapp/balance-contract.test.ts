import { describe, expect, it } from 'vitest';
import { parsePrivateKey, privateKeyToAddress } from '@/pearl/wallet';
import { BALANCE_TTL, freshBalance, validatePublicBalance, type PublicBalance } from './balance-contract';

const address = privateKeyToAddress(parsePrivateKey('2'.repeat(64)), 'mainnet');
const now = 100_000;
const snapshot: PublicBalance = { address, network: 'pearl:mainnet', total: '9007199254740993', spendable: '10000', maxSend: '9800', estimatedMaxFee: '200', updatedAt: now, namesVerified: true };

describe('public atomic balance snapshot boundary', () => {
  it('preserves atomic values beyond Number.MAX_SAFE_INTEGER', () => {
    expect(validatePublicBalance(snapshot, now).total).toBe('9007199254740993');
  });
  it.each([
    { total: 1 }, { total: '1e8' }, { total: '0.1' }, { total: '-1' }, { total: '01' },
    { network: 'pearl:testnet' }, { updatedAt: now + 1 }, { updatedAt: now - BALANCE_TTL - 1 },
    { spendable: '9007199254740994' }, { maxSend: '9900', estimatedMaxFee: '200' },
    { maxSend: null, estimatedMaxFee: '200' }, { namesVerified: false }, { utxos: [] },
  ])('rejects malformed, stale or inconsistent provider data: %j', patch => {
    expect(() => validatePublicBalance({ ...snapshot, ...patch }, now)).toThrow();
  });
  it('keeps unknown name protection distinct from zero spendable funds', () => {
    expect(validatePublicBalance({ ...snapshot, namesVerified: false, spendable: null, maxSend: null, estimatedMaxFee: null }, now)).toMatchObject({ total: snapshot.total, spendable: null });
  });
  it('accepts verified spendable funds while fee/MAX information is unavailable', () => {
    expect(validatePublicBalance({ ...snapshot, maxSend: null, estimatedMaxFee: null }, now).spendable).toBe('10000');
  });
  it.each(['network', 'fallback'] as const)('accepts bounded optional fee provenance from %s', feeSource => {
    expect(validatePublicBalance({ ...snapshot, feeRate: '2', feeSource }, now)).toMatchObject({ feeRate: '2', feeSource });
  });
  it('accepts explicitly unavailable fees only when MAX is unavailable', () => {
    expect(validatePublicBalance({ ...snapshot, maxSend: null, estimatedMaxFee: null, feeRate: null, feeSource: null }, now).feeSource).toBeNull();
  });
  it.each([
    { feeRate: '2' }, { feeSource: 'fallback' }, { feeRate: '2', feeSource: 'verified' },
    { feeRate: '0', feeSource: 'fallback' }, { feeRate: '20001', feeSource: 'network' },
    { feeRate: '1.5', feeSource: 'network' }, { feeRate: 2, feeSource: 'fallback' },
    { feeRate: null, feeSource: null }, { feeRate: '2', feeSource: null },
  ])('rejects inconsistent fee metadata: %j', patch => {
    expect(() => validatePublicBalance({ ...snapshot, ...patch }, now)).toThrow();
  });
  it('returns null for stale data or a different connected address', () => {
    expect(freshBalance(snapshot, address, now + BALANCE_TTL + 1)).toBeNull();
    expect(freshBalance(snapshot, 'different-address', now)).toBeNull();
  });
});
