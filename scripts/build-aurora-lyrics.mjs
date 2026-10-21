import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(projectRoot, "src", "aurora-lyrics");
const outputPath = path.join(projectRoot, "src", "extensions", "aurora-lyrics.js");

// Ordered pieces of one IIFE. Keep a single scope and script URL at runtime.
const parts = [
  "01-bootstrap.jsfrag",
  "02-ttml.jsfrag",
  "03-animation-primitives.jsfrag",
  "04-state-settings.jsfrag",
  "05-styles.jsfrag",
  "06-panel-ui.jsfrag",
  "07-fullscreen-layout.jsfrag",
  "08-fullscreen-controls.jsfrag",
  "09-fullscreen-media.jsfrag",
  "10-fullscreen-entry.jsfrag",
  "11-fullscreen-next-up.jsfrag",
  "12-track-offset-sync.jsfrag",
  "13-loading-scroll.jsfrag",
  "14-lyrics-sources.jsfrag",
  "15-prefetch-search.jsfrag",
  "16-lyric-dom-romanization.jsfrag",
  "17-lyric-events.jsfrag",
  "18-animation.jsfrag",
  "19-animation-modes.jsfrag",
  "20-lifecycle.jsfrag",
  // AMLL (real Apple-Music-style engine) lives INSIDE the shared IIFE so its
  // functions can see panelEl / getOffsetForPosition. It must come before
  // 21-boot.jsfrag, which closes the IIFE with })(); — otherwise every amll*
  // function ends up at module scope and throws ReferenceError on panelEl.
  "22-amll-integration.jsfrag",
  "21-boot.jsfrag",
];

const check = process.argv.includes("--check");
if (process.argv.length > 3 || (process.argv.length === 3 && !check)) {
  console.error("Usage: node scripts/build-aurora-lyrics.mjs [--check]");
  process.exit(2);
}

// GUARD: 05-styles is ONE template literal, so a stray backtick anywhere in it
// (a comment quoting a class name, a CSS value) closes the literal early and
// reopens it later. The result is still valid JavaScript, so `node --check`
// passes and the bundle builds — the CSS is just silently truncated. This is
// house rule #1 in DEVELOPERS/IDEAS.txt; enforce it here instead of relying on
// remembering to scan.
{
  const cssPath = path.join(sourceDir, "05-styles.jsfrag");
  const cssText = await readFile(cssPath, "utf8");
  const ticks = (cssText.match(/`/g) || []).length;
  if (ticks !== 2) {
    console.error(
      `05-styles.jsfrag must contain exactly 2 backticks (the template delimiters), found ${ticks}.` +
      "\nA stray backtick silently truncates the stylesheet — remove it (use quotes in CSS comments)."
    );
    process.exit(1);
  }
}

const source = Buffer.concat(await Promise.all(
  parts.map((part) => readFile(path.join(sourceDir, part)))
));

if (check) {
  let output;
  try {
    output = await readFile(outputPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!output || !source.equals(output)) {
    console.error("aurora-lyrics.js is out of date; run node scripts/build-aurora-lyrics.mjs");
    process.exit(1);
  }
  console.log("aurora-lyrics.js matches its source fragments");
} else {
  await writeFile(outputPath, source);
  console.log(`Built aurora-lyrics.js from ${parts.length} source fragments`);
}
