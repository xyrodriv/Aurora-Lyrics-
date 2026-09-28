/*
 * Artwork Accent - Aurora Lyrics theme.
 *
 * Samples the current track artwork and uses a readable, saturated color for
 * YouTube Music's progress, volume, and toggle controls.
 */
(function () {
  "use strict";

  const EXT_ID = "ytmod-artwork-accent";
  const FALLBACK_COLOR = "#1DB954";
  // Glow slider removed from the catalog on AJ's call (2026-09-28), so the
  // value is no longer user-facing — but the runtime default still matters
  // for new installs (where content.js sends {} and applySettings falls back
  // here). 1.5 = "150%" on the former percent slider.
  const DEFAULT_SETTINGS = { glow: 1.5 };
  let style = null;
  let currentAccent = FALLBACK_COLOR;
  let raf = 0;
  let lastArtworkUrl = "";
  let lastTrackCheckAt = 0;
  let requestSeq = 0;
  let currentSettings = Object.assign({}, DEFAULT_SETTINGS);

  function whenYTMod(callback) {
    if (window.YTMod && window.YTMod.player) return callback();
    setTimeout(() => whenYTMod(callback), 200);
  }

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function rgbToHsl(r, g, b) {
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

  function hueToRgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  function hslToHex(h, s, l) {
    let r;
    let g;
    let b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hueToRgb(p, q, h + 1 / 3);
      g = hueToRgb(p, q, h);
      b = hueToRgb(p, q, h - 1 / 3);
    }
    return "#" + [r, g, b]
      .map((value) => Math.round(value * 255).toString(16).padStart(2, "0"))
      .join("");
  }

  function sampleImage(url) {
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
            const hsl = rgbToHsl(r, g, b);
            if (hsl.l < 0.08 || hsl.l > 0.94) continue;
            const weight = 0.25 + hsl.s * 1.8;
            red += r * weight;
            green += g * weight;
            blue += b * weight;
            weightTotal += weight;
          }
          if (!weightTotal) return resolve(FALLBACK_COLOR);
          const hsl = rgbToHsl(red / weightTotal, green / weightTotal, blue / weightTotal);
          if (hsl.s < 0.08) {
            return resolve(hslToHex(0, 0, clamp(hsl.l, 0.52, 0.78)));
          }
          resolve(hslToHex(
            hsl.h,
            clamp(Math.max(hsl.s, 0.58) * 1.12, 0.58, 0.92),
            clamp(hsl.l, 0.42, 0.6)
          ));
        } catch (error) {
          reject(error);
        }
      };
      image.onerror = () => reject(new Error("Artwork could not be sampled."));
      image.src = url;
    });
  }

  function setAccent(color) {
    currentAccent = color || FALLBACK_COLOR;
    if (!style) return;
    document.documentElement.style.setProperty("--ym-artwork-accent", currentAccent);
  }

  function applySettings(next) {
    const glow = Number(next && next.glow);
    currentSettings.glow = Number.isFinite(glow)
      ? clamp(glow, 0, 1.5)
      : DEFAULT_SETTINGS.glow;
    if (style) style.textContent = buildCSS();
  }

  function buildCSS() {
    const glow = currentSettings.glow;
    const strongBlur = (5 * glow).toFixed(2);
    const softBlur = (11 * glow).toFixed(2);
    const strongAlpha = Math.round(52 * glow);
    const softAlpha = Math.round(24 * glow);
    const shadow = glow > 0
      ? `box-shadow:
          0 0 ${strongBlur}px color-mix(in srgb, var(--ym-artwork-accent) ${strongAlpha}%, transparent),
          0 0 ${softBlur}px color-mix(in srgb, var(--ym-artwork-accent) ${softAlpha}%, transparent);`
      : "box-shadow: none;";
    return `
      :root {
        --ym-artwork-accent: ${currentAccent};
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
        ${shadow}
      }
    `;
  }

  async function updateAccent(track) {
    const artworkUrl = track && track.artworkUrl ? track.artworkUrl : "";
    if (!artworkUrl || artworkUrl === lastArtworkUrl) return;
    lastArtworkUrl = artworkUrl;
    const seq = ++requestSeq;
    try {
      const color = await sampleImage(artworkUrl);
      if (seq === requestSeq) setAccent(color);
    } catch (error) {
      if (seq === requestSeq) setAccent(FALLBACK_COLOR);
      console.debug("[Artwork Accent] Could not sample artwork:", error);
    }
  }

  function buildUI() {
    if (document.getElementById("ym-artwork-accent-style")) return;
    style = document.createElement("style");
    style.id = "ym-artwork-accent-style";
    style.textContent = buildCSS();
    document.head.appendChild(style);
    setAccent(FALLBACK_COLOR);
    startTick();
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    if (!window.YTMod || !window.YTMod.player) return;
    const now = performance.now();
    if (now - lastTrackCheckAt < 500) return;
    lastTrackCheckAt = now;
    const track = window.YTMod.player.getTrack();
    updateAccent(track);
  }

  function startTick() {
    if (!raf) tick();
  }

  function teardown() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    ++requestSeq;
    lastArtworkUrl = "";
    lastTrackCheckAt = 0;
    currentAccent = FALLBACK_COLOR;
    if (style) style.remove();
    document.documentElement.style.removeProperty("--ym-artwork-accent");
    style = null;
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.id !== EXT_ID) return;
    if (data.type === "ytmod-settings") {
      applySettings(data.settings);
      return;
    }
    if (data.type !== "ytmod-ext") return;
    if (data.action === "disable") teardown();
  });

  whenYTMod(buildUI);
})();
