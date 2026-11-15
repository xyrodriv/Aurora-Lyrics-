# Aurora Lyrics privacy policy

**Last updated:** 15 November 2026

Aurora Lyrics is a browser extension for YouTube Music. This document explains
what it does with your information.

The short version: **the extension has no account and there is no analytics.**
Aurora Lyrics reads a small public announcement feed, looks up community lyrics
by YouTube video ID, and sends one view report when a community sync starts.
Makers may optionally sign in on the website with Discord to customise their
public profile; that sign-in is described under [This website](#this-website).
The optional community-offset feature shares a timing value and an optional
display name; it is described under [Community offsets](#community-offsets).

## What we collect

**No account, analytics, or telemetry.** The optional community-offset feature
can store a display name you type and a random owner token on your device; no
Aurora account is created. Aurora Lyrics has no crash reporting and no user
accounts. The announcement relay stores only the announcement text you see
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

## Community offsets

In the Sync tab you can share one lyric-timing offset for the current YouTube
video and playback mode. Posting sends the YouTube video id, mode, offset value,
and optional title, artist, and display name to the Aurora Community API. The
display name is capped at 24 characters, defaults to `Anonymous`, and is shown
publicly next to the offset; it is not verified and creates no account. The API
stores the offset and a salted hash of a random owner token. The raw owner token
is returned once and kept only in your browser's `localStorage` so this browser
can Undo the post. A shared offset is public and is applied to other listeners'
tracks when they load the same video.

Anyone can report a shared offset from the extension. A report sends the offset
id, an optional reason you type, and a salted SHA-256 hash of your IP address to
the Aurora Community API; the raw IP is not stored. The report is mirrored into
the Aurora Lyrics Discord moderation channel with the offset's public details
(track, mode, value, display name, and id) so a moderator can Keep or Delete it.
Discord receives that message, as it would any message in that server. Keep
leaves the offset active; Delete removes it.

## What is stored on your device

Aurora Lyrics stores data locally with `chrome.storage.local` and with the
YouTube Music page's `localStorage`. It never uses `chrome.storage.sync`.

**`chrome.storage.local`** holds:

- Your add-on settings and preferences, including YouTube Music player
  preferences.
- Which announcements you have seen or dismissed.
- A cache of fetched lyrics, so tracks you have already played do not need to be
  looked up again.
- Any TTML lyric files you import, saved per track.
- The public display name, Discord avatar, and public profile URL of a signed-in
  maker, so the offset form can show who is posting and link to their profile.
  The avatar is not uploaded with the offset.

**The YouTube Music page's `localStorage`** holds:

- The optional community-offset display name, so you do not have to retype it.
- The owner token for an offset you posted, so Undo works after a reload.
- Per-video offset values and fullscreen layout/rating choices.
- Plain-text song notes you save for a track.

This data stays on your device. Only the posted community offset and its
optional display name are sent to the community API; if you are signed in as a
maker, only the display name is posted with an offset. Uninstalling the
extension removes the extension's local data; site data can be cleared from the
browser's site settings.

## What is transmitted, and to whom

To find lyrics for the track you are playing, Aurora Lyrics sends **the track's
metadata** (title, artist, album, and duration) to third-party lyric and
metadata services. This is necessary: a lyric service cannot return lyrics
without being told which song you want.

**For lyric lookups, no personal information is included.** No account, no
identifiers, no browsing history. The requests contain only what is needed to
identify the song. They do come from your browser, so the service answering one
sees your IP address, the same way it would for any page you opened.

Aurora Lyrics also reads a small public announcement feed. That is a plain GET
for a JSON file: no track metadata, no account, and no identifier. The feed
server sees your IP address, like any other request.

The services contacted are:

| Service | Purpose |
|---|---|
| `api.spicylyrics.org` | Synced (TTML) lyrics |
| `unison.boidu.dev` | Synced lyrics |
| `lrclib.net` | Synced lyrics |
| `aurora-community-api.mitsyonsp.workers.dev` | Aurora Community TTML, offsets, profiles, uploads and view counts |
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

## Data handled by the extension

For Chrome Web Store disclosure, the extension handles these categories:

- **Website content:** the video id, title, artist, album, and duration of the
  track playing on YouTube Music. They are read from the page and sent only to
  the lyric and metadata services listed above to find the track's lyrics.
- **Personally identifiable information, only if you choose to provide it:** a
  signed-in maker's public display name, avatar, and profile URL are stored
  locally for the offset form. A community-offset display name is optional and
  is sent publicly only when you post an offset.
- **User activity, limited to one anonymous view report:** when a
  community-synced track starts, the extension sends that upload's id so its
  aggregate view count can be updated. It contains no account, install id, or
  browsing history.
- **Local-only data:** settings, player preferences, announcements, lyric
  cache, imported TTML, song notes, offsets, fullscreen choices, and owner
  tokens. These stay on your device.

No health, financial, authentication, personal-communications, location, or web
history data is collected.

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
- No access to any site other than `music.youtube.com`, the Aurora Lyrics
  website for the optional maker identity handoff, and the services listed above.

## Permissions, and why each is needed

- **`storage`**: saves your settings, player preferences, lyric cache, imported
  TTML, which announcements you have seen or dismissed, and maker identity
  locally on your device.
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

Questions or concerns: email
[mitsyonsp@gmail.com](mailto:mitsyonsp@gmail.com), open an issue at
[github.com/xyrodriv/Aurora-Lyrics-](https://github.com/xyrodriv/Aurora-Lyrics-/issues)
or join the [Discord](https://discord.gg/wsZxTSnaMa).
