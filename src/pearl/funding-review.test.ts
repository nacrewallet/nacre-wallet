import { describe, expect, it } from 'vitest';
import type { ScannedUtxo } from './hdwallet';
import { assertReviewedFunding, fundingFingerprint } from './funding-review';

const input: ScannedUtxo = {
  txid: 'ab'.repeat(32), vout: 0, value: 9_007_199_254_740_992n,
  address: 'public-owner-fixture', chain: 0, index: 0, blockHeight: 12,
};
const name = { ...input, txid: 'cd'.repeat(32), value: 547n };
const protectedOutpoints = new Set([`${name.txid}:0`]);
const destinations = ['recipient-fixture', 'change-fixture'];
const reviewed = fundingFingerprint([input, name], protectedOutpoints, destinations);

describe('reviewed name-transfer and consolidation funding', () => {
  it('accepts ordering, hex case and confirmation updates without altering the reviewed plan', () => {
    const current = fundingFingerprint([{ ...name, blockHeight: 14 }, { ...input, txid: input.txid.toUpperCase() }],
      new Set([`${name.txid.toUpperCase()}:0`]), [...destinations]);
    expect(() => assertReviewedFunding(reviewed, current)).not.toThrow();
  });

  it.each([
    ['one-grain value increase above the JS safe integer', { value: input.value + 1n }],
    ['different outpoint', { vout: 1 }],
    ['different owner', { address: 'other-owner-fixture' }],
    ['different signing chain', { chain: 1 as const }],
    ['different signing index', { index: 1 }],
  ] as const)('requires another review for %s', (_label, change) => {
    const current = fundingFingerprint([{ ...input, ...change }, name], protectedOutpoints, destinations);
    expect(() => assertReviewedFunding(reviewed, current)).toThrow(/Review this transaction again/);
  });

  it('rejects additional or missing inputs even when the fee rate is unchanged', () => {
    for (const utxos of [[input], [input, name, { ...input, txid: 'ef'.repeat(32) }]]) {
      expect(() => assertReviewedFunding(reviewed, fundingFingerprint(utxos, protectedOutpoints, destinations))).toThrow(/coins/);
    }
  });

  it('rejects changes to protected names or either payment destination', () => {
    const current = [
      fundingFingerprint([input, name], new Set(), destinations),
      fundingFingerprint([input, name], new Set([...protectedOutpoints, `${input.txid}:0`]), destinations),
      fundingFingerprint([input, name], protectedOutpoints, ['new-recipient', destinations[1]]),
      fundingFingerprint([input, name], protectedOutpoints, [destinations[0], 'new-change']),
    ];
    for (const fingerprint of current) expect(() => assertReviewedFunding(reviewed, fingerprint)).toThrow(/Review/);
  });

  it('keeps the original review immutable when caller arrays and values change', () => {
    const utxos = [{ ...input }, { ...name }], outputs = [...destinations], protectedCoins = new Set(protectedOutpoints);
    const snapshot = fundingFingerprint(utxos, protectedCoins, outputs);
    utxos[0].value++; outputs[0] = 'replacement'; protectedCoins.clear();
    expect(snapshot).toBe(reviewed);
    expect(() => assertReviewedFunding(snapshot, fundingFingerprint(utxos, protectedCoins, outputs))).toThrow(/Review/);
  });
});
