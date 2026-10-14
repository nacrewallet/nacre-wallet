# Build instructions

Nacre Wallet is built from TypeScript, React, and CSS using Vite. The source includes tests and local UI fixtures; the installable extension is generated in `dist/` or `dist-firefox/`.

## Requirements

- Node.js **24**; `.nvmrc` records the major version.
- npm, included with Node.js.
- Git, for a source checkout and `package:source`.
- Network access for `npm ci` to download the dependencies pinned by `package-lock.json`.

The scripts use Node APIs and do not require PowerShell, `zip`, Python, an API key, or a private environment file. Run them from the repository root. If you use a Node version manager, select the version in `.nvmrc` first.

## Install and verify

```sh
npm ci
npm run check
```

The combined check is equivalent to:

```sh
npm run lint
npm run typecheck
npm test
npm run test:packaging
```

Tests use synthetic fixtures and public test vectors. They do not require a funded wallet or a live transaction. An installed-browser test is separate from these checks.

## Chrome / Chromium

```sh
npm run build
npm run package
```

- `build` runs TypeScript checking and Vite, writing `dist/`.
- `package` performs a fresh production build and creates `releases/nacre-wallet-chrome-<version>.zip`.
- The ZIP contains `manifest.json` at its root, rather than a wrapping directory.

Load `dist/` using **Load unpacked** in `chrome://extensions`, or extract the release ZIP and load its root directory. Chrome/Chromium 127+ is required by the manifest. The ZIP is a build artifact; keep the source, lockfile, and commit used to produce it.

## Firefox

```sh
npm run build:firefox
npm run package:firefox
```

`build:firefox` creates the Chrome bundle, copies it to `dist-firefox/`, and rewrites the Firefox manifest. The converter uses an event-page background and removes website injection. `package:firefox` creates `releases/nacre-wallet-firefox-<version>.zip`. See [Firefox instructions](FIREFOX.md) for identity and temporary installation.

## Source archive

```sh
npm run package:source
```

This archives the **committed `HEAD`** using Git and requires a clean working tree. It does not include uncommitted edits, ignored files, `node_modules`, or generated extension builds. Commit the intended changes first. The result is `releases/nacre-wallet-source-<version>.zip`. A source ZIP is for source distribution or review; it is not the installable Chrome package.

## Build inputs and notices

`src/manifest.ts` defines the Chrome manifest. Vite resolves entry points and asset names; `scripts/build-firefox.mjs` adapts the built manifest for Firefox. `scripts/package.mjs` checks extension identity and production permissions, includes MIT/upstream and dependency/font notices, and uses `scripts/portable-zip.mjs` to write the package.

Brand icons are committed under `src/assets/`. There is no icon regeneration step in the normal build. Keep replacement artwork consistent with the manifest and preserve applicable notices.

Use the same committed source, lockfile, and Node/npm versions when comparing builds. Archive names contain the package version; a build command alone is not a claim of byte-for-byte reproducibility across every operating system and toolchain.

## Development versus production

`npm run dev` starts Vite for extension development. It enables the documented localhost connector origins. `npm run preview:ui` starts an isolated, in-memory UI fixture at port 5174; this is not a browser-extension integration test and must never use real funds or secrets.

Release commands use production mode. Packaging rejects localhost, `127.0.0.1`, and `<all_urls>` permissions. The committed source is sufficient to build the wallet; bridge services, exchange access, and deployment credentials are separate.
