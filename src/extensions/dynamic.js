/*
 * Dynamic - Aurora Lyrics theme.
 *
 * Uses the current track artwork as a full-page Kawarp background and keeps
 * YouTube Music's navigation, side rail, search header, and player bar clear
 * enough for the artwork to show through.
 */
(function () {
  "use strict";

  const EXT_ID = "ytmod-dynamic";
  const EXTENSION_SCRIPT_URL = document.currentScript ? document.currentScript.src : "";
  const KAWARP_MODULE_URL = EXTENSION_SCRIPT_URL
    ? new URL("kawarp-core.js", EXTENSION_SCRIPT_URL).href
    : "";
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

  // Default kawarp backdrop shown when no track is playing (or the current
  // track has no artwork URL). Embedding it as a data URL keeps the
  // page-world extension script self-contained: a `<script src>` injection
  // runs in the page's main world, which cannot fetch `chrome-extension://`
  // URLs, so a packaged image asset would be unreachable from this context.
  // Current default (AJ, 2026-09-28) = his "gradient" artwork, source file
  // `Logos/gradient (dont use).png` (512x512) -> ffmpeg libwebp -quality 90
  // -pix_fmt yuv444p (~8.6 KB) -> base64. To swap it: re-encode the source to
  // WebP, base64 it, and update the constant below. Note: the MIME in the data
  // URL prefix MUST match the actual file format (image/webp here) or browsers
  // will refuse to decode it.
  const DEFAULT_KAWARP_DATA_URL = "data:image/webp;base64,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";
  const DEFAULT_SETTINGS = {
    brightness: 0.78,
    saturation: 1.7,
    blurPasses: 6,
    warpIntensity: 1,
  };
  let currentSettings = Object.assign({}, DEFAULT_SETTINGS);

  function whenYTMod(callback) {
    if (window.YTMod && window.YTMod.player) return callback();
    setTimeout(() => whenYTMod(callback), 200);
  }

  let pageBgRoot = null;
  let pageBgHost = null;
  let pageDivider = null;
  let pageScrollHandler = null;
  let rootObserver = null;
  let resizeObserver = null;
  let kawarpCanvas = null;
  let kawarpInstance = null;
  let kawarpModulePromise = null;
  let kawarpArtworkUrl = "";
  let requestedKawarpArtworkUrl = "";
  let kawarpRequestSeq = 0;
  let raf = 0;
  let lastTrackCheckAt = 0;
  // When the Synced Lyrics add-on enters fullscreen on a song it takes over the
  // Kawarp backdrop. It calls suspend() so the page-wide Kawarp stops running
  // and hides, guaranteeing the two never animate at the same time; resume()
  // restores it on exit.
  let kawarpSuspended = false;

  function applySettings(next) {
    currentSettings = Object.assign({}, currentSettings, next || {});
    currentSettings.brightness = Math.min(1.2, Math.max(0.5, Number(currentSettings.brightness) || DEFAULT_SETTINGS.brightness));
    currentSettings.saturation = Math.min(2.5, Math.max(0.5, Number(currentSettings.saturation) || DEFAULT_SETTINGS.saturation));
    currentSettings.blurPasses = Math.round(Math.min(8, Math.max(2, Number(currentSettings.blurPasses) || DEFAULT_SETTINGS.blurPasses)));
    currentSettings.warpIntensity = Math.min(1, Math.max(0.2, Number(currentSettings.warpIntensity) || DEFAULT_SETTINGS.warpIntensity));
    KAWARP_OPTIONS.warpIntensity = currentSettings.warpIntensity;
    KAWARP_OPTIONS.blurPasses = currentSettings.blurPasses;
    KAWARP_OPTIONS.saturation = currentSettings.saturation;
    if (kawarpCanvas) {
      kawarpCanvas.style.filter =
        `saturate(${currentSettings.saturation}) brightness(${currentSettings.brightness})`;
    }
    if (kawarpInstance) {
      kawarpInstance.setOptions({
        warpIntensity: currentSettings.warpIntensity,
        blurPasses: currentSettings.blurPasses,
        saturation: currentSettings.saturation,
      });
    }
  }

  const CSS = `
    .ym-dynamic-page-bg-root {
      background: transparent !important;
      --ytmusic-app-background: transparent !important;
      --ytmusic-player-page-background: transparent !important;
      --ytmusic-player-bar-background: transparent !important;
      --ytmusic-nav-bar-background: transparent !important;
      --ytmusic-general-background-a: transparent !important;
      --ytmusic-general-background-b: transparent !important;
      --ytmusic-general-background-c: transparent !important;
      --ytmusic-general-background-d: transparent !important;
    }
    html.ym-dynamic-page-bg-active,
    body.ym-dynamic-page-bg-active {
      background: transparent !important;
    }
    .ym-dynamic-page-bg-root.ym-dynamic-page-bg-needs-position {
      position: relative !important;
    }
    .ym-dynamic-page-bg-host {
      position: fixed !important;
      inset: 0 !important;
      z-index: -1 !important;
      display: block;
      overflow: hidden;
      pointer-events: none;
      background: #0f0f0f;
    }
    .ym-dynamic-page-bg-host .ym-dynamic-kawarp-bg {
      transform: none;
      -webkit-mask-image: none;
      mask-image: none;
      filter: saturate(1.7) brightness(.78);
    }
    .ym-dynamic-page-bg-host .ym-dynamic-kawarp-bg.ready { opacity: .88; }
    .ym-dynamic-page-bg-host .ym-dynamic-kawarp-shade {
      background:
        linear-gradient(
          180deg,
          rgba(5,5,8,.28),
          rgba(5,5,8,.1) 28%,
          rgba(5,5,8,.1) 72%,
          rgba(5,5,8,.32)
        );
    }
    .ym-dynamic-page-divider {
      position: absolute;
      top: 84px;
      bottom: 72px;
      left: 68%;
      width: 1px;
      z-index: 2;
      background: linear-gradient(
        180deg,
        transparent,
        rgba(255,255,255,.38) 12%,
        rgba(255,255,255,.38) 88%,
        transparent
      );
      box-shadow: 0 0 8px rgba(255,255,255,.1);
      opacity: .56;
    }
    .ym-dynamic-page-bg-root ytmusic-app-layout,
    .ym-dynamic-page-bg-root ytmusic-nav-bar,
    .ym-dynamic-page-bg-root ytmusic-player-page,
    .ym-dynamic-page-bg-root ytmusic-watch-page,
    .ym-dynamic-page-bg-root ytmusic-player-bar,
    .ym-dynamic-page-bg-root ytmusic-guide-renderer,
    .ym-dynamic-page-bg-root ytmusic-left-nav-bar,
    .ym-dynamic-page-bg-root #layout,
    .ym-dynamic-page-bg-root #nav-bar,
    .ym-dynamic-page-bg-root #nav-bar-background,
    .ym-dynamic-page-bg-root #guide,
    .ym-dynamic-page-bg-root #guide-spacer,
    .ym-dynamic-page-bg-root #mini-guide,
    .ym-dynamic-page-bg-root #mini-guide-background,
    .ym-dynamic-page-bg-root #guide-wrapper,
    .ym-dynamic-page-bg-root #left-content,
    .ym-dynamic-page-bg-root #player-bar {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    .ym-dynamic-page-bg-root #player-bar-background {
      background: rgba(6,6,10,.22) !important;
      background-color: rgba(6,6,10,.22) !important;
      background-image: none !important;
      -webkit-backdrop-filter: blur(28px) saturate(1.45) brightness(.94);
      backdrop-filter: blur(28px) saturate(1.45) brightness(.94);
      border-top: 1px solid rgba(255,255,255,.1);
      box-shadow: 0 -10px 30px rgba(0,0,0,.12);
    }
    .ym-dynamic-page-bg-root.ym-dynamic-topbar-scrolled #nav-bar-background {
      background: rgba(6,6,10,.22) !important;
      background-color: rgba(6,6,10,.22) !important;
      background-image: none !important;
      -webkit-backdrop-filter: blur(28px) saturate(1.45) brightness(.94);
      backdrop-filter: blur(28px) saturate(1.45) brightness(.94);
      border-bottom: 1px solid rgba(255,255,255,.1);
      box-shadow: 0 10px 30px rgba(0,0,0,.12);
    }
    .ym-dynamic-page-bg-root ytmusic-nav-bar::before,
    .ym-dynamic-page-bg-root ytmusic-nav-bar::after,
    .ym-dynamic-page-bg-root ytmusic-guide-renderer::before,
    .ym-dynamic-page-bg-root ytmusic-guide-renderer::after,
    .ym-dynamic-page-bg-root ytmusic-player-bar::before,
    .ym-dynamic-page-bg-root ytmusic-player-bar::after {
      background: transparent !important;
    }
    .ym-dynamic-page-bg-root ytmusic-player-page .html5-video-container,
    .ym-dynamic-page-bg-root ytmusic-player-page video.html5-main-video {
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 2px;
      box-shadow:
        0 0 0 1px rgba(0,0,0,.28),
        0 18px 42px rgba(0,0,0,.38);
    }
    .ym-dynamic-page-bg-root.ym-dynamic-song-mode {
      --ym-dynamic-left-rail-width: 245px;
    }
    .ym-dynamic-page-bg-root.ym-dynamic-song-mode
      :is(ytmusic-guide-renderer, ytmusic-left-nav-bar, #guide-wrapper, #guide, #left-content),
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode
      :is(ytmusic-guide-renderer, ytmusic-left-nav-bar, #guide-wrapper, #guide, #left-content) {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode
      :is(
        ytmusic-browse-response,
        ytmusic-homepage,
        ytmusic-browse-page,
        ytmusic-section-list-renderer,
        ytmusic-carousel-shelf-renderer,
        ytmusic-music-shelf-renderer,
        ytmusic-grid-renderer,
        #page-manager,
        #main-panel,
        #content,
        #content-page,
        #browse-page,
        #home-page,
        #contents
      ),
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode ytmusic-browse-response > *,
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode ytmusic-section-list-renderer > #contents,
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode ytmusic-section-list-renderer > #contents > * {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    /* The fullbleed thumbnail is the page-level banner image.
   On ALBUM / ARTIST / PLAYLIST it lives inside
   ytmusic-immersive-header-renderer and is the real banner we want to show.
   On HOME it is a standalone decorative background (ytmusic-browse-response
   there has NO page-type attribute, and the page has ZERO
   ytmusic-immersive-header-renderer elements — measured live 2026-09-16), and
   it renders a stale album-art gradient over the top of the page
   (AJ-confirmed: red, then yellow/blue).
   So: hide every home-mode fullbleed, then re-show only the ones that belong
   to an immersive header. (Bleed-through behind the watch page is a separate
   Dynamic / Smooth Motion issue, not this rule — see MEMORY.md Round 8.) */
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode ytmusic-fullbleed-thumbnail-renderer,
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode ytmusic-fullbleed-thumbnail-renderer img {
      opacity: 0 !important;
      visibility: hidden !important;
    }
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode
      ytmusic-immersive-header-renderer ytmusic-fullbleed-thumbnail-renderer,
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode
      ytmusic-immersive-header-renderer ytmusic-fullbleed-thumbnail-renderer img {
      opacity: 1 !important;
      visibility: visible !important;
    }
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode
      :is(
        ytmusic-browse-response,
        ytmusic-homepage,
        ytmusic-section-list-renderer,
        ytmusic-carousel-shelf-renderer,
        ytmusic-shelf-renderer,
        ytmusic-music-shelf-renderer
      )::before,
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode
      :is(
        ytmusic-browse-response,
        ytmusic-homepage,
        ytmusic-section-list-renderer,
        ytmusic-carousel-shelf-renderer,
        ytmusic-shelf-renderer,
        ytmusic-music-shelf-renderer
      )::after {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode .ym-dynamic-kawarp-shade {
      background: rgba(5,5,8,.16);
    }
    /* The browse page stays mounted behind the player page (collapsed to
       height:0) and its content overflows. Because this theme makes the
       player-page background transparent, that overflow bled through as the
       home screen. Clip the browse page whenever the full player page is open. */
    .ym-dynamic-page-bg-root ytmusic-app-layout[player-page-open] ytmusic-browse-response {
      overflow: hidden !important;
    }
    /* The clip above is not enough on its own: the Dynamic theme makes the
       player page transparent so the page-wide Kawarp shows through, but the
       inactive browse/search pages behind it are ALSO transparent, and their
       opaque UI children (the page tabs, header, lists) bleed right through
       the fullscreen player (AJ-confirmed 2026-09-16 — "the library page tabs
       and header show behind the video"). The player page IS the current
       view during player-page-open, so hide the inactive browse/search pages
       entirely. The left guide (#guide) is a separate element and is
       unaffected — AJ explicitly wants the guide + left playlists panel to
       stay visible; this rule only kills the page-content bleed. */
    .ym-dynamic-page-bg-root ytmusic-app-layout[player-page-open] ytmusic-browse-response,
    .ym-dynamic-page-bg-root ytmusic-app-layout[player-page-open] ytmusic-search-page {
      display: none !important;
    }
    .ym-dynamic-page-bg-root:not(.ym-dynamic-song-mode) .ym-dynamic-page-divider {
      display: none !important;
    }
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode
      ytmusic-search-page > ytmusic-tabbed-search-results-renderer > ytmusic-tabs {
      background: rgba(6,6,10,.18) !important;
      background-color: rgba(6,6,10,.18) !important;
      background-image: none !important;
      -webkit-backdrop-filter: blur(24px) saturate(1.35);
      backdrop-filter: blur(24px) saturate(1.35);
    }
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode
      ytmusic-search-page > ytmusic-tabbed-search-results-renderer > ytmusic-tabs > #tabs {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
      -webkit-backdrop-filter: none !important;
      backdrop-filter: none !important;
    }
    .ym-dynamic-page-bg-root.ym-dynamic-song-mode ytmusic-player-bar {
      left: 0 !important;
      right: 0 !important;
      width: auto !important;
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode ytmusic-player-bar {
      left: 0 !important;
      right: 0 !important;
      width: auto !important;
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    .ym-dynamic-kawarp-bg {
      position: absolute;
      inset: 0;
      z-index: 0;
      display: block;
      width: 100%;
      height: 100%;
      opacity: 0;
      pointer-events: none;
      transform: scaleX(1.08);
      transform-origin: center center;
      filter: saturate(1.7) brightness(.72);
      -webkit-mask-image: linear-gradient(
        90deg,
        transparent 0%,
        rgba(0,0,0,.5) 3%,
        #000 9%,
        #000 91%,
        rgba(0,0,0,.5) 97%,
        transparent 100%
      );
      mask-image: linear-gradient(
        90deg,
        transparent 0%,
        rgba(0,0,0,.5) 3%,
        #000 9%,
        #000 91%,
        rgba(0,0,0,.5) 97%,
        transparent 100%
      );
      transition: opacity .65s ease;
    }
    .ym-dynamic-kawarp-bg.ready { opacity: .98; }
    .ym-dynamic-kawarp-shade {
      position: absolute;
      inset: 0;
      z-index: 1;
      background:
        linear-gradient(
          90deg,
          rgba(5,5,8,.26) 0%,
          rgba(5,5,8,.07) 9%,
          rgba(5,5,8,.07) 91%,
          rgba(5,5,8,.26) 100%
        ),
        linear-gradient(
          180deg,
          rgba(5,5,8,.14),
          transparent 26%,
          transparent 72%,
          rgba(5,5,8,.24)
        );
      pointer-events: none;
    }
  `;

  function findPageBgRoot() {
    return document.querySelector("ytmusic-app") ||
      document.querySelector("ytmusic-player-page");
  }

  function syncPageChrome() {
    if (!pageBgRoot) return;
    const isSongPage = window.location.pathname === "/watch";
    const scrollTop = Math.max(
      Number(window.scrollY) || 0,
      document.documentElement ? Number(document.documentElement.scrollTop) || 0 : 0,
      document.body ? Number(document.body.scrollTop) || 0 : 0
    );
    pageBgRoot.classList.toggle("ym-dynamic-song-mode", isSongPage);
    pageBgRoot.classList.toggle("ym-dynamic-home-mode", !isSongPage);
    pageBgRoot.classList.toggle("ym-dynamic-topbar-scrolled", scrollTop > 2);
  }

  function mountPageBackground() {
    if (!pageBgHost) return false;
    const root = findPageBgRoot();
    if (!root) return false;
    if (pageBgRoot && pageBgRoot !== root) {
      pageBgRoot.classList.remove(
        "ym-dynamic-page-bg-root",
        "ym-dynamic-page-bg-needs-position",
        "ym-dynamic-song-mode",
        "ym-dynamic-home-mode",
        "ym-dynamic-topbar-scrolled"
      );
    }
    pageBgRoot = root;
    pageBgRoot.classList.add("ym-dynamic-page-bg-root");
    pageBgRoot.classList.toggle(
      "ym-dynamic-page-bg-needs-position",
      getComputedStyle(pageBgRoot).position === "static"
    );
    if (pageBgHost.parentElement !== pageBgRoot) pageBgRoot.prepend(pageBgHost);
    syncPageChrome();
    return true;
  }

  function getCurrentTrack() {
    return window.YTMod && window.YTMod.player &&
      typeof window.YTMod.player.getTrack === "function"
      ? window.YTMod.player.getTrack()
      : null;
  }

  function getKawarpConstructor() {
    if (!KAWARP_MODULE_URL) {
      return Promise.reject(new Error("Kawarp module URL is unavailable."));
    }
    if (!kawarpModulePromise) {
      kawarpModulePromise = import(KAWARP_MODULE_URL).then((module) => {
        const Kawarp = module.default || module.Kawarp;
        if (typeof Kawarp !== "function") {
          throw new Error("Kawarp module did not export a constructor.");
        }
        return Kawarp;
      });
    }
    return kawarpModulePromise;
  }

  function sizeKawarpCanvas() {
    if (!kawarpCanvas || !pageBgHost) return;
    const rect = pageBgHost.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    if (pageDivider) {
      const tab = document.querySelector("ytmusic-player-page tp-yt-paper-tabs") ||
        document.querySelector("tp-yt-paper-tabs");
      const tabRect = tab && tab.getBoundingClientRect();
      const visual = document.querySelector("ytmusic-player-page video.html5-main-video") ||
        document.querySelector("ytmusic-player-page #movie_player");
      const visualRect = visual && visual.getBoundingClientRect();
      const nav = document.querySelector("ytmusic-nav-bar");
      const playerBar = document.querySelector("ytmusic-player-bar");
      const navRect = nav && nav.getBoundingClientRect();
      const playerBarRect = playerBar && playerBar.getBoundingClientRect();
      // Anchor the divider to the lyric/tab column's left edge ONLY. The old
      // midpoint branch fed the video's rect into the calculation, so the line
      // drifted with the video's aspect ratio and could land inside the video's
      // letterbox area (AJ-confirmed 2026-09-16: "it moves according to the
      // aspect ratio... behind the music video"). Dropping the video rect makes
      // the separator stable for every video.
      const dividerLeft =
        tabRect && tabRect.width ? tabRect.left - 24 : null;
      pageDivider.style.left = Number.isFinite(dividerLeft)
        ? `${Math.round(dividerLeft)}px`
        : "66%";
      pageDivider.style.top = navRect && navRect.height
        ? `${Math.max(0, Math.round(navRect.bottom))}px`
        : "84px";
      pageDivider.style.bottom = playerBarRect && playerBarRect.height
        ? `${Math.max(0, Math.round(window.innerHeight - playerBarRect.top))}px`
        : "72px";
    }

    if (kawarpCanvas.width === width && kawarpCanvas.height === height) return;
    kawarpCanvas.width = width;
    kawarpCanvas.height = height;
    if (kawarpInstance) kawarpInstance.resize();
  }

  function syncKawarpPlaybackState() {
    if (!kawarpInstance) return;
    // While suspended (Synced Lyrics is fullscreen), stay stopped no matter what
    // the playback state is, so the tick loop can't restart it behind our back.
    if (kawarpSuspended) { kawarpInstance.stop(); return; }
    const paused = window.YTMod && window.YTMod.player &&
      typeof window.YTMod.player.isPaused === "function"
      ? window.YTMod.player.isPaused()
      : null;
    kawarpInstance.setOptions({ animationSpeed: paused === true ? 0.1 : 1 });
    if (pageBgHost && pageBgHost.isConnected) kawarpInstance.start();
    else kawarpInstance.stop();
  }

  // Called by the Synced Lyrics add-on when it opens/closes its fullscreen song
  // backdrop. suspend() stops the animation and hides the host; resume() shows
  // it and lets the normal playback-state sync take over again.
  function suspendKawarp() {
    kawarpSuspended = true;
    if (kawarpInstance) { try { kawarpInstance.stop(); } catch (_) {} }
    if (pageBgHost) pageBgHost.style.visibility = "hidden";
  }

  function resumeKawarp() {
    kawarpSuspended = false;
    if (pageBgHost) pageBgHost.style.visibility = "";
    syncKawarpPlaybackState();
  }

  async function updateKawarpBackground(track) {
    const artworkUrl = track && track.artworkUrl ? track.artworkUrl : "";
    requestedKawarpArtworkUrl = artworkUrl;
    const requestId = ++kawarpRequestSeq;
    if (pageBgHost && !pageBgHost.isConnected) mountPageBackground();
    // No track artwork? Show the embedded default gradient as a friendly
    // idle backdrop instead of the host's grey #0f0f0f.
    const sourceUrl = artworkUrl || DEFAULT_KAWARP_DATA_URL;
    if (!kawarpCanvas || !pageBgHost || !pageBgHost.isConnected || !sourceUrl) {
      if (kawarpCanvas) kawarpCanvas.classList.remove("ready");
      return;
    }

    try {
      const Kawarp = await getKawarpConstructor();
      if (
        requestId !== kawarpRequestSeq ||
        !kawarpCanvas ||
        !pageBgHost ||
        !pageBgHost.isConnected
      ) return;
      sizeKawarpCanvas();
      if (!kawarpInstance) kawarpInstance = new Kawarp(kawarpCanvas, KAWARP_OPTIONS);
      if (sourceUrl !== kawarpArtworkUrl) {
        await kawarpInstance.loadImage(sourceUrl);
        if (requestId !== kawarpRequestSeq || artworkUrl !== requestedKawarpArtworkUrl) {
          if (requestedKawarpArtworkUrl) updateKawarpBackground({ artworkUrl: requestedKawarpArtworkUrl });
          return;
        }
        kawarpArtworkUrl = sourceUrl;
      }
      syncKawarpPlaybackState();
      kawarpCanvas.classList.add("ready");
    } catch (error) {
      if (requestId !== kawarpRequestSeq) return;
      console.warn("[Dynamic] Kawarp background failed:", error);
      if (kawarpCanvas) kawarpCanvas.classList.remove("ready");
    }
  }

  function buildUI() {
    if (document.getElementById("ym-dynamic-style")) return;
    const style = document.createElement("style");
    style.id = "ym-dynamic-style";
    style.textContent = CSS;
    document.head.appendChild(style);
    document.documentElement.classList.add("ym-dynamic-page-bg-active");
    document.body.classList.add("ym-dynamic-page-bg-active");

    pageScrollHandler = () => syncPageChrome();
    window.addEventListener("scroll", pageScrollHandler, { passive: true });
    document.addEventListener("scroll", pageScrollHandler, {
      capture: true,
      passive: true,
    });

    pageBgHost = document.createElement("div");
    pageBgHost.className = "ym-dynamic-page-bg-host";
    pageBgHost.setAttribute("aria-hidden", "true");
    kawarpCanvas = document.createElement("canvas");
    kawarpCanvas.className = "ym-dynamic-kawarp-bg";
    kawarpCanvas.setAttribute("aria-hidden", "true");
    applySettings(currentSettings);
    const shade = document.createElement("div");
    shade.className = "ym-dynamic-kawarp-shade";
    shade.setAttribute("aria-hidden", "true");
    pageDivider = document.createElement("div");
    pageDivider.className = "ym-dynamic-page-divider";
    pageDivider.setAttribute("aria-hidden", "true");
    pageBgHost.append(kawarpCanvas, shade, pageDivider);

    document.body.appendChild(pageBgHost);
    mountPageBackground();
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => sizeKawarpCanvas());
      resizeObserver.observe(pageBgHost);
    }

    if (pageBgRoot) {
      rootObserver = new MutationObserver(() => {
        mountPageBackground();
        syncPageChrome();
        sizeKawarpCanvas();
      });
      rootObserver.observe(pageBgRoot, { childList: true, subtree: true });
    }

    // Page-world handshake for the Synced Lyrics fullscreen backdrop: its
    // presence also signals "Dynamic is active", which gates the fullscreen
    // Kawarp. Removed in teardown so a disabled add-on leaves no trace.
    window.__ymAuroraDynamic = { suspend: suspendKawarp, resume: resumeKawarp };

    updateKawarpBackground(getCurrentTrack());
    startTick();
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    if (!window.YTMod || !window.YTMod.player) return;
    const now = performance.now();
    if (now - lastTrackCheckAt > 500) {
      lastTrackCheckAt = now;
      syncPageChrome();
      const track = getCurrentTrack();
      const artworkUrl = track && track.artworkUrl ? track.artworkUrl : "";
      // Skip artwork swaps while suspended: the hidden page Kawarp should do no
      // work at all while the fullscreen one is on screen.
      if (!kawarpSuspended && artworkUrl !== requestedKawarpArtworkUrl) {
        updateKawarpBackground(track);
      }
      syncKawarpPlaybackState();
    }
  }

  function startTick() {
    if (!raf) tick();
  }

  function teardown() {
    kawarpSuspended = false;
    try { delete window.__ymAuroraDynamic; } catch (_) { window.__ymAuroraDynamic = undefined; }
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (rootObserver) rootObserver.disconnect();
    if (resizeObserver) resizeObserver.disconnect();
    rootObserver = null;
    resizeObserver = null;
    ++kawarpRequestSeq;
    if (kawarpInstance) kawarpInstance.dispose();
    kawarpInstance = null;
    kawarpCanvas = null;
    pageDivider = null;
    kawarpArtworkUrl = "";
    requestedKawarpArtworkUrl = "";
    if (pageBgHost) pageBgHost.remove();
    if (pageBgRoot) {
      pageBgRoot.classList.remove(
        "ym-dynamic-page-bg-root",
        "ym-dynamic-page-bg-needs-position",
        "ym-dynamic-song-mode",
        "ym-dynamic-home-mode",
        "ym-dynamic-topbar-scrolled"
      );
    }
    pageBgHost = null;
    pageBgRoot = null;
    if (pageScrollHandler) {
      window.removeEventListener("scroll", pageScrollHandler);
      document.removeEventListener("scroll", pageScrollHandler, true);
      pageScrollHandler = null;
    }
    document.documentElement.classList.remove("ym-dynamic-page-bg-active");
    document.body.classList.remove("ym-dynamic-page-bg-active");
    const style = document.getElementById("ym-dynamic-style");
    if (style) style.remove();
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.id !== EXT_ID) return;
    if (data.type === "ytmod-settings") {
      applySettings(data.settings);
      return;
    }
    if (data.type !== "ytmod-ext") return;
    if (data.action === "suspend") { suspendKawarp(); return; }
    if (data.action === "resume") { resumeKawarp(); return; }
    if (data.action === "disable") teardown();
  });

  whenYTMod(() => {
    buildUI();
    window.postMessage({ type: "ytmod-settings-request", id: EXT_ID }, "*");
  });
})();
