import { describe, expect, it, vi } from 'vitest';
import * as btc from '@scure/btc-signer';
import { buildAndSignTx, importedSigner, type SendArgs } from './transaction';
import { parsePrivateKey, privateKeyToAddress } from './wallet';
import { hexToBytes } from './bytes';

// Published synthetic test key; never imported into the installed user wallet.
const key = parsePrivateKey('2222222222222222222222222222222222222222222222222222222222222222');
const owner = privateKeyToAddress(key, 'mainnet');
function fixture() {
  const signer = importedSigner(key, 'mainnet');
  const access = vi.spyOn(signer, 'keyForUtxo');
  const args: SendArgs = { signer, network: 'mainnet', recipient: owner, changeAddress: owner, amount: 100000001n, feeRate: 2n,
    utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 200000000n, address: owner, chain: 0, index: 0, blockHeight: 1 }],
    maxTotalDebitAtoms: 100000311n, approvedFee: 310n };
  return { args, access };
}

describe('total debit cap before transaction signing', () => {
  it('signs only an exact-boundary payment and the serialized outputs confirm the budget', () => {
    const f = fixture(), built = buildAndSignTx(f.args);
    const tx = btc.Transaction.fromRaw(hexToBytes(built.hex));
    let outputs = 0n;
    for (let i = 0; i < tx.outputsLength; i++) outputs += tx.getOutput(i).amount!;
    const actualFee = f.args.utxos.reduce((sum, item) => sum + item.value, 0n) - outputs;
    expect(actualFee).toBe(310n);
    expect(tx.getOutput(0).amount! + actualFee).toBe(f.args.maxTotalDebitAtoms);
    expect(tx.getInput(0).finalScriptWitness?.length).toBeGreaterThan(0);
  });

  it('rejects a one-grain overrun before asking the signer for any input key', () => {
    const f = fixture(); f.args.maxTotalDebitAtoms!--;
    expect(() => buildAndSignTx(f.args)).toThrow(/exceed Budget max/);
    expect(f.access).not.toHaveBeenCalled();
  });

  it.each(['fee', 'dust', 'more-inputs'] as const)('revalidates a changed %s against the approved fee before signing', change => {
    const f = fixture();
    if (change === 'fee') f.args.feeRate = 3n;
    if (change === 'dust') f.args.utxos[0].value = 100000511n;
    if (change === 'more-inputs') f.args.utxos = [
      { ...f.args.utxos[0], value: 60000000n },
      { ...f.args.utxos[0], txid: 'cd'.repeat(32), value: 60000000n },
    ];
    expect(() => buildAndSignTx(f.args)).toThrow(/differs from your approval/);
    expect(f.access).not.toHaveBeenCalled();
  });

  it('still enforces the cap when no reviewed fee is supplied by a caller', () => {
    const f = fixture(); delete f.args.approvedFee; f.args.feeRate = 3n;
    expect(() => buildAndSignTx(f.args)).toThrow(/exceed Budget max/);
    expect(f.access).not.toHaveBeenCalled();
  });

  it('preserves legacy native sends when neither optional constraint is supplied', () => {
    const f = fixture(); delete f.args.approvedFee; delete f.args.maxTotalDebitAtoms;
    expect(buildAndSignTx(f.args).feeGrains).toBe(310n);
  });
});
