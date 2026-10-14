# Firefox build

The Firefox package provides Nacre's native Pearl wallet features. **The website connector is disabled**: it relies on Chromium-specific popup and document identity handling. A working Chrome connector should not be interpreted as Firefox connector support.

## Build

Use Node.js 24 and install dependencies with `npm ci`, then run:

```sh
npm run build:firefox
npm run package:firefox
```

Outputs are `dist-firefox/` and `releases/nacre-wallet-firefox-<version>.zip`.

`scripts/build-firefox.mjs` copies the production Chrome bundle and changes the manifest:

- Replaces `background.service_worker` with `background.scripts` for an MV3 event page.
- Removes content scripts, web-accessible resources, and the Chrome minimum-version field.
- Sets the current Firefox add-on ID to `nacre-wallet@nacre.local`.
- Declares Firefox 140+ and Firefox for Android 142+ as minimum versions.

The converter does not modify the original `dist/` directory. These manifest minimums are not a claim that every listed browser/platform has been manually tested.

## Test locally

1. Open `about:debugging` in Firefox.
2. Select **This Firefox** → **Load Temporary Add-on**.
3. Select `dist-firefox/manifest.json`.
4. In a disposable profile, exercise create/import, unlock/lock, accounts, receive, fees, and settings with test-only data.

Temporary add-ons are removed on browser restart. Treat this as a development installation, not a durable place to keep wallet funds. A UI preview or an automated test run does not replace testing the installed extension.

## Distribution and identity

Normal Firefox distribution requires Mozilla signing. This repository does not assert that a signed add-on or store listing exists.

The add-on ID above is the current source identity. If publishing a separately maintained fork, choose its own ID in `scripts/build-firefox.mjs` **before its first distribution**, then keep that identity stable across updates. Renaming an ID does not migrate browser wallet storage. Preserve the MIT and third-party notices when distributing packages.

For general packaging and source-review instructions, see [BUILD.md](BUILD.md).
