import { describe, expect, it, vi } from 'vitest';
import * as btc from '@scure/btc-signer';
import { decodeBech32m } from './address';
import { hexToBytes } from './bytes';
import type { ScannedUtxo } from './hdwallet';
import { buildAndSignTx, buildCompoundTx, importedSigner, quoteFixedAmountMax, quoteSend } from './transaction';
import { parsePrivateKey, privateKeyToAddress } from './wallet';

// Published synthetic fixture only; no wallet storage or network is used.
const key = parsePrivateKey('2222222222222222222222222222222222222222222222222222222222222222');
const owner = privateKeyToAddress(key, 'mainnet');
const signer = importedSigner(key, 'mainnet');
const base = { signer, network: 'mainnet' as const, recipient: owner, changeAddress: owner };
const coin = (index: number, value = 100_000n): ScannedUtxo => ({
  txid: (index + 1).toString(16).padStart(64, '0'), vout: 0, value,
  address: owner, chain: 0, index: 0, blockHeight: 1,
});

// Ask the serialization library for the actual size, independently of the
// planner's estimate. Fixed-width dummy witnesses are only serialization
// fixtures; they are not valid signatures and are never submitted anywhere.
function serializedSize(inputCount: number, outputCount = 1): number {
  const script = new Uint8Array([0x51, 0x20, ...decodeBech32m(owner)!.witnessProgram]);
  const tx = new btc.Transaction();
  for (let i = 0; i < inputCount; i++) {
    const input = coin(i);
    tx.addInput({ txid: input.txid, index: input.vout, witnessUtxo: { script, amount: input.value } });
  }
  for (let i = 0; i < outputCount; i++) tx.addOutput({ script, amount: 1_000n });
  for (let i = 0; i < inputCount; i++) tx.updateInput(i, { finalScriptWitness: [new Uint8Array(64)] }, true);
  return btc.Transaction.fromRaw(tx.extract()).vsize;
}

describe('fee planner serialization regressions', () => {
  it.each([1, 2, 5, 252, 253])('fixed-amount MAX remains fundable with %i inputs and covers the serialized fee', count => {
    const utxos = Array.from({ length: count }, (_, i) => coin(i));
    const feeRate = 3n;
    const quote = quoteFixedAmountMax({ utxos, feeRate });
    expect(quote.ok).toBe(true);
    expect(quoteSend({ utxos, feeRate, amount: quote.amount })).toEqual(quote);
    expect(quote.inputCount).toBe(count);
    expect(quote.amount + quote.fee + quote.change).toBe(quote.spendable);
    expect(quote.fee).toBeGreaterThanOrEqual(BigInt(serializedSize(count)) * feeRate);
  });

  it('includes the CompactSize input-count expansion at 253 inputs', () => {
    expect(serializedSize(252)).toBe(14_544);
    expect(serializedSize(253)).toBe(14_603);
    const utxos = Array.from({ length: 253 }, (_, i) => coin(i));
    const quote = quoteSend({ utxos, amount: 0n, feeRate: 20n, sendMax: true });
    expect(quote.ok).toBe(true);
    expect(quote.fee).toBeGreaterThanOrEqual(BigInt(serializedSize(253)) * 20n);
  });

  it('checks actual signed fee and conservation for the protected multi-input maximum', () => {
    const utxos = [coin(0, 200_000n), coin(1), coin(2, 20_000_000n)];
    const protectedOutpoints = new Set([`${utxos[2].txid}:0`]);
    const feeRate = 3n;
    const quote = quoteFixedAmountMax({ utxos, protectedOutpoints, feeRate });
    const built = buildAndSignTx({ ...base, utxos, protectedOutpoints, feeRate,
      amount: quote.amount, approvedFee: quote.fee, maxTotalDebitAtoms: quote.amount + quote.fee });
    const tx = btc.Transaction.fromRaw(hexToBytes(built.hex));
    expect(tx.inputsLength).toBe(2);
    expect(tx.outputsLength).toBe(1);
    expect(tx.getOutput(0).amount).toBe(quote.amount);
    expect(300_000n - tx.getOutput(0).amount!).toBe(built.feeGrains);
    expect(built.feeGrains).toBeGreaterThanOrEqual(BigInt(tx.vsize) * feeRate);

    const keyForUtxo = vi.fn(() => key);
    expect(() => buildAndSignTx({ ...base, signer: { keyForUtxo }, utxos, protectedOutpoints,
      feeRate, amount: quote.amount, approvedFee: quote.fee,
      maxTotalDebitAtoms: quote.amount + quote.fee - 1n })).toThrow(/Budget max/);
    expect(keyForUtxo).not.toHaveBeenCalled();
  });

  it('native MAX excludes inputs whose fee would reduce the recipient amount', () => {
    const utxos = [coin(0), coin(1, 1n), coin(2, 116n)];
    const quote = quoteSend({ utxos, feeRate: 2n, amount: 0n, sendMax: true });
    expect(quote).toMatchObject({ ok: true, amount: 99_776n, fee: 224n, inputCount: 1, spendable: 100_117n });
    const tx = btc.Transaction.fromRaw(hexToBytes(buildAndSignTx({ ...base, utxos,
      feeRate: 2n, amount: 0n, sendMax: true }).hex));
    expect(tx.inputsLength).toBe(1);
    expect(tx.getOutput(0).amount).toBe(quote.amount);
  });

  it('rejects oversized MAX and consolidation before obtaining an input key', () => {
    expect(serializedSize(1738)).toBe(99_991);
    expect(serializedSize(1739)).toBe(100_048);
    const utxos = Array.from({ length: 1739 }, (_, i) => coin(i));
    expect(quoteSend({ utxos: utxos.slice(0, -1), feeRate: 1n, amount: 0n, sendMax: true }).ok).toBe(true);
    expect(quoteSend({ utxos, feeRate: 1n, amount: 0n, sendMax: true })).toMatchObject({ ok: false, error: expect.stringMatching(/standard size limit/) });
    const keyForUtxo = vi.fn(() => key);
    expect(() => buildAndSignTx({ ...base, signer: { keyForUtxo }, utxos,
      feeRate: 1n, amount: 0n, sendMax: true })).toThrow(/standard size limit/);
    expect(() => buildCompoundTx({ signer: { keyForUtxo }, network: 'mainnet', utxos,
      destination: owner, feeRate: 1n })).toThrow(/standard size limit/);
    expect(keyForUtxo).not.toHaveBeenCalled();
  // Serializing thousands of inputs can exceed the default timeout on CI.
  }, 15_000);
});
