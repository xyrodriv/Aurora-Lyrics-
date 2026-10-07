/* Aurora Lyrics — Next Up pill (add-on)
   ---------------------------------------------------------------------------
   A small pill showing what plays next, anchored to the bottom-left (or -right)
   corner of the artwork / video, OUTSIDE it — in the gutter between the media and
   the player bar, so it never covers the picture (AJ, 2026-09-28).

   WHERE THE DATA COMES FROM — verified live before writing a line of this:
     document.querySelector("ytmusic-player-queue").data
   is the FULL queue model straight from YouTube's API: an array of
   `{ playlistPanelVideoRenderer: { videoId, title, byline, thumbnail, selected } }`.
   That beats scraping on every axis — real order, no virtualization, no selector
   fragility. Verified facts from the live probe:
     - `#movie_player.getPlaylist()` EXISTS BUT RETURNS EMPTY (playlistLen 0) even
       with a real mix loaded, so that API is a dead end here.
     - The queue DOM is NOT virtualized (all 50 items were present), so scraping is
       a usable FALLBACK.
     - The playing row carries the `selected` attribute.
     - There is NO `video-id` attribute on the row, and NO `.title` element inside
       it — which is why public-api.js's getNextTrack() DOM fallback never worked:
       it looks for `.title`, while the real class is `.song-title`.

   NOTE this pill deliberately shows the QUEUE's next item, not
   `playerResponse.upcoming` — `upcoming` is the AUTOPLAY recommendation, which is
   what plays after the queue runs out, not the next track in it.
   --------------------------------------------------------------------------- */
(() => {
  "use strict";

  const EXT_ID = "ytmod-next-up";
  const STYLE_ID = "ym-nu-style";
  const PILL_ID = "ym-nu-pill";
  // The queue changes rarely, and the same tick re-measures the anchor so the pill
  // follows layout changes (resize, tab switch) without a resize listener.
  const TICK_MS = 700;
  // Gap between the media's bottom edge and the pill.
  const GAP_PX = 12;
  // Inset from the player page's left edge when the pill is left-aligned.
  const SIDE_PAD_PX = 12;
  // Clearance kept between the pill's box and the player bar. Covers the glow:
  // ::after is inset -8px with a 6px blur, so it reaches ~14px past the pill.
  const BAR_CLEARANCE_PX = 16;

  const DEFAULT_SETTINGS = {
    showArt: true,
    alignRight: false,
    // "Smooth glow (60fps)": drops the glow throttle from ~24fps to ~16ms so the
    // seam travels at the display rate. OFF by default - it costs a repaint every
    // frame while the pill is visible.
    smoothGlow: false,
  };

  // Registered so Chrome definitely re-resolves the conic when the JS rAF updates
  // the angle. Copied from the panel's credit-pill glow (aurora-lyrics.js:4628):
  // an UNregistered custom property driving a conic would not reliably repaint on
  // AJ's Chrome. inherits:true so the pill's own value reaches its ::before/::after.
  const CSS = `
@property --ym-nu-spin {
  syntax: "<angle>";
  inherits: true;
  initial-value: 0deg;
}
#${PILL_ID} {
  position: absolute;
  z-index: 2147482000;
  display: flex; align-items: center; gap: 10px;
  max-width: 320px;
  padding: 7px 14px 7px 7px;
  border-radius: 999px;
  /* TRANSPARENT fill (AJ, 2026-09-28): the glass comes from the backdrop blur and
     the glow ring, not from a dark tint.
     NOTE the box-shadow had to go with it — a shadow is painted BEHIND the
     element's background, so with a transparent fill a dark blurred rect shows
     straight through the pill and reads as exactly the dark fill we just removed.
     The glow ring does the separating instead. */
  background: transparent;
  border: 1px solid rgba(255, 255, 255, .16);
  backdrop-filter: blur(18px) saturate(120%);
  -webkit-backdrop-filter: blur(18px) saturate(120%);
  color: #f1f1f1;
  font-family: "Roboto", "YouTube Sans", system-ui, -apple-system, sans-serif;
  cursor: pointer;
  opacity: 0;
  transform: translateY(8px) scale(.97);
  /* left/top/right are transitioned so a reposition GLIDES instead of snapping —
     the tick re-measures the anchor every 700ms, and the layout can move under it
     (window resize, tab switch, queue panel opening). */
  transition:
    opacity .3s cubic-bezier(.22,.61,.36,1),
    transform .3s cubic-bezier(.22,.61,.36,1),
    left .34s cubic-bezier(.22,.61,.36,1),
    top .34s cubic-bezier(.22,.61,.36,1),
    right .34s cubic-bezier(.22,.61,.36,1),
    background .16s ease;
  pointer-events: none;
}
/* The FIRST placement must not animate, or the pill would glide in from 0,0.
   Applied by JS around that one write. */
#${PILL_ID}.ym-nu-no-pos-trans {
  transition-property: opacity, transform, background;
}
#${PILL_ID}.ym-nu-in {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}
#${PILL_ID}:hover { background: rgba(255, 255, 255, .10); }
#${PILL_ID}:active { transform: translateY(0) scale(.98); }
/* Aurora's fullscreen overlay is z-index 2147483000, so the pill has to rise
   above it to be visible there. Deliberately NOT the base z-index: at
   2147482000 the pill stays UNDER the marketplace panel (also 2147483000) and
   under the share preview (2147483600), which is what we want everywhere else. */
#${PILL_ID}.ym-nu-fs { z-index: 2147483200; }
#${PILL_ID} .ym-nu-thumb {
  width: 34px; height: 34px; flex: 0 0 auto;
  border-radius: 50%;
  object-fit: cover;
  background: rgba(255, 255, 255, .08);
}
#${PILL_ID} .ym-nu-text { min-width: 0; display: flex; flex-direction: column; }
#${PILL_ID} .ym-nu-label {
  font-size: 9px; font-weight: 700; letter-spacing: .1em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, .5);
  line-height: 1.3;
}
#${PILL_ID} .ym-nu-title {
  font-size: 13px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.35;
}
/* Content crossfade when the "next up" track changes (song transition / skip).
   Only the CONTENT fades + slides, so the pill (glass + glow) stays put and the
   re-labelling reads as a smooth update instead of a hard swap (AJ, 2026-09-28). */
#${PILL_ID} .ym-nu-thumb,
#${PILL_ID} .ym-nu-text {
  transition: opacity .2s ease, transform .2s ease;
}
#${PILL_ID}.ym-nu-swap .ym-nu-thumb,
#${PILL_ID}.ym-nu-swap .ym-nu-text {
  opacity: 0;
  transform: translateY(-5px);
}
/* Two-colour edge glow, copied from the credit pills (aurora-lyrics.js:4657). A
   MASKED pill-shaped ring painted with a conic-gradient whose 'from' angle is the
   registered --ym-nu-spin. The pill's SHAPE stays static — only the colour seam
   glides, which reads as travelling light rather than a rigid spin. ::before is
   the crisp ring (2px), ::after the wider blurred halo behind it. No fill inside. */
#${PILL_ID}::before {
  content: "";
  position: absolute;
  inset: -2px;
  border-radius: inherit;
  padding: 2px;
  background: conic-gradient(
    from var(--ym-nu-spin, 0deg),
    var(--ym-nu-accent-a, #ff5b8e) 0deg 180deg,
    var(--ym-nu-accent-b, #5be0ff) 180deg 360deg
  );
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
  z-index: -1;
}
#${PILL_ID}::after {
  content: "";
  position: absolute;
  inset: -8px;
  border-radius: inherit;
  background: conic-gradient(
    from var(--ym-nu-spin, 0deg),
    var(--ym-nu-accent-a, #ff5b8e) 0deg 180deg,
    var(--ym-nu-accent-b, #5be0ff) 180deg 360deg
  );
  filter: blur(6px);
  opacity: .35;
  pointer-events: none;
  z-index: -2;
}
@media (prefers-reduced-motion: reduce) {
  #${PILL_ID} {
    transition: opacity .18s ease;
    transform: none;
  }
  #${PILL_ID}.ym-nu-in { transform: none; }
}
`;

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let pill = null;
  let thumbEl = null;
  let titleEl = null;
  let tickTimer = 0;
  let currentKey = "";
  // The first placement writes left/top with the position transition suppressed,
  // or the pill would glide in from 0,0 on its very first frame.
  let positioned = false;

  function makeEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  }

  function whenYTMod(cb) {
    if (window.YTMod && window.YTMod.player) { cb(); return; }
    let tries = 0;
    const timer = setInterval(() => {
      if (window.YTMod && window.YTMod.player) { clearInterval(timer); cb(); return; }
      if (++tries > 200) clearInterval(timer);
    }, 100);
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ---- two-colour sampling -------------------------------------------------
     Copied from the credit pills (aurora-lyrics.js:10889). The sampler averages
     the LEFT and RIGHT halves of a 24x24 downscale to get two colours; when they
     are too alike to read as motion it pushes the second round the hue wheel and
     lifts its saturation. Here the source is the NEXT TRACK'S THUMBNAIL — which
     the pill is already showing — and it silently keeps the CSS default pair when
     the canvas is unreadable. */
  const accentCache = new Map();

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h: h, s: s, l: l };
  }

  function hue2rgb(p, q, t) {
    let u = t;
    if (u < 0) u += 1;
    if (u > 1) u -= 1;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  }

  function hslToRgb(h, s, l) {
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    ];
  }

  // Average colour of columns [from, to) in a 24x24 RGBA buffer, skipping
  // near-transparent pixels. Null when nothing usable is there.
  function averageSlice(data, from, to) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < 24; y++) {
      for (let x = from; x < to; x++) {
        const i = (y * 24 + x) * 4;
        if (data[i + 3] < 128) continue;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null;
  }

  function sampleThumbColors(url) {
    if (!url) return Promise.resolve(null);
    if (accentCache.has(url)) return Promise.resolve(accentCache.get(url));
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.onload = () => {
        let pair = null;
        try {
          const canvas = makeEl("canvas");
          canvas.width = 24;
          canvas.height = 24;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(img, 0, 0, 24, 24);
            const data = ctx.getImageData(0, 0, 24, 24).data;
            const left = averageSlice(data, 0, 12);
            const right = averageSlice(data, 12, 24);
            const first = left || right;
            let second = right || left;
            if (first && second) {
              const dist = Math.abs(first[0] - second[0]) +
                Math.abs(first[1] - second[1]) +
                Math.abs(first[2] - second[2]);
              if (dist < 70) {
                // Too alike to read as motion: push the second round the hue wheel
                // so the colour seam actually travels.
                const hsl = rgbToHsl(second[0], second[1], second[2]);
                second = hslToRgb(
                  (hsl.h + 0.11) % 1,
                  Math.min(1, Math.max(0.45, hsl.s * 1.1 + 0.15)),
                  Math.min(0.78, Math.max(0.42, hsl.l))
                );
              }
              pair = {
                a: "rgb(" + first[0] + ", " + first[1] + ", " + first[2] + ")",
                b: "rgb(" + second[0] + ", " + second[1] + ", " + second[2] + ")",
              };
            }
          }
        } catch (_) { pair = null; }
        if (accentCache.size > 120) accentCache.clear();
        accentCache.set(url, pair);
        resolve(pair);
      };
      img.onerror = () => { accentCache.set(url, null); resolve(null); };
      img.src = url;
    });
  }

  /* ---- glow engine ---------------------------------------------------------
     JS rAF, NOT a CSS @keyframes animation: AJ's Chrome reliably repaints the
     conic on a JS setProperty but NOT on a keyframe animation of the same
     registered @property (the v6/v9 freeze). The angle is set on the PILL, never
     on :root — a root-level setProperty cascade-invalidates the whole tree and
     tanked the panel to ~20fps.
     Throttled to ~24fps and gated on the pill actually being shown, so a hidden
     pill costs zero repaints. */
  const GLOW_PERIOD_MS = 5200;
  // ~24fps by default; the "Smooth glow (60fps)" setting drops the throttle to
  // ~16ms. Either way the seam keeps the same 5.2s revolution - only the
  // smoothness changes, so the glow never speeds up or slows down.
  const GLOW_STEP_MS_NORMAL = 42;
  const GLOW_STEP_MS_SMOOTH = 16;
  let glowStepMs = GLOW_STEP_MS_NORMAL;
  let glowStepDeg = 360 / (GLOW_PERIOD_MS / glowStepMs);
  let glowRAF = 0;
  let glowDeg = 0;
  let lastGlowAt = 0;

  function setGlowRate(smooth) {
    glowStepMs = smooth ? GLOW_STEP_MS_SMOOTH : GLOW_STEP_MS_NORMAL;
    glowStepDeg = 360 / (GLOW_PERIOD_MS / glowStepMs);
  }

  function spinPill(deg) {
    if (pill) pill.style.setProperty("--ym-nu-spin", deg.toFixed(2) + "deg");
  }

  function glowFrame(now) {
    glowRAF = requestAnimationFrame(glowFrame);
    if (now - lastGlowAt < glowStepMs) return;
    lastGlowAt = now;
    if (!pill || !pill.classList.contains("ym-nu-in")) return;
    glowDeg = (glowDeg + glowStepDeg) % 360;
    spinPill(glowDeg);
  }

  function startGlow() {
    if (glowRAF) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // No rAF at all: the seam stays two-colour, it just does not travel.
      spinPill(0);
      return;
    }
    glowRAF = requestAnimationFrame(glowFrame);
  }

  function stopGlow() {
    if (glowRAF) { cancelAnimationFrame(glowRAF); glowRAF = 0; }
  }

  /* ---- queue model ------------------------------------------------------- */
  // `title` / `byline` are YouTube renderer objects: either { simpleText } or
  // { runs: [{ text }] }. Handle both rather than assuming one.
  function textOf(node) {
    if (!node) return "";
    if (typeof node.simpleText === "string") return node.simpleText.trim();
    if (Array.isArray(node.runs)) {
      return node.runs.map((r) => (r && r.text) || "").join("").trim();
    }
    return "";
  }

  function thumbnailOf(renderer) {
    const list = renderer && renderer.thumbnail && renderer.thumbnail.thumbnails;
    if (!Array.isArray(list) || !list.length) return "";
    // Largest available; CSS scales it down to the pill, so this stays crisp.
    return list[list.length - 1].url || "";
  }

  // The queue array, or null when there is no queue to read.
  function queueRenderers() {
    try {
      const host = document.querySelector("ytmusic-player-queue");
      const data = host && host.data;
      if (!Array.isArray(data) || !data.length) return null;
      const out = data
        .map((entry) => entry && entry.playlistPanelVideoRenderer)
        .filter(Boolean);
      return out.length ? out : null;
    } catch (_) {
      return null;
    }
  }

  // The id the player is actually on. Used only as a tie-breaker: `selected` is
  // the primary signal, but it is worth a second opinion.
  function currentVideoId() {
    try {
      const mp = document.querySelector("#movie_player");
      const data = mp && mp.getVideoData && mp.getVideoData();
      return (data && data.video_id) || "";
    } catch (_) {
      return "";
    }
  }

  function playingIndex(list) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].selected === true) return i;
    }
    const vid = currentVideoId();
    if (vid) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].videoId === vid) return i;
      }
    }
    return -1;
  }

  // DOM fallback, used only when the queue model is unavailable. Selectors taken
  // from a live dump of a real row: .song-title / .byline / img inside
  // yt-img-shadow.thumbnail. NOTE `.title` does NOT exist — that is the bug that
  // made public-api.js's getNextTrack() fallback useless.
  function nextFromDom() {
    try {
      const rows = Array.from(document.querySelectorAll("ytmusic-player-queue-item"));
      if (!rows.length) return null;
      let idx = rows.findIndex((r) => r.hasAttribute("selected") || r.selected === true);
      if (idx < 0) idx = 0;
      const next = rows[idx + 1];
      if (!next) return null;
      const titleEl = next.querySelector(".song-title") || next.querySelector("yt-formatted-string");
      const img = next.querySelector("yt-img-shadow.thumbnail img") || next.querySelector("img");
      const title = titleEl && titleEl.textContent ? titleEl.textContent.trim() : "";
      if (!title) return null;
      return { title, artist: "", thumb: (img && (img.currentSrc || img.src)) || "" };
    } catch (_) {
      return null;
    }
  }

  function readNext() {
    const list = queueRenderers();
    if (list) {
      const idx = playingIndex(list);
      if (idx >= 0 && idx + 1 < list.length) {
        const r = list[idx + 1];
        const title = textOf(r.title);
        if (title) {
          return { title, artist: textOf(r.shortBylineText || r.longBylineText), thumb: thumbnailOf(r) };
        }
      }
      // A queue with a known playing index but nothing after it: there IS no next
      // track, so the pill should hide rather than guess.
      if (idx >= 0) return null;
    }
    return nextFromDom();
  }

  /* ---- the media anchor -------------------------------------------------- */
  // Whichever of the video / artwork is actually laid out. Verified live: on a
  // cover-art track the <video> is 0x0 AND #movie_player is 0x0, while the
  // artwork <img> is the real box — so "the media" cannot be a fixed selector.
  function mediaBox() {
    const cands = [
      document.querySelector("ytmusic-player-page video.html5-main-video"),
      document.querySelector("ytmusic-player-page img"),
    ];
    for (let i = 0; i < cands.length; i++) {
      const el = cands[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) return r;
    }
    return null;
  }

  // Left edge of the player page — which is what "beside the nav rail" means.
  function playerPageLeft() {
    const el = document.querySelector("ytmusic-player-page");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 100 ? r.left : null;
  }

  // Top edge of the player bar. Its progress slider sits at the very top of the
  // bar, so clearing this clears the slider too.
  function playerBarTop() {
    const bar = document.querySelector("ytmusic-player-bar");
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    return r.height > 20 ? r.top : null;
  }

  // Aurora's own fullscreen overlay reparents the media, so the pill's anchor no
  // longer means anything there. Hide instead of floating somewhere wrong.
  function inAuroraFullscreen() {
    return !!document.querySelector(".ym-sl-fs-overlay");
  }

  /* ---- render ------------------------------------------------------------ */
  function buildPill() {
    ensureStyle();
    thumbEl = makeEl("img", "ym-nu-thumb");
    thumbEl.alt = "";
    titleEl = makeEl("div", "ym-nu-title");
    const label = makeEl("div", "ym-nu-label", "Next");
    const text = makeEl("div", "ym-nu-text");
    text.appendChild(label);
    text.appendChild(titleEl);
    pill = makeEl("div");
    pill.id = PILL_ID;
    pill.setAttribute("role", "button");
    pill.appendChild(thumbEl);
    pill.appendChild(text);
    pill.addEventListener("click", () => {
      // The pill shows the track IMMEDIATELY after the current one, so a single
      // `next()` is exactly right.
      try {
        if (window.YTMod && window.YTMod.player && window.YTMod.player.next) {
          window.YTMod.player.next();
        }
      } catch (_) {}
    });
    // NEST in YTM's own player page so the pill is "actually in the website"
    // (AJ, 2026-09-29). Falls back to body only if that element isn't ready yet;
    // the per-tick ensureParent() re-seats it correctly either way.
    const host = document.querySelector("ytmusic-player-page") || document.body;
    host.appendChild(pill);
  }

  function hidePill() {
    currentKey = "";
    if (pill) pill.classList.remove("ym-nu-in");
  }

  // Swap the pill's text + thumbnail. On a real change (not the first paint) the
  // content fades + slides out, the new data is written while it is invisible, then
  // it eases back in — so a song transition reads as a smooth update, not a hard
  // swap (AJ, 2026-09-28). Reduced-motion users get the instant swap.
  function swapContent(next, animate) {
    const apply = () => {
      titleEl.textContent = next.title;
      titleEl.title = next.artist ? next.title + " \u2014 " + next.artist : next.title;
      if (settings.showArt && next.thumb) {
        thumbEl.src = next.thumb;
        thumbEl.style.display = "";
      } else {
        thumbEl.removeAttribute("src");
        thumbEl.style.display = "none";
      }
      pill.style.paddingLeft = settings.showArt && next.thumb ? "" : "16px";
      // Re-stamp the glide angle so a NEW pill never flashes at 0deg before the
      // rAF catches up (the credit pills do the same).
      spinPill(glowDeg);
      // Two glow colours from the NEW thumbnail. Cached, async, and it silently
      // keeps the CSS default pair when the canvas is unreadable.
      sampleThumbColors(next.thumb).then((pair) => {
        if (!pair || !pill) return;
        pill.style.setProperty("--ym-nu-accent-a", pair.a);
        pill.style.setProperty("--ym-nu-accent-b", pair.b);
      });
    };
    const reduce = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduce) { apply(); return; }
    let done = false;
    const fadeIn = () => {
      if (done) return;
      done = true;
      pill.removeEventListener("transitionend", onOut);
      apply();
      // Next frame(s): drop the swap state so the content rises + fades back in.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        pill.classList.remove("ym-nu-swap");
      }));
    };
    const onOut = (e) => { if (e.propertyName === "opacity") fadeIn(); };
    pill.classList.add("ym-nu-swap");
    pill.addEventListener("transitionend", onOut);
    // Safety net: if transitionend never fires (e.g. the pill is off-screen),
    // still complete the swap so the content never gets stuck invisible.
    setTimeout(fadeIn, 280);
  }

  // Mount the pill into the right surface: the player page in normal view (so it is
  // NESTED in YTM's own DOM and moves with the layout — "actually in the website",
  // AJ 2026-09-29), and the fullscreen overlay when Aurora's FS is active (so it
  // stays ABOVE the overlay instead of being trapped behind it). Re-parents only
  // when the target changes; runs every tick so a YTM re-render that wipes the
  // player page silently re-attaches it.
  // The pill's ONLY home: YTM's player page, so it is nested in the real DOM and
  // moves with the layout ("actually in the website", AJ 2026-09-29). It is no
  // longer re-parented into the fullscreen overlay — tick() hides it there instead
  // (AJ, 2026-10-01) — but it is STILL parked here while hidden, because the
  // overlay is removed wholesale on exit and would take a nested pill with it.
  // The body fallback covers the moment YTM has no player page.
  function ensureParent() {
    if (!pill) return;
    const target = document.querySelector("ytmusic-player-page") || document.body;
    if (target && pill.parentElement !== target) {
      target.appendChild(pill);
      // A fresh parent resets the layout: the next position write must land
      // UNtransitioned or the pill would glide in from 0,0 on the reparent.
      // (Only fires when the parent actually changes, so steady-state resize
      // still glides smoothly.)
      positioned = false;
    }
  }

  function positionPill(box) {
    if (!pill) return;
    const h = pill.offsetHeight || 48;
    // The pill is ABSOLUTE inside its parent, so its top/left/right are relative to
    // that parent's box. That parent is ALWAYS the player page now — the fullscreen
    // overlay branch is gone, because tick() hides the pill in fullscreen rather
    // than re-parenting it into the overlay (AJ, 2026-10-01).
    const parent = document.querySelector("ytmusic-player-page") || document.body;
    const pr = parent.getBoundingClientRect();
    if (!box) return;
    // AJ (2026-09-29): sit in the BOTTOM corner, just ABOVE the progress bar /
    // player bar — NOT hugging the video's bottom edge. Horizontal anchor
    // (player-page edge) is unchanged. If the bar can't be measured, fall back
    // to tucking just under the media.
    const barTop = playerBarTop();
    let top;
    if (barTop != null) {
      top = barTop - h - BAR_CLEARANCE_PX;
      // The glow ::after reaches ~14px past the pill; BAR_CLEARANCE_PX covers it.
      // Don't climb higher than the media bottom (would overlap the artwork).
      const minTop = box.bottom + 2;
      if (top < minTop) top = minTop;
    } else {
      top = box.bottom + GAP_PX;
    }
    // Viewport → parent-relative (the pill now lives INSIDE the player page).
    pill.style.top = Math.round(top - pr.top) + "px";
    if (settings.alignRight) {
      pill.style.left = "auto";
      pill.style.right = Math.round(pr.right - box.right) + "px";
    } else {
      // LEFT anchors to the PLAYER PAGE's own left edge — i.e. right beside the
      // nav rail — rather than to the artwork, which sits centred in a much wider
      // column and left the pill stranded mid-screen (AJ, 2026-09-28).
      const pageLeft = playerPageLeft();
      const leftVp = pageLeft == null ? box.left : pageLeft + SIDE_PAD_PX;
      pill.style.right = "auto";
      pill.style.left = Math.round(leftVp - pr.left) + "px";
    }
  }

  function tick() {
    if (!pill) return;
    // Aurora's fullscreen overlay owns the whole viewport, and the pill has no
    // sensible anchor inside it. It used to RE-PARENT into the overlay and pin to
    // its top-left corner, which just cluttered the view (AJ, 2026-10-01). Hide it
    // outright instead.
    const fs = inAuroraFullscreen();
    pill.classList.toggle("ym-nu-fs", fs);
    // Seat the pill in its surface BEFORE the early return. ensureParent(false) is
    // NOT optional here: the overlay is removed wholesale when fullscreen exits, so
    // a pill left nested inside it would be destroyed with it and never come back.
    // Parking it in the player page keeps it alive behind the overlay.
    ensureParent();
    // Record the mount surface so the bridge (which has no JS-eval) can verify
    // nesting. Harmless debug signal.
    pill.setAttribute("data-host", "player-page");
    if (fs) { hidePill(); return; }
    const box = mediaBox();
    if (!box) { hidePill(); return; }
    const next = readNext();
    if (!next) { hidePill(); return; }
    // Keyed so the DOM is only touched when the track actually changes.
    const key = next.title + "|" + next.artist + "|" + next.thumb;
    if (key !== currentKey) {
      const firstRender = currentKey === "";
      currentKey = key;
      // First paint skips the crossfade (nothing to fade FROM); later changes
      // fade the content out, swap, then fade back in via swapContent().
      swapContent(next, !firstRender);
    }
    if (!positioned) {
      // Suppress the position transition for this ONE write, or the pill glides in
      // from 0,0 on its first frame.
      pill.classList.add("ym-nu-no-pos-trans");
      positionPill(box);
      void pill.offsetWidth; // flush, so the write lands untransitioned
      pill.classList.remove("ym-nu-no-pos-trans");
      positioned = true;
    } else {
      positionPill(box);
    }
    pill.classList.add("ym-nu-in");
  }

  // Reposition IMMEDIATELY on layout changes instead of waiting up to TICK_MS for
  // the next poll — this kills the ~500ms lag AJ saw where the pill sat in its old
  // spot when entering/leaving fullscreen or resizing (AJ, 2026-09-29). A plain
  // resize glides (same parent → the transition carries). A fullscreen toggle
  // re-parents the pill, so it lands instantly — a cross-parent CSS glide isn't
  // possible, and an instant land on a fullscreen switch reads fine anyway.
  let repaintQueued = false;
  function scheduleReposition() {
    if (repaintQueued || !pill) return;
    repaintQueued = true;
    requestAnimationFrame(() => {
      repaintQueued = false;
      tick();
    });
  }
  function onFullscreenChange() {
    if (!pill) return;
    tick();
    // The overlay can settle a frame after the event; re-check so the pill lands
    // correctly even if it appeared just after fullscreenchange fired.
    setTimeout(tick, 80);
  }

  function applySettings(next) {
    if (!next || typeof next !== "object") return;
    settings = {
      showArt: typeof next.showArt === "boolean" ? next.showArt : DEFAULT_SETTINGS.showArt,
      alignRight: typeof next.alignRight === "boolean" ? next.alignRight : DEFAULT_SETTINGS.alignRight,
      smoothGlow: typeof next.smoothGlow === "boolean" ? next.smoothGlow : DEFAULT_SETTINGS.smoothGlow,
    };
    // Apply the glow rate immediately so the toggle takes effect without a reload.
    setGlowRate(settings.smoothGlow);
    currentKey = ""; // force a re-render on the next tick
  }

  function start() {
    buildPill();
    startGlow();
    tickTimer = window.setInterval(tick, TICK_MS);
    tick();
    window.postMessage({ type: "ytmod-settings-request", id: EXT_ID }, "*");
    // React to layout changes at once (kills the fullscreen/resize lag).
    window.addEventListener("resize", scheduleReposition);
    document.addEventListener("fullscreenchange", onFullscreenChange);
  }

  function teardown() {
    if (tickTimer) { window.clearInterval(tickTimer); tickTimer = 0; }
    stopGlow();
    window.removeEventListener("resize", scheduleReposition);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
    pill = null;
    thumbEl = null;
    titleEl = null;
    currentKey = "";
    positioned = false;
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
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
