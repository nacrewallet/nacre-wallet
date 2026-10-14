import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Export the reviewed committed tree, never untracked working files or history.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
git('rev-parse', '--verify', 'HEAD');
if (git('status', '--porcelain', '--untracked-files=normal')) {
  throw new Error('Commit or remove pending source changes before packaging. This archive exports HEAD only.');
}
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Invalid release version.');
const directory = path.join(root, 'releases');
mkdirSync(directory, { recursive: true });
const archive = path.join(directory, `nacre-wallet-source-${pkg.version}.zip`);
git('archive', '--format=zip', `--prefix=nacre-wallet-${pkg.version}/`, `--output=${archive}`, 'HEAD');
console.log(archive);
