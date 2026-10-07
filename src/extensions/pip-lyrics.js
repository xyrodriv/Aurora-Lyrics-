/*
 * PiP Lyrics — Aurora Lyrics add-on.
 *
 * Puts the synced lyrics in a Document Picture-in-Picture window, so they float
 * always-on-top while you work in another tab.
 *
 * Design notes worth keeping:
 *   - Lyrics come from the host bus ("lyrics:lines"), NOT from scraping the
 *     lyrics panel's DOM. DOM scraping across add-ons is what makes this kind of
 *     feature fragile; the panel publishes a plain-data contract instead.
 *   - The PiP window is a SEPARATE document. Nothing carries over: fonts, CSS
 *     and variables must all be re-declared there. Font URLs are absolute
 *     extension URLs derived from this script's own src.
 *   - Word fill uses background-clip: text on the element that directly contains
 *     the text. Putting the gradient on a wrapper whose children are the words
 *     paints a filled box instead (this cost a bug once already).
 *   - Highlighting is driven by polling the player position in the PiP window's
 *     own rAF loop rather than by bus events, so it stays smooth between lines.
 *
 * Runs in the page world (injected as <script src>).
 */
(function () {
  "use strict";

  const EXT_ID = "ytmod-pip-lyrics";
  const SCRIPT_URL = (document.currentScript && document.currentScript.src) || "";
  const FONT_BASE = SCRIPT_URL ? new URL("fonts/", SCRIPT_URL).href : "";

  const DEFAULTS = { master: true, showTransport: true };
  let settings = Object.assign({}, DEFAULTS);

  const ICON_PIP =
    "M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 " +
    "2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z";

  const ICON_PLAY = "M8 5v14l11-7z";
  const ICON_PAUSE = "M6 19h4V5H6v14zm8-14v14h4V5h-4z";
  const ICON_PREV = "M6 6h2v12H6zm3.5 6l8.5 6V6z";
  const ICON_NEXT = "M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z";
  // Shuffle / Repeat / Repeat-one — the panel's own glyphs (08-fullscreen-controls),
  // so the PiP's toggles match the fullscreen chip exactly.
  const ICON_SHUFFLE = "M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z";
  const ICON_REPEAT = "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z";
  const ICON_REPEAT_ONE = "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z";
  const ICON_VOLUME = "M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12z";

  // Same vendored Kawarp module the Dynamic theme and the fullscreen backdrop
  // use, so the PiP gets the identical fluid treatment rather than a lookalike.
  const KAWARP_CORE_URL = SCRIPT_URL ? new URL("kawarp-core.js", SCRIPT_URL).href : "";
  const KAWARP_OPTIONS = {
    warpIntensity: 1,
    blurPasses: 6,
    animationSpeed: 0.5,
    saturation: 1.5,
    dithering: 0.008,
    transitionDuration: 1000,
    tintIntensity: 0,
    scale: 1.08,
  };
  let kawarpModulePromise = null;

  // Ask the artwork CDN for a big thumbnail instead of the 60px bar one.
  function hiResArt(url) {
    if (!url || typeof url !== "string") return url;
    if (/=w\d+(-h\d+)?/.test(url)) return url.replace(/=w\d+(-h\d+)?/, "=w1024-h1024");
    return url + "=w1024-h1024";
  }

  function getKawarpConstructor() {
    if (!KAWARP_CORE_URL) return Promise.reject(new Error("Kawarp module URL unavailable."));
    if (!kawarpModulePromise) {
      kawarpModulePromise = import(KAWARP_CORE_URL).then((module) => {
        const Kawarp = module.default || module.Kawarp;
        if (typeof Kawarp !== "function") throw new Error("Kawarp module did not export a constructor.");
        return Kawarp;
      });
    }
    return kawarpModulePromise;
  }

  /* ---- panel renderer reuse -------------------------------------------------
     Rather than approximate the lyrics look, the PiP draws with the panel's OWN
     stylesheet. The panel injects it as <style id="ym-sl-style">, it defines all
     the variables it needs (--gradient-degrees, --gradient-offset,
     --Vocal-Sung/NotSung-opacity, --DefaultLyricsSize ...), and its fill is a
     linear-gradient + background-clip:text driven by --gradient-position on the
     leaf .word/.letter elements.

     What is reused verbatim: the stylesheet, the markup (makeLetterGroup's
     .letterGroup > .letter, plain .word spans), the state classes
     (Active/Sung/NotSung on .line, WordSung/WordNotSung on words) and the
     gradient formula (-20 + 120 * easeSinOut(progress) per letter).

     What is intentionally different: only the outer PiP shell (Kawarp, header,
     transport controls, and the separate-document camera). The lyric DOM,
     state intervals, background-vocal windows, provider footer, per-word/per-
     letter springs, splines, sync offset, and scroll spring are kept on the
     panel's published contract so the lyric surface follows the same behavior.
  */
  function panelStylesheetText() {
    const el = document.getElementById("ym-sl-style");
    return el && el.textContent ? el.textContent : "";
  }

  function easeSinOut(t) {
    const x = Math.max(0, Math.min(1, t));
    return Math.sin((x * Math.PI) / 2);
  }

  // Same predicate the panel uses for its state classes.
  function getState(positionMs, startMs, endMs) {
    if (positionMs < startMs) return "NotSung";
    if (positionMs >= endMs) return "Sung";
    return "Active";
  }

  // Re-derive the host's lyric clock from the raw player position + the sync
  // state published on "lyrics:sync". This mirrors aurora-lyrics.js
  // getOffsetForPosition() exactly, so the PiP tracks the synced tab instead of
  // running on raw playback (which would be early/late by the offset).
  function offsetForPosition(positionMs) {
    if (!syncState || !syncState.pauseSync) return syncState ? syncState.offsetMs : 0;
    const ps = syncState.pauseSync;
    if (positionMs - ps.offset >= ps.line) return ps.offset;
    return syncState.offsetMs;
  }

  function lyricPositionMs(positionMs) {
    if (positionMs == null) return null;
    return Math.max(0, positionMs - offsetForPosition(positionMs));
  }

  // Same click-to-seek rule as the main panel: line timestamps are lyric-clock
  // times, so put the active offset back when converting them to player time.
  function offsetForLine(startMs) {
    if (syncState && syncState.pauseSync && Number.isFinite(startMs) &&
        startMs >= syncState.pauseSync.line) {
      return Number(syncState.pauseSync.offset) || 0;
    }
    return syncState ? Number(syncState.offsetMs) || 0 : 0;
  }

  function seekToLyricTime(startMs) {
    const p = player();
    if (!p || typeof p.seek !== "function" || !Number.isFinite(startMs)) return;
    p.seek(Math.max(0, startMs + offsetForLine(startMs)));
  }

  // Copy the panel's live custom properties onto the PiP wrapper, so the user's
  // lyric size, offset, background-vocal, gradient, blur, and opacity settings
  // are literally the same on both surfaces. The old PiP-only zoom deliberately
  // diverged here; it is removed from the settings UI below.
  const COPIED_VARS = [
    "--ym-sl-lyrics-scale",
    "--ym-sl-lyrics-offset",
    "--ym-sl-bg-vocal-scale",
    "--gradient-alpha",
    "--gradient-alpha-end",
    "--gradient-degrees",
    "--gradient-offset",
    "--Vocal-Sung-opacity",
    "--Vocal-NotSung-opacity",
    "--BlurAmount",
  ];

  function copyPanelVars(target) {
    if (!target) return;
    const panel = document.getElementById("ym-sl-panel");
    if (!panel) return;
    // Size/opacity live on the panel's LyricsContent, while some inherited
    // properties resolve on the outer panel. Prefer the content node so the
    // copied --ym-sl-lyrics-scale is the actual live slider value.
    const source = panel.querySelector(".LyricsContent") || panel;
    const cs = getComputedStyle(source);
    COPIED_VARS.forEach((name) => {
      const v = cs.getPropertyValue(name);
      if (v && v.trim()) target.style.setProperty(name, v.trim());
    });
  }

  const CSS = `
    /* ===== PiP Lyrics (Aurora Lyrics) ===== */
    .ym-pip {
      position: fixed;
      inset: 0;
      display: flex;
      flex-direction: column;
      padding: 14px 18px 10px;
      box-sizing: border-box;
      /* Fallback for when Kawarp cannot start (no WebGL, module failure). */
      background: linear-gradient(180deg, #17181c 0%, #0c0d10 100%);
      color: #fff;
      font-family: "SpicyLyrics", Roboto, Arial, sans-serif;
      overflow: hidden;
      user-select: none;
    }
    /* The Kawarp canvas is the backdrop; everything else sits above it. */
    .ym-pip-kawarp {
      position: absolute;
      inset: 0;
      z-index: 0;
      opacity: 0;
      transition: opacity .6s ease;
      transform: scale(1.06);
      transform-origin: center;
    }
    .ym-pip-kawarp.ready { opacity: 1; }
    /* Legibility scrim over the fluid — keeps lyric contrast stable whatever
       colours the artwork throws out. */
    .ym-pip-scrim {
      position: absolute;
      inset: 0;
      z-index: 1;
      pointer-events: none;
      background: linear-gradient(180deg,
        rgba(0, 0, 0, .5) 0%, rgba(0, 0, 0, .22) 42%, rgba(0, 0, 0, .62) 100%);
    }
    .ym-pip > .ym-pip-head,
    .ym-pip > .ym-pip-lines,
    .ym-pip > .ym-pip-transport { position: relative; z-index: 2; }
    .ym-pip-head {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 0 0 auto;
      margin-bottom: 10px;
      min-width: 0;
    }
    /* Cover art thumbnail (AJ, 2026-10-07). Hidden until the track supplies
       artwork, so a track with none leaves no gap. */
    .ym-pip-art {
      width: 40px;
      height: 40px;
      flex: 0 0 auto;
      border-radius: 6px;
      object-fit: cover;
      background: rgba(255, 255, 255, .08);
      display: none;
    }
    .ym-pip-art.has-art { display: block; }
    /* Source label, pushed to the right edge of the header (AJ, 2026-10-07). */
    .ym-pip-source {
      margin-left: auto;
      flex: 0 0 auto;
      font-size: 11px;
      color: rgba(255, 255, 255, .38);
      white-space: nowrap;
    }
    /* The title/artist stack beside the art. min-width:0 is what lets the
       ellipsis actually engage inside a flex row. */
    .ym-pip-meta {
      display: flex;
      flex-direction: column;
      min-width: 0;
      gap: 1px;
    }
    .ym-pip-title {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: .2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ym-pip-artist {
      font-size: 12px;
      font-weight: 400;
      color: rgba(255, 255, 255, .5);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ym-pip-lines {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      /* border-box is REQUIRED for the padding below to do anything: as a
         stretched flex item this element defaults to content-box, so padding
         would be added OUTSIDE the box (past the window edge) instead of
         insetting the content. */
      box-sizing: border-box;
      overflow-x: hidden;
      overflow-y: auto;
      /* NO VISIBLE SCROLLBAR (AJ, 2026-10-07): the draggable thumb on the right
         was unwanted. Hiding it also means the gutter must go — with
         scrollbar-gutter:stable a blank strip would still be reserved. The 32px
         right inset STAYS: it is there because the ACTIVE line's glyphs paint past
         the layout box (a transform does not change layout) and overflow-x:hidden
         would clip them. Scrolling itself is unchanged; "Jump to current" is the
         discoverable way back to the active line. */
      padding-right: 32px;
      overscroll-behavior: contain;
      /* smooth, so the one-shot "auto" writes (smoothScrolling OFF) actually
         EASE. The per-frame spring writes pass behavior:"instant" to override
         this, so the two never fight. */
      scroll-behavior: smooth;
      scroll-snap-type: none;
      overflow-anchor: none;
      scrollbar-width: none;
    }
    .ym-pip-lines::-webkit-scrollbar { display: none; width: 0; height: 0; }
    .ym-pip-jump {
      position: absolute;
      z-index: 5;
      /* Bottom-LEFT, so it sits to the side of the centred transport controls
         rather than on top of them. */
      left: 12px;
      bottom: 12px;
      display: none;
      padding: 7px 12px;
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 999px;
      background: rgba(20,20,24,.82);
      color: rgba(255,255,255,.92);
      font: 600 12px/1.2 "SpicyLyrics", Roboto, Arial, sans-serif;
      cursor: pointer;
      white-space: nowrap;
      backdrop-filter: blur(8px);
    }
    .ym-pip-jump.visible { display: block; }
    .ym-pip-jump:hover { background: rgba(255,255,255,.16); }
    /* Normal flow is important: the outer .ym-pip-lines element is the actual
       scroll container, and the credits footer must come AFTER the lyric track,
       not underneath an absolutely-positioned track at the top. */
    .ym-pip-track {
      position: relative;
      display: block;
    }
    /* The panel's stylesheet owns the lyric look — typography, letter splitting,
       gradient fill and the Active/Sung/NotSung states all come from it. These
       rules only adapt it to a small floating window: neutralise the panel
       container's own chrome, lay the lines out on our translate track, and let
       far-away lines recede. Scoped with an extra class so they out-specify the
       panel's own rules rather than fighting them with !important everywhere. */
    #ym-sl-panel.ym-pip-panel {
      position: relative !important;
      inset: auto !important;
      width: 100% !important;
      min-height: 100% !important;
      height: auto !important;
      padding: 0 !important;
      margin: 0 !important;
      border: 0 !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      background: none !important;
      transform: none !important;
      overflow: visible !important;
    }
    #ym-sl-panel.ym-pip-panel .LyricsContent {
      position: relative !important;
      height: auto !important;
      min-height: 100% !important;
      padding: 0 !important;
      margin: 0 !important;
      overflow: visible !important;
      background: none !important;
      transform: none !important;
      -webkit-mask-image: none !important;
      mask-image: none !important;
    }
    #ym-sl-panel.SpicyRenderer .line {
      margin: 0 !important;
      padding: 2px 0 !important;
      text-align: left;
      cursor: pointer;
    }
    /* A narrow window has to WRAP. The panel lays a line out as a wrapping flex
       row of .word elements, but that row is only as wide as its CONTENT unless
       we pin it - so it runs past the edge and .ym-pip-lines (overflow-x:hidden)
       cuts it off mid-word. Pin the row to the box width, keep wrapping on, and
       allow a break inside a long word. */
    #ym-sl-panel.SpicyRenderer .line {
      width: 100% !important;
      max-width: 100% !important;
      flex-wrap: wrap !important;
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
    }
    /* Duet lines go on the RIGHT. The panel does this with justify-content:
       flex-end, but its rule is scoped to .SpicyLyricsScrollContainer.HasDuetLines
       - a wrapper the PiP does not have - and text-align does NOT move flex
       items, so duet lines always landed on the left here. Align them directly.
       NO BACKTICKS IN THIS COMMENT: the CSS lives inside a JS template literal. */
    #ym-sl-panel.SpicyRenderer .line.OppositeAligned:not(.rtl) {
      justify-content: flex-end !important;
      padding-left: 8%;
      text-align: right;
      transform-origin: right center;
    }
    /* Own class: the panel relies on its scroll container plus adaptive spacing
       to fade distant lines, which a small window has no room for. */
    #ym-sl-panel.SpicyRenderer .line.ym-pip-far { opacity: .2 !important; }
    .ym-pip-transport {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      padding-top: 8px;
      /* The volume sits at the far right WITHOUT dragging the centred transport
         off-centre — an auto margin would eat all the free space. */
      position: relative;
    }
    .ym-pip-transport button {
      width: 34px;
      height: 34px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: none;
      color: rgba(255, 255, 255, .82);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ym-pip-transport button:hover { background: rgba(255, 255, 255, .12); color: #fff; }
    .ym-pip-transport button svg { width: 22px; height: 22px; fill: currentColor; }
    .ym-pip-transport .ym-pip-main svg { width: 28px; height: 28px; }
    /* ---- seek row, shuffle/repeat, volume (AJ, 2026-10-07) ---------------- */
    .ym-pip-seek {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 8px;
      padding-top: 8px;
    }
    .ym-pip-time {
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      color: rgba(255, 255, 255, .6);
      min-width: 30px;
    }
    .ym-pip-time:last-child { text-align: right; }
    /* Shared range look for the seek + volume sliders. */
    .ym-pip-seek-range,
    .ym-pip-volume {
      -webkit-appearance: none;
      appearance: none;
      height: 4px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .22);
      cursor: pointer;
    }
    .ym-pip-seek-range { flex: 1 1 auto; min-width: 0; }
    .ym-pip-seek-range::-webkit-slider-thumb,
    .ym-pip-volume::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 4px rgba(0, 0, 0, .5);
    }
    /* Shuffle / Repeat are dimmed at rest and full white when engaged — the class
       is set from the LIVE player state in syncLoop, so they cannot lie. */
    .ym-pip-transport .ym-pip-opt { color: rgba(255, 255, 255, .55); }
    .ym-pip-transport .ym-pip-opt.active { color: #fff; }
    .ym-pip-vol {
      position: absolute;
      right: 0;
      top: calc(50% + 4px);
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      gap: 6px;
      color: rgba(255, 255, 255, .7);
    }
    .ym-pip-vol svg { width: 18px; height: 18px; fill: currentColor; flex: 0 0 auto; }
    .ym-pip-volume { width: 70px; }
    .ym-pip-hint {
      flex: 0 0 auto;
      text-align: center;
      font-size: 11px;
      color: rgba(255, 255, 255, .34);
    }
  `;

  // ---- state ---------------------------------------------------------------
  let btnHandle = null;
  let pipWin = null;
  let pipDoc = null;
  let rafId = 0;
  let lines = [];
  let linesVideoId = null;
  let staticLyrics = false;
  let romanizationEnabled = true;
  let songwriters = [];
  let attribution = null;
  let smoothScrolling = true;
  let simpleLyrics = false;
  let scrollLeadEnabled = false;
  let scrollLeadMs = 0;
  let lastRenderedActive = -2;
  let lastRenderedTarget = -2;
  let lineEls = [];
  let lineSets = [];   // animation records, parallel to lineEls
  let kit = null;      // the panel's published animation kit (lyrics:renderer)
  let lastFrameAt = 0;
  let lastTrackCheckAt = 0;
  let unsubscribe = null;
  let unsubscribeKit = null;
  let unsubscribeSync = null;
  let unsubscribeSettings = null;
  // Resolved sync state from the host (lyrics:sync): the base offset and any
  // MV-pause re-sync segment. Mirrors the panel's getOffsetForPosition() so the
  // PiP lyric clock matches the synced tab instead of running on raw playback.
  let syncState = null;

  function player() {
    return (window.YTMod && window.YTMod.player) || null;
  }

  function whenYTMod(callback) {
    if (window.YTMod && window.YTMod.player) return callback();
    setTimeout(() => whenYTMod(callback), 200);
  }

  function supported() {
    return typeof window.documentPictureInPicture !== "undefined" &&
           typeof window.documentPictureInPicture.requestWindow === "function";
  }

  // ---- pip document --------------------------------------------------------
  function fontFaces() {
    if (!FONT_BASE) return "";
    const faces = [
      [400, "LyricsRegular.woff2"],
      [500, "LyricsMedium.woff2"],
      [600, "LyricsSemibold.woff2"],
      [700, "LyricsBold.woff2"],
    ];
    return faces.map(([weight, file]) =>
      "@font-face{font-family:'SpicyLyrics';font-style:normal;font-weight:" + weight +
      ";font-display:swap;src:url('" + FONT_BASE + file + "') format('woff2');}"
    ).join("");
  }

  function makeEl(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svgIcon(doc, pathData) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS(NS, "path");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
    return svg;
  }

  function buildPipDoc(win) {
    const doc = win.document;
    doc.title = "Aurora Lyrics";

    // Order matters: fonts, then the PANEL's own stylesheet (so the lyrics are
    // drawn by the real renderer CSS), then our shell overrides on top.
    const style = doc.createElement("style");
    style.textContent = fontFaces() + panelStylesheetText() + CSS;
    doc.head.appendChild(style);

    const root = makeEl(doc, "div", "ym-pip");
    root.id = "ym-pip-root";

    // Kawarp backdrop (the same module the Dynamic theme uses), with a scrim on
    // top so lyric contrast does not depend on the artwork's colours.
    const canvas = doc.createElement("canvas");
    canvas.className = "ym-pip-kawarp";
    canvas.id = "ym-pip-kawarp";
    root.appendChild(canvas);
    const scrim = makeEl(doc, "div", "ym-pip-scrim");
    root.appendChild(scrim);

    const head = makeEl(doc, "div", "ym-pip-head");
    // Cover art (AJ, 2026-10-07): a small square thumbnail beside the title, like
    // the fullscreen header. The src is set in setHeader() from the track's
    // artworkUrl; it stays empty (and collapses) until a track is known.
    const art = makeEl(doc, "img", "ym-pip-art");
    art.id = "ym-pip-art";
    art.alt = "";
    head.appendChild(art);
    const meta = makeEl(doc, "div", "ym-pip-meta");
    meta.appendChild(makeEl(doc, "div", "ym-pip-title", "Aurora Lyrics"));
    const artist = makeEl(doc, "div", "ym-pip-artist", "");
    artist.id = "ym-pip-artist";
    meta.appendChild(artist);
    head.appendChild(meta);
    // Source label (AJ, 2026-10-07) — dim, pushed to the far right of the header.
    head.appendChild(makeEl(doc, "div", "ym-pip-source", "Aurora Lyrics"));
    root.appendChild(head);

    const linesBox = makeEl(doc, "div", "ym-pip-lines");
    linesBox.id = "ym-pip-lines";
    const jump = makeEl(doc, "button", "ym-pip-jump", "Jump to current lyric");
    jump.id = "ym-pip-jump";
    jump.type = "button";
    jump.setAttribute("aria-label", "Jump to current lyric");
    jump.addEventListener("click", () => jumpToCurrentLyric());
    // OVERLAY, not content: appended to the fixed .ym-pip root, NOT to the
    // scroll box. As a child of .ym-pip-lines it scrolled away with the lyrics
    // (an absolutely-positioned child of a scroll container scrolls with it).
    root.appendChild(jump);
    // The PiP uses the same scroll semantics as the main panel. A manual wheel
    // gesture stops the camera spring so it cannot fight the user's scroll.
    linesBox.addEventListener("wheel", () => {
      pipManualScrollPaused = true;
      pipManualScrollAt = performance.now();
      centerTargetY = null;
      resetCameraGlide();
    }, { passive: true });
    linesBox.addEventListener("touchstart", () => {
      pipManualScrollPaused = true;
      pipManualScrollAt = performance.now();
      centerTargetY = null;
      resetCameraGlide();
    }, { passive: true });
    // The panel's stylesheet is scoped to #ym-sl-panel.SpicyRenderer, so the PiP
    // has to present that same wrapper for the lyric rules to apply at all.
    const panelWrap = makeEl(doc, "div", "SpicyRenderer ym-pip-panel");
    panelWrap.id = "ym-sl-panel";
    const lyricsContent = makeEl(doc, "div", "LyricsContent");
    lyricsContent.id = "ym-pip-content";
    // Do NOT set a PiP-specific --DefaultLyricsSize. The shared stylesheet's
    // container-relative formula must win, and copyPanelVars() below copies the
    // panel's live --ym-sl-lyrics-scale into this same LyricsContent tree.
    panelWrap.appendChild(lyricsContent);
    linesBox.appendChild(panelWrap);
    root.appendChild(linesBox);

    if (settings.showTransport !== false) {
      // ---- seek row (AJ, 2026-10-07) --------------------------------------
      // Times either side of a range, mirroring the fullscreen scrubber. The range
      // is a 0..1000 RATIO, so it never depends on the duration arriving first.
      const seekRow = makeEl(doc, "div", "ym-pip-seek");
      const cur = makeEl(doc, "span", "ym-pip-time", "0:00");
      cur.id = "ym-pip-time-cur";
      const seek = makeEl(doc, "input", "ym-pip-seek-range");
      seek.id = "ym-pip-seek";
      seek.type = "range";
      seek.min = "0";
      seek.max = "1000";
      seek.step = "1";
      seek.value = "0";
      seek.setAttribute("aria-label", "Seek");
      const total = makeEl(doc, "span", "ym-pip-time", "0:00");
      total.id = "ym-pip-time-total";
      seekRow.appendChild(cur);
      seekRow.appendChild(seek);
      seekRow.appendChild(total);
      root.appendChild(seekRow);
      // While the user is dragging, the per-frame sync must not fight the thumb —
      // the same grace window the fullscreen seek uses.
      seek.addEventListener("pointerdown", () => { pipSeekUserAt = performance.now(); });
      seek.addEventListener("input", () => { pipSeekUserAt = performance.now(); });
      const commitSeek = () => {
        pipSeekUserAt = performance.now();
        const p = player();
        const dur = p && p.getDurationMs ? Number(p.getDurationMs()) : 0;
        if (!p || typeof p.seek !== "function" || !Number.isFinite(dur) || dur <= 0) return;
        p.seek(Math.round((Number(seek.value) / 1000) * dur));
      };
      seek.addEventListener("change", commitSeek);
      seek.addEventListener("pointerup", commitSeek);
      pipSeekEl = seek;

      // ---- transport row ---------------------------------------------------
      const bar = makeEl(doc, "div", "ym-pip-transport");

      // Shuffle / Repeat drive YTM's OWN player-bar buttons (there is no YTMod API
      // for them) through the panel's helper, and read the LIVE state back each
      // tick so they can never lie about the real mode.
      const shuffle = makeEl(doc, "button", "ym-pip-opt ym-pip-shuffle");
      shuffle.id = "ym-pip-shuffle";
      shuffle.type = "button";
      shuffle.title = "Shuffle";
      shuffle.setAttribute("aria-label", "Shuffle");
      shuffle.setAttribute("aria-pressed", "false");
      shuffle.appendChild(svgIcon(doc, ICON_SHUFFLE));
      shuffle.addEventListener("click", () => {
        if (kit && kit.clickPlayerButton) kit.clickPlayerButton("shuffle");
      });

      const prev = makeEl(doc, "button", "");
      prev.type = "button";
      prev.title = "Previous";
      prev.setAttribute("aria-label", "Previous");
      prev.appendChild(svgIcon(doc, ICON_PREV));
      prev.addEventListener("click", () => { const p = player(); if (p && p.previous) p.previous(); });

      const main = makeEl(doc, "button", "ym-pip-main");
      main.id = "ym-pip-toggle";
      main.type = "button";
      main.title = "Play / pause";
      main.setAttribute("aria-label", "Play or pause");
      main.appendChild(svgIcon(doc, ICON_PLAY));
      main.addEventListener("click", () => { const p = player(); if (p && p.togglePlay) p.togglePlay(); });

      const next = makeEl(doc, "button", "");
      next.type = "button";
      next.title = "Next";
      next.setAttribute("aria-label", "Next");
      next.appendChild(svgIcon(doc, ICON_NEXT));
      next.addEventListener("click", () => { const p = player(); if (p && p.next) p.next(); });

      const repeat = makeEl(doc, "button", "ym-pip-opt ym-pip-repeat");
      repeat.id = "ym-pip-repeat";
      repeat.type = "button";
      repeat.title = "Repeat";
      repeat.setAttribute("aria-label", "Repeat");
      repeat.setAttribute("aria-pressed", "false");
      repeat.appendChild(svgIcon(doc, ICON_REPEAT));
      repeat.addEventListener("click", () => {
        if (kit && kit.clickPlayerButton) kit.clickPlayerButton("repeat");
      });

      // Volume: a small speaker icon + a range, wired straight to the player API.
      const volWrap = makeEl(doc, "div", "ym-pip-vol");
      volWrap.appendChild(svgIcon(doc, ICON_VOLUME));
      const vol = makeEl(doc, "input", "ym-pip-volume");
      vol.id = "ym-pip-volume";
      vol.type = "range";
      vol.min = "0";
      vol.max = "100";
      vol.step = "1";
      vol.value = "100";
      vol.setAttribute("aria-label", "Volume");
      vol.addEventListener("input", () => {
        const p = player();
        // setVolume takes 0..1 (it clamps), while the range is 0..100 — passing the
        // raw 0..100 made every value >= 1 clamp to FULL volume, so nudging the
        // slider up jumped straight to max (AJ, 2026-10-07).
        if (p && typeof p.setVolume === "function") p.setVolume(Number(vol.value) / 100);
      });
      volWrap.appendChild(vol);
      pipVolumeEl = vol;

      bar.appendChild(shuffle);
      bar.appendChild(prev);
      bar.appendChild(main);
      bar.appendChild(next);
      bar.appendChild(repeat);
      bar.appendChild(volWrap);
      root.appendChild(bar);
    }

    doc.body.appendChild(root);
  }

  function pipEl(id) {
    return pipDoc ? pipDoc.getElementById(id) : null;
  }

  // ---- kawarp backdrop -----------------------------------------------------
  let kawarp = null;
  let kawarpArtUrl = null;
  let kawarpResizeObserver = null;
  let kawarpSeq = 0;

  function sizeKawarp() {
    const canvas = pipEl("ym-pip-kawarp");
    if (!canvas || !pipWin) return;
    const w = pipWin.innerWidth || 460;
    const h = pipWin.innerHeight || 300;
    const dpr = Math.min(pipWin.devicePixelRatio || 1, 1.5);
    const cw = Math.max(1, Math.round(w * dpr));
    const ch = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      if (kawarp && typeof kawarp.resize === "function") {
        try { kawarp.resize(); } catch (e) {}
      }
    }
  }

  function startKawarp(artUrl) {
    const canvas = pipEl("ym-pip-kawarp");
    if (!canvas || !KAWARP_CORE_URL) return;
    const seq = ++kawarpSeq;
    sizeKawarp();
    getKawarpConstructor().then(async (Kawarp) => {
      if (seq !== kawarpSeq || !pipWin || pipWin.closed) return;
      kawarp = new Kawarp(canvas, KAWARP_OPTIONS);
      if (artUrl) {
        await kawarp.loadImage(artUrl);
        kawarpArtUrl = artUrl;
      }
      if (seq !== kawarpSeq) return;
      kawarp.start();
      canvas.classList.add("ready");
      if (typeof pipWin.ResizeObserver === "function") {
        kawarpResizeObserver = new pipWin.ResizeObserver(() => sizeKawarp());
        kawarpResizeObserver.observe(canvas.parentElement || canvas);
      }
    }).catch((error) => {
      // Any failure falls back to the gradient background — never a blank window.
      console.warn("[Aurora Lyrics] PiP Kawarp failed:", error);
      if (canvas) canvas.classList.remove("ready");
      if (kawarp) { try { kawarp.dispose(); } catch (e) {} }
      kawarp = null;
    });
  }

  function stopKawarp() {
    kawarpSeq++;
    if (kawarpResizeObserver) { try { kawarpResizeObserver.disconnect(); } catch (e) {} }
    kawarpResizeObserver = null;
    if (kawarp) { try { kawarp.dispose(); } catch (e) {} }
    kawarp = null;
    kawarpArtUrl = null;
  }

  // Swap the artwork the fluid is built from when the track changes.
  function syncKawarpArt(artUrl) {
    const url = artUrl ? hiResArt(artUrl) : "";
    if (!url) return;
    if (!kawarp) { startKawarp(url); return; }
    if (url === kawarpArtUrl) return;
    kawarpArtUrl = url;
    try { kawarp.loadImage(url); } catch (e) {}
  }

  // ---- rendering -----------------------------------------------------------
  function setHeader() {
    const artist = pipEl("ym-pip-artist");
    if (!artist) return;
    const p = player();
    const track = p && p.getTrack ? p.getTrack() : null;
    const titleEl = pipDoc.querySelector(".ym-pip-title");
    if (titleEl) titleEl.textContent = (track && track.title) || "Aurora Lyrics";
    artist.textContent = (track && track.artist) || "";
    const art = pipEl("ym-pip-art");
    if (art) {
      const url = (track && track.artworkUrl) || "";
      // Only touch the src when it actually changes: re-assigning it restarts the
      // image load and would flicker the thumbnail on every tick.
      if (url && art.getAttribute("src") !== url) art.setAttribute("src", url);
      art.classList.toggle("has-art", !!url);
    }
    if (track && track.artworkUrl) syncKawarpArt(track.artworkUrl);
  }

  // One line, in the panel's exact markup. Plain syllables become .word; ones the
  // panel deems letter-capable become .letterGroup > .letter, using the panel's
  // own per-letter timing (letterEnd = end - 250ms, split evenly across chars).
  // Each element gets its own spring set from the panel's kit, mirroring the
  // panel's structure: a word-level store, plus a letter store per character.
  function makeAnimRecord(el, startMs, endMs, kind, lineTimed) {
    return {
      el: el,
      startMs: startMs,
      endMs: endMs,
      springs: kit
        ? (kind === "letter" ? kit.createLetterSprings() : kit.createWordSprings())
        : null,
      lastState: null,
      letters: null,
      // Mirror the panel's word.LineTimed flag (aurora-lyrics.js 6244, 6938-6945):
      // line-timed words stay at scale 1 / yOffset 0 (no bounce), and only Glow
      // is animated. Honoring this is what kills the PiP's active-line bounce —
      // the previous version applied blendSyllableAnimation to Scale and YOffset
      // unconditionally, which fed a non-rest moving goal to every word's spring.
      lineTimed: !!lineTimed,
    };
  }

  function buildLineElement(line, index) {
    const div = makeEl(pipDoc, "div", "line");
    div.dataset.index = String(index);
    if (line.opposite) div.classList.add("OppositeAligned");
    if (line.lineTimed) div.classList.add("line-timed");
    if (staticLyrics) div.classList.add("static");
    const words = (line.words && line.words.length)
      ? line.words
      : [{ text: line.text, startMs: line.startMs, endMs: line.endMs, isLast: true }];
    const records = [];
    const elements = [div];
    const bgIntervals = [];
    buildWordsInto(div, words, records, false, !!line.lineTimed);
    if (romanizationEnabled && line.romaji) {
      div.appendChild(makeEl(pipDoc, "div", "romaji", line.romaji));
    }
    // Match the main panel's click-to-seek behavior. Use the lyric-clock start,
    // then restore the active/pause-sync offset inside seekToLyricTime().
    div.addEventListener("click", () => seekToLyricTime(line.startMs));

    // Background vocals: the panel emits one .line.bg-line per background run,
    // right after the main line, with .bg-word children. Returned as siblings so
    // the caller appends them in order.
    (line.background || []).forEach((bg) => {
      if (!bg.words || !bg.words.length) return;
      const bgEl = makeEl(pipDoc, "div", "line bg-line");
      if (line.opposite) bgEl.classList.add("OppositeAligned");
      if (bg.lineTimed) bgEl.classList.add("line-timed");
      if (staticLyrics) bgEl.classList.add("static");
      buildWordsInto(bgEl, bg.words, records, true, !!bg.lineTimed);
      if (romanizationEnabled && bg.romaji) {
        bgEl.appendChild(makeEl(pipDoc, "div", "romaji", bg.romaji));
      }
      // Background vocals use their own time window, just like the main panel.
      bgEl.addEventListener("click", () => seekToLyricTime(bg.startMs));
      elements.push(bgEl);
      bgIntervals.push({ el: bgEl, startMs: bg.startMs, endMs: bg.endMs });
    });

    lineSets[index] = {
      records: records,
      elements: elements,
      intervals: [
        { el: div, startMs: line.startMs, endMs: line.endMs },
        ...bgIntervals,
      ],
    };
    return elements;
  }

  // Mirrors appendWords(): an IsPartOfWord run is wrapped in a span.word-group,
  // and the space BETWEEN syllables is generated by the panel's CSS ::after rule
  // — so no text nodes here, and the last word must be marked or it would get a
  // trailing space.
  function buildWordsInto(parent, words, records, background, lineTimed) {
    let group = null;
    words.forEach((word, i) => {
      const rec = buildWordElement(word, lineTimed);
      const el = rec.el;
      if (background) el.classList.add("bg-word");
      if (word.isPartOfWord) el.classList.add("PartOfWord");
      if (word.isLast) el.classList.add("LastWordInLine");
      const previous = words[i - 1];
      const belongsToGroupedWord =
        word.isPartOfWord || (previous && previous.isPartOfWord && group);
      if (belongsToGroupedWord) {
        if (!group) {
          group = makeEl(pipDoc, "span", "word-group");
          parent.appendChild(group);
        }
        group.appendChild(el);
        if (!word.isPartOfWord && previous && previous.isPartOfWord) group = null;
      } else {
        group = null;
        parent.appendChild(el);
      }
      // Tag the record (and its letters) with the LINE element it belongs to, so
      // animateLine can promote the right line. Bg-vocal words live in a SEPARATE
      // .line.bg-line sibling, so promoting only the lead line left every bg line
      // unpromoted — which is why bg vocals stayed visibly steppy after the lead
      // fix (AJ, 2026-10-07).
      rec.lineEl = parent;
      if (rec.letters) rec.letters.forEach((letter) => { letter.lineEl = parent; });
      records.push(rec);
    });
  }

  function buildWordElement(word, lineTimed) {
    const text = word.text || "";
    const startMs = Number.isFinite(word.startMs) ? word.startMs : 0;
    const endMs = Number.isFinite(word.endMs) ? word.endMs : startMs + 1;
    if (!word.letterCapable) {
      const span = makeEl(pipDoc, "span", "word");
      span.textContent = text;
      span.style.setProperty("--gradient-position", staticLyrics ? "100%" : "-20%");
      span.style.setProperty("--text-shadow-opacity", "0%");
      span.style.setProperty("--text-shadow-blur-radius", "4px");
      span.style.setProperty("--ym-sl-base-scale", staticLyrics || lineTimed ? "1" : "0.95");
      span.style.transform = staticLyrics || lineTimed
        ? "translateY(0)"
        : "translateY(calc(var(--DefaultLyricsSize) * 0.01))";
      return makeAnimRecord(span, startMs, endMs, "word", lineTimed);
    }
    const group = makeEl(pipDoc, "div", "letterGroup");
    const chars = Array.from(text);
    const letterEnd = Math.max(startMs + 1, endMs - 250);
    const per = Math.max(1, letterEnd - startMs) / Math.max(chars.length, 1);
    const letters = [];
    chars.forEach((char, i) => {
      const letter = makeEl(pipDoc, "span", "letter Emphasis", char);
      if (char.trim().length === 0) letter.classList.add("SpaceLetter");
      if (i === chars.length - 1) letter.classList.add("LastLetterInWord");
      letter.style.setProperty("--gradient-position", staticLyrics ? "100%" : "-20%");
      letter.style.setProperty("--text-shadow-opacity", "0%");
      letter.style.setProperty("--text-shadow-blur-radius", "4px");
      letter.style.setProperty("--ym-sl-base-scale", staticLyrics || lineTimed ? "1" : "0.95");
      letter.style.transform = staticLyrics || lineTimed
        ? "translateY(0)"
        : "translateY(calc(var(--DefaultLyricsSize) * 0.01))";
      group.appendChild(letter);
      // Letters inherit their word's lineTimed (the panel applies the same gate
      // to letters via word.LineTimed at the word level).
      letters.push(makeAnimRecord(letter, startMs + i * per, startMs + (i + 1) * per, "letter", lineTimed));
    });
    // The panel treats a .letterGroup as a word for the word-level animation too.
    const rec = makeAnimRecord(group, startMs, endMs, "word", lineTimed);
    rec.letters = letters;
    return rec;
  }

  function buildProviderRow(provider) {
    const row = makeEl(pipDoc, "div", "ym-sl-provider");
    row.appendChild(makeEl(pipDoc, "span", "ym-sl-provider-label", "Lyrics provided by"));
    row.appendChild(makeEl(pipDoc, "span", "ym-sl-provider-name", provider));
    return row;
  }

  function buildPersonRow(label, person) {
    const row = makeEl(pipDoc, "div", "ym-sl-uploader");
    row.appendChild(makeEl(pipDoc, "span", "ym-sl-uploader-label", label));
    const link = makeEl(pipDoc, "a", "ym-sl-uploader-link");
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (person && person.url) link.href = person.url;
    if (person && person.avatar) {
      const img = makeEl(pipDoc, "img", "ym-sl-uploader-avatar");
      img.alt = "";
      img.src = person.avatar;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => { try { img.remove(); } catch (e) {} });
      link.appendChild(img);
    }
    link.appendChild(makeEl(pipDoc, "span", "ym-sl-uploader-name", person && person.username));
    if (!person || !person.url) link.classList.add("no-link");
    row.appendChild(link);
    return row;
  }

  function buildCreditsFooter() {
    if (!songwriters.length && !(attribution && (attribution.provider || attribution.uploader || attribution.maker))) return null;
    const footer = makeEl(pipDoc, "div", "ym-sl-credits");
    if (songwriters.length) {
      footer.appendChild(makeEl(pipDoc, "div", "ym-sl-credits-label", "Written By"));
      const names = makeEl(pipDoc, "div", "ym-sl-credits-names");
      songwriters.forEach((name, index) => {
        if (index) names.appendChild(pipDoc.createTextNode(", "));
        names.appendChild(makeEl(pipDoc, "span", "ym-sl-credits-name", name));
      });
      footer.appendChild(names);
    }
    if (attribution && attribution.provider) footer.appendChild(buildProviderRow(attribution.provider));
    if (attribution && attribution.uploader) footer.appendChild(buildPersonRow("Uploaded by", attribution.uploader));
    if (attribution && attribution.maker) footer.appendChild(buildPersonRow("Made by", attribution.maker));
    return footer;
  }

  function buildLinesBox() {
    const content = pipEl("ym-pip-content");
    if (!content) return;
    // Pull the user's live lyric settings across before rendering.
    copyPanelVars(pipEl("ym-sl-panel"));
    while (content.firstChild) content.removeChild(content.firstChild);
    lineEls = [];
    lineSets = [];
    if (!lines.length) {
      content.appendChild(makeEl(pipDoc, "div", "ym-pip-hint", "No lyrics for this track."));
      return;
    }
    const track = makeEl(pipDoc, "div", "ym-pip-track");
    // Render the whole song once; the active line is brought into view with a
    // transform on the track, so nodes are never rebuilt mid-playback.
    lines.forEach((line, i) => {
      const els = buildLineElement(line, i);
      els.forEach((el) => track.appendChild(el));
      lineEls.push(els[0]);
    });
    content.appendChild(track);
    const footer = buildCreditsFooter();
    if (footer) {
      content.appendChild(footer);
      // Stamp the live glide angle on the fresh pills so they do not flicker at
      // 0deg for one frame before syncLoop's next tick.
      stampPipPills(pipSpinDeg());
    }
    // The lines have no measurable height until the browser has laid them out,
    // so a centering pass right now clamps to 0 and then SPRINGS to the real
    // position - which reads as the lyrics "bouncing" when the window opens.
    // Re-centre on the next frame, and once more after the window has settled
    // its size (the OS often restores the previous PiP size just after open).
    recenterAfterLayout();
  }

  // Snap (never spring) the camera to the current line once layout is ready.
  function recenterAfterLayout() {
    if (!pipWin || pipWin.closed) return;
    const settle = () => {
      if (!pipWin || pipWin.closed) return;
      centerInitialized = false;
      centerTargetY = null;
      resetCameraGlide();
      const p = player();
      const pos = p && typeof p.getPositionMs === "function" ? p.getPositionMs() : null;
      centerOn(activeIndexAt(lyricPositionMs(pos)));
    };
    pipWin.requestAnimationFrame(() => {
      settle();
      pipWin.requestAnimationFrame(settle);
    });
  }

  function activeIndexAt(posMs) {
    if (!lines.length || posMs === null || posMs === undefined) return -1;
    // The main panel uses an overlap-safe, last-match-wins lookup because a
    // widened lead line can overlap the next lead during a late bg vocal. The
    // old PiP binary search assumed disjoint windows and could highlight the
    // wrong line or return no line during that overlap.
    let found = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (posMs >= line.startMs && posMs < line.endMs) found = i;
    }
    return found;
  }

  function updateLineStates(posMs) {
    lineSets.forEach((set) => {
      (set.intervals || []).forEach((interval) => {
        const state = staticLyrics
          ? "Static"
          : getState(posMs, interval.startMs, interval.endMs);
        interval.el.classList.toggle("static", state === "Static");
        interval.el.classList.toggle("Active", state === "Active");
        interval.el.classList.toggle("NotSung", state === "NotSung");
        interval.el.classList.toggle("Sung", state === "Sung");
      });
    });
  }

  /* The panel's own animation, running on the panel's own springs and splines
     (published over the bus as "lyrics:renderer"). This mirrors its two passes:
     a word-level store per syllable, then a letter-level store per character
     inside a letterGroup, with the same falloff constants and the same style
     writes. Nothing here re-derives the feel — it calls the same functions. */
  function animateLine(activeIdx, posMs, dt) {
    const set = lineSets[activeIdx];
    const records = set && set.records;
    if (!records || !kit) {
      // Nothing to animate: make sure no stale hint is left on this line's
      // elements — the lead AND its bg-vocal siblings.
      const els = (set && set.elements) || [];
      for (let i = 0; i < els.length; i++) {
        if (els[i] && els[i].classList) els[i].classList.remove("ym-sl-animating");
      }
      return false;
    }
    const splines = kit.splines;
    let anyAwake = false;
    // Every LINE that owns at least one awake word this frame. Bg vocals are
    // separate .line.bg-line siblings, so the promotion below is per-owning-line.
    const awakeLines = new Set();
    for (let w = 0; w < records.length; w++) {
      const rec = records[w];
      const state = getState(posMs, rec.startMs, rec.endMs);
      const stateChanged = rec.lastState !== state;
      rec.lastState = state;
      rec.el.classList.toggle("WordNotSung", state === "NotSung");
      rec.el.classList.toggle("WordSung", state === "Sung");
      if (!rec.springs) continue;

      const progress = Math.max(0, Math.min(1,
        (posMs - rec.startMs) / Math.max(1, rec.endMs - rec.startMs)));
      const target = state === "Active" ? progress : state === "Sung" ? 1 : 0;
      // The word gradient is the panel's own: -20 -> 100 across the word while it
      // is being sung. Without this plain (non-letter) words never fill.
      const wordGradient = state === "Sung" ? 100 : state === "Active" ? -20 + 120 * progress : -20;
      // Honor lineTimed for Scale/YOffset exactly as the panel does (aurora-lyrics.js
      // 6938-6945): line-timed words stay at scale 1 / yOffset 0 (no bounce), and
      // only Glow is animated. This is the bounce fix — the unconditional blends
      // were feeding a non-rest moving goal to every word's spring.
      rec.springs.Scale.SetGoal(rec.lineTimed
        ? 1
        : kit.blendSyllableAnimation(splines.ScaleSpline.at(0), splines.ScaleSpline.at(target)));
      rec.springs.YOffset.SetGoal(rec.lineTimed
        ? 0
        : kit.blendVerticalAnimation(splines.YOffsetSpline.at(0), splines.YOffsetSpline.at(target)));
      rec.springs.Glow.SetGoal(
        kit.blendSyllableAnimation(splines.GlowSpline.at(0), splines.GlowSpline.at(target)));

      // Mirror the panel's simple-lyrics clause EXACTLY (19-animation-modes):
      // Simple lyrics stubs the Scale/Glow springs, so storeNeedsAnimation reports
      // false the moment they "settle" — but the gradient sweep still needs a
      // per-frame write while the word is being sung. Without this the fill freezes
      // at its state-flip value (the panel's "flash of fill, then dim" bug), which
      // is why the PiP's simple mode animated differently from the panel's.
      const selfAwake =
        stateChanged ||
        kit.storeNeedsAnimation(rec.springs) ||
        (simpleLyrics && state === "Active");
      let lettersAwake = false;
      if (rec.letters && (state === "Active" || selfAwake)) {
        lettersAwake = animateLetters(rec, posMs, dt);
      }
      if (!selfAwake && !lettersAwake) {
        // This word (and any letters it owns) have fully settled, so drop the
        // compositor hint. Without this the hint set while awake stays on
        // forever and every sung line stays promoted — the same layer-growth
        // bug the panel fixed, and the reason PiP reads as low frame rate.
        releaseLineHints(rec);
        continue;
      }
      anyAwake = true;
      // Track the LINE this word belongs to, not just "the active line" — a
      // background vocal lives in its own sibling line element.
      if (rec.lineEl) awakeLines.add(rec.lineEl);
      // Same compositor hint the panel applies per element while its springs are
      // awake — without it this animates unpromoted and reads as low frame rate.
      kit.setAnimatingHint(rec.el, true);

      const scale = rec.springs.Scale.Step(dt);
      const yOffset = rec.springs.YOffset.Step(dt);
      const glow = rec.springs.Glow.Step(dt);
      // NOTE the word constants are NOT the letter constants: no *2 on the
      // offset, and a much gentler glow (2/35 vs 12/185). Using the letter
      // values here is what made plain words bloom.
      kit.setStyleIfChanged(rec.el, "transform",
        "translate3d(0, calc(var(--DefaultLyricsSize) * " + yOffset + "), 0)", 0.001);
      kit.setStyleIfChanged(rec.el, "--ym-sl-base-scale", String(scale), 0.001);
      if (rec.letters) {
        // The letterGroup wrapper must stay inert: a gradient of its own
        // double/ghosts the active letters, and clearing its inherited
        // text-shadow would stop the glow reaching the letters (the panel's
        // "long words render dimmer" bug).
        kit.setStyleIfChanged(rec.el, "background-image", "none");
        kit.setStyleIfChanged(rec.el, "-webkit-text-fill-color", "inherit");
        kit.setStyleIfChanged(rec.el, "color", "inherit");
      } else {
        kit.setStyleIfChanged(rec.el, "--gradient-position", wordGradient + "%", 0.1);
        kit.setStyleIfChanged(rec.el, "--text-shadow-blur-radius", (4 + 2 * glow) + "px", 0.5);
        kit.setStyleIfChanged(rec.el, "--text-shadow-opacity",
          Math.min(glow * 35, 100) + "%", 1);
      }
    }
    // Mirror the panel's LINE-level compositor hint. The panel promotes via the
    // .ym-sl-animating CLASS — its per-element setAnimatingHint is deliberately a
    // no-op, because toggling will-change per word churns the background-clip:text
    // layer — and that class is added by the PANEL's rAF, which cannot see this
    // document. The PiP therefore called a no-op and its word transforms animated
    // UNPROMOTED, which is the pixel-stepping AJ reports (AJ, 2026-10-07). The
    // panel's stylesheet (copied in wholesale) already carries the
    // .line.ym-sl-animating .word/.letter rules, so toggling the class is all it
    // takes — and it comes off the moment every spring on the line has slept.
    // Promote EVERY line that owns an awake word this frame. It cannot be a single
    // "active line" toggle: background vocals render as their own .line.bg-line
    // siblings, so they need their own promotion or they animate unpromoted and
    // stay steppy while the lead line is smooth (AJ, 2026-10-07). Clearing is
    // driven by the same set, so a line drops its hint the moment its springs sleep.
    const setLineEls = (set && set.elements) || [];
    for (let i = 0; i < setLineEls.length; i++) {
      const el = setLineEls[i];
      if (el && el.classList && el.classList.contains("line")) {
        el.classList.toggle("ym-sl-animating", awakeLines.has(el));
      }
    }
    return anyAwake;
  }

  // The per-letter pass. activeIndex is the index of the letter being sung WITHIN
  // its own group, which is what the panel's proximity falloff is keyed on.
  function animateLetters(rec, posMs, dt) {
    const letters = rec.letters;
    if (!letters || !letters.length) return false;
    const splines = kit.splines;
    let activeIndex = -1;
    for (let i = 0; i < letters.length; i++) {
      if (posMs >= letters[i].startMs && posMs < letters[i].endMs) { activeIndex = i; break; }
    }
    let activeProgress = 0;
    if (activeIndex >= 0) {
      const a = letters[activeIndex];
      activeProgress = Math.max(0, Math.min(1,
        (posMs - a.startMs) / Math.max(1, a.endMs - a.startMs)));
    }
    const restingScale = splines.LetterScaleSpline.at(0);
    const restingYOffset = splines.LetterYOffsetSpline.at(0);
    const restingGlow = splines.GlowSpline.at(0);
    let anyAwake = false;
    for (let i = 0; i < letters.length; i++) {
      const L = letters[i];
      if (!L.springs) continue;
      const state = getState(posMs, L.startMs, L.endMs);
      let targetScale = restingScale;
      let targetYOffset = restingYOffset;
      let targetGlow = restingGlow;
      let targetGradient = state === "Sung" ? 100 : -20;
      if (activeIndex >= 0) {
        const baseScale = splines.LetterScaleSpline.at(activeProgress);
        const baseYOffset = splines.LetterYOffsetSpline.at(activeProgress);
        const baseGlow = splines.GlowSpline.at(activeProgress);
        const distance = Math.abs(i - activeIndex);
        const scaleFalloff = 1 / (1 + Math.pow(distance, 2.8));
        const glowFalloff = 1 / (1 + distance * 0.9);
        targetScale = restingScale + (baseScale - restingScale) * scaleFalloff;
        targetYOffset = restingYOffset + (baseYOffset - restingYOffset) * scaleFalloff;
        targetGlow = restingGlow + (baseGlow - restingGlow) * glowFalloff;
        if (state === "Active" && i === activeIndex) {
          targetGradient = -20 + 120 * kit.easeSinOut(activeProgress);
        }
      } else if (state === "Sung") {
        targetScale = splines.LetterScaleSpline.at(1);
        targetYOffset = splines.LetterYOffsetSpline.at(1);
        targetGlow = splines.GlowSpline.at(1);
      }
      L.springs.Scale.SetGoal(kit.blendSyllableAnimation(restingScale, targetScale));
      L.springs.YOffset.SetGoal(kit.blendVerticalAnimation(restingYOffset, targetYOffset));
      L.springs.Glow.SetGoal(kit.blendSyllableAnimation(restingGlow, targetGlow));
      const changed = L.lastState !== state;
      L.lastState = state;
      if (!changed && !kit.storeNeedsAnimation(L.springs)) {
        kit.setAnimatingHint(L.el, false);
        continue;
      }
      anyAwake = true;
      kit.setAnimatingHint(L.el, true);
      const scale = L.springs.Scale.Step(dt);
      const yOffset = L.springs.YOffset.Step(dt);
      const glow = L.springs.Glow.Step(dt);
      kit.setStyleIfChanged(L.el, "transform",
        "translate3d(0, calc(var(--DefaultLyricsSize) * " + (yOffset * 2) + "), 0)", 0.001);
      kit.setStyleIfChanged(L.el, "--ym-sl-base-scale", String(scale), 0.001);
      kit.setStyleIfChanged(L.el, "--gradient-position", targetGradient + "%", 0.1);
      kit.setStyleIfChanged(L.el, "--text-shadow-blur-radius", (4 + 12 * glow) + "px", 0.5);
      kit.setStyleIfChanged(L.el, "--text-shadow-opacity", (glow * 185) + "%", 1);
    }
    return anyAwake;
  }

  // Degraded path used only until the renderer kit arrives: set the gradient
  // straight from each element's own progress, with no springs.
  function fillWithoutKit(activeIdx, posMs) {
    const set = lineSets[activeIdx];
    const records = set && set.records;
    if (!records) return;
    records.forEach((rec) => {
      const walk = (items) => {
        items.forEach((item) => {
          const state = getState(posMs, item.startMs, item.endMs);
          let pos = state === "Sung" ? 100 : -20;
          if (state === "Active") {
            const p = (posMs - item.startMs) / Math.max(1, item.endMs - item.startMs);
            pos = -20 + 120 * easeSinOut(p);
          }
          item.el.style.setProperty("--gradient-position", pos + "%");
        });
      };
      if (rec.letters) walk(rec.letters);
      else walk([rec]);
      rec.el.classList.toggle("WordNotSung", getState(posMs, rec.startMs, rec.endMs) === "NotSung");
      rec.el.classList.toggle("WordSung", getState(posMs, rec.startMs, rec.endMs) === "Sung");
    });
  }

  /* ---- credit-pill glow ----------------------------------------------------
     The panel animates `--ym-sl-pfp-spin` on ITS .ym-sl-uploader-link pills from
     its own rAF, which only ever queries the MAIN document - so the PiP's copy of
     the credits pill sat frozen at 0deg. Run the same glide here, on THIS
     document's pills. Same 4.2s period and ~40fps throttle as aurora-lyrics.js. */
  const PIP_GLOW_PERIOD_MS = 4200;
  const PIP_GLOW_MIN_MS = 1000 / 40;
  let pipGlowClock = 0;
  let pipGlowLastPaint = -1e9;
  let pipGlowReduce = false;
  try {
    pipGlowReduce = !!(window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) {}

  function pipSpinDeg() {
    return (pipGlowClock / PIP_GLOW_PERIOD_MS * 360) % 360;
  }

  function stampPipPills(deg) {
    if (!pipDoc) return;
    const v = (+deg).toFixed(2) + "deg";
    const pills = pipDoc.querySelectorAll(".ym-sl-uploader-link");
    for (let i = 0; i < pills.length; i++) {
      pills[i].style.setProperty("--ym-sl-pfp-spin", v);
    }
  }

  function stepPipGlow(dtMs) {
    if (!pipDoc) return;
    if (pipGlowReduce) { stampPipPills(0); return; }
    pipGlowClock += dtMs;
    if (pipGlowClock - pipGlowLastPaint < PIP_GLOW_MIN_MS) return;
    pipGlowLastPaint = pipGlowClock;
    stampPipPills(pipSpinDeg());
  }

  function syncLoop() {
    if (!pipWin || pipWin.closed) { stopSync(); return; }
    rafId = pipWin.requestAnimationFrame(syncLoop);
    const p = player();
    if (!p) return;
    const now = performance.now();
    // Real elapsed time, clamped: a backgrounded or long-stalled frame must not
    // hand the springs a huge dt, which would overshoot.
    const dt = lastFrameAt ? Math.min(0.05, (now - lastFrameAt) / 1000) : 0.016;
    lastFrameAt = now;
    const pos = p.getPositionMs ? p.getPositionMs() : null;
    // Track changed under us: NEVER keep showing the PREVIOUS song's lyrics.
    // The panel republishes lyrics:lines when the new lyrics land, but until
    // then the PiP happily displays the old ones ("it just plays what it was
    // on"). Re-pull the latest published payload; if that is still the old
    // track, clear to the loading hint rather than lie about the song.
    if (now - lastTrackCheckAt > 500) {
      lastTrackCheckAt = now;
      const t = p.getTrack ? p.getTrack() : null;
      const vid = t && t.videoId ? String(t.videoId) : null;
      if (vid && linesVideoId && vid !== linesVideoId) {
        const cached = (window.YTMod && window.YTMod.bus) ? window.YTMod.bus.last("lyrics:lines") : null;
        if (cached && cached.videoId && String(cached.videoId) === vid) {
          onLines(cached);
        } else {
          lines = [];
          linesVideoId = vid;
          buildLinesBox();
        }
      }
    }
    // The synced tab shifts the lyric clock by the sync offset; the PiP must do
    // the same or every line/word lands that offset early. Mirror the panel's
    // animate(): lyricPositionMs = positionMs - getOffsetForPosition(positionMs).
    const lyricPos = lyricPositionMs(pos);
    const idx = activeIndexAt(lyricPos);
    const targetPos = scrollLeadEnabled ? lyricPos + scrollLeadMs : lyricPos;
    const targetIdx = activeIndexAt(targetPos);
    updateLineStates(lyricPos);
    if (idx !== lastRenderedActive) {
      lastRenderedActive = idx;
    }
    if (targetIdx !== lastRenderedTarget) {
      lastRenderedTarget = targetIdx;
      renderActive(targetIdx);
    }
    updateManualScrollRecovery(idx);
    stepCenterSpring(dt);
    // Glide the credits pill's seam (the panel's own rAF cannot see this doc).
    stepPipGlow(dt * 1000);
    // The panel evaluates every model line from its own StartTime/EndTime each
    // frame. Do the same here: background-vocal intervals are independent of
    // their lead line, and a late bg must keep filling while the next lead is
    // already active. This replaces the old "only active primary line" shortcut.
    for (let s = 0; s < lineSets.length; s++) {
      if (staticLyrics) continue;
      if (kit) animateLine(s, lyricPos, dt);
      else if (s === idx) fillWithoutKit(s, lyricPos);
    }
    const toggle = pipEl("ym-pip-toggle");
    if (toggle) {
      const paused = p.isPaused ? p.isPaused() : false;
      const want = paused ? ICON_PLAY : ICON_PAUSE;
      if (toggle.dataset.icon !== want) {
        toggle.dataset.icon = want;
        while (toggle.firstChild) toggle.removeChild(toggle.firstChild);
        toggle.appendChild(svgIcon(pipDoc, want));
      }
    }
    syncPipControls(p, pos);
  }

  function pipFormatClock(ms) {
    const total = Math.max(0, Math.floor(Number(ms) / 1000));
    return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
  }

  // Seek / volume / shuffle / repeat, refreshed each frame (AJ, 2026-10-07).
  // Everything is read from the LIVE player, never from local toggle state, so
  // the controls can never disagree with what YTM is actually doing.
  function syncPipControls(p, pos) {
    if (pipSeekEl) {
      const dur = p && p.getDurationMs ? Number(p.getDurationMs()) : 0;
      const at = Number(pos);
      if (Number.isFinite(dur) && dur > 0 && Number.isFinite(at)) {
        // Never fight a drag: skip the position write while the user has the thumb.
        if (performance.now() - pipSeekUserAt > 1200) {
          pipSeekEl.value = String(Math.round((Math.max(0, Math.min(dur, at)) / dur) * 1000));
        }
        const curEl = pipEl("ym-pip-time-cur");
        const totEl = pipEl("ym-pip-time-total");
        if (curEl) curEl.textContent = pipFormatClock(at);
        if (totEl) totEl.textContent = pipFormatClock(dur);
      }
    }
    if (pipVolumeEl && p && typeof p.getVolume === "function" && pipDoc.activeElement !== pipVolumeEl) {
      // getVolume() returns an OBJECT ({ media, slider, muted }), not a number.
      // media.volume is 0..1 — the range is 0..100. Reading it as a number gave
      // "[object Object]", which the range coerced to 0 (AJ, 2026-10-07).
      const info = p.getVolume();
      const vol01 = info && typeof info.media === "number"
        ? info.media
        : (info && typeof info.slider === "number" ? info.slider / 100 : null);
      if (vol01 !== null && Number.isFinite(vol01)) {
        pipVolumeEl.value = String(Math.round(vol01 * 100));
      }
    }
    if (!kit || !kit.readPlayerToggle) return;
    const shuffleEl = pipEl("ym-pip-shuffle");
    if (shuffleEl) shuffleEl.classList.toggle("active", kit.readPlayerToggle("shuffle") === "on");
    const repeatEl = pipEl("ym-pip-repeat");
    if (repeatEl) {
      const rep = kit.readPlayerToggle("repeat");
      repeatEl.classList.toggle("active", rep !== "off");
      // Repeat-one carries its state in the GLYPH, exactly like the panel's chip.
      const wantOne = rep === "one";
      if (repeatEl.dataset.one !== String(wantOne)) {
        repeatEl.dataset.one = String(wantOne);
        while (repeatEl.firstChild) repeatEl.removeChild(repeatEl.firstChild);
        repeatEl.appendChild(svgIcon(pipDoc, wantOne ? ICON_REPEAT_ONE : ICON_REPEAT));
      }
    }
  }

  function renderActive(activeIdx) {
    if (!lineEls.length) return;
    lineSets.forEach((set, i) => {
      // Far-line is PiP-only presentation chrome; the actual Active/Sung/
      // NotSung state is assigned from each interval in updateLineStates().
      lineEls[i].classList.toggle("ym-pip-far", activeIdx >= 0 && Math.abs(i - activeIdx) > 4);
    });
    centerOn(activeIdx);
  }

  // Mirror the panel's releaseLineAnimationHints: clear the per-element
  // compositor hint on a word and every letter it owns, so a line that stops
  // being active does not stay permanently promoted.
  function releaseLineHints(rec) {
    if (!rec || !rec.el || !kit) return;
    kit.setAnimatingHint(rec.el, false);
    if (rec.letters) rec.letters.forEach((L) => {
      if (L.el) kit.setAnimatingHint(L.el, false);
    });
  }

  function restRecords(records) {
    if (!records) return;
    records.forEach((rec) => {
      releaseLineHints(rec);
      // Set the resting GOAL but do NOT snap and do NOT strip the spring's
      // current transform. The panel lets its springs ease into rest; the old
      // SetGoal(..., true) + removeProperty("transform") here was yanking the
      // animation mid-motion, which read as "the animation just stops on the
      // line that was just playing". The settle pass in syncLoop now Steps the
      // springs until storeNeedsAnimation goes false, at which point the hints
      // are released and the line sits at rest with the panel's CSS defaults.
      rec.el.style.setProperty("--text-shadow-opacity", "0%");
      rec.el.style.setProperty("--text-shadow-blur-radius", "4px");
      if (rec.springs && kit) {
        rec.springs.Scale.SetGoal(1);
        rec.springs.YOffset.SetGoal(0);
        rec.springs.Glow.SetGoal(0);
      }
      if (rec.letters) restRecords(rec.letters);
    });
  }

  // Per-frame settle pass for non-active lines. restRecords only SETS the resting
  // goal; the springs still need to Step toward 1/0/0 or the line freezes at its
  // sung-end scale. The panel achieves the same effect because animateWord keeps
  // updating goals based on the word's state. The PiP only animates the active
  // line, so settleLineSet fills the gap: Step each record once with dt, write
  // the transform, and stop (release hints) when storeNeedsAnimation goes false.
  function settleLineSet(set, dt) {
    if (!set || !kit || !set.records) return;
    for (let w = 0; w < set.records.length; w++) {
      const rec = set.records[w];
      if (!rec.springs) continue;
      if (!kit.storeNeedsAnimation(rec.springs)) {
        releaseLineHints(rec);
        continue;
      }
      const scale = rec.springs.Scale.Step(dt);
      const yOffset = rec.springs.YOffset.Step(dt);
      const glow = rec.springs.Glow.Step(dt);
      kit.setStyleIfChanged(rec.el, "transform",
        "translate3d(0, calc(var(--DefaultLyricsSize) * " + yOffset + "), 0)", 0.001);
      kit.setStyleIfChanged(rec.el, "--ym-sl-base-scale", String(scale), 0.001);
      if (!rec.letters) {
        kit.setStyleIfChanged(rec.el, "--text-shadow-blur-radius", (4 + 2 * glow) + "px", 0.5);
        kit.setStyleIfChanged(rec.el, "--text-shadow-opacity",
          Math.min(glow * 35, 100) + "%", 1);
      }
    }
  }

  // Bring the active line to the vertical middle of the actual scroll box. The
  // main panel writes scrollTop; the PiP does the same, so its credits remain in
  // normal flow at the bottom and the user can scroll past the last lyric.
  //
  // The camera glide is the PANEL'S OWN spring — kit.Spring, the analytic spr port
  // — with the panel's constants, replacing the hand-integrated Euler spring this
  // used to run ("pip has the old one", AJ, 2026-10-07). Same model as the panel:
  // critically damped, ~0.8s settle, and a retarget KEEPS the velocity so
  // back-to-back line changes read as one continuous glide.
  const CAMERA_GLIDE_FREQ = 1;
  const CAMERA_GLIDE_DAMPING = 1;
  const CAMERA_GLIDE_SETTLE_PX = 0.25;
  const CAMERA_GLIDE_SETTLE_SPEED = 0.05;
  // How long after the user's last manual scroll gesture the camera may resume
  // following on its own. Upstream's model (their USER_SCROLL_COOLDOWN); the old
  // rule demanded they scroll the active line fully out of view AND back, so a
  // small nudge paused the camera for the rest of the song and only the Jump
  // button could restore it (AJ, 2026-10-07).
  const PIP_MANUAL_RESUME_MS = 1200;
  let centerTargetY = null;
  let pipManualScrollPaused = false;
  let pipManualScrollWasAway = false;
  let pipManualScrollAt = 0; // performance.now() of the last manual gesture
  let centerY = 0;
  // The camera's spring. Null means "at rest / not gliding" — dropping it is how
  // every reset point stops the motion (the spring owns the velocity now).
  let cameraSpring = null;
  let cameraLastPos = null;
  let centerInitialized = false;
  // Last whole-pixel value written to scrollTop. scrollTop is integer-only, so
  // the camera writes the whole part there and carries the remainder as a
  // translate (see setCameraFraction) — otherwise the whole text block ticks one
  // pixel at a time and the motion reads as pixels stepping (AJ, 2026-10-07).
  let cameraLastWhole = null;
  let cameraFraction = 0;
  // Seek / volume controls (built in buildChrome, synced in syncLoop).
  let pipSeekEl = null;
  let pipSeekUserAt = 0;   // performance.now() of the last seek drag
  let pipVolumeEl = null;

  // Stop the camera glide and clear the sub-pixel carry. Used by every point that
  // must halt the motion: a manual gesture, a jump, a snap, a resume.
  function resetCameraGlide() {
    cameraSpring = null;
    cameraLastPos = null;
    cameraLastWhole = null;
    setCameraFraction(0);
  }

  function setJumpVisible(visible) {
    const button = pipEl("ym-pip-jump");
    if (button) button.classList.toggle("visible", !!visible);
  }

  function activeLineInView(activeIdx) {
    const box = pipEl("ym-pip-lines");
    const target = lineEls[activeIdx];
    if (!box || !target) return false;
    const boxRect = box.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const visibleTop = boxRect.top + Math.min(32, box.clientHeight * 0.12);
    const visibleBottom = boxRect.bottom - Math.min(32, box.clientHeight * 0.12);
    return targetRect.bottom > visibleTop && targetRect.top < visibleBottom;
  }

  function jumpToCurrentLyric() {
    // Target the line the camera is GLIDING toward (the scroll-lead line), which
    // is what the main panel targets too. Centring the line being SUNG instead
    // fights the very next frame's retarget back to the lead line, so the jump
    // lands short and then drifts - the "jump to current doesn't work" bug.
    const idx = lastRenderedTarget >= 0 ? lastRenderedTarget : lastRenderedActive;
    if (idx < 0) return;
    pipManualScrollPaused = false;
    pipManualScrollWasAway = false;
    centerTargetY = null;
    resetCameraGlide();
    centerInitialized = false; // snap, do not glide
    centerOn(idx);
    setJumpVisible(false);
  }

  function writeCameraScroll(box, top, instant) {
    if (!box) return;
    // `instant` (the default) is the PER-FRAME spring writer: it must not kick
    // off a browser-native eased scroll that would fight the spring. Passing
    // instant === false is the ONE-SHOT path, handed to the element's own CSS
    // scroll-behavior (smooth) - used when smoothScrolling is OFF, mirroring the
    // main panel's writeScrollTop(top, false).
    const behavior = instant === false ? "auto" : "instant";
    try { box.scrollTo({ top, left: 0, behavior }); }
    catch (e) { box.scrollTop = top; }
  }

  // Sub-pixel carry for the camera. The PiP reuses the panel's stylesheet, so its
  // .LyricsContent already carries the panel's transform rule
  // (translateY(offset + --ym-sl-scroll-frac)) — writing the remainder here moves
  // the text by the fraction the integer scrollTop cannot express, which is what
  // removes the one-pixel ticking. The property is registered @property
  // inherits:false in the copied stylesheet, so this write does not invalidate the
  // whole subtree.
  function setCameraFraction(fraction) {
    const content = pipEl("ym-pip-content");
    if (!content) return;
    // Skip a write that would not visibly change anything (same guard the panel's
    // setScrollFraction uses).
    if (Math.abs(fraction - cameraFraction) < 0.01 && fraction !== 0) return;
    cameraFraction = fraction;
    content.style.setProperty("--ym-sl-scroll-frac", fraction === 0 ? "0px" : (-fraction) + "px");
  }

  function centerOn(activeIdx) {
    const box = pipEl("ym-pip-lines");
    const target = lineEls[activeIdx];
    if (!box || !target || pipManualScrollPaused) return;
    const targetScroll = target.offsetTop - (box.clientHeight - target.offsetHeight) / 2;
    const maxScroll = Math.max(0, box.scrollHeight - box.clientHeight);
    const clamped = Math.max(0, Math.min(maxScroll, targetScroll));
    if (!centerInitialized) {
      // First placement: SNAP, never glide. The lines have no measurable height
      // until layout, so a glide from 0 reads as the lyrics bouncing on open.
      centerY = clamped;
      centerTargetY = clamped;
      cameraSpring = null;
      cameraLastPos = null;
      centerInitialized = true;
      cameraLastWhole = clamped;
      writeCameraScroll(box, clamped);
      setCameraFraction(0);
      return;
    }
    centerTargetY = clamped;
    // Smooth Scrolling OFF (and not Simple Lyrics, which always glides — the
    // panel's setScrollTarget treats them the same way): hand the move to the
    // element's own CSS ease, ONCE per target change (stepCenterSpring then does
    // nothing). Without this the PiP wrote the new scrollTop instantly every frame
    // and had NO scroll animation.
    if (!smoothScrolling && !simpleLyrics) { writeCameraScroll(box, clamped, false); return; }
    // The glide: the spring is REUSED so its velocity carries into the new goal,
    // which is what makes rapid line changes read as one motion.
    if (!cameraSpring && kit && kit.Spring) {
      cameraSpring = new kit.Spring(centerY, CAMERA_GLIDE_FREQ, CAMERA_GLIDE_DAMPING);
    }
    if (cameraSpring) {
      cameraSpring.SetGoal(clamped);
      cameraLastPos = null;
    }
  }

  function updateManualScrollRecovery(activeIdx) {
    if (activeIdx < 0) {
      setJumpVisible(false);
      return;
    }
    const inView = activeLineInView(activeIdx);
    if (pipManualScrollPaused && !inView) {
      // Remember that the user really scrolled away, so a gesture that never left
      // the line cannot clear the pause before the browser applies it.
      pipManualScrollWasAway = true;
    }
    // Resume automatic following once the user has been IDLE for a moment and the
    // active line is in view. The old rule ALSO demanded they scroll the line
    // fully out of view and back, so a small nudge that kept it visible paused the
    // camera for the rest of the song and only "Jump to current" could restore it
    // (AJ, 2026-10-07). The cooldown is upstream's model; the wasAway path is kept
    // too, so a real scroll-away resumes the moment the line returns rather than
    // waiting out the timer.
    const idle = performance.now() - pipManualScrollAt;
    if (pipManualScrollPaused && inView && (pipManualScrollWasAway || idle > PIP_MANUAL_RESUME_MS)) {
      pipManualScrollPaused = false;
      pipManualScrollWasAway = false;
      centerTargetY = null;
      resetCameraGlide();
      centerInitialized = false;
      cameraLastWhole = null;
      centerOn(activeIdx);
      setJumpVisible(false);
      return;
    }
    setJumpVisible(pipManualScrollPaused && !inView);
  }

  function stepCenterSpring(dt) {
    const box = pipEl("ym-pip-lines");
    if (!box || centerTargetY == null || pipManualScrollPaused) return;
    const maxScroll = Math.max(0, box.scrollHeight - box.clientHeight);
    centerTargetY = Math.max(0, Math.min(maxScroll, centerTargetY));
    if ((!smoothScrolling && !simpleLyrics) || !cameraSpring) {
      // Either the one-shot CSS ease owns the move, or no glide is running.
      setCameraFraction(0);
      return;
    }
    // The analytic spr spring, stepped with the frame's dt (the caller already
    // clamps it to <=0.05). Velocity carries across retargets by design.
    const stepped = cameraSpring.Step(dt);
    centerY = Math.max(0, Math.min(maxScroll, stepped));
    const goal = centerTargetY;
    const moved = cameraLastPos === null ? Infinity : Math.abs(centerY - cameraLastPos);
    cameraLastPos = centerY;
    const settled =
      Math.abs(centerY - goal) < CAMERA_GLIDE_SETTLE_PX && moved < CAMERA_GLIDE_SETTLE_SPEED;
    // Whole pixel to scrollTop, remainder as the compositor translate. Writing
    // centerY straight into scrollTop quantized it, so the whole text block moved
    // in one-pixel steps — the "you can see where the pixels are moving" report.
    const whole = settled ? Math.round(goal) : Math.round(centerY);
    const fraction = settled ? 0 : centerY - whole;
    if (whole !== cameraLastWhole) {
      writeCameraScroll(box, whole);
      cameraLastWhole = whole;
    }
    setCameraFraction(fraction);
    if (settled) {
      centerY = goal;
      // Park the spring on the goal at rest so a later retarget starts clean.
      cameraSpring.SetGoal(goal, true);
      cameraLastPos = null;
    }
  }

  function stopSync() {
    if (rafId && pipWin && !pipWin.closed) {
      try { pipWin.cancelAnimationFrame(rafId); } catch (e) {}
    }
    rafId = 0;
  }

  // ---- lifecycle -----------------------------------------------------------
  // Scroll/motion settings, applied from EITHER the lines payload or the live
  // lyrics:settings event — so a toggle takes effect without waiting for a track
  // change (the payload only re-emits then).
  function applyScrollSettings(src) {
    if (!src) return;
    smoothScrolling = src.smoothScrolling !== false;
    scrollLeadEnabled = src.scrollLeadEnabled === true;
    scrollLeadMs = Number(src.scrollLeadMs) || 0;
    const simple = src.simpleLyrics === true;
    if (simple !== simpleLyrics) {
      simpleLyrics = simple;
      // Apple Music style lyrics is a RENDER MODE whose motion rules are scoped to
      // body.ym-sl-simple-lyrics in the panel's stylesheet. The springs already
      // switch (the kit's createWordSprings reads the panel's own setting), but
      // without this class on the PiP's BODY the CSS half never applies — which is
      // why the mode "kinda worked" here (AJ, 2026-10-07).
      if (pipDoc && pipDoc.body) pipDoc.body.classList.toggle("ym-sl-simple-lyrics", simple);
      // The word records capture their springs AT BUILD TIME, and createWordSprings
      // only returns the Scale/Glow STUBS while the panel's setting is on — so a
      // toggle has to REBUILD the lines, or the words keep the normal-mode zoom and
      // glow springs and the mode never truly applies (AJ, 2026-10-07). The panel
      // does the same thing (buildRendererLines on a simpleLyrics change).
      if (lines.length && pipWin && !pipWin.closed && pipDoc) {
        buildLinesBox();
        const p = player();
        const pos = lyricPositionMs(p ? p.getPositionMs() : null);
        updateLineStates(pos);
        lastRenderedActive = -2;
        lastRenderedTarget = -2;
        renderActive(activeIndexAt(pos));
      }
    }
    // Smooth Scrolling switched off: drop the glide NOW, not on the next track.
    if (!smoothScrolling) resetCameraGlide();
  }

  function onSettings(s) {
    applyScrollSettings(s);
  }

  function onLines(payload) {
    if (!payload) return;
    lines = Array.isArray(payload.lines) ? payload.lines : [];
    linesVideoId = payload.videoId || null;
    staticLyrics = !!payload.staticLyrics;
    romanizationEnabled = payload.romanizationEnabled !== false;
    songwriters = Array.isArray(payload.songwriters) ? payload.songwriters : [];
    attribution = payload.attribution || null;
    applyScrollSettings(payload);
    lastRenderedActive = -2;
    lastRenderedTarget = -2;
    centerTargetY = null;
    pipManualScrollPaused = false;
    pipManualScrollWasAway = false;
    centerY = 0;
    resetCameraGlide();
    centerInitialized = false;
    if (!pipWin || pipWin.closed || !pipDoc) return;
    setHeader();
    buildLinesBox();
    const pos = lyricPositionMs(player() ? player().getPositionMs() : null);
    updateLineStates(pos);
    renderActive(activeIndexAt(pos));
  }

  // While the PiP is open the synced-tab panel's lyrics are redundant (and waste
  // paint). Visually hide the main #ym-sl-panel via a class toggle and a one-time
  // injected !important rule. The panel still computes in the background — the
  // PiP needs its lyrics:lines / lyrics:sync bus topics — so this is purely a
  // visual / QoL suppression, not a pause.
  let suppressStyleInjected = false;
  function setMainPanelSuppressed(suppressed) {
    const panel = document.getElementById("ym-sl-panel");
    if (!panel) return;
    if (suppressed && !suppressStyleInjected) {
      const style = document.createElement("style");
      style.id = "ym-pip-suppress-style";
      style.textContent = "#ym-sl-panel.ym-pip-suppressed { display: none !important; }";
      (document.head || document.documentElement).appendChild(style);
      suppressStyleInjected = true;
    }
    panel.classList.toggle("ym-pip-suppressed", suppressed);
  }

  function onPipClosed() {
    stopSync();
    stopKawarp();
    pipWin = null;
    pipDoc = null;
    lineEls = [];
    setMainPanelSuppressed(false);
    if (btnHandle) btnHandle.setActive(false);
  }

  function openPip() {
    if (!supported()) return;
    // requestWindow needs the user gesture, so it is called synchronously here.
    documentPictureInPicture.requestWindow({ width: 460, height: 300 }).then((win) => {
      pipWin = win;
      pipDoc = win.document;
      buildPipDoc(win);
      win.addEventListener("pagehide", onPipClosed);
      if (btnHandle) btnHandle.setActive(true);
      setMainPanelSuppressed(true);
      // Pull the current lyrics: they are published when the lyrics are BUILT,
      // which is usually before this window is opened.
      const cached = (window.YTMod && window.YTMod.bus) ? window.YTMod.bus.last("lyrics:lines") : null;
      if (cached) onLines(cached);
      else { setHeader(); buildLinesBox(); }
      lastRenderedActive = -2;
      syncLoop();
    }).catch(() => {
      if (btnHandle) btnHandle.setActive(false);
    });
  }

  function closePip() {
    if (pipWin && !pipWin.closed) pipWin.close();
    onPipClosed();
  }

  function togglePip() {
    if (pipWin && !pipWin.closed) closePip();
    else openPip();
  }

  // ---- settings ------------------------------------------------------------
  function applySettings(next) {
    settings = Object.assign({}, settings, next || {});
    const master = settings.master !== false;
    if (!master) {
      closePip();
      if (btnHandle) { btnHandle.remove(); btnHandle = null; }
      return;
    }
    if (!supported()) return; // no PiP in this browser — no button at all
    if (!btnHandle) mountButton();
    // Live-copy the panel's current lyric settings into an already-open PiP.
    // The panel owns the size slider now, so no PiP-only zoom variable exists.
    const panelWrap = pipEl("ym-sl-panel");
    if (panelWrap) copyPanelVars(panelWrap);
  }

  function mountButton() {
    if (!window.YTMod || !window.YTMod.addPlayerBarButton) return;
    btnHandle = window.YTMod.addPlayerBarButton({
      id: "pip-lyrics",
      label: "Lyrics in picture-in-picture",
      iconSvgPath: ICON_PIP,
      onClick: () => togglePip(),
    });
  }

  function start() {
    if (window.YTMod && window.YTMod.bus) {
      // replay: both of these may already have been published before this add-on
      // loaded, and without it a late subscriber would sit on an empty view.
      unsubscribe = window.YTMod.bus.on("lyrics:lines", onLines, { replay: true });
      unsubscribeKit = window.YTMod.bus.on("lyrics:renderer", (payload) => {
        if (!payload) return;
        const wasMissing = !kit;
        kit = payload;
        // Lines rendered before the kit arrived have no springs attached, so
        // rebuild them to pick up the real animation.
        if (wasMissing && lines.length && pipWin && !pipWin.closed) buildLinesBox();
      }, { replay: true });
      // The sync offset (manual + MV-pause re-sync). replay:true so a PiP opened
      // mid-track inherits the offset currently in effect on the synced tab.
      unsubscribeSync = window.YTMod.bus.on("lyrics:sync", (payload) => {
        syncState = payload || null;
      }, { replay: true });
      // Live scroll/motion settings. Without this a toggle only reached the PiP on
      // the NEXT lyrics payload, so "Smooth Scrolling off" and "Apple Music style
      // lyrics" appeared to do nothing here (AJ, 2026-10-07).
      unsubscribeSettings = window.YTMod.bus.on("lyrics:settings", onSettings, { replay: true });
    }
    applySettings(settings);
    window.postMessage({ type: "ytmod-settings-request", id: EXT_ID }, "*");
  }

  function teardown() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (unsubscribeKit) { unsubscribeKit(); unsubscribeKit = null; }
    if (unsubscribeSync) { unsubscribeSync(); unsubscribeSync = null; }
    if (unsubscribeSettings) { unsubscribeSettings(); unsubscribeSettings = null; }
    closePip();
    if (btnHandle) { btnHandle.remove(); btnHandle = null; }
    lines = [];
    lineEls = [];
    lineSets = [];
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.id !== EXT_ID) return;
    if (data.type === "ytmod-settings") { applySettings(data.settings); return; }
    if (data.type !== "ytmod-ext") return;
    if (data.action === "disable") teardown();
  });

  whenYTMod(() => {
    start();
  });
})();
