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
  // Current default (AJ, 2026-10-20) = his dark+red gradient, source file
  // `Logos/dark and red gradient.jpg` (1536x1536 -> 512x512) -> PIL libwebp
  // -quality 90 (~4.6 KB) -> base64. This is the backdrop shown at STARTUP when
  // nothing is playing, so it is NOT assets/ambient-gradient.png (that one is the
  // marketplace wash only). To swap it: re-encode the source to
  // WebP, base64 it, and update the constant below. Note: the MIME in the data
  // URL prefix MUST match the actual file format (image/webp here) or browsers
  // will refuse to decode it.
  const DEFAULT_KAWARP_DATA_URL = "data:image/webp;base64,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";
  const DEFAULT_SETTINGS = {
    brightness: 0.78,
    saturation: 1.7,
    blurPasses: 6,
    warpIntensity: 1,
    // Keep the Kawarp backdrop on the cover art even when a music video is
    // playing (AJ, 2026-10-20).
    kawarpCoverArtOnly: false,
    // Custom background (AJ, 2026-10-21). Declared here so the add-on has sane
    // values BEFORE the first settings message arrives.
    customBg: false,
    customBgKawarp: true,
    customBgBlur: 24,
    contrast: 1,
    // Absorbed from the Ambient add-on (AJ, 2026-10-26): the same artwork that
    // feeds the backdrop also tints the player bar. ON, which is what Ambient
    // shipped with.
    artworkAccent: true,
  };
  let currentSettings = Object.assign({}, DEFAULT_SETTINGS);

  function whenYTMod(callback) {
    if (window.YTMod && window.YTMod.player) return callback();
    setTimeout(() => whenYTMod(callback), 200);
  }

  let pageBgRoot = null;
  let pageBgHost = null;
  let pageBarBlur = null;
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

  // Performance mode (AJ, 2026-10-26), mirrored into every add-on's settings by
  // the content script. Ultra = the untouched theme; Normal = 30fps backdrop and
  // no live-video sampling; Low = 24fps, same cover-art-only rule. The numbers
  // match the copies in 04-state-settings.jsfrag and snippet-npv-panel.js.
  const PERFORMANCE_MODES = ["ultra", "normal", "low"];
  let performanceMode = "ultra";

  function normalizePerformanceMode(value) {
    const mode = String(value || "").toLowerCase();
    return PERFORMANCE_MODES.indexOf(mode) === -1 ? "ultra" : mode;
  }

  function kawarpFpsForPerformance() {
    return performanceMode === "low" ? 24 : performanceMode === "normal" ? 30 : 0;
  }

  function videoSamplingAllowed() {
    return performanceMode === "ultra";
  }

  function applySettings(next) {
    performanceMode = normalizePerformanceMode(next && next.performanceMode);
    currentSettings = Object.assign({}, currentSettings, next || {});
    currentSettings.brightness = Math.min(1.2, Math.max(0.5, Number(currentSettings.brightness) || DEFAULT_SETTINGS.brightness));
    currentSettings.saturation = Math.min(2.5, Math.max(0.5, Number(currentSettings.saturation) || DEFAULT_SETTINGS.saturation));
    currentSettings.blurPasses = Math.round(Math.min(8, Math.max(2, Number(currentSettings.blurPasses) || DEFAULT_SETTINGS.blurPasses)));
    currentSettings.warpIntensity = Math.min(1, Math.max(0.2, Number(currentSettings.warpIntensity) || DEFAULT_SETTINGS.warpIntensity));
    currentSettings.kawarpCoverArtOnly = !!currentSettings.kawarpCoverArtOnly;
    // Normalise the custom-background keys. customBgKawarp uses !== false so a
    // missing value keeps the intended default (ON) while an explicit OFF sticks.
    currentSettings.customBg = !!currentSettings.customBg;
    currentSettings.customBgKawarp = currentSettings.customBgKawarp !== false;
    currentSettings.customBgBlur = Math.min(60, Math.max(0,
      Number(currentSettings.customBgBlur) || DEFAULT_SETTINGS.customBgBlur));
    currentSettings.contrast = Math.min(1.6, Math.max(0.6,
      Number(currentSettings.contrast) || DEFAULT_SETTINGS.contrast));
    // !== false, so a settings message that arrives before the key exists keeps
    // the glow rather than reading "missing" as off.
    currentSettings.artworkAccent = currentSettings.artworkAccent !== false;
    KAWARP_OPTIONS.warpIntensity = currentSettings.warpIntensity;
    KAWARP_OPTIONS.blurPasses = currentSettings.blurPasses;
    KAWARP_OPTIONS.saturation = currentSettings.saturation;
    if (kawarpCanvas) {
      kawarpCanvas.style.filter =
        `saturate(${currentSettings.saturation}) brightness(${currentSettings.brightness}) contrast(${currentSettings.contrast || 1})`;
    }
    if (kawarpInstance) {
      kawarpInstance.setOptions({
        warpIntensity: currentSettings.warpIntensity,
        blurPasses: currentSettings.blurPasses,
        saturation: currentSettings.saturation,
      });
      try { kawarpInstance.setMaxFps(kawarpFpsForPerformance()); } catch (_) {}
    }
    // A mode that forbids live sampling has to let go of a feed that is already
    // running, not just refuse the next one.
    if (!videoSamplingAllowed()) syncVideoFeed();
    // Custom background: reload the blob if the flag flipped, then repaint.
    if (customBgState === "ready" && customImgEl) applyCustomImgFilter();
    syncArtworkAccent();
    updateArtworkAccent(getCurrentTrack());
    syncCustomBg().then(() => {
      if (customBgState === "ready" && customBgUrl && !currentSettings.customBgKawarp) {
        showCustomImg();
        return;
      }
      if (currentSettings.customBgKawarp) removeCustomImg();
      updateKawarpBackground(getCurrentTrack());
    });
  }

  /* ===== artwork accent (AJ, 2026-10-26) =================================
     Absorbed from the Ambient add-on, which shipped as a card of its own. It
     reads the same artwork this theme's backdrop is built from, so it lives
     here: the cover is sampled once per track, and the player bar's progress
     line, sliders and switches take its colour, with a soft glow on the line.

     Sampling is Ambient's, unchanged: a 32px draw weighted by saturation, so a
     dark or washed-out cover still yields something readable, and a green
     fallback when the image cannot be read at all. The style element exists only
     while the switch is on, so turning it off leaves the bar as YouTube paints
     it. */
  const ACCENT_FALLBACK = "#1DB954";
  // Ambient's glow slider was removed from the UI before it was retired, and the
  // stronger look it shipped with is the one to keep.
  const ACCENT_GLOW = 1.5;
  let accentStyle = null;
  let accentColor = ACCENT_FALLBACK;
  let accentArtworkUrl = "";
  let accentRequestSeq = 0;

  const accentClamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function accentRgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: lightness };
    const delta = max - min;
    const saturation = lightness > 0.5
      ? delta / (2 - max - min)
      : delta / (max + min);
    let hue;
    switch (max) {
      case r: hue = (g - b) / delta + (g < b ? 6 : 0); break;
      case g: hue = (b - r) / delta + 2; break;
      default: hue = (r - g) / delta + 4; break;
    }
    return { h: hue / 6, s: saturation, l: lightness };
  }

  function accentHueToRgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  function accentHslToHex(h, s, l) {
    let r;
    let g;
    let b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = accentHueToRgb(p, q, h + 1 / 3);
      g = accentHueToRgb(p, q, h);
      b = accentHueToRgb(p, q, h - 1 / 3);
    }
    return "#" + [r, g, b]
      .map((value) => Math.round(value * 255).toString(16).padStart(2, "0"))
      .join("");
  }

  function sampleAccentColour(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return reject(new Error("Canvas sampling is unavailable."));
        try {
          context.drawImage(image, 0, 0, 32, 32);
          const pixels = context.getImageData(0, 0, 32, 32).data;
          let red = 0;
          let green = 0;
          let blue = 0;
          let weightTotal = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const hsl = accentRgbToHsl(r, g, b);
            if (hsl.l < 0.08 || hsl.l > 0.94) continue;
            const weight = 0.25 + hsl.s * 1.8;
            red += r * weight;
            green += g * weight;
            blue += b * weight;
            weightTotal += weight;
          }
          if (!weightTotal) return resolve(ACCENT_FALLBACK);
          const hsl = accentRgbToHsl(red / weightTotal, green / weightTotal, blue / weightTotal);
          if (hsl.s < 0.08) {
            return resolve(accentHslToHex(0, 0, accentClamp(hsl.l, 0.52, 0.78)));
          }
          resolve(accentHslToHex(
            hsl.h,
            accentClamp(Math.max(hsl.s, 0.58) * 1.12, 0.58, 0.92),
            accentClamp(hsl.l, 0.42, 0.6)
          ));
        } catch (error) {
          reject(error);
        }
      };
      image.onerror = () => reject(new Error("The artwork could not be sampled."));
      image.src = url;
    });
  }

  function buildAccentCSS() {
    const glow = ACCENT_GLOW;
    const strongBlur = (5 * glow).toFixed(2);
    const softBlur = (11 * glow).toFixed(2);
    const strongAlpha = Math.round(52 * glow);
    const softAlpha = Math.round(24 * glow);
    return `
      :root {
        --ym-artwork-accent: ${accentColor};
      }
      tp-yt-paper-slider {
        --paper-slider-knob-color: var(--ym-artwork-accent) !important;
        --paper-slider-active-color: var(--ym-artwork-accent) !important;
        --paper-slider-secondary-color: color-mix(in srgb, var(--ym-artwork-accent) 48%, transparent) !important;
      }
      tp-yt-paper-toggle-button {
        --paper-toggle-button-checked-bar-color: var(--ym-artwork-accent) !important;
        --paper-toggle-button-checked-button-color: var(--ym-artwork-accent) !important;
        --paper-toggle-button-checked-ink-color: var(--ym-artwork-accent) !important;
      }
      ytmusic-player-bar tp-yt-paper-slider .slider-bar.active,
      ytmusic-player-bar tp-yt-paper-slider #sliderKnob .slider-knob-inner,
      ytmusic-player-bar .progress-bar,
      ytmusic-player-bar .bar,
      ytmusic-player-bar #progress {
        background: var(--ym-artwork-accent) !important;
        transition: background-color .45s ease, box-shadow .45s ease;
        box-shadow:
          0 0 ${strongBlur}px color-mix(in srgb, var(--ym-artwork-accent) ${strongAlpha}%, transparent),
          0 0 ${softBlur}px color-mix(in srgb, var(--ym-artwork-accent) ${softAlpha}%, transparent);
      }
      /* New mini-player bar (2026): the progress line is ONE range input whose
         played fraction lives in an inline gradient that references YouTube's
         baseline tokens — and YouTube rewrites that gradient every second, so
         it cannot be replaced from CSS. Re-point the played-part token inside
         the slider wrapper instead; the inline gradient resolves against it and
         the line follows the artwork with no script on the hot path. */
      /* The 2026 bar's hover dot is a plain range thumb, not a paper-slider
         knob: without this it keeps YouTube's own #ff0033 while the line takes
         the artwork's colour. */
      ytmusic-miniplayer input.ytMusicMiniPlayerProgressBar::-webkit-slider-thumb {
        background-color: var(--ym-artwork-accent) !important;
      }
      ytmusic-miniplayer input.ytMusicMiniPlayerProgressBar::-moz-range-thumb {
        background-color: var(--ym-artwork-accent) !important;
        border: 0;
      }
      ytmusic-miniplayer .ytMusicMiniPlayerProgressBarWrapper {
        --yt-sys-color-baseline--static-brand-red: var(--ym-artwork-accent) !important;
        /* The bar also blends to YouTube's magenta across the most-replayed
           band, so tinting only the red left the line running red-to-pink as it
           grew. Both tokens are the accent now and the played line is one
           colour; the band's unplayed half stays YouTube's grey. */
        --yt-sys-color-baseline--static-magenta: var(--ym-artwork-accent) !important;
      }
    `;
  }

  function setAccent(color) {
    accentColor = color || ACCENT_FALLBACK;
    document.documentElement.style.setProperty("--ym-artwork-accent", accentColor);
  }

  // The switch is the style element's lifetime: on, the tint is in the document;
  // off, the player bar is YouTube's own again with nothing left behind.
  function syncArtworkAccent() {
    if (!currentSettings.artworkAccent) {
      dropArtworkAccent();
      return;
    }
    if (!accentStyle) {
      accentStyle = document.createElement("style");
      accentStyle.id = "ym-dynamic-accent-style";
      document.head.appendChild(accentStyle);
    }
    accentStyle.textContent = buildAccentCSS();
    setAccent(accentColor);
  }

  function updateArtworkAccent(track) {
    if (!currentSettings.artworkAccent) return;
    const artworkUrl = track && track.artworkUrl ? track.artworkUrl : "";
    if (!artworkUrl || artworkUrl === accentArtworkUrl) return;
    accentArtworkUrl = artworkUrl;
    const seq = ++accentRequestSeq;
    sampleAccentColour(artworkUrl).then((color) => {
      if (seq === accentRequestSeq) setAccent(color);
    }, (error) => {
      if (seq === accentRequestSeq) setAccent(ACCENT_FALLBACK);
      console.debug("[Aurora Bloom] Could not sample the artwork:", error);
    });
  }

  function dropArtworkAccent() {
    ++accentRequestSeq;
    accentArtworkUrl = "";
    accentColor = ACCENT_FALLBACK;
    if (accentStyle) {
      accentStyle.remove();
      accentStyle = null;
    }
    document.documentElement.style.removeProperty("--ym-artwork-accent");
  }

  const CSS = `
    .ym-dynamic-page-bg-root {
      background: transparent !important;
      --ytmusic-app-background: transparent !important;
      --ytmusic-player-page-background: transparent !important;
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
    .ym-dynamic-page-bg-host .ym-dynamic-custom-img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      z-index: 0;
      pointer-events: none;
      opacity: 0;
      transform: scale(1.08);
      transition: opacity .5s ease;
    }
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
    .ym-dynamic-page-bg-root ytmusic-app-layout,
    .ym-dynamic-page-bg-root ytmusic-nav-bar,
    .ym-dynamic-page-bg-root ytmusic-player-page,
    .ym-dynamic-page-bg-root ytmusic-watch-page,
    .ym-dynamic-page-bg-root ytmusic-player-bar,
    .ym-dynamic-page-bg-root ytmusic-miniplayer,
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
    /* The player-bar backdrop blur lives on a SEPARATE fixed layer
       (.ym-dynamic-bar-blur) that sits BEHIND the player bar (z-index:3, below
       the bar's z-index:4 interactive layer). We deliberately do NOT put
       backdrop-filter on YTM's own #player-bar-background: it is position:fixed,
       full-width and shares z-index:4 with ytmusic-player-bar, so a filter there
       overlaps the bar's interactive controls and disturbs Chromium's compositor
       — YTM mis-measures the bar width (false narrow mode -> the "More player
       controls" arrow appears on a wide screen) AND the expand-button's mouseout
       is never delivered, leaving #expanding-menu stuck open (AJ-confirmed
       2026-10-07). Keep this element transparent + click-through only. */
    .ym-dynamic-page-bg-root #player-bar-background {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
      pointer-events: none !important;
    }
    .ym-dynamic-bar-blur {
      position: fixed !important;
      left: 0;
      right: 0;
      bottom: 0;
      /* Exactly the player bar, never a fixed 72px: YouTube Modifications can
         shrink the bar (compact mode), and a taller frost layer then pokes its
         1px top border out ABOVE the bar as a line across the whole window
         (AJ, 2026-10-22 — measured at 882 while the compact bar started at
         896). Following the variable keeps the frost on the surface and the
         border on the bar's real edge. */
      height: var(--ytmusic-player-bar-height, 64px);
      box-sizing: border-box;
      z-index: 3 !important;
      pointer-events: none;
      background: rgba(6,6,10,.22);
      -webkit-backdrop-filter: blur(28px) saturate(1.45) brightness(.94);
      backdrop-filter: blur(28px) saturate(1.45) brightness(.94);
      border-top: 1px solid rgba(255,255,255,.1);
      box-shadow: 0 -10px 30px rgba(0,0,0,.12);
    }
    /* The expanding menu (the popup the player-bar arrow reveals) picks up
       YTM's flat opaque bar background, which reads as a dark slab behind the
       controls. Make it frosted glass instead, matching the nav-bar treatment.
       The arrow is then hidden WHILE its menu is open rather than relying on the
       panel covering it, so the panel can stay light without the arrow showing
       through — and hiding it is what native LOOKS like anyway. The arrow must
       stay hit-testable: opacity does not affect hit-testing, so the hover that
       holds the menu open survives. Do NOT add pointer-events:none here, or the
       menu would slam shut the instant the arrow vanished, flickering. */
    .ym-dynamic-page-bg-root #expanding-menu {
      background: rgba(6, 6, 10, .42) !important;
      background-color: rgba(6, 6, 10, .42) !important;
      -webkit-backdrop-filter: blur(26px) saturate(1.4) brightness(.96);
      backdrop-filter: blur(26px) saturate(1.4) brightness(.96);
      border-radius: 8px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, .22);
    }
    .ym-dynamic-page-bg-root .expand-button[aria-expanded="true"] {
      opacity: 0 !important;
    }
    /* The injected add-on icons live at the far right of the same row, past the
       menu's right edge, so they would sit out beside YTM's revealed internal
       controls instead of making way for them. Hide them for as long as the menu
       is open. opacity (not display) keeps the row's geometry stable — collapsing
       it would reflow the bar every time the menu opens and closes. Dropping
       pointer-events is safe here UNLIKE on the arrow: the menu is held open by
       hovering the ARROW, not by hovering these icons. */
    .ym-dynamic-page-bg-root
      #right-controls:has(.expand-button[aria-expanded="true"])
      .ym-pb-carousel {
      opacity: 0 !important;
      pointer-events: none;
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
    /* Do NOT pin width/left/right here. YTM's player bar is position:fixed and
       already full-width; forcing width:auto !important is unnecessary and was
       (wrongly) suspected of breaking the bar's collapse. The real stuck-arrow
       cause was #player-bar-background intercepting pointer events — see that
       rule. The transparent background below is all the Dynamic theme needs. */
    .ym-dynamic-page-bg-root.ym-dynamic-song-mode ytmusic-player-bar,
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode ytmusic-player-bar,
    .ym-dynamic-page-bg-root.ym-dynamic-song-mode ytmusic-miniplayer,
    .ym-dynamic-page-bg-root.ym-dynamic-home-mode ytmusic-miniplayer {
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

  // The <video> actually showing a picture right now. YTM keeps several around
  // (song video, MV player, hover previews), so filter by readiness, playback
  // and a sane on-screen size.
  function findPlayingVideo() {
    // #ym-npv is the Now Playing rail: while it is open on a non-song page it
    // PARKS YTM's live player inside its own art slot, so the video is no
    // longer under any of the YTM containers below. Without this selector the
    // page-wide Kawarp fell back to the still artwork (AJ, 2026-10-19).
    const nodes = document.querySelectorAll(
      "ytmusic-player-page video, #song-video video, ytmusic-player video, #ym-npv video"
    );
    for (const v of nodes) {
      if (!v || v.readyState < 2 || !v.videoWidth) continue;
      if (v.paused) continue;
      const rect = v.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 60) continue;
      return v;
    }
    return null;
  }

  let followingVideo = null;

  // Keeps the backdrop on the live video while one is playing, and hands it
  // back to the artwork the moment it stops (track change, MV -> audio).
  function syncVideoFeed() {
    if (!kawarpInstance || kawarpSuspended) return;
    // Cover-art-only: never follow the video. If one was being followed, the
    // block below hands the feed back to the cover art (AJ, 2026-10-20).
    // ⭐ A CUSTOM BACKGROUND is the same rule (AJ, 2026-10-21): this runs on every
    // tick and called loadVideo() unconditionally, so on the first track change to
    // an MV it quietly replaced the uploaded image with the video. updateKawarp
    // Background() already refused the video, but this second path did not.
    const usingCustom = customBgState === "ready" && !!customBgUrl;
    const v = (usingCustom || currentSettings.kawarpCoverArtOnly || !videoSamplingAllowed())
      ? null
      : findPlayingVideo();
    if (v) {
      if (followingVideo !== v) {
        try {
          kawarpInstance.loadVideo(v, {
            sampleWidth: 72,
            sampleHeight: 128,
            smoothing: 120,
            frameRate: 30,
          });
          followingVideo = v;
          kawarpArtworkUrl = "";
        } catch (e) {}
      }
      return;
    }
    if (followingVideo) {
      followingVideo = null;
      try { kawarpInstance.unloadVideo(); } catch (e) {}
      if (requestedKawarpArtworkUrl) updateKawarpBackground({ artworkUrl: requestedKawarpArtworkUrl });
    }
  }

  /* ===== custom background (AJ, 2026-10-21) =============================
     The blob is written by the panel's file control into IndexedDB; this side
     only READS it. Two render paths:
       Kawarp  — feed the object URL exactly like cover art (same loadImage call)
       blurred — a plain <img> with a CSS filter, which is cheaper than a whole
                 Kawarp pass when the user only wants a soft wallpaper */
  const CUSTOM_BG_EXT_ID = "ytmod-dynamic";
  let customBgUrl = "";
  let customBgState = "off"; // off | loading | ready
  let customImgEl = null;

  function readCustomBgRecord() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open("aurora-bg", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("images")) db.createObjectStore("images");
        };
        req.onsuccess = () => {
          const db = req.result;
          try {
            const tx = db.transaction("images", "readonly");
            const get = tx.objectStore("images").get(CUSTOM_BG_EXT_ID);
            get.onsuccess = () => resolve(get.result || null);
            get.onerror = () => resolve(null);
          } catch (_) { resolve(null); }
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }

  async function syncCustomBg() {
    if (!currentSettings.customBg) {
      if (customBgUrl) { URL.revokeObjectURL(customBgUrl); customBgUrl = ""; }
      customBgState = "off";
      removeCustomImg();
      kawarpArtworkUrl = "";
      return;
    }
    if (customBgState !== "off") return;
    customBgState = "loading";
    const rec = await readCustomBgRecord();
    if (!rec || !rec.blob) { customBgState = "off"; return; }
    customBgUrl = URL.createObjectURL(rec.blob);
    customBgState = "ready";
    // Force the next pass to reload with the new source.
    kawarpArtworkUrl = "";
    requestedKawarpArtworkUrl = "";
  }

  function applyCustomImgFilter() {
    if (!customImgEl) return;
    const blur = Math.max(0, Math.min(60, Number(currentSettings.customBgBlur) || 0));
    const bright = Number(currentSettings.brightness) || 1;
    const sat = Number(currentSettings.saturation) || 1;
    const contrast = Number(currentSettings.contrast) || 1;
    customImgEl.style.filter =
      "blur(" + blur + "px) brightness(" + bright + ") saturate(" + sat +
      ") contrast(" + contrast + ")";
  }

  function showCustomImg() {
    if (!customBgUrl) return false;
    if (pageBgHost && !pageBgHost.isConnected) mountPageBackground();
    if (!pageBgHost) return false;
    if (!customImgEl) {
      customImgEl = document.createElement("img");
      customImgEl.className = "ym-dynamic-custom-img";
      customImgEl.alt = "";
      customImgEl.setAttribute("aria-hidden", "true");
      customImgEl.addEventListener("load", () => { customImgEl.style.opacity = "1"; });
    }
    if (customImgEl.parentElement !== pageBgHost) pageBgHost.appendChild(customImgEl);
    if (customImgEl.getAttribute("src") !== customBgUrl) {
      customImgEl.style.opacity = "0";
      customImgEl.src = customBgUrl;
    }
    applyCustomImgFilter();
    if (kawarpCanvas) kawarpCanvas.classList.remove("ready");
    return true;
  }

  function removeCustomImg() {
    if (customImgEl && customImgEl.parentElement) {
      customImgEl.parentElement.removeChild(customImgEl);
    }
  }

  async function updateKawarpBackground(track) {
    // A custom background WINS over the track's artwork.
    await syncCustomBg();
    if (customBgState === "ready" && customBgUrl) {
      if (!currentSettings.customBgKawarp) { showCustomImg(); return; }
      removeCustomImg();
    } else {
      removeCustomImg();
    }
    const artworkUrl = track && track.artworkUrl ? track.artworkUrl : "";
    requestedKawarpArtworkUrl = artworkUrl;
    const requestId = ++kawarpRequestSeq;
    if (pageBgHost && !pageBgHost.isConnected) mountPageBackground();
    // No track artwork? Show the embedded default gradient as a friendly
    // idle backdrop instead of the host's grey #0f0f0f.
    const sourceUrl = customBgUrl || artworkUrl || DEFAULT_KAWARP_DATA_URL;
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
      if (!kawarpInstance) {
        kawarpInstance = new Kawarp(kawarpCanvas, KAWARP_OPTIONS);
        try { kawarpInstance.setMaxFps(kawarpFpsForPerformance()); } catch (_) {}
      }
      // Music videos: feed the live <video> so the backdrop moves with the
      // picture instead of sitting on a still. Kawarp samples a small colour
      // map, so this stays cheap. Audio tracks fall through to loadImage.
      // ⭐ A custom background must not be hijacked by the playing video. This
      // branch runs BEFORE the source comparison, so an MV would always win and
      // the uploaded image never appeared (AJ, 2026-10-21).
      const usingCustom = customBgState === "ready" && !!customBgUrl;
      const playingVideo = (usingCustom || currentSettings.kawarpCoverArtOnly || !videoSamplingAllowed())
        ? null
        : findPlayingVideo();
      if (playingVideo) {
        try {
          kawarpInstance.loadVideo(playingVideo, {
            sampleWidth: 72,
            sampleHeight: 128,
            smoothing: 120,
            frameRate: 30,
          });
          kawarpArtworkUrl = ""; // force a cover reload once the video is gone
          syncKawarpPlaybackState();
          kawarpCanvas.classList.add("ready");
          return;
        } catch (e) {}
      }
      if (sourceUrl !== kawarpArtworkUrl) {
        try { kawarpInstance.unloadVideo(); } catch (e) {}
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
    pageBgHost.append(kawarpCanvas, shade);

    document.body.appendChild(pageBgHost);
    pageBarBlur = document.createElement("div");
    pageBarBlur.className = "ym-dynamic-bar-blur";
    pageBarBlur.setAttribute("aria-hidden", "true");
    document.body.appendChild(pageBarBlur);
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
    // getSettings() lets other add-ons (the NPV rail) render their own Kawarp
    // with the SAME bloom settings instead of hard-coded values (AJ, 2026-10-19).
    window.__ymAuroraDynamic = {
      suspend: suspendKawarp,
      resume: resumeKawarp,
      getSettings: () => ({ ...currentSettings }),
    };

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
      // ⭐ YTM replaces the app's children on a route change (Home -> watch), which
      // detached the background host and made the custom image "disappear when I
      // switched to the home tab" (AJ, 2026-10-21). Re-mount whenever it is gone.
      if (pageBgHost && !pageBgHost.isConnected) mountPageBackground();
      if (customBgState === "ready" && customBgUrl && !currentSettings.customBgKawarp) {
        showCustomImg();
      }
      const track = getCurrentTrack();
      updateArtworkAccent(track);
      const artworkUrl = track && track.artworkUrl ? track.artworkUrl : "";
      // Skip artwork swaps while suspended: the hidden page Kawarp should do no
      // work at all while the fullscreen one is on screen.
      if (!kawarpSuspended && artworkUrl !== requestedKawarpArtworkUrl) {
        updateKawarpBackground(track);
      }
      syncKawarpPlaybackState();
      syncVideoFeed();
    }
  }

  function startTick() {
    if (!raf) tick();
  }

  function teardown() {
    kawarpSuspended = false;
    dropArtworkAccent();
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
    kawarpArtworkUrl = "";
    requestedKawarpArtworkUrl = "";
    if (pageBarBlur) pageBarBlur.remove();
    pageBarBlur = null;
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
