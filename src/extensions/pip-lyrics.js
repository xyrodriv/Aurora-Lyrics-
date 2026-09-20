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

     What is NOT reused: the panel's spring system for per-letter scale / Y-offset
     / glow. That is approximated here with the same targets and a simple easing,
     so the micro-motion is close but not bit-identical.
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
  // state published on "lyrics:sync". This mirrors spicy-lyrics.js
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

  // Copy the panel's live custom properties onto the PiP wrapper, so the user's
  // The panel's lyric SIZE is intentionally NOT copied — the PiP has its own
  // "zoom" setting (--ym-pip-zoom) so the floating window can be sized
  // independently of the synced tab. Offset / background-vocal / gradient / blur
  // settings still carry over without a bus topic per value.
  const COPIED_VARS = [
    "--ym-sl-lyrics-offset",
    "--ym-sl-bg-vocal-opacity",
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
    const cs = getComputedStyle(panel);
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
      align-items: baseline;
      gap: 8px;
      flex: 0 0 auto;
      margin-bottom: 10px;
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
      overflow: hidden;
    }
    /* The track is absolutely positioned so each line's offsetTop is measured
       against it, which makes centring a line a simple translate. */
    .ym-pip-track {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      /* Block flow, not flex: the panel's .line rules assume normal inline flow
         for their .word / .letterGroup children, and flex would re-parent them. */
      display: block;
      transition: transform .45s cubic-bezier(.22,.61,.36,1);
    }
    /* The panel's stylesheet owns the lyric look — typography, letter splitting,
       gradient fill and the Active/Sung/NotSung states all come from it. These
       rules only adapt it to a small floating window: neutralise the panel
       container's own chrome, lay the lines out on our translate track, and let
       far-away lines recede. Scoped with an extra class so they out-specify the
       panel's own rules rather than fighting them with !important everywhere. */
    #ym-sl-panel.ym-pip-panel {
      position: absolute !important;
      inset: 0 !important;
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
      height: 100% !important;
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
    }
    #ym-sl-panel.SpicyRenderer .line.OppositeAligned { text-align: right; }
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
  let lastRenderedActive = -2;
  let lineEls = [];
  let lineSets = [];   // animation records, parallel to lineEls
  let kit = null;      // the panel's published animation kit (lyrics:renderer)
  let lastFrameAt = 0;
  let unsubscribe = null;
  let unsubscribeKit = null;
  let unsubscribeSync = null;
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
    head.appendChild(makeEl(doc, "div", "ym-pip-title", "Aurora Lyrics"));
    const artist = makeEl(doc, "div", "ym-pip-artist", "");
    artist.id = "ym-pip-artist";
    head.appendChild(artist);
    root.appendChild(head);

    const linesBox = makeEl(doc, "div", "ym-pip-lines");
    linesBox.id = "ym-pip-lines";
    // The panel's stylesheet is scoped to #ym-sl-panel.SpicyRenderer, so the PiP
    // has to present that same wrapper for the lyric rules to apply at all.
    const panelWrap = makeEl(doc, "div", "SpicyRenderer ym-pip-panel");
    panelWrap.id = "ym-sl-panel";
    const lyricsContent = makeEl(doc, "div", "LyricsContent");
    lyricsContent.id = "ym-pip-content";
    // The panel sizes lyrics from --DefaultLyricsSize. Mirror that formula, but
    // drive it from the PiP's own "zoom" setting (--ym-pip-zoom) so the floating
    // window sizes independently of the synced tab. The 46px cap the panel uses is
    // lifted to 90px so the slider can reach 300% (3.0 -> 60px) without clipping.
    lyricsContent.style.setProperty(
      "--DefaultLyricsSize",
      "clamp(14px, calc(1.25rem * var(--ym-pip-zoom, 1.7)), 90px)"
    );
    // Seed the PiP's own zoom var from the "zoom" setting so the floating window
    // sizes independently of the synced tab. 1.7 == 170% default; 3.0 == 300%.
    lyricsContent.style.setProperty(
      "--ym-pip-zoom",
      String(settings.zoom != null ? settings.zoom : 1.7)
    );
    panelWrap.appendChild(lyricsContent);
    linesBox.appendChild(panelWrap);
    root.appendChild(linesBox);

    if (settings.showTransport !== false) {
      const bar = makeEl(doc, "div", "ym-pip-transport");
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

      bar.appendChild(prev);
      bar.appendChild(main);
      bar.appendChild(next);
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
      // Mirror the panel's word.LineTimed flag (spicy-lyrics.js 6244, 6938-6945):
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
    const words = (line.words && line.words.length)
      ? line.words
      : [{ text: line.text, startMs: line.startMs, endMs: line.endMs, isLast: true }];
    const records = [];
    const elements = [div];
    buildWordsInto(div, words, records, false, !!line.lineTimed);

    // Background vocals: the panel emits one .line.bg-line per background run,
    // right after the main line, with .bg-word children. Returned as siblings so
    // the caller appends them in order.
    (line.background || []).forEach((bg) => {
      if (!bg.words || !bg.words.length) return;
      const bgEl = makeEl(pipDoc, "div", "line bg-line");
      if (line.opposite) bgEl.classList.add("OppositeAligned");
      buildWordsInto(bgEl, bg.words, records, true);
      elements.push(bgEl);
    });

    lineSets[index] = { records: records, elements: elements };
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
      span.style.setProperty("--gradient-position", "-20%");
      span.style.setProperty("--text-shadow-opacity", "0%");
      span.style.setProperty("--text-shadow-blur-radius", "4px");
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
      letter.style.setProperty("--gradient-position", "-20%");
      letter.style.setProperty("--text-shadow-opacity", "0%");
      letter.style.setProperty("--text-shadow-blur-radius", "4px");
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
  }

  function activeIndexAt(posMs) {
    if (!lines.length || posMs === null || posMs === undefined) return -1;
    let lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (posMs < lines[mid].startMs) hi = mid - 1;
      else { found = mid; lo = mid + 1; }
    }
    if (found === -1) return -1;
    // Past the end of that line: only still "active" if the next has not begun.
    return found;
  }

  /* The panel's own animation, running on the panel's own springs and splines
     (published over the bus as "lyrics:renderer"). This mirrors its two passes:
     a word-level store per syllable, then a letter-level store per character
     inside a letterGroup, with the same falloff constants and the same style
     writes. Nothing here re-derives the feel — it calls the same functions. */
  function animateLine(activeIdx, posMs, dt) {
    const set = lineSets[activeIdx];
    const records = set && set.records;
    if (!records || !kit) return false;
    const splines = kit.splines;
    let anyAwake = false;
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
      // Honor lineTimed for Scale/YOffset exactly as the panel does (spicy-lyrics.js
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

      const selfAwake = stateChanged || kit.storeNeedsAnimation(rec.springs);
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
    // The synced tab shifts the lyric clock by the sync offset; the PiP must do
    // the same or every line/word lands that offset early. Mirror the panel's
    // animate(): lyricPositionMs = positionMs - getOffsetForPosition(positionMs).
    const lyricPos = lyricPositionMs(pos);
    const idx = activeIndexAt(lyricPos);
    if (idx !== lastRenderedActive) {
      lastRenderedActive = idx;
      renderActive(idx);
    }
    if (idx >= 0) {
      if (kit) animateLine(idx, lyricPos, dt);
      else fillWithoutKit(idx, lyricPos);
    }
    // Settle every non-active line's springs to rest (panel-faithful behavior).
    // Without this, restRecords' "SetGoal(1)" goal would never be reached because
    // the springs only Step inside animateLine (which runs only for the active
    // line). The storeNeedsAnimation short-circuit makes this O(1) for the lines
    // that have already settled.
    for (let s = 0; s < lineSets.length; s++) {
      if (s !== idx) settleLineSet(lineSets[s], dt);
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
  }

  function renderActive(activeIdx) {
    if (!lineEls.length) return;
    lineSets.forEach((set, i) => {
      const isActive = i === activeIdx;
      const isSung = activeIdx >= 0 && i < activeIdx;
      set.elements.forEach((el) => {
        el.classList.toggle("Active", isActive);
        el.classList.toggle("Sung", isSung);
        el.classList.toggle("NotSung", !isActive && !isSung);
      });
      lineEls[i].classList.toggle("ym-pip-far", activeIdx >= 0 && Math.abs(i - activeIdx) > 4);
      // Only the ACTIVE line is animated, so a line that stops being active would
      // otherwise keep whatever glow and scale it last had. The panel's springs
      // settle those to rest; without this the highlight halo lingers on every
      // line already sung.
      if (!isActive) restRecords(set.records);
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

  // Bring the active line to the vertical middle of the viewport box. Distance-
  // scaled duration matches the panel (clamp(180 + distance*0.22, 180, 420) ms).
  // The active line's BOUNCE was not this transition — it was the spring-goal
  // divergence (blends applied unconditionally instead of only when !lineTimed);
  // that is fixed in animateLine now. This CSS-transition centering is what the
  // PiP shipped with and what scrolled reliably.
  let lastCenterY = 0;
  function centerOn(activeIdx) {
    const box = pipEl("ym-pip-lines");
    const track = box && box.querySelector(".ym-pip-track");
    const target = lineEls[activeIdx];
    if (!box || !track || !target) return;
    const y = box.clientHeight / 2 - target.offsetHeight / 2 - target.offsetTop;
    const distance = Math.abs(y - lastCenterY);
    lastCenterY = y;
    const duration = Math.max(180, Math.min(420, 180 + distance * 0.22));
    track.style.transition = "transform " + duration + "ms cubic-bezier(.22,.61,.36,1)";
    track.style.transform = "translateY(" + Math.round(y) + "px)";
  }

  function stopSync() {
    if (rafId && pipWin && !pipWin.closed) {
      try { pipWin.cancelAnimationFrame(rafId); } catch (e) {}
    }
    rafId = 0;
  }

  // ---- lifecycle -----------------------------------------------------------
  function onLines(payload) {
    if (!payload) return;
    lines = Array.isArray(payload.lines) ? payload.lines : [];
    linesVideoId = payload.videoId || null;
    lastRenderedActive = -2;
    if (!pipWin || pipWin.closed || !pipDoc) return;
    setHeader();
    buildLinesBox();
    renderActive(activeIndexAt(lyricPositionMs(player() ? player().getPositionMs() : null)));
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
    // Live-apply the lyric-size slider to an already-open PiP window without a
    // rebuild: only the --ym-pip-zoom var needs to change for the clamp() above.
    const z = settings.zoom;
    if (z != null) {
      const content = pipEl("ym-pip-content");
      if (content) content.style.setProperty("--ym-pip-zoom", String(z));
    }
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
    }
    applySettings(settings);
    window.postMessage({ type: "ytmod-settings-request", id: EXT_ID }, "*");
  }

  function teardown() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (unsubscribeKit) { unsubscribeKit(); unsubscribeKit = null; }
    if (unsubscribeSync) { unsubscribeSync(); unsubscribeSync = null; }
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
