import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const ZIP32_LIMIT = 0xffffffff;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function checkedName(name) {
  if (typeof name !== 'string' || !name || /[\\<>:"|?*]/.test(name)
    || [...name].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)
    || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error(`Invalid portable ZIP entry name: ${JSON.stringify(name)}`);
  }
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length > 0xffff) throw new Error('ZIP entry name is too long.');
  return bytes;
}

function checkZip32(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= ZIP32_LIMIT) throw new Error('ZIP64 output is not supported.');
}

/** ZIP32 with fixed timestamps, ordinary DOS file attributes and complete local headers. */
export function createPortableZip(input) {
  if (!Array.isArray(input) || !input.length || input.length >= 0xffff) throw new Error('Invalid ZIP32 entry count.');
  const seen = new Set();
  const entries = input.map(({ name, data }) => {
    const filename = checkedName(name);
    const duplicateKey = name.normalize('NFC').toLowerCase();
    if (seen.has(duplicateKey)) throw new Error(`Duplicate portable ZIP entry: ${name}`);
    seen.add(duplicateKey);
    const contents = Buffer.from(data);
    checkZip32(contents.length);
    return { name, filename, contents };
  }).sort((a, b) => a.name === 'manifest.json' ? -1 : b.name === 'manifest.json' ? 1 : Buffer.compare(a.filename, b.filename));
  if (entries[0].name !== 'manifest.json') throw new Error('A root manifest.json is required.');

  const localRecords = [], centralRecords = [];
  let offset = 0;
  for (const { name, filename, contents } of entries) {
    // A stored first manifest is immediately readable even by simple ZIP readers.
    const method = name === 'manifest.json' ? 0 : 8;
    const compressed = method === 0 ? contents : deflateRawSync(contents, { level: 9 });
    checkZip32(compressed.length);
    const crc = crc32(contents);
    const flags = /^[\x20-\x7e]+$/.test(name) ? 0 : 0x0800; // UTF-8 only when needed; never data descriptors.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x0021, 12); // 1980-01-01 00:00:00, independent of timezone/mtime.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localRecords.push(local, filename, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // DOS creator, no Unix permissions or symlink type bits.
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(0x20, 38); // DOS archive bit; regular file, not a directory.
    central.writeUInt32LE(offset, 42);
    centralRecords.push(central, filename);
    offset += local.length + filename.length + compressed.length;
    checkZip32(offset);
  }
  const centralSize = centralRecords.reduce((total, record) => total + record.length, 0);
  checkZip32(centralSize); checkZip32(offset + centralSize + 22);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, ...centralRecords, end]);
}

/** Include every regular build file; links and special filesystem entries are rejected. */
export function zipBuildDirectory(directory) {
  const entries = [];
  function visit(absolute, relative) {
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`Build contains a symbolic link: ${relative || '.'}`);
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
    } else if (info.isFile()) {
      checkZip32(info.size);
      entries.push({ name: relative, data: readFileSync(absolute) });
    } else throw new Error(`Build contains a non-regular file: ${relative}`);
  }
  visit(path.resolve(directory), '');
  return createPortableZip(entries);
}
