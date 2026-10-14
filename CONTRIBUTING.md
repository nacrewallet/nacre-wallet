# Contributing

Thanks for helping improve Nacre Wallet. Keep changes focused, readable, and reproducible. The wallet is a PRL client; the Nacre exchange/bridge backend is a separate project.

## Local setup

Use Node.js 24, then run:

```sh
npm ci
npm run check
npm run build
```

See [BUILD.md](BUILD.md) for packaging and [FIREFOX.md](FIREFOX.md) for browser differences. The isolated UI preview is available through `npm run preview:ui`. Its account comes from a public test vector; never use it for real funds or enter a real recovery phrase.

## Changes and pull requests

1. Create a branch for one concrete change.
2. Preserve existing behavior outside its scope and keep user-facing text in English.
3. Add meaningful regression coverage for changes to keys, vaults, balances, fees, transactions, website consent, or request lifecycle.
4. Run `npm run check` and `npm run build`. If packaging or browser manifests change, also build both browser packages.
5. Describe the problem, the resulting behavior, checks performed, and any unverified browser behavior in the pull request. Include before/after screenshots for visible UI changes when useful.

Use a disposable browser profile and public/synthetic test fixtures. Distinguish unit tests, the local UI preview, installed-extension tests, and actual network observations when reporting validation. Do not describe a mocked test as a live end-to-end transfer.

Never commit private keys, real recovery phrases, passwords, authentication tokens, production wallet exports, browser profiles, user logs, or exchange credentials. Public test vectors must be clearly identified. Build outputs and release ZIPs belong in release artifacts, not source commits.

## Wallet and connector invariants

- Use exact integer grains for monetary arithmetic; PRL decimal strings have at most eight fractional digits.
- Require explicit approval for each website payment and retain its account, recipient, amount, fee, and optional total-debit budget binding.
- Preserve name-coin protection and reject unsafe or incomplete explorer state before spending.
- Treat external API responses and website messages as untrusted input.
- Preserve origin, document, popup, account, and lock checks; avoid broadening permissions as a workaround.
- Do not automatically retry an ambiguous broadcast. Preserve its transaction evidence for reconciliation.

Changes to cryptography, derivation, signing, custody, or consent boundaries need a clear rationale and targeted tests. Dependency changes should include the lockfile and preserve license notices.

## Bugs and security reports

For an ordinary bug, include the version/commit, browser, steps, expected behavior, and actual behavior. Remove private wallet and account information from screenshots and logs.

For a vulnerability, follow [SECURITY.md](SECURITY.md) instead of publishing exploit details in a normal issue.

## License

Contributions are made under the repository's [MIT license](LICENSE). Preserve upstream attribution and third-party notices. Do not add code or assets whose license cannot be distributed with the project.
