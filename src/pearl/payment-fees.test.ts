import { describe, it, expect } from 'vitest';
import * as btc from '@scure/btc-signer';
import { parsePrivateKey, privateKeyToAddress } from './wallet';
import { importedSigner, buildAndSignTx, buildCompoundTx, quoteSend, quoteFixedAmountMax } from './transaction';
import type { ScannedUtxo } from './hdwallet';
import { hexToBytes } from './bytes';
import { MAX_FEE_RATE } from './money';

const priv = parsePrivateKey('2222222222222222222222222222222222222222222222222222222222222222');
const owner = privateKeyToAddress(priv, 'mainnet');
const recipient = privateKeyToAddress(parsePrivateKey('3333333333333333333333333333333333333333333333333333333333333333'), 'mainnet');
const signer = importedSigner(priv, 'mainnet');
const coin = (id: number, value: bigint): ScannedUtxo => ({
  txid: id.toString(16).padStart(64, '0'), vout: 0, value,
  address: owner, chain: 0, index: 0, blockHeight: 1,
});
const base = { signer, network: 'mainnet' as const, recipient, changeAddress: owner };
const parse = (hex: string) => btc.Transaction.fromRaw(hexToBytes(hex));

describe('send MAX and fee agreement', () => {
  it('quotes a fixed-amount MAX that ordinary review and signing can fund exactly', () => {
    for (const feeRate of [1n, 2n, 100n]) for (const count of [1, 2, 5]) {
      const utxos = Array.from({ length: count }, (_, i) => coin(i + 1, BigInt(i + 1) * 100_000n));
      const quote = quoteFixedAmountMax({ utxos, feeRate });
      expect(quote.ok).toBe(true);
      const args = { ...base, utxos, feeRate, amount: quote.amount };
      expect(quoteSend(args)).toEqual(quote);
      const built = buildAndSignTx(args), tx = parse(built.hex);
      expect(tx.getOutput(0).amount).toBe(quote.amount);
      expect(built.feeGrains).toBe(quote.fee); expect(built.changeGrains).toBe(quote.change);
      expect(quote.amount + quote.fee).toBeLessThanOrEqual(quote.spendable);
    }
  });
  it('fixed-amount MAX excludes protected coins and uneconomic extra inputs', () => {
    const utxos = [coin(1, 100_000n), coin(2, 1n), coin(3, 10_000_000n)];
    const protectedOutpoints = new Set([`${utxos[2].txid}:0`]);
    const quote = quoteFixedAmountMax({ utxos, protectedOutpoints, feeRate: 2n });
    expect(quote).toMatchObject({ ok: true, amount: 99_690n, fee: 310n, inputCount: 1, spendable: 100_001n });
    const tx = parse(buildAndSignTx({ ...base, utxos, protectedOutpoints, feeRate: 2n, amount: quote.amount }).hex);
    expect(tx.inputsLength).toBe(1); expect(tx.getOutput(0).amount).toBe(99_690n);
  });
  it('fixed-amount MAX preserves dust, duplicate-input and excessive-fee guardrails', () => {
    const feeRate = 1n;
    expect(quoteFixedAmountMax({ utxos: [], feeRate }).ok).toBe(false);
    expect(quoteFixedAmountMax({ utxos: [coin(1, 701n)], feeRate }).ok).toBe(false);
    expect(quoteFixedAmountMax({ utxos: [coin(1, 702n)], feeRate })).toMatchObject({ ok: true, amount: 547n, fee: 155n });
    const duplicate = coin(1, 100_000n);
    expect(() => quoteFixedAmountMax({ utxos: [duplicate, duplicate], feeRate })).toThrow(/Duplicate/);
    const tooMany = Array.from({ length: 900 }, (_, i) => coin(i + 1, 100_000_000n));
    expect(quoteFixedAmountMax({ utxos: tooMany, feeRate: MAX_FEE_RATE })).toMatchObject({ ok: false, error: expect.stringMatching(/safety limit/) });
  });
  it('signs MAX as one output after fee and excludes a larger protected name coin', () => {
    const utxos = [coin(1, 100_000n), coin(2, 90_000n), coin(3, 10_000_000n)];
    const protectedOutpoints = new Set([`${utxos[2].txid}:0`]);
    const args = { ...base, utxos, protectedOutpoints, amount: 0n, feeRate: 2n, sendMax: true };
    const quote = quoteSend(args);
    expect(quote).toMatchObject({ ok: true, amount: 189_660n, fee: 340n, change: 0n, inputCount: 2 });
    const built = buildAndSignTx(args);
    const tx = parse(built.hex);
    expect(tx.inputsLength).toBe(2);
    expect(tx.outputsLength).toBe(1);
    expect(tx.getOutput(0).amount).toBe(quote.amount);
    expect(built.feeGrains).toBe(quote.fee);
    expect(built.changeGrains).toBe(0n);
    expect(tx.getInput(0).finalScriptWitness?.length).toBeGreaterThan(0);
    expect(tx.getInput(1).finalScriptWitness?.length).toBeGreaterThan(0);
  });

  it('ordinary multi-input review includes the same actual fee and change as signing', () => {
    const args = { ...base, utxos: [coin(1, 10_000n), coin(2, 10_000n)], amount: 15_000n, feeRate: 3n };
    const quote = quoteSend(args);
    const built = buildAndSignTx(args);
    expect(quote.fee).toBe(639n);
    expect(quote.inputCount).toBe(2);
    expect(built.feeGrains).toBe(quote.fee);
    expect(built.changeGrains).toBe(quote.change);
    expect(parse(built.hex).getOutput(0).amount).toBe(args.amount);
  });

  it('includes discarded dust in the review fee', () => {
    const args = { ...base, utxos: [coin(1, 10_000n)], amount: 9_700n, feeRate: 1n };
    const quote = quoteSend(args);
    expect(quote.fee).toBe(300n);
    expect(buildAndSignTx(args).feeGrains).toBe(300n);
  });

  it('rejects the entire balance as an ordinary payment and reports the missing fee', () => {
    const args = { ...base, utxos: [coin(1, 10_000n)], amount: 10_000n, feeRate: 1n };
    expect(quoteSend(args)).toMatchObject({ ok: false, shortfall: 155n });
    expect(() => buildAndSignTx(args)).toThrow(/Insufficient funds/);
  });

  it('refuses MAX when only protected coins or fee-sized balance remain', () => {
    const tiny = { ...base, amount: 0n, feeRate: 1n, sendMax: true };
    expect(() => buildAndSignTx({ ...tiny, utxos: [coin(1, 658n)] })).toThrow(/too small/);
    const protectedCoin = coin(2, 1_000_000n);
    expect(quoteSend({ ...tiny, utxos: [protectedCoin], protectedOutpoints: new Set([`${protectedCoin.txid}:0`]) }).ok).toBe(false);
  });

  it('keeps name coins protected when explorer transaction IDs use a different hex case', () => {
    const name = { ...coin(1, 1_000_000n), txid: 'AB'.repeat(32) };
    const quote = quoteSend({ utxos: [name], protectedOutpoints: new Set([`${name.txid.toLowerCase()}:0`]), amount: 0n, feeRate: 1n, sendMax: true });
    expect(quote.spendable).toBe(0n);
    expect(quote.ok).toBe(false);
  });
});

describe('signer payment guardrails', () => {
  it.each([0n, -1n, MAX_FEE_RATE + 1n])('rejects invalid fee rate %s before signing', feeRate => {
    expect(() => buildAndSignTx({ ...base, utxos: [coin(1, 100_000_000n)], amount: 1_000n, feeRate })).toThrow(/Fee rate/);
  });

  it('rejects a duplicated explorer outpoint rather than showing an inflated balance', () => {
    const same = coin(1, 10_000n);
    expect(() => quoteSend({ utxos: [same, same], amount: 15_000n, feeRate: 1n })).toThrow(/Duplicate/);
    const mixedCase = { ...same, txid: 'ab'.repeat(32) };
    expect(() => quoteSend({ utxos: [mixedCase, { ...mixedCase, txid: mixedCase.txid.toUpperCase() }], amount: 15_000n, feeRate: 1n })).toThrow(/Duplicate/);
  });

  it('rejects malformed output indexes from the indexer', () => {
    for (const vout of [-1, 0.5, 0x1_0000_0000]) {
      expect(() => quoteSend({ utxos: [{ ...coin(1, 10_000n), vout }], amount: 1_000n, feeRate: 1n })).toThrow(/outpoint/);
    }
  });

  it('rejects dust and non-positive payments', () => {
    for (const amount of [0n, -1n, 546n]) {
      expect(() => buildAndSignTx({ ...base, utxos: [coin(1, 100_000n)], amount, feeRate: 1n })).toThrow(/Amount must/);
    }
  });

  it('enforces the upstream 10 PRL fee ceiling even when an excessive fee is affordable', () => {
    const utxos = Array.from({ length: 900 }, (_, i) => coin(i + 1, 100_000_000n));
    const args = { ...base, utxos, amount: 0n, feeRate: MAX_FEE_RATE, sendMax: true };
    expect(quoteSend(args)).toMatchObject({ ok: false, error: expect.stringMatching(/safety limit/) });
    expect(() => buildAndSignTx(args)).toThrow(/safety limit/);
    expect(() => buildCompoundTx({ signer, network: 'mainnet', utxos, destination: owner, feeRate: MAX_FEE_RATE })).toThrow(/safety limit/);
  });
});
