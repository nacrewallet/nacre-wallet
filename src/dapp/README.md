# Nacre website connector

The connector supports Chromium 127+ and native PRL on Pearl mainnet.
Production injection is limited to `https://nacre.finance`.
The Firefox package disables website injection and retains native wallet features.

```ts
window.nacre.isNacre === true;
await window.nacre.request({ method: 'connect' }); // string[]: one approved address
await window.nacre.request({ method: 'getAccounts' }); // string[] or []
await window.nacre.request({ method: 'getBalance' }); // fresh permitted snapshot, or null
await window.nacre.request({ method: 'getBalance', params: { refresh: true } }); // authorized fresh read; no popup
await window.nacre.request({ method: 'disconnect' }); // null
await window.nacre.request({
  method: 'sendTransaction',
  params: { to: 'prl1…', amount: '1.00000001', orderId: 'unique-order-id' },
}); // { txid: string }; submitted, not necessarily confirmed
```

Injection dispatches `nacre#initialized`. The provider has no arbitrary signing, seed,
private-key export, arbitrary RPC, fee override or network-switch method. Amounts
are exact PRL decimal strings with at most eight fractional digits. Unsupported
fields, foreign addresses and dust payments are rejected. The Nacre bridge is a
separate service. A payment request can transfer real PRL only after explicit
wallet approval; this API does not implement a cross-chain conversion or grant
permission for future payments.

Both connection and payment open the native toolbar popup in the requesting
browser window and require user approval. Chrome anchors this popup to the
extension icon, without a separate window/title bar. If automatic opening is
refused, a badge signals the pending request; click the icon to resume it.
The payment review is immutable, refreshes UTXOs, fails closed when
`.pns` protection cannot be verified, and uses the same coin-selection/fee plan
as signing. Changed fees require another review. Mainnet submission uses the
fixed Pearlchain broadcaster; a website cannot choose the backend.

The worker authenticates the browser-supplied extension ID, site origin, top
frame, tab and document. Privileged approval messages additionally require the
browser-reported POPUP context, exact document ID and fixed popup URL in the
requesting browser window; a tab with the same URL cannot approve. No page-
supplied origin is trusted. Local/session storage is restricted to trusted
extension contexts. Production has no localhost injection or broad website
permissions; Vite development additionally permits explicit localhost ports
3000 and 5173 in the relay and worker.

Chromium reports an action popup's context window ID as `-1`. The worker first
verifies the popup document, then resolves the last active browser window through
Chrome's windows API; the broker still binds approval to the requesting window
and exact popup document. Neither a website-supplied window ID nor an extension
tab is accepted as authority. See Chromium's `RuntimeGetContextsInteractiveApiTest.GetPopupContext`.

The parent window's `focused` flag is not an authorization check: Chromium can
report it as false while the native popup itself owns focus. The live popup
identity and exact requesting-window/document binding remain enforced.

A connection shares the selected account's primary public address (HD receive
index 0, or the imported key's public address). It is prepared locally and
revalidated on approval, without explorer, fee, price, history or PNS queries.
Payments still require a fresh spendable-coin scan and all existing protections.

`getBalance`, `balanceOnConnect`, `totalDebitCap`, and `feeEstimates` are
advertised in `window.nacre.features`. Fee metadata, when supplied, is a paired
rate and source; `fallback` identifies wallet policy rather than a live network
recommendation. It is not a guaranteed final transaction fee.
The connection prompt explicitly includes public address and account-balance access.
Existing address-only grants are not upgraded silently: a fresh explicit `connect`
approval is required once. A passive call without parameters (or with
`{ refresh: false }`) returns the last fresh permitted snapshot, or `null`, without
a popup or network request. `{ refresh: true }` updates the authorized full account
without another prompt, only while the selected account is unlocked. A missing
scope, changed account or locked wallet produces `4100`; polling never opens consent.
Concurrent reads for one origin share one scan and do not consume approval records.

On explicit connection approval, the popup derives a public-only BIP86 account
node (or the imported account public address), bound to account/network/backend
metadata. This scan capability stays in trusted extension-session storage and is
never sent to the website. The worker scans receive and change chains with the
same complete-gap validation, PNS protection and fixed-payment MAX planner.
No mnemonic or signing key is restored in the worker. Disconnect, lock, account
changes, reconnect and payment submission invalidate in-flight reads as well as
cached snapshots. Every payment still requires its separate toolbar approval.

```ts
type Balance = {
  address: string; // the public address previously approved for this connection
  network: 'pearl:mainnet';
  total: string;
  spendable: string | null;
  maxSend: string | null;
  estimatedMaxFee: string | null;
  feeRate?: string | null; // integer grains per virtual byte
  feeSource?: 'network' | 'fallback' | null;
  updatedAt: number; // Unix milliseconds
  namesVerified: boolean;
};
```

All four amounts use **integer grain strings**: 100,000,000 grains = 1 PRL.
Use `BigInt`, never floating-point conversion, for arithmetic. `total` covers the
whole selected HD account, including receive and change addresses, or the single
address of an imported key. `spendable` excludes protected `.pns` coins and is
before network fees. Unknown name protection makes `spendable`, `maxSend` and
`estimatedMaxFee` null; an unavailable fee recommendation leaves the last two
null. An unavailable or incomplete account scan is an error, not a zero balance.

Website `maxSend` uses the same fixed-amount planner as `sendTransaction`, reserving
its conservative **recipient+change output** fee after protected coins are removed.
The returned amount is re-quoted as an ordinary fixed payment; `estimatedMaxFee`
is that quote's actual fee, including any discarded dust. This differs from the
wallet Send screen's one-output `sendMax: true` flow. Uneconomic small coins need
not be selected. A successful empty/dust-only scan can report zero for MAX and its
fee. These are estimates, not a reserved balance or permission to pay: changed
UTXOs, name protection or fee rates still require a fresh review and can make the
previous amount unaffordable. The exact requested amount is never silently reduced.
This connector does not add a site-triggered MAX transaction method.

Public snapshots expire after 60 seconds. Lock, account/network/backend change,
disconnect, wallet removal and website payment submission invalidate cached balance data.
Completed balance-request status also rechecks the current grant and freshness.
Read-only balance refresh never signs or broadcasts, and no UTXOs, derivation
paths, xpubs, seeds or private keys are included in its website result.

Popup messages also omit `sender.documentId` in Chromium because messaging only
fills frame metadata for tab-backed senders. For this shape (no tab/frame ID),
the worker requires the exact extension sender and fixed popup URL, then queries
ALL contexts at that URL. Exactly one matching frame must exist and be a
top-level POPUP. Its browser-reported document ID becomes the broker identity.
A duplicate tab, iframe or popup makes resolution ambiguous and is rejected;
a supplied but incorrect document ID never falls back to another context.
With no pending website request, normal opening returns an empty claim without
requiring approval identity. Pending connections still require full validation.

An open popup keeps discovering requests until one is claimed. Discovery errors
are visible and retryable. A repeated `connect` from the same site document
resumes its pending connection, preserving its expiry. It cannot replace a
payment or a different document's request.

Requests expire after five minutes and are rejected when the requesting page
navigates or its browser window closes. Closing a pending toolbar popup lets
the user reopen it; closing during signing cancels that signing operation.
The popup maintains a short-lived heartbeat port solely for reliable close
tracking. Public request state, grants and order
deduplication live in `chrome.storage.session`, surviving worker restarts but
not a full browser-session reset. Only one approval/payment runs at a time;
order IDs cannot be reassigned during that session. Connections can be revoked
from Settings and are invalidated by wallet removal.

Before broadcasting, the worker durably records the computed transaction ID and
a submission marker. No submission is retried automatically. Interrupted or
ambiguous submission returns error `-32002` with `data.txid` when available:
check that transaction and the account history before requesting another
payment. A submitted transaction is not a guarantee of swap settlement.

Errors use `4001` for rejected/expired requests, `4100` for authorization,
`4200` for unsupported methods, `-32602` for parameters, and `-32002` for an
active/duplicate request or ambiguous submission. Request results contain
public addresses, consented balance snapshots or transaction IDs only; no raw signed transaction reaches the
website. Session capacity is bounded to 500 request records without silently
evicting payment deduplication keys.

Automated coverage includes origin/frame validation, exact amount parsing,
immutable order IDs, approval ownership, expiry, revocation, worker restarts,
single submission transitions, account/network drift and name-protection
failure. Release still requires an unpacked-extension browser test with a
disposable profile and test-only wallet. Automated tests do not transfer funds.

A fresh automatic scan has a 45-second end-to-end deadline, including response bodies. The deadline aborts all explorer reads, releases the per-origin in-flight slot and rejects the result. A late obsolete scan cannot replace a later successful refresh.

## Total debit budget

`window.nacre.features` includes `totalDebitCap`. A `sendTransaction` request may include `maxTotalDebitAtoms`, a canonical positive integer string in grains (100,000,000 grains = 1 PRL), at least the requested amount and at most 9,223,372,036,854,775,807 grains. Numbers, decimals, exponents, signs and leading zeros are rejected. For example, an amount of `"0.9"` and a cap of `"100000000"` permit at most 1 PRL including the network fee. This example is protocol documentation, not a request to send funds.

The cap survives validation and persistence unchanged. Changing/removing it under an existing request or order ID is rejected. Review, signing authorization and the actual transaction builder check amount plus fee; the builder checks both its selected-input plan and the prepared transaction before signing, including dust change consumed as fee. The reviewed fee is also pinned, so a changed fee requires another review even if the new total would fit. The broker checks the stored budget again before its one-shot broadcast transition. The optional field grants no additional permission and never triggers an automatic signature.

The UI displays **Budget max** in PRL alongside total and network fee. If the site requires a budget, require the advertised feature and bind this field into the trusted payment instruction; never fall back to an uncapped payment. Old requests can omit the field for backwards compatibility. This cap applies to one immutable native wallet payment, not future bridge conversions, remote exchange fees or another independent request.
