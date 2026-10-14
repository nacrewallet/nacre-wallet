# Nacre Wallet

A self-custodial browser wallet for **Pearl (PRL)**, built with TypeScript and React. Create or restore a wallet, manage accounts, and review PRL payments in a compact browser popup.

## Features

- Local wallet creation and recovery, with a password-encrypted vault.
- PRL balances, receive addresses and QR codes, transaction history, and an address book.
- Exact PRL amounts, fee-aware MAX, and protected `.pns` name coins.
- Account management, `.pns` name transfers, and address consolidation.
- Light and dark themes, auto-lock, and connected-site controls.
- An opt-in Chrome/Chromium connection to `https://nacre.finance`, with separate wallet approval for each PRL payment.

**This is a PRL wallet.** It does not store ETH, BNB, SOL, USDT, or BTC. The Nacre bridge at [nacre.finance](https://nacre.finance) is a separate service. A website connection can request an explicitly approved PRL transfer; it does not give the website custody of the wallet or permission to sign future payments. Bridge infrastructure and exchange credentials are not part of this repository.

## Build and install

Use **Node.js 24** and the committed npm lockfile. No API key, `.env` file, or private credential is required to build.

```sh
npm ci
npm run check
npm run build
npm run package
```

`npm run check` runs lint, TypeScript checking, wallet tests, and packaging tests. `npm run package` builds the Chrome extension and writes `releases/nacre-wallet-chrome-<version>.zip`, with `manifest.json` at the ZIP root. See [Build instructions](BUILD.md) for individual commands and source archives.

To install locally in **Chrome/Chromium 127+**:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this project's `dist` folder. Alternatively, extract the release ZIP and select the extracted folder containing `manifest.json`.
3. Pin Nacre Wallet to the toolbar and open it to create or restore a wallet.

Keep your recovery phrase offline and private. Enter it only inside a wallet you trust, never on a website or in an issue report. An unpacked installation has its own extension identity and storage; it does not automatically migrate an existing Pearl Wallet or Nacre installation.

For an existing unpacked installation, rebuild or replace files in the **same folder**, then click **Reload** on that extension. Reload a connected website as well. Do not uninstall the extension as an update procedure: uninstalling removes its local storage.

Firefox has a separate [native-wallet build](FIREFOX.md) without the website connector. This repository and its build scripts do not imply an available Chrome Web Store or Firefox Add-ons listing.

## Development

```sh
npm run dev          # Extension development server
npm run preview:ui   # Isolated browser UI preview
npm test             # Wallet and protocol tests
npm run lint
npm run typecheck
```

The UI preview is at `http://127.0.0.1:5174/preview/index.html`. Add `?view=dashboard` or `?view=send` to inspect an empty example account. It uses a **public BIP-39 test vector**, in-memory storage, and mocked network responses; broadcasts are blocked. Never import a real recovery phrase or send funds to its example addresses. The preview is excluded from the production extension build.

The extension development build is different from the isolated preview: it can access the real wallet APIs and permits specific localhost connector origins for development. Use a disposable browser profile and test-only wallet when developing or testing the installed extension. Production packaging rejects development permissions.

## Network and website access

Production builds declare access to `pearlchain.live` and `blockbook.pearlresearch.ai` for public chain data, fee estimates, and transaction submission. These services can observe requested public addresses and ordinary network metadata. The website connector is restricted to the top-level `https://nacre.finance` origin.

A connection shares the selected public account address and explicitly approved balance access. Each website payment still requires a separate toolbar confirmation. The provider does not expose recovery phrases, private keys, arbitrary signing, or arbitrary RPC calls. See the [website API](src/dapp/README.md) for exact amounts, total-debit budgets, and ambiguous submission handling.

Network fees depend on the transaction and available fee data. MAX reserves the network fee and excludes protected name coins. See [Transaction fees](docs/TRANSACTION-FEES.md) for sources, units, fallback behavior, and limits. Wallet network fees are separate from any bridge or exchange fee.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/pearl/` | Addresses, keys, transaction construction, and fee policy |
| `src/storage/`, `src/state/` | Vault, accounts, session, and wallet state |
| `src/api/` | Public blockchain data adapters |
| `src/dapp/`, `src/background/` | Website protocol, consent, and background coordination |
| `src/screens/`, `src/ui/`, `src/popup/` | Wallet interface |
| `preview/` | Isolated UI fixture harness |
| `scripts/` | Firefox conversion and release packaging |

## Contributing and security

Read [Contributing](CONTRIBUTING.md) before submitting changes and [Security policy](SECURITY.md) before reporting a vulnerability. Automated checks cover specific behaviors; they do not guarantee security, network availability, or transaction settlement. No independent security audit is claimed. [Implementation review notes](SECURITY-REVIEW.md) record historical engineering checks and their limitations.

For the initial GitHub publication and release workflow, see [Publishing](docs/PUBLISHING.md).

## License and attribution

MIT licensed. Nacre Wallet is an independent fork of [kaspador/pearl-extension](https://github.com/kaspador/pearl-extension), based on commit `c916752d09eb729de188efdd37ac64e2e26e27d6` (Pearl Wallet 1.3.2). The distributed Chrome 1.3.3 bundle was also inspected to compare fee and MAX behavior; this does not claim complete parity with that release.

The upstream copyright and license are preserved in [LICENSE](LICENSE) and [NOTICE](NOTICE). Dependency and font notices accompany packaged builds. Nacre is not affiliated with Pearl Research Labs or the original Pearl Wallet author.
