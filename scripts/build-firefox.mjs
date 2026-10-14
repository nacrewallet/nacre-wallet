// Post-build: turn the Chrome MV3 `dist/` into a Firefox-compatible
// `dist-firefox/`. The bundled JS is left UNCHANGED — our chrome.* callback
// APIs (storage/alarms/runtime/tabs) work as-is in Firefox's chrome-compat
// namespace. Only the manifest differs:
//   • Firefox MV3 uses an event-page background (`scripts`), not a service
//     worker. Our background uses no SW-only APIs, so the same bundle loads
//     fine as a module background script.
//   • Firefox requires an explicit add-on id (browser_specific_settings.gecko).
//
// Run after `vite build` (see the `build:firefox` npm script).
import { cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2] ?? 'dist';
const OUT = process.argv[3] ?? 'dist-firefox';
const GECKO_ID = 'nacre-wallet@nacre.local';

if (!existsSync(`${SRC}/manifest.json`)) {
  console.error(`No ${SRC}/manifest.json — run "npm run build" first.`);
  process.exit(1);
}

const resolvedOutput = path.resolve(OUT);
const resolvedSource = path.resolve(SRC), root = process.cwd();
const regularOutput = resolvedOutput === path.join(root, 'dist-firefox');
const isolatedOutput = path.dirname(resolvedOutput) === path.join(root, 'release-build') && /^firefox-\d+\.\d+\.\d+$/.test(path.basename(resolvedOutput));
if ((!regularOutput && !isolatedOutput) || !resolvedSource.startsWith(root + path.sep) || resolvedSource === resolvedOutput || resolvedSource.startsWith(resolvedOutput + path.sep)) {
  throw new Error('Refusing to replace an output directory outside the wallet project.');
}
rmSync(resolvedOutput, { recursive: true, force: true });
cpSync(SRC, OUT, { recursive: true });

const mfPath = `${OUT}/manifest.json`;
const m = JSON.parse(readFileSync(mfPath, 'utf8'));

// The website connector requires Chromium's document-bound MessageSender.
// Firefox keeps the native wallet; do not inject a nonfunctional provider.
delete m.content_scripts;
delete m.web_accessible_resources;
delete m.minimum_chrome_version;

// Chrome's service-worker background → Firefox's event-page background script.
if (m.background?.service_worker) {
  m.background = {
    scripts: [m.background.service_worker],
    type: m.background.type ?? 'module',
  };
}

// Stable add-on id + minimum versions. data_collection_permissions is required
// by AMO (["none"] = the wallet collects no user data — keys/seed/password never
// leave the device; only public addresses and signed transactions are sent to
// read/broadcast on-chain). That manifest key only exists in Firefox 140+ /
// Firefox-for-Android 142+, so we set those as the minimums (MV3 module
// background needs 121+, comfortably covered).
m.browser_specific_settings = {
  ...(m.browser_specific_settings ?? {}),
  gecko: {
    id: GECKO_ID,
    strict_min_version: '140.0',
    data_collection_permissions: { required: ['none'] },
  },
  gecko_android: { strict_min_version: '142.0' },
};

writeFileSync(mfPath, `${JSON.stringify(m, null, 2)}\n`);
console.log(`✓ ${OUT}/ ready (Firefox MV3) — background=scripts, gecko.id=${GECKO_ID}`);
console.log(`  Test: Firefox → about:debugging → This Firefox → Load Temporary Add-on → ${OUT}/manifest.json`);
