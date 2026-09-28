# Aurora Lyrics

> Synced lyrics, artwork tools, and themes for YouTube Music.

Aurora Lyrics is an MV3 browser extension for YouTube Music that renders
karaoke-style **synced lyrics** alongside the player, plus a suite of companion
add-ons (dynamic themes, artwork accent, fullscreen mode, PiP, sleep timer, and
smooth motion).

## Features

- **Synced lyrics** — word-level (syllable), line-level, and plain/static
  rendering driven by live playback position.
- **Multiple lyric sources** — auto-fetches from the **Spicy Lyrics API**,
  **LRCLIB**, and **Unison**, and supports importing/exporting TTML with
  permanent, per-track saves.
- **Automatic Spotify-id resolution** — YouTube Music exposes no Spotify id, but
  the Spicy Lyrics API is keyed by one. Aurora resolves it through
  **ListenBrainz** (free, keyless, no backend) using a variant ladder over
  title/artist/album, so the Spicy source works for ordinary YT Music tracks
  rather than only hand-matched ones.
- **Timing calibration** — a global and a per-video offset, plus a pause-sync
  point, so the lyrics line up with any source.
- **Fullscreen karaoke mode** — video on one side, lyrics on the other, with an
  ambient Kawarp fluid WebGL backdrop.
- **Companion add-ons** (managed from the in-app marketplace panel):
  - Dynamic theme + Kawarp backdrop
  - Artwork Accent
  - PiP Lyrics
  - Sleep Timer
  - Smooth Motion
- **Support** — an in-app Support panel (Cash App / PayPal). See
  [Support](#support).

## Installation

### Load unpacked (Chromium)

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (the one containing
   `manifest.json`).
4. Open YouTube Music — the lyrics panel appears in the right sidebar and the
   add-ons panel opens from the top-right controls.

> **Reload note:** after editing source, reload the extension at
> `chrome://extensions` **and** reload the YouTube Music tab. `src/content/content.js`
> runs in the isolated world and does not hot-reload on a tab refresh alone.

### Via YTMod / marketplace

Aurora Lyrics is built as a YTMod extension and can be distributed through a
YTMod-compatible marketplace.

## Project structure

```
spicy-ytm/
├── manifest.json              # MV3 extension manifest (name, permissions, hosts)
├── LICENSE                    # GNU AGPL-3.0
├── src/
│   ├── content/               # Isolated-world injector + marketplace UI
│   │   ├── content.js         # Bootstraps the add-on registry + marketplace panel
│   │   ├── public-api.js      # window.YTMod bridge (player, bus, lyric helpers)
│   │   └── styles.css         # Marketplace + Support overlay styles
│   ├── extensions/            # Individual add-ons (web_accessible_resources)
│   │   ├── spicy-lyrics.js     # Synced Lyrics renderer (main)
│   │   ├── dynamic.js          # Dynamic theme + Kawarp backdrop
│   │   ├── artwork-accent.js   # Artwork Accent
│   │   ├── pip-lyrics.js
│   │   ├── sleep-timer.js
│   │   ├── smooth-motion.js
│   │   └── kawarp-core.js      # Bundled Kawarp WebGL module
│   └── popup/                 # Toolbar popup (popup.html / popup.js / popup.css)
├── docs/                      # Design, animation, and resolver notes
├── resolver-worker/           # Optional Spotify-Worker path + regression suites
└── backups/                   # Local working backups (git-ignored)
```

## Development

There is no build step — the source is plain JavaScript and CSS.

- `src/content/content.js` and `src/content/public-api.js` are
  `web_accessible_resources` and hot-reload on a YouTube Music tab reload.
- `src/content/content.js` is a `content_scripts` entry and needs a full
  `chrome://extensions` reload after edits.
- Some CSS lives **inside JavaScript template literals**. After editing CSS in
  those files, run `node --check <file>` before committing — an unescaped
  backtick there terminates the literal early and silently breaks the script.

## License

Licensed under the **GNU Affero General Public License v3.0** — see
[`LICENSE`](./LICENSE).

Aurora Lyrics is a focused adaptation of the original **Spicy Lyrics** Syllable
renderer by **Spikerko**, which is AGPL-3.0 licensed. That license and
attribution must be preserved when distributing adapted builds.

## Support

Aurora Lyrics is and always will be free. If you'd like to help keep it
maintained, tips are genuinely appreciated — they do **not** unlock premium
features or grant anything extra.

- Cash App: https://cash.app/$ajlol101
- PayPal: https://paypal.me/brandiluvsbts

You can also open the in-app **Support** panel from the top-right of the
add-ons panel.
