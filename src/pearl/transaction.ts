// Taproot key-path send. Mirrors mobile transaction.ts but Buffer-free.

import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { type HDKey } from '@scure/bip32';
import { decodeBech32m, isPayableWitnessProgram } from './address';
import { deriveAddress, getPrivateKey, toXOnlyPubkey, privateKeyToAddress, defaultDerivation, type Derivation } from './wallet';
import { type PearlNetwork, DUST_LIMIT, getNetwork } from './network';
import type { ScannedUtxo } from './hdwallet';
import { bytesToHex } from './bytes';
import { MAX_FEE_RATE, MAX_NETWORK_FEE } from './money';
import { assertTotalDebit } from './payment-budget';

const PEARL_NET: typeof btc.NETWORK         = { ...btc.NETWORK, bech32: 'prl'  };
const PEARL_NET_TESTNET: typeof btc.NETWORK = { ...btc.NETWORK, bech32: 'tprl' };

export interface BuiltTx {
  hex:          string;
  txid:         string;
  feeGrains:    bigint;
  changeGrains: bigint;
  inputCount:   number;
}

function addressToTaprootScript(address: string): Uint8Array {
  const d = decodeBech32m(address);
  if (!d || d.witnessVersion !== 1 || d.witnessProgram.length !== 32) {
    throw new Error('Invalid Pearl Taproot address');
  }
  const s = new Uint8Array(34);
  s[0] = 0x51;
  s[1] = 0x20;
  s.set(d.witnessProgram, 2);
  return s;
}

// Output script to PAY a recipient of any SegWit version: OP_<v> <program>.
// For v1 this is identical to addressToTaprootScript (OP_1 PUSH32). We need it
// for v2 (prl1z…) recipients, which @scure/btc-signer's addOutputAddress refuses
// ("Unknown witness program"). Inputs/change still go through the v1-only path —
// the wallet only ever spends its own Taproot coins.
// Re-validates network AND output type on its own, so a caller that skipped
// the UI check still cannot build a payment to another chain or to an
// anyone-can-spend witness version.
function recipientOutputScript(address: string, network: PearlNetwork): Uint8Array {
  const d = decodeBech32m(address);
  if (!d) throw new Error('Invalid Pearl address');
  if (d.hrp !== getNetwork(network).hrp) {
    throw new Error(`That address belongs to a different network (${d.hrp}), not Pearl ${network}.`);
  }
  const v = d.witnessVersion;
  const prog = d.witnessProgram;
  if (!isPayableWitnessProgram(v, prog.length)) {
    throw new Error(`Refusing to pay an unsupported address type (witness v${v}, ${prog.length}-byte program). Funds sent there could be lost or taken.`);
  }
  const s = new Uint8Array(2 + prog.length);
  s[0] = 0x50 + v;        // OP_1 … OP_16
  s[1] = prog.length;     // direct push (program ≤ 40 ≤ 75 bytes)
  s.set(prog, 2);
  return s;
}

function witnessVersionOf(address: string): number {
  return decodeBech32m(address)?.witnessVersion ?? 1;
}

// Coins that carry .pns names, as "txid:vout". Spending one outside a name
// transfer moves the name to wherever its first sat lands, so ordinary sends,
// consolidations and fee funding all leave them alone.
export type ProtectedOutpoints = ReadonlySet<string>;
const keyOf = (u: { txid: string; vout: number }) => `${u.txid.toLowerCase()}:${u.vout}`;
function withoutProtected(utxos: ScannedUtxo[], prot?: ProtectedOutpoints): ScannedUtxo[] {
  if (!prot?.size) return utxos;
  const keys = new Set([...prot].map(key => key.toLowerCase()));
  return utxos.filter(u => !keys.has(keyOf(u)));
}

function estVbytes(nIn: number, nOut: number): bigint {
  return BigInt(58 * nIn + 43 * nOut + 11);
}

// Pearl's default mempool accepts at most 100,000 vbytes. Use the actual
// serialized key-path shape for this limit, preserving the conservative fee
// estimate above. Each input has an empty scriptSig and a 64-byte DEFAULT
// Schnorr signature; marker/flag and CompactSize counts must be included.
function standardSizeError(nIn: number, nOut: number): string | undefined {
  const compactSize = (count: number) => count < 253 ? 1 : count <= 0xffff ? 3 : count <= 0xffffffff ? 5 : 9;
  const base = 8 + compactSize(nIn) + 41 * nIn + compactSize(nOut) + 43 * nOut;
  const vbytes = base + Math.ceil((nIn > 0 ? 2 + 66 * nIn : 0) / 4);
  if (vbytes > 100_000) {
    return "This transaction exceeds Pearl's standard size limit. Send a smaller amount to use fewer inputs.";
  }
}

function assertFeeRate(feeRate: bigint) {
  if (typeof feeRate !== 'bigint' || feeRate < 1n || feeRate > MAX_FEE_RATE) {
    throw new Error(`Fee rate must be between 1 and ${MAX_FEE_RATE} grains/vB.`);
  }
}

function feeSafetyError(fee: bigint, vbytes: bigint): string | undefined {
  if (fee < 0n || fee > vbytes * MAX_FEE_RATE + DUST_LIMIT || fee > MAX_NETWORK_FEE) {
    return 'The network fee exceeds the wallet safety limit. Lower the fee rate and retry.';
  }
}

function assertSafeFee(fee: bigint, vbytes: bigint) {
  const error = feeSafetyError(fee, vbytes);
  if (error) throw new Error(error);
}

function assertUniqueInputs(utxos: ScannedUtxo[]) {
  const seen = new Set<string>();
  for (const u of utxos) {
    if (typeof u.value !== 'bigint' || u.value <= 0n) throw new Error('Invalid input amount. Refresh the wallet and retry.');
    if (!/^[a-fA-F0-9]{64}$/.test(u.txid) || !Number.isInteger(u.vout) || u.vout < 0 || u.vout > 0xffffffff) {
      throw new Error('Invalid input outpoint. Refresh the wallet and retry.');
    }
    const key = keyOf(u);
    if (seen.has(key)) throw new Error('Duplicate input returned by the explorer. Refresh the wallet and retry.');
    seen.add(key);
  }
}

function selectUtxos(
  utxos: ScannedUtxo[], amount: bigint, feeRate: bigint,
): { picked: ScannedUtxo[]; total: bigint; estFee: bigint } {
  const sorted = [...utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const picked: ScannedUtxo[] = [];
  let total = 0n;
  for (const u of sorted) {
    picked.push(u);
    total += u.value;
    const estFee = estVbytes(picked.length, 2) * feeRate;
    if (total >= amount + estFee) return { picked, total, estFee };
  }
  return { picked, total, estFee: estVbytes(picked.length, 2) * feeRate };
}

// MAX means the largest recipient amount. Adding a coin worth less than its
// input fee would reduce that amount, so keep the best descending-value prefix.
function selectMaxUtxos(utxos: ScannedUtxo[], feeRate: bigint): { picked: ScannedUtxo[]; total: bigint; estFee: bigint } {
  const sorted = [...utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  let total = 0n, bestTotal = 0n, bestAmount = 0n, bestCount = 0;
  for (let i = 0; i < sorted.length; i++) {
    total += sorted[i].value;
    const amount = total - estVbytes(i + 1, 1) * feeRate;
    if (amount > bestAmount) { bestAmount = amount; bestTotal = total; bestCount = i + 1; }
  }
  return { picked: sorted.slice(0, bestCount), total: bestTotal, estFee: estVbytes(bestCount, 1) * feeRate };
}

const ADDR_SEARCH_MAX = 500;

// A signer resolves the private key that OWNS a given UTXO. Two implementations:
// an HD account (derives within one BIP-86 sub-tree) and an imported single key.
// In both cases the address is verified to belong to the account before a key is
// returned — never sign for a coin we can't prove we control.
export interface AccountSigner {
  keyForUtxo(u: { address: string; chain: 0 | 1; index: number }): Uint8Array;
}

// HD account signer. We can't blindly trust u.chain/u.index — if the send flow
// tagged a UTXO with the wrong path the derived key won't match the Taproot
// output and btc-signer emits an EMPTY witness (node rejects: "witness program
// passed empty witness"). So we verify the recorded path derives this exact
// address, and if not, find the real path by matching across both chains.
export function hdSigner(hd: HDKey, network: PearlNetwork, deriv?: Derivation): AccountSigner {
  const d = deriv ?? defaultDerivation(network);
  return {
    keyForUtxo(u) {
      if (deriveAddress(hd, u.chain, u.index, network, d).address === u.address) {
        return getPrivateKey(hd, u.chain, u.index, network, d);
      }
      for (const chain of [0, 1] as const) {
        for (let i = 0; i < ADDR_SEARCH_MAX; i++) {
          if (deriveAddress(hd, chain, i, network, d).address === u.address) {
            return getPrivateKey(hd, chain, i, network, d);
          }
        }
      }
      throw new Error(`No signing key found for UTXO address ${u.address} — cannot sign.`);
    },
  };
}

// Imported single-key signer. Controls exactly one address.
export function importedSigner(priv: Uint8Array, network: PearlNetwork): AccountSigner {
  const owned = privateKeyToAddress(priv, network);
  return {
    keyForUtxo(u) {
      if (u.address !== owned) {
        throw new Error(`Imported account does not control ${u.address} — cannot sign.`);
      }
      return priv;
    },
  };
}

interface PreparedInput { u: ScannedUtxo; priv: Uint8Array; xOnly: Uint8Array; script: Uint8Array; }

// Pre-sign verification (hardening). BEFORE building/signing anything, prove every
// selected input is (a) a well-formed Pearl Taproot address and (b) actually OWNED
// by this account (the signer returns a key only after verifying ownership). The
// locking script is ALWAYS re-derived locally from that address — we never trust a
// script that came from the backend. Fail fast rather than spend a coin we don't
// control or hand the node an unsignable transaction.
function prepareInputs(signer: AccountSigner, utxos: ScannedUtxo[]): PreparedInput[] {
  return utxos.map((u) => {
    const script = addressToTaprootScript(u.address);   // validates the address
    const priv   = signer.keyForUtxo(u);                 // asserts we own it (throws if not)
    const xOnly  = toXOnlyPubkey(secp256k1.getPublicKey(priv, true));
    return { u, priv, xOnly, script };
  });
}

function signWithAll(tx: btc.Transaction, keys: Uint8Array[]) {
  for (const k of keys) {
    try { tx.sign(k); } catch { /* key matches no input — skip */ }
  }
}

// Safety net: never broadcast a transaction with an unsigned (empty-witness)
// input. Catches any residual key/path mismatch before it hits the node.
function assertAllSigned(tx: btc.Transaction) {
  for (let i = 0; i < tx.inputsLength; i++) {
    const w = tx.getInput(i).finalScriptWitness;
    if (!w || w.length === 0) {
      throw new Error(`Could not sign input #${i} — refusing to broadcast an unsigned transaction.`);
    }
  }
}

export interface SendArgs {
  signer:       AccountSigner;
  network:      PearlNetwork;
  recipient:    string;
  amount:       bigint;
  utxos:        ScannedUtxo[];
  feeRate:      bigint;
  changeAddress: string;
  protectedOutpoints?: ProtectedOutpoints;
  sendMax?: boolean;
  maxTotalDebitAtoms?: bigint;
  approvedFee?: bigint;
}

export interface SendQuote {
  ok: boolean;
  amount: bigint;
  fee: bigint;
  change: bigint;
  inputCount: number;
  spendable: bigint;
  shortfall: bigint;
  error?: string;
}

type QuoteArgs = Pick<SendArgs, 'utxos' | 'protectedOutpoints' | 'amount' | 'feeRate' | 'sendMax'>;

// Shared by the review screen and signer: a multi-input send or MAX must not
// show a one-input fee and then sign a different payment. Existing ordinary
// selection remains unchanged to preserve the upstream golden transactions.
function planSend(args: QuoteArgs): SendQuote & { picked: ScannedUtxo[] } {
  assertFeeRate(args.feeRate);
  const spendable = withoutProtected(args.utxos, args.protectedOutpoints);
  assertUniqueInputs(spendable);
  const balance = spendable.reduce((sum, u) => sum + u.value, 0n);
  const selection = args.sendMax
    ? selectMaxUtxos(spendable, args.feeRate)
    : selectUtxos(spendable, args.amount, args.feeRate);
  const { picked, total, estFee } = selection;
  const amount = args.sendMax ? total - estFee : args.amount;
  const shortfall = total < amount + estFee ? amount + estFee - total : 0n;
  let change = total - amount - estFee;
  let fee = estFee;
  if (shortfall === 0n && change <= DUST_LIMIT) { fee = total - amount; change = 0n; }
  const outputCount = change > 0n ? 2 : 1;
  const error = standardSizeError(picked.length, outputCount) ?? feeSafetyError(fee, estVbytes(picked.length, outputCount));
  const ok = picked.length > 0 && amount > DUST_LIMIT && shortfall === 0n && !error;
  return {
    ok, amount: amount > 0n ? amount : 0n, fee,
    change: change > 0n ? change : 0n, inputCount: picked.length,
    spendable: balance, shortfall, error, picked,
  };
}

export function quoteSend(args: QuoteArgs): SendQuote {
  const { picked: _picked, ...quote } = planSend(args);
  return quote;
}

// Website payments carry an exact amount, not a sendMax instruction. Reserve
// the same recipient+change output fee as ordinary selection, then run that
// exact payment through the shared planner. Do not reuse the one-output MAX
// quote from the wallet's Send screen: that amount cannot fund this fee.
export function quoteFixedAmountMax(args: Pick<QuoteArgs, 'utxos' | 'protectedOutpoints' | 'feeRate'>): SendQuote {
  assertFeeRate(args.feeRate);
  const spendable = withoutProtected(args.utxos, args.protectedOutpoints);
  assertUniqueInputs(spendable);
  const sorted = [...spendable].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  let total = 0n, amount = 0n;
  // Match ordinary selection's descending prefixes. Uneconomic small coins
  // must not reduce the maximum obtainable from an earlier, cheaper prefix.
  for (let i = 0; i < sorted.length; i++) {
    total += sorted[i].value;
    const candidate = total - estVbytes(i + 1, 2) * args.feeRate;
    if (candidate > amount) amount = candidate;
  }
  return quoteSend({ utxos: args.utxos, protectedOutpoints: args.protectedOutpoints, feeRate: args.feeRate, amount });
}

export function buildAndSignTx(args: SendArgs): BuiltTx {
  const NET = args.network === 'testnet' ? PEARL_NET_TESTNET : PEARL_NET;
  const held = args.utxos.length - withoutProtected(args.utxos, args.protectedOutpoints).length;
  const plan = planSend(args);
  if (plan.error) throw new Error(plan.error);
  if (!plan.ok) {
    if (args.sendMax) throw new Error('Balance too small to cover the network fee.');
    if (args.amount <= DUST_LIMIT) throw new Error(`Amount must exceed ${DUST_LIMIT} grains.`);
    throw new Error(`Insufficient funds: need ${plan.shortfall} more grains (incl. fee).`
      + (held > 0 ? ` ${held} coin${held === 1 ? '' : 's'} holding .pns names ${held === 1 ? 'is' : 'are'} not used for sends.` : ''));
  }
  const { picked, amount, change: changeGrains, fee: feeGrains } = plan;
  // A changed fee or coin selection must fail before deriving input keys/signing.
  assertTotalDebit(amount, feeGrains, args.maxTotalDebitAtoms, args.approvedFee);
  const prepared = prepareInputs(args.signer, picked);   // verify ALL before building
  // A non-v1 recipient (e.g. v2 prl1z…) is a "non-standard" output to btc-signer,
  // so it must be built by hand and the standard-output guard relaxed — but ONLY
  // because of the recipient; inputs and change remain strict v1 Taproot.
  // Validate the recipient before building anything: throws on a foreign
  // network or an unpayable witness version.
  const recipScript = recipientOutputScript(args.recipient, args.network);
  const recipVer = witnessVersionOf(args.recipient);
  // Only P2MR (v2) is unknown to btc-signer, so relax its guard for v2 alone.
  const tx = new btc.Transaction({ allowUnknownOutputs: recipVer === 2 });
  const keyByHex = new Map<string, Uint8Array>();
  for (const p of prepared) {
    keyByHex.set(bytesToHex(p.priv), p.priv);
    tx.addInput({
      txid: p.u.txid, index: p.u.vout,
      witnessUtxo: { script: p.script, amount: p.u.value },
      tapInternalKey: p.xOnly,
    });
  }
  if (recipVer === 1) tx.addOutputAddress(args.recipient, amount, NET);
  else                tx.addOutput({ script: recipScript, amount });
  if (changeGrains > 0n) tx.addOutputAddress(args.changeAddress, changeGrains, NET);

  if (tx.getOutput(0).amount !== amount || tx.fee !== feeGrains) throw new Error('The prepared transaction differs from the approved payment.');
  assertTotalDebit(tx.getOutput(0).amount!, tx.fee, args.maxTotalDebitAtoms, args.approvedFee);
  signWithAll(tx, [...keyByHex.values()]);
  tx.finalize();
  assertAllSigned(tx);

  return {
    hex:          bytesToHex(tx.extract()),
    txid:         tx.id,
    feeGrains,
    changeGrains,
    inputCount:   picked.length,
  };
}

export interface PnsTransferArgs {
  signer:          AccountSigner;
  network:         PearlNetwork;
  recipient:       string;        // resolved Pearl address of the new owner
  inscriptionUtxo: ScannedUtxo;   // the coin that carries the name — MUST be spent
  feeUtxos:        ScannedUtxo[]; // other spendable coins (excludes the inscription) for fees
  feeRate:         bigint;
  changeAddress:   string;
  protectedOutpoints?: ProtectedOutpoints; // other names' coins, never used as fee
}

// A name coin this large is mostly ordinary value. Moving all of it to the
// recipient would give away that value, so it is split: a small carrier with
// the name goes to the recipient, the rest comes back as change.
const FAT_NAME_COIN = 100_000n;
const NAME_CARRIER  = 10_000n;

// Transfer a .pns name by spending its inscription UTXO to the recipient.
//
// The name rides the first sat of its coin (sat-flow, as the pearlchain.live
// indexer applies it). The name coin is always input 0, so that sat lands in
// output 0, which is always the recipient:
//   • ordinary coin      → recipient@0 (the coin minus fee)
//   • large coin         → recipient@0 small carrier, change@1 the rest
//   • coin below the fee → recipient@0 carrier, change@1, extra fee coins added
export function buildPnsTransferTx(args: PnsTransferArgs): BuiltTx {
  assertFeeRate(args.feeRate);
  // Names are held and indexed on Taproot outputs. Refuse anything else with a
  // clear message instead of btc-signer's "Unknown witness program".
  {
    const d = decodeBech32m(args.recipient);
    if (!d || d.hrp !== getNetwork(args.network).hrp) {
      throw new Error('Enter a Pearl address on this network to receive the name.');
    }
    if (d.witnessVersion !== 1 || d.witnessProgram.length !== 32) {
      throw new Error('Names can only be sent to a standard Pearl address (prl1p…).');
    }
  }
  const NET = args.network === 'testnet' ? PEARL_NET_TESTNET : PEARL_NET;
  const insc = args.inscriptionUtxo;
  assertUniqueInputs([insc]);

  // Prefer the simplest, cheapest shape: spend ONLY the inscription coin into a
  // single output to the recipient. Works whenever the coin covers fee + dust.
  const feeSplit = estVbytes(1, 2) * args.feeRate;
  const splitChange = insc.value - NAME_CARRIER - feeSplit;
  if (insc.value >= FAT_NAME_COIN && splitChange > DUST_LIMIT) {
    assertSafeFee(feeSplit, estVbytes(1, 2));
    const [p] = prepareInputs(args.signer, [insc]);
    const tx = new btc.Transaction({ allowUnknownOutputs: false });
    tx.addInput({ txid: p.u.txid, index: p.u.vout, witnessUtxo: { script: p.script, amount: p.u.value }, tapInternalKey: p.xOnly });
    tx.addOutputAddress(args.recipient, NAME_CARRIER, NET);    // vout[0] = recipient, carries the name's sat
    tx.addOutputAddress(args.changeAddress, splitChange, NET); // vout[1] = the rest back to the sender
    signWithAll(tx, [p.priv]);
    tx.finalize();
    assertAllSigned(tx);
    return { hex: bytesToHex(tx.extract()), txid: tx.id, feeGrains: feeSplit, changeGrains: splitChange, inputCount: 1 };
  }

  const feeSingle = estVbytes(1, 1) * args.feeRate;
  if (insc.value - feeSingle > DUST_LIMIT) {
    assertSafeFee(feeSingle, estVbytes(1, 1));
    const prepared = prepareInputs(args.signer, [insc]);
    const tx = new btc.Transaction({ allowUnknownOutputs: false });
    const keyByHex = new Map<string, Uint8Array>();
    for (const p of prepared) {
      keyByHex.set(bytesToHex(p.priv), p.priv);
      tx.addInput({ txid: p.u.txid, index: p.u.vout, witnessUtxo: { script: p.script, amount: p.u.value }, tapInternalKey: p.xOnly });
    }
    tx.addOutputAddress(args.recipient, insc.value - feeSingle, NET);  // vout[0] = recipient
    signWithAll(tx, [...keyByHex.values()]);
    tx.finalize();
    assertAllSigned(tx);
    return { hex: bytesToHex(tx.extract()), txid: tx.id, feeGrains: feeSingle, changeGrains: 0n, inputCount: 1 };
  }

  // Inscription coin is too small to also pay the fee → pull in extra coins and
  // emit recipient@0 + change@1. The inscription coin is ALWAYS input 0, so the
  // name's first sat lands in output 0, the recipient. This is the sat-flow
  // rule the pearlchain.live indexer applies. (1.3.1 emitted change@0 +
  // recipient@1 for an older indexer rule, which under sat-flow sends the name
  // back to the sender's own change address.) The recipient gets a minimal
  // carrier amount; the name follows the sat, not the value.
  const RECIP_AMT = DUST_LIMIT + 1n;
  const others = withoutProtected(args.feeUtxos, args.protectedOutpoints)
    .filter(u => !(u.txid === insc.txid && u.vout === insc.vout));
  const picked: ScannedUtxo[] = [insc];
  let total = insc.value;
  let fee = estVbytes(picked.length, 2) * args.feeRate;
  for (const u of [...others].sort((a, b) => (b.value > a.value ? 1 : -1))) {
    if (total >= RECIP_AMT + fee + DUST_LIMIT) break;       // enough for recipient + fee + a non-dust change
    picked.push(u);
    total += u.value;
    fee = estVbytes(picked.length, 2) * args.feeRate;
  }
  if (total < RECIP_AMT + fee) {
    throw new Error('Not enough balance to cover the transfer fee. Add a little PEARL to this account and retry.');
  }
  assertUniqueInputs(picked);
  assertSafeFee(fee, estVbytes(picked.length, 2));
  const sizeError = standardSizeError(picked.length, total - RECIP_AMT - fee > DUST_LIMIT ? 2 : 1);
  if (sizeError) throw new Error(sizeError);

  const prepared = prepareInputs(args.signer, picked);
  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  const keyByHex = new Map<string, Uint8Array>();
  for (const p of prepared) {
    keyByHex.set(bytesToHex(p.priv), p.priv);
    tx.addInput({ txid: p.u.txid, index: p.u.vout, witnessUtxo: { script: p.script, amount: p.u.value }, tapInternalKey: p.xOnly });
  }

  let change = total - RECIP_AMT - fee;
  const feeGrains = fee;
  if (change > DUST_LIMIT) {
    tx.addOutputAddress(args.recipient, RECIP_AMT, NET);      // vout[0] = recipient, carries the name's sat
    tx.addOutputAddress(args.changeAddress, change, NET);     // vout[1] = change (sender)
  } else {
    // No room for change → single output to recipient (vout[0]); fee absorbs the rest.
    tx.addOutputAddress(args.recipient, total - feeGrains, NET);
    change = 0n;
  }

  signWithAll(tx, [...keyByHex.values()]);
  tx.finalize();
  assertAllSigned(tx);
  return { hex: bytesToHex(tx.extract()), txid: tx.id, feeGrains, changeGrains: change, inputCount: picked.length };
}

export interface CompoundArgs {
  signer:      AccountSigner;
  network:     PearlNetwork;
  utxos:       ScannedUtxo[];   // everything spendable
  destination: string;          // where to consolidate (typically receive #0)
  feeRate:     bigint;
  protectedOutpoints?: ProtectedOutpoints; // name coins, left where they are
}

// Sweep ALL UTXOs into a single output at `destination`. Useful when funds
// are scattered across many derived addresses (e.g. change from a wallet
// that rotates addresses). One network fee, one input set, one output.
export function buildCompoundTx(args: CompoundArgs): BuiltTx {
  assertFeeRate(args.feeRate);
  const NET = args.network === 'testnet' ? PEARL_NET_TESTNET : PEARL_NET;
  const utxos = withoutProtected(args.utxos, args.protectedOutpoints);
  assertUniqueInputs(utxos);

  if (utxos.length === 0) throw new Error('Nothing to compound.');
  if (utxos.length === 1) throw new Error('Only one UTXO — nothing to consolidate.');

  const total  = utxos.reduce((s, u) => s + u.value, 0n);
  const fee    = estVbytes(utxos.length, 1) * args.feeRate;
  const output = total - fee;
  assertSafeFee(fee, estVbytes(utxos.length, 1));
  const sizeError = standardSizeError(utxos.length, 1);
  if (sizeError) throw new Error(sizeError);
  if (output <= DUST_LIMIT) {
    throw new Error('Balance too small to cover the consolidation fee.');
  }

  const prepared = prepareInputs(args.signer, utxos);   // verify ALL before building
  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  const keyByHex = new Map<string, Uint8Array>();

  for (const p of prepared) {
    keyByHex.set(bytesToHex(p.priv), p.priv);
    tx.addInput({
      txid: p.u.txid, index: p.u.vout,
      witnessUtxo: { script: p.script, amount: p.u.value },
      tapInternalKey: p.xOnly,
    });
  }

  tx.addOutputAddress(args.destination, output, NET);

  signWithAll(tx, [...keyByHex.values()]);
  tx.finalize();
  assertAllSigned(tx);

  return {
    hex:          bytesToHex(tx.extract()),
    txid:         tx.id,
    feeGrains:    fee,
    changeGrains: 0n,
    inputCount:   utxos.length,
  };
}
