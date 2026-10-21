/* Aurora Lyrics — Share a lyric (add-on)
   ---------------------------------------------------------------------------
   Renders the line you are currently on as a square 1080x1080 PNG and hands it
   to the browser as a download. Nothing leaves the machine: the card is drawn
   on a <canvas> and saved locally, so this stays inside the project's
   "no backend, no account" promise (see PRIVACY.md).

   WHY A SEPARATE ADD-ON, and why it never touches aurora-lyrics.js:
   the synced renderer already publishes everything a consumer needs on the
   inter-add-on bus (public-api.js, "Topics in use"):
       lyrics:lines   { trackKey, videoId, title, artist, lines:[{ text, ... }] }
       lyrics:active  { trackKey, index }
   pip-lyrics.js is the precedent — it reads the same bus from its own file.
   Subscribing with { replay: true } matters for the same reason it does there:
   the topics only fire when the lyrics are (re)built, so an add-on that starts
   mid-track would otherwise sit on an empty view forever.

   THE ARTWORK IS CONDITIONAL, and that is deliberate. Drawing a cross-origin
   image onto a canvas TAINTS it, and toBlob() then throws SecurityError. So the
   art is loaded with crossOrigin="anonymous": if the CDN sends
   Access-Control-Allow-Origin the image arrives clean, and if it does not the
   load FAILS (onerror) and we fall back to a gradient. Either way you get a
   card — only the artwork is optional. We deliberately do NOT add the image
   CDNs to host_permissions for this: that changes the permission set, and
   Chrome can disable the extension for existing users pending re-consent.

   Font: the card must use SpicyLyrics, so document.fonts.load() runs BEFORE the
   first fillText. Canvas silently renders in a fallback font otherwise, which
   looks like a styling bug rather than a load-order one.
   --------------------------------------------------------------------------- */
(() => {
  "use strict";

  const EXT_ID = "ytmod-share-lyric";
  // Output sizes. `portrait` is 3:4 — the standard portrait post, and the shape
  // the marketplace showcase wants, since a square card gets cropped in a 3:4
  // thumb. The layout is driven by W and H SEPARATELY, never by one square S:
  // a single dimension would put the artwork and the footer at the wrong height
  // on the taller card.
  const CARD_ASPECTS = {
    square: { w: 1080, h: 1080 },
    portrait: { w: 1080, h: 1440 },
  };
  const FONT_STACK = '"SpicyLyrics", "Roboto", "YouTube Sans", system-ui, -apple-system, sans-serif';

  // Card layout (AJ, 2026-09-28). LEFT-ANCHORED, not centred: artwork on the
  // left, the lyric in a right-hand column, then a footer with the track on the
  // left and the attribution on the right. Everything is MEASURED before it is
  // drawn, so the rhythm holds for a 1-line or a 3-line lyric.
  // The lyric hangs off the artwork's TOP by a fixed offset rather than being
  // centred on the artwork's span: that is what keeps it reading as "next to
  // it, but a bit lower" no matter how many rows the line wraps to (AJ,
  // 2026-09-28 — a centre-based rule drifted up on a 1-line lyric).
  const PAD = 76;
  const ART_SIDE = 360;
  const ART_TOP = 96;           // top-anchored, NOT vertically centred
  // 3:4 has far more vertical room than square, so the artwork GROWS to close the
  // gap that otherwise sits between it and the lyric (AJ, 2026-09-28). Sized from
  // where the lyric actually lands, so the gap is constant whatever the line
  // count does; square keeps its exact size.
  const ART_SIDE_PORTRAIT_MAX = 620;
  const ART_LYRIC_GAP = 80;

  // Demo card, for the "Try it" chip and for when the share button is pressed
  // with no lyrics loaded — so the feature is reachable at any time.
  const DEMO_TEXT = "Try out Share a Lyric!";
  const DEMO_TITLE = "Share a Lyric";
  const DEMO_ARTIST = "Aurora Lyrics";
  const DEMO_STAMP = "0:00";
  const LYRIC_START_SIZE = 78;
  const LYRIC_MAX_LINES = 3;
  const LYRIC_SHIFT = 110;      // block sits this far BELOW the geometric centre
  const TRACK_SIZE = 34;
  const ATTR_SIZE = 26;
  const ATTR_H = 32;
  const ATTR_TEXT = "Aurora Lyrics for YouTube Music";
  const ATTR_RESERVE = 400;   // horizontal room kept clear for the attribution
  const FOOTER_GAP = 48;      // body -> footer

  // Top-right badge: the timestamp of the ACTIVE line — where in the track this
  // lyric is sung. It also counterweights the artwork in the opposite corner,
  // which was the largest void on the card (AJ, 2026-09-28).
  const BADGE_SIZE = 26;
  const BADGE_PAD_X = 22;
  const BADGE_PAD_Y = 13;
  const BADGE_TRACKING = "1px";
  // Hairline inset frame. Set to 0 to disable. This is the cheapest way to make
  // an airy layout read as DELIBERATE margin instead of empty space — it gives
  // the card edges structure, which is most of what "something feels off" is.
  const FRAME_INSET = 28;

  // One filled 24x24 path (Material "share") — addPlayerBarButton takes a single
  // path `d`, so the icon has to be a one-path glyph.
  const ICON_SHARE =
    "M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11" +
    "c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81" +
    "C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16" +
    "c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z";

  const DEFAULT_SETTINGS = {
    showArt: true,
    showTrackInfo: true,
    showTimestamp: true,
    portrait: false,
    video: false,
    // Use the frame currently on screen instead of the thumbnail (MV only).
    mvFrame: false,
  };

  const STYLE_ID = "ym-share-style";
  const OVERLAY_ID = "ym-share-overlay";

  // Kawarp — the same vendored WebGL module Aurora Bloom and the fullscreen
  // backdrop use, resolved from this script's own URL (the pattern all three
  // consumers share). Options match FS_KAWARP_OPTIONS so the exported video
  // looks like the extension's real backdrop, not a second interpretation.
  const SCRIPT_URL = (document.currentScript && document.currentScript.src) || "";
  const KAWARP_CORE_URL = SCRIPT_URL ? new URL("kawarp-core.js", SCRIPT_URL).href : "";
  // The extension's own logo, for the demo card. This add-on runs in the PAGE
  // world and has no chrome.* API, so SCRIPT_URL is the only route to an
  // extension asset — the same trick kawarp-core.js is loaded with. It is already
  // listed in web_accessible_resources.
  const LOGO_URL = SCRIPT_URL ? new URL("../../assets/manifest-logo.webp", SCRIPT_URL).href : "";
  const KAWARP_OPTIONS = {
    warpIntensity: 1,
    blurPasses: 6,
    animationSpeed: 0.1,
    saturation: 1.5,
    dithering: 0.008,
    transitionDuration: 1000,
    tintIntensity: 0,
    scale: 1,
  };

  const VIDEO_MS = 4000;
  const VIDEO_FPS = 30;
  const VIDEO_BITRATE = 8000000;
  // ⭐ Kawarp crossfades its album in, so its first ~1s of output is a fade from
  // BLACK — recording straight away opened the clip on a black frame (AJ's
  // screenshot). Warm up first, but HOLD for at least the crossfade duration:
  // breaking the moment the canvas stopped being pure black caught the fade
  // mid-way, which is the black blob + dithering noise AJ saw in the first
  // second (2026-09-28). Ceiling so a stubborn case cannot hang.
  const KAWARP_WARMUP_MIN_MS = 1200; // > transitionDuration (1000)
  const KAWARP_WARMUP_MAX_MS = 2600;
  // ⭐⭐ THE BACKDROP CLOCK IS DRIVEN BY US, not by Kawarp's own rAF loop.
  // `animationSpeed` is clamped to 5 by its setter (kawarp-core.js:321), which
  // caps how fast the backdrop can EVER move — 3.5 already read as too slow (AJ,
  // 2026-09-28). But `render(time, timestamp)` takes the animation clock as an
  // ARGUMENT (kawarp-core.js:600), so calling it directly sidesteps the clamp
  // completely and any speed is reachable.
  // NOTE: AJ's "record 8s then speed it up to 4s" is mathematically the same
  // thing — the frames are synthesised here, so compressing time is exactly
  // advancing the clock faster. One mechanism, not two.
  const KAWARP_CLOCK_PLAYING = 8; // ~2.3x the old 3.5, and 8x the extension's own backdrop
  const KAWARP_CLOCK_PAUSED = 0.8;
  // Probed at runtime with isTypeSupported: MediaRecorder's codec support varies
  // by Chrome build. MP4 first, because it matches the project's other showcase
  // clips; WebM is the reliable fallback.
  const VIDEO_MIME_CANDIDATES = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];

  // Preview popup. Same pattern as sleep-timer.js: the add-on owns its own
  // <style> element and removes it on teardown.
  // NOTE: this literal is guarded by .workbuddy-ai/scratch/check-css-template.mjs
  // — a stray backtick here truncates the CSS and the leftover text is parsed as
  // JS, which can still pass `node --check` while killing the whole add-on.
  const CSS = `
#ym-share-overlay {
  position: fixed; inset: 0; z-index: 2147483600;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: rgba(4, 6, 12, .72);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  animation: ym-share-in .18s ease;
}
@keyframes ym-share-in { from { opacity: 0; } to { opacity: 1; } }
#ym-share-overlay .ym-share-panel {
  display: flex; flex-direction: column; gap: 16px;
  padding: 16px;
  border-radius: 20px;
  background: rgba(16, 18, 24, .96);
  border: 1px solid rgba(255, 255, 255, .14);
  box-shadow: 0 24px 70px rgba(0, 0, 0, .55);
  max-height: calc(100vh - 48px);
  font-family: "Roboto", "YouTube Sans", system-ui, -apple-system, sans-serif;
}
/* Media sizing lives on .ym-share-stage below: the card is shown at its own
   aspect ratio and is never cropped, and the stage carries the box so the size
   can transition. */
#ym-share-overlay .ym-share-video { background: #05070c; }
/* The STAGE owns the card's size. That is what lets a square <-> 3:4 switch
   animate instead of snapping, and it gives the spinner a correctly-sized box
   before any media exists. JS sets the px size from the current aspect. */
#ym-share-overlay .ym-share-stage {
  position: relative;
  display: flex; align-items: center; justify-content: center;
  min-height: 140px;
  transition: width .34s cubic-bezier(.2,.7,.3,1), height .34s cubic-bezier(.2,.7,.3,1);
}
#ym-share-overlay .ym-share-img,
#ym-share-overlay .ym-share-video {
  display: block;
  width: 100%; height: 100%;
  max-width: 100%; max-height: 100%;
  border-radius: 12px;
  object-fit: contain;
}
#ym-share-overlay .ym-share-body {
  display: flex;
  transition: opacity .18s ease;
}
#ym-share-overlay .ym-share-panel.loading .ym-share-body { opacity: .28; }
#ym-share-overlay .ym-share-spinner {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  opacity: 0;
  transition: opacity .18s ease;
  pointer-events: none;
}
#ym-share-overlay .ym-share-panel.loading .ym-share-spinner { opacity: 1; }
#ym-share-overlay .ym-share-ring {
  width: 38px; height: 38px; border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, .18);
  border-top-color: rgba(255, 255, 255, .88);
  animation: ym-share-spin .8s linear infinite;
}
@keyframes ym-share-spin { to { transform: rotate(360deg); } }
/* Reserved height so the panel does not jump when the status line clears. */
#ym-share-overlay .ym-share-status {
  min-height: 20px;
  font-size: 13px; font-weight: 600; letter-spacing: .02em;
  color: rgba(255, 255, 255, .72);
  text-align: center;
}
#ym-share-overlay .ym-share-actions {
  display: flex; gap: 10px; justify-content: flex-end; align-items: center;
}
#ym-share-overlay .ym-share-btn {
  appearance: none; cursor: pointer;
  padding: 10px 18px; border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, .16);
  background: rgba(255, 255, 255, .08);
  color: #f1f1f1;
  font: inherit; font-size: 14px; font-weight: 600;
  transition: background .15s ease, transform .1s ease;
}
#ym-share-overlay .ym-share-btn:hover { background: rgba(255, 255, 255, .16); }
#ym-share-overlay .ym-share-btn:active { transform: scale(.97); }
#ym-share-overlay .ym-share-btn[disabled] {
  opacity: .45; cursor: default; transform: none;
}
#ym-share-overlay .ym-share-btn[disabled]:hover { background: rgba(255, 255, 255, .08); }
#ym-share-overlay .ym-share-primary[disabled]:hover { background: #f1f1f1; }
/* Shape + output toggles live IN the popup rather than in the marketplace
   settings list, so the choice is where the user already is (AJ, 2026-09-28). */
#ym-share-overlay .ym-share-toggle {
  appearance: none; cursor: pointer;
  padding: 8px 14px; border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, .16);
  background: rgba(255, 255, 255, .06);
  color: rgba(255, 255, 255, .72);
  font: inherit; font-size: 13px; font-weight: 600;
  transition: background .15s ease, color .15s ease, border-color .15s ease;
}
#ym-share-overlay .ym-share-toggle:hover { background: rgba(255, 255, 255, .14); }
#ym-share-overlay .ym-share-toggle[data-on="1"] {
  background: rgba(255, 255, 255, .92); color: #0d0f14; border-color: transparent;
}
/* Absorbs the free space so the toggles sit left and the buttons sit right. */
#ym-share-overlay .ym-share-spacer { flex: 1 1 auto; }
#ym-share-overlay .ym-share-primary {
  background: #f1f1f1; color: #0d0f14; border-color: transparent;
}
#ym-share-overlay .ym-share-primary:hover { background: #ffffff; }
@media (prefers-reduced-motion: reduce) {
  #ym-share-overlay { animation: none; }
  #ym-share-overlay .ym-share-btn { transition: none; }
  #ym-share-overlay .ym-share-toggle { transition: none; }
  #ym-share-overlay .ym-share-body,
  #ym-share-overlay .ym-share-spinner { transition: none; }
  /* A static, brighter ring instead of a spin. */
  #ym-share-overlay .ym-share-ring {
    animation: none;
    border-color: rgba(255, 255, 255, .55);
  }
}
`;

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let btnHandle = null;
  let lines = [];
  let meta = { title: "", artist: "", videoId: "" };
  let activeIndex = -1;
  let syncOffsetMs = 0; // lyric clock offset from lyrics:sync, for time-based active line
  let unsubLines = null;
  let unsubActive = null;
  let unsubSync = null;
  let busy = false;
  let overlayEl = null;
  let previewUrl = null;
  let previewBody = null;
  let previewStatus = null;
  let previewDownload = null;
  let previewPanel = null;
  let previewStage = null;
  let previewPortraitToggle = null;
  let previewVideoToggle = null;
  let previewFrameToggle = null;
  let previewFilename = "";
  let recordingActive = false;
  let recordingCancelled = false;
  // Kawarp's animation clock, advanced by driveKawarp() instead of its own loop.
  let kawarpClock = 0;
  let kawarpClockAt = 0;
  // What the popup is currently showing, so its shape/output toggles can
  // re-render without the caller having to pass everything again.
  let previewText = "";
  let previewInfo = null;
  // Invalidates an in-flight render when the toggles are flipped again mid-way.
  let renderSeq = 0;
  // A recorded clip, if one has been made for the CURRENT preview. Cleared by any
  // re-render, because a different shape means the clip is stale.
  let previewVideoUrl = null;
  let previewVideoFilename = "";
  // True while the preview is showing the demo card rather than a real track.
  let demoMode = false;

  /* ---- DOM helper ----------------------------------------------------------
     Trusted Types is enforced in this project: never innerHTML /
     insertAdjacentHTML / DOMParser. Build nodes and set textContent. */
  function makeEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  }

  function whenYTMod(cb) {
    if (window.YTMod && window.YTMod.bus) { cb(); return; }
    let tries = 0;
    const timer = setInterval(() => {
      if (window.YTMod && window.YTMod.bus) { clearInterval(timer); cb(); return; }
      if (++tries > 200) clearInterval(timer); // ~20s, then give up quietly
    }, 100);
  }

  function currentTrack() {
    try {
      const p = window.YTMod && window.YTMod.player;
      return p && typeof p.getTrack === "function" ? p.getTrack() : null;
    } catch (_) {
      return null;
    }
  }

  // Mirrors dynamic.js's syncKawarpPlaybackState: `isPaused()` can return null
  // (before the bar renders), and null must read as PLAYING rather than paused,
  // so the backdrop is never needlessly slowed.
  function isPlaybackPaused() {
    try {
      const p = window.YTMod && window.YTMod.player;
      if (p && typeof p.isPaused === "function") return p.isPaused() === true;
    } catch (_) {}
    return false;
  }

  // The CDN accepts a trailing =wN-hN hint and resizes server-side, so the same
  // helper the lyrics panel uses gets us a card-sized source instead of a
  // 120px thumbnail stretched over 1080.
  function hiResArt(url) {
    if (!url || typeof url !== "string") return url || "";
    if (/=w\d+(-h\d+)?/.test(url)) return url.replace(/=w\d+(-h\d+)?/, "=w1024-h1024");
    return url + "=w1024-h1024";
  }

  // The frame currently on screen, as a canvas the card can drawImage() later.
  // ⭐ YouTube feeds the video through MediaSource as a same-origin blob: URL, so
  // drawImage(video) does NOT taint the card canvas and toBlob() keeps working.
  // If that assumption ever breaks (no video element, zero dimensions, or a
  // genuinely cross-origin source) the getImageData probe throws and the caller
  // falls back to the thumbnail instead of killing the export.
  function grabVideoFrame() {
    try {
      const video = document.querySelector("ytmusic-player video.html5-main-video")
        || document.querySelector("video.html5-main-video");
      if (!video || !video.videoWidth || !video.videoHeight) return null;
      // Cover-crop to a square so neither the square nor the 3:4 card distorts it.
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const side = Math.min(vw, vh);
      const canvas = makeEl("canvas");
      canvas.width = 1024;
      canvas.height = 1024;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(
        video,
        (vw - side) / 2, (vh - side) / 2, side, side,
        0, 0, canvas.width, canvas.height
      );
      ctx.getImageData(0, 0, 1, 1); // taint probe — throws on a cross-origin frame
      return canvas;
    } catch (_) {
      return null;
    }
  }

  // Single entry point for the card's artwork, so both render paths (still and
  // video export) honour the MV-frame toggle the same way (AJ, 2026-10-20).
  async function loadCardArt(info) {
    if (!settings.showArt) return null;
    if (settings.mvFrame) {
      const frame = grabVideoFrame();
      if (frame) return frame;
    }
    return loadArt(hiResArt(info.artworkUrl));
  }

  // Loads the extension's logo and verifies it is safe to composite.
  // ⭐ A chrome-extension:// image is cross-origin from the page, and drawing a
  // TAINTED image onto the card canvas would make toBlob() throw — killing the
  // whole export. `crossOrigin="anonymous"` means a successful load already has
  // CORS clearance, and the scratch-canvas read below is belt-and-braces: if
  // getImageData throws, the logo is unusable and the caller falls back.
  async function loadLogoArt() {
    if (!LOGO_URL) return null;
    const img = await loadArt(LOGO_URL);
    if (!img) return null;
    try {
      const probe = makeEl("canvas");
      probe.width = 8;
      probe.height = 8;
      const g = probe.getContext("2d");
      g.drawImage(img, 0, 0, 8, 8);
      g.getImageData(0, 0, 1, 1);
    } catch (_) {
      return null;
    }
    return img;
  }

  // Placeholder "artwork" for the demo card, returned as a CANVAS so it flows
  // through the exact same path as real album art — cover-fit backdrop, rounded
  // inset — with no special cases anywhere in the drawing code.
  async function makeDemoArt() {
    const SIDE = 512;
    const canvas = makeEl("canvas");
    canvas.width = SIDE;
    canvas.height = SIDE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const grad = ctx.createLinearGradient(0, 0, SIDE, SIDE);
    grad.addColorStop(0, "#2b3a63");
    grad.addColorStop(.5, "#4a2c63");
    grad.addColorStop(1, "#16233c");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SIDE, SIDE);

    const logo = await loadLogoArt();
    if (logo) {
      // Fit the logo into the middle ~62% of the tile, preserving its ratio.
      const box = SIDE * 0.62;
      const scale = Math.min(box / logo.width, box / logo.height);
      const w = logo.width * scale;
      const h = logo.height * scale;
      ctx.drawImage(logo, (SIDE - w) / 2, (SIDE - h) / 2, w, h);
      return canvas;
    }

    // Fallback: the share glyph on concentric rings, drawn with canvas paths.
    ctx.strokeStyle = "rgba(255, 255, 255, .10)";
    ctx.lineWidth = 3;
    for (let r = 90; r <= 230; r += 46) {
      ctx.beginPath();
      ctx.arc(SIDE / 2, SIDE / 2, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(SIDE / 2, SIDE / 2);
    ctx.scale(7, 7);
    ctx.translate(-12, -12);
    ctx.fillStyle = "rgba(255, 255, 255, .92)";
    ctx.fill(new Path2D(ICON_SHARE));
    ctx.restore();
    return canvas;
  }

  /* ---- live lyric state (bus) --------------------------------------------- */
  function onLines(payload) {
    if (!payload) return;
    lines = Array.isArray(payload.lines) ? payload.lines : [];
    meta = {
      title: payload.title || "",
      artist: payload.artist || "",
      videoId: payload.videoId || "",
    };
    if (activeIndex >= lines.length) activeIndex = -1;
  }

  // Where in the track the active line is sung. Taken from the LINE's own
  // startMs rather than the live playhead: the line's start is stable and is
  // what the card is actually about, whereas the playhead keeps moving while
  // the card is being built.
  function timestampLabel() {
    // The demo card has no real lines, so it carries a fixed stamp.
    if (demoMode) return DEMO_STAMP;
    if (!lines.length) return "";
    const i = activeLineIndexByTime();
    if (i < 0) return "";
    const ms = Number(lines[i].startMs);
    if (!Number.isFinite(ms) || ms < 0) return "";
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
  }

  function onActive(payload) {
    if (!payload) return;
    // Kept for parity; the active line is now resolved by timestamp
    // (see activeLineIndexByTime). The bus index is into modelLines, which
    // includes DotLine entries the lines payload excludes — see pickText.
    activeIndex = Number.isFinite(payload.index) ? payload.index : -1;
  }

  function onSync(payload) {
    if (payload && Number.isFinite(payload.offsetMs)) syncOffsetMs = payload.offsetMs;
  }

  // Live lyric position in MS: the player's raw playhead minus the lyric clock
  // offset published on lyrics:sync (AJ, 2026-09-29). NOTE: ytmusic-player has NO
  // getCurrentTime() — the codebase reads the playhead via player.getPositionMs()
  // (public-api.js). Using the wrong method left t at 0, so every card fell through
  // to the first line.
  function currentLyricPositionMs() {
    let t = 0;
    try {
      const p = window.YTMod && window.YTMod.player;
      if (p && typeof p.getPositionMs === "function") t = p.getPositionMs();
    } catch (_) {}
    return Math.max(0, t - syncOffsetMs);
  }

  // The line to render — EXACTLY the active one, nothing else.
  // Resolved by TIMESTAMP against this add-on's own `lines` array (AJ, 2026-09-29):
  // the bus `lyrics:active` index is into spicy-lyrics's modelLines, which INCLUDES
  // DotLine ("…") entries the lines payload excludes (they have no lead), so
  // trusting it shifted every card to the wrong line ("most of the time the line
  // after"). Mapping the live playhead to our own lines gives the ACTUAL line.
  function activeLineIndexByTime() {
    if (!lines.length) return -1;
    const pos = currentLyricPositionMs();
    let found = -1;
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].startMs;
      const e = lines[i].endMs;
      if (Number.isFinite(s) && Number.isFinite(e)) {
        if (pos >= s && pos < e) return i;
        if (pos >= s) found = i;
      }
    }
    return found >= 0 ? found : 0;
  }

  function pickText() {
    if (!lines.length) return "";
    const i = activeLineIndexByTime();
    if (i < 0) return "";
    return String(lines[i].text || "").trim();
  }

  /* ---- canvas helpers ----------------------------------------------------- */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrapRows(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const rows = [words[0]];
    for (let i = 1; i < words.length; i++) {
      const test = rows[rows.length - 1] + " " + words[i];
      if (ctx.measureText(test).width <= maxWidth) rows[rows.length - 1] = test;
      else rows.push(words[i]);
    }
    return rows;
  }

  // Shrink until the text fits `maxLines`, then ellipsize rather than overflow.
  // A card with a clipped line looks broken; a smaller one just looks designed.
  function layoutText(ctx, raw, maxWidth, maxLines, startSize, weight) {
    const segments = String(raw).split("\n");
    let size = startSize;
    let rows = [];
    while (size >= 22) {
      ctx.font = weight + " " + size + "px " + FONT_STACK;
      rows = [];
      for (let i = 0; i < segments.length; i++) {
        rows = rows.concat(wrapRows(ctx, segments[i], maxWidth));
      }
      if (rows.length <= maxLines) break;
      size -= 2;
    }
    if (rows.length > maxLines) {
      rows = rows.slice(0, maxLines);
      rows[maxLines - 1] = rows[maxLines - 1].replace(/\s+\S*$/, "") + "\u2026";
    }
    return { size, rows };
  }

  function loadArt(url) {
    return new Promise((resolve) => {
      if (!url) { resolve(null); return; }
      const img = new Image();
      // Anonymous load: clean pixels or a hard failure. Never a tainted canvas.
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img.naturalWidth > 0 ? img : null);
      img.onerror = () => resolve(null); // no CORS header -> gradient fallback
      img.src = url;
      // A hung decode must not strand the export; toBlob never fires otherwise.
      setTimeout(() => resolve(null), 4000);
    });
  }

  async function ensureFont() {
    if (!document.fonts || typeof document.fonts.load !== "function") return;
    try {
      await Promise.all([
        document.fonts.load('600 62px "SpicyLyrics"'),
        document.fonts.load('400 30px "SpicyLyrics"'),
      ]);
    } catch (_) { /* fall through to the stack in FONT_STACK */ }
  }

  /* ---- the card ----------------------------------------------------------- */
  // The drawing pass, split out from canvas creation so the VIDEO path can reuse
  // ONE canvas and one ctx across ~120 frames instead of allocating a canvas per
  // frame. Deliberately SYNCHRONOUS: it has to run inside the same rAF turn as
  // Kawarp's render, and an `await` would push the draw into a later microtask.
  // `kawarpCanvas` non-null means "video export" — Kawarp owns the backdrop.
  function paintCard(ctx, W, H, text, info, art, kawarpCanvas) {

    // 1. Backdrop. The artwork blown up and blurred, so the card carries the
    //    track's own colour. With no art we paint the Aurora gradient rather
    //    than a flat black rectangle — the fallback should look intentional.
    //    BRIGHTNESS (AJ, 2026-09-28): the first pass stacked brightness(.85)
    //    under a flat 62% black scrim, which landed at ~0.32 of the artwork's
    //    light and read as near-black. The blur now BRIGHTENS, and the scrim is
    //    a soft gradient rather than a blackout — so the colour actually shows
    //    while white type still clears contrast on top of it.
    if (kawarpCanvas) {
      // Video export: Kawarp IS the backdrop. It renders to a WebGL canvas
      // created with `preserveDrawingBuffer: true` (kawarp-core.js:224), which is
      // what makes copying its pixels reliable instead of returning a blank
      // buffer once the frame has been composited.
      ctx.drawImage(kawarpCanvas, 0, 0, W, H);
    } else if (art) {
      // Base fill first: a 70px blur samples past the drawn rect, and without
      // this the outermost pixels of the PNG come out transparent.
      ctx.fillStyle = "#05070c";
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.filter = "blur(70px) saturate(1.45) brightness(1.42)";
      // COVER-fit, not a stretch: on a 3:4 card a straight W/H draw would pull
      // the blurred artwork 33% taller than it is.
      const cover = Math.max((W + 200) / art.width, (H + 200) / art.height);
      const dw = art.width * cover;
      const dh = art.height * cover;
      ctx.drawImage(art, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();

      const scrim = ctx.createLinearGradient(0, 0, 0, H);
      scrim.addColorStop(0, "rgba(5, 7, 13, .12)");
      scrim.addColorStop(.45, "rgba(5, 7, 13, .18)");
      scrim.addColorStop(1, "rgba(5, 7, 13, .26)");
      ctx.fillStyle = scrim;
      ctx.fillRect(0, 0, W, H);

      // Vignette: focuses the eye, and stops the blurred edge from reading as
      // an unfinished crop. Kept light — at .45 it was flattening the whole
      // outer third to grey (AJ asked for brighter, 2026-09-28). Radii come from
      // the short and long axes so the falloff still reaches the corners of a
      // non-square card.
      const vig = ctx.createRadialGradient(
        W / 2, H / 2, Math.min(W, H) * .28,
        W / 2, H / 2, Math.max(W, H) * .78
      );
      vig.addColorStop(0, "rgba(0, 0, 0, 0)");
      vig.addColorStop(1, "rgba(0, 0, 0, .22)");
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, W, H);
    } else {
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "#1d3255");
      grad.addColorStop(.5, "#43275e");
      grad.addColorStop(1, "#0f1a2c");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    // 2. Measure before drawing. The lyric column's width depends on whether the
    //    artwork is present, so the text is laid out against the column it will
    //    actually live in rather than the full card.
    const footerMid = H - PAD - ATTR_H / 2;
    const bodyBottom = footerMid - ATTR_H / 2 - FOOTER_GAP;
    const artY = ART_TOP;

    // The lyric BLOCK spans the full content width, so it is centred on the card
    // by construction, while the text inside stays LEFT-ALIGNED — which also
    // lines its left edge up with the artwork's. It used to hug the right of the
    // artwork in a 520px column, and the block's own centre then landed ~724px
    // in a 1080px card, so it read as pushed right (AJ, 2026-09-28: "still too
    // much to the right … should be right in the middle").
    const colX = PAD;
    const colW = W - PAD * 2;

    const laid = layoutText(ctx, text, colW, LYRIC_MAX_LINES, LYRIC_START_SIZE, "600");
    const lh = laid.size * 1.24;
    const lyricH = lh * laid.rows.length;

    const title = String(info.title || "").trim();
    const artist = String(info.artist || "").trim();
    const trackLabel = title && artist ? title + "  \u2014  " + artist : (title || artist);
    let trackFit = null;
    if (settings.showTrackInfo && trackLabel) {
      // Keep clear of the attribution on the same baseline.
      trackFit = layoutText(ctx, trackLabel, W - PAD * 2 - ATTR_RESERVE, 1, TRACK_SIZE, "400");
    }

    // The block sits LYRIC_SHIFT below the card's geometric centre, for two
    // reasons: the footer anchors the bottom, which pulls the visual weight down
    // so a block on dead centre reads high (AJ: "move the text down a bit"); and
    // with a full-width column the shift is what keeps a 2-3 row block clear of
    // the artwork above it. Clamped above the footer so a tall block can never
    // collide with it.
    const lyricTop = Math.min((H - lyricH) / 2 + LYRIC_SHIFT, bodyBottom - lyricH);

    // Portrait only: grow the artwork so it reaches down toward the lyric instead
    // of leaving a void. Computed from `lyricTop`, which is why the measurement
    // pass has to run before anything is drawn.
    const artSide = settings.portrait
      ? Math.max(ART_SIDE, Math.min(ART_SIDE_PORTRAIT_MAX, lyricTop - ART_TOP - ART_LYRIC_GAP))
      : ART_SIDE;

    ctx.textBaseline = "middle";

    // 3. Artwork, left.
    if (art) {
      ctx.save();
      roundRect(ctx, PAD, artY, artSide, artSide, 30);
      ctx.clip();
      ctx.drawImage(art, PAD, artY, artSide, artSide);
      ctx.restore();
      ctx.save();
      roundRect(ctx, PAD, artY, artSide, artSide, 30);
      ctx.strokeStyle = "rgba(255, 255, 255, .20)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    // 4. A soft local wash behind the lyric ONLY. AJ wants the backdrop bright,
    //    but white type over a bright blurred artwork washes out — so the extra
    //    contrast is applied where the text actually is, as an ellipse that fades
    //    to nothing well before it could read as a visible shape. Clamped so it
    //    never reaches the artwork above it: the block's centre is constant at
    //    H/2 + LYRIC_SHIFT, which is what makes this a fixed band.
    if (lyricH > 0) {
      const cy = lyricTop + lyricH / 2;
      const rx = W * 0.62;
      const artBottom = art ? ART_TOP + artSide : 0;
      const ry = Math.max(110, Math.min(lyricH * 1.15, cy - artBottom - 24));
      ctx.save();
      ctx.translate(W / 2, cy);
      ctx.scale(1, ry / rx);
      const wash = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      wash.addColorStop(0, "rgba(5, 7, 13, .30)");
      wash.addColorStop(.55, "rgba(5, 7, 13, .17)");
      wash.addColorStop(1, "rgba(5, 7, 13, 0)");
      ctx.fillStyle = wash;
      ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
      ctx.restore();
    }

    // 5. The lyric — the hero of the card: full content width, left-aligned.
    //    NO shadow (AJ, 2026-09-28): the dark halo it painted around every glyph
    //    read as a drop shadow rather than as depth. Legibility comes from the
    //    scrim and the wash above instead.
    ctx.font = "600 " + laid.size + "px " + FONT_STACK;
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < laid.rows.length; i++) {
      ctx.fillText(laid.rows[i], colX, lyricTop + lh * i + lh / 2);
    }

    // 6. Footer: track on the LEFT, attribution on the RIGHT. One shared
    //    baseline, so the two sizes still read as a single line.
    if (trackFit) {
      ctx.font = "400 " + trackFit.size + "px " + FONT_STACK;
      ctx.fillStyle = "rgba(255, 255, 255, .88)";
      ctx.textAlign = "left";
      ctx.fillText(trackFit.rows[0], PAD, footerMid);
    }
    ctx.font = "400 " + ATTR_SIZE + "px " + FONT_STACK;
    ctx.fillStyle = "rgba(255, 255, 255, .62)";
    ctx.textAlign = "right";
    ctx.fillText(ATTR_TEXT, W - PAD, footerMid);

    // 7. Top-right badge: the timestamp of the active line. Its top edge is
    //    aligned to the artwork's, so the two top corners read as one system
    //    rather than as two things that happen to be up there.
    const badgeText = settings.showTimestamp ? timestampLabel() : "";
    if (badgeText) {
      ctx.letterSpacing = BADGE_TRACKING;
      ctx.font = "600 " + BADGE_SIZE + "px " + FONT_STACK;
      const textW = ctx.measureText(badgeText).width;
      const bw = textW + BADGE_PAD_X * 2;
      const bh = BADGE_SIZE + BADGE_PAD_Y * 2;
      const bx = W - PAD - bw;
      const by = ART_TOP;
      ctx.save();
      roundRect(ctx, bx, by, bw, bh, bh / 2);
      ctx.fillStyle = "rgba(255, 255, 255, .14)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, .22)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255, 255, 255, .92)";
      ctx.fillText(badgeText, bx + bw / 2, by + bh / 2);
      ctx.textAlign = "left";
      ctx.letterSpacing = "0px";
    }

    // 8. Hairline frame, drawn last so nothing lands on top of it.
    if (FRAME_INSET > 0) {
      ctx.save();
      roundRect(ctx, FRAME_INSET, FRAME_INSET, W - FRAME_INSET * 2, H - FRAME_INSET * 2, 18);
      ctx.strokeStyle = "rgba(255, 255, 255, .14)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }

  function cardSize() {
    return settings.portrait ? CARD_ASPECTS.portrait : CARD_ASPECTS.square;
  }

  function makeCardCanvas() {
    const size = cardSize();
    const canvas = makeEl("canvas");
    canvas.width = size.w;
    canvas.height = size.h;
    return canvas;
  }

  // `artOverride` lets the demo supply a canvas placeholder instead of an image
  // URL. Left `undefined` for a real track so the normal load runs.
  async function buildCard(text, info, artOverride) {
    await ensureFont();
    const size = cardSize();
    const canvas = makeCardCanvas();
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const art = artOverride !== undefined
      ? artOverride
      : await loadCardArt(info);
    paintCard(ctx, size.w, size.h, text, info, art, null);
    return canvas;
  }

  function safeName(s) {
    const cleaned = String(s || "")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60);
    return cleaned || "aurora-lyric";
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function downloadUrl(url, filename) {
    const a = makeEl("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function closePreview() {
    // Any in-flight render is now stale, including one still waiting on the
    // Kawarp module or the artwork.
    renderSeq++;
    // A recording in flight has to be told to stop, or its rAF loop would keep
    // painting into a canvas nobody is showing.
    if (recordingActive) {
      recordingCancelled = true;
      recordingActive = false;
    }
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
    previewBody = null;
    previewStatus = null;
    previewDownload = null;
    previewPanel = null;
    previewStage = null;
    previewPortraitToggle = null;
    previewVideoToggle = null;
    previewFrameToggle = null;
    document.removeEventListener("keydown", onPreviewKeydown, true);
    if (previewUrl) {
      const url = previewUrl;
      previewUrl = null;
      // Revoke LATE: a blob: download reads asynchronously, so revoking in the
      // same tick as the Download click can cancel it.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  }

  function onPreviewKeydown(event) {
    if (event.key !== "Escape") return;
    // Capture phase + stopPropagation: YTM's own Escape handling exits the
    // player, and dismissing a preview should not also do that.
    event.stopPropagation();
    event.preventDefault();
    closePreview();
  }

  // One overlay shell for both outputs: the body holds an <img> or a <video>, the
  // status line carries the recording timer, and Download stays disabled until
  // there is actually something to save.
  function buildPreviewShell() {
    ensureStyle();

    const body = makeEl("div", "ym-share-body");
    const spinner = makeEl("div", "ym-share-spinner");
    spinner.appendChild(makeEl("div", "ym-share-ring"));
    const stage = makeEl("div", "ym-share-stage");
    stage.appendChild(body);
    stage.appendChild(spinner);
    const status = makeEl("div", "ym-share-status");

    const download = makeEl("button", "ym-share-btn ym-share-primary", "Download");
    download.type = "button";
    download.disabled = true;
    download.addEventListener("click", () => {
      // In video mode the button RENDERS first. Recording takes 4 real seconds,
      // so it is a deliberate action rather than something that fires the moment
      // a toggle is flipped (AJ, 2026-09-28).
      if (settings.video && !previewVideoUrl) { renderVideo(); return; }
      if (previewUrl) downloadUrl(previewUrl, previewFilename);
    });

    const close = makeEl("button", "ym-share-btn", "Close");
    close.type = "button";
    close.addEventListener("click", closePreview);

    // Shape + output toggles. They persist through the public API's cmd bridge
    // and re-render the preview in place.
    const portraitToggle = makeEl("button", "ym-share-toggle", "3:4");
    portraitToggle.type = "button";
    portraitToggle.title = "Square card, or 3:4 portrait";
    portraitToggle.addEventListener("click", () => {
      settings.portrait = !settings.portrait;
      // Update the chip's own state directly: the shell is REUSED across
      // re-renders now, so nothing else re-applies data-on and the chip would
      // stay looking "on" forever (AJ, 2026-09-28).
      syncPreviewToggles();
      persistSettings();
      refreshPreview();
    });

    const videoToggle = makeEl("button", "ym-share-toggle", "Video");
    videoToggle.type = "button";
    videoToggle.title = "Still image, or a 4-second video with an animated backdrop";
    videoToggle.addEventListener("click", () => {
      settings.video = !settings.video;
      syncPreviewToggles();
      persistSettings();
      refreshPreview();
    });

    // MV frame (AJ, 2026-10-20): use the frame that is on screen right now instead
    // of the thumbnail. Only offered when a video element actually exists — a
    // still track has no frame to sample — which syncPreviewToggles() enforces.
    const frameToggle = makeEl("button", "ym-share-toggle", "Frame");
    frameToggle.type = "button";
    frameToggle.title = "Use the current video frame instead of the thumbnail";
    frameToggle.addEventListener("click", () => {
      settings.mvFrame = !settings.mvFrame;
      syncPreviewToggles();
      persistSettings();
      refreshPreview();
    });

    const spacer = makeEl("div", "ym-share-spacer");

    const actions = makeEl("div", "ym-share-actions");
    actions.appendChild(portraitToggle);
    actions.appendChild(videoToggle);
    actions.appendChild(frameToggle);
    actions.appendChild(spacer);
    actions.appendChild(download);
    actions.appendChild(close);

    const panel = makeEl("div", "ym-share-panel");
    panel.appendChild(stage);
    panel.appendChild(status);
    panel.appendChild(actions);

    overlayEl = makeEl("div", "ym-share-overlay");
    overlayEl.id = OVERLAY_ID;
    overlayEl.appendChild(panel);
    // Dismiss on a backdrop click, but not on a click inside the panel.
    overlayEl.addEventListener("click", (event) => {
      if (event.target === overlayEl) closePreview();
    });

    document.body.appendChild(overlayEl);
    document.addEventListener("keydown", onPreviewKeydown, true);

    previewBody = body;
    previewStatus = status;
    previewDownload = download;
    previewPanel = panel;
    previewStage = stage;
    previewPortraitToggle = portraitToggle;
    previewVideoToggle = videoToggle;
    previewFrameToggle = frameToggle;
    syncPreviewToggles();
    setStageSize();
  }

  // Reflect `settings` onto the chips. Needed because the shell is now REUSED
  // across re-renders, so data-on is no longer re-applied by a rebuild.
  function syncPreviewToggles() {
    if (previewPortraitToggle) {
      previewPortraitToggle.setAttribute("data-on", settings.portrait ? "1" : "0");
    }
    if (previewVideoToggle) {
      previewVideoToggle.setAttribute("data-on", settings.video ? "1" : "0");
    }
    if (previewFrameToggle) {
      previewFrameToggle.setAttribute("data-on", settings.mvFrame ? "1" : "0");
      // No video element means there is no frame to sample, so the toggle would
      // do nothing — hide it rather than leave a dead button (AJ, 2026-10-20).
      const hasVideo = !!(document.querySelector("ytmusic-player video.html5-main-video")
        || document.querySelector("video.html5-main-video"));
      previewFrameToggle.style.display = hasVideo ? "" : "none";
    }
  }

  // The displayed card box for the CURRENT aspect, fitted to the viewport the way
  // the media's old max-width/max-height caps used to. The stage owns the size so
  // a square <-> 3:4 switch TRANSITIONS instead of snapping (AJ, 2026-09-28).
  function setStageSize() {
    if (!previewStage) return;
    const size = cardSize();
    const availW = Math.min(window.innerWidth * 0.78, 620);
    const availH = Math.max(140, window.innerHeight - 168);
    const scale = Math.min(availW / size.w, availH / size.h);
    previewStage.style.width = Math.round(size.w * scale) + "px";
    previewStage.style.height = Math.round(size.h * scale) + "px";
  }

  function setPreviewStatus(text) {
    if (previewStatus) previewStatus.textContent = text || "";
  }

  // Dim what is already on screen and show the ring, rather than emptying the
  // panel — an empty body has no size, which is what made the panel collapse
  // between renders (AJ, 2026-09-28).
  function setPreviewLoading(on) {
    if (previewPanel) previewPanel.classList.toggle("loading", !!on);
  }

  // Reuse the shell on a re-render so the panel keeps its size and content.
  function ensurePreviewShell() {
    if (!overlayEl) buildPreviewShell();
  }

  function cancelRecording() {
    if (!recordingActive) return;
    recordingCancelled = true;
    recordingActive = false;
  }

  // Persist through the public API's cmd bridge. content.js only DELIVERS the
  // keys declared in the catalog schema, which is why `portrait` and `video`
  // stay in that schema marked dev:true rather than being deleted — remove them
  // and the choice would silently reset on every reload.
  function persistSettings() {
    try {
      const api = window.YTMod;
      if (api && typeof api.saveExtensionSettings === "function") {
        api.saveExtensionSettings(EXT_ID, Object.assign({}, settings));
      }
    } catch (err) {
      console.warn("[Aurora Lyrics] could not persist share settings:", err);
    }
  }

  // Load the demo card. Used by the share button when no lyrics are loaded —
  // without that fallback the feature would be unreachable unless a synced track
  // happened to be playing. (The old "Try it" chip that forced the demo is gone,
  // AJ 2026-09-29: the preview already covers it.)
  async function loadDemo() {
    demoMode = true;
    const demoArt = await makeDemoArt();
    previewText = DEMO_TEXT;
    previewInfo = {
      title: DEMO_TITLE,
      artist: DEMO_ARTIST,
      artworkUrl: "",
      demoArt: demoArt,
    };
    // The demo exists to produce a test VIDEO, so arm video mode for it and
    // persist that, keeping the chip's state honest.
    settings.video = true;
    syncPreviewToggles();
    persistSettings();
    refreshPreview();
  }

  // Re-render the preview after a toggle changed. ALWAYS renders the still: in
  // video mode the still doubles as the poster you look at before pressing
  // Render video, which keeps toggling instant instead of firing a 4-second
  // recording the moment a toggle flips (AJ, 2026-09-28).
  function refreshPreview() {
    if (!previewText || !previewInfo) return;
    cancelRecording();
    // A re-render invalidates any clip recorded for the previous shape.
    previewVideoUrl = null;
    previewVideoFilename = "";
    const base = safeName(previewInfo.title) + "-lyric";
    const seq = ++renderSeq;
    ensurePreviewShell();
    // The stage animates to the new aspect while the media is re-rendered.
    syncPreviewToggles();
    setStageSize();
    setPreviewLoading(true);
    buildCard(previewText, previewInfo).then((canvas) => {
      if (seq !== renderSeq) return;
      if (!canvas) { setPreviewLoading(false); flash("Could not build the card"); return; }
      showStill(canvas, base + ".png");
    }).catch((err) => {
      console.warn("[Aurora Lyrics] lyric card rebuild failed:", err);
      setPreviewLoading(false);
    });
  }

  function setPreviewMedia(node, url, filename) {
    if (!previewBody) return;
    // Release the outgoing blob late: a download may still be reading it.
    if (previewUrl && previewUrl !== url) {
      const old = previewUrl;
      setTimeout(() => URL.revokeObjectURL(old), 10000);
    }
    previewBody.textContent = "";
    previewBody.appendChild(node);
    previewUrl = url;
    previewFilename = filename;
    setPreviewLoading(false);
    if (previewDownload) {
      previewDownload.disabled = false;
      // In video mode with no clip yet, the button RENDERS. Once a clip exists it
      // is an ordinary download.
      previewDownload.textContent = settings.video && !previewVideoUrl ? "Render video" : "Download";
    }
    if (settings.video && !previewVideoUrl) {
      setPreviewStatus("Video records " + (VIDEO_MS / 1000) + "s in real time \u2014 press Render video.");
    } else {
      setPreviewStatus("");
    }
  }

  // Static export: show the rendered card for review instead of downloading it
  // straight away. REUSES the shell, so switching shape dims the old card and
  // swaps it in place rather than collapsing the panel.
  function showStill(canvas, filename) {
    ensurePreviewShell();
    setPreviewLoading(true);
    try {
      // Throws SecurityError on a tainted canvas. The anonymous artwork load is
      // what prevents that, but the catch keeps a CDN surprise from becoming a
      // silent no-op.
      canvas.toBlob((blob) => {
        if (!blob) { setPreviewLoading(false); flash("Could not build the card"); return; }
        const url = URL.createObjectURL(blob);
        const img = makeEl("img", "ym-share-img");
        img.src = url;
        img.alt = "Lyric card preview";
        setPreviewMedia(img, url, filename);
      }, "image/png");
    } catch (err) {
      console.warn("[Aurora Lyrics] lyric card preview failed:", err);
      setPreviewLoading(false);
      flash("Could not build the card");
    }
  }

  // Fired by the Download button while in video mode. Recording is the slow part
  // (4 real seconds), so the popup owns the timer while it runs.
  function renderVideo() {
    if (!previewText || !previewInfo || recordingActive) return;
    // ⭐ A rejected promise here used to be COMPLETELY silent, which is what made
    // the scope bug in driveKawarp() look like an endless "Preparing…" instead of
    // an error. Surface any failure rather than hanging.
    showVideoPreview(previewText, previewInfo, safeName(previewInfo.title) + "-lyric", true)
      .catch((err) => {
        console.warn("[Aurora Lyrics] video export failed:", err);
        setPreviewLoading(false);
        setPreviewStatus("Could not start recording");
        flash("Could not start recording");
      });
  }

  function pickVideoMime() {
    if (typeof MediaRecorder === "undefined") return "";
    for (let i = 0; i < VIDEO_MIME_CANDIDATES.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(VIDEO_MIME_CANDIDATES[i])) return VIDEO_MIME_CANDIDATES[i];
      } catch (_) { /* isTypeSupported throws on a malformed type */ }
    }
    return "";
  }

  function videoExtension(mime) {
    return /mp4/i.test(mime) ? ".mp4" : ".webm";
  }

  // Advance Kawarp's animation clock and render one frame. Called by BOTH the
  // warm-up loop and the recording tick, so the backdrop is always painted before
  // paintCard copies it. `dt` is clamped so a tab hiccup cannot jump the clock.
  // ⭐ The instance is a PARAMETER, not a closure: `kawarp` is local to
  // showVideoPreview, and referencing it from here threw ReferenceError on the
  // first line — before the try — which silently stranded the popup on
  // "Preparing backdrop…" forever (AJ, 2026-09-28). `node --check` cannot see a
  // scope error like that.
  function driveKawarp(instance) {
    if (!instance) return;
    const now = performance.now();
    const dt = Math.min(0.25, Math.max(0, (now - kawarpClockAt) / 1000));
    kawarpClockAt = now;
    const speed = isPlaybackPaused() ? KAWARP_CLOCK_PAUSED : KAWARP_CLOCK_PLAYING;
    kawarpClock += dt * speed;
    try {
      instance.render(kawarpClock, now);
    } catch (_) { /* a failed frame must not kill the recording */ }
  }

  // Cheap 16x16 luminance probe, used ONLY to decide whether Kawarp has painted
  // real pixels yet. Returns false ("assume it is fine") when the pixels cannot
  // be read: a WebGL canvas whose texture came from a cross-origin image can be
  // tainted, and getImageData would throw.
  function isMostlyBlack(canvas) {
    if (!canvas) return false;
    try {
      const probe = makeEl("canvas");
      probe.width = 16;
      probe.height = 16;
      const g = probe.getContext("2d");
      if (!g) return false;
      g.drawImage(canvas, 0, 0, 16, 16);
      const data = g.getImageData(0, 0, 16, 16).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
      return sum / (data.length / 4) < 24;
    } catch (_) {
      return false;
    }
  }

  // Video export: Kawarp animates behind the SAME card content for 4 seconds.
  // MediaRecorder records in real time, so this takes as long as the clip and the
  // timer in the popup is the honest UI for that — there is no fast path.
  async function showVideoPreview(text, info, filenameBase, autoDownload) {
    const mime = pickVideoMime();
    if (!mime) { flash("Video export is not supported in this browser"); return; }

    cancelRecording();
    // Take the next generation: a later toggle or dismissal invalidates it and
    // the awaits below bail out.
    const seq = ++renderSeq;
    ensurePreviewShell();
    setPreviewLoading(true);
    setPreviewStatus("Preparing\u2026");

    const size = cardSize();
    const canvas = makeCardCanvas();
    const ctx = canvas.getContext("2d");
    if (!ctx) { closePreview(); flash("Could not build the card"); return; }

    await ensureFont();
    const art = info.demoArt
      ? info.demoArt
      : await loadCardArt(info);
    if (seq !== renderSeq) return;

    // Kawarp needs an IMAGE URL, so the demo's canvas placeholder is handed over
    // as a data URL (same-origin, so it cannot taint the WebGL canvas).
    const artUrl = info.demoArt ? info.demoArt.toDataURL("image/png") : hiResArt(info.artworkUrl);

    // Kawarp on a DETACHED canvas. It sizes itself from canvas.width/height
    // (kawarp-core.js resize()), never from layout, so it needs no DOM — and it
    // renders with preserveDrawingBuffer, which is what makes the per-frame
    // drawImage in paintCard reliable rather than a blank buffer.
    let kawarp = null;
    let kawarpCanvas = null;
    if (KAWARP_CORE_URL) {
      try {
        kawarpCanvas = makeEl("canvas");
        kawarpCanvas.width = size.w;
        kawarpCanvas.height = size.h;
        const mod = await import(KAWARP_CORE_URL);
        const Kawarp = mod.default || mod.Kawarp;
        if (typeof Kawarp !== "function") throw new Error("Kawarp did not export a constructor");
        kawarp = new Kawarp(kawarpCanvas, KAWARP_OPTIONS);
        if (artUrl) await kawarp.loadImage(artUrl);
        // Do NOT start() it: its own loop is speed-clamped, and it would also
        // fight our manual render() calls. driveKawarp() owns the clock from here.
        kawarp.stop();
        kawarpClock = 0;
        kawarpClockAt = performance.now();
      } catch (err) {
        // Fall back to the static blurred-art backdrop: paintCard treats a null
        // kawarpCanvas as "use the artwork", so the clip still renders.
        console.warn("[Aurora Lyrics] Kawarp unavailable for video export:", err);
        if (kawarp) { try { kawarp.dispose(); } catch (_) {} }
        kawarp = null;
        kawarpCanvas = null;
      }
    }

    const releaseKawarp = () => {
      if (kawarp) { try { kawarp.dispose(); } catch (_) {} }
      kawarp = null;
      kawarpCanvas = null;
    };

    // The Kawarp import and image load are the slowest awaits here, so a toggle
    // flipped during them must not leave a second instance running.
    if (seq !== renderSeq) { releaseKawarp(); return; }

    // ⭐ Hold for at least the CROSSFADE duration before recording. Kawarp fades
    // the album in over `transitionDuration`, so breaking the moment the canvas
    // stopped being pure black caught the fade mid-way — that is the black blob
    // plus dithering noise in the first second of AJ's clip (2026-09-28). The
    // luminance probe is best-effort: it returns "not black" if the pixels cannot
    // be read at all, and the ceiling guarantees the loop terminates.
    if (kawarp) {
      const warmStart = performance.now();
      let warm = 0;
      while ((warm = performance.now() - warmStart) < KAWARP_WARMUP_MAX_MS) {
        if (seq !== renderSeq) { releaseKawarp(); return; }
        // Paint a backdrop frame BEFORE waiting, so the luminance probe and the
        // eventual recording both see a frame rendered this tick.
        driveKawarp(kawarp);
        setPreviewStatus("Preparing backdrop\u2026");
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (warm >= KAWARP_WARMUP_MIN_MS && !isMostlyBlack(kawarpCanvas)) break;
      }
      if (seq !== renderSeq) { releaseKawarp(); return; }
    }

    let stream = null;
    let recorder = null;
    try {
      stream = canvas.captureStream(VIDEO_FPS);
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VIDEO_BITRATE });
    } catch (err) {
      // isTypeSupported can pass while the constructor still rejects (a bitrate
      // the encoder refuses, say), so retry with defaults before giving up.
      try {
        recorder = new MediaRecorder(stream);
      } catch (err2) {
        console.warn("[Aurora Lyrics] video recording unavailable:", err2);
        releaseKawarp();
        closePreview();
        flash("Could not start recording");
        return;
      }
    }

    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      releaseKawarp();
      if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
      if (recordingCancelled) { recordingCancelled = false; return; }
      const type = (recorder && recorder.mimeType) || mime;
      const filename = filenameBase + videoExtension(type);
      const url = URL.createObjectURL(new Blob(chunks, { type }));
      // Set these BEFORE setPreviewMedia: the button label and the status hint
      // both key off whether a clip exists yet.
      previewVideoUrl = url;
      previewVideoFilename = filename;
      const video = makeEl("video", "ym-share-video");
      video.src = url;
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      setPreviewMedia(video, url, filename);
      try { video.play().catch(() => {}); } catch (_) {}
      // Download was the click that started the recording, so save the result
      // rather than making the user press it a second time.
      if (autoDownload) downloadUrl(url, filename);
    };

    const started = performance.now();
    recordingActive = true;
    recordingCancelled = false;
    // Drop the spinner so the timer and the card behind it are both visible.
    setPreviewLoading(false);
    try {
      recorder.start();
    } catch (err) {
      recordingActive = false;
      releaseKawarp();
      closePreview();
      flash("Could not start recording");
      return;
    }

    const tick = () => {
      if (!recordingActive) return;
      // Drive the backdrop FIRST, then composite it. driveKawarp() reads the LIVE
      // playback state every frame, so pausing mid-recording slows the backdrop
      // exactly as the extension's own backdrop does.
      driveKawarp(kawarp);
      paintCard(ctx, size.w, size.h, text, info, art, kawarpCanvas);
      const elapsed = performance.now() - started;
      const shown = Math.min(VIDEO_MS, elapsed) / 1000;
      setPreviewStatus("Recording " + shown.toFixed(1) + "s of " + (VIDEO_MS / 1000) + "s\u2026");
      if (elapsed >= VIDEO_MS) {
        recordingActive = false;
        try { recorder.stop(); } catch (_) {}
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Transient feedback through the button's own tooltip, so this add-on never
  // has to invent a toast surface of its own.
  function flash(message) {
    const el = document.getElementById("ym-pb-share-lyric");
    if (!el) return;
    const prevTitle = el.title;
    const prevLabel = el.getAttribute("aria-label") || "";
    el.title = message;
    el.setAttribute("aria-label", message);
    setTimeout(() => {
      el.title = prevTitle;
      el.setAttribute("aria-label", prevLabel);
    }, 2200);
  }

  async function shareActiveLine() {
    if (busy) return;
    const text = pickText();
    // No lyrics: show the demo instead of just refusing. Without this the
    // feature is unreachable unless a synced track happens to be playing.
    if (!text) { loadDemo(); return; }

    busy = true;
    try {
      const track = currentTrack() || {};
      const info = {
        title: track.title || meta.title || "",
        artist: track.artist || meta.artist || "",
        artworkUrl: track.artworkUrl || "",
      };
      // Leaving demo mode behind, so the timestamp comes from the real lines.
      demoMode = false;
      // Remembered so the popup's toggles and the Download button can re-render
      // without the caller passing everything again. ALWAYS the still: in video
      // mode the still is the poster, and the clip is recorded on demand from
      // Download (AJ, 2026-09-28).
      previewText = text;
      previewInfo = info;
      refreshPreview();
    } catch (err) {
      console.warn("[Aurora Lyrics] lyric card failed:", err);
      flash("Could not build the card");
    } finally {
      busy = false;
    }
  }

  /* ---- wiring ------------------------------------------------------------- */
  function mountButton() {
    if (!window.YTMod || !window.YTMod.addPlayerBarButton) return;
    btnHandle = window.YTMod.addPlayerBarButton({
      id: "share-lyric",
      label: "Share this lyric as an image",
      iconSvgPath: ICON_SHARE,
      onClick: () => { shareActiveLine(); },
    });
  }

  function applySettings(next) {
    if (!next || typeof next !== "object") return;
    settings = {
      showArt: typeof next.showArt === "boolean" ? next.showArt : DEFAULT_SETTINGS.showArt,
      showTrackInfo: typeof next.showTrackInfo === "boolean" ? next.showTrackInfo : DEFAULT_SETTINGS.showTrackInfo,
      showTimestamp: typeof next.showTimestamp === "boolean" ? next.showTimestamp : DEFAULT_SETTINGS.showTimestamp,
      portrait: typeof next.portrait === "boolean" ? next.portrait : DEFAULT_SETTINGS.portrait,
      video: typeof next.video === "boolean" ? next.video : DEFAULT_SETTINGS.video,
      mvFrame: typeof next.mvFrame === "boolean" ? next.mvFrame : DEFAULT_SETTINGS.mvFrame,
    };
  }

  function start() {
    const bus = window.YTMod.bus;
    unsubLines = bus.on("lyrics:lines", onLines, { replay: true });
    unsubActive = bus.on("lyrics:active", onActive, { replay: true });
    unsubSync = bus.on("lyrics:sync", onSync, { replay: true });
    mountButton();
    window.postMessage({ type: "ytmod-settings-request", id: EXT_ID }, "*");
  }

  function teardown() {
    if (unsubLines) { unsubLines(); unsubLines = null; }
    if (unsubActive) { unsubActive(); unsubActive = null; }
    if (unsubSync) { unsubSync(); unsubSync = null; }
    if (btnHandle) { btnHandle.remove(); btnHandle = null; }
    closePreview();
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    lines = [];
    activeIndex = -1;
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.id !== EXT_ID) return;
    if (data.type === "ytmod-settings") { applySettings(data.settings); return; }
    if (data.type !== "ytmod-ext") return;
    if (data.action === "disable") teardown();
  });

  whenYTMod(() => { start(); });
})();
