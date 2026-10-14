import { readFileSync, writeFileSync, cpSync, existsSync, readdirSync, mkdirSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { zipBuildDirectory } from './portable-zip.mjs';

const root = process.cwd();
const target = process.argv[2] === 'firefox' ? 'firefox' : 'chrome';
// An isolated release output can be packaged without touching an installed unpacked dist/.
const directory = path.resolve(root, process.argv[3] ?? (target === 'firefox' ? 'dist-firefox' : 'dist'));
if (directory === root || !directory.startsWith(root + path.sep)) throw new Error('Package input must be a build directory inside this wallet project.');
const resolvedRoot = realpathSync(root), resolvedDirectory = realpathSync(directory);
if (lstatSync(directory).isSymbolicLink() || !resolvedDirectory.startsWith(resolvedRoot + path.sep)) throw new Error('Package input must not link outside the wallet project.');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
// Optional distinct filename for a store submission; never overwrite that file.
const outputName = process.argv[4] ?? `nacre-wallet-${target}-${pkg.version}.zip`;
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.zip$/.test(outputName)) throw new Error('Package output must be a ZIP filename inside releases/.');
const releaseDir = path.join(root, 'releases');
const archive = path.join(releaseDir, outputName);
if (process.argv[4] && existsSync(archive)) throw new Error('The requested store ZIP already exists; choose a new filename.');
const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
if (manifest.name !== 'Nacre Wallet' || manifest.version !== pkg.version) throw new Error('Build identity does not match Nacre Wallet.');
const serialized = JSON.stringify(manifest);
if (serialized.includes('localhost') || serialized.includes('127.0.0.1') || serialized.includes('<all_urls>')) throw new Error('Release contains a development or wildcard site permission.');
for (const file of ['LICENSE', 'NOTICE', 'README.md', 'SECURITY-REVIEW.md']) {
  if (existsSync(path.join(root, file))) cpSync(path.join(root, file), path.join(directory, file));
}
mkdirSync(path.join(directory, 'docs'), { recursive: true });
cpSync(path.join(root, 'docs/TRANSACTION-FEES.md'), path.join(directory, 'docs/TRANSACTION-FEES.md'));
if (existsSync(path.join(root, 'src/assets/licenses'))) cpSync(path.join(root, 'src/assets/licenses'), path.join(directory, 'font-licenses'), { recursive: true });
mkdirSync(path.join(directory, 'font-licenses'), { recursive: true });
cpSync(path.join(root, 'src/assets/fonts/OFL-Geist.txt'), path.join(directory, 'font-licenses/OFL-Geist.txt'));
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const notices = ['NACRE WALLET — THIRD-PARTY SOFTWARE NOTICES\n'];
for (const [relative, dependency] of Object.entries(lock.packages)) {
  if (!relative.startsWith('node_modules/') || dependency.dev) continue;
  const dir = path.join(root, relative);
  if (!existsSync(dir)) continue;
  notices.push(`\n--- ${relative.replace(/^node_modules\//, '')} ${dependency.version} (${dependency.license ?? 'see notice'}) ---\n`);
  for (const file of readdirSync(dir).filter(name => /^(license|licence|copying|notice)(\.|$)/i.test(name))) {
    try { notices.push(readFileSync(path.join(dir, file), 'utf8')); } catch { /* Some packages use a license directory. */ }
  }
}
writeFileSync(path.join(directory, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
mkdirSync(releaseDir, { recursive: true });
writeFileSync(archive, zipBuildDirectory(directory), { flag: process.argv[4] ? 'wx' : 'w' });
console.log(archive);
