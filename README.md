# Aurora Lyrics

> Synced lyrics, artwork tools, and themes for YouTube Music.

Aurora Lyrics is an MV3 browser extension for YouTube Music that renders
karaoke-style **synced lyrics** alongside the player, plus a suite of companion
add-ons.

## Features

- **Synced lyrics** — word-level (syllable), line-level, and plain/static
  rendering driven by live playback position.
- **Multiple lyric sources** — auto-fetches from the **Spicy Lyrics API** and
  **LRCLIB**; TTML files can be dropped or picked in, re-exported with your
  sync, and saved per track so they survive a reload.
- **Automatic Spotify-id resolution** — YouTube Music exposes no Spotify id, but
  the Spicy Lyrics API is keyed by one. Aurora resolves it through
  **ListenBrainz** (free, keyless, no backend) using a variant ladder over
  title/artist/album, so the Spicy source works for ordinary YT Music tracks
  rather than only hand-matched ones.
- **Timing calibration** — a global and a per-video offset, plus a pause-sync
  point, so the lyrics line up with any source.
- **Fullscreen karaoke mode** — video on one side, lyrics on the other, with an
  ambient Kawarp fluid WebGL backdrop.
- **Apple Music–style renderer** — the AMLL engine for line-synced tracks, with
  spring scrolling and the Apple Music stacked-line look, alongside the Spicy
  renderer for word-by-word karaoke. Which engine draws which kind of track is
  a setting, so you can put the Apple Music look on karaoke if you prefer it.
- **On-device translation** — optional English translation of non-English lines,
  done locally in Chrome (138+); nothing is sent to a server.
- **Manual lyric search** — when the automatic lookup misses, search LRCLIB in
  the panel and apply a match to the track you are playing.
- **Companion add-ons** (managed from the in-app marketplace panel):
  - **Apple Music Style** — the frosted player bar, wider lyrics column and type
  - **Aurora Bloom** — dynamic Kawarp backdrop built from the artwork
  - **Ambient** — artwork glow and a matching player tint
  - **Aurora Flow** — smooth motion across the interface
  - **Sleep Timer** — fade out, then pause
  - **PiP Lyrics** — always-on-top lyrics window
  - **Share a Lyric** — export the current line as a card or clip
  - **Next Up** — what plays next, in a pill beside the artwork
  - **Song Notes** — per-song notes saved in your browser
  - Plus optional **snippets**: track-change notification, copy lyrics, centered
    home, Now Playing panel, and arrow-key seeking

## Installation

### Load unpacked (Chromium)

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (the one containing
   `manifest.json`).
4. Open YouTube Music — the lyrics render in the **Lyrics** tab beside the queue,
   and the add-ons marketplace opens from the icon at the top-right of the page.

> **Reload note:** after editing source, reload the extension at
> `chrome://extensions` **and** reload the YouTube Music tab. `src/content/content.js`
> runs in the isolated world and does not hot-reload on a tab refresh alone.

### Add-ons

There is nothing else to install. Every add-on ships inside the extension and is
installed, switched and configured from the in-app marketplace panel; each one
is a plain script registered through the same `window.YTMod` bridge, so they can
be enabled and disabled without reloading the extension. On a fresh profile the
lyrics renderer and **Aurora Bloom** install and enable themselves; everything
else is opt-in.

## Project structure

```
Aurora Lyrics/
├── manifest.json              # MV3 manifest (permissions, hosts, injected files)
├── LICENSE                    # GNU AGPL-3.0
├── PRIVACY.md                 # What leaves the browser, host by host
├── changelog.json             # Release notes for the in-app update card
├── icons/                     # 16/32/48/128 toolbar and store icons
├── assets/
│   ├── art/                   # Add-on showcase clips and stills
│   └── manifest-logo.webp     # Logo used by the update card
├── scripts/
│   └── build-aurora-lyrics.mjs # Concatenates the renderer fragments
└── src/
    ├── aurora-lyrics/         # SOURCE fragments for the renderer (edit these)
    │   └── NN-*.jsfrag        #   01 … 23, concatenated in the order the build lists
    ├── content/               # Isolated-world injector + marketplace UI
    │   ├── content.js         # Content script: registry, marketplace, settings, panel
    │   ├── public-api.js      # Page-world window.YTMod bridge (player, bus, lyrics)
    │   └── styles.css         # Injected panel and marketplace styles
    ├── background/
    │   └── service-worker.js  # Fetch proxy for APIs that send no CORS header
    ├── extensions/            # Add-ons, loaded on demand (web_accessible_resources)
    │   ├── aurora-lyrics.js   # GENERATED from src/aurora-lyrics/ — do not edit
    │   ├── amll-core.js       # Apple-Music-style lyric engine
    │   ├── kawarp-core.js     # Kawarp WebGL backdrop
    │   ├── dynamic.js         # Aurora Bloom
    │   ├── artwork-accent.js  # Ambient
    │   ├── smooth-motion.js   # Aurora Flow
    │   ├── sleep-timer.js
    │   ├── pip-lyrics.js
    │   ├── share-lyric.js
    │   ├── next-up.js
    │   ├── song-notes.js
    │   ├── snippet-*.js       # Standalone tweaks
    │   └── fonts/             # Bundled lyric faces and their licence
    └── popup/                 # Toolbar popup (popup.html / popup.js / popup.css)
```

## Development

The Aurora Lyrics renderer is assembled from ordered fragments. Edit the
numbered files in `src/aurora-lyrics/` (`01-bootstrap.jsfrag` …
`23-auto-translate.jsfrag`) and rebuild the injected script:

```sh
node scripts/build-aurora-lyrics.mjs          # writes src/extensions/aurora-lyrics.js
node scripts/build-aurora-lyrics.mjs --check  # fails if the built file is stale
```

**Never edit `src/extensions/aurora-lyrics.js` directly — it is generated.** The
rest of the source is plain JavaScript and CSS with no build step.

Fragment order is the order in the build script, not the numeric prefix:
`21-boot.jsfrag` closes the shared IIFE, so it is appended after 22 and 23 even
though its number is lower.

- `src/content/public-api.js` is a `web_accessible_resource`: a YouTube Music tab
  reload picks up a change, no extension reload needed.
- `src/content/content.js` and `src/content/styles.css` are `content_scripts`
  entries and need a full `chrome://extensions` reload **and** a tab reload.
- Behavioural harnesses live in `.scratch/` and are git-ignored; they are plain
  Node scripts, so run them with `node .scratch/<name>.cjs`.
- Some CSS lives **inside JavaScript template literals**. After editing CSS in
  those files, run `node --check <file>` before committing — an unescaped
  backtick there terminates the literal early and silently breaks the script.

## License and attribution

Licensed under the **GNU Affero General Public License v3.0** — see
[`LICENSE`](./LICENSE).

**Aurora Lyrics is an unofficial project.** It is a focused adaptation of the
original **Spicy Lyrics** Syllable renderer by **Spikerko** (AGPL-3.0), and it
uses the **Spicy Lyrics API** to fetch community syncs. It is **not made,
endorsed, or supported by Spicy Lyrics** or by Spikerko, and it is not
affiliated with either. The upstream license and attribution must be preserved
when distributing adapted builds.

Lyrics fetched through the Spicy Lyrics API are credited on screen, in the
lyrics panel, from the `source` field of each response — the provider is always
named, and community syncs name and link the uploader and the maker.

## Support

Aurora Lyrics is and always will be free. If you'd like to help keep it
maintained, tips are genuinely appreciated — they do **not** unlock premium
features or grant anything extra.

- Cash App: https://cash.app/$ajlol101
- PayPal: https://paypal.me/brandiluvsbts
