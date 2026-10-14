import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPortableZip, zipBuildDirectory } from './portable-zip.mjs';

const manifest = Buffer.from('{"manifest_version":3,"name":"Fixture","version":"1.0.0"}\n');
const fixture = [
  { name: 'assets/main.js', data: Buffer.from('export const language = "en";\n') },
  { name: 'LICENSE', data: Buffer.from('MIT fixture\n') },
  { name: 'manifest.json', data: manifest },
  { name: 'icons/icon.png', data: Buffer.from([137, 80, 78, 71, 0, 255, 7]) },
  { name: 'vector.txt', data: Buffer.from('123456789') },
];

function inspect(zip) {
  const extracted = new Map(), offsets = new Map();
  let cursor = 0;
  while (zip.readUInt32LE(cursor) === 0x04034b50) {
    const start = cursor;
    assert.equal(zip.readUInt16LE(cursor + 4), 20);
    const flags = zip.readUInt16LE(cursor + 6), method = zip.readUInt16LE(cursor + 8);
    assert.equal(flags & ~0x0800, 0); // no descriptors or encryption
    assert.equal(zip.readUInt16LE(cursor + 10), 0);
    assert.equal(zip.readUInt16LE(cursor + 12), 0x21);
    const crc = zip.readUInt32LE(cursor + 14), compressed = zip.readUInt32LE(cursor + 18), size = zip.readUInt32LE(cursor + 22);
    const nameLength = zip.readUInt16LE(cursor + 26);
    assert.equal(zip.readUInt16LE(cursor + 28), 0);
    const name = zip.subarray(cursor + 30, cursor + 30 + nameLength).toString('utf8');
    assert.ok(!name.includes('\\')); assert.ok(!name.endsWith('/'));
    const bytes = zip.subarray(cursor + 30 + nameLength, cursor + 30 + nameLength + compressed);
    const data = method === 0 ? Buffer.from(bytes) : inflateRawSync(bytes);
    assert.equal(data.length, size);
    if (name === 'vector.txt') assert.equal(crc, 0xcbf43926);
    extracted.set(name, data); offsets.set(name, { start, flags, method, crc, compressed, size });
    cursor += 30 + nameLength + compressed;
  }
  assert.equal([...extracted.keys()][0], 'manifest.json');
  assert.equal(offsets.get('manifest.json').method, 0);
  const centralStart = cursor;
  let count = 0;
  while (zip.readUInt32LE(cursor) === 0x02014b50) {
    assert.equal(zip.readUInt16LE(cursor + 4), 20); // DOS creator
    assert.equal(zip.readUInt16LE(cursor + 6), 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const local = offsets.get(name); assert.ok(local);
    assert.equal(zip.readUInt16LE(cursor + 8), local.flags);
    assert.equal(zip.readUInt16LE(cursor + 10), local.method);
    assert.equal(zip.readUInt32LE(cursor + 16), local.crc);
    assert.equal(zip.readUInt32LE(cursor + 20), local.compressed);
    assert.equal(zip.readUInt32LE(cursor + 24), local.size);
    for (const offset of [30, 32, 34, 36]) assert.equal(zip.readUInt16LE(cursor + offset), 0);
    assert.equal(zip.readUInt32LE(cursor + 38), 0x20);
    assert.equal(zip.readUInt32LE(cursor + 42), local.start);
    cursor += 46 + nameLength; count++;
  }
  assert.equal(zip.readUInt32LE(cursor), 0x06054b50);
  assert.equal(zip.readUInt16LE(cursor + 4), 0); assert.equal(zip.readUInt16LE(cursor + 6), 0);
  assert.equal(zip.readUInt16LE(cursor + 8), count); assert.equal(zip.readUInt16LE(cursor + 10), count);
  assert.equal(zip.readUInt32LE(cursor + 12), cursor - centralStart);
  assert.equal(zip.readUInt32LE(cursor + 16), centralStart);
  assert.equal(zip.readUInt16LE(cursor + 20), 0);
  assert.equal(cursor + 22, zip.length); // no trailing descriptors/ZIP64 records/comments
  return extracted;
}

test('root manifest comes first with complete local headers; every asset extracts byte-for-byte', () => {
  const files = inspect(createPortableZip(fixture));
  for (const entry of fixture) assert.deepEqual(files.get(entry.name), entry.data);
  assert.equal(files.size, fixture.length);
  assert.equal(JSON.parse(files.get('manifest.json').toString()).manifest_version, 3);
});

test('identical content produces identical bytes regardless of enumeration order', () => {
  assert.deepEqual(createPortableZip(fixture), createPortableZip([...fixture].reverse()));
});

test('UTF-8 names and empty files remain ordinary valid entries', () => {
  const entries = [...fixture, { name: 'assets/étiquette.txt', data: Buffer.alloc(0) }];
  assert.deepEqual(inspect(createPortableZip(entries)).get('assets/étiquette.txt'), Buffer.alloc(0));
});

test('missing/wrapped manifests, unsafe paths and ambiguous names are rejected', () => {
  assert.throws(() => createPortableZip([{ name: 'dist/manifest.json', data: manifest }]), /root manifest/);
  for (const name of ['/absolute', '../escape', 'assets/../escape', 'assets\\file', './manifest.json', 'C:drive', 'file\0name', 'directory/']) {
    assert.throws(() => createPortableZip([...fixture, { name, data: Buffer.alloc(0) }]), /Invalid portable/);
  }
  assert.throws(() => createPortableZip([...fixture, { name: 'LICENSE', data: '' }]), /Duplicate/);
  assert.throws(() => createPortableZip([...fixture, { name: 'MANIFEST.JSON', data: manifest }]), /Duplicate/);
  assert.throws(() => createPortableZip(Array(0xffff).fill(fixture[0])), /entry count/);
});

test('directory packaging preserves nested files and licenses but rejects symbolic links', () => {
  const tempRoot = realpathSync(os.tmpdir());
  const directory = mkdtempSync(path.join(tempRoot, 'nacre-zip-test-'));
  try {
    mkdirSync(path.join(directory, 'assets')); mkdirSync(path.join(directory, 'empty'));
    writeFileSync(path.join(directory, 'manifest.json'), manifest);
    writeFileSync(path.join(directory, 'assets', 'main.js'), 'fixture');
    writeFileSync(path.join(directory, 'LICENSE'), 'license fixture');
    const files = inspect(zipBuildDirectory(directory));
    assert.deepEqual([...files.keys()], ['manifest.json', 'LICENSE', 'assets/main.js']);
    assert.equal(files.get('LICENSE').toString(), 'license fixture');
    symlinkSync(path.join(directory, 'assets'), path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => zipBuildDirectory(directory), /symbolic link/);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), tempRoot);
    assert.ok(path.basename(directory).startsWith('nacre-zip-test-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
