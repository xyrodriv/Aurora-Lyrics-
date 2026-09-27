# Privacy Policy — Aurora Lyrics

**Last updated:** 26 September 2026

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

To find lyrics and artwork for the track you are playing, Aurora Lyrics sends
**the track's metadata** — title, artist, album, and duration — to third-party
lyric and artwork services. This is necessary: a lyric service cannot return
lyrics without being told which song you want.

**No personal information is included.** No account, no identifiers, no browsing
history. The requests contain only what is needed to identify the song.

The services contacted are:

| Service | Purpose |
|---|---|
| `api.spicylyrics.org` | Synced (TTML) lyrics |
| `lrclib.net` | Synced lyrics |
| `unison.boidu.dev` | Synced lyrics |
| `labs.api.listenbrainz.org` | Spotify-id resolution |
| `itunes.apple.com` | Artwork lookup |
| `api.deezer.com` | Artwork lookup |
| `musicbrainz.org` | Artwork lookup |
| `open.spotify.com` | Artwork lookup |

Each of these is an independent third party with its own privacy policy. Aurora
Lyrics does not control them and is not responsible for their practices.

## What we do NOT do

- No analytics, tracking pixels, or telemetry.
- No advertising.
- No selling or sharing of data.
- No reading of your browsing history, bookmarks, or other tabs.
- No access to any site other than `music.youtube.com` and the services listed
  above.

## Permissions, and why each is needed

- **`storage`** — saves your settings, lyric cache, and imported TTML locally on
  your device.
- **Host permissions** — allow the extension to request lyrics and artwork from
  the services listed above, and to run on YouTube Music.

## Children

Aurora Lyrics is not directed at children and collects no data from anyone,
including children under 13.

## Changes

If this policy changes, the "last updated" date above will change with it.

## Contact

Questions or concerns: **REPLACE_WITH_YOUR_CONTACT_EMAIL**
