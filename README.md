# Aurora Lyrics

Synced lyrics for YouTube Music, with a bit of taste.

Aurora Lyrics is a Manifest V3 extension that puts karaoke-grade lyrics next to
whatever you are playing — in the side panel, in a fullscreen composition, or in
a floating window — and hands you the tools to fix the timing when a source is
off.

---

## What you get

**Lyrics that actually follow the song.** Word-by-word karaoke, plain line
sync, or static text, all driven from live playback position rather than a
timer. Which engine draws which track is a setting, so the Apple Music look can
go on karaoke tracks if that is your thing.

**Sources, in order.** Aurora Community first, then Spicy Lyrics, then Unison,
then LRCLIB. The Spicy source is keyed by Spotify id, which YouTube Music does
not expose, so Aurora asks the Spicy search endpoint for it once per track and
only accepts a match it ranks exact (or likely, for small padding). If every
source misses, search LRCLIB yourself from the panel and apply a match by hand.

**Your own files.** Drop a TTML in and it renders immediately — temporarily, or
saved per track so it survives a reload. Export it back out untouched, or use
**Export + Sync** to bake the offset you dialled in into every `begin`/`end`.
Both are saved with the file's own mixed time formats intact.

**Timing you can fix.** Separate song and video offsets, a global nudge, a
pause-sync point for music videos that drift after a break, and offsets shared
by other people that load automatically for a video.

**Translation that never leaves the machine.** Optional English translation of
non-English lines, using Chrome's on-device translator (138+). No server.

## Fullscreen

Four compositions, one engine:

| | |
|---|---|
| **Hits** | Artwork, title, metadata and actions in a header, lyrics directly beneath. The cover-art default. |
| **Video + Lyrics** | The side-by-side framing, with the media column and the lyric column kept apart by construction. |
| **Video Background** | The video fills the screen and the lyrics float over it behind a soft shade. |
| **Stage** | Artwork or video bleeds to full height on one side, transport docked over it, lyrics on the other. |

Every composition sits on the **Kawarp** fluid backdrop, which is also what
drives the colour of the player bar elsewhere in the UI. Hover chrome (layout
switches, the queue, the jump-to-current pill) clears itself after a couple of
seconds without input, and the pointer goes with it.

## Add-ons

Everything ships inside the extension and installs from the in-app marketplace;
nothing else to download, and nothing needs an extension reload to switch on.

- **Kawarp** — the animated backdrop plus the artwork tinting it feeds
- **Aurora Lyrics** — the renderer itself, with its line engines and TTML settings
- **Aurora Flow** — smooth motion across the interface
- **Animated Artwork** — Apple Music's animated covers, where an album has one
- **Sleep Timer** — fade out, then pause (or stop at the end of the track)
- **PiP Lyrics** — always-on-top lyrics in a picture-in-picture window
- **Next Up** — what plays next, in the player bar
- **Song Notes** — a note per song, saved locally
- **Snippets** — track-change notification, centered home, Now Playing panel,
  arrow-key seeking

On a fresh profile the lyric renderer, Kawarp, Aurora Flow and Centered home
arrive enabled; the rest are opt-in.

## Installing

1. Open `chrome://extensions` (or `edge://`, `brave://`).
2. Turn on **Developer mode**.
3. **Load unpacked** → pick this folder, or `build/aurora-lyrics-<version>` if you
   packaged it.
4. Open YouTube Music. Lyrics live in the **Lyrics** tab beside the queue; the
   marketplace is the icon at the top-right of the page.

Editing source? Reload the extension at `chrome://extensions` **and** refresh the
YouTube Music tab. `src/content/content.js` runs in the isolated world and does
not pick up a change from a tab refresh alone.

## Building

The renderer is assembled from ordered fragments, so the injected script is
output, not source:

```sh
node scripts/build-aurora-lyrics.mjs          # writes src/extensions/aurora-lyrics.js
node scripts/build-aurora-lyrics.mjs --check  # fails if that file is stale
node scripts/package-extension.mjs           # refreshes build/aurora-lyrics-<version>
```

Never edit `src/extensions/aurora-lyrics.js` by hand — the build overwrites it.
Fragment order follows the build script rather than the numeric prefixes:
`21-boot.jsfrag` closes the shared IIFE, so it is concatenated after 22 and 23.

Two things that bite: `public-api.js` is a web-accessible resource, so a tab
refresh is enough for it, while `content.js` and `styles.css` need the full
extension reload. And some CSS lives inside JavaScript template literals — after
touching those, run `node --check <file>`, because one stray backtick ends the
literal early and takes the script with it.

There is no committed test suite. Behaviour is checked with throwaway
Node/headless-Chrome scripts while a change is being made; `--check` is the only
gate that stays.

## Credits

Aurora Lyrics stands on other people's work:

- **[Spicy Lyrics](https://github.com/Spikerko/spicy-lyrics)** by **Spikerko** —
  the Syllable renderer Aurora's engine is adapted from, and the API its
  community syncs come from. AGPL-3.0.
- **[Better Lyrics](https://github.com/better-lyrics/better-lyrics)**
  ([Chrome Web Store](https://chromewebstore.google.com/detail/better-lyrics-lyrics-for/effdbpeggelllpfkjppbokhmmiinhlmg)) —
  the extension Aurora started from, and the source of several interface ideas
  and conventions.
- **[Apple Music Like Lyrics (AMLL)](https://github.com/amll-dev/applemusic-like-lyrics)** —
  the Apple Music-style renderer behind the AMLL engine and its spring scrolling.

None of them endorse or support this project.

## License

**GNU Affero General Public License v3.0** — see [`LICENSE`](./LICENSE).

Aurora Lyrics is unofficial and unaffiliated with Spicy Lyrics, Spikerko, Better
Lyrics, AMLL or YouTube. The upstream licence and attribution travel with any
adapted build. Lyrics fetched through the Spicy Lyrics API are credited on
screen from each response's `source` field, and community syncs name and link
their uploader and maker.

## Support

Free now and free later. Tips keep it maintained; they do not unlock anything.

- Cash App: https://cash.app/$ajlol101
- PayPal: https://paypal.me/brandiluvsbts
