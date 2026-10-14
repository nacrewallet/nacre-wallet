# Pearl transaction fees in Nacre Wallet

Research checked on 7 October 2026. Network observations below are dated examples, not fixed prices. Code implementing the wallet policy is in `src/pearl/fee-policy.ts`; transaction selection, quoting and signing share `src/pearl/transaction.ts`.

## Amounts, rates and three different meanings of “fee”

One PRL is 100,000,000 grains. Transaction amounts and final fees use integer grains. A fee rate multiplies transaction virtual size, rather than the PRL amount being transferred. Consequently, spending many small UTXOs usually costs more than spending one large UTXO of the same total value.

| Value | Meaning and unit |
| --- | --- |
| Transaction fee | Input value minus all output values, in grains |
| `recommendedFee` | Explorer recommendation, in grains/vB |
| `mempoolMinFee` | Explorer-reported mempool floor, in grains/vB |
| Node/explorer `relayfee` | Configured relay policy, in PRL per 1,000 virtual bytes |
| Blockbook `estimatefee/2` | Estimated rate for a two-block target, in PRL/kB |

The explorer's [published API documentation](https://pearlchain.live/api-docs) defines grain amounts. Its [shipped application code](https://pearlchain.live/_next/static/chunks/app/page-1287246101f06161.js) displays `recommendedFee` and `mempoolMinFee` directly as “sat/vB”, and converts `relayfee` with `1e8 / 1000`. Here the atomic unit is a Pearl grain. A PRL/kB rate therefore becomes grains/vB by multiplying by 100,000.

A relay floor is an admission rule, a fee recommendation is an estimator's prediction, and a confirmed transaction's fee is historical evidence. They are not interchangeable. Neither a current estimate nor a higher fee guarantees a confirmation deadline.

## Source priority and missing estimates

For the default `https://pearlchain.live` backend, the source order is:

1. Keep the primary explorer's valid `recommendedFee`, when present. Do not consult the secondary estimator to replace it with a cheaper rate.
2. If the primary recommendation is absent/null or the primary service is unavailable, query `https://blockbook.pearlresearch.ai/api/v2/estimatefee/2` and its `/api/v2/` status endpoint. Use this estimate only when status identifies `backend.chain: 'mainnet'` and `blockbook.inSync: true`. Convert the decimal PRL/kB result precisely and round upwards to grains/vB. The secondary host is already included in the wallet's allowed backends; this lookup sends no address, balance or account information.
3. Only when neither source supplies an estimate, use the explicit 2-grain/vB wallet fallback, subject to the fee floors below.

The secondary estimate replaces only the missing recommendation. Any `relayfee` or `mempoolMinFee` supplied by the primary explorer is retained and still validated. An explicit malformed or excessive recommendation from either source blocks the quote; it never becomes a cheaper fallback. Blockbook's recognized `'-1'` unavailable-estimate sentinel and a null result mean no estimate. Custom Pearlchain URLs are not automatically supplemented with the fixed mainnet service; configured Blockbook mode uses its own selected backend.

The shared policy follows these rules:

1. Validate all supplied rate and floor values. Wrong types, non-finite values, negative floors, non-positive recommendations and values exceeding the safety ceiling block the quote.
2. Use a valid current recommendation, rounding upwards to integer grains/vB.
3. Respect the configured relay floor, with a conservative wallet minimum of 1 grain/vB. Stay strictly above a positive published mempool floor: a fractional floor is rounded upwards; an integer floor requires the next integer rate.
4. Only when the recommendation is absent/null after the available sources have been checked, use the explicit fallback of 2 grains/vB, raised to the applicable floors when necessary.

The 2-grain fallback is a Nacre estimate: twice the reference node's documented default relay rate. It is not an observed recommendation or a promise of prompt inclusion. The UI and public balance contract retain `source: 'fallback'` so this assumption is visible. `source: 'network'` means a live estimator supplied a usable recommendation; it does not mean a transaction is guaranteed to be accepted or mined.

Priority multipliers are rounded upwards, cannot go below the applicable floor, and cannot exceed the 20,000-grain/vB wallet ceiling. An excessive selection is rejected instead of silently clamped. Null stats can support only the explicit fallback; they never substitute for a successful UTXO scan, current account validation or verified `.pns` coin protection.

## What the public node and APIs actually showed

On 7 October 2026, [Pearlchain stats](https://pearlchain.live/api/explorer/stats) returned `recommendedFee: null`, `mempoolMinFee: null` and `relayfee: 0.00001`. That relay setting converts to 1 grain/vB.

During the same investigation, the existing [Pearl Blockbook estimate endpoint](https://blockbook.pearlresearch.ai/api/v2/estimatefee/2) returned `{"result":"0.00783243"}`: 783.243 grains/vB, rounded upwards to **784 grains/vB**. Its status endpoint reported mainnet and a synchronized indexer. This is why the documented 2-grain fallback must not replace an available estimator.

A separate read-only query to the [documented public Pearlchain RPC service](https://pearlchain.live/rpc) returned `estimatefee(2) = 0.007163788647900323` PRL/kB, or approximately 716.379 grains/vB. Different nodes observe different transaction samples. `estimatesmartfee` returned method-not-found. This observation suggests a possible estimator compatibility issue, but the private explorer backend was not available to establish the cause of its null recommendation. No RPC domain is needed by the wallet's Blockbook fallback.

The reference node's [`EstimateFee` implementation](https://github.com/pearl-research-labs/pearl/blob/2f8b770cac8f8b74be05c1fc51c2baeb76ce0701/node/mempool/estimatefee.go) samples transactions it observed and measures their virtual size. Its return type and conversion implementation establish PRL/kB units. Some adjacent comments/help text incorrectly say grains/kB; follow the actual `PrlPerKilobyte` conversion, not that stale wording. The estimator can be unavailable when it lacks enough observations. A recognized estimator-unavailable sentinel is handled at the adapter boundary; arbitrary negative recommendations are invalid.

## Relay, mempool pressure and inclusion

The reference node's [relay policy](https://github.com/pearl-research-labs/pearl/blob/2f8b770cac8f8b74be05c1fc51c2baeb76ce0701/node/mempool/policy.go) defaults to 1,000 grains per 1,000 bytes. Its [configuration](https://github.com/pearl-research-labs/pearl/blob/2f8b770cac8f8b74be05c1fc51c2baeb76ce0701/node/config.go) permits overriding this setting. The mempool calls relay validation using transaction virtual size.

When the mempool is full, the [node implementation](https://github.com/pearl-research-labs/pearl/blob/2f8b770cac8f8b74be05c1fc51c2baeb76ce0701/node/mempool/mempool.go) evicts low-rate transactions and may reject new transactions at or below its last eviction rate. Its [`getmempoolinfo` result](https://github.com/pearl-research-labs/pearl/blob/2f8b770cac8f8b74be05c1fc51c2baeb76ce0701/node/btcjson/chainsvrresults.go) exposes size, bytes and capacity, not this internal floor. A missing published mempool floor therefore does not prove there is no admission pressure. Block templates [prioritize fee rate](https://github.com/pearl-research-labs/pearl/blob/2f8b770cac8f8b74be05c1fc51c2baeb76ce0701/node/mining/mining.go), subject to dependencies and other validity constraints.

## Quoting ordinary sends and MAX

Nacre preserves the community wallet's conservative native transaction budget:

```text
estimated virtual bytes = 58 × input count + 43 × output count + 11
base fee in grains      = estimated virtual bytes × selected grains/vB
```

An ordinary send reserves a recipient output and a change output. Remaining change of 546 grains or less is included in the final fee instead of creating a dust output. Native wallet MAX uses one recipient output. Website MAX must remain an ordinary fixed-amount payment, so it uses the matching ordinary-send quote, including its output budget. It does not expose the total balance as spendable MAX.

The planner excludes protected name coins and inputs that add no net spendable value. Quotes and signing use the same selected inputs, amount, change and final fee. Large input sets must also meet the node's 100,000-vB standard-size limit; an exact native size calculation is used for that bound. The conservative fee budget remains separate from exact serialized virtual size.

A public [confirmed example](https://pearlchain.live/api/explorer/tx/0884f1bb9cfd4acda58fe87db2b1f47d937bf2800c7bafd2ce3cd51ee8a32ec4) paid 310 grains (0.00000310 PRL), with actual virtual size 154 vB. For one input and two outputs the conservative budget is 155 vB, and `155 × 2 = 310`. Its actual effective rate was about 2.013 grains/vB. This explains that transaction, not the current network recommendation. The upstream [community wallet source](https://github.com/kaspador/pearl-extension/blob/c916752d09eb729de188efdd37ac64e2e26e27d6/src/screens/Send.tsx) used a 1-grain/vB missing-estimate default; Nacre's explicit fallback and second estimator are independent wallet policy.

## Approval and safety boundaries

The selected fee is quoted in grains before signing. The signer enforces the rate ceiling, the 10-PRL total fee ceiling, the approved final fee, and any website `maxTotalDebitAtoms` budget against **amount plus final fee**. Refreshes retain account/network/lock checks and `.pns` protection. A changed or excessive fee must result in another review or a rejected request; it must not be paid silently from the user's remaining balance.

Unit tests cover malformed/absent estimates, source provenance, precise unit conversion, upward rounding, relay and mempool floors, priority ceilings and fallback behavior. Integration tests cover both balance paths and approval preparation; transaction tests use disposable synthetic keys and no network broadcast.
