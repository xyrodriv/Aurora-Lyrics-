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
  // Console branding: a red Aurora badge on every log, shaped like the
  // coloured tags Better Lyrics prints. Bound helpers keep the real call
  // site in DevTools instead of pointing at a wrapper.
  const AURORA_BADGE = "background:#dc2626;color:#fff;padding:1px 5px;border-radius:3px;font-weight:600";
  const alWarn = console.warn.bind(console, "%cAurora Lyrics", AURORA_BADGE);


  const EXT_ID = "ytmod-pip-lyrics";
  const SCRIPT_URL = (document.currentScript && document.currentScript.src) || "";
  const FONT_BASE = SCRIPT_URL ? new URL("fonts/", SCRIPT_URL).href : "";

  const DEFAULTS = { master: true, showTransport: true };
  let settings = Object.assign({}, DEFAULTS);

  // Bar glyph: a screen with the mini player docked in its corner. `iconParts`
  // rather than Material's one filled path, so it carries the bar's own 2.4
  // round weight (see addPlayerBarButton in public-api.js) instead of YouTube
  // Music's speaker-box shape.
  const ICON_PIP_PARTS = [
    { d: "M6 5h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z" },
    {
      d: "M13.7 12.2h3.4a1.1 1.1 0 0 1 1.1 1.1v2a1.1 1.1 0 0 1-1.1 1.1h-3.4a1.1 1.1 0 0 1-1.1-1.1v-2a1.1 1.1 0 0 1 1.1-1.1Z",
      mode: "fill",
    },
  ];

  // Shuffle / Repeat / Repeat-one — the panel's own glyphs (08-fullscreen-controls),
  // so the PiP's toggles match the fullscreen chip exactly.
  const ICON_VOLUME = "M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12z";

  /* ---- fullscreen transport glyphs ---------------------------------------
     Copied from 08-fullscreen-controls so the PiP draws the SAME icons as the
     fullscreen player instead of Material lookalikes: one double-chevron skip
     (35x20), and the thick rounded shuffle / repeat (24 grid, 2.6 stroke).
     fsSvgIcon's multi-part builder is mirrored here as partSvg because the PiP
     document is built by this add-on alone. */
  const FS_STROKE = 2.6;
  const fsThick = (parts) => parts.map((part) => ({
    tag: part.tag,
    attrs: Object.assign(
      {
        fill: "none",
        stroke: "currentColor",
        "stroke-width": String(FS_STROKE),
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
      part.attrs
    ),
  }));
  const FS_SKIP_D = "M 19.467 19.905 C 20.008 19.905 20.463 19.746 21.005 19.426 L 33.61 12.023 C 34.533 11.482 35 10.817 35 9.993 C 35 9.158 34.545 8.53 33.61 7.977 L 21.005 0.574 C 20.463 0.254 19.998 0.094 19.456 0.094 C 18.374 0.094 17.475 0.917 17.475 2.418 L 17.475 9.49 C 17.315 8.898 16.873 8.408 16.135 7.977 L 3.529 0.574 C 3 0.254 2.533 0.094 1.993 0.094 C 0.911 0.094 0 0.917 0 2.418 L 0 17.582 C 0 19.083 0.91 19.906 1.993 19.906 C 2.533 19.906 3 19.746 3.529 19.426 L 16.135 12.023 C 16.861 11.593 17.315 11.088 17.475 10.485 L 17.475 17.582 C 17.475 19.083 18.386 19.906 19.467 19.906 L 19.467 19.905 Z";
  const PART_ICON_SHUFFLE = fsThick([
    { tag: "path", attrs: { d: "M3 17h2.4c2.1 0 3.4-1.2 4.6-3l3.1-4c1.2-1.8 2.5-3 4.6-3H20" } },
    { tag: "path", attrs: { d: "M3 7h2.4c2.1 0 3.4 1.2 4.6 3l3.1 4c1.2 1.8 2.6 3 4.6 3H20" } },
    { tag: "path", attrs: { d: "M17.2 4.3 20.2 7l-3 2.7" } },
    { tag: "path", attrs: { d: "M17.2 14.3 20.2 17l-3 2.7" } },
  ]);
  /* Repeat is the fullscreen chip's glyph STRUCTURE, not just its shape: the
     looping animation travels a filled "track" around the loop while the two
     static rails fade out and a head rides an offset-path in the same
     direction. Those class names are the ones the fullscreen CSS animates, and
     the same keyframes are copied into this add-on's stylesheet - rebuilding a
     lookalike spin from the description was exactly what not to do. */
  const PART_ICON_REPEAT = [
    {
      tag: "path",
      attrs: {
        class: "ym-pip-repeat-track",
        d: "M3 9.5V8.5A3.5 3.5 0 0 1 6.5 5H20.2A1.6 1.6 0 0 1 21.8 6.6V14.5H21V15.5A3.5 3.5 0 0 1 17.5 19H3.8A1.6 1.6 0 0 1 2.2 17.4V9.5H3Z",
        pathLength: "100",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2.6",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
    },
    {
      tag: "g",
      attrs: { class: "ym-pip-repeat-rail ym-pip-repeat-rail-top" },
      children: fsThick([
        { tag: "path", attrs: { d: "M3 9.5V8.5A3.5 3.5 0 0 1 6.5 5H20" } },
        { tag: "path", attrs: { d: "M17.2 2.3 20.2 5l-3 2.7" } },
      ]),
    },
    {
      tag: "g",
      attrs: { class: "ym-pip-repeat-rail ym-pip-repeat-rail-bottom" },
      children: fsThick([
        { tag: "path", attrs: { d: "M21 14.5v1A3.5 3.5 0 0 1 17.5 19H4" } },
        { tag: "path", attrs: { d: "M6.8 16.3 3.8 19l3 2.7" } },
      ]),
    },
    {
      tag: "g",
      attrs: { class: "ym-pip-repeat-head ym-pip-repeat-head-top" },
      children: fsThick([{ tag: "path", attrs: { d: "M17.2 2.3 20.2 5l-3 2.7" } }]),
    },
    {
      tag: "g",
      attrs: { class: "ym-pip-repeat-head ym-pip-repeat-head-bottom" },
      children: fsThick([{ tag: "path", attrs: { d: "M6.8 16.3 3.8 19l3 2.7" } }]),
    },
  ];
  const PART_ICON_REPEAT_ONE = fsThick([
    { tag: "path", attrs: { d: "M11.1 10.4 12.8 9.2v5.9" } },
    { tag: "path", attrs: { d: "M10.9 15.1h3.8" } },
  ]);

  /* ---- play / pause morph -------------------------------------------------
     Ported from 08-fullscreen-controls: the glyph is TWO rounded quads that are
     interpolated point-by-point and re-emitted as path data every frame, so
     pause's two bars BECOME the play triangle instead of crossfading. Same
     shapes, same 260ms, same cubic ease. */
  const FS_PLAY_MORPH_MS = 260;
  const FS_PLAY_PAUSE_SHAPES = [
    { p: [2, 0, 8, 0, 8, 20, 2, 20], r: [2, 2, 2, 2] },
    { p: [10, 0, 16, 0, 16, 20, 10, 20], r: [2, 2, 2, 2] },
  ];
  const FS_PLAY_TRIANGLE_SHAPES = [
    { p: [2, 0, 9.5, 5, 9.5, 15, 2, 20], r: [2.2, 0, 0, 2.2] },
    { p: [6, 2.67, 17, 10, 6, 17.33, 6, 10], r: [0, 3.2, 0, 0] },
  ];
  function fsPlayMorphEase(t) {
    return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  function fsRoundedQuadPath(points, radii) {
    let d = "";
    for (let i = 0; i < 4; i++) {
      const pi = ((i + 3) % 4) * 2;
      const ci = i * 2;
      const ni = ((i + 1) % 4) * 2;
      const px = points[pi], py = points[pi + 1];
      const cx = points[ci], cy = points[ci + 1];
      const nx = points[ni], ny = points[ni + 1];
      const r = radii[i] || 0;
      const prevLen = Math.hypot(cx - px, cy - py);
      const nextLen = Math.hypot(nx - cx, ny - cy);
      const prevR = prevLen > 0 ? Math.min(r, prevLen / 2) : 0;
      const nextR = nextLen > 0 ? Math.min(r, nextLen / 2) : 0;
      const sx = prevLen > 0 ? cx + (px - cx) * (prevR / prevLen) : cx;
      const sy = prevLen > 0 ? cy + (py - cy) * (prevR / prevLen) : cy;
      const ex = nextLen > 0 ? cx + (nx - cx) * (nextR / nextLen) : cx;
      const ey = nextLen > 0 ? cy + (ny - cy) * (nextR / nextLen) : cy;
      d += (i === 0 ? "M" : "L") + sx.toFixed(2) + " " + sy.toFixed(2);
      d += "Q" + cx.toFixed(2) + " " + cy.toFixed(2) +
        " " + ex.toFixed(2) + " " + ey.toFixed(2);
    }
    return d + " Z";
  }
  function pipDrawPlayMorph(button, t) {
    const paths = button.querySelectorAll(".ym-pip-play-morph");
    if (paths.length < 2) return;
    for (let i = 0; i < 2; i++) {
      const from = FS_PLAY_PAUSE_SHAPES[i];
      const to = FS_PLAY_TRIANGLE_SHAPES[i];
      const points = [];
      const radii = [];
      for (let j = 0; j < 8; j++) points.push(from.p[j] + (to.p[j] - from.p[j]) * t);
      for (let j = 0; j < 4; j++) radii.push(from.r[j] + (to.r[j] - from.r[j]) * t);
      paths[i].setAttribute("d", fsRoundedQuadPath(points, radii));
    }
  }
  // t = 0 is pause (two bars), t = 1 is play (triangle), exactly as fullscreen.
  function pipSetPlayMorph(button, action, immediate) {
    if (!button) return;
    // Call-on-CHANGE only, like the fullscreen chip. The PiP's sync loop runs
    // every frame, and re-entering here each time cancelled the running tween
    // and restarted the 260ms ease from the current value - the morph crept a
    // few percent forward per frame and never arrived, so the glyph sat on the
    // pause bars forever.
    if (button.dataset.playState === action && immediate !== true) return;
    button.dataset.playState = action;
    button.setAttribute("aria-label", action === "play" ? "Play" : "Pause");
    const target = action === "play" ? 1 : 0;
    let state = button.__pipPlayMorph;
    if (!state) state = button.__pipPlayMorph = { t: target, raf: 0 };
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
    const from = state.t;
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (immediate === true || reduced || Math.abs(target - from) < .001) {
      state.t = target;
      pipDrawPlayMorph(button, target);
      return;
    }
    const start = performance.now();
    const step = (now) => {
      if (!button.isConnected) { state.raf = 0; return; }
      const progress = Math.min(1, (now - start) / FS_PLAY_MORPH_MS);
      state.t = from + (target - from) * fsPlayMorphEase(progress);
      pipDrawPlayMorph(button, state.t);
      if (progress < 1) state.raf = requestAnimationFrame(step);
      else { state.t = target; state.raf = 0; }
    };
    state.raf = requestAnimationFrame(step);
  }
  function pipPlayMorphSvg(doc) {
    const svg = partSvg(doc, [], "0 0 18 20");
    for (let i = 0; i < 2; i++) {
      const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "ym-pip-play-morph");
      path.setAttribute("d", fsRoundedQuadPath(
        FS_PLAY_PAUSE_SHAPES[i].p, FS_PLAY_PAUSE_SHAPES[i].r
      ));
      path.setAttribute("fill", "currentColor");
      svg.appendChild(path);
    }
    return svg;
  }

  // Build an SVG from part descriptors. Attributes are set one by one so the
  // stroke parts keep fill:none without a stylesheet rule having to fight the
  // generic "button svg { fill: currentColor }".
  function partSvg(doc, parts, viewBox, extraClass) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", viewBox || "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (extraClass) svg.setAttribute("class", extraClass);
    const add = (parent, part) => {
      const el = doc.createElementNS(NS, part.tag);
      const attrs = part.attrs || {};
      for (const key of Object.keys(attrs)) el.setAttribute(key, attrs[key]);
      if (part.children) part.children.forEach((child) => add(el, child));
      parent.appendChild(el);
      return el;
    };
    parts.forEach((part) => add(svg, part));
    return svg;
  }

  // Same vendored Kawarp module the Dynamic theme and the fullscreen backdrop
  // use, so the PiP gets the identical fluid treatment rather than a lookalike.
  const KAWARP_CORE_URL = SCRIPT_URL ? new URL("kawarp-core.js", SCRIPT_URL).href : "";
  // The SAME engine module the panel uses for Apple-Music-style lyrics. Loaded
  // here so a line-by-line track keeps its renderer when it moves to the PiP.
  const AMLL_CORE_URL = SCRIPT_URL ? new URL("amll-core.js", SCRIPT_URL).href : "";
  const KAWARP_OPTIONS = {
    warpIntensity: 1,
    blurPasses: 6,
    animationSpeed: 0.5,
    saturation: 1.5,
    // Dithering is the fixed kawarp-core default, not a user setting.
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
      padding: 14px 16px 12px;
      box-sizing: border-box;
      /* Fallback for when Kawarp cannot start (no WebGL, module failure). */
      background: linear-gradient(180deg, #17181c 0%, #0c0d10 100%);
      color: #fff;
      font-family: "SpicyLyrics", Roboto, Arial, sans-serif;
      overflow: hidden;
      user-select: none;
      /* Compositor-only entrance: the window itself is created by Chrome, so
         this is the only "open" motion the document owns. */
      animation: ym-pip-in .34s cubic-bezier(.2, .7, .3, 1) both;
    }
    @keyframes ym-pip-in {
      from { opacity: 0; transform: scale(.985) translateY(6px); }
      to { opacity: 1; transform: none; }
    }
    /* The Kawarp canvas is the backdrop; everything else sits above it. */
    .ym-pip-kawarp {
      position: absolute;
      inset: 0;
      z-index: 0;
      /* The backing store is sized in DEVICE pixels for sharpness; without these
         the canvas displays at its attribute size (1.5x the window) and spills
         past the root. 100% + the 1.06 scale is the only overscan. */
      display: block;
      width: 100%;
      height: 100%;
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
    .ym-pip-board,
    .ym-pip > .ym-pip-controls { position: relative; z-index: 2; }
    /* One board holds the picture and the lyric column, so the layout can move
       the picture to the side without touching the DOM. Stacked (default):
       video row, title row, lyrics row. */
    .ym-pip-board {
      flex: 1 1 auto;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto auto minmax(0, 1fr);
      grid-template-areas: "video" "head" "stage";
    }
    /* ---- music-video pane --------------------------------------------------
       The live player video is MIRRORED here (captureStream), never moved: the
       tab keeps its picture and playback, and YTM's element stays where it
       expects it. */
    .ym-pip-video-wrap {
      position: relative;
      z-index: 2;
      grid-area: video;
      opacity: 0;
      margin-bottom: 0;
      transition:
        opacity .28s ease,
        margin-bottom .38s cubic-bezier(.22, .61, .36, 1);
    }
    /* "video-on" means "show the picture NOW", which is not the same as "this
       track has a video". A window too short to feed the picture without
       starving the lyrics drops the class, and the thumbnail comes back. */
    .ym-pip.video-on .ym-pip-video-wrap {
      opacity: 1;
      margin-bottom: 12px;
    }
    /* max-height, not grid-template-rows: a 1fr row inside an auto-height
       container resolves to 0, so the video painted OVER the header instead of
       taking space (measured in a headless pass). The inner carries the 16:9
       ratio, so it has a real height to collapse from. */
    .ym-pip-video-inner {
      width: 100%;
      aspect-ratio: 16 / 9;
      max-height: 0;
      overflow: hidden;
      border-radius: 14px;
      background: #000;
      box-shadow: 0 14px 34px rgba(0, 0, 0, .45);
      position: relative;
      transition: max-height .4s cubic-bezier(.22, .61, .36, 1);
    }
    .ym-pip.video-on .ym-pip-video-inner { max-height: 50vh; }
    /* WIDE layout: picture on the LEFT, title + lyrics in a RIGHT column, the
       transport still spanning the bottom. Applied only when JS measured a
       window wide enough for both columns AND a picture that fits (see
       updatePipLayout), so a narrow PiP keeps the stacked arrangement. */
    .ym-pip.video-on.ym-pip-wide .ym-pip-board {
      grid-template-columns: minmax(0, 1.06fr) minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
      grid-template-areas:
        "video head"
        "video stage";
      column-gap: 16px;
    }
    .ym-pip.video-on.ym-pip-wide .ym-pip-video-wrap {
      margin-bottom: 0;
      align-self: center;
      min-height: 0;
    }
    /* The left column sets the width; this keeps the picture from overflowing a
       short window. 124px = the shell's 26px padding + the measured transport
       card (82px) + a little slack; it only bites on extreme wide-and-short. */
    .ym-pip.video-on.ym-pip-wide .ym-pip-video-inner {
      max-height: calc(100vh - 124px);
    }
    #ym-pip-video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #000;
      opacity: 0;
      transition: opacity .45s ease;
    }
    #ym-pip-video.live { opacity: 1; }
    .ym-pip-head {
      display: flex;
      align-items: center;
      gap: 10px;
      grid-area: head;
      margin-bottom: 10px;
      min-width: 0;
      animation: ym-pip-rise .4s .04s cubic-bezier(.2, .7, .3, 1) both;
    }
    /* With the video on top the thumbnail is redundant, and the title becomes
       the caption for the picture. */
    .ym-pip.video-on .ym-pip-art { display: none; }
    .ym-pip.video-on .ym-pip-title { font-size: 16px; letter-spacing: .1px; }
    .ym-pip.video-on .ym-pip-artist { font-size: 12.5px; }
    @keyframes ym-pip-rise {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: none; }
    }
    /* Track change: the text is re-written in place, so flash it rather than
       letting a new title appear mid-frame with no transition. */
    .ym-pip-title.swap, .ym-pip-artist.swap {
      animation: ym-pip-swap .34s cubic-bezier(.2, .7, .3, 1) both;
    }
    @keyframes ym-pip-swap {
      from { opacity: .15; transform: translateY(5px); }
      to { opacity: 1; transform: none; }
    }
    /* Cover art thumbnail. Hidden until the track supplies
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
    /* The lyric viewport. Holds the built-in renderer's scroll box, and the
       AMLL host on top of it when the engine owns the track. */
    .ym-pip-stage {
      position: relative;
      grid-area: stage;
      min-height: 0;
    }
    .ym-pip-stage .ym-pip-lines {
      position: absolute;
      inset: 0;
    }
    /* Soft TOP edge only. A scroll box has to clip, and a hard line cutting a
       glyph in half under the header is what reads as broken. No bottom mask:
       the controls card terminates the area, and fading the last lines there
       just made the fill look like it was dying early. */
    #ym-sl-amll-host {
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 26px);
      mask-image: linear-gradient(to bottom, transparent 0, #000 26px);
    }
    /* Top AND bottom dissolve: with the card gone, lines were
       ending on a hard cut right above the transport. The bottom band is 72px
       so a line fades out as it approaches the controls instead of being sliced
       by the scrollport edge. */
    .ym-pip-lines {
      -webkit-mask-image: linear-gradient(to bottom,
        transparent 0,
        #000 26px,
        #000 calc(100% - 72px),
        transparent 100%);
      mask-image: linear-gradient(to bottom,
        transparent 0,
        #000 26px,
        #000 calc(100% - 72px),
        transparent 100%);
    }
    .ym-pip-lines {
      position: relative;
      min-height: 0;
      /* border-box is REQUIRED for the padding below to do anything: as a
         stretched flex item this element defaults to content-box, so padding
         would be added OUTSIDE the box (past the window edge) instead of
         insetting the content. */
      box-sizing: border-box;
      overflow-x: hidden;
      overflow-y: auto;
      /* NO VISIBLE SCROLLBAR: the draggable thumb on the right
         was unwanted. Hiding it also means the gutter must go — with
         scrollbar-gutter:stable a blank strip would still be reserved. The 32px
         right inset STAYS: it is there because the ACTIVE line's glyphs paint past
         the layout box (a transform does not change layout) and overflow-x:hidden
         would clip them. Scrolling itself is unchanged; "Jump to current" is the
         discoverable way back to the active line. */
      padding-right: 32px;
      /* Same reason as the right inset, for the LEFT edge: a word's glow
         (text-shadow) and a long word's first syllable both paint past the
         layout box, and overflow-x:hidden was cutting them at the window edge.
         The lines sat flush left, so the 1-second emphasis glow lost its left
         half. This reserves the band the glow needs; the text layout itself is
         unchanged apart from that inset. */
      padding-left: 22px;
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
      z-index: 6;
      /* Bottom-LEFT of the LYRIC area, so it never lands on the controls card. */
      left: 2px;
      bottom: 6px;
      display: block;
      padding: 7px 12px;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 999px;
      background: rgba(20,20,24,.72);
      color: rgba(255,255,255,.92);
      font: 600 12px/1.2 "SpicyLyrics", Roboto, Arial, sans-serif;
      cursor: pointer;
      white-space: nowrap;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      opacity: 0;
      transform: translateY(6px);
      pointer-events: none;
      transition: opacity .2s ease, transform .24s cubic-bezier(.2, .7, .3, 1),
        background-color .16s ease;
    }
    .ym-pip-jump.visible { opacity: 1; transform: none; pointer-events: auto; }
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
    /* No far-line dimming (the lyrics that cut off at the bottom
       still get dim which i dont want"). The bottom mask already dissolves a
       line as it leaves; a second opacity cut made the next lines look broken
       rather than faded. Depth blur supplies the distance cue now. */
    /* ---- controls ---------------------------------------------------------
       One glass card instead of loose rows: the seek bar, transport and volume
       now read as a single object, which is also what gives the window its
       "floating player" feel. */
    /* No card (i dont really want a whole frosted border down
       there"): Apple Music's mini player doesn't box its transport either. The
       controls sit straight on the artwork, only the glyphs and a thin progress
       line carry weight. */
    .ym-pip-controls {
      flex: 0 0 auto;
      position: relative;
      margin-top: 6px;
      padding: 4px 4px 0;
      border-radius: 0;
      background: transparent;
      border: 0;
      box-shadow: none;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
    .ym-pip-transport {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding-top: 10px;
      /* The volume sits at the far right WITHOUT dragging the centred transport
         off-centre — an absolute child does not take part in the centring. */
      position: relative;
    }
    .ym-pip-transport button {
      width: 36px;
      height: 36px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: rgba(255, 255, 255, .8);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color .16s ease, color .16s ease, transform .16s ease;
    }
    /* Hover is a glyph-shaped halo, not a button surface - the fullscreen
       player's treatment. A filled disc reads heavy in a 480px window. */
    .ym-pip-transport button:hover { background: transparent; color: #fff; }
    .ym-pip-transport button > svg { transition: filter .22s ease; }
    .ym-pip-transport button:hover > svg {
      filter: drop-shadow(0 0 5px rgba(255, 255, 255, .4));
    }
    .ym-pip-transport button:active { transform: scale(.92); }
    .ym-pip-transport button:focus-visible {
      outline: 2px solid rgba(255, 255, 255, .8);
      outline-offset: 2px;
    }
    .ym-pip-transport button svg { width: 21px; height: 21px; fill: currentColor; }
    /* Primary transport: a solid disc, so the one action you reach for is
       unmistakable at a glance in a small window. */
    .ym-pip-transport .ym-pip-main {
      width: 42px;
      height: 42px;
      margin: 0 2px;
      background: #fff;
      color: #111;
      box-shadow: 0 4px 14px rgba(0, 0, 0, .35);
      transition: transform .2s cubic-bezier(.2, .8, .3, 1.2), box-shadow .2s ease,
        background-color .16s ease;
    }
    .ym-pip-transport .ym-pip-main:hover {
      background: #fff;
      transform: scale(1.06);
      box-shadow: 0 6px 18px rgba(0, 0, 0, .42);
    }
    .ym-pip-transport .ym-pip-main:active { transform: scale(.95); }
    .ym-pip-transport .ym-pip-main svg { width: 24px; height: 24px; }
    /* Shuffle / Repeat are dimmed at rest and full white when engaged — the class
       is set from the LIVE player state in syncLoop, so they cannot lie. */
    .ym-pip-transport .ym-pip-opt { color: rgba(255, 255, 255, .42); }
    .ym-pip-transport .ym-pip-opt:hover { color: rgba(255, 255, 255, .9); }
    /* The skip glyph is the fullscreen 35x20 double chevron: it needs its own
       aspect ratio, and Prev is the same drawing mirrored. */
    .ym-pip-transport .ym-pip-skip svg { width: 25px; height: 14px; }
    .ym-pip-transport .ym-pip-prev svg { transform: scaleX(-1); }
    .ym-pip-transport .ym-pip-opt { position: relative; }
    .ym-pip-transport .ym-pip-opt.active { color: #fff; }
    .ym-pip-transport .ym-pip-opt.active > svg {
      filter: drop-shadow(0 0 3px rgba(255, 255, 255, .32));
    }
    /* The fullscreen "engaged" cue, copied exactly: a 4px dot under the glyph,
       opacity-gated so it fades rather than pops. */
    .ym-pip-transport .ym-pip-shuffle::after,
    .ym-pip-transport .ym-pip-repeat::after {
      content: "";
      position: absolute;
      bottom: 2px;
      left: 50%;
      transform: translateX(-50%);
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: #fff;
      opacity: 0;
      transition: opacity .2s ease;
    }
    .ym-pip-transport .ym-pip-shuffle.active::after,
    .ym-pip-transport .ym-pip-repeat.active::after { opacity: 1; }
    /* Same 0.52s pulse the fullscreen shuffle plays when switched on. */
    .ym-pip-transport .ym-pip-opt.is-glowing > svg {
      animation: ym-pip-opt-glow .52s ease-in-out both;
    }
    @keyframes ym-pip-opt-glow {
      0%, 100% { transform: scale(1); filter: drop-shadow(0 0 0 rgba(255, 255, 255, 0)); }
      48%      { transform: scale(1.08); filter: drop-shadow(0 0 7px rgba(255, 255, 255, .65)); }
    }
    @media (prefers-reduced-motion: reduce) {
      .ym-pip-transport .ym-pip-opt.is-glowing > svg { animation: none; }
    }
    /* Play/pause is a floating glyph like the fullscreen transport, not a white
       disc: the two morphing quads are filled with currentColor and there is no
       surface under them. */
    .ym-pip-transport .ym-pip-main {
      background: transparent;
      color: #fff;
      box-shadow: none;
      opacity: .9;
    }
    .ym-pip-transport .ym-pip-main:hover {
      background: transparent;
      box-shadow: none;
      opacity: 1;
      transform: scale(1.06);
    }
    .ym-pip-transport .ym-pip-main svg { width: 20px; height: 22px; }
    .ym-pip-transport .ym-pip-play-morph { fill: currentColor; }
    /* Repeat loop: the fullscreen keyframes, copied verbatim. The filled track
       draws itself round the loop while the head rides the same path. */
    .ym-pip-transport .ym-pip-repeat-track {
      opacity: 0;
      stroke-dasharray: 32.15 17.85;
      stroke-dashoffset: 0;
      transition: opacity .06s linear;
    }
    .ym-pip-transport .ym-pip-repeat-rail { transition: opacity .06s linear; }
    .ym-pip-transport .ym-pip-repeat-head {
      opacity: 0;
      transform-box: fill-box;
      offset-distance: 0%;
      transition: opacity .06s linear;
    }
    .ym-pip-transport .ym-pip-repeat-head-top {
      offset-path: path("M20.2 5A1.6 1.6 0 0 1 21.8 6.6V14.5H21V15.5A3.5 3.5 0 0 1 17.5 19H3.8A1.6 1.6 0 0 1 2.2 17.4V9.5H3V8.5A3.5 3.5 0 0 1 6.5 5H20.2Z");
      offset-anchor: 100% 50%;
      offset-rotate: auto;
    }
    .ym-pip-transport .ym-pip-repeat-head-bottom {
      offset-path: path("M3.8 19A1.6 1.6 0 0 1 2.2 17.4V9.5H3V8.5A3.5 3.5 0 0 1 6.5 5H20.2A1.6 1.6 0 0 1 21.8 6.6V14.5H21V15.5A3.5 3.5 0 0 1 17.5 19H3.8Z");
      offset-anchor: 0% 50%;
      offset-rotate: auto -180deg;
    }
    .ym-pip-transport .ym-pip-repeat.is-looping .ym-pip-repeat-rail { opacity: 0; }
    .ym-pip-transport .ym-pip-repeat.is-looping .ym-pip-repeat-track,
    .ym-pip-transport .ym-pip-repeat.is-looping .ym-pip-repeat-head { opacity: 1; }
    .ym-pip-transport .ym-pip-repeat.is-looping .ym-pip-repeat-track {
      animation: ym-pip-repeat-track .62s cubic-bezier(.65, 0, .35, 1) both;
      will-change: stroke-dashoffset;
    }
    .ym-pip-transport .ym-pip-repeat.is-looping .ym-pip-repeat-head {
      animation: ym-pip-repeat-head .62s cubic-bezier(.65, 0, .35, 1) both;
      will-change: offset-distance;
    }
    @keyframes ym-pip-repeat-track {
      from { stroke-dashoffset: 0; }
      to   { stroke-dashoffset: -100; }
    }
    @keyframes ym-pip-repeat-head {
      from { offset-distance: 0%; }
      to   { offset-distance: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ym-pip-transport .ym-pip-repeat.is-looping .ym-pip-repeat-track,
      .ym-pip-transport .ym-pip-repeat.is-looping .ym-pip-repeat-head { animation: none; }
    }
    .ym-pip-vol {
      position: absolute;
      right: -2px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      gap: 6px;
      color: rgba(255, 255, 255, .6);
    }
    .ym-pip-vol svg { width: 17px; height: 17px; fill: currentColor; flex: 0 0 auto; }
    .ym-pip-volume { width: 58px; }
    /* ---- seek row -------------------------------------------------------- */
    .ym-pip-seek {
      display: flex;
      align-items: center;
      gap: 9px;
    }
    .ym-pip-time {
      font-size: 10.5px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: rgba(255, 255, 255, .5);
      min-width: 29px;
      letter-spacing: .2px;
    }
    .ym-pip-time:last-child { text-align: right; }
    /* The track behind the knob is a FILL: a hard-stop gradient driven by the
       --ym-pip-fill percentage the loop writes, so the played part reads at a
       glance without a second element. */
    .ym-pip-seek-range,
    .ym-pip-volume {
      -webkit-appearance: none;
      appearance: none;
      height: 4px;
      border-radius: 999px;
      background: linear-gradient(90deg,
        rgba(255, 255, 255, .92) 0 var(--ym-pip-fill, 0%),
        rgba(255, 255, 255, .2) var(--ym-pip-fill, 0%) 100%);
      cursor: pointer;
      transition: height .16s ease;
    }
    .ym-pip-seek-range:hover,
    .ym-pip-volume:hover { height: 5px; }
    .ym-pip-seek-range { flex: 1 1 auto; min-width: 0; }
    .ym-pip-seek-range::-webkit-slider-thumb,
    .ym-pip-volume::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 5px rgba(0, 0, 0, .55);
      transition: transform .16s ease;
    }
    .ym-pip-seek-range:hover::-webkit-slider-thumb,
    .ym-pip-volume:hover::-webkit-slider-thumb { transform: scale(1.25); }
    /* No knob on the playback bar either. */
    .ym-pip-seek-range::-webkit-slider-thumb { width: 0; height: 0; opacity: 0; }
    .ym-pip-seek-range::-moz-range-thumb { width: 0; height: 0; opacity: 0; border: 0; }
    /* ---- sliders: the fullscreen scrubber's dimensions and behaviour --------
       A 3px track with hairline insets that grows to 9px on hover, and a 12px
       thumb that only appears while you are pointing at it - so nothing sits
       there as a stray dot, but dragging still has a grab handle. */
    .ym-pip-seek-range,
    .ym-pip-volume {
      height: 3px;
      border-radius: 999px;
      background: linear-gradient(90deg,
        rgba(255, 255, 255, .92) 0 var(--ym-pip-fill, 0%),
        rgba(255, 255, 255, .18) var(--ym-pip-fill, 0%) 100%);
      box-shadow:
        inset 0 0 0 1px rgba(255, 255, 255, .16),
        inset 0 1px 0 rgba(255, 255, 255, .22);
      transition: height .18s ease;
    }
    .ym-pip-seek-range:hover,
    .ym-pip-volume:hover { height: 9px; }
    .ym-pip-seek-range::-webkit-slider-thumb,
    .ym-pip-volume::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 12px;
      height: 12px;
      margin-top: -4.5px;
      border: 0;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 5px rgba(0, 0, 0, .5);
      opacity: 0;
      transition: opacity .2s ease;
    }
    /* The thumb stays invisible even on hover (a dot shows when
       hovering over the sliders pls fix that"). The track alone carries the
       value, the same as the volume slider before the fullscreen restyle; the
       drag readout pill already tells you where you are pointing. */
    .ym-pip-seek-range:hover::-webkit-slider-thumb,
    .ym-pip-volume:hover::-webkit-slider-thumb,
    .ym-pip-seek-range:focus::-webkit-slider-thumb,
    .ym-pip-volume:focus::-webkit-slider-thumb { opacity: 0; }
    .ym-pip-seek-range::-moz-range-thumb,
    .ym-pip-volume::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border: 0;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 5px rgba(0, 0, 0, .5);
      opacity: 0;
    }
    .ym-pip-seek-range:hover::-moz-range-thumb,
    .ym-pip-volume:hover::-moz-range-thumb { opacity: 0; }
    /* The fullscreen readout pill, floating over the slider while dragging. */
    .ym-pip-tip {
      position: absolute;
      transform: translateX(-50%);
      background: rgba(18, 18, 20, .92);
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      padding: 6px 9px;
      border-radius: 8px;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity .15s ease;
      z-index: 8;
      font-variant-numeric: tabular-nums;
    }
    .ym-pip-tip-on { opacity: 1; }
    .ym-pip-hint {
      flex: 0 0 auto;
      text-align: center;
      font-size: 11px;
      color: rgba(255, 255, 255, .34);
    }
    /* A narrow window cannot fit the volume beside five buttons; the icon would
       end up under the next button. Drop the slider, keep the transport. */
    @media (max-width: 420px) {
      .ym-pip-vol { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ym-pip,
      .ym-pip-head,
      .ym-pip-controls,
      .ym-pip-title.swap,
      .ym-pip-artist.swap,
      .ym-pip-video-wrap,
      #ym-pip-video,
      .ym-pip-jump,
      .ym-pip-transport button,
      .ym-pip-transport .ym-pip-main {
        animation: none !important;
        transition: none !important;
      }
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
  let songwriters = [];
  let attribution = null;
  let smoothScrolling = true;
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
  // ---- renderer ---------------------------------------------------------
  // "spicy" = the built-in renderer drawn from the panel's own stylesheet and
  // kit; "amll" = the real Apple-Music engine, exactly as the panel runs it for
  // line-by-line tracks. Published per track by the panel (the Renderer tab).
  let rendererMode = "spicy";
  let amllPlayer = null;
  let amllHost = null;
  let amllCreditsEl = null;
  let amllModulePromise = null;
  let amllGen = 0;
  let amllSizeObserver = null;
  let amllTimeHosts = [];
  const amllTimeHoldTimers = new Map();
  const AMLL_TIME_HOLD_MS = 600;
  let amllLastFrameAt = 0;
  // ---- music-video mirror ------------------------------------------------
  let pipVideoSource = null;
  let pipVideoStream = null;
  let pipVideoCheckedAt = 0;

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
    // The credits use the add-ons face, which the page gets from panel.css. The
    // PiP is a separate document with no panel.css, so declare it here too.
    const satoshi =
      "@font-face{font-family:'Satoshi';font-style:normal;font-weight:300 900;" +
      "font-display:swap;src:url('" + FONT_BASE + "Satoshi-Variable.woff2') format('woff2');}";
    return satoshi + faces.map(([weight, file]) =>
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
    // The window can be resized while open; the picture appears, moves to its own
    // column, or is dropped entirely depending on the new size (updatePipLayout).
    win.addEventListener("resize", updatePipLayout);

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

    // ---- music-video mirror (hidden until a video track is detected) ------
    // The <video> here is fed a captureStream of the TAB's player video. Moving
    // the real element across documents would take the picture away from YTM
    // and risk its player losing the media, so this is a read-only mirror.
    const videoWrap = makeEl(doc, "div", "ym-pip-video-wrap");
    videoWrap.id = "ym-pip-video-wrap";
    const videoInner = makeEl(doc, "div", "ym-pip-video-inner");
    const mirror = doc.createElement("video");
    mirror.id = "ym-pip-video";
    mirror.muted = true;
    mirror.autoplay = true;
    mirror.playsInline = true;
    mirror.setAttribute("playsinline", "");
    mirror.setAttribute("muted", "");
    mirror.addEventListener("playing", () => mirror.classList.add("live"));
    videoInner.appendChild(mirror);
    videoWrap.appendChild(videoInner);
    // The board owns the video, title and lyrics, so the wide layout can put the
    // picture in a left column simply by re-gridding it.
    const board = makeEl(doc, "div", "ym-pip-board");
    board.id = "ym-pip-board";
    board.appendChild(videoWrap);
    root.appendChild(board);

    const head = makeEl(doc, "div", "ym-pip-head");
    head.id = "ym-pip-head";
    // Cover art: a small square thumbnail beside the title, like
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
    // The dim "Aurora Lyrics" source label that used to sit at the far right of
    // the header is gone: the window already says what it is,
    // and the corner read as clutter next to the Apple-Music-style header.
    board.appendChild(head);

    // ---- lyric stage ------------------------------------------------------
    // Fixed-height box that owns BOTH renderers: the built-in scroll box and,
    // when the panel publishes renderer "amll", the engine host stacked on top.
    // Keeping the engine out of the scroll box is what gives it a stable
    // viewport (it translates its own lines instead of scrolling).
    const stage = makeEl(doc, "div", "ym-pip-stage");
    stage.id = "ym-pip-stage";
    const linesBox = makeEl(doc, "div", "ym-pip-lines");
    linesBox.id = "ym-pip-lines";
    const jump = makeEl(doc, "button", "ym-pip-jump", "Jump to current lyric");
    jump.id = "ym-pip-jump";
    jump.type = "button";
    jump.setAttribute("aria-label", "Jump to current lyric");
    jump.addEventListener("click", () => jumpToCurrentLyric());
    // OVERLAY, not content: a child of the STAGE, NOT of the scroll box. Inside
    // .ym-pip-lines it would scroll away with the lyrics (an absolutely
    // positioned child of a scroll container scrolls with it).
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
    stage.appendChild(linesBox);
    stage.appendChild(jump);
    board.appendChild(stage);
    // The video pane opening/closing changes the lyric viewport. Re-seat the
    // built-in camera afterwards, or the active line drifts off centre.
    if (typeof win.ResizeObserver === "function") {
      let stageResizeTimer = 0;
      const stageObserver = new win.ResizeObserver(() => {
        if (stageResizeTimer) win.clearTimeout(stageResizeTimer);
        stageResizeTimer = win.setTimeout(() => {
          stageResizeTimer = 0;
          if (!pipWin || pipWin.closed) return;
          if (rendererMode === "spicy" && lineEls.length) recenterAfterLayout();
        }, 140);
      });
      stageObserver.observe(stage);
    }

    if (settings.showTransport !== false) {
      // One glass card holds the scrubber and the transport, so the bottom of
      // the window reads as a single surface instead of three loose rows.
      const controls = makeEl(doc, "div", "ym-pip-controls");
      controls.id = "ym-pip-controls";
      // Value readout while a slider is dragged, the same pill the fullscreen
      // scrubber floats above its thumb.
      const pipTip = makeEl(doc, "div", "ym-pip-tip");
      controls.appendChild(pipTip);
      const repositionTip = (input, text) => {
        const cardBox = controls.getBoundingClientRect();
        const box = input.getBoundingClientRect();
        const min = Number(input.min) || 0;
        const max = Number(input.max) || 100;
        const ratio = Math.max(0, Math.min(1, (Number(input.value) - min) / Math.max(1, max - min)));
        pipTip.textContent = text;
        pipTip.style.left = Math.round(box.left - cardBox.left + ratio * box.width) + "px";
        pipTip.style.top = Math.round(box.top - cardBox.top - 28) + "px";
        pipTip.classList.add("ym-pip-tip-on");
      };
      const hideTip = () => pipTip.classList.remove("ym-pip-tip-on");
      // ---- seek row --------------------------------------
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
      controls.appendChild(seekRow);
      // While the user is dragging, the per-frame sync must not fight the thumb —
      // the same grace window the fullscreen seek uses.
      seek.addEventListener("pointerdown", () => { pipSeekUserAt = performance.now(); });
      seek.addEventListener("input", () => {
        pipSeekUserAt = performance.now();
        setRangeFill(seek);
        const pTip = player();
        const durMs = pTip && pTip.getDurationMs ? Number(pTip.getDurationMs()) : 0;
        const ms = (Number(seek.value) / 1000) * (Number.isFinite(durMs) ? durMs : 0);
        const totalS = Math.max(0, Math.round(ms / 1000));
        repositionTip(seek, Math.floor(totalS / 60) + ":" + String(totalS % 60).padStart(2, "0"));
      });
      seek.addEventListener("change", hideTip);
      seek.addEventListener("pointerup", hideTip);
      setRangeFill(seek);
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
      shuffle.appendChild(partSvg(doc, PART_ICON_SHUFFLE, "0 0 24 24"));
      shuffle.addEventListener("click", () => {
        if (kit && kit.clickPlayerButton) kit.clickPlayerButton("shuffle");
        pulsePipToggle(shuffle);
      });

      const prev = makeEl(doc, "button", "ym-pip-skip ym-pip-prev");
      prev.type = "button";
      prev.title = "Previous";
      prev.setAttribute("aria-label", "Previous");
      prev.appendChild(partSvg(doc, [{ tag: "path", attrs: { d: FS_SKIP_D, fill: "currentColor", "fill-rule": "nonzero" } }], "0 0 35 20"));
      prev.addEventListener("click", () => { const p = player(); if (p && p.previous) p.previous(); });

      const main = makeEl(doc, "button", "ym-pip-main");
      main.id = "ym-pip-toggle";
      main.type = "button";
      main.title = "Play / pause";
      main.setAttribute("aria-label", "Play or pause");
      main.appendChild(pipPlayMorphSvg(doc));
      main.addEventListener("click", () => { const p = player(); if (p && p.togglePlay) p.togglePlay(); });

      const next = makeEl(doc, "button", "ym-pip-skip ym-pip-next");
      next.type = "button";
      next.title = "Next";
      next.setAttribute("aria-label", "Next");
      next.appendChild(partSvg(doc, [{ tag: "path", attrs: { d: FS_SKIP_D, fill: "currentColor", "fill-rule": "nonzero" } }], "0 0 35 20"));
      next.addEventListener("click", () => { const p = player(); if (p && p.next) p.next(); });

      const repeat = makeEl(doc, "button", "ym-pip-opt ym-pip-repeat");
      repeat.id = "ym-pip-repeat";
      repeat.type = "button";
      repeat.title = "Repeat";
      repeat.setAttribute("aria-label", "Repeat");
      repeat.setAttribute("aria-pressed", "false");
      repeat.appendChild(partSvg(doc, PART_ICON_REPEAT, "0 0 24 24"));
      repeat.addEventListener("click", () => {
        if (kit && kit.clickPlayerButton) kit.clickPlayerButton("repeat");
        pulsePipToggle(repeat);
        animatePipLoop(repeat);
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
        // slider up jumped straight to max.
        if (p && typeof p.setVolume === "function") p.setVolume(Number(vol.value) / 100);
        setRangeFill(vol);
        repositionTip(vol, Math.round(Number(vol.value)) + "%");
      });
      vol.addEventListener("change", hideTip);
      vol.addEventListener("pointerup", hideTip);
      setRangeFill(vol);
      volWrap.appendChild(vol);
      pipVolumeEl = vol;

      bar.appendChild(shuffle);
      bar.appendChild(prev);
      bar.appendChild(main);
      bar.appendChild(next);
      bar.appendChild(repeat);
      bar.appendChild(volWrap);
      controls.appendChild(bar);
      root.appendChild(controls);
    }

    doc.body.appendChild(root);
  }

  function pipEl(id) {
    return pipDoc ? pipDoc.getElementById(id) : null;
  }

  /* ---- AMLL renderer ------------------------------------------------------
     When the panel draws a line-by-line track with the Apple-Music engine, the
     PiP runs that SAME engine instead of approximating it with the built-in
     renderer. The panel publishes which renderer owns the track
     ("lyrics:settings" / "lyrics:lines" -> renderer). Better Lyrics has no PiP
     implementation yet, so those tracks use the built-in renderer here.

     The engine is imported in the PAGE's realm (the same module URL the panel
     uses) and its element is appended into the PiP document, which adopts it.
     Importing in the PiP realm would need an inline module script, and the
     host page's CSP is not ours to rely on.
  */
  const AMLL_CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;
  let amllLastPos = 0;
  let amllUnavailable = false;

  function amllCssText() {
    const el = document.getElementById("ym-sl-amll-css");
    return el && el.textContent ? el.textContent : "";
  }

  function injectAmllCss() {
    if (!pipDoc || pipDoc.getElementById("ym-pip-amll-css")) return;
    const style = pipDoc.createElement("style");
    style.id = "ym-pip-amll-css";
    style.textContent = amllCssText();
    (pipDoc.head || pipDoc.documentElement).appendChild(style);
  }

  // A zero viewport is unrecoverable in this engine (it zeroes the default line
  // height, and the range test then fails for every line). The panel guards the
  // size the same way; mirror it so a resize can never write 0 back in.
  function guardAmllSize() {
    if (!amllPlayer) return;
    try {
      const guarded = [0, 0];
      let w = 0;
      let h = 0;
      Object.defineProperty(guarded, "0", {
        get() { return w; }, set(v) { if (v > 0) w = v; },
        enumerable: true, configurable: true,
      });
      Object.defineProperty(guarded, "1", {
        get() { return h; }, set(v) { if (v > 0) h = v; },
        enumerable: true, configurable: true,
      });
      amllPlayer.size = guarded;
    } catch (e) {}
  }

  function seedAmllSize() {
    if (!amllPlayer || !amllHost) return false;
    const r = amllHost.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    try {
      amllPlayer.size[0] = r.width;
      amllPlayer.size[1] = r.height;
    } catch (e) { return false; }
    return true;
  }

  function watchAmllSize() {
    if (amllSizeObserver || !pipWin || typeof pipWin.ResizeObserver === "undefined") return;
    amllSizeObserver = new pipWin.ResizeObserver(() => {
      if (!amllPlayer || !amllHost) return;
      const r = amllHost.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      if (amllPlayer.size[0] === r.width && amllPlayer.size[1] === r.height) return;
      amllPlayer.size[0] = r.width;
      amllPlayer.size[1] = r.height;
      try { amllPlayer.layoutCalculator.updateUnmeasuredHeights(amllPlayer.defaultLineHeight); } catch (e) {}
      try { if (typeof amllPlayer.calcLayout === "function") amllPlayer.calcLayout("resize"); } catch (e) {}
    });
    try { amllSizeObserver.observe(amllHost); } catch (e) {}
  }

  // Published line model -> the engine's LyricLine[] (times in ms).
  function amllAtoms(words) {
    const out = [];
    const list = words || [];
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (!w || !w.text) continue;
      const start = Number(w.startMs) || 0;
      const end = Math.max(start + 1, Number(w.endMs) || 0);
      out.push({ word: String(w.text), startTime: start, endTime: end });
      const next = list[i + 1];
      if (!next || !next.text) continue;
      if (w.isPartOfWord) continue;
      if (/\s$/.test(String(w.text)) || /^\s/.test(String(next.text))) continue;
      if (AMLL_CJK_RE.test(String(w.text)) || AMLL_CJK_RE.test(String(next.text))) continue;
      // The engine treats whitespace as its own atom; without it every word in
      // the line fuses into one element and the fill sweeps as a single block.
      out.push({ word: " ", startTime: end, endTime: end });
    }
    return out;
  }

  function amllLinesFromPublished() {
    const out = [];
    (lines || []).forEach((line) => {
      if (!line) return;
      out.push({
        words: amllAtoms(line.words && line.words.length
          ? line.words
          : [{ text: line.text, startMs: line.startMs, endMs: line.endMs }]),
        translatedLyric: "",
        romanLyric: "",
        startTime: Number(line.startMs) || 0,
        endTime: Math.max(Number(line.startMs) || 0, Number(line.endMs) || 0),
        isBG: false,
        isDuet: !!line.opposite,
      });
      (line.background || []).forEach((bg) => {
        if (!bg || !bg.words || !bg.words.length) return;
        out.push({
          words: amllAtoms(bg.words),
          translatedLyric: "",
          romanLyric: "",
          startTime: Number(bg.startMs) || 0,
          endTime: Math.max(Number(bg.startMs) || 0, Number(bg.endMs) || 0),
          isBG: true,
          isDuet: false,
        });
      });
    });
    return out;
  }

  // Tap a line to jump the player there, exactly like the built-in renderer.
  // The engine renders its own DOM, so Aurora's panel-side click handling never
  // sees these nodes. It does dispatch a `line-click` LyricLineMouseEvent on the
  // player object though, which is the supported hook. `line.startTime` is a lyric
  // timestamp; seekToLyricTime() adds the active offset back when seeking, so a
  // manual or pause-sync offset lands on the same line it draws as active.
  function bindAmllSeek(engine) {
    if (!engine || typeof engine.addEventListener !== "function") return;
    // DomLyricPlayer extends EventTarget and dispatches the event on ITSELF
    // (this.dispatchEvent(evt) in onMouseEventHandler), not on its DOM element.
    // Listening on getElement() therefore never fired and a click did nothing.
    if (engine.__ymPipSeekBound) return;
    engine.__ymPipSeekBound = true;
    engine.addEventListener("line-click", (event) => {
      // event.line is the engine's LyricLineEl, not the raw line data; its
      // getLine() is the object carrying startTime. Accept both shapes so a
      // future engine build that hands over the data directly still works.
      const line = event && event.line;
      const data = line && typeof line.getLine === "function" ? line.getLine() : line;
      if (!data) return;
      const at = Number(data.startTime);
      if (!Number.isFinite(at) || at < 0) return;
      event.preventDefault();
      seekToLyricTime(at);
    });
  }

  function syncAmllCredits() {
    if (!amllPlayer || !amllHost) return;
    if (amllCreditsEl) { try { amllCreditsEl.remove(); } catch (e) {} amllCreditsEl = null; }
    const footer = buildCreditsFooter();
    if (!footer) return;
    amllCreditsEl = footer;
    let slot = null;
    try { slot = amllPlayer.getBottomLineElement(); } catch (e) {}
    (slot || amllHost).appendChild(footer);
  }

  function syncAmllLines() {
    if (!amllPlayer) return;
    try {
      amllPlayer.setLyricLines(amllLinesFromPublished(), Math.max(0, amllLastPos));
      syncAmllCredits();
    } catch (e) {
      alWarn("PiP: could not give the lyrics to AMLL.", e);
    }
  }

  /* The engine's mask position is computed from --amll-player-time, which the
     host must write (the bundled build deliberately does not write it itself).
     Scope it to the enabled lines plus the next one so a frame does not
     invalidate every word in the window. An outgoing line keeps its last value
     for longer than the theme's alpha easing, or its fill would snap back to
     the unsung end as it fades. */
  function holdAmllTime(el, t) {
    const pending = amllTimeHoldTimers.get(el);
    if (pending) clearTimeout(pending);
    try { el.style.setProperty("--amll-player-time", String(t)); } catch (e) {}
    const timer = setTimeout(() => {
      amllTimeHoldTimers.delete(el);
      try { el.style.removeProperty("--amll-player-time"); } catch (e) {}
    }, AMLL_TIME_HOLD_MS);
    amllTimeHoldTimers.set(el, timer);
  }

  function releaseAmllTime(el) {
    const pending = amllTimeHoldTimers.get(el);
    if (!pending) return;
    clearTimeout(pending);
    amllTimeHoldTimers.delete(el);
  }

  function scopeAmllTime(t) {
    try {
      const groups = amllPlayer.currentLyricGroups || [];
      const hosts = [];
      let lastEnabled = -1;
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        if (!group || !group.mainLine || !group.element) continue;
        let enabled = false;
        try { enabled = !!group.mainLine.isEnabled; } catch (e) {}
        if (!enabled) continue;
        hosts.push(group.element);
        lastEnabled = i;
      }
      for (let i = lastEnabled + 1; i < groups.length; i++) {
        try {
          if (groups[i].mainLine.getLine().startTime > t) { hosts.push(groups[i].element); break; }
        } catch (e) {}
      }
      for (const el of amllTimeHosts) {
        if (hosts.indexOf(el) === -1) holdAmllTime(el, t);
      }
      for (const el of hosts) {
        releaseAmllTime(el);
        try { el.style.setProperty("--amll-player-time", String(t)); } catch (e) {}
      }
      amllTimeHosts = hosts;
    } catch (e) {}
  }

  /* The engine only retires a finished line when the next one starts in the same
     tick, so a line whose window has passed can stay fully lit. Retire anything
     the playhead has left, and re-point the scroll once (not per line, which
     walks the camera a line per frame). */
  function retireAmllLines() {
    try {
      const groups = amllPlayer.currentLyricGroups || [];
      const t = amllPlayer.getCurrentTime();
      let targetIdx = -1;
      for (let i = 0; i < groups.length; i++) {
        try {
          const ln = groups[i].mainLine.getLine();
          if (t >= ln.startTime && t <= ln.endTime) { targetIdx = i; break; }
          if (ln.startTime > t) { targetIdx = i; break; }
        } catch (e) {}
      }
      let retired = false;
      for (const group of groups) {
        if (!group || !group.mainLine) continue;
        let s = -1;
        let e = -1;
        try {
          const ln = group.mainLine.getLine();
          s = ln.startTime;
          e = ln.endTime;
        } catch (err) { continue; }
        if (t >= s && t <= e) continue;
        let enabled = false;
        try { enabled = !!group.mainLine.isEnabled; } catch (err) {}
        if (!enabled) continue;
        // disable() can be async; swallow a rejection so one retired line cannot
        // become an unhandled rejection every frame.
        try {
          const p = group.mainLine.disable();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch (err) {}
        if (group.bgLine) {
          try {
            const p = group.bgLine.disable();
            if (p && typeof p.catch === "function") p.catch(() => {});
          } catch (err) {}
        }
        try {
          const tc = amllPlayer.timelineController;
          const idx = groups.indexOf(group);
          if (tc && idx !== -1 && tc.highlightedGroupsSet &&
              typeof tc.highlightedGroupsSet.delete === "function") {
            tc.highlightedGroupsSet.delete(idx);
          }
        } catch (err) {}
        retired = true;
      }
      if (retired && targetIdx !== -1) {
        try {
          const tc = amllPlayer.timelineController;
          if (tc && tc.snapshot && tc.snapshot.scrollToIndex !== targetIdx) {
            tc.snapshot.scrollToIndex = targetIdx;
            if (typeof amllPlayer.calcLayout === "function") amllPlayer.calcLayout("playback-tick");
          }
        } catch (err) {}
      }
    } catch (e) {}
  }

  // The engine reports a manual scroll on scrollState.isAutoAlignSuspended. The
  // PiP's jump pill only listened to the built-in scroll box, so Apple-style
  // lyrics could be scrolled away with no way back. Mirror the engine's flag
  // onto the same pill; reading the class back keeps any other hide respected.
  function syncAmllJumpButton() {
    const button = pipEl("ym-pip-jump");
    if (!button || !amllPlayer) return;
    let suspended = false;
    try { suspended = !!amllPlayer.scrollState.isAutoAlignSuspended; } catch (e) {}
    if (button.classList.contains("visible") === suspended) return;
    setJumpVisible(suspended);
  }

  function amllDrive(posMs, paused) {
    if (!amllPlayer || !Number.isFinite(posMs)) return;
    const now = performance.now();
    const dt = amllLastFrameAt ? Math.min(64, Math.max(0, now - amllLastFrameAt)) : 16;
    amllLastFrameAt = now;
    try {
      const wantPlaying = !paused;
      if (amllPlayer.getIsPlaying() !== wantPlaying) {
        if (wantPlaying) amllPlayer.resume();
        else amllPlayer.pause();
      }
      if (!(amllPlayer.size[1] > 0)) seedAmllSize();
      amllLastPos = posMs;
      amllPlayer.setCurrentTime(posMs, false);
      amllPlayer.update(dt);
      scopeAmllTime(posMs);
      retireAmllLines();
      syncAmllJumpButton();
    } catch (e) {}
  }

  function dropAmll() {
    amllGen++;
    if (amllSizeObserver) { try { amllSizeObserver.disconnect(); } catch (e) {} amllSizeObserver = null; }
    for (const el of amllTimeHosts) releaseAmllTime(el);
    amllTimeHosts = [];
    for (const el of amllTimeHoldTimers.keys()) releaseAmllTime(el);
    if (amllPlayer) { try { amllPlayer.dispose(); } catch (e) {} }
    amllPlayer = null;
    amllCreditsEl = null;
    if (amllHost && amllHost.parentNode) amllHost.parentNode.removeChild(amllHost);
    amllHost = null;
    amllLastFrameAt = 0;
    if (pipDoc && pipDoc.body) pipDoc.body.classList.remove("amll-active");
  }

  async function ensureAmll() {
    if (!pipDoc || !pipWin || pipWin.closed) return;
    if (amllPlayer) return;
    if (amllUnavailable) return;
    const gen = ++amllGen;
    // The stylesheet is injected by the panel when it starts the engine, which
    // can land a beat after the lyrics payload. Wait for it, bounded.
    for (let i = 0; i < 30; i++) {
      if (amllCssText()) break;
      await new Promise((r) => setTimeout(r, 100));
      if (gen !== amllGen || !pipWin || pipWin.closed) return;
    }
    if (!amllCssText()) {
      // The panel is not running the engine for this track after all. Keep the
      // built-in renderer rather than drawing unstyled engine output.
      amllUnavailable = true;
      rendererMode = "spicy";
      const box = pipEl("ym-pip-lines");
      if (box) box.style.display = "";
      buildLinesBox();
      return;
    }
    try {
      if (!amllModulePromise) amllModulePromise = import(AMLL_CORE_URL);
      const mod = await amllModulePromise;
      if (gen !== amllGen || !pipWin || pipWin.closed) return;
      if (!mod || typeof mod.LyricPlayer !== "function") throw new Error("LyricPlayer missing");
      injectAmllCss();
      const stage = pipEl("ym-pip-stage");
      if (!stage) return;
      const host = pipDoc.createElement("div");
      host.id = "ym-sl-amll-host";
      stage.appendChild(host);
      amllHost = host;
      const engine = new mod.LyricPlayer();
      // Same configuration the panel uses for this engine. The calc-mask path
      // is the one that tracks the media clock on every frame; the WAAPI mask
      // path can park on a stale play-state.
      engine.supportMaskImage = false;
      engine.setEnableSpring(true);
      engine.setWordFadeWidth(0.5);
      engine.setAlignPosition(0.42);
      engine.setOverscanPx(150);
      engine.getElement().style.height = "100%";
      host.appendChild(engine.getElement());
      amllPlayer = engine;
      bindAmllSeek(engine);
      guardAmllSize();
      seedAmllSize();
      watchAmllSize();
      pipDoc.body.classList.add("amll-active");
      const box = pipEl("ym-pip-lines");
      if (box) box.style.display = "none";
      syncAmllLines();
      amllLastFrameAt = 0;
    } catch (e) {
      alWarn("PiP: AMLL engine unavailable; using the built-in renderer.", e);
      amllUnavailable = true;
      dropAmll();
      rendererMode = "spicy";
      const box = pipEl("ym-pip-lines");
      if (box) box.style.display = "";
      buildLinesBox();
    }
  }

  // <html data-*> markers: the cheapest way to observe the PiP from the tab's
  // own page, where the bridge / devtools can see them (the PiP document has no
  // content script of its own).
  function markPipState() {
    try {
      const root = document.documentElement;
      root.dataset.ymPipRenderer = rendererMode;
      root.dataset.ymPipAmll = amllPlayer
        ? String((amllPlayer.currentLyricGroups || []).length)
        : "0";
      const mirror = pipEl("ym-pip-video");
      root.dataset.ymPipVideo = mirror && mirror.srcObject ? "1" : "0";
      root.dataset.ymPipKawarp = kawarp ? (kawarpVideoEl ? "video" : "art") : "0";
    } catch (e) {}
  }

  // Flip the PiP between the two renderers. Returns true when the owner changed.
  function setRenderer(mode) {
    const next = mode === "amll" ? "amll" : "spicy";
    const changed = next !== rendererMode;
    rendererMode = next;
    const box = pipEl("ym-pip-lines");
    if (next === "amll") {
      if (box) box.style.display = "none";
      setJumpVisible(false);
      ensureAmll();
      markPipState();
      return changed;
    }
    dropAmll();
    if (box) box.style.display = "";
    markPipState();
    return changed;
  }

  /* ---- music-video mirror -------------------------------------------------
     A music video sits on top of the window with the title under it, or in its
     own left column when the window is wide enough (see updatePipLayout). The
     TAB's <video> is mirrored with captureStream() rather than moved: moving a
     media element to another document makes YTM lose the playback it owns, and
     it would also fight the fullscreen overlay for the same node. A mirror is
     one extra composite and keeps every existing behaviour intact.
  */
  function findLiveVideo() {
    const video = document.querySelector("ytmusic-player video") ||
      document.querySelector("#movie_player video");
    // A song with no video still leaves an empty element behind, so require real
    // frame dimensions - the same readiness test the panel uses.
    return video && video.videoWidth > 0 ? video : null;
  }

  // Side-by-side needs BOTH: a column wide enough for a useful picture, and
  // enough height for the transport card plus a readable lyric column. The bar
  // is lower than the stacked layout's because the picture no longer borrows
  // the lyrics' height.
  const WIDE_MIN_WIDTH = 640;
  const WIDE_MIN_HEIGHT = 360;
  // Below this even a side-by-side picture is pointless.
  const VIDEO_MIN_HEIGHT = 300;
  // A STACKED picture steals its height from the lyrics, and how much it steals
  // depends on the WIDTH (16:9), so no fixed window height can know when it stops
  // being worth it. Measure instead: under this the stage is too short for a
  // couple of lines, and the picture is dropped entirely (thumbnail returns).
  const MIN_STAGE_HEIGHT = 120;
  // A few px of hysteresis around that floor: the header grows slightly when the
  // picture is on (larger title), so a decision that re-measured at the exact
  // boundary could flip itself. Hide below the floor, come back only with room
  // to spare.
  const LAYOUT_HYSTERESIS = 10;

  function stopVideoMirror() {
    const mirror = pipEl("ym-pip-video");
    if (mirror) {
      try { mirror.pause(); } catch (e) {}
      mirror.srcObject = null;
      mirror.classList.remove("live");
    }
    // Capturing keeps the tab's decoder feeding a second consumer; stop the
    // tracks explicitly or they outlive the window.
    if (pipVideoStream && typeof pipVideoStream.getTracks === "function") {
      pipVideoStream.getTracks().forEach((track) => { try { track.stop(); } catch (e) {} });
    }
    pipVideoSource = null;
    pipVideoStream = null;
    updatePipLayout();
  }

  // Decide how the window draws itself from its CURRENT size plus whether a
  // picture exists:
  //   off     - too short for a stacked picture: no video at all
  //   stacked - video row on top, title under it, lyrics below (narrow window)
  //   wide    - video on the LEFT, title + lyrics in a RIGHT column
  // Only class toggles: every rule lives in CSS, so there is no per-frame cost.
  function updatePipLayout() {
    if (!pipWin || pipWin.closed || !pipDoc) return;
    const root = pipEl("ym-pip-root");
    const mirror = pipEl("ym-pip-video");
    if (!root || !mirror) return;
    const hasVideo = !!mirror.srcObject;
    const w = pipWin.innerWidth || 0;
    const h = pipWin.innerHeight || 0;
    const wideFits = w >= WIDE_MIN_WIDTH && h >= WIDE_MIN_HEIGHT;
    let showVideo = hasVideo && h >= VIDEO_MIN_HEIGHT;
    let wide = showVideo && wideFits;
    // Stacked only: decide from the geometry the picture WOULD take, without
    // showing it. The old probe added `video-on`, measured the shrunken stage,
    // then removed it - and since the shrunken stage was measured after the
    // class went on, the answer depended on the previous frame. Near the
    // threshold every sync tick re-decided the opposite way and the video faded
    // in and out forever. These numbers are state-independent: the board and
    // head heights do not depend on the picture, and its 16:9 height follows the
    // board's width (capped by the CSS max-height: 50vh).
    if (showVideo && !wide) {
      const board = pipEl("ym-pip-board");
      const head = pipEl("ym-pip-head");
      const boardBox = board ? board.getBoundingClientRect() : null;
      const boardH = boardBox ? boardBox.height : 0;
      const boardW = boardBox ? boardBox.width : 0;
      // +10 is the header's margin-bottom; +12 is the picture's own.
      const headH = head ? head.getBoundingClientRect().height + 10 : 0;
      const videoH = Math.min(boardW * 9 / 16, h * 0.5);
      // The class reflects the PREVIOUS decision (it is applied after this
      // block), which is exactly the state the hysteresis band needs.
      const floor = root.classList.contains("video-on")
        ? MIN_STAGE_HEIGHT
        : MIN_STAGE_HEIGHT + LAYOUT_HYSTERESIS;
      if (boardH > 0 && boardH - headH - 12 - videoH < floor) {
        showVideo = false;
        wide = false;
      }
    }
    // Apply the decision in ONE step, after it is made. Applying `video-on` first
    // and probing what was left was the feedback loop: hide/show flipped every
    // time the result was measured.
    root.classList.toggle("video-on", showVideo);
    root.classList.toggle("ym-pip-wide", wide);
    // A hidden mirror would keep decoding behind the thumbnail. Pause it; the
    // live stream resumes by itself when the window is big enough again. This
    // never touches the tab's real player.
    if (showVideo) {
      if (mirror.paused) mirror.play().catch(() => {});
    } else if (!mirror.paused) {
      try { mirror.pause(); } catch (e) {}
    }
    // Tab-side marker like ymPipRenderer, so the layout the PiP chose can be
    // observed from the page without reaching into the PiP document.
    try {
      document.documentElement.dataset.ymPipLayout = wide ? "wide" : showVideo ? "stacked" : "off";
    } catch (e) {}
  }

  function syncVideoPane(force) {
    if (!pipWin || pipWin.closed || !pipDoc) return;
    const now = performance.now();
    if (!force && now - pipVideoCheckedAt < 500) return;
    pipVideoCheckedAt = now;
    const mirror = pipEl("ym-pip-video");
    const root = pipEl("ym-pip-root");
    if (!mirror || !root) return;
    const live = findLiveVideo();
    if (!live) { stopVideoMirror(); syncKawarpSource(); return; }
    const videoTrack = pipVideoStream && pipVideoStream.getVideoTracks
      ? pipVideoStream.getVideoTracks()[0]
      : null;
    // Re-capture when the element is swapped, and also when its tracks have
    // ended (a track change can kill the capture while leaving the element in
    // place, which would otherwise leave a frozen last frame on screen).
    const stale = !!pipVideoStream && (!videoTrack || videoTrack.readyState === "ended");
    if (pipVideoSource !== live || stale) {
      stopVideoMirror();
      try {
        if (typeof live.captureStream === "function") {
          pipVideoStream = live.captureStream();
          mirror.srcObject = pipVideoStream;
          pipVideoSource = live;
          mirror.play().catch(() => {});
        }
      } catch (e) {
        pipVideoSource = null;
        pipVideoStream = null;
      }
    }
    updatePipLayout();
    syncKawarpSource();
    markPipState();
  }

  // ---- kawarp backdrop -----------------------------------------------------
  let kawarp = null;
  let kawarpArtUrl = null;
  let kawarpVideoEl = null;
  // A track change can blank videoWidth for a tick or two while the next source
  // loads. Switching on the first missing tick would flash the cover-art fluid
  // in the middle of a music video, so the video has to stay gone for a while.
  let kawarpVideoGoneTicks = 0;
  let kawarpResizeObserver = null;
  let kawarpSeq = 0;
  // The module import is async, so several sync ticks can land before the first
  // instance exists. Without this, each one would construct on the SAME canvas;
  // the extras never start but still take the WebGL context. Holds the seq of
  // the creation in flight; stopKawarp() invalidates it by bumping kawarpSeq.
  let kawarpPendingSeq = 0;

  // A music video feeds the fluid with its live frames, exactly like the panel's
  // fullscreen backdrop: a small colour map sampled at 30fps reacts to the
  // picture instead of a still cover. Tracks without a video keep the artwork.
  const KAWARP_VIDEO_OPTIONS = {
    sampleWidth: 72,
    sampleHeight: 128,
    smoothing: 120,
    frameRate: 30,
  };

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
      // Assigning width/height CLEARS the drawing buffer. Doing the redraw in
      // the same task means the cleared buffer is never composited; otherwise a
      // resize tick (or a burst of them) showed the empty canvas as a black
      // flash until the next animation frame painted.
      if (kawarp && typeof kawarp.renderFrame === "function") {
        try { kawarp.renderFrame(); } catch (e) {}
      }
    }
  }

  function startKawarp(artUrl, videoEl) {
    const canvas = pipEl("ym-pip-kawarp");
    if (!canvas || !KAWARP_CORE_URL) return;
    const seq = ++kawarpSeq;
    kawarpPendingSeq = seq;
    sizeKawarp();
    getKawarpConstructor().then(async (Kawarp) => {
      if (seq !== kawarpSeq || !pipWin || pipWin.closed) return;
      kawarp = new Kawarp(canvas, KAWARP_OPTIONS);
      let live = false;
      if (videoEl) {
        // loadVideo throws for a source it cannot follow; that must not cost the
        // backdrop, so fall through to the artwork instead of failing shut.
        try {
          kawarp.loadVideo(videoEl, KAWARP_VIDEO_OPTIONS);
          live = true;
        } catch (e) {}
      }
      if (live) {
        kawarpVideoEl = videoEl;
        kawarpArtUrl = null;
      } else if (artUrl) {
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
      if (kawarpPendingSeq === seq) kawarpPendingSeq = 0;
      alWarn("PiP Kawarp failed:", error);
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
    kawarpVideoEl = null;
    kawarpVideoGoneTicks = 0;
  }

  function kawarpArtworkUrl() {
    const p = player();
    const track = p && p.getTrack ? p.getTrack() : null;
    return track && track.artworkUrl ? hiResArt(track.artworkUrl) : "";
  }

  // Keep ONE Kawarp alive and swap only what feeds it, so a track change or a
  // video appearing is a load, never a restart (a second canvas would stack and
  // the older one would paint over the new source). The live video wins while it
  // exists; without one the artwork is the source.
  function syncKawarpSource() {
    const videoEl = findLiveVideo();
    const artUrl = kawarpArtworkUrl();
    if (!kawarp) {
      // 0 is "nothing in flight": kawarpSeq starts at 0 too, so a plain equality
      // would refuse to ever start the first backdrop.
      if (kawarpPendingSeq && kawarpPendingSeq === kawarpSeq) return;
      if (videoEl || artUrl) startKawarp(artUrl, videoEl);
      return;
    }
    if (videoEl) {
      kawarpVideoGoneTicks = 0;
      if (videoEl === kawarpVideoEl) return;
      try {
        kawarp.loadVideo(videoEl, KAWARP_VIDEO_OPTIONS);
        kawarpVideoEl = videoEl;
        kawarpArtUrl = null;
      } catch (e) {
        // Not samplable: stay on whatever was already drawing.
      }
      return;
    }
    if (kawarpVideoEl) {
      // The video ended, or an audio-only track replaced it. Wait out a couple
      // of checks first so a track change cannot strobe the backdrop.
      if (++kawarpVideoGoneTicks < 3) return;
      kawarpVideoGoneTicks = 0;
      kawarpVideoEl = null;
      try { kawarp.unloadVideo(); } catch (e) {}
      if (artUrl) {
        kawarpArtUrl = artUrl;
        try { kawarp.loadImage(artUrl); } catch (e) {}
      }
      return;
    }
    if (artUrl && artUrl !== kawarpArtUrl) {
      kawarpArtUrl = artUrl;
      try { kawarp.loadImage(artUrl); } catch (e) {}
    }
  }

  // ---- rendering -----------------------------------------------------------
  // Replace a header string and flash it in. Only on an actual change, so the
  // per-track refresh cannot make the title twitch every time it runs.
  function swapText(el, text) {
    if (!el) return;
    const next = text == null ? "" : String(text);
    if (el.textContent === next) return;
    el.textContent = next;
    try {
      el.classList.remove("swap");
      void el.offsetWidth;   // restart the animation from its first frame
      el.classList.add("swap");
    } catch (e) {}
  }

  function setHeader() {
    const artist = pipEl("ym-pip-artist");
    if (!artist) return;
    const p = player();
    const track = p && p.getTrack ? p.getTrack() : null;
    const titleEl = pipDoc.querySelector(".ym-pip-title");
    swapText(titleEl, (track && track.title) || "Aurora Lyrics");
    swapText(artist, (track && track.artist) || "");
    const art = pipEl("ym-pip-art");
    if (art) {
      const url = (track && track.artworkUrl) || "";
      // Only touch the src when it actually changes: re-assigning it restarts the
      // image load and would flicker the thumbnail on every tick.
      if (url && art.getAttribute("src") !== url) art.setAttribute("src", url);
      art.classList.toggle("has-art", !!url);
    }
    syncKawarpSource();
  }

  // One line, in the panel's exact markup. Plain syllables become .word; ones the
  // panel deems letter-capable become .letterGroup > .letter, using the panel's
  // own per-letter timing (letterEnd = end - 250ms, split evenly across chars).
  // Each element gets its own spring set from the panel's kit, mirroring the
  // panel's structure: a word-level store, plus a letter store per character.
  // The fullscreen player plays one 0.52s glow pulse when shuffle or repeat is
  // switched on. The PiP gets the same cue through the same class name, so the
  // two surfaces cannot drift apart again.
  // The fullscreen chip runs its loop-rail animation by holding `is-looping` for
  // one animation length; the same class drives the same keyframes here.
  function animatePipLoop(el) {
    if (!el || !el.classList) return;
    el.classList.remove("is-looping");
    void el.offsetWidth;
    el.classList.add("is-looping");
    setTimeout(() => { try { el.classList.remove("is-looping"); } catch (e) {} }, 640);
  }

  function pulsePipToggle(el) {
    if (!el || !el.classList) return;
    el.classList.remove("is-glowing");
    // Read the width so a second click restarts the animation instead of being
    // swallowed as "class already present".
    void el.offsetWidth;
    el.classList.add("is-glowing");
    setTimeout(() => { try { el.classList.remove("is-glowing"); } catch (e) {} }, 560);
  }

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
      // fix.
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

  const PROVIDER_URLS = {
    "Spicy Lyrics": "https://spicylyrics.org/",
    "Unison": "https://unison.boidu.dev/",
    "LRCLIB": "https://lrclib.net/",
  };
  const PROVIDER_ICON_FILES = {
    "Apple Music": "provider-apple-music.png",
    "Spicy Lyrics": "provider-spicy-lyrics.png",
    "Unison": "provider-unison.svg",
    "Aurora Community": "provider-aurora.png",
    "LRCLIB": "provider-lrclib.png",
  };

  function buildProviderIcon(provider) {
    const file = PROVIDER_ICON_FILES[provider];
    if (!file || !SCRIPT_URL) return null;
    let src = "";
    try { src = new URL(file, SCRIPT_URL).href; } catch (e) { return null; }
    const img = makeEl(pipDoc, "img", "ym-sl-provider-icon");
    img.src = src;
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    img.width = 17;
    img.height = 17;
    img.decoding = "async";
    img.addEventListener("error", () => { try { img.remove(); } catch (e) {} });
    return img;
  }

  function buildProviderRow(provider) {
    const row = makeEl(pipDoc, "div", "ym-sl-provider");
    row.appendChild(makeEl(pipDoc, "span", "ym-sl-provider-label", "Provided by"));
    const icon = buildProviderIcon(provider);
    if (icon) row.appendChild(icon);
    const url = PROVIDER_URLS[provider] || "";
    if (url) {
      const link = makeEl(pipDoc, "a", "ym-sl-provider-name", provider);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      row.appendChild(link);
    } else {
      row.appendChild(makeEl(pipDoc, "span", "ym-sl-provider-name", provider));
    }
    return row;
  }

  // Same up-right arrow as the panel's person credits; PiP copies the panel
  // stylesheet, so the tag styling travels with it.
  function creditArrow() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = pipDoc.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "ym-sl-uploader-arrow");
    svg.setAttribute("width", "9");
    svg.setAttribute("height", "9");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = pipDoc.createElementNS(NS, "path");
    path.setAttribute("d", "M7 17 17 7M9 7h8v8");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2.2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  function formatCreditDate(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const date = new Date(seconds > 1e12 ? seconds : seconds * 1000);
    if (Number.isNaN(date.getTime())) return "";
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);
    } catch (e) {
      return "";
    }
  }

  function buildPersonRow(label, person) {
    const row = makeEl(pipDoc, "div", "ym-sl-uploader");
    const level = Number(person && person.level);
    const hasLevel = Number.isFinite(level) && level > 0;
    if (hasLevel) row.setAttribute("data-level", String(level));
    row.appendChild(makeEl(pipDoc, "span", "ym-sl-uploader-label", label));
    const link = makeEl(pipDoc, "a", "ym-sl-uploader-link");
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (person && person.url) {
      link.href = person.url;
      link.title = `Open ${person.username || "maker"}'s ${person.profileLabel || "Aurora"} profile`;
    }
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
    if (person && person.url) link.appendChild(creditArrow());
    if (!person || !person.url) link.classList.add("no-link");
    row.appendChild(link);
    return row;
  }

  function isSameCreditPerson(a, b) {
    if (!a || !b) return false;
    if (a.id && b.id) return a.id === b.id;
    return !!a.username && a.username === b.username;
  }

  // Mirrors the panel's three-cell rail, because the PiP copies the panel's
  // stylesheet and the two must not drift apart.
  function buildCreditsFooter() {
    if (!songwriters.length && !(attribution && (attribution.provider || attribution.uploader || attribution.maker))) return null;
    const footer = makeEl(pipDoc, "div", "ym-sl-credits");
    const hasWriters = songwriters.length > 0;
    if (attribution && attribution.provider === "Unison") {
      footer.classList.add("ym-sl-credits--unison");
      if (!hasWriters) footer.classList.add("ym-sl-credits--no-writers");
    } else if (attribution && attribution.provider === "Spicy Lyrics") {
      footer.classList.add("ym-sl-credits--spicy");
      if (SCRIPT_URL) {
        try {
          footer.style.setProperty(
            "--ym-sl-spicy-banner-image",
            `url("${new URL("spicy-lyrics-banner.png", SCRIPT_URL).href}")`
          );
        } catch (e) {}
      }
    } else if (attribution && attribution.provider === "Aurora Community") {
      // Same rail treatment as Spicy; the extra class is the Aurora hook.
      footer.classList.add("ym-sl-credits--spicy", "ym-sl-credits--aurora");
      const brand = buildProviderIcon("Aurora Community");
      if (brand) {
        brand.classList.add("ym-sl-credit-brand");
        footer.appendChild(brand);
      }
    } else if (attribution && attribution.provider === "Apple Music") {
      // Apple has no contributor rows; the provider mark leads the rail.
      footer.classList.add("ym-sl-credits--apple");
      const brand = buildProviderIcon("Apple Music");
      if (brand) {
        brand.classList.add("ym-sl-credit-brand");
        footer.appendChild(brand);
      }
    } else if (attribution && attribution.provider === "LRCLIB") {
      // LRCLIB has no contributor rows; reuse Apple's icon-led layout with
      // the flat deep-blue LRCLIB skin.
      footer.classList.add("ym-sl-credits--apple", "ym-sl-credits--lrclib");
    }
    if (songwriters.length) {
      const box = makeEl(pipDoc, "div", "ym-sl-credit-box ym-sl-credit-writers");
      box.appendChild(makeEl(pipDoc, "div", "ym-sl-credits-label", "Written by"));
      const names = makeEl(pipDoc, "div", "ym-sl-credits-names");
      songwriters.forEach((name, index) => {
        if (index) names.appendChild(pipDoc.createTextNode(", "));
        names.appendChild(makeEl(pipDoc, "span", "ym-sl-credits-name", name));
      });
      box.appendChild(names);
      footer.appendChild(box);
    }
    if (attribution && attribution.provider) {
      const box = makeEl(pipDoc, "div", "ym-sl-credit-box ym-sl-credit-provider");
      box.appendChild(buildProviderRow(attribution.provider));
      const submitted = formatCreditDate(attribution.uploader && attribution.uploader.createdAt);
      if (submitted && hasWriters) {
        box.appendChild(makeEl(pipDoc, "span", "ym-sl-provider-date", submitted));
      }
      footer.appendChild(box);
      if (submitted && !hasWriters) {
        footer.appendChild(makeEl(pipDoc, "span", "ym-sl-provider-date", submitted));
      }
    }
    if (attribution && (attribution.uploader || attribution.maker)) {
      const box = makeEl(pipDoc, "div", "ym-sl-credit-box ym-sl-credit-people");
      // Self-uploads suppress the maker row; preserve its profile URL on the
      // one credit that remains.
      const uploader = attribution.uploader && isSameCreditPerson(attribution.maker, attribution.uploader)
        ? Object.assign({}, attribution.uploader, {
            url: attribution.uploader.url || attribution.maker.url,
          })
        : attribution.uploader;
      if (attribution.maker && !isSameCreditPerson(attribution.maker, attribution.uploader)) {
        box.appendChild(buildPersonRow("Made by", attribution.maker));
      }
      if (uploader) box.appendChild(buildPersonRow("Uploaded by", uploader));
      footer.appendChild(box);
    }
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
    if (footer) content.appendChild(footer);
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

      // Non-simple mode: the springs are real, so "settled" genuinely means this
      // word has nothing left to write. (The old activation clause here existed
      // for the sharpened Simple look, which the PiP no longer applies to a Spicy
      // track — see applyScrollSettings.)
      const selfAwake =
        stateChanged ||
        kit.storeNeedsAnimation(rec.springs);
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
    // UNPROMOTED, which is the pixel-stepping reports. The
    // panel's stylesheet (copied in wholesale) already carries the
    // .line.ym-sl-animating .word/.letter rules, so toggling the class is all it
    // takes — and it comes off the moment every spring on the line has slept.
    // Promote EVERY line that owns an awake word this frame. It cannot be a single
    // "active line" toggle: background vocals render as their own .line.bg-line
    // siblings, so they need their own promotion or they animate unpromoted and
    // stay steppy while the lead line is smooth. Clearing is
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
      // OVERRIDE PASS - the clause the PiP was missing, and the reason its
      // long-word glow looked old. The proximity pass above is directionless: it
      // lights the letters the playhead has NOT REACHED exactly as hard as the
      // ones it just left (at distance 1 the falloff is 1/(1+0.9) = 0.526, and
      // the spline peaks at 1.433, so an unsung neighbour sits at ~0.75 -> a
      // 13px halo at full opacity). The panel pins those letters to rest in
      // 18-animation ("Upstream LyricsAnimator.ts:1092-1102"), which makes the
      // glow TRAIL the karaoke point as a travelling pulse. Without it the PiP
      // smeared a broad bloom ~2 letters ahead of the sung one - the old look.
      if (state === "NotSung") {
        targetScale = restingScale;
        targetYOffset = restingYOffset;
        targetGlow = restingGlow;
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
    // NOT p.isPaused(): YTMod's flag lags the element by a frame or more and
    // reports "playing" on players that have already stopped, which left the
    // PiP's play/pause glyph stuck on the pause bars after a pause. The <video>
    // element's own flag is the truth; pick the real one, not a hover preview or
    // an ad surface.
    const videoEl = [...document.querySelectorAll("video")]
      .find((v) => v.duration > 1 && v.readyState >= 2) || null;
    const paused = videoEl
      ? videoEl.paused
      : (p.isPaused ? p.isPaused() : false);
    // The music-video mirror is polled, not built per frame: attaching a stream
    // is cheap but not free, and the video element YTM recycles only changes on
    // a track change.
    syncVideoPane(false);
    if (rendererMode === "amll" && amllPlayer) {
      // The engine owns the lyric surface: it translates and masks its own
      // lines, including the camera and the credits in its bottom slot.
      amllDrive(lyricPos, paused);
    } else {
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
      // The panel evaluates every model line from its own StartTime/EndTime each
      // frame. Do the same here: background-vocal intervals are independent of
      // their lead line, and a late bg must keep filling while the next lead is
      // already active. This replaces the old "only active primary line" shortcut.
      for (let s = 0; s < lineSets.length; s++) {
        if (staticLyrics) continue;
        if (kit) animateLine(s, lyricPos, dt);
        else if (s === idx) fillWithoutKit(s, lyricPos);
      }
    }
    const toggle = pipEl("ym-pip-toggle");
    if (toggle) pipSetPlayMorph(toggle, paused ? "play" : "pause", false);
    syncPipControls(p, pos);
  }

  // Paint the played portion of a range with the shared fill gradient.
  function setRangeFill(el) {
    if (!el) return;
    const min = Number(el.min) || 0;
    const max = Number(el.max) || 100;
    const value = Number(el.value) || 0;
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    el.style.setProperty("--ym-pip-fill", Math.max(0, Math.min(100, pct)).toFixed(2) + "%");
  }

  function pipFormatClock(ms) {
    const total = Math.max(0, Math.floor(Number(ms) / 1000));
    return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
  }

  // Seek / volume / shuffle / repeat, refreshed each frame.
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
        setRangeFill(pipSeekEl);
      }
    }
    if (pipVolumeEl && p && typeof p.getVolume === "function" && pipDoc.activeElement !== pipVolumeEl) {
      // getVolume() returns an OBJECT ({ media, slider, muted }), not a number.
      // media.volume is 0..1 — the range is 0..100. Reading it as a number gave
      // "[object Object]", which the range coerced to 0.
      const info = p.getVolume();
      const vol01 = info && typeof info.media === "number"
        ? info.media
        : (info && typeof info.slider === "number" ? info.slider / 100 : null);
      if (vol01 !== null && Number.isFinite(vol01)) {
        pipVolumeEl.value = String(Math.round(vol01 * 100));
        setRangeFill(pipVolumeEl);
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
        // Same glyph as the fullscreen chip; repeat-one carries its state in the
        // numeral drawn inside the loop, not in a second badge.
        repeatEl.appendChild(partSvg(pipDoc,
          wantOne ? PART_ICON_REPEAT.concat(PART_ICON_REPEAT_ONE) : PART_ICON_REPEAT,
          "0 0 24 24"));
      }
    }
  }

  function renderActive(activeIdx) {
    if (!lineEls.length) return;
    lineSets.forEach((set, i) => {
      // Far-line is PiP-only presentation chrome; the actual Active/Sung/
      // NotSung state is assigned from each interval in updateLineStates().
      lineEls[i].classList.toggle("ym-pip-far", activeIdx >= 0 && Math.abs(i - activeIdx) > 4);
      // Depth blur, copied from the panel (19-animation-modes): the sung line
      // is crisp, then 2px, 3px, 4px, 5px as it gets further away, capped at 5.
      // A background-vocal row is a sibling ELEMENT of the same line set, so it
      // inherits its lead line's distance and never blurs while it is still the
      // phrase being played.
      const distance = activeIdx >= 0 ? Math.abs(i - activeIdx) : 0;
      // Softer than the panel (turn the blur a little down a
      // bit but keep it") AND bounded: a filtered line is its own compositor
      // surface, so blurring every row of a 33-line song is exactly the kind of
      // per-line cost that made this window stutter before. Only the five rows
      // nearest the sung one get a filter; past that the text is already dimmed
      // by .ym-pip-far, where a 3-5px blur just reads as haze anyway.
      const near = distance > 0 && distance <= 5;
      const blur = near ? Math.min(3, 1 + distance * 0.6) : 0;
      const els = set.elements || [];
      for (let e = 0; e < els.length; e++) {
        const el = els[e];
        if (!el || !el.style) continue;
        // Panel rule 1: a line that is still being sung stays crisp even when it
        // is not the line being read - a background phrase routinely runs past
        // the start of the next lead, and blurring it mid-phrase is wrong.
        // updateLineStates() runs before this, so the class is current.
        const singing = el.classList && el.classList.contains("Active");
        const value = (blur === 0 || singing) ? "none" : "blur(" + blur + "px)";
        if (el.style.filter !== value) el.style.filter = value;
      }
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
  // used to run ("pip has the old one"). Same model as the panel:
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
  // button could restore it.
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
  // pixel at a time and the motion reads as pixels stepping.
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
    // Apple-style lyrics: the engine owns its own scroll offset, so the built-in
    // camera math has nothing to move. resetScroll() is the engine's supported
    // "back to the playing line" - it clears the manual offset and un-suspends
    // auto-align, exactly like the panel's button now does.
    if (rendererMode === "amll" && amllPlayer && typeof amllPlayer.resetScroll === "function") {
      try { amllPlayer.resetScroll(); } catch (e) {}
      setJumpVisible(false);
      return;
    }
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
    // Smooth Scrolling OFF: hand the move to the element's own CSS ease, ONCE
    // per target change (stepCenterSpring then does nothing). Without this the
    // PiP wrote the new scrollTop instantly every frame and had NO scroll
    // animation.
    if (!smoothScrolling) { writeCameraScroll(box, clamped, false); return; }
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
    //. The cooldown is upstream's model; the wasAway path is kept
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
    if (!smoothScrolling || !cameraSpring) {
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
    // NOTE: the panel's legacy simpleLyrics flag is PINNED true (it stopped being
    // a mode when the renderer became per-kind), so it must NOT drive the PiP.
    // Applying it here put body.ym-sl-simple-lyrics on a Spicy track, which turns
    // on the AMLL look's stubbed Scale/Glow springs and per-line scaling — the
    // words floated up instead of bouncing. The PiP's look follows rendererMode,
    // so a Spicy track is drawn exactly like the panel's Spicy track.
    // Smooth Scrolling switched off: drop the glide NOW, not on the next track.
    if (!smoothScrolling) resetCameraGlide();
  }

  // Which renderer the PiP should be running for the current content: the
  // panel's own decision, never inferred from the timings here.
  function wantedRenderer(payload) {
    if (!payload || payload.renderer !== "amll") return "spicy";
    if (payload.staticLyrics || !lines.length) return "spicy";
    return "amll";
  }

  function onSettings(s) {
    if (!s) return;
    applyScrollSettings(s);
    if (!s.renderer) return;
    const mode = wantedRenderer({ renderer: s.renderer, staticLyrics: staticLyrics });
    if (mode === rendererMode) return;
    setRenderer(mode);
    if (mode === "spicy") buildLinesBox();
    else syncAmllLines();
  }

  function onLines(payload) {
    if (!payload) return;
    lines = Array.isArray(payload.lines) ? payload.lines : [];
    linesVideoId = payload.videoId || null;
    staticLyrics = !!payload.staticLyrics;
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
    // A PiP opened from another page (Home, a playlist) predates the Lyrics tab,
    // so the panel may have appeared after the open call. The first track's
    // lyrics are the moment that panel exists; idempotent, so every track can
    // re-assert it.
    setMainPanelPipView(true);
    setHeader();
    syncVideoPane(true);
    const mode = wantedRenderer(payload);
    if (mode === "amll") {
      // A new track is a fresh chance: a previous fallback (the stylesheet had
      // not landed yet) must not keep this song on the wrong renderer forever.
      amllUnavailable = false;
      // The engine hosts its own line model and credits; rebuild them for this
      // track rather than leaving the previous song on screen. Hand it the
      // CURRENT clock, or the view would rebuild at 0 and scroll in.
      const nowPos = lyricPositionMs(player() ? player().getPositionMs() : null);
      amllLastPos = Number.isFinite(nowPos) ? Math.max(0, nowPos) : 0;
      setRenderer("amll");
      syncAmllLines();
    } else {
      setRenderer("spicy");
      buildLinesBox();
      const pos = lyricPositionMs(player() ? player().getPositionMs() : null);
      updateLineStates(pos);
      renderActive(activeIndexAt(pos));
    }
  }

  // While the PiP is open the tab's lyric panel is redundant, but hiding the
  // whole panel also hides the ONLY controls that edit sync and offset. So the
  // panel becomes the PiP control surface instead: a status block, and the REAL
  // Options card (the same node the Options button shows) docked underneath.
  // That card is a <body> child normally; moving it in makes it a normal block
  // inside the panel, and closing the PiP puts it back where it came from.
  let pipPanelView = null;
  let dockedOptionsWasHidden = true;

  function setMainPanelPipView(open) {
    // The tab panel can be detached while YTM re-renders the watch page (it is
    // moved around, not rebuilt), and getElementById cannot see a detached tree.
    // Fall back to the view's own parent so a PiP closed during that re-render
    // still puts the Options card back instead of leaving it inside a panel that
    // will reappear later still showing "PiP is open".
    const panel = document.getElementById("ym-sl-panel") ||
      (pipPanelView && pipPanelView.parentElement);
    if (!panel) return;
    // Same detached-tree reason as above: the card travels inside the view, so
    // look there when it is not reachable from the live document.
    const overlay = document.querySelector(".ym-sl-options-overlay") ||
      (pipPanelView && pipPanelView.querySelector(".ym-sl-options-overlay"));
    if (open) {
      panel.classList.add("ym-pip-open");
      if (pipPanelView && pipPanelView.parentElement !== panel) {
        // YTM rebuilt the tab around a detached panel: carry the view (and the
        // docked card inside it) across instead of making a second one.
        panel.appendChild(pipPanelView);
      } else if (!pipPanelView) {
        pipPanelView = document.createElement("div");
        pipPanelView.className = "ym-pip-open-view";
        pipPanelView.id = "ym-pip-open-view";
        const title = document.createElement("div");
        title.className = "ym-pip-open-title";
        title.textContent = "PiP is open";
        const note = document.createElement("div");
        note.className = "ym-pip-open-note";
        note.textContent = "The lyrics are in the floating window. Adjust sync, offset, or the lyric file below — changes apply immediately.";
        pipPanelView.append(title, note);
        panel.appendChild(pipPanelView);
      }
      if (overlay && overlay.parentElement !== pipPanelView) {
        dockedOptionsWasHidden = overlay.classList.contains("hidden");
        overlay.classList.remove("hidden");
        overlay.classList.add("ym-sl-options-docked");
        pipPanelView.appendChild(overlay);
      }
    } else {
      panel.classList.remove("ym-pip-open");
      if (overlay && pipPanelView && overlay.parentElement === pipPanelView) {
        overlay.classList.remove("ym-sl-options-docked");
        // Restore the exact state it had before docking: if the user had the
        // floating card open, it comes back open; otherwise it comes back closed.
        if (dockedOptionsWasHidden) overlay.classList.add("hidden");
        document.body.appendChild(overlay);
      }
      // remove() works on a detached panel too (isConnected would be false there
      // and leave the view behind, so the panel came back still saying PiP is on).
      if (pipPanelView) pipPanelView.remove();
      pipPanelView = null;
    }
  }

  function onPipClosed() {
    stopSync();
    stopKawarp();
    stopVideoMirror();
    dropAmll();
    try {
      const ds = document.documentElement.dataset;
      delete ds.ymPipRenderer;
      delete ds.ymPipAmll;
      delete ds.ymPipVideo;
      delete ds.ymPipLayout;
      delete ds.ymPipKawarp;
    } catch (e) {}
    pipWin = null;
    pipDoc = null;
    lineEls = [];
    lineSets = [];
    setMainPanelPipView(false);
    if (btnHandle) btnHandle.setActive(false);
  }

  function openPip() {
    if (!supported()) return;
    // requestWindow needs the user gesture, so it is called synchronously here.
    // Tall enough for a music video plus a few lyric lines; the user can resize.
    documentPictureInPicture.requestWindow({ width: 480, height: 620 }).then((win) => {
      pipWin = win;
      pipDoc = win.document;
      buildPipDoc(win);
      win.addEventListener("pagehide", onPipClosed);
      if (btnHandle) btnHandle.setActive(true);
      setMainPanelPipView(true);
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
      iconParts: ICON_PIP_PARTS,
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
      // lyrics" appeared to do nothing here.
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
