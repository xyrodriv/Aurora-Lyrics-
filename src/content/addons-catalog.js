/* Shared add-on catalogue.
 *
 * Loaded before content.js in the YouTube Music content script, and directly by
 * the standalone add-ons window. Keep it dependency-free: the entries use
 * chrome.runtime.getURL() and nothing else from the page.
 */
(() => {
"use strict";

const APPLE_THEME_ID = "apple-music";
const APPLE_THEME_NAME = "Apple Music Style";

const AVAILABLE = [
  {
    id: APPLE_THEME_ID,
    name: APPLE_THEME_NAME,
    author: "Aurora Lyrics",
    category: "Themes",
    stars: 5,
    tags: ["theme", "apple", "player bar", "glass", "type", "lyrics column"],
    description: "A look inspired by Apple Music, gathered on one card: a dark frosted player bar with the song info on the left and the transport centred, the wider lyrics column with its quiet tab strip, the Spicy Lyrics typeface and glass chrome. Nothing to install — every switch changes YouTube Music the moment you touch it.",
    version: "1.0.0",
    lastUpdated: "2026-10-23",
    settings: [],
  },
  // The Aurora CSS theme lived here. Its four player/chrome levers were
  // YouTube Music tweaks rather than a look, so they moved to the YouTube page
  // and then, with the type and the lyrics column, to the Apple Music card
  // above.
  {
    id: "ytmod-dynamic",
    name: "Kawarp",
    author: "Aurora Lyrics",
    category: "Themes",
    stars: 5,
    tags: ["theme", "dynamic", "kawarp", "artwork"],
    description: "Turns the playing track into a flowing, full-page Kawarp backdrop.",
    version: "1.0.0",
    lastUpdated: "2026-09-28",
    website: "https://kawarp.vercel.app/",
    jsUrl: chrome.runtime.getURL("src/extensions/dynamic.js"),
    settings: [
      { key: "brightness", label: "Brightness", min: 0.5, max: 1.2, step: 0.01, default: 0.75, display: "decimal" },
      { key: "saturation", label: "Saturation", min: 0.5, max: 2.5, step: 0.05, default: 1.25, display: "decimal" },
      { key: "blurPasses", label: "Blur passes", min: 2, max: 8, step: 1, default: 5, display: "passes" },
      { key: "warpIntensity", label: "Warp intensity", min: 0.2, max: 1, step: 0.05, default: 0.60, display: "decimal" },
      // Grain in Kawarp's final output pass. 0 turns it off; 0.1 is the shader's
      // maximum. 0.05 is the value the backdrop used before it became adjustable.
      { key: "dithering", label: "Dithering", min: 0, max: 0.1, step: 0.01, default: 0.02, display: "decimal" },
      // Music videos don't use Kawarp, so they get their own blurred backdrop
      // (drawn in aurora-lyrics.js). This slider is SEPARATE from "Brightness"
      // above (which drives Kawarp) and controls that MV backdrop's brightness.
      // dev-only. Consumed cross-add-on by Aurora Lyrics.
      { key: "backdropBrightness", label: "Music video backdrop brightness", min: 0, max: 2.0, step: 0.05, default: 1.15, display: "decimal", dev: true },
      // Music videos already always use the Kawarp backdrop,
      // so the old "Prefer Aurora Bloom for music videos" toggle was
      // redundant and has been removed.
      // Never sample the live video; keep the backdrop on the track's cover
      // art even for music videos.
      { key: "kawarpCoverArtOnly", label: "Cover art only (ignore video)", type: "toggle", default: false },
      // The Ambient add-on is this theme's other half: the same artwork, used
      // to tint the player bar and the sliders. It ships ON, which is what
      // Ambient's own default was.
      { key: "artworkAccent", label: "Artwork glow and accent colour", type: "toggle", default: true },
      // Contrast applies to the Kawarp canvas AND the blurred image, like
      // brightness/saturation above. Keep it above the collapsible custom
      // background block so it stays visible with the image controls closed.
      { key: "contrast", label: "Contrast", min: 0.6, max: 1.6, step: 0.01, default: 1.15, display: "decimal" },
      // Custom background. The blob lives in IndexedDB; the
      // key is only the boolean "an image is set and should be used".
      // The disclosure keeps the image controls out of the way until they are
      // needed, instead of letting them trail off the Kawarp sliders.
      { type: "header", label: "Custom background", collapsible: true },
      { key: "customBg", label: "Background image", type: "file", default: false },
      { key: "customBgKawarp", label: "Use Kawarp on the image", type: "toggle", default: true },
      { key: "customBgBlur", label: "Blur", min: 0, max: 60, step: 1, default: 24, display: "pixels", disabledWhen: "customBgKawarp" },
    ],
  },
  // Ambient used to live here as its own card. It read the same artwork the
  // backdrop does, so it is now a switch on Kawarp above. Its registry record is dropped by the orphan sweep at boot.
  {
    id: "ytmod-spicy-lyrics",
    name: "Aurora Lyrics",
    author: "Aurora Lyrics",
    category: "Extensions",
    stars: 5,
    tags: ["lyrics", "synced", "karaoke", "ttml"],
    // Terms of Service s5: naming the upstream as a dependency is allowed
    // ("uses or is built on Spicy Lyrics is fine"), but the listing must NOT
    // read as Spicy Lyrics' own product. That is carried by the DISCLAIMER,
    // which sits directly under the title, so the description no longer opens
    // with a second "Unofficial." — plus a github link to
    // THIS project rather than to Spikerko's repo, which would imply
    // origin/endorsement.
    // Rewritten in plain language: no renderer/API jargon.
    description: "Shows the lyrics of whatever you're playing, in time with the music — the words light up as they're sung. You can make the text bigger, change how it looks, and open a full-screen lyric view.",
    disclaimer: "Not affiliated with Spicy Lyrics · Unofficial",
    version: "0.2.0",
    lastUpdated: "2026-10-07",
    github: "https://github.com/xyrodriv/Aurora-Lyrics-",
    jsUrl: chrome.runtime.getURL("src/extensions/aurora-lyrics.js"),
    settings: [
      // Order is the reading order of the page. Everything WITHOUT `dev: true`
      // shows to everyone; everything with it is hidden until the 6-tap gesture
      // has been used — see visibleSettings(). Keep the non-dev entries first.
      // Lyric size ceiling is 600%. Default back to 130% —
        // 145% read too big; 130% is the intended look.
      { key: "size", label: "Lyric size", min: 0.75, max: 6.0, step: 0.05, default: 1.30, display: "percent" },
      // On-device English translation of non-English lines (Chrome 138+ desktop).
      // ON by default. It may download a language pack, but
      // only when a foreign line actually appears, and that is the song where
      // the second line earns its space.
      { key: "autoTranslate", label: "English translation of foreign lyrics", type: "toggle", default: true },
      { key: "legibilityBackdrop", label: "Dark shade behind lyrics", type: "toggle", default: false },
      // Fade the line that has just ended and recede it slightly, the way Apple
      // Music and Spicy Lyrics do. ON by default; off leaves finished lines
      // dim but in place. Spicy's version is fullscreen-only, while Aurora can
      // apply it in the panel too because the setting belongs to the lyrics.
      { key: "fadePreviousLines", label: "Fade away previous lines", note: "Spicy Lyrics renderer", type: "toggle", default: true },
      // In-page fullscreen: the overlay stays inside the tab,
      // so the tab strip, other tabs and the rest of the desktop keep working
      // while the fullscreen view is up. Off by default — the native behaviour
      // is unchanged until it is switched on.
      { key: "fullscreenInPage", label: "Fullscreen stays inside the tab", type: "toggle", default: false },
      // Joins each word into one whole-word fill — no per-syllable/letter karaoke
      // stepping, so a word lights up as a single unit. The Spicy Lyrics
      // "whole word" toggle.
      { key: "joinSyllables", label: "Join syllables into words", type: "toggle", default: false },
      // Nested under the toggle above. The whole-word join
      // already covered the background-vocal lines, so this exposes that
      // behaviour as a choice instead of hard-coding it. Rendered as an
      // indented child row that only exists while the parent is ON.
      { key: "joinBgSyllables", label: "Also join background lines", type: "toggle", default: true, childOf: "joinSyllables" },
      // Renderer: WHICH renderer draws WHICH kind of track. Each row is a named
      // choice rather than a boolean, so the order is explicit: Spicy Lyrics
      // first, Apple Music second, Better Lyrics third. Existing installs are
      // migrated from amllWordTracks/spicyLineTracks by the add-on. This lives
      // in its own card so the two choices read as one decision, not as two
      // unrelated toggles buried among the display settings.
      { type: "header", label: "Renderer" },
      { key: "wordRenderer", label: "Word-by-word", type: "select", default: "spicy", options: [
        { value: "spicy", label: "Spicy Lyrics" },
        { value: "amll", label: "Apple Music" },
        { value: "braccato", label: "Better Lyrics" },
      ] },
      // The wave is a Braccato line-builder switch: only offer it when Better
      // Lyrics actually owns word-by-word tracks. It sits directly under the
      // Word-by-word row and stays in the DOM collapsed, so switching to Better
      // Lyrics animates it open instead of snapping the list.
      // Both switches below belong to the Better Lyrics engine, not to a
      // particular way of slicing the track, so they show for either renderer:
      // the word-by-word one and the line-by-line one. Wavy letters is ON, so
      // the engine's letters carry their rise/fall by default.
      { key: "braccatoLetterWave", label: "Wavy letters", type: "toggle", default: true,
        visibleWhen: [
          { key: "wordRenderer", value: "braccato" },
          { key: "lineRenderer", value: "braccato" },
        ] },
      // ON by default. It was shipped off while the halos were
      // the suspected cost; A/B/A on the live page then measured glow-on FASTER
      // than glow-off (109 vs 94 fps), i.e. the halo cost is inside the noise
      // and the switch is a look preference, not a performance knob. Shown
      // whenever a Braccato renderer owns the track, either the word-by-word one
      // or the line-by-line one - both come out of the same engine.
      { key: "braccatoGlow", label: "Glow on sung words", type: "toggle", default: true,
        visibleWhen: [
          { key: "wordRenderer", value: "braccato" },
          { key: "lineRenderer", value: "braccato" },
        ] },
      // OFF by default: the engine's own face is what the lyrics have always
      // used, so nothing changes for anyone who does not ask. On, the lines
      // take Satoshi - the add-ons panel's face - through a class on the
      // panel (syncBraccatoPanelFlags).
      { key: "braccatoSatoshi", label: "Satoshi font", type: "toggle", default: false,
        visibleWhen: [
          { key: "wordRenderer", value: "braccato" },
          { key: "lineRenderer", value: "braccato" },
        ] },
      // Better Lyrics by default: line-synced tracks are its native
      // case (the engine derives one clean line fill), so that is the main
      // line-by-line renderer unless the user picks Spicy or Apple Music.
      { key: "lineRenderer", label: "Line-by-line", type: "select", default: "braccato", options: [
        { value: "spicy", label: "Spicy Lyrics" },
        { value: "amll", label: "Apple Music" },
        { value: "braccato", label: "Better Lyrics" },
      ] },
      { type: "header", label: "Scrolling" },
      // smoothScrolling back ON by default: the eased glide into the active
      // line reads better. NOT locked while Apple Music style
      // lyrics is on any more: that mode is per-track now, and a word-synced
      // track renders through the Spicy renderer, which honours this toggle.
      // (Line-synced tracks are drawn by the engine, which springs its own
      // scroll regardless.)
      // This one rides BOTH line renderers: with it off the panel deliberately
      // stops scrolling at all, so the note has to name both of them.
      { key: "smoothScrolling", label: "Smooth scrolling", note: "Spicy Lyrics + Better Lyrics", type: "toggle", default: true },
      // The early-scroll lead is the Spicy line index only - Better Lyrics
      // runs its own scroll plan from its tick.
      { key: "scrollLeadEnabled", label: "Start scrolling early", note: "Only for the Spicy Lyrics renderer", type: "toggle", default: false },
      { key: "scrollLeadMs", label: "Early scroll lead", min: 0, max: 800, step: 10, default: 250, display: "milliseconds" },
      // NOTE: "Use the Spicy Lyrics font across YouTube Music" used to live here.
      // It changes YouTube rather than the lyrics, so it now sits on the panel's
      // own YouTube page (see YT_PREFS_KEY below) where it survives uninstalling
      // this add-on.
      // ---- developer mode only ------------------------------------------
      { type: "header", label: "TTML settings" },
      { key: "bgOpacity", label: "Background vocals", min: 0.15, max: 1.0, step: 0.05, default: 1.0, display: "percent", dev: true },
      { key: "animation", label: "Animation intensity", min: 0, max: 1.25, step: 0.05, default: 1.0, display: "percent", dev: true },
      { key: "syllableAnimation", label: "Syllable animation intensity", min: 0, max: 1.5, step: 0.05, default: 1.0, display: "percent", dev: true },
      { key: "verticalAnimation", label: "Vertical animation intensity", min: 0, max: 3, step: 0.05, default: 1.25, display: "percent", dev: true },
      { key: "adaptiveSpacing", label: "Adaptive word spacing", type: "toggle", default: true, dev: true },
      // NOTE: the MV blurred-backdrop brightness slider lives in AURORA BLOOM
      // (ytmod-dynamic), not here — that is where the backdrop controls live.
      // Aurora Lyrics reads it cross-add-on (see handleHostMessage).
      // NOTE: "Vertical position" used to live here. It was removed as a setting
      // — the slider is gone and aurora-lyrics.js pins
      // the offset at its -80px default, so a value stored while the slider
      // existed cannot keep shifting the lyrics with no UI left to undo it.
      // NOTE: "Where lyrics come from" (source reordering) was removed. The resolver now uses a fixed priority: Aurora Community,
      // then Spicy Lyrics, then Unison, with LRCLIB last. lrc.red was retired
      // entirely on.
    ],
  },
  {
    id: "ytmod-smooth-motion",
    name: "Aurora Flow",
    author: "Aurora Lyrics",
    category: "Themes",
    stars: 5,
    tags: ["animation", "motion", "transitions", "ui", "smooth"],
    description: "Smooth, fluid animations throughout the interface.",
    version: "1.0.0",
    lastUpdated: "2026-09-28",
    jsUrl: chrome.runtime.getURL("src/extensions/smooth-motion.js"),
    // Toggles removed. Aurora Flow is always on;
    // every module (left panel reflow, search suggestions, page transitions,
    // micro-interactions) is force-enabled inside smooth-motion.js, so the
    // settings panel renders empty by design.
    settings: [],
  },
  {
    id: "ytmod-animated-art",
    name: "Animated Artwork",
    author: "Aurora Lyrics",
    category: "Extensions",
    stars: 5,
    tags: ["artwork", "cover", "animated", "apple music", "fullscreen"],
    description: "Apple Music's animated album covers, on the now-playing square and behind the fullscreen lyrics. Albums without one keep their normal cover, so nothing changes for them.",
    version: "1.0.0",
    lastUpdated: "2026-11-19",
    jsUrl: chrome.runtime.getURL("src/extensions/animated-art.js"),
    // No settings: installing and enabling the card IS the switch.
    settings: [],
  },
  {
    id: "ytmod-sleep-timer",
    name: "Sleep Timer",
    author: "Aurora Lyrics",
    category: "Extensions",
    stars: 5,
    tags: ["sleep", "timer", "fade", "volume", "playback"],
    description: "Fades the music out and optionally pauses it, so playback stops itself. Pick how long until the fade starts (or end of track), how long the fade takes, and whether to pause once it reaches silence.",
    version: "1.0.0",
    lastUpdated: "2026-09-16",
    jsUrl: chrome.runtime.getURL("src/extensions/sleep-timer.js"),
    // Settings removed: the add-on injects its own
    // control panel at the bottom-right player bar, so duplicating them here was
    // redundant. An empty array renders NO Settings section at all (same as
    // Ambient); the add-on's own internal defaults still apply.
    settings: [],
  },
  {
    id: "ytmod-pip-lyrics",
    name: "PiP Lyrics",
    author: "Aurora Lyrics",
    category: "Extensions",
    stars: 5,
    tags: ["lyrics", "pip", "picture-in-picture", "always-on-top", "window"],
    description: "Puts the synced lyrics in a floating always-on-top picture-in-picture window, so you can keep them on screen while you work in another tab. Reads the live lines from Aurora Lyrics, with word-level highlighting.",
    version: "1.0.0",
    lastUpdated: "2026-09-16",
    jsUrl: chrome.runtime.getURL("src/extensions/pip-lyrics.js"),
    // Preview clip removed: it showed real lyric text, and
    // redistributing copyrighted lyrics in the add-on art is avoidable risk.
    // The preview slot falls back to the brand mark.
    // Settings removed: the add-on's own defaults
    // (DEFAULTS = { master: true, showTransport: true }) are what we want, and
    // an empty array renders NO Settings section at all (same as Ambient).
    settings: [],
  },
  {
    id: "ytmod-next-up",
    name: "Next Up",
    author: "Aurora Lyrics",
    category: "Extensions",
    stars: 5,
    tags: ["queue", "next", "up-next", "player-bar", "playback"],
    description: "Shows what plays next in the player bar, with its cover art. Click it to skip straight to that track.",
    version: "2.0.0",
    lastUpdated: "2026-10-26",
    jsUrl: chrome.runtime.getURL("src/extensions/next-up.js"),
    settings: [
      { key: "showArt", label: "Show the cover art", type: "toggle", default: true },
    ],
  },
  {
    id: "ytmod-song-notes",
    name: "Song Notes",
    author: "Aurora Lyrics",
    category: "Extensions",
    stars: 5,
    tags: ["notes", "memo", "per-song", "utility"],
    description: "Save plain-text notes for any song and read them back the next time it plays. Notes are stored in your browser, keyed to the video, and the button shows a dot when the current song has one.",
    version: "1.0.0",
    lastUpdated: "2026-09-29",
    jsUrl: chrome.runtime.getURL("src/extensions/song-notes.js"),
    // No settings: the add-on is a single button plus its own popup, and empty
    // settings render no Settings section at all (same as Ambient / Sleep Timer).
    settings: [],
  },

  /* ---- Snippets ---------------------------------------------------------
     Small standalone tweaks that are NOT add-ons, but deliberately carry the
     SAME entry shape so they reuse the whole install / enable / disable
     pipeline (loadExtensionJS + the ytmod-ext enable/disable messages) and the
     same card UI. A snippet therefore runs only while it is INSTALLED and ON,
     exactly like an add-on — it is not an always-on tweak.
     The Snippets tab is just this category; nothing else special-cases it, so
     an empty category simply renders that tab's empty state.

     History — two attempts, both built and both parked, so neither gets
     re-tried from scratch:

     1. "Dislike: keep the song playing". YTM rates AND advances
        the queue in one motion, so keeping the song meant rating and then
        jumping straight back. It worked, but the track visibly switched away
        and back for a moment — too much churn for a regular user.

     2. "Song / Video toggle". YTM renders the premium Song/Video
        switch and merely HIDES it, so revealing it worked, and the mechanism
        turned out to be the redux action SET_PLAYBACK_CONTENT_MODE. But a free
        account's player ignores that action, and the counterpart version's
        video id is NOT anywhere in the page data (searched exhaustively), so
        the switch cannot be completed without resolving the song/video pair
        through the API.

     Both are backed up in .workbuddy-ai/backups/ and written up in the daily
     logs and SNIPPET-IDEAS.txt. */
  {
    id: "snippet-track-toast",
    name: "Track-change notification",
    author: "Aurora Lyrics",
    category: "Snippets",
    stars: 5,
    tags: ["notification", "toast", "track change", "now playing"],
    description: "Shows a notification with the song, artist and cover art whenever a new track starts.",
    version: "0.1.0",
    lastUpdated: "2026-10-08",
    jsUrl: chrome.runtime.getURL("src/extensions/snippet-track-toast.js"),
    // No art: the card falls back to its monogram tile.
    settings: [],
  },
  {
    id: "snippet-centered-home",
    name: "Centered home",
    author: "Aurora Lyrics",
    category: "Snippets",
    stars: 5,
    tags: ["home", "layout", "centered", "headers", "chips", "sidebar"],
    description: "Centers the home page section headers and the filter chips.",
    version: "0.1.0",
    lastUpdated: "2026-10-19",
    jsUrl: chrome.runtime.getURL("src/extensions/snippet-centered-home.js"),
    // No art: the card falls back to its monogram tile.
    settings: [],
  },
  {
    id: "snippet-npv-panel",
    name: "Now Playing panel (NPV)",
    author: "Aurora Lyrics",
    category: "Snippets",
    stars: 5,
    tags: ["now playing", "npv", "panel", "sidebar", "cover art"],
    description: "Adds a side panel with cover art, song details and live lyrics. It works on the home page and in the song view, and collapses to a thin edge when you want the space back.",
    version: "0.1.0",
    lastUpdated: "2026-10-18",
    jsUrl: chrome.runtime.getURL("src/extensions/snippet-npv-panel.js"),
    // No art: the card falls back to its monogram tile.
    settings: [
      // Lives here rather than on the panel itself: it is a
      // preference, not a per-session action.
      { key: "kawarp", label: "Ambient background", type: "toggle", default: true },
    ],
  },
  {
    id: "snippet-arrow-seek",
    name: "Arrow-key seeking",
    author: "Aurora Lyrics",
    category: "Snippets",
    stars: 5,
    tags: ["keyboard", "seek", "shortcuts", "playback"],
    description: "YouTube Music ignores the arrow keys on the player, so this claims them: Left/Right seek 5 seconds, hold Shift for 15. Typing is never intercepted.",
    version: "0.1.0",
    lastUpdated: "2026-10-20",
    jsUrl: chrome.runtime.getURL("src/extensions/snippet-arrow-seek.js"),
    settings: [
      // Seconds per ArrowLeft/ArrowRight press (Shift multiplies by 3).
      { key: "step", label: "Skip step", min: 1, max: 30, step: 1, default: 5, display: "seconds" },
    ],
  },
];

window.AURORA_ADDONS = { APPLE_THEME_ID, APPLE_THEME_NAME, AVAILABLE };
})();
