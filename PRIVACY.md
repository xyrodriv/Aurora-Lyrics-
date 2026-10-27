# Aurora Lyrics privacy policy

**Last updated:** 27 October 2026

Aurora Lyrics is a browser extension for YouTube Music. This document explains
what it does with your information.

The short version: **there is no account, no analytics, and no Aurora Lyrics
server.** Nothing about you is sent to us, because there is no "us" to send it
to.

## What we collect

**Nothing.** Aurora Lyrics has no backend, no telemetry, no crash reporting, and
no user accounts. We do not collect, store, or transmit personal information.

## What is stored on your device

Aurora Lyrics uses Chrome's `storage` permission to save the following **locally,
on your machine**:

- Your add-on settings and preferences.
- A cache of fetched lyrics, so tracks you have already played do not need to be
  looked up again.
- Any TTML lyric files you import, saved per track.

This data never leaves your browser. Uninstalling the extension removes it.

## What is transmitted, and to whom

To find lyrics for the track you are playing, Aurora Lyrics sends **the track's
metadata** (title, artist, album, and duration) to third-party lyric and
metadata services. This is necessary: a lyric service cannot return lyrics
without being told which song you want.

**No personal information is included.** No account, no identifiers, no browsing
history. The requests contain only what is needed to identify the song. They do
come from your browser, so the service answering one sees your IP address, the
same way it would for any page you opened.

The services contacted are:

| Service | Purpose |
|---|---|
| `api.spicylyrics.org` | Synced (TTML) lyrics |
| `lrclib.net` | Synced lyrics |
| `labs.api.listenbrainz.org` | Spotify-id resolution |
| `itunes.apple.com` | Artwork and metadata search |
| `api.deezer.com` | Artwork and metadata search |
| `musicbrainz.org` | Release lookup, for matching a track |
| `open.spotify.com` | Artwork and artist lookup (oEmbed) |
| `raw.githubusercontent.com` | Update check (release notes only) |
| `fonts.spikerko.org` | Lyrics typeface stylesheet |

Each of these is an independent third party with its own privacy policy. Aurora
Lyrics does not control them and is not responsible for their practices.

The update check requests a release-notes file and nothing else; it carries no
track metadata. The typeface stylesheet is requested only when the bundled copy
cannot be resolved, and is the same face the lyrics are drawn in.

## This website

The site you are reading is a static page. It sets no cookies, runs no
analytics, and serves its fonts and images from its own origin.

One panel on the home page lists who is online in the community Discord. When
that panel comes close to the viewport, the page asks `discord.com` for the
server's public widget data, and the avatars it draws come from
`cdn.discordapp.com`. Discord therefore sees that request and the IP address it
came from. Nothing travels the other way: no account, no identifier, and no
record of what you clicked. If you never scroll as far as the panel, the
request is never made.

## What we do NOT do

- No analytics, tracking pixels, or telemetry.
- No advertising.
- No selling or sharing of data.
- No reading of your browsing history, bookmarks, or other tabs.
- No access to any site other than `music.youtube.com` and the services listed
  above.

## Permissions, and why each is needed

- **`storage`**: saves your settings, lyric cache, and imported TTML locally on
  your device.
- **Host permissions**: allow the extension to request lyrics and track metadata
  from the services listed above, and to run on YouTube Music.

## Limited Use

Aurora Lyrics uses the information it accesses only to provide its single
purpose: synced lyrics. It does not sell that information, use it for
advertising, or transfer it to anyone except the lyric services listed above, or
where the law requires it. This use follows the Chrome Web Store User Data
Policy, including the Limited Use requirements.

## Children

Aurora Lyrics is not directed at children and collects no data from anyone,
including children under 13.

## Changes

If this policy changes, the "last updated" date above will change with it.

## Contact

Questions or concerns: open an issue at
[github.com/xyrodriv/Aurora-Lyrics-](https://github.com/xyrodriv/Aurora-Lyrics-/issues)
or join the [Discord](https://discord.gg/wsZxTSnaMa).
