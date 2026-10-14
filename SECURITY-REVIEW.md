# Nacre Wallet implementation review

This records targeted engineering checks, not an independent security audit or a claim that the wallet is ready to hold real funds.

## Version 0.1.10 network fees and MAX

The fee adapter first uses the primary explorer recommendation, then the existing permitted Pearl Blockbook estimator when that recommendation is absent. Blockbook must report synchronized mainnet; its PRL/kB result is converted exactly and rounded upward to integer grains/vB. Missing estimates from both sources permit an explicitly identified 2 grains/vB wallet fallback raised to published floors. Invalid, zero, negative or excessive explicit estimates block instead of silently falling back. No extension permissions were added.

Foreground and background balances share the fee policy and planners. The provider advertises `feeEstimates` and exposes paired, validated public `feeRate`/`feeSource` metadata; fallback is not labelled a network recommendation. The connected site's MAX reserves a regular transfer's fee, including possible change. Native Send MAX uses an economic input prefix and one output. Protected name coins remain excluded. The 100,000-vB standard transaction size limit is checked before signing, in addition to wallet rate/total-fee ceilings.

Send and website approvals recheck fee rate/source, funding, exact requested amount and total budget before signing. Consolidation and name transfer also freeze their reviewed funding inputs, values, protected coins and destinations; changed funding requires another review before their builders are invoked. They show the rate rather than a complete total-fee quote, so that UI remains a future improvement. None of these checks guarantees a confirmation deadline or replaces network validation.

Validation: 479 wallet tests in 39 files, TypeScript and ESLint passed. The website's 37 targeted balance/discovery/affordability/payment-gate tests and TypeScript passed. A read-only live adapter check on 2026-10-07 returned 784 grains/vB from Blockbook while the primary recommendation was null, with a 1-grain/vB relay floor. This is a time-specific observation, not a fixed tariff. Test signing uses public synthetic fixtures; no user key, transaction submission or live payment was used. Installation/reload of the user's extension remains a separate manual step; browser automation cannot access chrome://extensions.

## Baseline

The source starts from `kaspador/pearl-extension` commit `c916752d09eb729de188efdd37ac64e2e26e27d6` (package version 1.3.2). The distributed Chrome 1.3.3 JavaScript was inspected statically without installing or executing it. Its MAX, fee-preview and fee-limit behavior was compared with the source. This is a bounded reconciliation, not a claim that the entire 1.3.3 release has been reproduced.

## Payment findings and changes

- The original MAX button used the spendable balance without subtracting fees. `sendMax` now creates one recipient output from unprotected inputs after reserving its network fee.
- The original fee preview always assumed one input and two outputs. `quoteSend` and signing share the same input selection and change/dust calculation. The review includes dust added to the fee.
- The original amount sanitizer deleted arbitrary characters and truncated extra decimal places; subsequent number conversion could round grains. `money.ts` provides strict decimal parsing and formatting using `bigint`. Scientific notation, extra separators, negative values and more than eight decimals are rejected instead of being silently changed. Fiat values remain approximate display data.
- Fee recommendations are converted only after checking finite numeric values. Signing enforces 1–20,000 grains/vB and a maximum total network fee of 1,000,000,000 grains (10 PRL), following the inspected 1.3.3 policy. These are wallet safety limits, not Pearl consensus limits. Invalid input values and duplicate outpoints are rejected.
- Coin selection for ordinary payments remains the upstream algorithm. Key derivation, Taproot construction, account ownership checks and golden fixtures have not been changed. Protected `.pns` outpoints remain excluded from ordinary payments and MAX.
- Send now freezes the reviewed payment and rechecks account, network, inputs, protected coins, amount and fee before synchronous signing. Changing a `.pns` recipient clears the previous resolution immediately. Ordinary Send, dApp payments, consolidation and name transfer block spending when the name-coin lookup is unverified; retained consolidation/name-transfer actions check that state again immediately before transaction construction.

## Checks performed

The targeted suite passed 66 tests in seven files covering exact decimals, MAX output amounts, multi-input fees, discarded dust, insufficient funds, fee bounds, duplicate and malformed outpoints, name-coin protection, v2 recipients, existing golden fixtures, and the public provider protocol. TypeScript checking also passed. No actual funds, user keys or broadcast endpoints were used. Dependency audit is tracked separately by the build owner; a local `npm audit --json` check during this work reported zero known advisories, which does not establish overall code security.

Read-only inspection of the connector found these implemented boundaries: exact allowed website origins; top-level tab/document identity; browser-verified toolbar document ownership; method and decimal validation; explicit payment approval; fresh account/name-coin checks; selected mainnet account and unlock revalidation before signing; equality of the approved and signed network fee; and a durable session marker before a single broadcast attempt. Interrupted or ambiguous submissions retain their transaction ID instead of being automatically resubmitted. Protocol tests cover malformed requests, unexpected methods/fields, unsupported networks, origin spoofing and browser sender identity. Broker lifecycle tests and browser interaction checks are tracked separately by the connector/build owners.

A subsequent run passed 23 tests covering the broker lifecycle (14) and payment preparation (9), followed by another passing TypeScript check. Preparation tests verify exact amounts and immutable reviewed snapshots, lock/network/account checks, rejection of stale or failed synchronization, and unavailable or protected name coins. The targeted checks above therefore cover 89 tests in nine files. The build owner tracks the final full-suite result separately.

## Integration checks still required

Session restoration and unlocking also revalidate after asynchronous key derivation, preventing a late operation from restoring keys after lock. Six regression tests cover interrupted restore/unlock and late storage writes.

Version 0.1.0 combined checks: 161 tests in 17 files passed, TypeScript and ESLint passed, and the production extension built successfully. A separate in-memory UI harness verified onboarding, zero-balance dashboard, receive QR/address, settings themes, lock screen and the connection-approval layout at 360 × 600 CSS pixels. It uses a public test vector and blocks broadcasts. These checks do not exercise an installed extension.

- Verify the entire provider/worker/approval flow in a real Chromium extension, including navigation, expiry, account changes, lock, worker restart and ambiguous broadcast results. The source implements these boundaries, but unit tests do not establish browser behavior.
- Keep ordinary/dApp spending, consolidation and name transfer blocked if the `.pns` coin lookup is unverified. The guards were inspected in source; interactive testing of indexer outages across the retained wallet screens is still required.
- Payment idempotency records live in browser session storage. They survive worker restarts, not browser exit; a swap backend must enforce durable business-order idempotency independently.
- Preserve local-only key handling and ensure review amounts and fees use the exact decimal formatter. Blockchain data and fee recommendations from an explorer are untrusted inputs; this work is not a full verification of the explorer/indexer trust model.
- Complete connector, browser-build and UI checks before treating this experimental fork as suitable for real funds. Tests establish specific behavior; they do not replace independent review of custody and signing boundaries.

The available UI browser cannot load this extension as an installed Chromium extension. In particular, real toolbar `runtime.getContexts()`/document/window identity and MAIN-world script injection have not been exercised here. No successful UI preview or unit-test result should be described as an installed-extension end-to-end test.

## Version 0.1.1 toolbar correction

The popup now has intrinsic 360 × 600 CSS-pixel dimensions rather than viewport-relative dimensions that caused Chrome auto-sizing to collapse. Website requests use the native action popup on Chrome 127+ and browser-verified POPUP/document/window identity. A denied automatic opening retains a pending request and toolbar badge; closing a pending popup permits reopening, while interrupted signing cannot resume. Old pending requests without a browser-window identity are rejected during upgrade without discarding transaction markers. Port heartbeat/reconnection maintains close tracking, and live contexts distinguish an actual close from a reconnect.

The complete suite passed 168 tests across 18 files. Targeted authentication/lifecycle tests, TypeScript and lint pass. In the UI harness, a smaller 240 × 160 viewport still produced 360 × 600 document dimensions; onboarding and connection approval were visually checked at their normal size. The harness cannot establish actual Chrome toolbar placement. An installed Chrome smoke test remains required.

## Version 0.1.2 connection recovery

The installed-browser report exposed a wrong 0.1.1 assumption: Chromium's genuine `POPUP` context has `windowId: -1`, so the previous validator rejected it. `RuntimeGetContextsInteractiveApiTest.GetPopupContext` in Chromium explicitly documents this behavior. Authentication now verifies the exact extension popup document first, then resolves a concrete focused browser window through the background windows API. Broker approval remains bound to both the requesting window and popup document. An ordinary extension tab, child frame, foreign document or unfocused window remains unauthorized.

The popup discovers requests while open, stops discovery once it claims one, preserves the claim through unlock/onboarding, and shows retryable discovery failures. A second Connect click from the same website document resumes its pending connection without extending its expiry. It cannot replace a payment or another document's request. Existing signing/broadcast markers and wallet vault storage are unchanged.

Regression coverage reproduces Chromium popup metadata across the real background message handler and broker: request creation, toolbar opening, claim, review, explicit connect, site result and cleared badge. Browser APIs are mocked; this is not an installed-Chrome end-to-end test. Discovery tests cover transient errors, delayed requests, single-flight retries and cleanup. No user wallet, keys or funds were used.

The complete 0.1.2 suite passed 188 tests across 21 files. ESLint, TypeScript and the production build passed. Installed-extension verification remains necessary; the available browser surface cannot load the extension.

## Version 0.1.3 native message identity and idle opening

A second installed-browser report exposed a further incorrect test fixture in 0.1.2: Chromium's MessageService fills source frame data only when a tab is present. Native popup messages therefore omit `sender.documentId` as well as tab/frame fields. The previous tests modeled the popup context's `windowId: -1` but still supplied a fictional sender document ID.

The worker now resolves this metadata-free sender only when its browser-supplied extension ID, exact popup URL and origin (when present) match, its tab/frame fields are absent, and ALL runtime contexts at that URL identify exactly one top-level POPUP. Context enumeration must not filter away duplicate tabs or child frames; ambiguous cases remain unauthorized. A sender with a document ID continues to require an exact match, without fallback. The actual context document ID and focused browser window remain the broker's approval identity. Port-close tracking retains the same browser-resolved document identity.

Opening the wallet with no pending request returns an empty claim before approval-context authentication, preventing a website warning during normal use. This does not grant account access or approval authority. Requests that exist still pass the full identity checks. Wallet vault, key derivation, signing and transaction submission logic are unchanged. These checks use Chromium source-based browser mocks, not an installed-browser test.

Version 0.1.3 checks: 217 tests across 22 files passed, including idle open, pending approval without sender document/frame/tab metadata, expiry recovery, ambiguous context rejection and retained port-close identity. ESLint, TypeScript and the production build passed. Native installed Chrome interaction remains unverified in this environment.

A follow-up close-tracking correction preserves lock-on-close even if registration has not resolved: when Chrome confirms no live popup remains, the callback may lock without a document ID; it never invents an approval identity or cancels another popup. The changed close/background suites passed 18 tests, including two added regressions, followed by passing lint, TypeScript and production build checks.

## Version 0.1.4 popup focus and local connection preparation

The installed-browser screenshot reached the parent-window focus check and was rejected. Chromium's WindowControllerList explicitly documents that an extension popup may take focus away from its browser window. The parent `focused` boolean is no longer used as approval authority. The worker still authenticates a live, unambiguous native POPUP and validates a concrete browser window ID; broker approval still requires the exact requesting window and claimed popup document. Chrome's own `action.openPopup` handles eligibility for automatic opening.

Connection previews now derive one selected-account public address locally (HD receive index 0, including custom derivation/imported seeds; stored validated public address for imported keys). They do not invoke balance, fee, price, history or PNS endpoints. The HD session identity, unlocked state, mainnet selection and selected account are revalidated after asynchronous work, and approval prepares the address again. No key export or signing method is used for connection. Payment previews retain fresh coin scans, verified PNS protection and exact fee/amount checks; connection/payment types are distinct.

Version 0.1.4 checks: all 236 tests across 24 files passed, followed by passing ESLint, TypeScript and the production build. A cross-layer regression uses the actual background handler, approval client, account derivation and connection preparation with an in-memory encrypted vault and a public BIP39 test vector. It verifies no address disclosure before explicit consent, successful account return and badge cleanup with a native metadata-free popup sender and an unfocused parent window, zero network calls, and no signing or broadcast. Browser APIs are mocked; installed Chrome behavior remains unverified in this environment.

## Version 0.1.6 website MAX fee agreement

The website balance snapshot previously advertised the wallet's one-output MAX amount, while website payments accept a fixed amount and reserve a recipient+change fee. The displayed maximum could therefore fail payment preparation. The new `quoteFixedAmountMax` uses ordinary selection's descending coin prefixes and two-output estimate, then re-quotes that exact amount with the shared payment planner. It excludes protected coins and avoids reducing the result by adding uneconomic small inputs. Ordinary selection, signing and the internal wallet MAX algorithm are unchanged.

Regression coverage takes a public balance snapshot through actual website payment preparation and offline signing using declared public fixture keys. It checks amount/fee agreement, one/many inputs, dust boundaries, name-coin protection, duplicate inputs, excessive fees and stale affordability after fee or protection changes. A fresh approval is still required and an amount is never silently reduced. No user wallet data, actual funds or broadcast endpoint is used.


## Version 0.1.7 automatic balance updates

Connection approval explicitly grants public address and full-account balance sharing while unlocked. The authenticated popup derives a public-only account node (or single public address); the worker stores it only in trusted session state. Read-only refresh never restores a mnemonic or signing key and never opens approval from polling. Old grants require explicit reconnect. Scope, origin, selected account, metadata and unlocked session are checked before and after scans. Invalidation generations reject lock/account/revoke/reconnect/payment races, including results pending a storage write; repeated reads share one in-flight scan per origin. Public snapshots omit xpubs, UTXOs and derivation paths.

The same complete HD scanner and exact fixed-payment MAX planner are reused. Name-protection failure suppresses spendable/MAX; fee failure suppresses MAX. Payment signing, per-payment consent and unknown-submission handling are unchanged. Validation uses public test vectors and synthetic explorer responses only; no real wallet state, funds or transactions are used.

A fresh automatic scan has a 45-second end-to-end deadline, including response bodies. The deadline aborts all explorer reads, releases the per-origin in-flight slot and rejects the result. A late obsolete scan cannot replace a later successful refresh.

## Version 0.1.8 production origin migration

Both MAIN-world provider injection and isolated relay injection now match only `https://nacre.finance/*`; the protocol accepts only the exact HTTPS origin. The old hosted demo origin, HTTP, www/subdomains and alternate ports are rejected. The dashboard link and package homepage use the same production origin. Existing grants remain scoped to their original origin and cannot authorize the new site. A fresh explicit connection approval is required. Storage identity, vault encryption, payment signing and Pearl backend permissions are unchanged. Firefox still omits website injection.

## Version 0.1.9 total debit cap

An optional canonical integer `maxTotalDebitAtoms` is preserved by protocol validation and the durable broker. Requests are cloned before asynchronous queueing; returned approval objects are also cloned. Idempotency binds cap presence and value to the original request/order. Fresh review checks requested atoms plus the actual planner fee against the cap. The signing authorization repeats that check against stored parameters. The builder independently checks the selected UTXO plan before obtaining input keys and the actual constructed outputs/input fee before signing, and rejects any mismatch against the reviewed fee. Broadcast authorization repeats the stored amount/fee check before recording its one-shot marker. Neither a stale preview nor changing/removing the cap creates a new signing authorization.

Coverage includes exact large integers, one-grain boundaries, malformed/insufficient caps, fee increases, changed input selection, dust absorbed into fees, request mutation during refresh/queueing, clone isolation, changed idempotency parameters and expiry. Offline transaction tests use a published synthetic private key and inspect serialized outputs/witnesses; they never load user wallet storage or call a broadcast endpoint. The cap is opt-in per payment and does not authorize financial execution. The installed browser extension is not automatically overwritten or reloaded by release packaging.
