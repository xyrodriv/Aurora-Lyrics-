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
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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
const zipped =
  process.platform === "win32"
    ? spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Compress-Archive -Path '${path.join(stage, "*")}' -DestinationPath '${zipPath}' -Force`,
        ],
        { stdio: "inherit" }
      )
    : spawnSync("zip", ["-r", "-q", zipPath, "."], { cwd: stage, stdio: "inherit" });

if (zipped.status !== 0) throw new Error("zipping failed");

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
