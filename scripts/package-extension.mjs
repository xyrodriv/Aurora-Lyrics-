#!/usr/bin/env node
/**
 * Stages the runtime files of the extension and zips them for the Chrome Web
 * Store. Sources (src/aurora-lyrics/*.jsfrag), docs, the website and mockups
 * stay out: the store upload should contain only what the browser loads.
 *
 *   node scripts/package-extension.mjs
 *
 * Writes build/aurora-lyrics-<version>/ and build/aurora-lyrics-<version>.zip.
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));

if (!manifest.version) throw new Error("manifest.json has no version");

const name = `aurora-lyrics-${manifest.version}`;
const buildDir = path.join(root, "build");
const stage = path.join(buildDir, name);
const zipPath = path.join(buildDir, `${name}.zip`);

// Everything the manifest or the content script can load at runtime.
const ENTRIES = [
  "manifest.json",
  "changelog.json",
  "icons",
  "assets",
  "src/content",
  "src/extensions",
  "src/background",
  "src/popup",
];

const SKIP = /(^|\/)(\.DS_Store|Thumbs\.db|[^/]+\.(map|md|log|jsfrag))$/i;

// The store unpacks the archive and resolves paths exactly as manifest.json
// spells them, so every entry name must use forward slashes. Compress-Archive
// (and .NET's ZipFile) write "src\\content\\content.js" on Windows, which lands
// as one file literally named that and makes every manifest path miss. This
// writes the archive directly instead: deflate, POSIX separators, no directory
// entries, no platform branch.
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

const dosTime = (date) =>
  ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
const dosDate = (date) =>
  (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;

async function writeZip(dir, names, target) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    if (name.includes("\\")) throw new Error(`zip entry would use a backslash: ${name}`);
    const source = path.join(dir, name);
    const data = await readFile(source);
    const packed = deflateRawSync(data, { level: 9 });
    const entry = Buffer.from(name, "utf8");
    const { mtime } = await stat(source);
    const time = dosTime(mtime);
    const date = dosDate(mtime);
    const sum = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(sum, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(entry.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, entry, packed);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(sum, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(entry.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, entry);

    offset += header.length + entry.length + packed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await writeFile(target, Buffer.concat([...local, directory, end]));
}

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

for (const entry of ENTRIES) {
  await cp(path.join(root, entry), path.join(stage, entry), {
    recursive: true,
    filter: (source) => !SKIP.test(path.relative(root, source).replaceAll("\\", "/")),
  });
}

// Walk the stage so the report describes what is really in the zip, not what
// the copy list hoped for.
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else files.push(path.relative(stage, full).replaceAll("\\", "/"));
  }
}
await walk(stage);
files.sort();

const problems = [];
if (!files.includes("manifest.json")) problems.push("manifest.json is not at the archive root");
if (files.some((file) => file.endsWith(".jsfrag"))) problems.push("source fragments leaked into the package");
if (files.some((file) => file.startsWith("website/") || file.startsWith("mockups/"))) {
  problems.push("site or mockup files leaked into the package");
}
if (problems.length) {
  console.error(problems.map((problem) => `  ${problem}`).join("\n"));
  process.exit(1);
}

await rm(zipPath, { force: true });
await writeZip(stage, files, zipPath);

const bytes = (await stat(zipPath)).size;
const kb = (value) => `${(value / 1024).toFixed(1)} KB`;

console.log(`\n${path.relative(root, zipPath)}`);
console.log(`  ${files.length} files, ${kb(bytes)} zipped\n`);
for (const entry of ENTRIES) {
  const group = files.filter((file) => file === entry || file.startsWith(`${entry}/`));
  if (!group.length) continue;
  const size = (
    await Promise.all(group.map(async (file) => (await stat(path.join(stage, file))).size))
  ).reduce((total, value) => total + value, 0);
  console.log(`  ${entry.padEnd(20)} ${String(group.length).padStart(3)} files  ${kb(size)}`);
}
