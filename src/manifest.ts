// Chrome Manifest V3 definition for Pearl Wallet. Kept in TS (not raw JSON) so
// @crxjs/vite-plugin can inline the popup/options HTML paths, hash the
// service worker, and rewrite asset URLs at build time.

import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

export default defineManifest(({ mode }) => ({
  manifest_version: 3,
  name: 'Nacre Wallet',
  short_name: 'Nacre',
  minimum_chrome_version: '127',
  version: pkg.version,
  description: pkg.description,

  // Popup is the main UX surface (click the toolbar icon).
  action: {
    default_title: 'Nacre Wallet',
    default_popup: 'src/popup/index.html',
    default_icon: {
      '16':  'src/assets/icon-16.png',
      '32':  'src/assets/icon-32.png',
      '48':  'src/assets/icon-48.png',
      '128': 'src/assets/icon-128.png',
    },
  },

  icons: {
    '16':  'src/assets/icon-16.png',
    '32':  'src/assets/icon-32.png',
    '48':  'src/assets/icon-48.png',
    '128': 'src/assets/icon-128.png',
  },

  // Background service worker (MV3) — used for long-running tasks like
  // periodic balance refresh and auto-lock timer. Stays minimal in v0.1.
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },

  // No options page — every flow (including new-wallet creation and seed
  // reveal) lives inside the popup for a single, consistent UX surface.

  permissions: [
    'storage',          // encrypted vault lives in chrome.storage.local
    'alarms',           // periodic auto-lock + balance refresh
  ],

  host_permissions: [
    // Default Pearl backends — required so fetch() works from the popup.
    'https://pearlchain.live/*',
    'https://blockbook.pearlresearch.ai/*',
  ],

  // Production is restricted to the exact Nacre site. Localhost is dev-only;
  // the isolated relay additionally restricts dev origins to explicit ports.
  content_scripts: [
    { matches: ['https://nacre.finance/*', ...(mode === 'development' ? ['http://localhost/*', 'http://127.0.0.1/*'] : [])], js: ['src/dapp/content.ts'], run_at: 'document_start', all_frames: false, world: 'ISOLATED' },
    { matches: ['https://nacre.finance/*', ...(mode === 'development' ? ['http://localhost/*', 'http://127.0.0.1/*'] : [])], js: ['src/dapp/provider.ts'], run_at: 'document_start', all_frames: false, world: 'MAIN' },
  ],

  content_security_policy: {
    extension_pages:
      // Strict CSP — no inline scripts, no eval. WebCrypto and noble libs
      // are wasm-free and work under this.
      "script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline';",
  },
}));
