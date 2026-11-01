# Aurora Lyrics privacy policy

**Last updated:** 1 November 2026

Aurora Lyrics is a browser extension for YouTube Music. This document explains
what it does with your information.

The short version: **the extension has no account and there is no analytics.**
Aurora Lyrics reads a small public announcement feed, looks up community lyrics
by YouTube video ID, and sends one view report when a community sync starts.
Makers may optionally sign in on the website with Discord to customise their
public profile; that sign-in is described under [This website](#this-website).

## What we collect

**Nothing personal.** Aurora Lyrics has no telemetry, no crash reporting, and no
user accounts. The announcement relay stores only the announcement text you see
in the app; it does not receive anything about you. Community lyric lookups send
the current YouTube video ID and nothing else about you. When a community-synced
track starts playing, the extension sends one report containing that upload's
id so its public profile can count the view. There is no account, install id, or
other track metadata in that report.

## Community uploads

Using `/upload-ttml` in the Aurora Lyrics Discord server is optional. The bot
sends your Discord user ID, display name, and avatar URL to the Aurora Community
API along with the TTML file and track link. Approved uploads display your
display name and avatar publicly in the lyrics panel, and may appear on a public
maker profile with the aggregate views for each synced track. A maker may also
sign in to add optional social links and choose a profile background; those
details are public. Staff can remove an upload; ask in Discord if you want one
taken down. Do not upload lyrics or a sync you do not have permission to share.

## What is stored on your device

Aurora Lyrics uses Chrome's `storage` permission to save the following **locally,
on your machine**:

- Your add-on settings and preferences.
- Which announcements you have seen or dismissed.
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

Aurora Lyrics also reads a small public announcement feed. That is a plain GET
for a JSON file: no track metadata, no account, and no identifier. The feed
server sees your IP address, like any other request.

The services contacted are:

| Service | Purpose |
|---|---|
| `api.spicylyrics.org` | Synced (TTML) lyrics |
| `lrclib.net` | Synced lyrics |
| `site-5aa52a9653ee459eaa8c6b433dad2937.freebuff.page` | Aurora Community TTML, profiles, uploads and view counts |
| `discord.com` | Optional Discord sign-in for maker profiles |
| `cdn.discordapp.com` | Community uploader and maker avatars |
| `labs.api.listenbrainz.org` | Spotify-id resolution |
| `itunes.apple.com` | Artwork and metadata search |
| `api.deezer.com` | Artwork and metadata search |
| `musicbrainz.org` | Release lookup, for matching a track |
| `open.spotify.com` | Artwork and artist lookup (oEmbed) |
| `raw.githubusercontent.com` | Update check (release notes only) |
| `site-ecb11ddf30644a24b5d9f12c57480dbd.freebuff.page` | Announcements (read-only) |
| `fonts.spikerko.org` | Lyrics typeface stylesheet |

The lyrics and metadata services are independent third parties with their own
privacy policies. Aurora Lyrics does not control them and is not responsible
for their practices. The announcement relay is operated for Aurora Lyrics and
stores only the announcement text; it receives nothing about you. The Aurora
Community API is also operated for Aurora Lyrics; it serves community syncs
keyed by YouTube video ID, builds public maker profiles, and records aggregate
view counts. The view report contains the upload id and no account, install
identifier, or other track metadata; like any request it carries an IP address.
The count is an aggregate view total, not a unique-listener or profile-visit
metric. Community credits may load an uploader's Discord avatar from
`cdn.discordapp.com`; that image request goes to Discord and carries your IP
address, like any other image request.

The update check requests a release-notes file and nothing else; it carries no
track metadata. The announcement feed is also read-only and carries nothing
about you. The typeface stylesheet is requested only when the bundled copy
cannot be resolved, and is the same face the lyrics are drawn in.

## This website

The site you are reading is a static page. It sets no cookies, runs no
analytics, and serves its fonts and images from its own origin. A community
profile page fetches the public maker profile from the Aurora Community API;
that request carries no account or persistent identifier. Profile avatars load
from `cdn.discordapp.com`, which carries your IP address like any image request.

If you are a maker with an approved community upload, you may optionally sign in
with Discord to edit your profile. During sign-in, the Aurora Community API
receives your Discord user id, display name, and avatar. It stores that id,
name, and avatar, plus the social links and background you choose, so it can
render your public profile. The sign-in session is stored as a token in this
browser's `localStorage`; it is not a cookie and is sent only to the Aurora
Community API for profile requests, not to Discord or other services. You can
clear it by signing out or clearing site data. Signing in is not required to
read any profile.

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

- **`storage`**: saves your settings, lyric cache, imported TTML, and which
  announcements you have seen or dismissed locally on your device.
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
