/*
 * Aurora Lyrics — content script (injected into music.youtube.com) v0.5.11
 *
 * Our own injector. The Aurora Lyrics API, the registry, and the marketplace UI
 * are unchanged in spirit from v0.3.0; only the entry point and storage
 * differ (GM_setValue -> chrome.storage.local, GM_addStyle -> injected <style>).
 *
 * v0.5.0 redesigns the marketplace to mirror Spicetify's marketplace:
 *   - Top: tab bar (Extensions / Themes / Installed).
 *   - Top-right: view + density + floating toggles.
 *   - Body: responsive grid of cards (thumbnail / name / author / stars /
 *     description / tags / last-updated) with Install / Coming-soon / toggle
 *     actions per card.
 *
 * TRUSTED TYPES: YouTube Music enforces a TrustedHTML policy that blocks EVERY
 * string-to-HTML/XML sink — innerHTML, insertAdjacentHTML, AND DOMParser for
 * both text/html and application/xml. So ALL DOM is built with
 * createElement/appendChild/textContent/createElementNS only. Never use innerHTML.
 */

(() => {
  "use strict";

  /* ---- DOM helpers (Trusted-Types safe) ---- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // Expose the extension root to PAGE-world snippets (they are injected as
  // <script src> and have no chrome.runtime). data-* is readable across worlds.
  try { document.documentElement.dataset.ymExtBase = chrome.runtime.getURL(""); } catch (_) {}

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v);
    }
    for (const kid of kids) {
      if (kid == null) continue;
      e.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return e;
  }

  function svgIcon(d) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill-rule", "evenodd");
    svg.appendChild(p);
    return svg;
  }

  const ICON_APPS = "M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z";
  const ICON_CLOSE = "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z";
  const ICON_BACK = "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z";
  const ICON_GRID = "M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z";
  const ICON_LIST = "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zm0-10v2h14V7H7z";
  const ICON_DENSITY = "M3 5h18v2H3zm0 6h18v2H3zm0 6h18v2H3z";
  const ICON_FLOAT = "M4 4h16v16H4V4zm2 2v12h12V6H6zm2 2h8v2H8V8zm0 4h5v2H8v-2z";
  const ICON_DELETE = "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5-1-1h-5l-1 1H5v2h14V4z";
  const ICON_CHEVRON = "M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z";
  // Sliders, drawn as three line + knob pairs. The lines STOP short of each knob:
  // every icon svg here is filled with fill-rule="evenodd", so a line crossing a
  // knob would punch a hole through it instead of passing underneath. This is the
  // Settings button's glyph, not an add-on's tile, so it is drawn here rather than
  // taken from MK_GLYPH (AJ, 2026-10-26).
  const ICON_SETTINGS =
    "M4 6h8.8v2H4z M17.2 6H20v2h-2.8z M15 4.9a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2z " +
    "M4 12h2.8v2H4z M11.2 12H20v2h-8.8z M9 10.9a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2z " +
    "M4 18h10.8v2H4z M19.2 18H20v2h-.8z M17 16.9a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2z";

  function makeIconButton(iconPath, onClick, title) {
    const b = h("button", { class: "ym-icon-btn", title: title || "", "aria-label": title || "" });
    b.appendChild(svgIcon(iconPath));
    b.addEventListener("click", onClick);
    return b;
  }

  /* ---- storage (chrome.storage.local; async) ----
     Every read goes through safeStorageGet, because the plain
     `chrome.storage.local.get(key, cb)` form has a failure mode that leaves the
     callback NEVER called.

     Once the extension is reloaded or updated, the content script already running
     in an open tab is orphaned. From that moment every chrome.* call either throws
     "Extension context invalidated" or silently drops its callback. The dropped
     callback is the dangerous half: `renderSection()` awaits getReg() and has
     already cleared #ym-section by then, so the marketplace is left as an empty
     panel — no cards, no empty-state message. That is indistinguishable from
     "no extensions installed", so it reads as the extension being broken rather
     than stale, and reloading the extension with a tab open reproduces it every
     single time.

     So: never trust the callback to arrive. Check lastError, catch the synchronous
     throw, and time the read out. A wrong-but-rendered panel always beats a blank
     one, and `storageReadFailed` lets the caller say WHY it is empty. */
  const STORAGE_TIMEOUT_MS = 1500;
  let storageReadFailed = false;
  function safeStorageGet(key, fallback) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = 0;
      const done = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const fail = (why) => {
        storageReadFailed = true;
        console.warn(`[YTMod] chrome.storage read of "${key}" failed (${why}). The extension was probably reloaded — refresh this tab.`);
        done(fallback);
      };
      timer = setTimeout(() => fail("timed out, callback never fired"), STORAGE_TIMEOUT_MS);
      try {
        chrome.storage.local.get(key, (r) => {
          if (chrome.runtime.lastError) {
            fail(chrome.runtime.lastError.message);
            return;
          }
          const value = r ? r[key] : undefined;
          done(value == null ? fallback : value);
        });
      } catch (err) {
        // "Extension context invalidated" throws synchronously, right here.
        fail((err && err.message) || "context invalidated");
      }
    });
  }
  function safeStorageSet(payload) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = 0;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        console.warn("[YTMod] chrome.storage write timed out; the extension was probably reloaded.");
        done();
      }, STORAGE_TIMEOUT_MS);
      try {
        chrome.storage.local.set(payload, () => {
          if (chrome.runtime.lastError) {
            console.warn("[YTMod] chrome.storage write failed:", chrome.runtime.lastError.message);
          }
          done();
        });
      } catch (err) {
        console.warn("[YTMod] chrome.storage write threw:", (err && err.message) || err);
        done();
      }
    });
  }
  const getReg = () => safeStorageGet("ytmod_registry", {});
  const setReg = (reg) => safeStorageSet({ ytmod_registry: reg });
  // Persisted marketplace preferences (view, density, floating mode, and position).
  const getUI = () => safeStorageGet("ytmod_ui", {});
  const setUI = (patch) => safeStorageSet({
    ytmod_ui: Object.assign({
      view: ui.view,
      density: ui.density,
      floating: ui.floating,
      floatX: ui.floatX,
      floatY: ui.floatY,
      dev: ui.dev,
    }, patch),
  });
  // Performance mode (AJ, 2026-10-26). GLOBAL, not per add-on: one governor over
  // the three Kawarp backdrops (page, Now Playing rail, fullscreen), so it is
  // stored once and mirrored into every add-on's settings envelope by
  // postExtensionSettings(). Add-ons treat it as a cap on top of their own
  // toggles; nothing here flips a user's add-on switch behind their back.
  const PERFORMANCE_KEY = "ytmod_performance_mode";
  const PERFORMANCE_MODES = ["ultra", "normal", "low"];
  // Add-ons Low mode takes out entirely. Aurora Flow is pure motion — page
  // transitions, panel reflow, micro-interactions — so it is the one add-on
  // where a slower machine buys back real frames by losing it. It has no on/off
  // switch of its own (once installed it is always on), so a "disabled" record
  // would leave a row that still says Installed with nothing running; Low
  // UNINSTALLS it instead and remembers that it did, so Normal/Ultra puts it
  // back and nothing the user removed themselves is ever reinstalled
  // (AJ, 2026-10-26).
  const LOW_MODE_SUSPENDED = ["ytmod-smooth-motion"];
  const PERF_SUSPENDED_KEY = "ytmod_perf_suspended";
  let performanceMode = "ultra";
  let performanceModeReady = null;
  const normalizePerformanceMode = (value) => {
    const mode = String(value || "").toLowerCase();
    return PERFORMANCE_MODES.indexOf(mode) === -1 ? "ultra" : mode;
  };
  const lowModeBlocks = (id) =>
    performanceMode === "low" && LOW_MODE_SUSPENDED.indexOf(id) !== -1;
  const lowModeNotice = (id) => {
    const ext = findAvail(id);
    return "Performance mode is set to Low. Choose Normal or Ultra in Settings to use " +
      (ext ? ext.name : "this add-on") + ".";
  };
  const getPerformanceSuspended = () => safeStorageGet(PERF_SUSPENDED_KEY, {});
  const setPerformanceSuspended = (map) => safeStorageSet({ [PERF_SUSPENDED_KEY]: map });
  // Removes an add-on without the "restart required" notice: the governor is not
  // the user uninstalling something, and its teardown is the same one the normal
  // path sends. Mirrors uninstall() minus the UI, the toast and the scrim.
  async function suspendAddon(id) {
    const reg = await getReg();
    if (!reg[id]) return;
    applyExtension(id, false);
    delete reg[id];
    await setReg(reg);
    await removeExtensionSettings(id);
    await bgDel(id);
  }

  // Puts back one Low removed. Re-added at enabled:true because that is the only
  // state Aurora Flow ever has.
  async function restoreSuspendedAddon(id) {
    const ext = findAvail(id);
    const reg = await getReg();
    if (!ext || reg[id]) return;
    reg[id] = { enabled: true, version: ext.version || "?", installedAt: Date.now() };
    await setReg(reg);
    applyExtension(id, true);
  }

  // Applies the mode's add-on restrictions: out on the way into Low, back on the
  // way out. Runs BEFORE the registry is applied at boot, so Low never mounts an
  // add-on just to tear it down.
  async function applyPerformanceRestrictions(mode) {
    const suspended = (await getPerformanceSuspended()) || {};
    const reg = await getReg();
    let dirty = false;
    if (mode === "low") {
      for (const id of LOW_MODE_SUSPENDED) {
        if (!reg[id]) continue;
        // Quiet: the mode toast is the notification, not a second one.
        await suspendAddon(id);
        suspended[id] = true;
        dirty = true;
      }
    } else {
      const ids = Object.keys(suspended);
      for (const id of ids) {
        // Only what Low removed — the map never holds anything the user
        // uninstalled for their own reasons.
        if (!reg[id]) await restoreSuspendedAddon(id);
        delete suspended[id];
      }
      if (ids.length) dirty = true;
    }
    if (dirty) await setPerformanceSuspended(suspended);
  }
  const loadPerformanceMode = () => {
    if (!performanceModeReady) {
      performanceModeReady = safeStorageGet(PERFORMANCE_KEY, "ultra").then((value) => {
        performanceMode = normalizePerformanceMode(value);
        return performanceMode;
      });
    }
    return performanceModeReady;
  };
  const storePerformanceMode = (value) => {
    performanceMode = normalizePerformanceMode(value);
    performanceModeReady = Promise.resolve(performanceMode);
    return safeStorageSet({ [PERFORMANCE_KEY]: performanceMode });
  };
  // Re-post every enabled add-on's settings so a mode change lands immediately
  // instead of on the next track change or reload.
  const pushPerformanceMode = async () => {
    const reg = await getReg();
    for (const id of Object.keys(reg)) {
      if (!reg[id] || !reg[id].enabled) continue;
      const ext = findAvail(id);
      if (!ext) continue;
      const settings = await getExtensionSettings(ext);
      postExtensionSettings(id, settings);
    }
  };
  // Set by the Settings page while it is on screen, so a value that lands late
  // (storage read, or a change made elsewhere) repaints the chosen mode.
  let performancePaint = null;
  const performanceLabel = (mode) => mode.charAt(0).toUpperCase() + mode.slice(1);
  // Called straight from the Settings page — no message round-trip: the page and
  // the store live in this same script, and a postMessage would only be read
  // back by the page world, which has no use for it.
  async function choosePerformanceMode(raw) {
    const mode = normalizePerformanceMode(raw);
    await storePerformanceMode(mode);
    await pushPerformanceMode();
    // Off/on for the add-ons Low does not run, then a quiet re-render so the
    // rail greys those rows out (or un-greys them) immediately.
    await applyPerformanceRestrictions(mode);
    renderSection(true);
    if (performancePaint) performancePaint(mode);
    toast("Performance: " + performanceLabel(mode));
  }

  const EXT_SETTINGS_KEY = "ytmod_settings";
  let extensionSettingsStore = null;
  let extensionSettingsWrite = Promise.resolve();
  const getExtensionSettingsStore = () => {
    if (extensionSettingsStore) return Promise.resolve(extensionSettingsStore);
    return safeStorageGet(EXT_SETTINGS_KEY, {}).then((value) => {
      extensionSettingsStore = value || {};
      return extensionSettingsStore;
    });
  };
  const settingNumber = (setting, value) => {
    const numeric = Number(value);
    const fallback = Number(setting.default);
    const clamped = Number.isFinite(numeric) ? numeric : fallback;
    return Math.min(Number(setting.max), Math.max(Number(setting.min), clamped));
  };
  const settingValue = (setting, value) => {
    if (setting.type === "text") {
      const text = value == null ? "" : String(value);
      return text.slice(0, Number(setting.maxLength) || 200);
    }
    if (setting.type === "toggle") {
      if (typeof value === "string") {
        return !/^(false|0|off|no)$/i.test(value.trim());
      }
      return value == null ? Boolean(setting.default) : Boolean(value);
    }
    if (setting.type === "order") {
      // Ordered list of ids. Without this branch it would fall through to
      // settingNumber and become NaN, wiping the default order.
      const allowed = (setting.options || []).map((option) => option.id);
      const given = Array.isArray(value) ? value.map(String) : [];
      const out = given.filter((id) => allowed.indexOf(id) !== -1);
      for (const id of allowed) if (out.indexOf(id) === -1) out.push(id);
      return out;
    }
    if (setting.type === "file") {
      // ⭐ Boolean, NOT a number. Without this branch a file setting fell through
      // to settingNumber(), which turns `false` into 0 and then clamps against
      // undefined min/max — producing NaN. NaN is falsy, so the custom background
      // switched itself off the moment settings were re-read (panel reopen, page
      // reload), which looked like "it reverts to Kawarp" (AJ, 2026-10-21).
      // The blob itself lives in IndexedDB; this key only means "an image is set".
      if (typeof value === "string") return !/^(false|0|off|no|)$/i.test(value.trim());
      return value === true || value === 1;
    }
    return settingNumber(setting, value);
  };
  const getExtensionDefaults = (ext) => Object.fromEntries(
    (ext.settings || [])
      // Section headers (type:"header") are display-only and have no key, so
      // they must be filtered out before Object.fromEntries or the result
      // would contain a junk `undefined` key that breaks getExtensionSettings.
      .filter((setting) => setting.type !== "header")
      .map((setting) => [setting.key, settingValue(setting, setting.default)])
  );
  const getExtensionSettings = async (ext) => {
    const store = await getExtensionSettingsStore();
    const defaults = getExtensionDefaults(ext);
    const saved = store[ext.id] || {};
    const out = Object.fromEntries(
      Object.keys(defaults).map((key) => {
        const setting = ext.settings.find((item) => item.key === key);
        return [key, settingValue(setting, saved[key] == null ? defaults[key] : saved[key])];
      })
    );
    // Keys outside the add-on catalog (the custom font block) have no `setting`
    // descriptor, so the loop above drops them. Without this they vanish on the
    // next open: the panel then claims "default font" while the lyrics still use
    // the custom face, and Default can no longer clear it (AJ, 2026-10-20).
    if (saved.customFont != null) out.customFont = saved.customFont;
    if (saved.customFontScale != null) out.customFontScale = saved.customFontScale;
    return out;
  };
  const saveExtensionSettings = (id, values) => {
    extensionSettingsWrite = extensionSettingsWrite.then(async () => {
      const store = await getExtensionSettingsStore();
      extensionSettingsStore = Object.assign({}, store, { [id]: Object.assign({}, values) });
      await new Promise((res) => chrome.storage.local.set({ [EXT_SETTINGS_KEY]: extensionSettingsStore }, res));
    });
    // A theme's settings ARE its styling, so they take effect immediately rather
    // than on the next page load. Saved first, classed second: if the write is
    // interrupted the classes stay consistent with what the panel is showing.
    const ext = findAvail(id);
    if (ext && ext.cssUrl) applyThemeOptions(ext, values);
    return extensionSettingsWrite;
  };
  const removeExtensionSettings = (id) => {
    extensionSettingsWrite = extensionSettingsWrite.then(async () => {
      const store = await getExtensionSettingsStore();
      const next = Object.assign({}, store);
      delete next[id];
      extensionSettingsStore = next;
      await new Promise((res) => chrome.storage.local.set({ [EXT_SETTINGS_KEY]: extensionSettingsStore }, res));
    });
    return extensionSettingsWrite;
  };
  const postExtensionSettings = (id, settings) => {
    // performanceMode rides along in EVERY add-on's envelope: it is one global
    // governor (see PERFORMANCE_KEY above), and this is the only chokepoint every
    // settings post passes through.
    window.postMessage({
      type: "ytmod-settings",
      id,
      settings: Object.assign({}, settings, { performanceMode }),
    }, "*");
  };
  const PERMANENT_LYRICS_KEY = "ytmod_spicy_lyrics_ttml";
  const getPermanentLyrics = (trackKey) => new Promise((res) => {
    chrome.storage.local.get(PERMANENT_LYRICS_KEY, (r) => {
      const saved = r[PERMANENT_LYRICS_KEY] || {};
      res(typeof saved[trackKey] === "string" ? saved[trackKey] : null);
    });
  });
  const setPermanentLyrics = (trackKey, xml) => new Promise((res) => {
    chrome.storage.local.get(PERMANENT_LYRICS_KEY, (r) => {
      const saved = Object.assign({}, r[PERMANENT_LYRICS_KEY] || {});
      saved[trackKey] = xml;
      chrome.storage.local.set({ [PERMANENT_LYRICS_KEY]: saved }, res);
    });
  });
  const removePermanentLyrics = (trackKey) => new Promise((res) => {
    chrome.storage.local.get(PERMANENT_LYRICS_KEY, (r) => {
      const saved = Object.assign({}, r[PERMANENT_LYRICS_KEY] || {});
      delete saved[trackKey];
      chrome.storage.local.set({ [PERMANENT_LYRICS_KEY]: saved }, res);
    });
  });
  // ---- Spicy Lyrics API cache -----------------------------------------------
  // The /v1/lyrics endpoint is rate-limited. Entries carry a 30-day `exp`
  // (SPICY_CACHE_TTL_MS in the page script — the ToS s7 ceiling; upstream's
  // 3-day window was dropped on 2026-10-07). This side only stores the object;
  // expiry is enforced by the page script, which sweeps on every read. Stored
  // as one object so
  // a single read/write covers the whole cache; entries carry their own
  // `exp` stamp and are dropped lazily on read.
  const SPICY_CACHE_KEY = "ytmod_spicy_lyrics_cache";
  // The cache is read at most once per page load, so a byte count here is cheap
  // — and it was the only way to tell a genuinely empty cache apart from one
  // that failed to load, which is what a "resolver ran but the API never fired"
  // report looks like from the page world.
  const getSpicyCache = () => new Promise((res) => {
    chrome.storage.local.get(SPICY_CACHE_KEY, (r) => {
      const saved = r[SPICY_CACHE_KEY];
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        console.debug(`[YTMod] Spicy cache loaded: ${Object.keys(saved).length} entries.`);
        res(saved);
      } else {
        console.debug("[YTMod] Spicy cache empty or unreadable; starting fresh.");
        res({});
      }
    });
  });
  const setSpicyCache = (cache) => new Promise((res) => {
    const count = cache && typeof cache === "object" ? Object.keys(cache).length : 0;
    chrome.storage.local.set({ [SPICY_CACHE_KEY]: cache }, () => {
      // A dropped entry here means the page world handed us an object it could
      // not serialise (a cycle, or a structured-clone-hostile value), which
      // silently costs a re-fetch on the next play.
      if (chrome.runtime.lastError) {
        console.warn(`[YTMod] Spicy cache write FAILED (${count} entries):`, chrome.runtime.lastError.message);
      } else {
        console.debug(`[YTMod] Spicy cache stored: ${count} entries.`);
      }
      res();
    });
  });
  const clearSpicyCache = () => new Promise((res) => {
    chrome.storage.local.remove(SPICY_CACHE_KEY, () => {
      if (chrome.runtime.lastError) {
        console.warn("[YTMod] Spicy cache clear failed:", chrome.runtime.lastError.message);
      } else {
        console.debug("[YTMod] Spicy cache cleared.");
      }
      res();
    });
  });
  const LRCLIB_ORIGIN = "https://lrclib.net";
  const LRCLIB_PATHS = new Set(["/api/get", "/api/search"]);
  const MUSICBRAINZ_ORIGIN = "https://musicbrainz.org";
  // MusicBrainz asks clients to keep request volume low. The resolver calls
  // this only after ListenBrainz misses, and this gate makes the fallback
  // polite even when several tracks change quickly.
  let musicBrainzNextAt = 0;
  const spotifyArtworkCache = new Map();
  const fetchLRCLIB = async (rawUrl) => {
    const url = new URL(String(rawUrl || ""));
    if (url.origin !== LRCLIB_ORIGIN || !LRCLIB_PATHS.has(url.pathname)) {
      throw new Error("Unsupported LRCLIB endpoint.");
    }
    const response = await fetch(url.href, {
      headers: { Accept: "application/json" },
      credentials: "omit",
    });
    return {
      ok: response.ok,
      status: response.status,
      data: response.ok ? await response.json() : null,
    };
  };
  const waitForMusicBrainz = async () => {
    const now = Date.now();
    const wait = Math.max(0, musicBrainzNextAt - now);
    musicBrainzNextAt = Math.max(now, musicBrainzNextAt) + 1100;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  };
  const quoteMusicBrainz = (value) => String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .trim();
  /* MusicBrainz's SEARCH endpoint never carries URL relationships: `inc` is a
     LOOKUP parameter, so `recordings[].relations` is always absent and the
     Spotify link could never be found there however well the search matched —
     "Ready or Not" by brakence was the visible case (AJ, 2026-10-22). The
     search stays a single request; the top candidates are then looked up by
     MBID, where relations DO come back, and those relations are merged onto the
     candidate so callers keep scoring exactly what they always did.

     Query shape is deliberately title + artist only. `dur:` and `release:` used
     to be ANDed in, which silently zeroed recall whenever YouTube's duration
     (music videos run long) or album spelling differed — and duration is
     already a scoring hint on the caller's side. */
  const MB_RELATION_LOOKUPS = 3;
  const musicBrainzSpotifyRelation = (relation) => {
    const resource = String(relation && relation.url && relation.url.resource || "");
    return /^spotify:track:[A-Za-z0-9]{22}$/i.test(resource) ||
      /open\.spotify\.com\/(?:intl-[^/]+\/)?track\/[A-Za-z0-9]{22}/i.test(resource);
  };

  const fetchMusicBrainzRecordingSearch = async (title, artist, album, durationMs) => {
    const recording = quoteMusicBrainz(title);
    const creditedArtist = quoteMusicBrainz(artist);
    if (!recording) return { ok: false, status: 400, data: null };
    const terms = [`recording:\"${recording}\"`];
    if (creditedArtist) terms.push(`artist:\"${creditedArtist}\"`);
    const url = new URL("/ws/2/recording/", MUSICBRAINZ_ORIGIN);
    url.search = new URLSearchParams({
      query: terms.join(" AND "),
      fmt: "json",
      limit: "10",
    }).toString();
    await waitForMusicBrainz();
    const response = await fetch(url.href, {
      headers: { Accept: "application/json" },
      credentials: "omit",
    });
    if (!response.ok) return { ok: false, status: response.status, data: null };
    const data = await response.json().catch(() => null);
    const recordings = data && Array.isArray(data.recordings) ? data.recordings : [];

    // Each lookup is a rate-limited request, so walk only the head of the
    // relevance list and stop at the first candidate that already carries a
    // Spotify track link. A failure here is TRANSIENT (status 0/429/5xx): the
    // caller must not record a permanent miss for a song we could not inspect.
    let lookups = 0;
    for (const candidate of recordings) {
      if (lookups >= MB_RELATION_LOOKUPS) break;
      if (!candidate || !candidate.id) continue;
      lookups++;
      await waitForMusicBrainz();
      const relUrl = new URL(`/ws/2/recording/${encodeURIComponent(candidate.id)}`, MUSICBRAINZ_ORIGIN);
      relUrl.search = new URLSearchParams({ inc: "url-rels", fmt: "json" }).toString();
      let relResponse = null;
      try {
        relResponse = await fetch(relUrl.href, {
          headers: { Accept: "application/json" },
          credentials: "omit",
        });
      } catch (_) {
        return { ok: false, status: 0, data: null };
      }
      if (relResponse.status === 429 || relResponse.status >= 500) {
        return { ok: false, status: relResponse.status, data: null };
      }
      if (!relResponse.ok) continue; // this candidate is unusable; try the next
      const full = await relResponse.json().catch(() => null);
      if (!full || !Array.isArray(full.relations)) continue;
      candidate.relations = full.relations;
      if (full.relations.some(musicBrainzSpotifyRelation)) break;
    }
    // album / durationMs stay in the signature: the caller passes them for
    // scoring, and dropping the parameters would silently change that contract.
    return { ok: true, status: 200, data: Object.assign({}, data, { recordings }) };
  };
  const fetchSpotifyAlbumArtwork = async (artist, album) => {
    const cacheKey = [artist, album].map((value) => String(value || "").toLowerCase().trim()).join("\u0001");
    if (!artist || !album) return null;
    if (spotifyArtworkCache.has(cacheKey)) return spotifyArtworkCache.get(cacheKey);

    const lookup = (async () => {
      try {
        const musicBrainzUrl = new URL("https://musicbrainz.org/ws/2/release/");
        musicBrainzUrl.search = new URLSearchParams({
          query: `artist:"${artist}" AND release:"${album}"`,
          fmt: "json",
          inc: "url-rels",
          limit: "5",
        }).toString();
        const musicBrainzResponse = await fetch(musicBrainzUrl.href, {
          headers: { Accept: "application/json" },
          credentials: "omit",
        });
        const musicBrainzData = musicBrainzResponse.ok
          ? await musicBrainzResponse.json()
          : null;
        const release = musicBrainzData && Array.isArray(musicBrainzData.releases)
          ? musicBrainzData.releases.find((item) =>
            String(item.title || "").toLowerCase().trim() === String(album).toLowerCase().trim()
          ) || musicBrainzData.releases[0]
          : null;
        if (!release || !release.id) return null;

        const releaseUrl = new URL(
          `https://musicbrainz.org/ws/2/release/${encodeURIComponent(release.id)}`
        );
        releaseUrl.search = new URLSearchParams({
          fmt: "json",
          inc: "url-rels",
        }).toString();
        const releaseResponse = await fetch(releaseUrl.href, {
          headers: { Accept: "application/json" },
          credentials: "omit",
        });
        const releaseData = releaseResponse.ok
          ? await releaseResponse.json()
          : release;
        const relation = releaseData && Array.isArray(releaseData.relations)
          ? releaseData.relations.find((item) =>
            item && item.url && /^https:\/\/open\.spotify\.com\/album\/[A-Za-z0-9]+/.test(item.url.resource || "")
          )
          : null;
        let artworkUrl = "";
        if (relation && relation.url && relation.url.resource) {
          const spotifyResponse = await fetch(relation.url.resource, {
            credentials: "omit",
          });
          if (spotifyResponse.ok) {
            const html = await spotifyResponse.text();
            const imageMatch =
              html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) ||
              html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
            artworkUrl = imageMatch && imageMatch[1]
              ? imageMatch[1].replace(/&amp;/g, "&")
              : "";
          }
          if (!artworkUrl) {
            const oembedUrl = new URL("https://open.spotify.com/oembed");
            oembedUrl.search = new URLSearchParams({
              url: relation.url.resource,
            }).toString();
            const oembedResponse = await fetch(oembedUrl.href, {
              headers: { Accept: "application/json" },
              credentials: "omit",
            });
            if (oembedResponse.ok) {
              const oembedData = await oembedResponse.json();
              artworkUrl = typeof oembedData.thumbnail_url === "string"
                ? oembedData.thumbnail_url
                : "";
            }
          }
        }
        return artworkUrl ? {
          trackName: "",
          artistName: artist,
          collectionName: album,
          artworkUrlDirect: artworkUrl,
        } : null;
      } catch (_) {
        return null;
      }
    })();
    spotifyArtworkCache.set(cacheKey, lookup);
    const result = await lookup;
    spotifyArtworkCache.set(cacheKey, Promise.resolve(result));
    return result;
  };

  /* Deezer track search, exposed to add-ons for ISRC lookups.
     Why Deezer: YouTube Music does NOT expose ISRC anywhere in its API —
     verified against /youtubei/v1/player (videoDetails has musicVideoType but
     no isrc) and /youtubei/v1/next (no isrc, no externalIds). Deezer returns
     `isrc` on every track and carries new releases on release day, which
     MusicBrainz does not (AJ, 2026-10-19).

     It MUST go through the service worker: api.deezer.com sends no
     Access-Control-Allow-Origin, and a content script is bound by the page's
     CORS policy. The worker runs on the extension origin and can reach it.
     Falls back to a direct fetch only if the worker is unavailable. */
  const fetchDeezerTracks = async (title, artist, album) => {
    const q = [title, artist, album].filter(Boolean).join(" ").trim();
    if (!q) return { ok: false, status: 400, data: null };
    const url = new URL("https://api.deezer.com/search/track");
    url.search = new URLSearchParams({ q, limit: "10" }).toString();

    const proxied = await Promise.race([
      new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: "ym-fetch-json", url: url.href }, (response) => {
            // lastError is set when no listener exists (worker not running/failed).
            resolve(chrome.runtime.lastError ? null : response || null);
          });
        } catch (_) {
          resolve(null);
        }
      }),
      // A hung worker must not stall the lyrics chain behind it.
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (proxied) return proxied;

    try {
      const response = await fetch(url.href, {
        headers: { Accept: "application/json" },
        credentials: "omit",
      });
      return {
        ok: response.ok,
        status: response.status,
        data: response.ok ? await response.json() : null,
      };
    } catch (error) {
      return { ok: false, status: 0, data: null, error: String(error && error.message) };
    }
  };

  const fetchCoverArt = async (title, artist) => {
    const trackTitle = String(title || "");
    const trackArtist = String(artist || "");
    const deezerParams = new URLSearchParams({
      q: [
        trackArtist ? `artist:"${trackArtist}"` : "",
        trackTitle ? `track:"${trackTitle}"` : "",
      ].filter(Boolean).join(" "),
      limit: "5",
    });
    try {
      const deezerUrl = new URL("https://api.deezer.com/search/track");
      deezerUrl.search = deezerParams.toString();
      const deezerResponse = await fetch(deezerUrl.href, {
        headers: { Accept: "application/json" },
        credentials: "omit",
      });
      const deezerData = deezerResponse.ok ? await deezerResponse.json() : null;
      if (deezerData && Array.isArray(deezerData.data) && deezerData.data.length) {
        const deezerResults = deezerData.data.map((result) => ({
          trackName: result.title,
          artistName: result.artist && result.artist.name,
          collectionName: result.album && result.album.title,
          artworkUrlDirect: result.album && result.album.id
            ? `https://api.deezer.com/album/${encodeURIComponent(result.album.id)}/image?size=xl`
            : "",
          artworkUrl600: result.album && (
            result.album.cover_xl ||
            result.album.cover_big ||
            result.album.cover_medium
          ),
        }));
        const normalize = (value) => String(value || "")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .trim();
        const exact = deezerResults.find((result) =>
          normalize(result.trackName) === normalize(trackTitle) &&
          normalize(result.artistName) === normalize(trackArtist)
        );
        const spotifyArtwork = await fetchSpotifyAlbumArtwork(
          trackArtist,
          exact && exact.collectionName || deezerResults[0].collectionName
        );
        return {
          ok: true,
          status: deezerResponse.status,
          data: {
            results: spotifyArtwork ? [spotifyArtwork, ...deezerResults] : deezerResults,
          },
        };
      }
    } catch (_) {}

    const params = new URLSearchParams({
      term: [trackTitle, trackArtist].filter(Boolean).join(" "),
      media: "music",
      entity: "song",
      country: "us",
      limit: "5",
    });
    const url = new URL("https://itunes.apple.com/search");
    url.search = params.toString();
    const response = await fetch(url.href, {
      headers: { Accept: "application/json" },
      credentials: "omit",
    });
    return {
      ok: response.ok,
      status: response.status,
      data: response.ok ? await response.json() : null,
    };
  };

  /* ---- toast notifications (install / enable / disable) ---- */
  let toastBox;
  function toast(msg) {
    if (!toastBox) {
      toastBox = h("div", { id: "ym-toasts" });
      (overlay || document.body).appendChild(toastBox);
    }
    const t = h("div", { class: "ym-toast", text: msg });
    toastBox.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 320);
    }, 2600);
  }

  // Inject CSS via a <style> element (Trusted-Types safe: textContent, not innerHTML).
  function injectCSS(css) {
    const s = document.createElement("style");
    // Marked so the YouTube page's type scaler never rewrites our own sheets
    // (see ytSheetIsOurs). Theme CSS carries no type today, but a future one
    // could, and silently resizing the panel from YTM's rules is not a trade
    // anyone asked for (AJ, 2026-10-22).
    s.setAttribute("data-ym-owned", "1");
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return s;
  }

  /* ---- available catalog (later: fetch from a GitHub-hosted marketplace.json) ----
     Entry shape: { id, name, author, category, stars, tags, description, version,
                    lastUpdated, css?, cssUrl?, jsUrl?, comingSoon?, github? }
     github: string URL, OR string[] of URLs, OR {label,url}[] — shown in the detail view.
     categories: Extensions | Themes */
  const CAT_COLOR = { Extensions: "#e01040", Themes: "#8e0b26" };

  // The one theme that is a built-in page rather than a stylesheet (see
  // mkAppleThemePage). It has no jsUrl and no cssUrl: its switches ARE the
  // site's prefs, so there is nothing to install and nothing to enable.
  // Named "Style" on purpose: it is a look inspired by Apple Music, not an
  // Apple product, and the card says so (AJ, 2026-10-23).
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
      description: "An Apple Music–style look, gathered on one card: a dark frosted player bar with the song info on the left and the transport centred, the wider lyrics column with its quiet tab strip, the Spicy Lyrics typeface and glass chrome. Nothing to install — every switch changes YouTube Music the moment you touch it.",
      version: "1.0.0",
      lastUpdated: "2026-10-23",
      settings: [],
    },
    // The Aurora CSS theme lived here. Its four player/chrome levers were
    // YouTube Music tweaks rather than a look, so they moved to the YouTube page
    // and then, with the type and the lyrics column, to the Apple Music card
    // above (AJ, 2026-10-23).
    {
      id: "ytmod-dynamic",
      name: "Aurora Bloom",
      author: "Aurora Lyrics",
      category: "Themes",
      stars: 5,
      tags: ["theme", "dynamic", "kawarp", "artwork"],
      description: "An immersive full-screen theme that turns the playing track into a flowing, full-page backdrop.",
      version: "1.0.0",
      lastUpdated: "2026-09-28",
      jsUrl: chrome.runtime.getURL("src/extensions/dynamic.js"),
      settings: [
        { key: "brightness", label: "Brightness", min: 0.5, max: 1.2, step: 0.01, default: 1.12, display: "decimal" },
        { key: "saturation", label: "Saturation", min: 0.5, max: 2.5, step: 0.05, default: 1.60, display: "decimal" },
        { key: "blurPasses", label: "Blur passes", min: 2, max: 8, step: 1, default: 6, display: "passes" },
        { key: "warpIntensity", label: "Warp intensity", min: 0.2, max: 1, step: 0.05, default: 1, display: "decimal" },
        // Music videos don't use Kawarp, so they get their own blurred backdrop
        // (drawn in aurora-lyrics.js). This slider is SEPARATE from "Brightness"
        // above (which drives Kawarp) and controls that MV backdrop's brightness.
        // dev-only (AJ, 2026-09-28). Consumed cross-add-on by Aurora Lyrics.
        { key: "backdropBrightness", label: "Music video backdrop brightness", min: 0, max: 2.0, step: 0.05, default: 1.15, display: "decimal", dev: true },
        // Music videos already always use the Kawarp backdrop (AJ, 2026-10-19),
        // so the old "Prefer Aurora Bloom for music videos" toggle was
        // redundant and has been removed (AJ, 2026-10-20).
        // Never sample the live video; keep the backdrop on the track's cover
        // art even for music videos (AJ, 2026-10-20).
        { key: "kawarpCoverArtOnly", label: "Cover art only (ignore video)", type: "toggle", default: false },
        // The Ambient add-on is this theme's other half: the same artwork, used
        // to tint the player bar and the sliders. It ships ON, which is what
        // Ambient's own default was (AJ, 2026-10-26).
        { key: "artworkAccent", label: "Artwork glow and accent colour", type: "toggle", default: true },
        // Custom background (AJ, 2026-10-21). The blob lives in IndexedDB; the
        // key is only the boolean "an image is set and should be used".
        // The header gives the block its own labelled section instead of letting
        // it trail off the bottom of the Kawarp sliders.
        { type: "header", label: "Custom background" },
        { key: "customBg", label: "Background image", type: "file", default: false },
        { key: "customBgKawarp", label: "Use Kawarp on the image", type: "toggle", default: true },
        { key: "customBgBlur", label: "Blur", min: 0, max: 60, step: 1, default: 24, display: "pixels", disabledWhen: "customBgKawarp" },
        // Contrast applies to the Kawarp canvas AND the blurred image, like
        // brightness/saturation above.
        { key: "contrast", label: "Contrast", min: 0.6, max: 1.6, step: 0.01, default: 1, display: "decimal" },
      ],
    },
    // Ambient used to live here as its own card. It read the same artwork the
    // backdrop does, so it is now a switch on Aurora Bloom above (AJ,
    // 2026-10-26). Its registry record is dropped by the orphan sweep at boot.
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
      // with a second "Unofficial." (AJ, 2026-10-22) — plus a github link to
      // THIS project rather than to Spikerko's repo, which would imply
      // origin/endorsement.
      // Rewritten in plain language (AJ, 2026-10-19): no renderer/API jargon.
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
        // Lyric size ceiling is 600%. Default back to 130% (AJ, 2026-10-07) —
          // 145% (2026-09-28) read too big; 130% is the intended look.
        { key: "size", label: "Lyric size", min: 0.75, max: 6.0, step: 0.05, default: 1.30, display: "percent" },
        // Renderer (AJ, 2026-10-23): WHICH renderer draws WHICH kind of track,
        // named on the row itself instead of hanging off a master toggle. Both
        // defaults are the renderer each kind was built for — Spicy for
        // word-by-word karaoke, the Apple Music engine for line-by-line — and
        // flipping both swaps them.
        // They get their own rail tab (LYRICS_GROUPS, "renderer"), not a header
        // row — the panel strips header rows now that the rail names sections.
        { key: "amllWordTracks", label: "Apple Music for word-by-word", type: "toggle", default: false },
        { key: "spicyLineTracks", label: "Spicy lyrics for line-by-line", type: "toggle", default: false },
        // On-device English translation of non-English lines (Chrome 138+ desktop).
        // ON by default (AJ, 2026-10-26). It may download a language pack, but
        // only when a foreign line actually appears, and that is the song where
        // the second line earns its space.
        { key: "autoTranslate", label: "English translation of foreign lyrics", type: "toggle", default: true },
        { key: "legibilityBackdrop", label: "Dark shade behind lyrics", type: "toggle", default: false },
        // In-page fullscreen (AJ, 2026-10-22): the overlay stays inside the tab,
        // so the tab strip, other tabs and the rest of the desktop keep working
        // while the fullscreen view is up. Off by default — the native behaviour
        // is unchanged until it is switched on.
        { key: "fullscreenInPage", label: "Fullscreen stays inside the tab", type: "toggle", default: false },
        // Joins each word into one whole-word fill — no per-syllable/letter karaoke
        // stepping, so a word lights up as a single unit. The Spicy Lyrics
        // "whole word" toggle (AJ, 2026-10-19).
        { key: "joinSyllables", label: "Join syllables into words", type: "toggle", default: false },
        // Nested under the toggle above (AJ, 2026-10-20). The whole-word join
        // already covered the background-vocal lines, so this exposes that
        // behaviour as a choice instead of hard-coding it. Rendered as an
        // indented child row that only exists while the parent is ON.
        { key: "joinBgSyllables", label: "Also join background lines", type: "toggle", default: true, childOf: "joinSyllables" },
        { type: "header", label: "Scrolling" },
        // smoothScrolling back ON by default (AJ, 2026-10-07) — he prefers the
        // eased glide into the active line. NOT locked while Apple Music style
        // lyrics is on any more: that mode is per-track now, and a word-synced
        // track renders through the Spicy renderer, which honours this toggle.
        // (Line-synced tracks are drawn by the engine, which springs its own
        // scroll regardless.)
        { key: "smoothScrolling", label: "Smooth scrolling", type: "toggle", default: true },
        { key: "scrollLeadEnabled", label: "Start scrolling early", type: "toggle", default: false },
        { key: "scrollLeadMs", label: "Early scroll lead", min: 0, max: 800, step: 10, default: 250, display: "milliseconds" },
        // NOTE: "Use the Spicy Lyrics font across YouTube Music" used to live here.
        // It changes YouTube rather than the lyrics, so it now sits on the panel's
        // own YouTube page (see YT_PREFS_KEY below) where it survives uninstalling
        // this add-on (AJ, 2026-10-22).
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
        // on AJ's call (2026-09-26) — the slider is gone and aurora-lyrics.js pins
        // the offset at its -80px default, so a value stored while the slider
        // existed cannot keep shifting the lyrics with no UI left to undo it.
        // NOTE: "Where lyrics come from" (source reordering) was removed (AJ,
        // 2026-10-19). The resolver now uses a fixed priority — Spicy Lyrics wins
        // when it has the track, LRCLIB as the fallback — so there is no
        // user-facing reordering. lrc.red was retired entirely on 2026-10-22,
        // and Unison on 2026-10-25.
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
      // Toggles removed on AJ's call (2026-09-28). Aurora Flow is always on;
      // every module (left panel reflow, search suggestions, page transitions,
      // micro-interactions) is force-enabled inside smooth-motion.js, so the
      // settings panel renders empty by design.
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
      // Settings removed on AJ's call (2026-09-28): the add-on injects its own
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
      // Preview clip removed (AJ, 2026-10-19): it showed real lyric text, and
      // redistributing copyrighted lyrics in the add-on art is avoidable risk.
      // The preview slot falls back to the brand mark.
      // Settings removed on AJ's call (2026-09-29): the add-on's own defaults
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
       exactly like an add-on (AJ, 2026-10-07) — it is not an always-on tweak.
       The Snippets tab is just this category; nothing else special-cases it, so
       an empty category simply renders that tab's empty state.

       History — two attempts, both built and both parked, so neither gets
       re-tried from scratch:

       1. "Dislike: keep the song playing" (2026-10-07). YTM rates AND advances
          the queue in one motion, so keeping the song meant rating and then
          jumping straight back. It worked, but the track visibly switched away
          and back for a moment — too much churn for a regular user.

       2. "Song / Video toggle" (2026-10-08). YTM renders the premium Song/Video
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
        // Lives here rather than on the panel itself (AJ, 2026-10-19): it is a
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
  const findAvail = (id) => AVAILABLE.find((a) => a.id === id);

  /* ---- applied-style cache (for disable/uninstall) ----
     An extension may ship CSS (injected via injectCSS) and/or JS (a page-world
     script loaded from jsUrl / inline js, so it can use window.YTMod). Both are
     tracked separately and torn down on disable. */
  const applied = {};
  // A theme ships as a FILE (cssUrl) rather than an inline string: a theme is
  // something you write and keep editing, and inlining it here would mean
  // rebuilding the content script for every colour change.
  //
  // It is FETCHED and injected as a <style>, not <link>ed. A <link> to a
  // chrome-extension:// URL is a cross-origin stylesheet request made by the
  // page, and when that is refused the failure is silent: the element sits in
  // the DOM, the file is served, and not one rule applies (AJ, 2026-10-22: the
  // link was present and correct while #player-bar-background kept its 0px
  // border). Fetching from the content script's own origin and writing the text
  // into a <style> is the same path the base stylesheet already takes, and it is
  // the one that demonstrably applies.
  function injectCSSFile(id, url) {
    const style = document.createElement("style");
    style.dataset.ymExt = id;
    (document.head || document.documentElement).appendChild(style);
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.text();
      })
      .then((css) => {
        style.textContent = css;
        console.debug("[YTMod] theme stylesheet applied:", id, css.length + " chars");
      })
      .catch((err) => console.warn("[YTMod] theme stylesheet failed to load:", url, err));
    return style;
  }
  /* Only ONE CSS theme may be live at a time: two stylesheets fighting over the
     same player chrome is not a look, it is a bug. Enabling a theme switches off
     any other enabled theme, and the REGISTRY is written before anything is
     applied — otherwise the boot loop would re-apply both after a reload. */
  async function makeThemeExclusive(id) {
    const ext = findAvail(id);
    if (!ext || !ext.cssUrl) return;
    const reg = await getReg();
    let changed = false;
    for (const otherId of Object.keys(reg)) {
      if (otherId === id) continue;
      const other = findAvail(otherId);
      if (!other || !other.cssUrl || !reg[otherId].enabled) continue;
      reg[otherId].enabled = false;
      applyExtension(otherId, false);
      changed = true;
    }
    if (changed) await setReg(reg);
  }
  /* Theme options are CSS classes on <html>, one per toggle setting:
     ym-theme-<key>. Every rule in a theme stylesheet is gated on one, so a part
     that is switched off costs no rules and no repaint, and a second theme could
     ship its own options without touching this code. */
  const THEME_CLASS_PREFIX = "ym-theme-";
  function applyThemeOptions(ext, values) {
    if (!ext || !ext.cssUrl) return;
    const root = document.documentElement;
    for (const setting of ext.settings || []) {
      if (setting.type !== "toggle" || !setting.key) continue;
      root.classList.toggle(THEME_CLASS_PREFIX + setting.key, !!(values && values[setting.key]));
    }
  }
  function clearThemeOptions() {
    const root = document.documentElement;
    for (const name of Array.from(root.classList)) {
      if (name.indexOf(THEME_CLASS_PREFIX) === 0) root.classList.remove(name);
    }
  }
  function loadExtensionJS(ext) {
    const s = document.createElement("script");
    if (ext.jsUrl) s.src = ext.jsUrl;
    else if (ext.js) s.textContent = ext.js;
    else return null;
    s.className = "ym-ext-script";
    s.dataset.ymExt = ext.id;
    (document.head || document.documentElement).appendChild(s);
    return s;
  }
  function applyExtension(id, on) {
    const ext = findAvail(id);
    if (!ext) return;
    if (on) {
      if (ext.css && !applied[id + "_css"]) applied[id + "_css"] = injectCSS(ext.css);
      if (ext.cssUrl && !applied[id + "_css"]) applied[id + "_css"] = injectCSSFile(id, ext.cssUrl);
      if (ext.cssUrl) getExtensionSettings(ext).then((values) => applyThemeOptions(ext, values));
      if ((ext.jsUrl || ext.js) && !applied[id + "_js"]) {
        applied[id + "_js"] = loadExtensionJS(ext);
        window.postMessage({ type: "ytmod-ext", id, action: "enable" }, "*");
      }
    } else {
      if (ext.cssUrl) clearThemeOptions();
      if (applied[id + "_css"]) { try { applied[id + "_css"].remove(); } catch (e) {} delete applied[id + "_css"]; }
      if (applied[id + "_js"]) {
        window.postMessage({ type: "ytmod-ext", id, action: "disable" }, "*");
        const node = applied[id + "_js"];
        delete applied[id + "_js"];
        setTimeout(() => { try { node.remove(); } catch (e) {} }, 60);
      }
    }
  }

  function formatSettingValue(setting, value) {
    if (setting.type === "text") return value ? "Configured" : "Not set";
    if (setting.type === "toggle") return value ? "On" : "Off";
    if (setting.display === "percent") return Math.round(Number(value) * 100) + "%";
    if (setting.display === "passes") return String(value) + " passes";
    if (setting.display === "pixels") return (Number(value) > 0 ? "+" : "") + String(value) + "px";
    if (setting.display === "minutes") return String(Math.round(Number(value))) + " min";
    if (setting.display === "seconds") return String(Math.round(Number(value))) + "s";
    if (setting.display === "milliseconds") return String(Math.round(Number(value))) + "ms";
    return Number(value).toFixed(2);
  }

  /* Which settings this user is allowed to see. A setting carrying `dev: true` is
     hidden until the 6-tap gesture turns developer mode on (see onTitleTap).

     Headers are structural, so they are filtered against what SURVIVES rather than
     carrying a flag of their own: a heading whose whole block is hidden would
     otherwise be left stranded above nothing. That is exactly the case for
     "TTML settings" with developer mode off. */
  function visibleSettings(ext) {
    const all = (ext && ext.settings) || [];
    if (ui.dev) return all;
    const out = [];
    for (let i = 0; i < all.length; i++) {
      const setting = all[i];
      if (setting.type === "header") {
        let hasVisibleChild = false;
        for (let j = i + 1; j < all.length && all[j].type !== "header"; j++) {
          if (!all[j].dev) { hasVisibleChild = true; break; }
        }
        if (hasVisibleChild) out.push(setting);
        continue;
      }
      if (!setting.dev) out.push(setting);
    }
    return out;
  }

  function mkInfoList(label, items, kind) {
    const row = h("div", { class: "ym-mk-info-row ym-mk-info-" + kind });
    row.appendChild(h("span", { class: "ym-mk-info-label", text: label }));
    const ul = h("ul", { class: "ym-mk-info-list" });
    (items || []).forEach((t) => ul.appendChild(h("li", { text: t })));
    row.appendChild(ul);
    return row;
  }

  /* Draggable priority list (setting type "order").
     Motion follows the panel's own language rather than a generic drag feel:
     rows stagger in with a rise + blur when the settings first paint, and every
     reorder is a FLIP — each displaced row glides to its new slot with a short
     blur, which is the same blur the add-on switch uses (AJ, 2026-10-19).
     Arrow buttons mirror the drag so the list is usable without a pointer. */
  const orderRepaints = new Map(); // setting key -> repaint(), for Reset
  // Deferred apply for the "order" setting. Set whenever the user reorders the
  // lyrics sources; consumed (and cleared) by finishCloseDetail() so the current
  // track only re-resolves ONCE — after the panel closes — instead of on every
  // drag/arrow nudge (AJ, 2026-10-19).
  let pendingOrderPost = null;

  function buildOrderControl(setting, getValues, onChange) {
    const options = Array.isArray(setting.options) ? setting.options : [];
    const byId = new Map(options.map((option) => [option.id, option]));

    const currentOrder = () => {
      // getValues() rather than a captured object: the caller REASSIGNS `values`
      // on every change and on Reset, so a snapshot would go stale.
      const all = getValues() || {};
      const saved = Array.isArray(all[setting.key]) ? all[setting.key] : [];
      const ids = saved.filter((id) => byId.has(id));
      // Anything missing from the saved value is appended, so a partial or
      // corrupted entry can never hide a source from the user.
      for (const option of options) if (ids.indexOf(option.id) === -1) ids.push(option.id);
      return ids;
    };

    const list = h("div", {
      class: "ym-order-list",
      role: "listbox",
      "aria-label": setting.label,
    });
    let dragEl = null;

    // FLIP: measure, mutate the DOM, then animate each moved row from its old
    // position to the new one.
    const flip = (mutate) => {
      const before = new Map();
      Array.from(list.children).forEach((el) => before.set(el, el.getBoundingClientRect()));
      mutate();
      Array.from(list.children).forEach((el) => {
        const prev = before.get(el);
        if (!prev || !el.animate) return;
        const next = el.getBoundingClientRect();
        const dy = prev.top - next.top;
        if (!dy) return;
        el.animate(
          [
            { transform: "translateY(" + dy + "px)", filter: "blur(3px)" },
            { transform: "none", filter: "blur(0px)" },
          ],
          { duration: 300, easing: "cubic-bezier(.22,1,.36,1)" }
        );
      });
    };

    const commit = () => {
      onChange(Array.from(list.children).map((el) => el.dataset.id));
    };

    function move(row, dir) {
      const sibling = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
      if (!sibling) return;
      flip(() => list.insertBefore(row, dir < 0 ? sibling : sibling.nextSibling));
      commit();
    }

    function paint(animateIn) {
      list.replaceChildren();
      const ids = currentOrder();
      ids.forEach((id, index) => {
        const meta = byId.get(id) || { label: id, hint: "" };
        const row = h("div", {
          class: "ym-order-row",
          role: "option",
          draggable: "true",
          "data-id": id,
        });
        const up = h("button", {
          class: "ym-order-move", type: "button", "aria-label": "Move up", title: "Move up", text: "\u2191",
        });
        const down = h("button", {
          class: "ym-order-move", type: "button", "aria-label": "Move down", title: "Move down", text: "\u2193",
        });
        up.addEventListener("click", (ev) => { ev.preventDefault(); move(row, -1); });
        down.addEventListener("click", (ev) => { ev.preventDefault(); move(row, 1); });
        if (index === 0) up.disabled = true;
        if (index === ids.length - 1) down.disabled = true;

        row.append(
          h("span", { class: "ym-order-handle", "aria-hidden": "true", text: "\u28FF" }),
          h("span", { class: "ym-order-num", text: String(index + 1) }),
          h("div", { class: "ym-order-body" },
            h("div", { class: "ym-order-name", text: meta.label || id }),
            meta.hint ? h("div", { class: "ym-order-hint", text: meta.hint }) : null
          ),
          up,
          down
        );

        row.addEventListener("dragstart", (ev) => {
          dragEl = row;
          row.classList.add("dragging");
          if (ev.dataTransfer) {
            ev.dataTransfer.effectAllowed = "move";
            try { ev.dataTransfer.setData("text/plain", id); } catch (_) {}
          }
        });
        row.addEventListener("dragend", () => {
          row.classList.remove("dragging");
          dragEl = null;
          commit();
        });
        row.addEventListener("dragover", (ev) => {
          ev.preventDefault();
          if (!dragEl || dragEl === row) return;
          const rect = row.getBoundingClientRect();
          const after = ev.clientY > rect.top + rect.height / 2;
          // Skip the no-op case, otherwise the row twitches when the pointer is
          // still inside the slot it already occupies.
          if (after && row.nextElementSibling === dragEl) return;
          if (!after && row.previousElementSibling === dragEl) return;
          flip(() => list.insertBefore(dragEl, after ? row.nextSibling : row));
        });

        list.appendChild(row);
      });

      if (animateIn) {
        Array.from(list.children).forEach((el, i) => {
          if (!el.animate) return;
          el.animate(
            [
              { opacity: 0, transform: "translateY(12px)", filter: "blur(5px)" },
              { opacity: 1, transform: "none", filter: "blur(0px)" },
            ],
            { duration: 440, delay: 70 + i * 55, easing: "cubic-bezier(.34,1.4,.5,1)", fill: "backwards" }
          );
        });
      }
    }

    paint(true);
    // Reset to defaults rebuilds the list without the entrance stagger.
    orderRepaints.set(setting.key, () => paint(false));
    return h("div", { class: "ym-detail-setting-row ym-detail-setting-row-order" },
      h("div", { class: "ym-detail-setting-label", text: setting.label }),
      list
    );
  }

  /* ---- Aurora Lyrics: custom lyrics font (AJ, 2026-10-20) --------------------
     Upload a font and preview how it reads in BOTH render modes before applying:
       - line-synced : one whole-line fill (line-timed lyrics)
       - word-synced : per-word fill (Syllable / word karaoke)
     Both previews run off the same demo TTML on the same clock, so what you see is
     what you get. Apply persists `customFont` (a data:/https: src, validated again
     on the extension side) + `customFontScale` (a size-adjust %) via the usual
     ext-settings channel. The extension registers the @font-face and points every
     lyric font-family at `--ym-sl-lyric-font`. */
  const CUSTOM_FONT_MIME = {
    ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
  };

  /* ---- preview motion: the renderer's own primitives, ported verbatim ------
     The preview has to MOVE like the lyrics, not just paint like them. These
     are the exact curves and spring tunings from 03-animation-primitives.jsfrag
     (which are themselves copied from upstream Spicy Lyrics v6.3.20). Copying
     the numbers is the whole point: a hand-tuned ease looks close but drifts
     from the real bounce, and AJ can tell. */
  class CfontSpline {
    constructor(points) {
      const sorted = points.slice().sort((a, b) => a.Time - b.Time);
      this.xs = sorted.map((p) => p.Time);
      this.ys = sorted.map((p) => p.Value);
      this.ks = this.solveTangents();
    }
    solveTangents() {
      const xs = this.xs;
      const ys = this.ys;
      const n = xs.length - 1;
      const a = new Array(n + 1).fill(0);
      const b = new Array(n + 1).fill(0);
      const c = new Array(n + 1).fill(0);
      const r = new Array(n + 1).fill(0);
      for (let i = 1; i < n; i++) {
        const hPrev = xs[i] - xs[i - 1];
        const hNext = xs[i + 1] - xs[i];
        a[i] = 1 / hPrev;
        b[i] = 2 * (1 / hPrev + 1 / hNext);
        c[i] = 1 / hNext;
        r[i] = 3 * ((ys[i] - ys[i - 1]) / (hPrev * hPrev) + (ys[i + 1] - ys[i]) / (hNext * hNext));
      }
      const firstH = xs[1] - xs[0];
      a[0] = 1 / firstH;
      b[0] = 2 / firstH;
      c[0] = 1 / firstH;
      r[0] = (3 * (ys[1] - ys[0])) / (firstH * firstH);
      const lastH = xs[n] - xs[n - 1];
      a[n] = 1 / lastH;
      b[n] = 2 / lastH;
      c[n] = 0;
      r[n] = (3 * (ys[n] - ys[n - 1])) / (lastH * lastH);
      for (let i = 1; i <= n; i++) {
        const m = a[i] / b[i - 1];
        b[i] -= m * c[i - 1];
        r[i] -= m * r[i - 1];
      }
      const ks = new Array(n + 1).fill(0);
      ks[n] = r[n] / b[n];
      for (let i = n - 1; i >= 0; i--) ks[i] = (r[i] - c[i] * ks[i + 1]) / b[i];
      return ks;
    }
    at(value) {
      const xs = this.xs;
      const ys = this.ys;
      const ks = this.ks;
      if (value <= xs[0]) return ys[0];
      if (value >= xs[xs.length - 1]) return ys[ys.length - 1];
      let index = 0;
      while (index < xs.length - 2 && value > xs[index + 1]) index++;
      const x0 = xs[index];
      const x1 = xs[index + 1];
      const width = x1 - x0 || 1;
      const t = (value - x0) / width;
      const rise = ys[index + 1] - ys[index];
      const from = ks[index] * width - rise;
      const to = -ks[index + 1] * width + rise;
      return (1 - t) * ys[index] + t * ys[index + 1] + t * (1 - t) * (from * (1 - t) + to * t);
    }
  }
  class CfontSpring {
    constructor(startPosition, frequency, dampingRatio, goal) {
      this.d = dampingRatio;
      this.f = frequency;
      this.g = goal == null ? startPosition : goal;
      this.p = startPosition;
      this.v = 0;
    }
    Step(dt) {
      const d = this.d;
      const f = this.f * (2 * Math.PI);
      const g = this.g;
      let p = this.p;
      let v = this.v;
      if (d === 1) {
        const q = Math.exp(-f * dt);
        const w = dt * q;
        const c0 = q + w * f;
        const c2 = q - w * f;
        const c3 = w * f * f;
        const o = p - g;
        p = o * c0 + v * w + g;
        v = v * c2 - o * c3;
      } else if (d < 1) {
        const q = Math.exp(-d * f * dt);
        const c = Math.sqrt(1 - d * d);
        const i = Math.cos(dt * f * c);
        const j = Math.sin(dt * f * c);
        const z = c > 1e-5 ? j / c : dt * f + (((dt * f) ** 2) * (c ** 4) / 20 - c * c) * (dt * f) ** 3 / 6;
        const y = f * c > 1e-5 ? j / (f * c) : dt + (((dt * f * c) ** 2) * (f * f * c * c) / 20 - f * f * c * c) * dt ** 3 / 6;
        const o = p - g;
        p = (o * (i + z * d) + v * y) * q + g;
        v = (v * (i - z * d) - o * (z * f)) * q;
      } else {
        const c = Math.sqrt(d * d - 1);
        const r1 = -f * (d + c);
        const r2 = -f * (d - c);
        const ec1 = Math.exp(r1 * dt);
        const ec2 = Math.exp(r2 * dt);
        const o = p - g;
        const co2 = (v - o * r1) / (2 * f * c);
        const co1 = ec1 * (o - co2);
        p = co1 + co2 * ec2 + g;
        v = co1 * r1 + co2 * ec2 * r2;
      }
      this.p = p;
      this.v = v;
      return p;
    }
    SetGoal(goal, replacePosition) {
      this.g = goal;
      if (replacePosition) {
        this.p = goal;
        this.v = 0;
      }
    }
  }
  // Upstream's curves: resting scale 0.95, peak 1.0505 at 70%, settle 1; a
  // dip-and-return Y offset peaking at 90%; a glow that snaps on at 15% and
  // fades out by 100%. Spring tunings are upstream's too.
  const CFONT_SCALE_SPLINE = new CfontSpline([
    { Time: 0, Value: 0.95 }, { Time: 0.7, Value: 1.0505 }, { Time: 1, Value: 1 },
  ]);
  const CFONT_Y_SPLINE = new CfontSpline([
    { Time: 0, Value: 0 }, { Time: 0.9, Value: -(1 / 60) }, { Time: 1, Value: 0 },
  ]);
  const CFONT_GLOW_SPLINE = new CfontSpline([
    { Time: 0, Value: 0 }, { Time: 0.15, Value: 1 }, { Time: 0.6, Value: 1 }, { Time: 1, Value: 0 },
  ]);
  const CFONT_SCALE_SPRING = [0.88, 0.64];
  const CFONT_Y_SPRING = [1.45, 0.4];
  const CFONT_GLOW_SPRING = [1.18, 0.56];
  // NORMAL pace (words ~250–450 ms) with deliberate imperfections: glued
  // part-of-word pairs ("shi|ning", "to|night"), a couple of long words, and
  // uneven gaps so the fill reads like a real track rather than a metronome.
  const CUSTOM_FONT_DEMO_TTML = [
    '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"',
    '     xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="en">',
    '<body dur="13.60"><div begin="00:00.400" end="00:13.400">',
    '<p begin="00:00.400" end="00:04.900" ttm:agent="v1">',
    '<span begin="00:00.400" end="00:00.760" ttm:role="x-word">we</span>',
    '<span begin="00:00.780" end="00:01.060" ttm:role="x-word">were</span>',
    '<span begin="00:01.140" end="00:01.500" ttm:role="x-word">shi</span><span begin="00:01.500" end="00:01.880" ttm:role="x-word" itunes:part-of-word="1">ning</span>',
    '<span begin="00:01.960" end="00:02.220" ttm:role="x-word">so</span>',
    '<span begin="00:02.260" end="00:02.740" ttm:role="x-word">bright</span>',
    '</p>',
    '<p begin="00:05.100" end="00:09.700" ttm:agent="v1">',
    '<span begin="00:05.100" end="00:05.520" ttm:role="x-word">un</span><span begin="00:05.520" end="00:05.980" ttm:role="x-word" itunes:part-of-word="1">der</span>',
    '<span begin="00:06.040" end="00:06.420" ttm:role="x-word">ne</span><span begin="00:06.420" end="00:06.820" ttm:role="x-word" itunes:part-of-word="1">on</span>',
    '<span begin="00:06.940" end="00:07.360" ttm:role="x-word">lights</span>',
    '<span begin="00:07.420" end="00:07.820" ttm:role="x-word">to</span><span begin="00:07.820" end="00:08.200" ttm:role="x-word" itunes:part-of-word="1">night</span>',
    '<span begin="00:08.420" end="00:09.020" ttm:role="x-word">a</span><span begin="00:09.020" end="00:09.700" ttm:role="x-word" itunes:part-of-word="1">gain</span>',
    '</p>',
    '<p begin="00:10.200" end="00:13.400" ttm:agent="v1">',
    '<span begin="00:10.200" end="00:10.560" ttm:role="x-word">we</span>',
    '<span begin="00:10.580" end="00:10.900" ttm:role="x-word">were</span>',
    '<span begin="00:10.960" end="00:11.300" ttm:role="x-word">dan</span><span begin="00:11.300" end="00:11.760" ttm:role="x-word" itunes:part-of-word="1">cing</span>',
    '<span begin="00:11.840" end="00:12.100" ttm:role="x-word">in</span>',
    '<span begin="00:12.160" end="00:12.420" ttm:role="x-word">the</span>',
    '<span begin="00:12.500" end="00:13.100" ttm:role="x-word">dark</span>',
    '</p></div></body></tt>',
  ].join("");
  const cfontTsToSec = (value) => {
    const s = String(value == null ? "" : value).trim();
    if (!s) return 0;
    if (/^\d+(?:\.\d+)?s$/.test(s)) return parseFloat(s);
    if (/^\d+(?:\.\d+)?m$/.test(s)) return parseFloat(s) * 60;
    if (/^\d+(?:\.\d+)?h$/.test(s)) return parseFloat(s) * 3600;
    const fields = s.split(":");
    let secs = parseFloat(fields.pop());
    if (fields.length && /^\d+$/.test(fields[fields.length - 1])) secs += parseInt(fields.pop(), 10) * 60;
    if (fields.length && /^\d+$/.test(fields[fields.length - 1])) secs += parseInt(fields.pop(), 10) * 3600;
    return Number.isFinite(secs) ? secs : 0;
  };
  const cfontParseDemo = (xml) => {
    const lines = [];
    const lineRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = lineRe.exec(xml))) {
      const start = cfontTsToSec(/\bbegin="([^"]*)"/i.exec(m[1])?.[1]);
      const end = cfontTsToSec(/\bend="([^"]*)"/i.exec(m[1])?.[1]);
      const inner = m[2];
      const words = [];
      const wRe = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
      let wm;
      let prevCloseEnd = -1;
      while ((wm = wRe.exec(inner))) {
        const text = wm[2].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim();
        if (!text) continue;
        const wStart = cfontTsToSec(/\bbegin="([^"]*)"/i.exec(wm[1])?.[1]);
        const wEnd = cfontTsToSec(/\bend="([^"]*)"/i.exec(wm[1])?.[1]);
        // Apple TTML marks a syllable that CONTINUES the previous word with
        // itunes:part-of-word="1". We cannot rely on literal whitespace between
        // <span>s — the demo has none, and Apple strips it too — so the
        // attribute is the source of truth: a part-of-word syllable glues to
        // its neighbour (no space), every other syllable starts a new word.
        // Relying on whitespace alone glued every word together ("wewere…").
        const partOfWord = /\b(?:itunes:)?part-of-word="(?:1|true)"/i.test(wm[1]);
        const spaceBefore = prevCloseEnd >= 0 && !partOfWord;
        words.push({ text, start: wStart, end: wEnd, spaceBefore, partOfWord });
        prevCloseEnd = wm.index + wm[0].length;
      }
      if (words.length) lines.push({ start, end, words });
    }
    return lines;
  };
  const cfontReadFile = (file) => new Promise((resolve, reject) => {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const mime = CUSTOM_FONT_MIME[ext];
    if (!mime) return reject(new Error("Use a .ttf, .otf, .woff or .woff2 font"));
    if (file.size > 8 * 1024 * 1024) return reject(new Error("Font file is too large (8 MB max)"));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.onload = () => {
      // Re-wrap in a typed Blob so the data: URL carries a real font MIME — a lot
      // of font files arrive with an empty `file.type` and would become
      // `data:;base64`, which the extension's src sanitiser would reject.
      const blob = new Blob([reader.result], { type: mime });
      const asUrl = new FileReader();
      asUrl.onerror = () => reject(new Error("Could not read that file"));
      asUrl.onload = () => resolve({ name: file.name, dataUrl: String(asUrl.result) });
      asUrl.readAsDataURL(blob);
    };
    reader.readAsArrayBuffer(file);
  });
  // A custom range control: the native <input type=range> looks different on
  // every platform and clashes with the panel, so this is a track + fill + thumb
  // with pointer capture and full keyboard support (arrows, Home/End).
  function buildCfontSlider({ min, max, step, value, onInput }) {
    const wrap = h("div", {
      class: "ym-cfont-slider",
      tabindex: "0",
      role: "slider",
      "aria-valuemin": String(min),
      "aria-valuemax": String(max),
      "aria-valuenow": String(value),
      "aria-label": "Custom font size",
    });
    const track = h("div", { class: "ym-cfont-slider-track" });
    const fill = h("div", { class: "ym-cfont-slider-fill" });
    const thumb = h("div", { class: "ym-cfont-slider-thumb" });
    track.append(fill);
    wrap.append(track, thumb);
    let val = value;
    const paint = () => {
      const pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
      fill.style.width = pct + "%";
      thumb.style.left = pct + "%";
      wrap.setAttribute("aria-valuenow", String(val));
    };
    const set = (raw, fire) => {
      const snapped = Math.round(raw / step) * step;
      const next = Math.max(min, Math.min(max, snapped));
      if (next !== val) {
        val = next;
        paint();
        if (fire) onInput(val);
      } else {
        paint();
      }
    };
    const fromClientX = (clientX) => {
      const rect = track.getBoundingClientRect();
      if (!rect.width) return val;
      return min + ((clientX - rect.left) / rect.width) * (max - min);
    };
    let dragging = false;
    wrap.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      dragging = true;
      wrap.classList.add("is-dragging");
      try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      set(fromClientX(e.clientX), true);
    });
    wrap.addEventListener("pointermove", (e) => {
      if (dragging) set(fromClientX(e.clientX), true);
    });
    const endDrag = () => { dragging = false; wrap.classList.remove("is-dragging"); };
    wrap.addEventListener("pointerup", endDrag);
    wrap.addEventListener("pointercancel", endDrag);
    wrap.addEventListener("lostpointercapture", endDrag);
    wrap.addEventListener("keydown", (e) => {
      const delta = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step }[e.key];
      if (delta != null) { e.preventDefault(); set(val + delta, true); }
      else if (e.key === "Home") { e.preventDefault(); set(min, true); }
      else if (e.key === "End") { e.preventDefault(); set(max, true); }
    });
    paint();
    return { el: wrap, set: (v) => set(v, false), get: () => val };
  }

  function buildCustomFontSection(ext, values, commit) {
    let appliedFont = typeof values.customFont === "string" ? values.customFont : "";
    let pendingFont = null;
    // Which side of the Default/Custom switch the user picked. It can be Custom
    // with no face staged yet (the upload controls should still be visible).
    let customMode = !!appliedFont;
    const initialScale = Number(values.customFontScale);
    // 200% is the intended starting point for a freshly uploaded face (AJ).
    let scale = Number.isFinite(initialScale) && initialScale > 0 ? initialScale : 2;
    // The first cut shipped 100% as the default. A stored 1.0 with NO font in
    // use is almost certainly that old default rather than a deliberate choice,
    // so let the new 200% win until a face is actually applied.
    if (!appliedFont && scale === 1) scale = 2;
    let raf = 0;
    let t0 = 0;
    let lastNow = 0;
    let previewSeq = 0;
    let previewFace = null;

    const demoLines = cfontParseDemo(CUSTOM_FONT_DEMO_TTML);
    const baseTime = demoLines.length ? demoLines[0].start : 0;
    const endTime = demoLines.length ? demoLines[demoLines.length - 1].end : 1;
    const durationMs = Math.max(1200, (endTime - baseTime) * 1000) + 700;

    const block = h("div", { class: "ym-cfont" });
    block.append(h("div", { class: "ym-cfont-head" },
      h("div", { class: "ym-cfont-title", text: "Custom lyrics font" }),
      h("span", { class: "ym-cfont-badge", text: "Live preview" })
    ));
    block.append(h("p", {
      class: "ym-cfont-desc",
      text: "Upload a .ttf, .otf, .woff or .woff2. Both panes render with the real lyrics engine \u2014 line-synced on the left, word-synced on the right \u2014 before you apply it. The size slider only zooms this preview; the lyrics keep your Lyrics size setting.",
    }));
    // Default vs custom is a real SETTING, not just a Remove button: choosing
    // Default drops the custom face and keeps the size for later.
    const defBtn = h("button", { class: "ym-cfont-mode-opt", type: "button", text: "Default" });
    const cusBtn = h("button", { class: "ym-cfont-mode-opt", type: "button", text: "Custom" });
    const modeRow = h("div", { class: "ym-cfont-mode-row" },
      h("span", { class: "ym-cfont-mode-label", text: "Font" }),
      h("div", { class: "ym-cfont-mode" }, defBtn, cusBtn)
    );
    block.append(modeRow);

    const controls = h("div", { class: "ym-cfont-controls" });
    const uploadBtn = h("button", { class: "ym-cfont-btn ym-cfont-upload", type: "button", text: appliedFont ? "Replace font" : "Upload font" });
    const scaleVal = h("span", { class: "ym-cfont-scale-val", text: Math.round(scale * 100) + "%" });
    const slider = buildCfontSlider({
      min: 50, max: 200, step: 5, value: Math.round(scale * 100),
      onInput: (v) => {
        scale = v / 100;
        scaleVal.textContent = v + "%";
        previewWrap.style.setProperty("--ym-cfont-scale", String(scale));
        // An already-APPLIED font updates live (same as the other sliders); a
        // preview-only change stays local until Apply.
        if (appliedFont && !pendingFont) commit({ customFontScale: scale });
      },
    });
    const scaleWrap = h("div", { class: "ym-cfont-scale" },
      h("span", { class: "ym-cfont-scale-label", text: "Preview size" }),
      slider.el,
      scaleVal
    );
    const fileInput = h("input", { type: "file", accept: ".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2", class: "ym-cfont-file" });
    controls.append(uploadBtn, scaleWrap, fileInput);
    const statusEl = h("div", { class: "ym-cfont-status" + (appliedFont ? " is-on" : "") });
    const paintStatus = () => {
      const isCustom = customMode || !!appliedFont || !!pendingFont;
      if (pendingFont) {
        statusEl.textContent = "Previewing your font \u2014 press Apply to use it.";
        statusEl.classList.add("is-pending");
        statusEl.classList.remove("is-on");
      } else if (appliedFont) {
        statusEl.textContent = "Using your custom font on the lyrics.";
        statusEl.classList.remove("is-pending");
        statusEl.classList.add("is-on");
      } else if (isCustom) {
        statusEl.textContent = "No custom font yet \u2014 upload one to get started.";
        statusEl.classList.remove("is-pending", "is-on");
      } else {
        statusEl.textContent = "Using the default SpicyLyrics font.";
        statusEl.classList.remove("is-pending", "is-on");
      }
      defBtn.classList.toggle("active", !isCustom);
      cusBtn.classList.toggle("active", isCustom);
      // Default mode hides the upload/size card entirely; it belongs to Custom.
      controls.classList.toggle("is-default", !isCustom);
      uploadBtn.textContent = appliedFont ? "Replace font" : "Upload font";
      scaleWrap.classList.remove("is-dim");
    };

    const previewWrap = h("div", { class: "ym-cfont-preview hidden" });
    const applyBtn = h("button", { class: "ym-cfont-apply", type: "button", text: "Apply font" });
    const cancelBtn = h("button", { class: "ym-cfont-btn", type: "button", text: "Cancel" });
    const previewActions = h("div", { class: "ym-cfont-actions hidden" }, applyBtn, cancelBtn);

    const stopLoop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; lastNow = 0; };

    // The preview paints AND moves with the same model as the real renderer:
    // each word owns a gradient position (-20% -> 100% across its window), a
    // Scale spring (0.95 rest -> 1.0505 peak -> 1), a Y spring (dip at 90%) and
    // a Glow spring (on at 15%, off by 100%). The line flips
    // NotSung -> Active -> Sung for its alpha. The values are stepped with the
    // renderer's own Spring/Spline primitives, so the bounce matches rather
    // than merely resembling it.
    const paintSweep = (elapsedMs, dt) => {
      const rows = previewWrap.querySelectorAll(".ym-cfont-line");
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const ls = Number(row.dataset.start);
        const le = Number(row.dataset.end);
        const lineState = elapsedMs < ls ? "NotSung" : elapsedMs > le ? "Sung" : "Active";
        row.classList.toggle("NotSung", lineState === "NotSung");
        row.classList.toggle("Active", lineState === "Active");
        row.classList.toggle("Sung", lineState === "Sung");
        const words = row.querySelectorAll(".word");
        for (let i = 0; i < words.length; i++) {
          const word = words[i];
          const s = Number(word.dataset.start);
          const e = Number(word.dataset.end);
          const prog = elapsedMs <= s ? 0 : elapsedMs >= e ? 1 : (elapsedMs - s) / Math.max(1, e - s);
          const wState = elapsedMs < s ? "NotSung" : elapsedMs > e ? "Sung" : "Active";
          const target = wState === "Active" ? prog : wState === "Sung" ? 1 : 0;
          const store = word._cf;
          if (store) {
            // Line-timed words never bounce (upstream pins scale 1 / Y 0), but
            // they still carry the glow that follows the line's sweep.
            store.scale.SetGoal(store.lineTimed ? 1 : (wState === "Active" ? CFONT_SCALE_SPLINE.at(prog) : wState === "Sung" ? 1 : 0.95));
            store.y.SetGoal(store.lineTimed ? 0 : (wState === "Active" ? CFONT_Y_SPLINE.at(prog) : 0));
            store.glow.SetGoal(CFONT_GLOW_SPLINE.at(target));
            const sc = store.scale.Step(dt);
            const yy = store.y.Step(dt);
            const gl = store.glow.Step(dt);
            word.style.transform = "translate3d(0, calc(1em * " + yy.toFixed(5) + "), 0) scale(" + sc.toFixed(5) + ")";
            word.style.setProperty("--cf-glow", gl.toFixed(4));
          }
          word.style.setProperty("--cf-p", (-20 + 120 * prog).toFixed(2) + "%");
        }
      }
    };
    const tick = (now) => {
      if (!previewWrap.isConnected) { raf = 0; return; }
      const dt = lastNow ? Math.min(0.05, (now - lastNow) / 1000) : 0.016;
      lastNow = now;
      paintSweep(t0 ? (now - t0) % durationMs : 0, dt);
      raf = requestAnimationFrame(tick);
    };
    const startLoop = () => {
      stopLoop();
      if (reducedMotion()) { paintSweep(durationMs + 1, 1); return; }
      t0 = performance.now();
      lastNow = 0;
      raf = requestAnimationFrame(tick);
    };

    const attachSprings = (el, lineTimed) => {
      el._cf = {
        lineTimed,
        scale: new CfontSpring(lineTimed ? 1 : 0.95, CFONT_SCALE_SPRING[0], CFONT_SCALE_SPRING[1]),
        y: new CfontSpring(0, CFONT_Y_SPRING[0], CFONT_Y_SPRING[1]),
        glow: new CfontSpring(0, CFONT_GLOW_SPRING[0], CFONT_GLOW_SPRING[1]),
      };
      return el;
    };
    const makeLine = (line, mode) => {
      const row = h("div", { class: "ym-cfont-line" + (mode === "lsync" ? " line-timed" : "") });
      row.dataset.start = String((line.start - baseTime) * 1000);
      row.dataset.end = String((line.end - baseTime) * 1000);
      if (mode === "lsync") {
        // Line-synced: one .word, one sweep across the whole line window.
        const w = attachSprings(h("span", {
          class: "word",
          text: line.words.map((x, i) => (i && x.spaceBefore ? " " : "") + x.text).join(""),
        }), true);
        w.dataset.start = row.dataset.start;
        w.dataset.end = row.dataset.end;
        row.append(w);
      } else {
        // Word-synced: one .word per syllable; PartOfWord glues continuations.
        // A flex row drops whitespace-only text nodes, so the gap between words
        // must be a real element (the renderer uses .letter.SpaceLetter for the
        // same reason) — without it every word runs together ("ningso").
        // Each WORD is wrapped in a nowrap group so its syllables can never be
        // split across two rows ("to" on one line, "night" on the next).
        let group = null;
        line.words.forEach((w) => {
          if (!w.partOfWord) {
            if (w.spaceBefore) row.append(h("span", { class: "ym-cfont-space", text: " " }));
            group = h("span", { class: "ym-cfont-word-group" });
            row.append(group);
          }
          const el = attachSprings(h("span", { class: "word" + (w.partOfWord ? " PartOfWord" : ""), text: w.text }), false);
          el.dataset.start = String((w.start - baseTime) * 1000);
          el.dataset.end = String((w.end - baseTime) * 1000);
          (group || row).append(el);
        });
      }
      return row;
    };
    const renderPreview = (family) => {
      previewWrap.replaceChildren();
      [["lsync", "Line-synced"], ["wsync", "Word-synced"]].forEach(([mode, label]) => {
        const pane = h("div", { class: "ym-cfont-pane" }, h("div", { class: "ym-cfont-pane-label", text: label }));
        const stage = h("div", { class: "ym-cfont-stage" });
        demoLines.forEach((line) => stage.append(makeLine(line, mode)));
        pane.append(stage);
        previewWrap.append(pane);
      });
      // A pending upload previews under its own temporary family; an applied
      // font previews through --ym-sl-lyric-font — exactly what the lyrics use.
      if (family) previewWrap.style.setProperty("--ym-cfont-family", '"' + family + '"');
      else previewWrap.style.removeProperty("--ym-cfont-family");
      previewWrap.style.setProperty("--ym-cfont-scale", String(scale));
      previewWrap.classList.remove("hidden");
      startLoop();
    };

    uploadBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      cfontReadFile(file)
        .then(({ dataUrl }) => {
          // A fresh family per upload: reusing one name would leave the previous
          // FontFace competing for the same family and the pane could keep the
          // old glyphs after a "Replace".
          const family = "ym-cfont-preview-" + (++previewSeq);
          const face = new FontFace(family, 'url("' + dataUrl + '")');
          return face.load().then((loaded) => {
            if (document.fonts && document.fonts.add) {
              if (previewFace) { try { document.fonts.delete(previewFace); } catch (e) { /* ignore */ } }
              document.fonts.add(loaded);
            }
            previewFace = loaded;
            pendingFont = dataUrl;
            customMode = true;
            renderPreview(family);
            previewActions.classList.remove("hidden");
            paintStatus();
          });
        })
        .catch((err) => toast(err && err.message ? err.message : "Could not read that font"));
    });
    // Show the applied font's own preview (read-only). No pending file means the
    // Apply/Cancel pair has nothing to act on, so it stays hidden.
    const dropPreviewFace = () => {
      if (previewFace && document.fonts) {
        try { document.fonts.delete(previewFace); } catch (e) { /* ignore */ }
      }
      previewFace = null;
    };
    const showApplied = () => {
      previewActions.classList.add("hidden");
      if (appliedFont) renderPreview(null);
      else { previewWrap.classList.add("hidden"); stopLoop(); }
    };

    applyBtn.addEventListener("click", () => {
      if (!pendingFont) return;
      appliedFont = pendingFont;
      pendingFont = null;
      customMode = true;
      commit({ customFont: appliedFont, customFontScale: scale });
      paintStatus();
      showApplied();
      toast("Custom font applied");
    });
    cancelBtn.addEventListener("click", () => {
      pendingFont = null;
      dropPreviewFace();
      paintStatus();
      showApplied();
    });
    // "Default" is the explicit revert setting. It ALWAYS posts the clear, even
    // when the local state looks empty: a panel built before the persistence
    // fix can still be showing "default" while a face is live, and one click
    // must still be enough to get SpicyLyrics back (AJ, 2026-10-20).
    defBtn.addEventListener("click", () => {
      customMode = false;
      appliedFont = "";
      pendingFont = null;
      dropPreviewFace();
      commit({ customFont: "" });
      previewWrap.classList.add("hidden");
      previewActions.classList.add("hidden");
      stopLoop();
      paintStatus();
      toast("Using the default font");
    });
    // "Custom" reveals the upload/size card; it does not force the picker open.
    cusBtn.addEventListener("click", () => {
      customMode = true;
      paintStatus();
    });

    block.append(controls, statusEl, previewWrap, previewActions);
    paintStatus();
    // An already-applied font shows its preview on open, so the section never
    // looks empty after a reload.
    if (appliedFont) showApplied();
    // The section lives inside a collapsed disclosure: only run the rAF loop
    // while it is actually open, or the preview burns frames off-screen.
    const setActive = (open) => {
      if (!open) { stopLoop(); return; }
      if (!previewWrap.classList.contains("hidden")) startLoop();
    };
    // "Reset to defaults" also drops the font; keep this block's local state in
    // sync with the settings object the reset just replaced.
    const reset = () => {
      customMode = false;
      appliedFont = "";
      pendingFont = null;
      dropPreviewFace();
      scale = 2;
      slider.set(200);
      scaleVal.textContent = "200%";
      previewWrap.classList.add("hidden");
      previewActions.classList.add("hidden");
      stopLoop();
      paintStatus();
    };
    stopLoop();
    return { el: block, setActive, reset };
  }

  // ---- Report a problem (AJ, 2026-10-19) ------------------------------------
  // A red "Report a problem" button in every add-on's settings opens a frosted,
  // dimmed modal: pick an issue (or Other -> a textarea), then Send -> "Thanks for
  // reporting!". Send is a placeholder for now (no backend yet). Singleton overlay
  // on <body>, reused across add-ons.
  let reportOverlay = null;
  const reportedExts = new Set(); // ext ids reported this session (per-add-on gate)
  let reportSendCount = 0;        // total reports sent this session
  const REPORT_MAX = 3;           // beyond this, the panel points to Discord only
  let currentReportExtId = "";    // ext id currently open in the modal
  let reportGen = 0;              // bumped on open; guards stale close/Send callbacks
  const REPORT_DISCORD_URL = "https://discord.gg/wsZxTSnaMa";
  function reportIssuesFor(ext) {
    const byId = {
      "ytmod-spicy-lyrics": ["Lyrics not showing", "Fullscreen", "Lyric sources", "Other"],
      "ytmod-smooth-motion": ["Animations look wrong", "Panel / corner motion", "Performance / lag", "Buttons / controls", "Other"],
      "ytmod-dynamic": ["Cover art animation", "Video background / backdrop", "Gallery dimming", "Performance", "Other"],
      "ytmod-sleep-timer": ["Timer never fires", "Fade / volume", "Pause behaviour", "Other"],
      "ytmod-pip-lyrics": ["Picture-in-picture window", "Lyrics inside PiP", "Controls", "Other"],
    };
    return (ext && byId[ext.id]) || ["Doesn't work", "Visual / layout", "Performance", "Buttons / controls", "Other"];
  }
  function buildReportProblem() {
    const scrim = h("div", { class: "ym-report-scrim hidden" });
    const card = h("div", { class: "ym-report-card" });
    // Whole PICK view (title + × + sub + options + other + send) fades out as one.
    const pick = h("div", { class: "ym-report-pick" });
    const title = h("div", { class: "ym-report-title" });
    const x = h("button", { class: "ym-report-x", type: "button", "aria-label": "Close", title: "Close", text: "\u00d7" });
    pick.append(h("div", { class: "ym-report-head" }, title, x));
    pick.append(h("div", { class: "ym-report-sub", text: "Pick one of the options below" }));
    const options = h("div", { class: "ym-report-options" });
    const otherWrap = h("div", { class: "ym-report-other hidden" });
    const otherInput = h("textarea", {
      class: "ym-report-other-input",
      placeholder: "Tell us what went wrong\u2026",
      rows: "3",
      maxlength: "1000",
    });
    otherWrap.append(otherInput);
    const send = h("button", { class: "ym-report-send", type: "button", text: "Send" });
    send.disabled = true;

    let rows = [];
    // Single source of truth for the Other textarea (AJ, 2026-10-20). It used to
    // be driven ONLY by the Other row's own click, so its visibility could drift
    // out of sync with the row's checked state — e.g. it vanished after another
    // option was picked. Deriving it from the row on EVERY click makes it
    // idempotent, and clearing a stale inline card height on show means a
    // previous collapse can never clip the box.
    let otherVisible = false;
    const syncOther = () => {
      const otherRow = rows.find((r) => r.getAttribute("data-value") === "Other");
      const want = !!(otherRow && otherRow.classList.contains("selected"));
      if (want === otherVisible) return;
      otherVisible = want;
      if (want) {
        card.style.height = ""; // a pinned height from a past collapse would clip it
        otherWrap.classList.remove("hidden");
        if (!reducedMotion() && otherWrap.animate) {
          otherWrap.animate(
            [{ opacity: 0, height: "0px" }, { opacity: 1, height: otherWrap.scrollHeight + "px" }],
            { duration: 320, easing: "cubic-bezier(.22,1,.36,1)" }
          );
        }
        otherInput.focus();
        return;
      }
      // Smooth OUT: collapse the wrapper AND animate the card's height down in
      // step, so the surface shrinks together instead of the border snapping.
      const cardH = card.offsetHeight;
      const wrapH = otherWrap.offsetHeight;
      if (!reducedMotion() && otherWrap.animate) {
        track(otherWrap.animate(
          [{ opacity: 1, height: wrapH + "px" }, { opacity: 0, height: "0px" }],
          { duration: 260, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" }
        )).onfinish = () => {
          otherWrap.classList.add("hidden");
          otherWrap.style.height = "";
        };
        if (card.animate && wrapH > 0 && cardH > wrapH) {
          card.style.height = cardH + "px";
          track(card.animate(
            [{ height: cardH + "px" }, { height: (cardH - wrapH) + "px" }],
            { duration: 260, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" }
          )).onfinish = () => { card.style.height = ""; };
        }
      } else {
        otherWrap.classList.add("hidden");
      }
    };
    const renderOptions = (issues) => {
      options.replaceChildren();
      // Fresh rows are all unselected and openReportProblem() re-hides the
      // textarea, so the derived flag has to start false — otherwise syncOther()
      // believes it is already in the right state and skips showing it again.
      otherVisible = false;
      rows = issues.map((label) => {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", "M5 13l4 4L19 7");
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", "currentColor");
        p.setAttribute("stroke-width", "3");
        p.setAttribute("stroke-linecap", "round");
        p.setAttribute("stroke-linejoin", "round");
        svg.appendChild(p);
        const circle = h("span", { class: "ym-report-radio" }, h("span", { class: "ym-report-check" }, svg));
        const row = h("button", {
          class: "ym-report-option", type: "button", role: "checkbox", "aria-checked": "false", "data-value": label,
        }, h("span", { class: "ym-report-option-label", text: label }), circle);
        // MULTI-SELECT (AJ, 2026-10-20): more than one of these is usually true at
        // the same time, so each row toggles independently instead of clearing the
        // others. Send unlocks as soon as ANY row is selected, and the Other
        // textarea follows that row's own checked state rather than the whole form.
        row.addEventListener("click", () => {
          const on = !row.classList.contains("selected");
          row.classList.toggle("selected", on);
          row.setAttribute("aria-checked", on ? "true" : "false");
          send.disabled = !rows.some((r) => r.classList.contains("selected"));
          syncOther();
        });
        options.appendChild(row);
        return row;
      });
    };
    pick.append(options, otherWrap, send);

    // Discord link (embedded inline with a top-right arrow); reused by the
    // thanks / "already reported" / "report limit reached" views.
    const arrowNs = "http://www.w3.org/2000/svg";
    const makeDiscordLink = () => {
      const arrow = document.createElementNS(arrowNs, "svg");
      arrow.setAttribute("viewBox", "0 0 24 24");
      arrow.setAttribute("class", "ym-report-discord-arrow");
      arrow.setAttribute("aria-hidden", "true");
      ["M7 17 17 7", "M8 7h9v9"].forEach((d) => {
        const path = document.createElementNS(arrowNs, "path");
        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", "2.5");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        arrow.appendChild(path);
      });
      return h("a", { class: "ym-report-discord", href: REPORT_DISCORD_URL, target: "_blank", rel: "noopener noreferrer" },
        h("span", { class: "ym-report-discord-text", text: "Join our Discord" }), arrow);
    };
    const thanks = h("div", { class: "ym-report-thanks hidden" },
      h("div", { class: "ym-report-thanks-title", text: "Thanks for reporting!" }),
      h("div", { class: "ym-report-thanks-sub" },
        document.createTextNode("Need extra help? "),
        makeDiscordLink(),
        document.createTextNode(".")
      ),
      h("button", { class: "ym-report-close", type: "button", text: "Close" })
    );
    // Shown on a LATER re-open, once THIS add-on has already been reported.
    const done = h("div", { class: "ym-report-done hidden" },
      h("div", { class: "ym-report-done-title", text: "You've already reported" }),
      h("div", { class: "ym-report-done-sub" },
        document.createTextNode("If you're experiencing another bug, please "),
        makeDiscordLink(),
        document.createTextNode(".")
      ),
      h("button", { class: "ym-report-close", type: "button", text: "Close" })
    );
    // Shown once this session has hit the report cap (Discord only from here).
    const blocked = h("div", { class: "ym-report-done hidden" },
      h("div", { class: "ym-report-done-title", text: "You can't report anymore" }),
      h("div", { class: "ym-report-done-sub" },
        document.createTextNode("You've reached the report limit. Please "),
        makeDiscordLink(),
        document.createTextNode(" if you need help.")
      ),
      h("button", { class: "ym-report-close", type: "button", text: "Close" })
    );

    card.append(pick, thanks, done, blocked);
    scrim.appendChild(card);

    // Track + cancel running animations so a re-open never inherits a stale
    // fill:forwards or a stale close timer (the "opens then abruptly closes" bug).
    const lives = [];
    const track = (a) => { if (a) lives.push(a); return a; };
    const cancelAll = () => { lives.forEach((a) => { try { a.cancel(); } catch (_) {} }); lives.length = 0; };
    const resetStyles = () => {
      pick.style.filter = ""; pick.style.opacity = ""; pick.style.transform = "";
      thanks.style.opacity = ""; thanks.style.transform = ""; thanks.style.filter = "";
      done.style.opacity = ""; done.style.transform = ""; done.style.filter = "";
      blocked.style.opacity = ""; blocked.style.transform = ""; blocked.style.filter = "";
      card.style.height = ""; card.style.opacity = ""; card.style.transform = ""; card.style.filter = "";
    };
    const markReported = () => {
      reportSendCount++;
      if (currentReportExtId) reportedExts.add(currentReportExtId);
    };

    const closeReport = () => {
      const genAtClose = reportGen;
      cancelAll();
      if (reducedMotion() || !scrim.animate) { scrim.classList.add("hidden"); return; }
      const a = track(card.animate(
        [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.96) translateY(8px)", filter: "blur(6px)" }],
        { duration: 200, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }));
      track(scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: "ease-out", fill: "forwards" }));
      // A close scheduled before a re-open must NOT hide the freshly opened modal.
      const finishClose = () => {
        if (genAtClose !== reportGen) return;
        scrim.classList.add("hidden");
        cancelAll();
      };
      a.onfinish = finishClose;
      window.setTimeout(finishClose, 320);
    };
    x.addEventListener("click", closeReport);
    thanks.querySelector(".ym-report-close").addEventListener("click", closeReport);
    done.querySelector(".ym-report-close").addEventListener("click", closeReport);
    blocked.querySelector(".ym-report-close").addEventListener("click", closeReport);
    scrim.addEventListener("click", (e) => { if (e.target === scrim) closeReport(); });

    send.addEventListener("click", () => {
      if (send.disabled) return;
      // Placeholder — wire the real submit later (AJ, 2026-10-19).
      if (reducedMotion() || !pick.animate) { pick.classList.add("hidden"); thanks.classList.remove("hidden"); markReported(); return; }
      // Track this fade so a re-open's cancelAll() clears it — an untracked
      // fill:forwards would pin `pick` at opacity:0 and render the form invisible
      // (the "blank white panel" on the next open). AJ, 2026-10-21.
      track(pick.animate(
        [{ opacity: 1, transform: "none", filter: "blur(0)" }, { opacity: 0, transform: "translateY(-8px)", filter: "blur(6px)" }],
        { duration: 240, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }
      )).onfinish = () => {
        const fromH = card.offsetHeight;
        pick.classList.add("hidden");
        pick.style.filter = "";
        thanks.classList.remove("hidden");
        markReported();
        const toH = card.offsetHeight;
        // Smoothly shrink the card to the smaller thanks layout (AJ, 2026-10-19).
        if (card.animate && toH > 0 && fromH !== toH) {
          card.style.height = fromH + "px";
          const shrink = track(card.animate(
            [{ height: fromH + "px" }, { height: toH + "px" }],
            { duration: 380, easing: "cubic-bezier(.34,1.2,.5,1)", fill: "forwards" }));
          shrink.onfinish = () => { card.style.height = ""; };
        }
        track(thanks.animate(
          [{ opacity: 0, transform: "translateY(12px)", filter: "blur(6px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }],
          { duration: 460, easing: "cubic-bezier(.34,1.4,.5,1)" }));
      };
    });

    document.body.appendChild(scrim);
    reportOverlay = { scrim, title, pick, thanks, done, blocked, options, otherWrap, otherInput, send, renderOptions, cancelAll, resetStyles };
    return reportOverlay;
  }
  function openReportProblem(ext) {
    const r = reportOverlay || buildReportProblem();
    ++reportGen;               // invalidate any in-flight close/Send callbacks
    r.cancelAll();             // kill stale fill:forwards so nothing looks "closed"
    r.resetStyles();           // clear inline height/opacity/transform from last time
    currentReportExtId = (ext && ext.id) || "";
    const atLimit = reportSendCount >= REPORT_MAX;
    const alreadyExt = !atLimit && reportedExts.has(currentReportExtId);
    const showingPick = !atLimit && !alreadyExt;
    const nameTitle = `Report a problem with ${ext && ext.name ? ext.name : "Aurora Lyrics"}`;
    r.pick.classList.add("hidden");
    r.thanks.classList.add("hidden");
    r.done.classList.add("hidden");
    r.blocked.classList.add("hidden");
    if (showingPick) {
      // Fresh report (per add-on): show the pick form and build its options.
      r.title.textContent = nameTitle;
      r.pick.classList.remove("hidden");
      r.otherWrap.classList.add("hidden");
      r.otherInput.value = "";
      r.send.disabled = true;
      r.renderOptions(reportIssuesFor(ext));
    } else if (alreadyExt) {
      // This add-on was already reported this session (others can still report).
      r.title.textContent = nameTitle;
      r.done.classList.remove("hidden");
    } else {
      // Session report cap reached: point to Discord only.
      r.title.textContent = "Report a problem";
      r.blocked.classList.remove("hidden");
    }
    r.scrim.classList.remove("hidden");
    if (reducedMotion() || !r.scrim.animate) return;
    r.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
    const card = r.scrim.querySelector(".ym-report-card");
    if (card && card.animate) {
      card.animate(
        [{ opacity: 0, transform: "scale(.96) translateY(10px)", filter: "blur(6px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }],
        { duration: 440, easing: "cubic-bezier(.34,1.4,.5,1)" });
    }
    if (showingPick) {
      Array.from(r.options.children).forEach((row, i) => {
        if (!row.animate) return;
        row.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
          { duration: 420, delay: 80 + i * 45, easing: "cubic-bezier(.34,1.4,.5,1)", fill: "backwards" });
      });
    }
  }
  // Appends the right-aligned "Report a problem" footer button to a detail host, so
  // EVERY add-on has it — even ones with no settings — and it never reads as an
  // Uninstall/Action button (AJ, 2026-10-19).
  function mountReportButton(host, ext) {
    const btn = h("button", { class: "ym-report-btn", type: "button", text: "Report a problem" });
    btn.addEventListener("click", () => openReportProblem(ext));
    host.appendChild(h("div", { class: "ym-report-foot" }, btn));
  }

  /* ===== custom background storage (AJ, 2026-10-21) =====================
     A user-uploaded backdrop can be many megabytes, so it lives in IndexedDB —
     localStorage has a ~5MB cap and syncs badly (rule 7 in DEVELOPERS/IDEAS).
     One store, keyed by add-on id. Only the BLOB is stored; the settings row
     keeps a boolean so the extension knows one exists. */
  const BG_DB_NAME = "aurora-bg";
  const BG_DB_STORE = "images";
  const BG_MAX_BYTES = 25 * 1024 * 1024;
  const BG_MAX_EDGE = 2560;
  let bgDbPromise = null;

  function bgDb() {
    if (bgDbPromise) return bgDbPromise;
    bgDbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(BG_DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(BG_DB_STORE)) db.createObjectStore(BG_DB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (_) { resolve(null); }
    });
    return bgDbPromise;
  }

  async function bgStore(mode, fn) {
    const db = await bgDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(BG_DB_STORE, mode);
        const store = tx.objectStore(BG_DB_STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }

  const bgPut = (key, record) => bgStore("readwrite", (st) => st.put(record, key));
  const bgGet = (key) => bgStore("readonly", (st) => st.get(key));
  const bgDel = (key) => bgStore("readwrite", (st) => st.delete(key));

  // Downscale on import so a 40MP photo does not cost 200MB of VRAM. Anything
  // already small enough is stored untouched (no needless re-encode).
  async function bgPrepare(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const scale = Math.min(1, BG_MAX_EDGE / Math.max(w, h));
      if (scale >= 1 && file.size <= 8 * 1024 * 1024) return { blob: file, w, h };
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      return { blob: blob || file, w: cw, h: ch };
    } catch (_) {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function bgFormatBytes(n) {
    if (!n) return "";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  /* Custom file picker for an image setting. Fully custom chrome — the only
     native part is the OS file dialog itself, which cannot be styled. The
     thumbnail always shows the RAW image (no Kawarp, no blur), so it is a
     faithful preview of what was imported. */
  const FILE_ICON = "M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5z";

  function buildFileControl(ext, setting, commit) {
    const row = h("div", { class: "ym-detail-setting-row ym-file-row", "data-key": setting.key });
    row.appendChild(h("div", { class: "ym-detail-setting-label", text: setting.label }));

    const control = h("div", { class: "ym-detail-setting-control ym-file-control" });
    const card = h("div", { class: "ym-file-card" });
    const thumb = h("div", { class: "ym-file-thumb" });
    const info = h("div", { class: "ym-file-info" });
    const nameEl = h("div", { class: "ym-file-name", text: "No image selected" });
    const metaEl = h("div", { class: "ym-file-meta", text: "PNG, JPG or WebP \u00b7 up to 25 MB" });
    info.append(nameEl, metaEl);
    const actions = h("div", { class: "ym-file-actions" });
    const pickBtn = h("button", { class: "ym-file-btn", type: "button", text: "Choose image" });
    const clearBtn = h("button", { class: "ym-file-btn ym-file-btn-quiet", type: "button", text: "Remove" });
    const input = h("input", {
      class: "ym-file-input", type: "file", accept: "image/*",
      tabindex: "-1", "aria-hidden": "true",
    });
    actions.append(pickBtn, clearBtn);
    card.append(thumb, info, actions);
    control.append(card, input);
    row.appendChild(control);

    let previewUrl = "";
    function paint(url, name, meta, animate) {
      if (previewUrl && previewUrl !== url) URL.revokeObjectURL(previewUrl);
      previewUrl = url;
      thumb.replaceChildren();
      if (url) {
        const img = h("img", { class: "ym-file-img", src: url, alt: "" });
        thumb.appendChild(img);
        if (animate && img.animate) {
          img.animate(
            [{ opacity: 0, transform: "scale(.92)" }, { opacity: 1, transform: "none" }],
            { duration: 340, easing: "cubic-bezier(.34,1.3,.5,1)" }
          );
        }
        thumb.classList.add("has-image");
      } else {
        thumb.appendChild(svgIcon(FILE_ICON));
        thumb.classList.remove("has-image");
      }
      nameEl.textContent = name || "No image selected";
      metaEl.textContent = meta || "PNG, JPG or WebP \u00b7 up to 25 MB";
      clearBtn.disabled = !url;
      clearBtn.classList.toggle("is-off", !url);
    }
    paint("", "", "", false);

    // Read any stored blob AFTER the row is in the DOM, so a re-render never
    // leaves the thumbnail permanently empty.
    bgGet(ext.id).then((rec) => {
      if (!row.isConnected) return;
      if (!rec || !rec.blob) return;
      const meta = [
        rec.w && rec.h ? rec.w + " \u00d7 " + rec.h : "",
        bgFormatBytes(rec.bytes || rec.blob.size),
      ].filter(Boolean).join(" \u00b7 ");
      paint(URL.createObjectURL(rec.blob), rec.name || "Background image", meta, false);
    }).catch(() => {});

    pickBtn.addEventListener("click", () => input.click());

    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      if (!/^image\//.test(file.type)) { toast("That file is not an image"); return; }
      if (file.size > BG_MAX_BYTES) { toast("Image is larger than 25 MB"); return; }
      card.classList.add("is-busy");
      const prepared = await bgPrepare(file);
      card.classList.remove("is-busy");
      if (!prepared) { toast("Could not read that image"); return; }
      await bgPut(ext.id, {
        blob: prepared.blob,
        name: file.name,
        w: prepared.w,
        h: prepared.h,
        bytes: prepared.blob.size,
      });
      const meta = prepared.w + " \u00d7 " + prepared.h + " \u00b7 " + bgFormatBytes(prepared.blob.size);
      paint(URL.createObjectURL(prepared.blob), file.name, meta, true);
      commit({ [setting.key]: true });
    });

    clearBtn.addEventListener("click", async () => {
      if (clearBtn.disabled) return;
      const img = thumb.querySelector(".ym-file-img");
      if (img && img.animate) {
        const a = img.animate(
          [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.92)" }],
          { duration: 220, easing: "cubic-bezier(.4,0,.7,1)", fill: "forwards" }
        );
        await new Promise((resolve) => { a.onfinish = resolve; window.setTimeout(resolve, 300); });
      }
      await bgDel(ext.id);
      paint("", "", "", false);
      commit({ [setting.key]: false });
    });

    return row;
  }

  async function buildSettingsSection(ext) {
    const list = visibleSettings(ext);
    if (!list.length) return null;
    let values = await getExtensionSettings(ext);
    const section = h("section", { class: "ym-detail-settings" });
    // Info button: plain-language "what it does / pros / cons" for this add-on.
    const info = MK_INFO[ext.id];
    const infoPanel = h("div", { class: "ym-mk-info hidden" });
    let infoBtn = null;
    if (info) {
      if (info.what) {
        infoPanel.appendChild(h("div", { class: "ym-mk-info-row" },
          h("span", { class: "ym-mk-info-label", text: "What it does" }),
          h("span", { class: "ym-mk-info-text", text: info.what })
        ));
      }
      if (info.pros && info.pros.length) infoPanel.appendChild(mkInfoList("Pros", info.pros, "pro"));
      if (info.cons && info.cons.length) infoPanel.appendChild(mkInfoList("Cons", info.cons, "con"));
      infoBtn = h("button", {
        class: "ym-mk-info-btn",
        type: "button",
        title: "What this add-on does, with pros and cons",
        "aria-label": "About this add-on",
        "aria-expanded": "false",
        text: "i",
      });
      let infoBusy = false;
      let infoCloseAnim = null;
      infoBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (infoBusy) return;
        const open = infoPanel.classList.contains("hidden");
        infoBtn.setAttribute("aria-expanded", open ? "true" : "false");
        infoBtn.classList.toggle("on", open);
        // Same motion language as switching add-ons: a springy rise on open,
        // a short blur-out on close (AJ, 2026-10-19).
        if (open) {
          // A close animation with fill:forwards keeps holding height:0 and
          // opacity:0. If it is not cancelled the reopened card stays collapsed
          // and only flashes its top edge on the next click (AJ, 2026-10-19).
          if (infoCloseAnim) {
            try { infoCloseAnim.cancel(); } catch (e) {}
            infoCloseAnim = null;
          }
          infoPanel.classList.remove("hidden");
          if (!infoPanel.animate) return;
          infoBusy = true;
          // Grow the block while its rows rise, so the settings below slide
          // down instead of jumping (AJ, 2026-10-19).
          const target = infoPanel.offsetHeight;
          infoPanel.style.overflow = "hidden";
          const grow = infoPanel.animate(
            [{ height: "0px" }, { height: target + "px" }],
            { duration: 420, easing: "cubic-bezier(.22,1,.36,1)" }
          );
          grow.onfinish = () => { infoPanel.style.overflow = ""; };
          // Stagger each row exactly like mkAnimateIn does when you switch
          // add-ons — a single block tween felt stiff (AJ, 2026-10-19).
          Array.from(infoPanel.children).forEach((el, i) => {
            if (!el.animate) return;
            el.animate(
              [{ opacity: 0, transform: "translateY(18px)" }, { opacity: 1, transform: "none" }],
              { duration: 540, delay: 40 + i * 54, easing: "cubic-bezier(.34,1.4,.5,1)", fill: "backwards" }
            );
          });
          const total = 40 + infoPanel.children.length * 54 + 540;
          window.setTimeout(() => { infoBusy = false; }, total);
        } else if (infoPanel.animate) {
          infoBusy = true;
          const h0 = infoPanel.offsetHeight;
          infoPanel.style.overflow = "hidden";
          const a = infoPanel.animate(
            [
              { height: h0 + "px", opacity: 1, transform: "none", filter: "blur(0px)" },
              { height: "0px", opacity: 0, transform: "translateY(-10px)", filter: "blur(6px)" },
            ],
            { duration: 220, easing: "cubic-bezier(.4,0,.35,1)", fill: "forwards" }
          );
          infoCloseAnim = a;
          const done = () => {
            infoPanel.classList.add("hidden");
            infoPanel.style.overflow = "";
            // Cancel AFTER hiding: display:none already holds the collapsed
            // state, so the forwards fill is no longer needed.
            try { a.cancel(); } catch (e) {}
            if (infoCloseAnim === a) infoCloseAnim = null;
            infoBusy = false;
          };
          a.onfinish = done;
          window.setTimeout(done, 260);
        } else {
          infoPanel.classList.add("hidden");
        }
      });
    }
    section.appendChild(h("div", { class: "ym-detail-settings-head" },
      h("div", { class: "ym-detail-settings-titlerow" },
        h("div", { class: "ym-detail-settings-title", text: "Settings" }),
        infoBtn
      ),
      h("div", { class: "ym-detail-settings-subtitle", text: "Changes apply immediately and are saved automatically." })
    ));
    if (info) section.appendChild(infoPanel);
    const controls = new Map();
    for (const setting of list) {
      if (setting.type === "header") {
        // Visual-only section heading. No key, no input, no entry in `controls`
        // (so the Reset button ignores it) and no entry in `values` (so
        // postExtensionSettings does not post a junk key to the extension).
        section.appendChild(h("div", { class: "ym-detail-setting-section", text: setting.label }));
        continue;
      }
      if (setting.type === "file") {
        section.appendChild(buildFileControl(ext, setting, (patch) => {
          values = Object.assign({}, values, patch);
          postExtensionSettings(ext.id, patch);
          saveExtensionSettings(ext.id, values);
        }));
        continue;
      }
      if (setting.type === "order") {
        // Reordering does NOT push to the extension immediately. Posting on every
        // drag/arrow step would make the resolver re-run and refetch lyrics for the
        // current track each time. We persist the choice now (so a reload keeps it)
        // and stash it in pendingOrderPost; finishCloseDetail() flushes it once,
        // after the panel is closed (AJ, 2026-10-19).
        section.appendChild(buildOrderControl(setting, () => values, (next) => {
          values = Object.assign({}, values, { [setting.key]: next });
          saveExtensionSettings(ext.id, values);
          pendingOrderPost = { id: ext.id, values };
        }));
        continue;
      }
      const isText = setting.type === "text";
      const isToggle = setting.type === "toggle";
      const valueEl = h("output", {
        class: "ym-detail-setting-value",
        text: formatSettingValue(setting, values[setting.key]),
      });
      const input = h("input", {
        class: "ym-detail-setting-input",
        type: isText ? "text" : isToggle ? "checkbox" : "range",
        min: isText || isToggle ? null : setting.min,
        max: isText || isToggle ? null : setting.max,
        step: isText || isToggle ? null : setting.step,
        value: isText || !isToggle ? values[setting.key] : null,
        placeholder: isText ? setting.placeholder : null,
        autocomplete: isText ? "off" : null,
        "aria-label": setting.label,
      });
      if (isToggle) input.checked = Boolean(values[setting.key]);
      const isRange = !isText && !isToggle;
      // Drives the filled portion of the track (see the range CSS).
      const syncRangeFill = () => {
        if (!isRange) return;
        const lo = Number(setting.min || 0), hi = Number(setting.max || 100);
        const pct = hi > lo ? ((Number(input.value) - lo) / (hi - lo)) * 100 : 0;
        input.style.setProperty("--val", Math.max(0, Math.min(100, pct)) + "%");
      };
      const updateSetting = () => {
        const value = settingValue(setting, isToggle ? input.checked : input.value);
        values = Object.assign({}, values, { [setting.key]: value });
        if (isToggle) input.checked = value;
        else input.value = value;
        valueEl.textContent = formatSettingValue(setting, value);
        syncRangeFill();
        postExtensionSettings(ext.id, values);
        saveExtensionSettings(ext.id, values);
        // A change can flip another row's disabledWhen condition (e.g. the
        // kawarp toggle locks its blur slider), so re-sync every row. `childOf`
        // rows re-sync here too, which is what makes a parent toggle open and
        // close its child row.
        controls.forEach((entry) => {
          if (entry.syncDisabled) entry.syncDisabled();
          if (entry.syncVisible) entry.syncVisible();
        });
      };
      input.addEventListener(isToggle ? "change" : "input", updateSetting);
      syncRangeFill();
      const row = h("div", { class: "ym-detail-setting-row", "data-key": setting.key },
        h("div", { class: "ym-detail-setting-label", text: setting.label }),
        h("div", { class: "ym-detail-setting-control" }, input, valueEl)
      );
      // `childOf`: a nested row that only exists while its parent toggle is ON
      // (AJ, 2026-10-20). It stays in the DOM and collapses to zero height, so
      // opening/closing is a CSS transition on the row itself instead of a
      // layout jump — that is what gives the in AND out motion.
      let syncVisible = null;
      if (setting.childOf) {
        row.classList.add("ym-detail-setting-child");
        syncVisible = () => {
          const open = !!values[setting.childOf];
          row.classList.toggle("collapsed", !open);
          row.setAttribute("aria-hidden", open ? "false" : "true");
          // A collapsed row must not be tabbable or clickable either.
          input.tabIndex = open ? 0 : -1;
          row.style.pointerEvents = open ? "" : "none";
        };
        syncVisible();
      }
      // `disabledWhen`: dim + lock this row while the named setting is truthy
      // (used by the kawarp blur, which the kawarp toggle overrides). Inline
      // styles keep it self-contained -- no conditional-row CSS to extend.
      const syncDisabled = () => {
        const blocked = !!(setting.disabledWhen && values[setting.disabledWhen]);
        row.style.opacity = blocked ? "0.45" : "";
        row.style.pointerEvents = blocked ? "none" : "";
        row.title = blocked ? "Another setting overrides this one" : "";
      };
      syncDisabled();
      controls.set(setting.key, { input, valueEl, setting, syncRangeFill, syncDisabled, syncVisible });
      section.appendChild(row);
    }

    let fontCtl = null; // assigned below once the font block is built
    const reset = h("button", { class: "ym-detail-settings-reset", type: "button", text: "Reset to defaults" });
    reset.addEventListener("click", () => {
      // The font lives outside the catalog, so getExtensionDefaults() has no key
      // for it. Clear it explicitly or "reset" would leave a stale face applied.
      values = Object.assign(getExtensionDefaults(ext), { customFont: "", customFontScale: 2 });
      if (fontCtl) fontCtl.reset();
      controls.forEach(({ input, valueEl, setting, syncRangeFill }) => {
        if (setting.type === "toggle") input.checked = Boolean(values[setting.key]);
        else input.value = values[setting.key];
        valueEl.textContent = formatSettingValue(setting, values[setting.key]);
        if (syncRangeFill) syncRangeFill();
      });
      // Order lists are not in `controls` (they have no input element), so they
      // rebuild themselves from the restored values.
      orderRepaints.forEach((repaint) => repaint());
      postExtensionSettings(ext.id, values);
      saveExtensionSettings(ext.id, values);
      // Reset is a single deliberate apply, so it does not need deferral — clear
      // any stale pending post so closeDetail() does not re-fire it (AJ, 2026-10-19).
      pendingOrderPost = null;
      toast("Settings reset");
    });
    section.appendChild(reset);
    if (ext.id === "ytmod-spicy-lyrics") {
      // Its own block rather than a settings row: upload + previews + apply.
      const commitFont = (patch) => {
        Object.assign(values, patch);
        postExtensionSettings(ext.id, patch);
        saveExtensionSettings(ext.id, values);
      };
      const font = buildCustomFontSection(ext, values, commitFont);
      fontCtl = font;
      // The font block is an advanced extra, so it stays collapsed behind a
      // "More" disclosure under all the settings. The grid-rows transition gives
      // it a real height animation (display:none cannot).
      const moreLabel = h("span", { class: "ym-cfont-more-label", text: "More" });
      const moreBtn = h("button", { class: "ym-cfont-more", type: "button", "aria-expanded": "false" }, moreLabel);
      const chev = svgIcon("M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z");
      chev.setAttribute("fill", "currentColor");
      moreBtn.appendChild(chev);
      const collapse = h("div", { class: "ym-cfont-collapse" });
      collapse.append(h("div", { class: "ym-cfont-collapse-inner" }, font.el));
      moreBtn.addEventListener("click", () => {
        const open = !collapse.classList.contains("open");
        collapse.classList.toggle("open", open);
        moreBtn.classList.toggle("is-open", open);
        moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
        moreLabel.textContent = open ? "Less" : "More";
        font.setActive(open);
      });
      section.append(moreBtn, collapse);
    }
    postExtensionSettings(ext.id, values);
    // Cascade the settings in with the SAME motion language the detail pane
    // uses when you switch add-ons, so a block that appears right after
    // "Installing…" lands instead of popping (AJ, 2026-10-19).
    if (section.animate) {
      Array.from(section.children).forEach((el, i) => {
        if (!el.animate) return;
        el.animate(
          [{ opacity: 0, transform: "translateY(18px)" }, { opacity: 1, transform: "none" }],
          { duration: 540, delay: 40 + i * 54, easing: "cubic-bezier(.34,1.4,.5,1)", fill: "backwards" }
        );
      });
    }
    return section;
  }

  /* ---- YTMod API + marketplace state ----
     NOTE: the public `window.YTMod` lives in the PAGE world (src/content/public-api.js),
     injected by boot(). The content script runs in an isolated world, so its own
     window.YTMod is invisible to the console. Player readers + open/install controls
     are bridged to this isolated world via window.postMessage. */
  const ui = {
    category: "Extensions",
    // view / density / floating are PINNED (AJ, 2026-09-28): the toolbar was
    // removed and the panel is now always the centred glass card.
    view: "grid",
    density: "comfortable",
    floating: true,
    floatX: null,
    floatY: null,
    dev: false,
  };

  /* ---- secret developer mode -----------------------------------------------
     Tap the "Aurora Lyrics" title in the marketplace header 6 times in a row to
     reveal the per-add-on settings; 6 more to hide them again.

     Hidden by DEFAULT rather than moved to a separate page: those sliders are a
     tuning surface, and a normal user has no reason to meet 14 of them on the
     Synced Lyrics detail page. Nothing on screen hints that the title is
     interactive — that is the whole point, so do NOT add an affordance, a title
     attribute, or an aria hint.

     Persisted in the same `ytmod_ui` store as the view preferences, so it
     survives a reload without needing its own key. */
  const DEV_TAP_COUNT = 6;
  // "6 times in a row" needs a run-breaker, or any 6 taps across a whole session
  // would eventually trip it. Generous for a slow tapper, short enough that two
  // stray clicks a minute apart do not accumulate.
  const DEV_TAP_WINDOW_MS = 900;
  let devTaps = 0;
  let devTapTimer = 0;
  let detailExt = null; // the ext currently rendered by renderDetail, for re-render

  function setDevMode(on) {
    ui.dev = !!on;
    setUI({ dev: ui.dev });
    toast(ui.dev ? "Developer mode on" : "Developer mode off");
    // Settings only exist inside a detail view, so re-render whatever is on
    // screen to apply the change now instead of on the next navigation.
    if (mkDetail && mkSel !== "home") renderSection();
  }

  function onTitleTap() {
    if (devTapTimer) clearTimeout(devTapTimer);
    devTaps += 1;
    if (devTaps >= DEV_TAP_COUNT) {
      devTaps = 0;
      devTapTimer = 0;
      setDevMode(!ui.dev);
      return;
    }
    devTapTimer = window.setTimeout(() => {
      devTaps = 0;
      devTapTimer = 0;
    }, DEV_TAP_WINDOW_MS);
  }

  let overlay;
  let floatBtn = null;
  // Detail sheet (AJ, 2026-09-28): the detail view is now a SHEET that morphs
  // out of the clicked card's thumb, instead of swapping the whole section.
  let sheetEl = null, sheetBg = null, sheetCover = null, sheetScrim = null,
      sheetPoster = null, sheetText = null, sheetCloseBtn = null;
  let tabThumb = null;       // sliding tab indicator (AJ, 2026-09-28)
  let watermarkEl = null;    // ambient panel background (track cover, else the logo)
  let watermarkAltEl = null; // second layer, cross-faded when the cover changes
  let currentArtUrl = "";
  let LOGO_URL = "";
  let thumbVideoObserver = null; // plays list loops only while on screen
  let sheetCard = null;      // the card the sheet morphed out of
  let sheetOpen = false;
  let sheetState = "closed"; // closed | opening | open | closing
  let sheetAnims = [];
  let marketplaceCloseTimer = 0;
  let marketplaceCloseHandler = null;
  let marketplaceOpenTimer = 0;

  function openMarketplace() {
    if (!overlay) return;
    if (marketplaceCloseTimer) clearTimeout(marketplaceCloseTimer);
    marketplaceCloseTimer = 0;
    if (marketplaceCloseHandler) {
      overlay.removeEventListener("animationend", marketplaceCloseHandler);
      marketplaceCloseHandler = null;
    }
    overlay.classList.remove("hidden", "ym-leaving", "ym-opening");
    refreshPanelArt();
    startHomeTrackWatch();
    // QUIET refresh: the section was already rendered while the overlay was
    // hidden, and the open animation below fades the whole panel in. A normal
    // renderSection() replays mkAnimateIn()'s stagger on top of that, so the
    // user sees the content, then watches it fade in again (AJ, 2026-10-21).
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      renderSection(true);
      return;
    }
    // Force a fresh animation when reopening quickly after a close.
    void overlay.offsetWidth;
    overlay.classList.add("ym-opening");
    marketplaceOpenTimer = window.setTimeout(() => {
      overlay.classList.remove("ym-opening");
      marketplaceOpenTimer = 0;
    }, 280);
    renderSection(true);
  }

  function closeMarketplace() {
    stopHomeTrackWatch();
    if (!overlay || overlay.classList.contains("hidden") || overlay.classList.contains("ym-leaving")) return;
    // Reset the detail sheet instantly (no morph) so reopening starts clean.
    if (sheetOpen) finishCloseDetail();
    if (marketplaceOpenTimer) clearTimeout(marketplaceOpenTimer);
    marketplaceOpenTimer = 0;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      overlay.classList.add("hidden");
      return;
    }
    overlay.classList.remove("ym-opening");
    overlay.classList.add("ym-leaving");
    const finish = () => {
      if (marketplaceCloseTimer) clearTimeout(marketplaceCloseTimer);
      marketplaceCloseTimer = 0;
      if (marketplaceCloseHandler) {
        overlay.removeEventListener("animationend", marketplaceCloseHandler);
        marketplaceCloseHandler = null;
      }
      overlay.classList.remove("ym-leaving");
      overlay.classList.add("hidden");
    };
    marketplaceCloseHandler = (event) => {
      if (event.target === overlay && event.animationName === "ym-market-close") finish();
    };
    overlay.addEventListener("animationend", marketplaceCloseHandler);
    marketplaceCloseTimer = window.setTimeout(finish, 280);
  }

  function syncFloatButton() {
    if (!floatBtn) return;
    const title = ui.floating ? "Use full-screen marketplace" : "Use floating marketplace";
    floatBtn.replaceChildren(svgIcon(ICON_FLOAT));
    floatBtn.title = title;
    floatBtn.setAttribute("aria-label", title);
    floatBtn.classList.toggle("active", ui.floating);
  }

  function applyMarketplaceMode(persist) {
    if (!overlay) return;
    overlay.classList.toggle("ym-floating", ui.floating);
    if (ui.floating) {
      if (Number.isFinite(ui.floatX) && Number.isFinite(ui.floatY)) {
        const place = () => {
          if (!overlay || !ui.floating) return;
          overlay.style.left = ui.floatX + "px";
          overlay.style.top = ui.floatY + "px";
          overlay.style.transform = "none";
          const rect = overlay.getBoundingClientRect();
          overlay.style.left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, rect.left)) + "px";
          overlay.style.top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, rect.top)) + "px";
        };
        if (persist) {
          overlay.style.removeProperty("left");
          overlay.style.removeProperty("top");
          overlay.style.removeProperty("transform");
          requestAnimationFrame(place);
        } else {
          place();
        }
      }
    } else {
      overlay.classList.remove("ym-dragging");
      overlay.style.removeProperty("left");
      overlay.style.removeProperty("top");
      overlay.style.removeProperty("transform");
    }
    syncFloatButton();
    if (persist) setUI({ floating: ui.floating, floatX: ui.floatX, floatY: ui.floatY });
  }

  function enableMarketplaceDrag(header) {
    let drag = null;
    header.addEventListener("pointerdown", (event) => {
      if (!ui.floating || event.button !== 0) return;
      if (event.target.closest("button, input, select, textarea, a")) return;
      const rect = overlay.getBoundingClientRect();
      overlay.style.left = rect.left + "px";
      overlay.style.top = rect.top + "px";
      overlay.style.transform = "none";
      drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      header.setPointerCapture(event.pointerId);
      overlay.classList.add("ym-dragging");
      event.preventDefault();
    });
    header.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const rect = overlay.getBoundingClientRect();
      const x = Math.max(8, Math.min(window.innerWidth - rect.width - 8, event.clientX - drag.offsetX));
      const y = Math.max(8, Math.min(window.innerHeight - rect.height - 8, event.clientY - drag.offsetY));
      overlay.style.left = x + "px";
      overlay.style.top = y + "px";
    });
    const finishDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      try { header.releasePointerCapture(event.pointerId); } catch (_) {}
      const rect = overlay.getBoundingClientRect();
      ui.floatX = Math.round(rect.left);
      ui.floatY = Math.round(rect.top);
      overlay.classList.remove("ym-dragging");
      setUI({ floatX: ui.floatX, floatY: ui.floatY });
      drag = null;
    };
    header.addEventListener("pointerup", finishDrag);
    header.addEventListener("pointercancel", finishDrag);
  }

  async function install(id) {
    const ext = findAvail(id);
    if (!ext || ext.comingSoon) return;
    // Defense in depth: the rail, the detail button and the page-world API all
    // arrive here, and Low mode must refuse all three.
    if (lowModeBlocks(id)) { toast(lowModeNotice(id)); return; }
    const reg = await getReg();
    reg[id] = { enabled: true, version: ext.version || "?", installedAt: Date.now() };
    await setReg(reg);
    await makeThemeExclusive(id);
    applyExtension(id, true);
    toast((ext.name || id) + " installed");
    renderSection(true);
    console.debug("[YTMod] installed extension:", id);
  }

  async function setEnabled(id, on) {
    const reg = await getReg();
    if (!reg[id]) return;
    reg[id].enabled = on;
    await setReg(reg);
    if (on) await makeThemeExclusive(id);
    applyExtension(id, on);
    const e = findAvail(id);
    toast((e ? e.name : id) + (on ? " enabled" : " disabled"));
    console.debug("[YTMod] extension", id, on ? "enabled" : "disabled");
  }

  /* ---- "restart required" notice ---------------------------------------
     Uninstalling sends the add-on a teardown message, but a page-world script
     cannot reliably undo everything it attached: observers, timers, injected
     <style> nodes and patched prototypes all survive their own teardown. A page
     reload is the only honest reset, so we ASK for one instead of claiming the
     removal is complete and leaving the user with half-removed code
     (AJ, 2026-10-21). */
  let restartScrim = null;
  let restartTextEl = null;

  function hideRestartRequired() {
    if (restartScrim) restartScrim.classList.add("hidden");
  }

  function showRestartRequired(name) {
    if (!restartScrim) {
      restartScrim = h("div", { class: "ym-restart-scrim hidden" });
      const card = h("div", {
        class: "ym-restart-card",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "ym-restart-title",
      });
      card.appendChild(h("div", { class: "ym-restart-badge", "aria-hidden": "true", text: "\u27f3" }));
      card.appendChild(h("h2", { class: "ym-restart-title", id: "ym-restart-title", text: "Restart YouTube Music" }));
      restartTextEl = h("p", { class: "ym-restart-text" });
      card.appendChild(restartTextEl);
      card.appendChild(h("p", {
        class: "ym-restart-note",
        text: "Everything else you have installed keeps working \u2014 only a reload clears the leftover code.",
      }));
      const actions = h("div", { class: "ym-restart-actions" });
      const later = h("button", { class: "ym-restart-later", type: "button", text: "Later" });
      const now = h("button", { class: "ym-restart-now", type: "button", text: "Restart now" });
      later.addEventListener("click", hideRestartRequired);
      now.addEventListener("click", () => {
        try { location.reload(); } catch (e) {}
      });
      actions.append(later, now);
      card.appendChild(actions);
      restartScrim.appendChild(card);
      // Click-outside and Escape both mean "Later" — never trap the user.
      restartScrim.addEventListener("click", (ev) => {
        if (ev.target === restartScrim) hideRestartRequired();
      });
      document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape" && restartScrim && !restartScrim.classList.contains("hidden")) {
          hideRestartRequired();
        }
      });
      document.body.appendChild(restartScrim);
    }
    restartTextEl.textContent = (name || "The add-on") +
      " was removed. Some of its code can stay loaded until the page reloads, so restart YouTube Music to finish removing it.";
    restartScrim.classList.remove("hidden");
    const nowBtn = restartScrim.querySelector(".ym-restart-now");
    if (nowBtn && typeof nowBtn.focus === "function") nowBtn.focus();
  }

  async function uninstall(id) {
    const reg = await getReg();
    if (!reg[id]) return;
    const ext = findAvail(id);
    applyExtension(id, false);
    delete reg[id];
    await setReg(reg);
    await removeExtensionSettings(id);
    // Drop any uploaded background too, or the blob outlives the add-on.
    await bgDel(id);
    renderSection(true);
    // AFTER the re-render, so the panel already shows the add-on as available
    // behind the notice instead of the stale "Uninstalling" state.
    showRestartRequired(ext ? ext.name : id);
    console.debug("[YTMod] uninstalled extension:", id);
  }

  // Promote registerExtension to a top-level function so the page-world bridge
  // (which performs the real chrome.storage work) can call it.
  async function registerExtension(manifest) {
    if (!findAvail(manifest.id)) AVAILABLE.push(manifest);
    return install(manifest.id);
  }

  /* ---- marketplace UI (Spicetify-style: tabs + sort + search + grid) ---- */
  // Ambient panel background (AJ, 2026-09-28): the now-playing cover, blurred and
  // dimmed, so the panel picks up the track's colour. Falls back to the logo.
  function currentTrackArt() {
    const img =
      document.querySelector("ytmusic-miniplayer img.ytmusicTrackInfoThumbnail") ||
      document.querySelector("ytmusic-miniplayer img") ||
      document.querySelector("ytmusic-player-bar img.image") ||
      document.querySelector("ytmusic-player-bar img") ||
      document.querySelector("#song-image img") ||
      document.querySelector("ytmusic-player-page img");
    const src = img && img.getAttribute("src");
    return src && /^https?:/.test(src) ? src : "";
  }

  function refreshPanelArt() {
    if (!watermarkEl) return;
    const art = currentTrackArt();
    const url = art || LOGO_URL;
    if (!url || url === currentArtUrl) return;
    currentArtUrl = url;
    const next = 'url("' + url + '")';
    const isCover = !!art;

    if (!watermarkAltEl || reducedMotion()) {
      watermarkEl.style.backgroundImage = next;
      watermarkEl.classList.toggle("is-cover", isCover);
      return;
    }
    // Cross-fade: paint the incoming art on the alt layer, ease it up to the same
    // dimness, then promote it and clear the alt. `background-image` itself cannot
    // be transitioned, hence two layers (AJ, 2026-09-28).
    const targetOp = isCover ? 0.2 : 0.14; // mirrors the CSS (.ym-watermark / .is-cover)
    watermarkAltEl.style.backgroundImage = next;
    watermarkAltEl.classList.toggle("is-cover", isCover);
    const a = watermarkAltEl.animate(
      [{ opacity: 0 }, { opacity: targetOp }],
      { duration: 700, easing: "cubic-bezier(0.32,0.72,0,1)", fill: "both" });
    a.onfinish = () => {
      watermarkEl.style.backgroundImage = next;
      watermarkEl.classList.toggle("is-cover", isCover);
      watermarkAltEl.style.backgroundImage = "";
      try { a.cancel(); } catch (_) {}
    };
  }

  // Play a list thumb's loop only while it is on screen (AJ, 2026-09-28): a grid
  // of autoplaying videos would otherwise keep decoding every one of them.
  function observeThumbVideo(v) {
    if (!v) return;
    if (typeof IntersectionObserver === "undefined") {
      const p = v.play(); if (p && p.catch) p.catch(() => {});
      return;
    }
    if (!thumbVideoObserver) {
      thumbVideoObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          const el = e.target;
          if (e.isIntersecting) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
          else { try { el.pause(); } catch (_) {} }
        }
      }, { root: null, threshold: 0.01 });
    }
    thumbVideoObserver.observe(v);
  }

  // Slide the tab indicator under the active tab. Runs on open, on tab click, and
  // on resize (tab widths depend on their text).
  function moveTabThumb() {
    if (!overlay || !tabThumb) return;
    const row = overlay.querySelector(".ym-tabs-row");
    const active = row && row.querySelector(".ym-tab.active");
    if (!active) return;
    tabThumb.style.width = active.offsetWidth + "px";
    tabThumb.style.transform = "translateX(" + active.offsetLeft + "px)";
  }

  // Switch category with motion: the current list fades OUT, then the new list
  // renders and its cards fade in (the existing ym-card-in stagger via --d).

  function marketKey(e) {
    if (!overlay || overlay.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      // The YouTube tab's section picker owns ONE level of Escape, so stepping
      // out of a section does not also close the panel (AJ, 2026-10-22).
      if (mkSel === "youtube" && ytBackToPicker) { ytBackToPicker(); return; }
      closeMarketplace();
      return;
    }
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    if (!mkRows) return;
    // :not(.ym-mk-card-discord) — the Discord row is a link, so it must not be
    // reachable with the arrows (they CLICK the card they land on).
    const cards = $$(".ym-mk-card:not(.ym-mk-card-discord)", mkRows);
    if (!cards.length) return;
    const cur = cards.findIndex((c) => c.classList.contains("sel"));
    let i = cur < 0 ? 0 : cur;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); i = Math.min(cards.length - 1, i + 1); }
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); i = Math.max(0, i - 1); }
    else if (e.key === "Home") { e.preventDefault(); i = 0; }
    else if (e.key === "End") { e.preventDefault(); i = cards.length - 1; }
    else if (e.key === "Enter") { e.preventDefault(); if (cards[i]) cards[i].click(); return; }
    else return;
    if (cards[i]) cards[i].click();
  }

  // Bridge from the page-world public API (src/content/public-api.js). It posts
  // {type:"ytmod-cmd"} messages; we perform the isolated-world work (chrome.storage,
  // registry, marketplace render) and post {type:"ytmod-resp"} back.
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d) return;
    if (d.type === "ytmod-settings-request" && typeof d.id === "string") {
      const ext = findAvail(d.id);
      if (ext && ext.settings) {
        // The mode must be known BEFORE the first envelope goes out, or an add-on
        // that mounts early would start in Ultra and never be corrected.
        loadPerformanceMode()
          .then(() => getExtensionSettings(ext))
          .then((settings) => postExtensionSettings(d.id, settings));
      }
      return;
    }
    if (d.type !== "ytmod-cmd") return;
    const { id, method, args } = d;
    const respond = (ok, result) => { if (id) window.postMessage({ type: "ytmod-resp", id, ok, result }, "*"); };
    (async () => {
      try {
        let r;
        switch (method) {
          case "openMarketplace": openMarketplace(); r = true; break;
          case "closeMarketplace": closeMarketplace(); r = true; break;
          case "install": await install(args[0]); r = true; break;
          case "setExtensionEnabled": await setEnabled(args[0], args[1]); r = true; break;
          case "saveExtensionSettings": await saveExtensionSettings(args[0], args[1]); r = true; break;
          case "getRegistry": r = await getReg(); break;
          case "getAvailable": r = AVAILABLE.slice(); break;
          case "registerExtension": r = await registerExtension(args[0]); break;
          case "getPermanentLyrics": r = await getPermanentLyrics(args[0]); break;
          case "setPermanentLyrics": await setPermanentLyrics(args[0], args[1]); r = true; break;
          case "removePermanentLyrics": await removePermanentLyrics(args[0]); r = true; break;
          case "getSpicyCache": r = await getSpicyCache(); break;
          case "setSpicyCache": await setSpicyCache(args[0]); r = true; break;
          case "clearSpicyCache": await clearSpicyCache(); r = true; break;
          case "fetchLRCLIB": r = await fetchLRCLIB(args[0]); break;
          case "fetchMusicBrainzRecordingSearch":
            r = await fetchMusicBrainzRecordingSearch(args[0], args[1], args[2], args[3]);
            break;
          case "fetchDeezerTracks":
            r = await fetchDeezerTracks(args[0], args[1], args[2]);
            break;
          case "fetchCoverArt": r = await fetchCoverArt(args[0], args[1]); break;
          default: throw new Error("unknown method " + method);
        }
        respond(true, r);
      } catch (err) {
        respond(false, String(err && err.message ? err.message : err));
      }
    })();
  });

  // Inject the page-world public API so `window.YTMod` is reachable from the DevTools
  // console (and other page-world scripts). Must run after the bridge listener above
  // is registered.
  function injectPublicAPI() {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("src/content/public-api.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  /* ---- marketplace v2: rail + master–detail (AJ, 2026-10-19) ----------
     Replaces the tabs + grid + sheet surface. The registry, install /
     uninstall, settings engine, floating drag and dev gesture are unchanged;
     this block only owns how the catalog is presented. */
  let mkRows = null, mkInd = null, mkDetail = null, mkSegPill = null;
  let mkSel = "home", mkFilter = "All";
  let mkAutoCollapsed = false;
  let mkNarrowState = null;

  // Compact rail: auto-collapse below 860px, but only when the breakpoint is
  // actually crossed — otherwise every re-render would undo a manual expand.
  function syncMkCollapse() {
    if (!overlay) return;
    const narrow = !!(window.matchMedia && window.matchMedia("(max-width: 860px)").matches);
    if (mkNarrowState === narrow) return;
    mkNarrowState = narrow;
    if (narrow) {
      if (!overlay.classList.contains("ym-mk-collapsed")) {
        overlay.classList.add("ym-mk-collapsed");
        mkAutoCollapsed = true;
      }
    } else if (mkAutoCollapsed) {
      overlay.classList.remove("ym-mk-collapsed");
      mkAutoCollapsed = false;
    }
  }

  // Only these add-ons carry a preview clip (AJ, 2026-10-19).
  // PiP Lyrics removed entirely: its preview showed real lyric text, and even
  // the logo fallback read as a preview slot (AJ, 2026-10-19).
  // Plain-language "what it does / pros / cons" shown from the info button next
  // to each add-on's Settings heading. Kept short and concrete — this is the
  // text a first-time user actually reads before installing (AJ, 2026-10-19).
  const MK_INFO = {
    "ytmod-dynamic": {
      what: "Replaces the flat page background with a live, blurred version of the current artwork (or music video).",
      pros: ["Ties the whole app to the song you're playing", "Follows the video on music videos", "Adjustable brightness, saturation and warp"],
      cons: ["Uses GPU continuously while playing", "Most visible on pages with large empty areas"],
    },
    "ytmod-spicy-lyrics": {
      what: "The lyric engine: synced lyrics, word-by-word animation, TTML import, offset control and fullscreen layouts.",
      pros: ["Best-in-class word and letter animation", "Imported TTML and per-track offsets", "Three fullscreen layouts"],
      cons: ["Imported TTML files are the only way to fix badly timed songs", "Fullscreen modes are heavier on older hardware"],
    },
    "ytmod-smooth-motion": {
      what: "Animates page, sidebar and player transitions instead of letting YouTube Music snap between states.",
      pros: ["Makes navigation feel fluid", "Covers the guide, player and video resize"],
      cons: ["Adds a short transition you can't skip", "Can feel slower on very low-end machines"],
    },
    "ytmod-sleep-timer": {
      what: "Pauses playback after a set time or at the end of the current track.",
      pros: ["No need to keep the tab focused", "Fades out rather than cutting abruptly"],
      cons: ["Timer state resets if you reload the page", "One timer at a time"],
    },
    "ytmod-pip-lyrics": {
      what: "Shows the current lyric line in a small always-on-top window.",
      pros: ["Lyrics stay visible while you use other apps", "Follows the main renderer's styling"],
      cons: ["Needs a second window open", "Limited to one line of context"],
    },
    "ytmod-next-up": {
      what: "Shows the next track in the player bar, with its cover art.",
      pros: ["See the queue without opening it", "One click to skip straight to that track"],
      cons: ["Reads YouTube's queue, so it follows YTM's own ordering", "Hides itself when the bar has no room for it"],
    },
    "ytmod-song-notes": {
      what: "Lets you attach private notes to a track and read them back later.",
      pros: ["Notes are stored per track", "Useful for references and reminders"],
      cons: ["Stored locally, not synced across devices", "No rich text formatting"],
    },
    "snippet-track-toast": {
      what: "Pops a small notification with the song, artist and cover art whenever a track starts.",
      pros: ["Useful when the player bar is hidden", "Unobtrusive and auto-dismisses"],
      cons: ["Can overlap content briefly", "Duplicates the player bar on the song view"],
    },
    "snippet-centered-home": {
      what: "Centers the home page section headers and filter chips.",
      pros: ["Calmer, more balanced home layout", "No configuration needed"],
      cons: ["Purely cosmetic", "Can look off on very wide screens"],
    },
    "snippet-arrow-seek": {
      what: "Lets the left and right arrow keys scrub the song instead of doing nothing.",
      pros: ["No new buttons to learn", "Shift jumps three times further", "Works on the player page and in fullscreen"],
      cons: ["Claims the arrow keys for the whole page", "The step is a fixed number of seconds, not a percentage"],
    },
    "snippet-npv-panel": {
      what: "A docked side rail with cover art or video, title, artist card, lyrics and the up-next queue.",
      pros: ["Keeps lyrics and queue visible while browsing", "Collapses to a thin edge", "Follows the Aurora Bloom backdrop"],
      cons: ["Takes horizontal space while open", "Feels cramped in a narrow window"],
    },
  };

  // Per-add-on glyph + tint for the rail tiles and the detail monogram.
  const MK_GLYPH = {
    "ytmod-dynamic":      { c: "#ff4d6a", d: "M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z" },
    "ytmod-spicy-lyrics": { c: "#ff5c9e", d: "M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" },
    "ytmod-smooth-motion": { c: "#7aa2ff", d: "M3 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0v3c-2-3-4-3-6 0s-4 3-6 0-4-3-6 0z" },
    "ytmod-sleep-timer":  { c: "#9b8cff", d: "M12 3a9 9 0 108.5 12A7 7 0 1112 3z" },
    "ytmod-pip-lyrics":   { c: "#ffb454", d: "M3 5h18v14H3V5zm2 2v10h14V7H5zm6 4h6v4h-6v-4z" },
    "ytmod-next-up":      { c: "#4fd1c5", d: "M4 6h12v2H4V6zm0 5h12v2H4v-2zm0 5h8v2H4v-2zm14-5l4 3-4 3v-6z" },
    "ytmod-song-notes":   { c: "#f5c542", d: "M4 4h16v12H8l-4 4V4zm3 4h10v2H7V8zm0 4h7v2H7v-2z" },
    "snippet-track-toast":{ c: "#9aa7ff", d: "M12 22a2 2 0 002-2h-4a2 2 0 002 2zm7-6V11a7 7 0 10-14 0v5l-2 2v1h18v-1l-2-2z" },
    "snippet-centered-home": { c: "#a78bfa", d: "M7 5h10v2H7zM5 9h14v2H5zM8 13h8v2H8zM6 17h12v2H6z" },
    "snippet-npv-panel":  { c: "#ff4d6a", d: "M3 4h18v16H3V4zm2 2v12h4V6H5zm6 0v12h8V6h-9z" },
    // Two outward triangles = seek back / forward. Deep accent so it does not
    // read the same as the two #ff4d6a tiles above (AJ, 2026-10-20).
    "snippet-arrow-seek": { c: "#e01040", d: "M10 7v10l-6-5zM14 7v10l6-5z" },
    // The YouTube PAGE (not an add-on card). Brand red, the same sanctioned
    // exception as the Discord row: it has to read as YouTube at a glance.
    youtube: { c: "#ff4a4a", d: "M21.6 7.2a2.5 2.5 0 0 0-1.76-1.77C18.25 5 12 5 12 5s-6.25 0-7.84.43A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.76 1.77C5.75 19 12 19 12 19s6.25 0 7.84-.43a2.5 2.5 0 0 0 1.76-1.77A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15V9l5.2 3z" },
    // A built-in theme rather than an add-on: the note wears Apple Music's pink
    // in the rail, so the row never reads as a missing installed check.
    [APPLE_THEME_ID]: { c: "#fa2d48", d: "M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" },
  };
  // "#rrggbb" + alpha byte, for the tinted tile background/border.
  const mkTint = (hex, alpha) => hex + alpha;

  // Attribution for Aurora Lyrics. Spicy ToS s6 requires naming the provider
  // on screen wherever lyrics appear.
  const MK_SOURCES = {
    "ytmod-spicy-lyrics": [
      ["Lyrics", [["Spicy Lyrics", "https://spicylyrics.org/"], ["LRCLIB", "https://lrclib.net/"]]],
      ["Track matching", [["MusicBrainz", "https://musicbrainz.org/"], ["ListenBrainz", "https://listenbrainz.org/"]]],
    ],
  };
  const MK_LNK = {
    "Spicy Lyrics": "ym-mk-lnk-spicy",
    LRCLIB: "ym-mk-lnk-lrclib",
    MusicBrainz: "ym-mk-lnk-mb",
    ListenBrainz: "ym-mk-lnk-lb",
  };
  const MK_CHECK = "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z";
  const MK_HOME = "M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z";
  const MK_PLUS = "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z";
  const MK_CAT_ORDER = { Themes: 0, Extensions: 1, Snippets: 2 };

  // AVAILABLE is not grouped by category (Aurora Flow sits between two
  // Extensions), so a naive "category changed" check emits the same heading
  // twice. Sort by the rail order first — Array#sort is stable, so the catalog
  // order inside each group is preserved.
  function mkFilteredList() {
    return AVAILABLE
      .filter((e) => mkFilter === "All" || e.category === mkFilter)
      .slice()
      .sort((a, b) => (MK_CAT_ORDER[a.category] ?? 9) - (MK_CAT_ORDER[b.category] ?? 9));
  }

  function mkLogoUrl() {
    try { return chrome.runtime.getURL("assets/manifest-logo.webp"); } catch (_) { return ""; }
  }

  // Outline trash with a separate lid group so it can swing open on click.
  function mkTrashIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.9");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const lid = document.createElementNS(NS, "g");
    lid.setAttribute("class", "ym-mk-lid");
    // Same pivot as the mockup. Without it the lid rotates around the SVG
    // origin and visibly detaches from the bin.
    lid.style.transformBox = "view-box";
    lid.style.transformOrigin = "9px 6px";
    for (const d of ["M4 7h16", "M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"]) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      lid.appendChild(p);
    }
    svg.appendChild(lid);
    for (const d of [
      "M6.5 7l.9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7",
      "M10 11v6M14 11v6",
    ]) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }

  function mkSidebarIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const rect = document.createElementNS(NS, "rect");
    for (const pair of [["x", "3"], ["y", "4"], ["width", "18"], ["height", "16"], ["rx", "3"]]) rect.setAttribute(pair[0], pair[1]);
    const line = document.createElementNS(NS, "path");
    line.setAttribute("d", "M9.5 4v16");
    svg.appendChild(rect);
    svg.appendChild(line);
    return svg;
  }

  function mkCard(id, label, monoText, installed, isHome) {
    const card = h("div", {
      class: "ym-mk-card" + (installed ? " installed" : "") + (String(mkSel) === String(id) ? " sel" : ""),
      "data-id": id,
      role: "button",
      tabindex: "0",
    });
    const mono = h("div", { class: "ym-mk-mono" });
    const glyph = !isHome && MK_GLYPH[id];
    if (isHome) mono.appendChild(svgIcon(MK_HOME));
    else if (glyph) {
      mono.appendChild(svgIcon(glyph.d));
      mono.style.color = glyph.c;
      mono.style.background = mkTint(glyph.c, "1f");
      mono.style.borderColor = mkTint(glyph.c, "3d");
    } else mono.textContent = monoText;
    card.appendChild(mono);
    card.appendChild(h("div", { class: "ym-mk-name", text: label }));
    if (installed) {
      const chk = svgIcon(MK_CHECK);
      chk.classList.add("ym-mk-check");
      card.appendChild(chk);
    }
    // Low performance mode greys the add-ons it will not run and says why on
    // click, instead of opening a page whose Install button cannot work. Low also
    // uninstalls them (see applyPerformanceRestrictions), so the row reads as an
    // ordinary catalog entry plus this class. The rail is re-rendered on every
    // mode change, so `blocked` is always current.
    const blocked = lowModeBlocks(id);
    if (blocked) {
      card.classList.add("ym-mk-card-blocked");
      card.setAttribute("aria-disabled", "true");
    }
    const go = () => {
      if (blocked) { toast(lowModeNotice(id)); return; }
      mkSelect(id);
    };
    card.addEventListener("click", go);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
    return card;
  }

  // An <a> with the rail-card classes, so it inherits the same hover, press and
  // focus treatment as the add-on rows. Deliberately NOT given a data-id and
  // excluded from the arrow-key list below: arrows must never fire an external
  // link, and the rail indicator only tracks selectable rows.
  function mkDiscordCard() {
    const card = h("a", {
      class: "ym-mk-card ym-mk-card-discord",
      href: REPORT_DISCORD_URL,
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Open the Aurora Lyrics Discord server",
      "aria-label": "Join the Aurora Lyrics Discord server",
    });
    card.appendChild(h("div", { class: "ym-mk-mono" }, svgIcon(MK_DISCORD_PATH)));
    card.appendChild(h("div", { class: "ym-mk-name", text: "Discord Server" }));
    const out = svgIcon(MK_ARROW_PATH);
    out.classList.add("ym-mk-out");
    card.appendChild(out);
    return card;
  }

  function mkBuildRows(list, reg) {
    if (!mkRows || !mkInd) return;
    mkRows.replaceChildren(mkInd);
    // Home leads the rail: it is the landing view, so the external link and the
    // site's own settings sit under it rather than above it (AJ, 2026-10-22).
    mkRows.appendChild(mkCard("home", "Home", "", false, true));
    mkRows.appendChild(mkDiscordCard());
    // Its own page rather than an add-on card: it is YouTube's settings, not
    // Aurora's, so it must not appear as something to install (AJ, 2026-10-22).
    // It wears the Discord row's "this is not an add-on" treatment in YouTube
    // red, so the two rail entries above the add-on list read as one pair
    // (AJ, 2026-10-22).
    const ytCard = mkCard("youtube", "YouTube Modifications", "YT", false, false);
    ytCard.classList.add("ym-mk-card-yt");
    mkRows.appendChild(ytCard);
    let last = null;
    for (const ext of list) {
      if (ext.category !== last) {
        last = ext.category;
        mkRows.appendChild(h("div", { class: "ym-mk-cat", text: ext.category || "Add-ons" }));
      }
      const card = mkCard(ext.id, ext.name, (ext.name || "?").charAt(0).toUpperCase(), !!reg[ext.id], false);
      mkRows.appendChild(card);
    }
    mkPositionInd(true);
  }

  function mkPositionInd(instant) {
    if (!mkInd || !mkRows) return;
    const el = mkRows.querySelector(".ym-mk-card.sel");
    if (!el) { mkInd.style.opacity = "0"; return; }
    mkInd.style.opacity = "1";
    if (instant) mkInd.style.transition = "none";
    mkInd.style.height = el.offsetHeight + "px";
    mkInd.style.transform = "translateY(" + el.offsetTop + "px)";
    if (instant) requestAnimationFrame(() => { mkInd.style.transition = ""; });
  }

  function mkPositionSegPill(instant) {
    if (!mkSegPill || !overlay) return;
    const btn = overlay.querySelector(".ym-mk-segbtn.on");
    if (!btn) return;
    if (instant) mkSegPill.style.transition = "none";
    mkSegPill.style.width = btn.offsetWidth + "px";
    mkSegPill.style.transform = "translateX(" + btn.offsetLeft + "px)";
    if (instant) requestAnimationFrame(() => { mkSegPill.style.transition = ""; });
  }

  // Filter switch: the rail cascades out in the direction of travel, then the
  // new list cascades in from the opposite side.
  function mkListOut(dir) {
    if (!mkRows) return Promise.resolve();
    const items = Array.from(mkRows.querySelectorAll(".ym-mk-card, .ym-mk-cat"));
    if (!items.length) return Promise.resolve();
    items.forEach((el, i) => {
      if (!el.animate) return;
      el.animate([
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateX(" + dir * 10 + "px)" },
      ], { duration: 140, delay: i * 12, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" });
    });
    return new Promise((resolve) => setTimeout(resolve, items.length * 12 + 160));
  }

  function mkListIn(dir) {
    if (!mkRows) return;
    const items = Array.from(mkRows.querySelectorAll(".ym-mk-card, .ym-mk-cat"));
    items.forEach((el, i) => {
      if (!el.animate) return;
      el.animate([
        { opacity: 0, transform: "translateX(" + -dir * 12 + "px)" },
        { opacity: 1, transform: "none" },
      ], { duration: 340, delay: i * 20, easing: "cubic-bezier(.34,1.3,.5,1)", fill: "both" });
    });
  }

  function mkAnimateIn() {
    if (!mkDetail) return;
    const w = mkDetail.firstElementChild;
    if (!w || !w.animate) return;
    Array.from(w.children).forEach((el, i) => {
      if (!el.animate) return;
      el.animate(
        [{ opacity: 0, transform: "translateY(18px)" }, { opacity: 1, transform: "none" }],
        { duration: 540, delay: 40 + i * 54, easing: "cubic-bezier(.34,1.4,.5,1)", fill: "both" }
      );
    });
    const m = w.querySelector(".ym-mk-dmono");
    if (m && m.animate) {
      m.animate([{ transform: "scale(.84)" }, { transform: "scale(1)" }],
        { duration: 640, easing: "cubic-bezier(.34,1.5,.5,1)", fill: "both" });
    }
  }

  // Grow a freshly inserted block from 0 to its natural height so everything
  // below it slides instead of jumping. WAAPI (no fill) leaves no inline styles
  // behind, so the element measures normally afterwards.
  function mkGrowIn(el) {
    if (!el || !el.animate) return;
    const target = el.offsetHeight;
    if (!target) return;
    el.style.overflow = "hidden";
    const a = el.animate(
      [{ height: "0px", opacity: 0 }, { height: target + "px", opacity: 1 }],
      { duration: 420, easing: "cubic-bezier(.22,1,.36,1)" }
    );
    const done = () => { el.style.overflow = ""; };
    a.onfinish = done;
    window.setTimeout(done, 460);
  }

  async function mkOut(dir) {
    const w = mkDetail && mkDetail.firstElementChild;
    if (!w || !w.animate) return;
    const shift = dir < 0 ? -14 : 14;
    const out = w.animate([
      { opacity: 1, transform: "none", filter: "blur(0px)" },
      { opacity: 0, transform: "translateY(" + shift + "px)", filter: "blur(6px)" },
    ], { duration: 180, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" });
    await new Promise((resolve) => {
      let done = false;
      // Do NOT cancel here: cancelling drops fill:forwards and the old view
      // snaps back to full opacity for a frame before the render swaps it,
      // which reads as a flash. The node is replaced by replaceChildren().
      const finish = () => { if (done) return; done = true; resolve(); };
      out.onfinish = finish;
      setTimeout(finish, 280);
    });
  }

  async function mkSelect(id) {
    if (String(id) === String(mkSel)) return;
    const list = mkFilteredList();
    const from = mkSel === "home" ? -1 : list.findIndex((e) => e.id === mkSel);
    const to = id === "home" ? -1 : list.findIndex((e) => e.id === id);
    const dir = to > from ? 1 : -1;
    mkSel = id;
    if (mkRows) {
      mkRows.querySelectorAll(".ym-mk-card").forEach((c) => c.classList.toggle("sel", c.dataset.id === String(id)));
    }
    mkPositionInd(false);
    await mkOut(dir);
    const reg = await getReg();
    await mkRenderDetail(reg);
  }

  async function setMkFilter(c) {
    if (c === mkFilter) return;
    const order = ["All", "Themes", "Extensions", "Snippets"];
    const dir = order.indexOf(c) > order.indexOf(mkFilter) ? -1 : 1;
    mkFilter = c;
    if (overlay) {
      overlay.querySelectorAll(".ym-mk-segbtn").forEach((b) => b.classList.toggle("on", b.dataset.c === c));
    }
    mkPositionSegPill(false);
    const reg = await getReg();
    const list = mkFilteredList();
    // Land on the first add-on of the chosen filter. Keeping Home selected meant
    // its entrance animation replayed on every tab switch, which read as spam.
    mkSel = list.length ? list[0].id : "home";
    await Promise.all([mkListOut(dir), mkOut(dir)]);
    mkBuildRows(list, reg);
    mkListIn(dir);
    await mkRenderDetail(reg);
  }

  function mkSources(src) {
    const box = h("div", { class: "ym-mk-sources" });
    box.appendChild(h("div", { class: "ym-mk-srclab", text: "Data sources" }));
    for (const [label, links] of src) {
      const row = h("div", { class: "ym-mk-srcrow" });
      row.appendChild(h("b", { text: label }));
      const wrap = h("span", { class: "ym-mk-srclinks" });
      links.forEach(([name, url], i) => {
        if (i) wrap.appendChild(h("i", { text: "·" }));
        wrap.appendChild(h("a", {
          class: "ym-mk-lnk " + (MK_LNK[name] || ""),
          href: url,
          target: "_blank",
          rel: "noopener noreferrer",
          text: name,
        }));
      });
      row.appendChild(wrap);
      box.appendChild(row);
    }
    return box;
  }

  // Change the label AND morph the width in the same beat, so the button never
  // jumps between "Uninstall" and "Uninstalling…".
  function mkBtnLabel(btn, text) {
    const label = btn.querySelector("span");
    if (!label) return;
    const first = btn.getBoundingClientRect().width;
    label.textContent = text;
    const last = btn.getBoundingClientRect().width;
    if (Math.abs(last - first) < 1 || !btn.animate) return;
    btn.style.overflow = "hidden";
    const a = btn.animate([{ width: first + "px" }, { width: last + "px" }],
      { duration: 300, easing: "cubic-bezier(.34,1.16,.5,1)" });
    a.onfinish = () => { btn.style.overflow = ""; };
  }

  function mkActions(ext, installed) {
    const acts = h("div", { class: "ym-mk-acts" });
    if (installed) {
      const b = h("button", { class: "ym-mk-btn-un", type: "button" });
      b.appendChild(mkTrashIcon());
      b.appendChild(h("span", { text: "Uninstall" }));
      b.addEventListener("click", async () => {
        if (b.dataset.busy) return;
        b.dataset.busy = "1";
        b.classList.add("busy");
        mkBtnLabel(b, "Uninstalling…");
        const lid = b.querySelector(".ym-mk-lid");
        if (lid && lid.animate) {
          lid.animate([
            { transform: "translateY(-2px) rotate(-14deg)" },
            { transform: "translateY(-9px) rotate(-44deg)" },
          ], { duration: 480, easing: "cubic-bezier(.34,1.4,.5,1)", fill: "forwards" });
        }
        // Fake work: the mockup's 850ms beat makes the removal feel real and
        // gives the lid swing time to finish before the row re-renders.
        await new Promise((resolve) => setTimeout(resolve, 850));
        // Collapse the settings block with the same exit motion the detail pane
        // uses, so it does not vanish mid-beat — and animate its HEIGHT so the
        // actions row slides up instead of snapping (AJ, 2026-10-19).
        const settingsEl = document.querySelector("#ym-market .ym-mk-settings");
        if (settingsEl) {
          const h0 = settingsEl.offsetHeight;
          settingsEl.style.overflow = "hidden";
          const out = settingsEl.animate([
            { height: h0 + "px", opacity: 1, transform: "none", filter: "blur(0px)", marginBottom: "" },
            { height: "0px", opacity: 0, transform: "translateY(-12px)", filter: "blur(6px)", marginBottom: "0px" },
          ], { duration: 260, easing: "cubic-bezier(.4,0,.35,1)", fill: "forwards" });
          await new Promise((resolve) => {
            out.onfinish = resolve;
            setTimeout(resolve, 320);
          });
        }
        await uninstall(ext.id);
      });
      acts.appendChild(b);
    } else {
      const b = h("button", { class: "ym-mk-btn-in", type: "button" });
      // Greyed like the rail row: the click still answers (with the reason)
      // rather than doing nothing at all.
      if (lowModeBlocks(ext.id)) b.classList.add("ym-mk-btn-off");
      b.appendChild(svgIcon(MK_PLUS));
      b.appendChild(h("span", { text: "Install" }));
      b.addEventListener("click", async () => {
        if (b.dataset.busy) return;
        if (lowModeBlocks(ext.id)) { toast(lowModeNotice(ext.id)); return; }
        b.dataset.busy = "1";
        b.classList.add("busy");
        mkBtnLabel(b, "Installing…");
        await new Promise((resolve) => setTimeout(resolve, 700));
        await install(ext.id);
      });
      acts.appendChild(b);
    }
    for (const g of githubLinks(ext)) {
      const a = h("a", { class: "ym-mk-ghlink", href: g.url, target: "_blank", rel: "noopener noreferrer" });
      a.appendChild(svgIcon(ICON_GITHUB));
      a.appendChild(h("span", { text: g.label }));
      acts.appendChild(a);
    }
    return acts;
  }

  // Discord invite, rendered as a RAIL card above Home (AJ, 2026-10-21) — the
  // same styling as the add-on rows, so it reads as part of the rail rather than
  // as a banner inside the home content. Reuses REPORT_DISCORD_URL so the invite
  // lives in exactly one place.
  const MK_DISCORD_PATH = "M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.036A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z";
  const MK_ARROW_PATH = "M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z";


  /* Home is a LANDING screen now, not a catalog spread (AJ, 2026-10-30).
     The rail already lists every add-on, and repeating that inventory here made
     the first screen read as a store. This page answers three questions instead:
     what is playing, what changed, and what can I do from here. The full catalog
     remains one rail click away. There are no fake stats or placeholder rows: a
     missing track or a failed changelog read simply removes that block. */
  let homeReleasePromise = null;
  function homeRelease() {
    if (!homeReleasePromise) {
      homeReleasePromise = readBundledChangelog()
        .then((changelog) => findRelease(changelog, runningVersion()) || newestRelease(changelog))
        .catch(() => null);
    }
    return homeReleasePromise;
  }

  function mountHomeNews(news) {
    homeRelease().then((release) => {
      if (!news.isConnected) return;
      if (!release) { news.remove(); return; }
      news.replaceChildren();

      const head = h("div", { class: "ym-home-news-head" });
      head.appendChild(h("h2", { class: "ym-home-news-title", text: "What's new" }));
      head.appendChild(h("span", {
        class: "ym-home-news-version",
        text: "v" + (release.version || ""),
      }));
      news.appendChild(head);
      if (release.title) {
        news.appendChild(h("p", { class: "ym-home-news-lead", text: release.title }));
      }

      const groups = [
        ["New", Array.isArray(release.features) ? release.features : []],
        ["Fixed", Array.isArray(release.fixes) ? release.fixes : []],
      ];
      for (const [label, items] of groups) {
        if (!items.length) continue;
        const group = h("div", { class: "ym-home-news-group" });
        group.appendChild(h("h3", { class: "ym-home-news-label", text: label }));
        const list = h("ul", { class: "ym-home-news-list" });
        // A release can grow without bound; the home page stays a summary.
        for (const item of items.slice(0, 2)) list.appendChild(h("li", { text: item }));
        group.appendChild(list);
        news.appendChild(group);
      }
      news.hidden = false;
    });
  }

  function homeTrackHref() {
    const link =
      document.querySelector("ytmusic-miniplayer a[href*='watch?v=']") ||
      document.querySelector("ytmusic-player-bar a[href*='watch?v=']");
    const href = link && link.getAttribute("href");
    if (href) return href;
    try {
      const videoId = new URL(location.href).searchParams.get("v");
      if (videoId) return "/watch?v=" + encodeURIComponent(videoId);
    } catch (_) {}
    return "";
  }

  function openLyricsFromHome() {
    // On a watch page the Lyrics tab is already mounted, so switch it under the
    // closing panel and let the overlay fade away over the result. Elsewhere,
    // close first and then go to the current track's watch page.
    const found = watchTabs();
    const lyricsTab = found && found.tabs.find((tab) => /lyric/.test(tabLabel(tab)));
    if (lyricsTab) {
      try { lyricsTab.click(); } catch (_) {}
      closeMarketplace();
      return;
    }
    const href = homeTrackHref();
    if (!href) { toast("Start a song in YouTube Music first."); return; }
    closeMarketplace();
    window.setTimeout(() => {
      try { location.assign(href); } catch (_) {}
    }, 260);
  }

  let homeTrackPoll = 0;
  let homeTrackKey = "";
  let homePaint = null;
  function homeTrackKeyOf(track) {
    return JSON.stringify([
      track && track.title || "",
      track && track.artist || "",
      track && track.art || "",
    ]);
  }
  function startHomeTrackWatch() {
    if (homeTrackPoll) return;
    homeTrackPoll = window.setInterval(checkHomeTrack, 500);
  }
  function stopHomeTrackWatch() {
    if (homeTrackPoll) {
      window.clearInterval(homeTrackPoll);
      homeTrackPoll = 0;
    }
  }
  function checkHomeTrack() {
    if (!overlay || overlay.classList.contains("hidden") || overlay.classList.contains("ym-leaving")) return;
    if (mkSel !== "home" || !mkDetail || !mkDetail.querySelector(".ym-home-now")) return;
    const track = readPlayerBarTrack();
    // The bar is briefly empty while YouTube Music swaps tracks. Hold the last
    // good track instead of flashing the no-track state through that gap.
    if (!track.title) return;
    const key = homeTrackKeyOf(track);
    if (key === homeTrackKey) return;
    homeTrackKey = key;
    if (homePaint) homePaint(track);
  }

  // The player bar hands out 60-120px thumbs. Google's image CDN accepts a
  // larger width/height pair in the same URL, and ytimg's named posters have
  // larger variants, so the hero gets a source that survives a 2x display.
  function homeArtUrl(url) {
    if (!url) return "";
    return String(url)
      .replace(/([=/-])w\d+-h\d+/g, "$1w720-h720")
      .replace(/([=])s\d+(-c)?/g, "$1s720$2")
      .replace(/\/(hq|mq|sd|maxres)?default\.(jpg|jpeg|webp|png)(\?|$)/i, "/maxresdefault.$2$3");
  }

  function mkHome(reg) {
    const track = readPlayerBarTrack();
    const enabled = AVAILABLE.filter((e) => reg[e.id] && reg[e.id].enabled).length;
    const wrap = h("div", { class: "ym-mk-home" });

    const hero = h("section", {
      class: "ym-home-now",
      "aria-labelledby": "ym-home-track",
    });
    const art = h("div", { class: "ym-home-art", "aria-hidden": "true" });
    const titleEl = h("h1", { class: "ym-home-track", id: "ym-home-track" });
    const artistEl = h("p", { class: "ym-home-artist" });
    let openButton = null;

    function paintArt(url) {
      art.replaceChildren();
      art.style.backgroundImage = "";
      art.classList.toggle("is-fallback", !url);
      if (!url) {
        const logo = mkLogoUrl();
        if (logo) art.style.backgroundImage = 'url("' + logo + '")';
        return;
      }
      const img = h("img", {
        class: "ym-home-art-img",
        alt: "",
        decoding: "async",
        loading: "eager",
      });
      let fellBack = false;
      img.addEventListener("error", () => {
        // A wider CDN URL can 404; the bar's own source is the safety net.
        if (!fellBack && homeArtUrl(url) !== url) {
          fellBack = true;
          img.src = url;
          return;
        }
        img.remove();
        art.classList.add("is-fallback");
        const logo = mkLogoUrl();
        if (logo) art.style.backgroundImage = 'url("' + logo + '")';
      });
      img.src = homeArtUrl(url);
      art.appendChild(img);
    }

    function paint(next) {
      homeTrackKey = homeTrackKeyOf(next);
      paintArt(next.art);
      titleEl.textContent = next.title || "Nothing playing";
      artistEl.textContent = next.title
        ? (next.artist || "Playing in YouTube Music")
        : "Start a song in YouTube Music to see it here.";
      if (openButton) {
        openButton.disabled = !next.title;
        openButton.title = next.title ? "" : "Start a song in YouTube Music first";
        openButton.onclick = next.title ? openLyricsFromHome : null;
      }
    }

    hero.appendChild(art);

    const copy = h("div", { class: "ym-home-copy" });
    copy.appendChild(h("div", { class: "ym-home-kicker", text: "Now playing" }));
    copy.appendChild(titleEl);
    copy.appendChild(artistEl);

    const actions = h("div", { class: "ym-home-actions" });
    const lyricsInstalled = !!reg["ytmod-spicy-lyrics"];
    const lyricsOn = !!(lyricsInstalled && reg["ytmod-spicy-lyrics"].enabled);
    const lyricsExt = findAvail("ytmod-spicy-lyrics");
    if (lyricsOn) {
      openButton = h("button", { class: "ym-home-btn primary", type: "button", text: "Open lyrics" });
      actions.appendChild(openButton);
    } else if (lyricsInstalled) {
      const enable = h("button", { class: "ym-home-btn primary", type: "button", text: "Turn on lyrics" });
      enable.addEventListener("click", async () => {
        await setEnabled("ytmod-spicy-lyrics", true);
        renderSection(true);
      });
      actions.appendChild(enable);
    } else if (lyricsExt) {
      const setup = h("button", { class: "ym-home-btn primary", type: "button", text: "Set up lyrics" });
      setup.addEventListener("click", () => mkSelect(lyricsExt.id));
      actions.appendChild(setup);
    }
    const settings = h("button", { class: "ym-home-btn quiet", type: "button", text: "Settings" });
    settings.addEventListener("click", () => {
      if (mkSel !== "settings") mkSelect("settings");
    });
    actions.appendChild(settings);
    copy.appendChild(actions);
    hero.appendChild(copy);
    wrap.appendChild(hero);

    const news = h("section", {
      class: "ym-home-news",
      hidden: "",
      "aria-label": "What's new",
    });
    wrap.appendChild(news);
    mountHomeNews(news);

    // A quiet summary, not a dashboard of stat cards. The counts are derived
    // from the registry, so they stay honest after an install or a mode change.
    const foot = h("footer", { class: "ym-home-foot" });
    const active = h("span", { class: "ym-home-foot-item" });
    active.appendChild(h("b", { text: String(enabled) }));
    active.appendChild(document.createTextNode(enabled === 1 ? " add-on on" : " add-ons on"));
    foot.appendChild(active);
    foot.appendChild(h("span", { class: "ym-home-foot-sep", "aria-hidden": "true", text: "\u00b7" }));
    foot.appendChild(h("span", {
      class: "ym-home-foot-item",
      text: "Performance: " + performanceLabel(performanceMode),
    }));
    foot.appendChild(h("span", { class: "ym-home-foot-sep", "aria-hidden": "true", text: "\u00b7" }));
    foot.appendChild(h("span", {
      class: "ym-home-foot-item",
      text: "Aurora Lyrics v" + (runningVersion() || "?"),
    }));
    wrap.appendChild(foot);

    paint(track);
    homePaint = paint;
    return wrap;
  }

  function mkQuietPolish(prevBtnW, prevPillBg) {
    if (!mkDetail) return;
    // Button width: FLIP from the previous width so Install <-> Uninstall grows
    // and shrinks instead of snapping.
    const btn = mkDetail.querySelector(".ym-mk-btn-un, .ym-mk-btn-in");
    if (prevBtnW && btn && btn.animate) {
      const w = btn.getBoundingClientRect().width;
      if (Math.abs(w - prevBtnW) > 1) {
        btn.style.overflow = "hidden";
        const a = btn.animate([{ width: prevBtnW + "px" }, { width: w + "px" }],
          { duration: 420, easing: "cubic-bezier(.34,1.16,.5,1)" });
        a.onfinish = () => { btn.style.overflow = ""; };
      }
    }
    // Status pill: cross-fade the old colour into the new one.
    if (prevPillBg) {
      const pill = mkDetail.querySelector(".ym-mk-pill");
      if (pill && pill.animate) {
        pill.animate([
          { backgroundColor: prevPillBg, opacity: .45, transform: "scale(.94)" },
          { backgroundColor: getComputedStyle(pill).backgroundColor, opacity: 1, transform: "none" },
        ], { duration: 340, easing: "cubic-bezier(.34,1.3,.5,1)" });
      }
    }
  }

  /* ===== Aurora Lyrics: grouped sub-rail (AJ, 2026-10-21) =================
     This add-on has 19 settings and read as one endless column. They are split
     into groups and the pane gains a second, smaller rail.
     ⭐ The rows are the SAME NODES the generic builder already made — they are
     MOVED, never rebuilt — so every control keeps its listener, its childOf
     collapse and its disabledWhen wiring. Nothing in the settings engine
     changes; this is purely a re-parenting plus a tab strip. */
  // Which group was last open. The detail pane is REBUILT on every quiet
  // re-render (install / uninstall / settings save), so without this the rail
  // snapped back to "Look" every time something else changed (AJ, 2026-10-21).
  let lrActiveGroup = "";

  const LYRICS_GROUPS = [
    // Look collects everything you SEE: how big the words are and what they sit
    // on, plus the Apple-Music motion mode.
    // The Motion tab keeps only the intensities, which are dev-only — so for a
    // normal install that tab is empty and drops itself (see `live` below).
    { id: "look", label: "Look", keys: ["size", "legibilityBackdrop", "fullscreenInPage", "bgOpacity", "adaptiveSpacing"] },
    // Which renderer draws which kind of track (AJ, 2026-10-23). Its own tab so
    // the choice reads as a choice instead of hiding under the look settings.
    { id: "renderer", label: "Renderer", keys: ["amllWordTracks", "spicyLineTracks"] },
    // Translation is a property of the WORDS, not of the look (AJ, 2026-10-22).
    { id: "words", label: "Words", keys: ["autoTranslate", "joinSyllables", "joinBgSyllables"] },
    { id: "motion", label: "Motion", keys: ["animation", "syllableAnimation", "verticalAnimation"] },
    { id: "scrolling", label: "Scrolling", keys: ["smoothScrolling", "scrollLeadEnabled", "scrollLeadMs"] },
    { id: "font", label: "Font", keys: [] },
  ];

  // Same spring the detail pane opens with, applied to the newly shown group.
  function staggerInPanel(panel) {
    if (!panel || !panel.animate) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    Array.from(panel.children).forEach((el, i) => {
      if (!el.animate) return;
      el.animate(
        [{ opacity: 0, transform: "translateY(18px)" }, { opacity: 1, transform: "none" }],
        { duration: 540, delay: 40 + i * 54, easing: "cubic-bezier(.34,1.4,.5,1)", fill: "both" }
      );
    });
  }

  function groupLyricsSettings(section) {
    const rail = h("div", { class: "ym-lr-rail", role: "tablist", "aria-label": "Setting groups" });
    const panels = h("div", { class: "ym-lr-panels" });
    const wrap = h("div", { class: "ym-lr" }, rail, panels);
    const panelById = new Map();
    LYRICS_GROUPS.forEach((g) => {
      const panel = h("div", { class: "ym-lr-panel", role: "tabpanel", "data-panel": g.id });
      panelById.set(g.id, panel);
      panels.appendChild(panel);
    });

    const firstRow = section.querySelector(".ym-detail-setting-row");
    if (firstRow) section.insertBefore(wrap, firstRow);

    // Headers named the old sections; the rail names them now.
    Array.from(section.querySelectorAll(".ym-detail-setting-section")).forEach((n) => n.remove());

    // Anything not listed falls into the FIRST group, so a setting added later
    // can never silently vanish from the panel.
    const fallback = panelById.get(LYRICS_GROUPS[0].id);
    Array.from(section.querySelectorAll(".ym-detail-setting-row")).forEach((row) => {
      const key = row.getAttribute("data-key");
      const g = LYRICS_GROUPS.find((grp) => grp.keys.indexOf(key) >= 0);
      (g ? panelById.get(g.id) : fallback).appendChild(row);
    });

    // The custom-font disclosure is its own group.
    const fontPanel = panelById.get("font");
    const moreBtn = section.querySelector(".ym-cfont-more");
    const collapse = section.querySelector(".ym-cfont-collapse");
    if (moreBtn) fontPanel.appendChild(moreBtn);
    if (collapse) fontPanel.appendChild(collapse);

    // A group with no rows would be a dead tab — drop it.
    const live = LYRICS_GROUPS.filter((g) => panelById.get(g.id).childElementCount > 0);
    const motionOK = () => !(window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    let activeId = (lrActiveGroup && live.some((g) => g.id === lrActiveGroup))
      ? lrActiveGroup
      : (live[0] ? live[0].id : "");
    lrActiveGroup = activeId;
    let switching = false;

    // The container's height is explicit because every panel is absolutely
    // positioned (that is what lets a taller panel overflow instead of being
    // clipped). Re-sync whenever the ACTIVE panel changes size — a child row
    // collapsing is the common case.
    function syncPanelHeight() {
      const p = panelById.get(activeId);
      if (!p) return;
      const h = p.offsetHeight;
      if (h) panels.style.height = h + "px";
    }
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => { if (!switching) syncPanelHeight(); });
      LYRICS_GROUPS.forEach((g) => ro.observe(panelById.get(g.id)));
    }

    /* Group switch, in THREE beats rather than a swap (AJ, 2026-10-21):
         1. the outgoing panel rises and fades out (.15s)
         2. the incoming one is shown and its rows spring up, staggered
         3. the container's HEIGHT is tweened between the two, so the pane
            below does not jump — that jump was the "it snaps" complaint.
       The tab highlight moves immediately, so the click feels instant even
       though the content takes ~300ms to settle. */
    function showPanel(id, btn) {
      if (switching || id === activeId) return;
      const from = panelById.get(activeId);
      const to = panelById.get(id);
      if (!to) return;
      switching = true;
      tabs.forEach((t) => {
        const on = t === btn;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      const finish = () => {
        if (from) from.classList.remove("active");
        to.classList.add("active");
        activeId = id;
        // The panels are ABSOLUTE, so this explicit height is what the container
        // is; the CSS transition on .ym-lr-panels animates it. Deliberately NOT
        // a tween with overflow:hidden — that clipped the bottom of a taller
        // incoming panel for the length of the animation, which is the
        // "text is cut off then goes normal" AJ saw (2026-10-21).
        lrActiveGroup = id;
        syncPanelHeight();
        staggerInPanel(to);
        switching = false;
      };
      if (from && from.animate && motionOK()) {
        const a = from.animate(
          [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-10px)" }],
          { duration: 150, easing: "cubic-bezier(.4,0,.7,1)", fill: "forwards" }
        );
        let done = false;
        const go = () => { if (done) return; done = true; a.cancel(); finish(); };
        a.onfinish = go;
        window.setTimeout(go, 220); // belt: onfinish can be missed if the tab is hidden
      } else {
        finish();
      }
    }

    const tabs = live.map((g) => {
      const btn = h("button", {
        class: "ym-lr-tab" + (g.id === activeId ? " active" : ""),
        type: "button",
        role: "tab",
        "aria-selected": g.id === activeId ? "true" : "false",
        text: g.label,
      });
      btn.addEventListener("click", () => showPanel(g.id, btn));
      // role="tablist" promises arrow-key navigation; without it the rail is
      // only reachable by tabbing through every entry (AJ, 2026-10-21).
      btn.addEventListener("keydown", (ev) => {
        const i = live.findIndex((grp) => grp.id === g.id);
        let next = -1;
        if (ev.key === "ArrowDown" || ev.key === "ArrowRight") next = (i + 1) % live.length;
        else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") next = (i - 1 + live.length) % live.length;
        else return;
        ev.preventDefault();
        const target = tabs[next];
        if (!target) return;
        target.focus();
        showPanel(live[next].id, target);
      });
      rail.appendChild(btn);
      return btn;
    });
    if (activeId) panelById.get(activeId).classList.add("active");
    // rAF so the panel has been laid out before its height is read.
    requestAnimationFrame(syncPanelHeight);
    return section;
  }

  /* ===== player bar icons (AJ, 2026-10-23) =================================
     YouTube Music draws its player bar from Material glyphs. These are ours, in
     the same thick rounded language as the fullscreen transport: solid heads and
     triangles where Apple Music uses them, a 2.2 round-capped stroke for the
     line work, all on the 24x24 grid YTM's own <svg> already uses. Only the
     svg's CHILDREN are replaced, so the button, its size, its colour, its
     hover/press states and its aria-label stay exactly YTM's — the icon is the
     only thing that changes.

     YTM re-renders an icon whenever its state changes (play <-> pause, repeat
     off/all/one, a pressed thumb), which drops our parts. One MutationObserver
     on the bar repaints whatever fell back, and the state key stored on the svg
     makes a settled pass free: a matching key with our parts still in place
     writes nothing, so the observer cannot loop.

     State is read from the DOM YTM already owns — aria-pressed on the thumbs,
     the volume slider's aria-valuenow, the media element's paused flag. The one
     exception is repeat-one, which YTM publishes only in the button's localized
     title; in a non-English UI the numeral falls back to the plain loop. */
  const YT_ICON_STROKE = 2.4;
  function ytIconStroke(d, extra) {
    return {
      tag: "path",
      attrs: Object.assign({
        d,
        fill: "none",
        stroke: "currentColor",
        "stroke-width": String(YT_ICON_STROKE),
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }, extra || {}),
    };
  }
  function ytIconSolid(d, extra) {
    return {
      tag: "path",
      attrs: Object.assign({
        d,
        fill: "currentColor",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linejoin": "round",
      }, extra || {}),
    };
  }
  function ytIconHead(d) {
    return { tag: "path", attrs: { d, fill: "currentColor", stroke: "none" } };
  }
  // Two solid triangles, a hair apart at the tips. This is the Apple Music
  // skip shape, and the 2-unit stroke rounds the corners without closing the
  // gap. The triangles grow OUTWARD from the tips (the bases moved, the tips
  // barely did), so a bigger skip reads heavier without pushing its edge into
  // the play button's air (AJ, 2026-10-23).
  // Previous points LEFT and next points RIGHT. They shipped swapped, so each
  // button's arrows pointed the opposite way to its own name (AJ, 2026-10-23).
  const YT_ICON_PREV = [
    ytIconSolid("M12.2 12 22 4.2v15.6L12.2 12Z"),
    ytIconSolid("M2 12 11.8 4.2v15.6L2 12Z"),
  ];
  const YT_ICON_NEXT = [
    ytIconSolid("M11.8 12 2 4.2v15.6L11.8 12Z"),
    ytIconSolid("M22 12 12.2 4.2v15.6L22 12Z"),
  ];
  // The play button's svg is 40px, not 24: the same 24-grid geometry draws at
  // 1.67x, so this triangle is sized for that box, not for the 24px row. It is
  // deliberately a touch smaller than YTM's (5..22) now that the skips carry
  // the weight (AJ, 2026-10-23).
  const YT_ICON_PLAY = [ytIconSolid("M4.8 4.8 19.2 12 4.8 19.2Z", { "stroke-width": "2.4" })];
  // Round caps extend each bar by half its stroke, so the 6..18 line paints
  // 3.6..20.4 tall: the same 16.8 the play triangle occupies. The bars are 4.8
  // wide and 2.4 apart, so the pair grew outward without closing the gap
  // (AJ, 2026-10-23).
  const YT_ICON_PAUSE = [
    ytIconStroke("M8.3 6v12", { "stroke-width": "4.8" }),
    ytIconStroke("M15.7 6v12", { "stroke-width": "4.8" }),
  ];
  // The fullscreen transport's shuffle and repeat, at the bar's 24px.
  const YT_ICON_SHUFFLE = [
    ytIconStroke("M3 7h3.6l9.4 10h0.8"),
    ytIconStroke("M3 17h3.6l9.4-10h0.8"),
    ytIconHead("M16.9 13.8 21.6 17 16.9 20.2Z"),
    ytIconHead("M16.9 3.8 21.6 7 16.9 10.2Z"),
  ];
  const YT_ICON_REPEAT = [
    ytIconStroke("M4 11.5V9.5A4.5 4.5 0 0 1 8.5 5h7.3"),
    ytIconHead("M15.2 1.9 19.6 5 15.2 8.1Z"),
    ytIconStroke("M20 12.5v2a4.5 4.5 0 0 1-4.5 4.5H8.2"),
    ytIconHead("M8.8 15.9 4.4 19 8.8 22.1Z"),
  ];
  const YT_ICON_REPEAT_ONE = YT_ICON_REPEAT.concat([ytIconStroke("M10.6 10.6 12.5 9.3V15")]);
  // Speaker with the waves the volume level deserves. The body is solid, like
  // the system glyph; only the waves are strokes so they stay one weight.
  const YT_VOLUME_BODY = {
    tag: "path",
    attrs: {
      d: "M4 9.5h3.2L12 5.8v12.4l-4.8-3.7H4Z",
      fill: "currentColor",
      stroke: "currentColor",
      "stroke-width": "1.3",
      "stroke-linejoin": "round",
    },
  };
  const YT_ICON_VOLUME_HIGH = [
    YT_VOLUME_BODY,
    ytIconStroke("M15.2 9.4a4.4 4.4 0 0 1 0 5.2", { "stroke-width": "2" }),
    ytIconStroke("M18 6.6a8 8 0 0 1 0 10.8", { "stroke-width": "2" }),
  ];
  const YT_ICON_VOLUME_LOW = [
    YT_VOLUME_BODY,
    ytIconStroke("M15.4 9.3a4.6 4.6 0 0 1 0 5.4", { "stroke-width": "2" }),
  ];
  const YT_ICON_VOLUME_MUTE = [
    YT_VOLUME_BODY,
    ytIconStroke("M15.4 9.7l5 4.6", { "stroke-width": "2.1" }),
    ytIconStroke("M20.4 9.7l-5 4.6", { "stroke-width": "2.1" }),
  ];
  // One closed thumb: the cuff is part of the outline, so the pressed state can
  // simply fill the same path instead of needing a second shape. Dislike is the
  // same path turned over, which keeps the pair exactly symmetrical.
  const YT_LIKE_PATH = "M5.8 20A1.8 1.8 0 0 1 4 18.2v-5.4A1.8 1.8 0 0 1 5.8 11h2.9l2.8-4.7a1.95 1.95 0 0 1 3.6 1.2l-.55 3.7h4.1a2 2 0 0 1 1.97 2.4l-1.02 4.3A2.55 2.55 0 0 1 16.97 20H5.8Z";
  const YT_LIKE_FLIP = "translate(0 24) scale(1 -1)";
  function ytIconThumb(on, flip) {
    const attrs = {
      d: YT_LIKE_PATH,
      fill: on ? "currentColor" : "none",
      stroke: "currentColor",
      "stroke-width": on ? "1.2" : "2.1",
      "stroke-linejoin": "round",
    };
    if (flip) attrs.transform = YT_LIKE_FLIP;
    return { tag: "path", attrs };
  }
  const YT_ICON_MORE = [5, 12, 19].map((cx) => ({
    tag: "circle",
    attrs: { cx: String(cx), cy: "12", r: "1.7", fill: "currentColor" },
  }));
  const YT_ICON_PARTS = {
    prev: YT_ICON_PREV,
    next: YT_ICON_NEXT,
    play: YT_ICON_PLAY,
    pause: YT_ICON_PAUSE,
    shuffle: YT_ICON_SHUFFLE,
    repeat: YT_ICON_REPEAT,
    repeatOne: YT_ICON_REPEAT_ONE,
    "volume-high": YT_ICON_VOLUME_HIGH,
    "volume-low": YT_ICON_VOLUME_LOW,
    "volume-mute": YT_ICON_VOLUME_MUTE,
    like: [ytIconThumb(false, false)],
    likeOn: [ytIconThumb(true, false)],
    dislike: [ytIconThumb(false, true)],
    dislikeOn: [ytIconThumb(true, true)],
    more: YT_ICON_MORE,
  };

  function ytPlayerBar() {
    // 2026 rollout: the bar is now <ytmusic-miniplayer>, slotted into the app
    // layout where <ytmusic-player-bar> used to be. Both are supported; the
    // new host wins whenever it is mounted.
    return document.querySelector("ytmusic-miniplayer") ||
      document.querySelector("ytmusic-player-bar");
  }
  function ytIsMiniBar(bar) {
    return !!bar && bar.tagName.toLowerCase() === "ytmusic-miniplayer";
  }
  // The media element is the truth for play vs pause; the button's label is the
  // fallback for the rare frame before a track has loaded.
  function ytPlayerPaused() {
    const video = document.querySelector("ytmusic-player video, #movie_player video, video");
    if (video) return video.paused === true;
    const bar = ytPlayerBar();
    const btn = bar && (bar.querySelector("yt-icon-button.play-pause-button") ||
      bar.querySelector("button[aria-label='Pause'], button[aria-label='Play'], button[aria-label='pause'], button[aria-label='play']"));
    const inner = btn && btn.querySelector("button");
    const label = (btn && (btn.getAttribute("title") || btn.getAttribute("aria-label"))) ||
      (inner && inner.getAttribute("aria-label")) || "";
    return !/pause/i.test(label);
  }
  function ytRepeatIsOne(btn) {
    const inner = btn.querySelector("button");
    const label = btn.getAttribute("title") || (inner && inner.getAttribute("aria-label")) || "";
    return /\bone\b|\b1\b/i.test(label);
  }
  function ytVolumeLevel() {
    // Muting does not always zero the slider: YTM remembers the volume it will
    // restore, so the media element is the authority on silence.
    const video = document.querySelector("ytmusic-player video, #movie_player video, video");
    if (video && video.muted === true) return "mute";
    const bar = ytPlayerBar();
    const slider = bar && (bar.querySelector("#volume-slider") ||
      bar.querySelector("input[aria-label='Volume']"));
    const raw = slider ? (slider.getAttribute("aria-valuenow") || slider.value) : 100;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return "mute";
    return value < 45 ? "low" : "high";
  }

  const YT_ICON_JOBS = [
    ["yt-icon-button.previous-button", () => "prev"],
    ["yt-icon-button.next-button", () => "next"],
    ["yt-icon-button.play-pause-button", () => (ytPlayerPaused() ? "play" : "pause")],
    ["yt-icon-button.shuffle", () => "shuffle"],
    ["yt-icon-button.expand-shuffle", () => "shuffle"],
    ["yt-icon-button.repeat", (btn) => (ytRepeatIsOne(btn) ? "repeatOne" : "repeat")],
    ["yt-icon-button.volume", () => "volume-" + ytVolumeLevel()],
    ["yt-icon-button.expand-volume", () => "volume-" + ytVolumeLevel()],
  ];

  function ytPaintIcon(svg, key) {
    const parts = YT_ICON_PARTS[key];
    if (!svg || !parts) return;
    // Ours, and the right state: nothing to do. This is what stops the
    // observer from repainting its own work on every pass.
    if (svg.getAttribute("data-ym-icon") === key && svg.querySelector("[data-ym-part]")) return;
    // YTM's own paths stay in the svg, hidden by CSS while we own it: they are
    // what the switch hands back, and hidden they still receive YouTube's
    // play/pause updates, so turning the custom set off shows the CURRENT
    // glyph rather than the one from page load (AJ, 2026-10-23).
    for (const node of Array.from(svg.children)) {
      if (node.getAttribute("data-ym-part")) svg.removeChild(node);
    }
    for (const part of parts) {
      const el = document.createElementNS("http://www.w3.org/2000/svg", part.tag);
      const attrs = part.attrs || {};
      for (const name in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, name)) el.setAttribute(name, attrs[name]);
      }
      el.setAttribute("data-ym-part", "1");
      svg.appendChild(el);
    }
    svg.setAttribute("data-ym-icon", key);
  }

  // The mini-player bar has no `yt-icon-button` wrappers: each control is a Wiz
  // <button> whose only stable identity is its aria-label. Same glyph set, same
  // painter — only the lookup differs. Unmapped controls (Playback Speed,
  // Rewind 10, Fast forward 30) keep YouTube's own icons.
  const YT_MINI_ICON_JOBS = [
    [/^shuffle$/i, () => "shuffle"],
    [/^repeat/i, (btn) => (ytRepeatIsOne(btn) ? "repeatOne" : "repeat")],
    [/^(play|pause)$/i, () => (ytPlayerPaused() ? "play" : "pause")],
    [/^previous$/i, () => "prev"],
    [/^next$/i, () => "next"],
    [/^(mute|unmute)$/i, () => "volume-" + ytVolumeLevel()],
    [/^more$/i, () => "more"],
  ];

  function ytPaintMiniPlayerIcons(bar) {
    const buttons = bar.querySelectorAll("button[aria-label]");
    for (const button of buttons) {
      const label = (button.getAttribute("aria-label") || "").trim();
      const job = YT_MINI_ICON_JOBS.find(([re]) => re.test(label));
      if (job) {
        ytPaintIcon(button.querySelector("svg"), job[1](button));
        continue;
      }
      // Like/dislike stay YouTube's here. The new bar draws the like button with
      // an ANIMATED Lottie icon on a 48-unit viewBox, not the 24-unit svg every
      // other control uses — painting our glyph into it rendered half-size in
      // the corner and hid the animation. Unpaint anything a previous pass left
      // there so the stock icon comes back.
      if (button.hasAttribute("aria-pressed")) ytUnpaintIcon(button.querySelector("svg"));
    }
  }

  function ytUnpaintIcon(svg) {
    if (!svg || !svg.getAttribute("data-ym-icon")) return;
    for (const node of Array.from(svg.children)) {
      if (node.getAttribute("data-ym-part")) svg.removeChild(node);
    }
    svg.removeAttribute("data-ym-icon");
  }

  function ytPaintPlayerIcons() {
    const bar = ytPlayerBar();
    if (!bar) return;
    if (ytIsMiniBar(bar)) {
      ytPaintMiniPlayerIcons(bar);
      return;
    }
    for (const job of YT_ICON_JOBS) {
      const buttons = bar.querySelectorAll(job[0]);
      for (const button of buttons) {
        ytPaintIcon(button.querySelector("svg"), job[1](button));
      }
    }
    const middle = bar.querySelector(".middle-controls-buttons");
    if (!middle) return;
    const thumbs = middle.querySelectorAll("ytmusic-like-button-renderer button[aria-pressed]");
    if (thumbs[0]) {
      ytPaintIcon(thumbs[0].querySelector("svg"),
        thumbs[0].getAttribute("aria-pressed") === "true" ? "likeOn" : "like");
    }
    if (thumbs[1]) {
      ytPaintIcon(thumbs[1].querySelector("svg"),
        thumbs[1].getAttribute("aria-pressed") === "true" ? "dislikeOn" : "dislike");
    }
    const menu = middle.querySelector("ytmusic-menu-renderer button");
    if (menu) ytPaintIcon(menu.querySelector("svg"), "more");
  }

  let ytIconObserver = null;
  let ytIconTimer = 0;

  function ytSchedulePlayerIcons() {
    if (ytIconTimer) return;
    ytIconTimer = window.setTimeout(() => {
      ytIconTimer = 0;
      ytPaintPlayerIcons();
    }, 60);
  }

  function ytAttachIconObserver() {
    if (ytIconObserver) return true;
    const bar = ytPlayerBar();
    if (!bar) return false;
    ytIconObserver = new MutationObserver(ytSchedulePlayerIcons);
    // Scoped to the bar, not <body>: the lyrics repaint every frame, and an
    // observer there would wake this module on every word.
    ytIconObserver.observe(bar, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-pressed", "aria-valuenow", "title", "d"],
    });
    ytPaintPlayerIcons();
    return true;
  }

  let ytIconPoll = 0;
  function ytStartPlayerIcons() {
    if (ytAttachIconObserver()) return;
    // A cold load builds the bar after the content script runs. Poll until it
    // lands, then stop: the bar itself lives for the whole session. One poller
    // only — applyYtPrefs() calls this on every settings change (AJ, 2026-10-23).
    if (ytIconPoll) return;
    let tries = 0;
    ytIconPoll = window.setInterval(() => {
      if (ytAttachIconObserver() || ++tries > 40) {
        window.clearInterval(ytIconPoll);
        ytIconPoll = 0;
      }
    }, 250);
  }

  // The switch's off path. Our parts out and the key cleared, the stock paths
  // the painter left in place paint again — and the observer goes with them, so
  // nothing repaints the set back on (AJ, 2026-10-23).
  function ytStopPlayerIcons() {
    if (ytIconObserver) ytIconObserver.disconnect();
    ytIconObserver = null;
    if (ytIconTimer) {
      if (window.clearTimeout) window.clearTimeout(ytIconTimer);
      ytIconTimer = 0;
    }
    if (ytIconPoll) {
      window.clearInterval(ytIconPoll);
      ytIconPoll = 0;
    }
    const bar = ytPlayerBar();
    if (!bar) return;
    for (const svg of bar.querySelectorAll("svg[data-ym-icon]")) {
      for (const node of Array.from(svg.children)) {
        if (node.getAttribute("data-ym-part")) svg.removeChild(node);
      }
      svg.removeAttribute("data-ym-icon");
    }
  }

  /* ---- player bar: a progress line that moves like time -------------------
     YouTube steps the seek slider in whole seconds, so the played line and the
     dot at its end jump a second at a time — the snap AJ hit in fullscreen on a
     word-by-word track, on 2026-10-26. While the switch is on, one animation
     frame follows the media element instead: the line is the bar's own scaleX,
     the dot is the knob slid by a transform, and neither costs a layout.

     Only the PAINT is ours. The slider's value, its ARIA readout and its hit
     area stay YouTube's, and a drag belongs to the pointer: while it is down the
     dot follows the slider's own value, which is what YouTube is drawing too. */
  let ytProgressRaf = 0;
  let ytProgressParts = null;
  let ytProgressWidth = 0;
  let ytProgressPct = -1;
  let ytProgressResize = null;

  function ytProgressLookup() {
    const slider = document.querySelector("ytmusic-player-bar #progress-bar");
    const primary = slider && slider.querySelector("#primaryProgress");
    const knob = slider && slider.querySelector("#sliderKnob");
    if (primary && knob && slider.getClientRects().length) return { slider, primary, knob };
    return ytMiniProgressLookup();
  }

  // The 2026 bar's slider. It is one plain range input: no knob and no primary
  // node to translate, and its line is an inline gradient YouTube rewrites on
  // whole seconds. Only a VISIBLE one counts — YTM can leave a hidden old
  // player bar, or a second mini bar, in the document.
  function ytMiniProgressLookup() {
    const sliders = Array.from(document.querySelectorAll("input.ytMusicMiniPlayerProgressBar"));
    const slider = sliders.find((el) => el.getClientRects().length) || sliders[0];
    if (!slider) return null;
    return {
      slider,
      mini: true,
      host: slider.closest(".ytMusicMiniPlayerProgressBarWrapper") || slider.parentElement,
    };
  }

  // The new bar's line is painted by a class rule (styles.css) from this
  // custom property: set it on the wrapper so YouTube rewriting the input's own
  // inline gradient cannot take the value with it. A drag is the pointer's
  // value; otherwise the media element is the clock.
  function ytMiniProgressStep(parts) {
    const slider = parts.slider;
    let pct;
    if (slider.matches(":active")) {
      const max = Number(slider.max);
      if (!(max > 0)) return;
      pct = Number(slider.value) / max;
    } else {
      const video = ytProgressMedia();
      if (!video) return;
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      pct = video.currentTime / duration;
    }
    pct = Math.min(1, Math.max(0, pct));
    if (pct === ytProgressPct) return;
    ytProgressPct = pct;
    if (parts.host) parts.host.style.setProperty("--ym-mini-progress", (pct * 100).toFixed(3) + "%");
  }

  function ytProgressMedia() {
    return document.querySelector("ytmusic-player video, #movie_player video, video");
  }

  // The dot is centred on the line's end (YTM gives the knob a -16px margin),
  // so sliding it by `pct * width` puts its centre exactly on the bar's edge.
  function ytProgressPaint(parts, pct) {
    parts.primary.style.transform = "scaleX(" + pct.toFixed(6) + ")";
    parts.knob.style.transform = "translateX(" + (pct * ytProgressWidth).toFixed(2) + "px)";
  }

  function ytProgressStep() {
    // The bar outlives every page in YTM, but a fullscreen transition can rebuild
    // the slider under us — re-resolve whenever the node we hold is gone.
    if (!ytProgressParts || !ytProgressParts.slider.isConnected) {
      ytProgressParts = ytProgressLookup();
      ytProgressWidth = 0;
      ytProgressPct = -1;
      if (ytProgressParts && ytProgressResize) {
        // Only the old slider is measured; a range input is not resized by the
        // line moving inside it.
        if (ytProgressParts.mini) ytProgressResize.disconnect();
        else ytProgressResize.observe(ytProgressParts.slider);
      }
    }
    const parts = ytProgressParts;
    if (!parts) return;
    // The new bar has no width to measure and no nodes to transform: its line
    // is a gradient, repainted from a custom property.
    if (parts.mini) { ytMiniProgressStep(parts); return; }
    if (!ytProgressWidth) ytProgressWidth = parts.slider.getBoundingClientRect().width;
    if (!(ytProgressWidth > 0)) return;
    if (parts.slider.dragging) {
      const max = Number(parts.slider.max);
      if (!(max > 0)) return;
      const pct = Math.min(1, Math.max(0, Number(parts.slider.value) / max));
      if (pct === ytProgressPct) return;
      ytProgressPct = pct;
      ytProgressPaint(parts, pct);
      return;
    }
    const video = ytProgressMedia();
    if (!video) return;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const pct = Math.min(1, Math.max(0, video.currentTime / duration));
    if (pct === ytProgressPct) return;
    ytProgressPct = pct;
    ytProgressPaint(parts, pct);
  }

  function ytProgressFrame() {
    ytProgressRaf = window.requestAnimationFrame(ytProgressFrame);
    ytProgressStep();
  }

  function ytStartSmoothProgress() {
    if (ytProgressRaf) return;
    if (!ytProgressResize && typeof ResizeObserver === "function") {
      // A resize — the window, a fullscreen pass, a theme that changes the bar's
      // width — invalidates the width the dot is slid by. One observer clears it
      // and the next frame re-measures, so no frame reads layout while painting.
      ytProgressResize = new ResizeObserver(() => {
        ytProgressWidth = 0;
        ytProgressPct = -1;
      });
    }
    if (ytProgressParts && ytProgressResize && !ytProgressParts.mini) ytProgressResize.observe(ytProgressParts.slider);
    // One immediate paint: the class hands the dot over on this very tick, and it
    // should not sit at the start of the bar waiting for a frame.
    ytProgressPct = -1;
    ytProgressStep();
    ytProgressRaf = window.requestAnimationFrame(ytProgressFrame);
  }

  function ytStopSmoothProgress() {
    if (ytProgressRaf) window.cancelAnimationFrame(ytProgressRaf);
    ytProgressRaf = 0;
    if (ytProgressResize) {
      ytProgressResize.disconnect();
      ytProgressResize = null;
    }
    const parts = ytProgressParts;
    ytProgressParts = null;
    ytProgressWidth = 0;
    ytProgressPct = -1;
    // The new bar is painted by a class rule, and the class is already off: drop
    // the frame value so a re-enable starts from a clean slate.
    if (parts && parts.mini) {
      if (parts.host) parts.host.style.removeProperty("--ym-mini-progress");
      return;
    }
    if (!parts || !parts.slider.isConnected) return;
    // Hand both pieces back where the playhead actually is: the line's transform
    // is ours now, and leaving it would freeze it a fraction of a second ahead of
    // YouTube's next whole-second value.
    parts.knob.style.transform = "";
    const video = ytProgressMedia();
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      const pct = Math.min(1, Math.max(0, video.currentTime / video.duration));
      parts.primary.style.transform = "scaleX(" + pct.toFixed(6) + ")";
    }
  }

  /* ===== YouTube page (AJ, 2026-10-22) =====================================
     Settings for YouTube Music ITSELF — not for the lyrics, and deliberately NOT
     part of an add-on. They get their own rail page and their own storage key so
     they keep working with every add-on uninstalled, Aurora Lyrics included.

     Both are applied to <html>: YTM rebuilds the inside of ytmusic-app
     constantly, but the root survives, so neither can be dropped by a re-render.
     applyYtPrefs() is idempotent, so boot and every change can just call it. */
  const YT_PREFS_KEY = "ytmod_youtube_prefs";
  const YT_FONT_CLASS = "ym-yt-font";
  const YT_COMPACT_CLASS = "ym-yt-compact";
  const YT_VOLUME_CLASS = "ym-yt-volume";
  // Home levers (AJ, 2026-10-22). Classes on <html> for the same reason as the
  // rest: YouTube rebuilds the browse page constantly, the root never goes away,
  // and a switch that is off costs no rules at all.
  const YT_NOCHIPS_CLASS = "ym-yt-nochips";
  const YT_TIGHT_CLASS = "ym-yt-tight-home";
  const YT_NOCAPTIONS_CLASS = "ym-yt-no-captions";
  const YT_WIDE_CLASS = "ym-yt-wide-shelves";
  const YT_SMALLTITLES_CLASS = "ym-yt-small-titles";
  const YT_LIBEMPTY_CLASS = "ym-yt-lib-noempty";
  const YT_LIBBIG_CLASS = "ym-yt-lib-big";
  const YT_LIBWIDE_CLASS = "ym-yt-lib-wide";
  // Explore (AJ, 2026-10-23). No route class exists for this page — <html> only
  // gets one for the Library — so these are scoped in CSS by the components
  // only Explore renders (:has() on the shortcut grid / the genre carousel),
  // and the switches are simply inert elsewhere.
  const YT_EXPLOREWIDE_CLASS = "ym-yt-explore-wide";
  const YT_EXPLOREMOODS_CLASS = "ym-yt-explore-moods";
  const YT_EXPLORENOSHORTCUTS_CLASS = "ym-yt-explore-noshortcuts";
  // Song view (AJ, 2026-10-23): the column beside the cover art. Both are
  // layout-only, so they are classes like the rest and cost nothing when off.
  const YT_SONGWIDE_CLASS = "ym-yt-song-wide";
  const YT_SONGTABS_CLASS = "ym-yt-song-tabs";
  // Song view layouts (AJ, 2026-10-23). One class per NON-default layout; the
  // default is the absence of a class, so it contributes no rules at all.
  const YT_SONGLAYOUT_PREFIX = "ym-yt-song-layout-";
  const SONG_LAYOUTS = [
    { id: "default", label: "Default", hint: "Cover left · lyrics right" },
    { id: "split", label: "Lyrics left", hint: "Lyrics left · cover right" },
    { id: "lyrics", label: "Lyrics only", hint: "No cover, full-width lyrics" },
    { id: "art", label: "Cover art only", hint: "The lyrics column is hidden" },
  ];
  // Anything stored before this lever existed, or a value from a build that
  // shipped a different set, lands on the default rather than on no layout.
  const songLayoutNormalized = (value) =>
    SONG_LAYOUTS.some((layout) => layout.id === value) ? value : "default";
  // Player-bar and chrome levers, carried over from the retired Aurora theme
  // (AJ, 2026-10-23). Same contract as the rest of this page: a class on <html>
  // and a switch that is off contributes no rules at all.
  const YT_DARKBAR_CLASS = "ym-yt-dark-bar";
  // The custom glyph set is a switch now (AJ, 2026-10-23). Off, the painter is
  // stopped and the player bar keeps YouTube's own icons AND its own spacing.
  const YT_CUSTOMICONS_CLASS = "ym-yt-custom-icons";
  const YT_DOCK_CLASS = "ym-yt-dock";
  const YT_GLASSCHROME_CLASS = "ym-yt-glass-chrome";
  const YT_NODIVIDERS_CLASS = "ym-yt-no-dividers";
  // The class only hands the seek knob over to the progress painter below; the
  // animation itself is the rAF loop that runs while the switch is on.
  const YT_SMOOTHPROGRESS_CLASS = "ym-yt-smooth-progress";
  const YT_SCALE_MIN = 0.85;
  const YT_SCALE_MAX = 1.2;
  // The Apple Music look is the shipped default, so every switch it owns is ON
  // and the two that are a matter of taste are off: the glass top bar and side
  // nav, and the transparent album-art chrome that goes with it. Type sits at
  // 120% (AJ, 2026-10-26) — the stock size read small next to the wider column.
  // The home/library/explore levers stay off: those pages are YouTube's own.
  const DEFAULT_YT_PREFS = {
    font: true,
    scale: 1.2,
    compact: true,
    volume: true,
    noChips: false,
    tightHome: false,
    noCaptions: false,
    wideShelves: false,
    smallTitles: false,
    libHideEmpty: false,
    libBig: false,
    libWide: false,
    exploreWide: false,
    exploreMoods: false,
    exploreNoShortcuts: false,
    // Wider column on by default too: the lyrics get a usable measure without
    // anyone finding the lever first (AJ, 2026-10-23).
    songWide: true,
    songTabs: true,
    // Which of the four player-page layouts is drawn. A string, not a switch,
    // so loadYtPrefs() normalises it by hand (see the schema pass there).
    songLayout: "default",
    // On by default: this is the look the Aurora theme shipped, and moving it
    // here should not silently hand people the stock chrome back (AJ,
    // 2026-10-23). Every one of them is a switch on the YouTube page.
    darkBar: true,
    // The custom set ships on: it is the look the Apple Music card is for
    // (AJ, 2026-10-23).
    customIcons: true,
    dock: true,
    glassChrome: false,
    noDividers: true,
    // On by default: a progress line that moves once a second reads as broken
    // next to everything else on this page (AJ, 2026-10-26).
    smoothProgress: true,
  };
  let ytPrefs = Object.assign({}, DEFAULT_YT_PREFS);
  // Profiles saved before 2026-10-26 hold these values. Kept ONLY to recognise
  // one that never touched a switch: it gets the new defaults, while anything
  // customised is left alone (see loadYtPrefs). Never applied as a value.
  const LEGACY_YT_PREFS = {
    font: false,
    scale: 1,
    compact: false,
    volume: false,
    noChips: false,
    tightHome: false,
    noCaptions: false,
    wideShelves: false,
    smallTitles: false,
    libHideEmpty: false,
    libBig: false,
    libWide: false,
    exploreWide: false,
    exploreMoods: false,
    exploreNoShortcuts: false,
    songWide: true,
    songTabs: false,
    songLayout: "default",
    darkBar: true,
    customIcons: true,
    dock: true,
    glassChrome: true,
    noDividers: true,
  };
  const YT_DEFAULTS_REV_KEY = "ytmod_youtube_defaults_rev";
  const YT_DEFAULTS_REV = 1;
  const matchesLegacyYtPrefs = (saved) =>
    Object.keys(LEGACY_YT_PREFS).every((key) => saved[key] === LEGACY_YT_PREFS[key]);

  const clampYtScale = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_YT_PREFS.scale;
    return Math.round(Math.min(YT_SCALE_MAX, Math.max(YT_SCALE_MIN, n)) * 100) / 100;
  };

  // YTM's own root size, captured BEFORE the first time we overwrite it. Our
  // surfaces (the add-ons panel, the lyrics panel) are pinned to it in CSS, so
  // they keep the size they inherit today and never inflate with this setting.
  // Captured rather than hard-coded at 10px: if YouTube ever changes its base,
  // the pin follows instead of drifting (AJ, 2026-10-22).
  let ytRootBase = 0;
  // Last compact state actually painted, so the resize nudge below only fires
  // on a real flip instead of on every boot and every slider tick.
  let ytCompactApplied = null;
  // Same idea for the wider lyrics column: flipping it changes the player
  // page's split, which YouTube only re-fits on a resize.
  let ytSongWideApplied = null;
  // Same, for the layout: every layout is a different split, so flipping one
  // needs the same refit the wider column does.
  let ytSongLayoutApplied = null;

  function applyYtPrefs() {
    const root = document.documentElement;
    if (!ytRootBase) {
      ytRootBase = parseFloat(getComputedStyle(root).fontSize) || 10;
      root.style.setProperty("--ym-yt-root-fs", ytRootBase + "px");
    }
    root.classList.toggle(YT_FONT_CLASS, ytPrefs.font === true);
    const compact = ytPrefs.compact === true;
    root.classList.toggle(YT_COMPACT_CLASS, compact);
    root.classList.toggle(YT_VOLUME_CLASS, ytPrefs.volume === true);
    root.classList.toggle(YT_NOCHIPS_CLASS, ytPrefs.noChips === true);
    root.classList.toggle(YT_TIGHT_CLASS, ytPrefs.tightHome === true);
    root.classList.toggle(YT_NOCAPTIONS_CLASS, ytPrefs.noCaptions === true);
    root.classList.toggle(YT_WIDE_CLASS, ytPrefs.wideShelves === true);
    root.classList.toggle(YT_SMALLTITLES_CLASS, ytPrefs.smallTitles === true);
    root.classList.toggle(YT_LIBEMPTY_CLASS, ytPrefs.libHideEmpty === true);
    root.classList.toggle(YT_LIBBIG_CLASS, ytPrefs.libBig === true);
    root.classList.toggle(YT_LIBWIDE_CLASS, ytPrefs.libWide === true);
    root.classList.toggle(YT_EXPLOREWIDE_CLASS, ytPrefs.exploreWide === true);
    root.classList.toggle(YT_EXPLOREMOODS_CLASS, ytPrefs.exploreMoods === true);
    root.classList.toggle(YT_EXPLORENOSHORTCUTS_CLASS, ytPrefs.exploreNoShortcuts === true);
    const songWide = ytPrefs.songWide === true;
    root.classList.toggle(YT_SONGWIDE_CLASS, songWide);
    root.classList.toggle(YT_SONGTABS_CLASS, ytPrefs.songTabs === true);
    const songLayout = songLayoutNormalized(ytPrefs.songLayout);
    for (const layout of SONG_LAYOUTS) {
      root.classList.toggle(
        YT_SONGLAYOUT_PREFIX + layout.id,
        layout.id === songLayout && layout.id !== "default"
      );
    }
    root.classList.toggle(YT_DARKBAR_CLASS, ytPrefs.darkBar === true);
    const customIcons = ytPrefs.customIcons === true;
    root.classList.toggle(YT_CUSTOMICONS_CLASS, customIcons);
    if (customIcons) ytStartPlayerIcons();
    else ytStopPlayerIcons();
    root.classList.toggle(YT_DOCK_CLASS, ytPrefs.dock === true);
    root.classList.toggle(YT_GLASSCHROME_CLASS, ytPrefs.glassChrome === true);
    root.classList.toggle(YT_NODIVIDERS_CLASS, ytPrefs.noDividers === true);
    const smoothProgress = ytPrefs.smoothProgress === true;
    root.classList.toggle(YT_SMOOTHPROGRESS_CLASS, smoothProgress);
    if (smoothProgress) ytStartSmoothProgress();
    else ytStopSmoothProgress();
    // The capsule needs the selected tab's box the moment the lever turns on,
    // not at the next tab switch. One frame, because the class has to paint
    // before anything can be measured.
    const measureSong = () => songTabGeometry();
    if (window.requestAnimationFrame) window.requestAnimationFrame(measureSong);
    else window.setTimeout(measureSong, 0);
    // A wider column is a different player-page split, and YouTube sizes the
    // video (and re-centres the cover) from that split only when a resize tells
    // it to. First paint counts too, not just a flip: the class can be on long
    // before the player page mounts. Two follow-ups catch the lazy tracker that
    // lands after the frame.
    if (ytSongWideApplied !== songWide || ytSongLayoutApplied !== songLayout) {
      const refit = () => window.dispatchEvent(new Event("resize"));
      if (window.requestAnimationFrame) window.requestAnimationFrame(refit);
      else window.setTimeout(refit, 0);
      window.setTimeout(refit, 180);
      window.setTimeout(refit, 420);
    }
    ytSongWideApplied = songWide;
    ytSongLayoutApplied = songLayout;
    // Turning the filter on has to mark the cards that are ALREADY on screen;
    // the watcher below only sees what renders after it is armed.
    if (ytPrefs.libHideEmpty) ytTagEmptyPlaylists();
    // YTM measures its player page once in JS and stores the height inline, so
    // a CSS-only change to the bars would leave that page sized for the old
    // chrome. A resize is the event it already listens for (AJ, 2026-10-22).
    if (ytCompactApplied !== null && ytCompactApplied !== compact) {
      const nudge = () => window.dispatchEvent(new Event("resize"));
      if (window.requestAnimationFrame) window.requestAnimationFrame(nudge);
      else window.setTimeout(nudge, 0);
    }
    ytCompactApplied = compact;
    // The Spicy Lyrics sheet also registers the @font-face, so it has to be in
    // the document even if the panel was never opened this session.
    if (ytPrefs.font) ensurePanelFont();
    // Two levers, because YouTube's type is split: the rem rules follow this
    // root (inline, or YTM's `html { font-size: 10px }` would win), while the
    // px majority is rewritten in the CSSOM below. At 100% the property is
    // removed rather than written back, so the page is exactly as YTM shipped it.
    if (Math.abs(ytPrefs.scale - 1) > 0.001) {
      root.style.fontSize = (ytRootBase * ytPrefs.scale).toFixed(2) + "px";
    } else {
      root.style.removeProperty("font-size");
    }
    // rem rules follow the root above; the px majority follows this one.
    if (Math.abs(ytPrefs.scale - 1) > 0.001) {
      ytCollectScaleTargets();
      ytApplyScale();
      ytWatchSheets();
    } else if (ytScaleTargets) {
      ytApplyScale();
    }
  }

  /* ---- the px half of the interface scale --------------------------------
     YouTube Music authors almost all of its type in fixed px (16px guide
     entries, 14px row titles, 12px bylines), so scaling the rem root alone
     left the app looking untouched — that is the "it does nothing" AJ hit on
     2026-10-22. The px declarations are rewritten in the LIVE CSSOM instead:
     every font-size, plus every custom property whose name mentions font-size
     (YTM sizes whole component families from tokens such as
     --ytmusic-responsive-font-size), gets multiplied. The normal cascade —
     inheritance included — does the rest, and nothing is hard-coded, so a
     component YouTube ships next month is covered for free.

     Originals are captured ONCE and always multiplied from that snapshot, so
     dragging the slider can never compound the scale. At 100% every touched
     declaration is written back and the page is YouTube's again. */
  let ytScaleTargets = null;
  const ytScaleSheets = new WeakSet();
  let ytScaleObserver = null;

  function ytSheetIsOurs(sheet) {
    const node = sheet.ownerNode;
    // Content-script CSS is not listed in document.styleSheets at all, and
    // adopted stylesheets belong to the page. No owner node = not ours to touch.
    if (!node) return true;
    if (node.getAttribute && node.getAttribute("data-ym-owned")) return true;
    if (/^ym-/.test(String(node.id || ""))) return true;
    return /^(chrome|moz|safari-web)-extension:/.test(String(node.href || ""));
  }

  function ytHarvestRules(rules) {
    for (const rule of rules) {
      // Grouping rules (@media, @supports) carry no declarations of their own.
      if (!rule.style) {
        if (rule.cssRules && rule.cssRules.length) ytHarvestRules(rule.cssRules);
        continue;
      }
      // Aurora's own UI keeps its type whichever sheet it lands in.
      if (rule.selectorText && rule.selectorText.indexOf("ym-") !== -1) continue;
      const style = rule.style;
      const size = String(style.getPropertyValue("font-size") || "").trim();
      if (/^\d+(\.\d+)?px$/.test(size) && parseFloat(size) > 0) {
        ytScaleTargets.push({
          style,
          prop: "font-size",
          px: parseFloat(size),
          priority: style.getPropertyPriority("font-size"),
        });
      }
      for (const prop of style) {
        if (!prop.startsWith("--") || prop.toLowerCase().indexOf("font-size") === -1) continue;
        const value = String(style.getPropertyValue(prop) || "").trim();
        if (!/^\d+(\.\d+)?px$/.test(value)) continue;
        ytScaleTargets.push({
          style,
          prop,
          px: parseFloat(value),
          priority: style.getPropertyPriority(prop),
        });
      }
    }
  }

  function ytCollectScaleTargets() {
    if (!ytScaleTargets) ytScaleTargets = [];
    for (const sheet of Array.from(document.styleSheets)) {
      if (ytScaleSheets.has(sheet)) continue;
      if (ytSheetIsOurs(sheet)) { ytScaleSheets.add(sheet); continue; }
      let rules = null;
      // Throws for cross-origin sheets, and a freshly added <link> is listed
      // before its CSS is parsed. Neither is marked as done: a later pass can
      // still find rules in the second case.
      try { rules = sheet.cssRules; } catch (_) { continue; }
      if (!rules || !rules.length) continue;
      ytScaleSheets.add(sheet);
      try { ytHarvestRules(rules); } catch (_) {}
    }
  }

  function ytApplyScale() {
    if (!ytScaleTargets || !ytScaleTargets.length) return;
    const scale = ytPrefs.scale;
    for (const target of ytScaleTargets) {
      try {
        // Priority is passed through: setProperty() without it would silently
        // drop an !important and change which rule wins.
        target.style.setProperty(target.prop, (target.px * scale).toFixed(2) + "px", target.priority);
      } catch (_) {}
    }
  }

  // YTM lazy-loads stylesheet chunks as you navigate. Without this, a page
  // reached after boot keeps its stock type while everything else scales.
  function ytWatchSheets() {
    if (ytScaleObserver || !document.head || !window.MutationObserver) return;
    const pass = () => {
      if (ytPrefs.scale === 1) return;
      ytCollectScaleTargets();
      ytApplyScale();
    };
    ytScaleObserver = new MutationObserver(() => {
      pass();
      // A <link> shows up in the DOM before its rules do, and the load itself
      // fires no mutation; one delayed look picks the sheet up once it parses.
      window.setTimeout(pass, 1500);
    });
    ytScaleObserver.observe(document.head, { childList: true });
  }

  async function loadYtPrefs() {
    const saved = await safeStorageGet(YT_PREFS_KEY, null);
    const defaultsRev = Number(await safeStorageGet(YT_DEFAULTS_REV_KEY, 0)) || 0;
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      // Read through the schema instead of naming the keys. The first three
      // home switches were added to the page and to applyYtPrefs() but not
      // here, so they painted the page and then came back Off on the next
      // load; a schema pass cannot drift again (AJ, 2026-10-22).
      const next = Object.assign({}, DEFAULT_YT_PREFS);
      for (const key of Object.keys(DEFAULT_YT_PREFS)) {
        if (key === "scale") next.scale = clampYtScale(saved.scale);
        else if (key === "songLayout") next.songLayout = songLayoutNormalized(saved.songLayout);
        else if (typeof saved[key] === "boolean") next[key] = saved[key];
      }
      ytPrefs = next;
      // The shipped look changed on 2026-10-26 (every Apple Music switch on,
      // glass chrome off, type at 120%). A profile still holding the old set
      // exactly never chose any of it, so it moves to the new defaults; one
      // customised switch keeps the whole set it was using. Runs once.
      if (defaultsRev < YT_DEFAULTS_REV && matchesLegacyYtPrefs(saved)) {
        ytPrefs = Object.assign({}, DEFAULT_YT_PREFS);
      }
    } else {
      // One-time migration from the build where this switch lived in Aurora
      // Lyrics' own settings. Without it, updating would quietly switch the font
      // back off under anyone who had already turned it on (AJ, 2026-10-22).
      const store = await getExtensionSettingsStore();
      const legacy = store["ytmod-spicy-lyrics"];
      if (legacy && legacy.youtubeFont === true) {
        ytPrefs = Object.assign({}, DEFAULT_YT_PREFS, { font: true });
      }
    }
    if (defaultsRev < YT_DEFAULTS_REV) {
      await safeStorageSet({ [YT_DEFAULTS_REV_KEY]: YT_DEFAULTS_REV });
    }
    applyYtPrefs();
    // Armed once at boot; it stays idle unless the Library filter is on.
    ytWatchEmptyPlaylists();
  }

  // Dragging the size slider fires an input event per pixel; without this every
  // one of them was a storage write (AJ, 2026-10-22).
  let ytSaveTimer = 0;
  function saveYtPrefs() {
    clearTimeout(ytSaveTimer);
    ytSaveTimer = window.setTimeout(() => {
      // Same schema pass as the loader, for the same reason.
      const out = {};
      for (const key of Object.keys(DEFAULT_YT_PREFS)) out[key] = ytPrefs[key];
      chrome.storage.local.set({ [YT_PREFS_KEY]: out });
    }, 200);
  }

  // One row of the YouTube page, built from the same classes as an add-on's
  // settings rows so both surfaces read as one panel — same switch, same slider,
  // same hover and focus treatment.
  function ytRow(key, label, input, valueEl) {
    return h("div", { class: "ym-detail-setting-row", "data-key": key },
      h("div", { class: "ym-detail-setting-label", text: label }),
      h("div", { class: "ym-detail-setting-control" }, input, valueEl)
    );
  }

  // A switch row for the YouTube page: one label, one switch, one On/Off readout.
  function ytToggleRow(key, label, value, onChange) {
    const input = h("input", {
      class: "ym-detail-setting-input",
      type: "checkbox",
      "aria-label": label,
    });
    input.checked = value === true;
    const out = h("output", {
      class: "ym-detail-setting-value",
      text: input.checked ? "On" : "Off",
    });
    input.addEventListener("change", () => {
      out.textContent = input.checked ? "On" : "Off";
      onChange(input.checked);
    });
    return ytRow(key, label, input, out);
  }

  /* ---- the YouTube page: a picker, then one panel per part of the site ----
     AJ, 2026-10-22. The page used to be one long column of settings. It is now
     two levels: a tile per part of YouTube Music, then that part's switches.
     Five Home levers plus Playlist view was going to be a wall, and a tile per
     part reads as a map of the site rather than a list of settings.

     Both views live inside .ym-yt-views and are SWAPPED, not re-rendered by the
     marketplace — and the outgoing view plays its own exit (fade + travel +
     blur) before it is replaced, so going back is a motion, not a cut. */
  // Which panel is open; null = the picker. Module-level so a QUIET re-render
  // (install / uninstall while the panel is open) keeps the user where they are.
  /* ---- Library cards: which ones are empty -------------------------------
     YouTube prints "0 tracks" in the subtitle of an empty playlist and nothing
     in the element itself, so CSS cannot filter them — the class has to be
     spent from script. Only the subtitle is read, and only while the switch is
     on, so the cost is one text scan per browse re-render (AJ, 2026-10-22).

     LIMIT: the match is the English string. A localized YouTube would print
     "0 Titel" and nothing would be hidden — the rest of this panel is English
     too, so the switch simply does nothing there rather than hiding the wrong
     cards. */
  const ytEmptyRe = /(^|[\s\u2022·])0\s+(tracks?|songs?|episodes?)\b/i;
  let ytEmptyObserver = null;
  let ytEmptyTimer = 0;

  function ytTagEmptyPlaylists() {
    if (!ytPrefs.libHideEmpty) return;
    const cards = document.querySelectorAll("ytmusic-grid-renderer ytmusic-two-row-item-renderer");
    for (const card of cards) {
      const sub = card.querySelector(".subtitle");
      const empty = !!(sub && ytEmptyRe.test(sub.textContent || ""));
      if (card.classList.contains("ym-yt-empty") !== empty) card.classList.toggle("ym-yt-empty", empty);
    }
  }

  function ytWatchEmptyPlaylists() {
    if (ytEmptyObserver || !window.MutationObserver) return;
    ytEmptyObserver = new MutationObserver(() => {
      if (!ytPrefs.libHideEmpty) return;
      clearTimeout(ytEmptyTimer);
      ytEmptyTimer = window.setTimeout(ytTagEmptyPlaylists, 150);
    });
    ytEmptyObserver.observe(document.body, { childList: true, subtree: true });
  }

  let ytSection = null;
  // Mounted while a panel is open. The global Escape handler uses it to step
  // back one level instead of closing the whole panel.
  let ytBackToPicker = null;

  const YT_SECTIONS = [
    {
      id: "home",
      name: "Home screen",
      desc: "Chips, spacing, shelf titles, card captions.",
      art: "home",
      title: "Home screen",
      blurb: "Chips, spacing, shelf titles and card captions. The browse pages only — your library and the player are untouched.",
      active: () => ["noChips", "tightHome", "noCaptions", "wideShelves", "smallTitles"]
        .filter((k) => ytPrefs[k] === true).length,
      panels: () => [ytHomePanel()],
    },
    {
      id: "library",
      name: "Library",
      desc: "Empty playlists, card size.",
      art: "library",
      title: "Library",
      blurb: "Your saved music grid — what it shows, how big the cards are, and how much of the window they use. Only the Library page.",
      active: () => (ytPrefs.libHideEmpty ? 1 : 0) + (ytPrefs.libBig ? 1 : 0) +
        (ytPrefs.libWide ? 1 : 0),
      panels: () => [ytLibraryPanel()],
    },
    {
      id: "explore",
      name: "Explore",
      desc: "Shortcut tiles, the genre wall.",
      art: "explore",
      title: "Explore",
      blurb: "The four shortcut tiles at the top of Explore and the Moods & genres row under them. Only that page.",
      // The width lever only counts while the tiles it widens are on screen.
      active: () => (ytPrefs.exploreWide && !ytPrefs.exploreNoShortcuts ? 1 : 0) +
        (ytPrefs.exploreMoods ? 1 : 0) + (ytPrefs.exploreNoShortcuts ? 1 : 0),
      panels: () => [ytExplorePanel()],
    },
    {
      // Type and text size are the two settings that change EVERY page, so they
      // get their own tile rather than sitting under one page's name. It is the
      // tile that collects the next site-wide lever too (AJ, 2026-10-22).
      id: "global",
      name: "Global",
      desc: "The player bar's line, the hairlines.",
      art: "global",
      title: "Global",
      blurb: "The player bar's progress line, and the divider lines that separate one region from the next. Both apply on every page. The lyrics column, the type and the rest of the chrome live on the Apple Music theme.",
      active: () => (ytPrefs.smoothProgress ? 1 : 0) + (ytPrefs.noDividers ? 1 : 0),
      panels: () => [ytChromePanel()],
    },
  ];

  // A settings block. A block's heading is OPTIONAL: the section header above
  // already names the section, so a single unnamed block is the normal case and
  // a heading is only what separates two blocks in one section.
  function ytPanel(title, subtitle, cls) {
    const sec = h("section", { class: "ym-detail-settings ym-mk-settings" + (cls ? " " + cls : "") });
    if (title) {
      const head = h("div", { class: "ym-detail-settings-head" });
      head.appendChild(h("div", { class: "ym-detail-settings-titlerow" },
        h("div", { class: "ym-detail-settings-title", text: title })
      ));
      if (subtitle) head.appendChild(h("div", { class: "ym-detail-settings-subtitle", text: subtitle }));
      sec.appendChild(head);
    }
    return sec;
  }

  // The hairlines were the one lever in Global that was not part of the Apple
  // Music look, so they stayed behind when the rest moved to the theme card
  // (AJ, 2026-10-23). The progress line joined them as a second block: it is a
  // player-bar lever that applies on every page, not a page layout of its own.
  function ytChromePanel() {
    const frag = document.createDocumentFragment();

    const bar = ytPanel("Player bar");
    bar.appendChild(ytToggleRow("ytSmoothProgress", "Smooth progress line", ytPrefs.smoothProgress, (on) => {
      ytPrefs.smoothProgress = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    frag.appendChild(bar);

    const sec = ytPanel("Dividers");
    sec.appendChild(ytToggleRow("ytNoDividers", "Hide divider lines", ytPrefs.noDividers, (on) => {
      ytPrefs.noDividers = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    frag.appendChild(sec);
    return frag;
  }

  /* The theme's type block. The font, the interface size and the glass chrome
     were Global's rows on the YouTube page; they moved here with the rest of the
     Apple Music look (AJ, 2026-10-23). */
  function appleTypePanel() {
    const sec = ytPanel("Type and chrome");

    // ---- interface font
    sec.appendChild(ytToggleRow("ytFont", "Spicy Lyrics font", ytPrefs.font, (on) => {
      ytPrefs.font = on;
      applyYtPrefs();
      saveYtPrefs();
    }));

    // ---- glass top bar and side nav
    sec.appendChild(ytToggleRow("ytGlassChrome", "Glass top bar and side nav", ytPrefs.glassChrome, (on) => {
      ytPrefs.glassChrome = on;
      applyYtPrefs();
      saveYtPrefs();
    }));

    // ---- interface text size
    const scaleInput = h("input", {
      class: "ym-detail-setting-input",
      type: "range",
      min: YT_SCALE_MIN,
      max: YT_SCALE_MAX,
      step: 0.05,
      "aria-label": "Interface text size",
    });
    scaleInput.value = ytPrefs.scale;
    const scaleValue = h("output", {
      class: "ym-detail-setting-value",
      text: Math.round(ytPrefs.scale * 100) + "%",
    });
    // Drives the filled part of the track (the shared range CSS reads --val).
    const syncFill = () => {
      const pct = ((Number(scaleInput.value) - YT_SCALE_MIN) / (YT_SCALE_MAX - YT_SCALE_MIN)) * 100;
      scaleInput.style.setProperty("--val", Math.max(0, Math.min(100, pct)) + "%");
    };
    scaleInput.addEventListener("input", () => {
      ytPrefs.scale = clampYtScale(scaleInput.value);
      scaleValue.textContent = Math.round(ytPrefs.scale * 100) + "%";
      syncFill();
      applyYtPrefs();
      saveYtPrefs();
    });
    syncFill();
    sec.appendChild(ytRow("ytScale", "Interface text size", scaleInput, scaleValue));
    return sec;
  }

  function ytHomePanel() {
    // The browse pages, not the player: the chip row is the tallest thing above
    // the first shelf and the cards carry two lines of metadata each. Every
    // switch is independent, so this reads as a menu rather than a "mode".
    const sec = ytPanel(null, null, "ym-mk-yt-home");
    sec.appendChild(ytToggleRow("ytNoChips", "Hide the filter chips", ytPrefs.noChips, (on) => {
      ytPrefs.noChips = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    sec.appendChild(ytToggleRow("ytTightHome", "Tighter home spacing", ytPrefs.tightHome, (on) => {
      ytPrefs.tightHome = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    sec.appendChild(ytToggleRow("ytNoCaptions", "Artwork-only cards", ytPrefs.noCaptions, (on) => {
      ytPrefs.noCaptions = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    sec.appendChild(ytToggleRow("ytWideShelves", "Let the shelves use the full width", ytPrefs.wideShelves, (on) => {
      ytPrefs.wideShelves = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    sec.appendChild(ytToggleRow("ytSmallTitles", "Small shelf titles", ytPrefs.smallTitles, (on) => {
      ytPrefs.smallTitles = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    return sec;
  }

  function ytLibraryPanel() {
    const sec = ytPanel(null, null);
    sec.appendChild(ytToggleRow("ytLibEmpty", "Hide empty playlists", ytPrefs.libHideEmpty, (on) => {
      ytPrefs.libHideEmpty = on;
      applyYtPrefs();
      ytWatchEmptyPlaylists();
      saveYtPrefs();
    }));
    sec.appendChild(ytToggleRow("ytLibBig", "Larger library cards", ytPrefs.libBig, (on) => {
      ytPrefs.libBig = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    sec.appendChild(ytToggleRow("ytLibWide", "Let the library use the full width", ytPrefs.libWide, (on) => {
      ytPrefs.libWide = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    return sec;
  }

  function ytExplorePanel() {
    const sec = ytPanel(null, null);
    const wideRow = ytToggleRow("ytExploreWide", "Full-width shortcut tiles", ytPrefs.exploreWide, (on) => {
      ytPrefs.exploreWide = on;
      applyYtPrefs();
      saveYtPrefs();
    });
    sec.appendChild(wideRow);
    sec.appendChild(ytToggleRow("ytExploreMoods", "Moods & genres as a grid", ytPrefs.exploreMoods, (on) => {
      ytPrefs.exploreMoods = on;
      applyYtPrefs();
      saveYtPrefs();
    }));

    /* The width lever has nothing to widen while the tiles are hidden, so the
       skip switch locks it. Locked, not cleared: the stored value survives, and
       turning the tiles back on restores the width they were at. Runs on build
       too, so reopening the section shows the lock that is really in effect. */
    const syncWideLock = () => {
      const locked = ytPrefs.exploreNoShortcuts === true;
      wideRow.classList.toggle("is-locked", locked);
      wideRow.setAttribute("aria-disabled", locked ? "true" : "false");
      if (locked) wideRow.title = "The shortcut tiles are hidden";
      else wideRow.removeAttribute("title");
      const input = wideRow.querySelector("input");
      if (input) {
        input.disabled = locked;
        input.tabIndex = locked ? -1 : 0;
      }
    };

    sec.appendChild(ytToggleRow("ytExploreNoShortcuts", "Skip the shortcut tiles", ytPrefs.exploreNoShortcuts, (on) => {
      ytPrefs.exploreNoShortcuts = on;
      applyYtPrefs();
      saveYtPrefs();
      syncWideLock();
    }));
    syncWideLock();
    return sec;
  }

  // A switch the current player bar has made irrelevant: dim it the same way as
  // any other locked row instead of letting it look broken, and leave its stored
  // value alone — the old bar still reads it if YouTube rolls back.
  function ytLockRow(row, why) {
    row.classList.add("is-locked");
    row.setAttribute("aria-disabled", "true");
    row.title = why;
    const input = row.querySelector("input");
    if (input) {
      input.disabled = true;
      input.tabIndex = -1;
    }
  }

  function applePlayerPanel() {
    const sec = ytPanel("Player bar and song view");
    // The bar's own look and arrangement. Independent of the compact lever
    // below: one changes the bar's HEIGHT, these change its surface and where
    // its three zones sit.
    sec.appendChild(ytToggleRow("ytDarkBar", "Dark frosted player bar", ytPrefs.darkBar, (on) => {
      ytPrefs.darkBar = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    // Off restores YouTube's own glyphs and the stock spacing around them, so
    // the bar reads exactly as it did before the theme (AJ, 2026-10-23).
    sec.appendChild(ytToggleRow("ytIcons", "Custom player-bar icons", ytPrefs.customIcons, (on) => {
      ytPrefs.customIcons = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    // The 2026 mini-player bar ships this arrangement natively — song info on
    // the left, transport centred — so there is nothing left for the switch to
    // change there. Dim it instead of letting it look broken, and keep it live
    // on the old bar, which still needs the re-layout.
    const dockRow = ytToggleRow("ytDock", "Song info left, controls centred", ytPrefs.dock, (on) => {
      ytPrefs.dock = on;
      applyYtPrefs();
      saveYtPrefs();
    });
    if (document.querySelector("ytmusic-miniplayer")) {
      ytLockRow(dockRow, "YouTube Music's new player bar already lays the bar out this way");
    }
    sec.appendChild(dockRow);
    sec.appendChild(ytToggleRow("ytCompact", "Compact header and player bar", ytPrefs.compact, (on) => {
      ytPrefs.compact = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    sec.appendChild(ytToggleRow("ytVolume", "Always show the volume slider", ytPrefs.volume, (on) => {
      ytPrefs.volume = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    // The new bar paints its own volume slider, so this switch has nothing left
    // to do there. Dim it, same as the dock switch above, and deliberately stop
    // short of making it work — the stored value stays for the old bar.
    const volumeRow = sec.querySelector('[data-key="ytVolume"]');
    if (volumeRow && document.querySelector("ytmusic-miniplayer")) {
      ytLockRow(volumeRow, "YouTube Music's new player bar has its own volume slider");
    }
    // The column beside the cover. Independent levers: the width one is about
    // how much lyric fits on a line, the tab one about how the four labels
    // share that width.
    sec.appendChild(ytToggleRow("ytSongWide", "Wider lyrics column", ytPrefs.songWide, (on) => {
      ytPrefs.songWide = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    sec.appendChild(ytToggleRow("ytSongTabs", "Quiet tab strip with a sliding capsule", ytPrefs.songTabs, (on) => {
      ytPrefs.songTabs = on;
      applyYtPrefs();
      saveYtPrefs();
    }));
    return sec;
  }

  // The tile's "picture" is CSS, not artwork: a mini shelf for Home and a
  // now-playing stack for Song view. Two elements per tile either way, so a
  // third section only needs its own art class.
  function ytTileArt(kind) {
    const art = h("div", { class: "ym-yt-art ym-yt-art-" + kind, "aria-hidden": "true" });
    if (kind === "home") {
      // First cell is the shelf title, then eight cards in two rows.
      for (let i = 0; i < 9; i++) art.appendChild(h("i"));
    } else if (kind === "global") {
      // The hairline IS the setting: two regions and the divider the switch
      // hides between them. It used to be a letterform, back when the type and
      // the size lived on this page (AJ, 2026-10-23).
      art.appendChild(h("i", { class: "ym-yt-art-block" }));
      art.appendChild(h("i", { class: "ym-yt-art-rule" }));
      art.appendChild(h("i", { class: "ym-yt-art-block" }));
    } else if (kind === "library") {
      // A little grid of covers, with one round artist tile among them.
      for (let i = 0; i < 8; i++) art.appendChild(h("i"));
    } else if (kind === "explore") {
      // Four shortcut cards over a strip of genre chips — the page's own map.
      const cards = h("div", { class: "ym-yt-art-cards" });
      for (let i = 0; i < 4; i++) cards.appendChild(h("i"));
      art.appendChild(cards);
      const chips = h("div", { class: "ym-yt-art-chips" });
      for (let i = 0; i < 3; i++) chips.appendChild(h("i"));
      art.appendChild(chips);
    } else {
      art.appendChild(h("i", { class: "ym-yt-disc" }));
      const lines = h("div", { class: "ym-yt-lines" });
      for (let i = 0; i < 4; i++) lines.appendChild(h("i"));
      art.appendChild(lines);
    }
    return art;
  }

  function ytTile(sec, onOpen) {
    // The badge sits inside aria-hidden art, so the tile names itself.
    const tile = h("button", { class: "ym-yt-tile", type: "button", "aria-label": sec.name + " settings" });
    const art = ytTileArt(sec.art);
    const on = sec.active();
    if (on) art.appendChild(h("span", { class: "ym-yt-tile-badge", text: on + " on" }));
    tile.appendChild(art);

    const body = h("div", { class: "ym-yt-tile-body" });
    const row = h("div", { class: "ym-yt-tile-row" });
    row.appendChild(h("div", { class: "ym-yt-tile-name", text: sec.name }));
    row.appendChild(svgIcon(ICON_CHEVRON));
    body.appendChild(row);
    body.appendChild(h("div", { class: "ym-yt-tile-desc", text: sec.desc }));
    tile.appendChild(body);

    tile.addEventListener("click", () => onOpen(sec));
    return tile;
  }

  function ytPickerView(onOpen) {
    const view = h("div", { class: "ym-yt-view", "data-view": "picker" });
    const tiles = h("div", { class: "ym-yt-tiles" });
    for (const sec of YT_SECTIONS) tiles.appendChild(ytTile(sec, onOpen));
    view.appendChild(tiles);
    return view;
  }

  function ytSectionView(sec, onBack) {
    const view = h("div", { class: "ym-yt-view", "data-section": sec.id });

    const back = h("button", { class: "ym-yt-back", type: "button", "aria-label": "All sections" });
    back.appendChild(svgIcon(ICON_BACK));
    back.appendChild(h("span", { text: "All sections" }));
    back.addEventListener("click", onBack);
    view.appendChild(back);

    const head = h("div", { class: "ym-yt-sec-head" });
    head.appendChild(h("h2", { class: "ym-yt-sec-title", text: sec.title }));
    head.appendChild(h("p", { class: "ym-yt-sec-blurb", text: sec.blurb }));
    view.appendChild(head);

    for (const panel of sec.panels()) view.appendChild(panel);
    return view;
  }

  function mkYoutubePage() {
    const wrap = h("div", { class: "ym-mk-dwrap ym-mk-yt" });

    const head = h("div", { class: "ym-mk-dhead" });
    const glyph = MK_GLYPH.youtube;
    const mono = h("div", { class: "ym-mk-dmono" }, svgIcon(glyph.d));
    mono.style.color = glyph.c;
    mono.style.background = mkTint(glyph.c, "1f");
    mono.style.borderColor = mkTint(glyph.c, "3d");
    head.appendChild(mono);
    const titles = h("div", { class: "ym-mk-dtitles" });
    titles.appendChild(h("h1", { text: "YouTube Music" }));
    titles.appendChild(h("div", { class: "ym-mk-disclaimer", text: "Settings for the site itself, not for an add-on" }));
    head.appendChild(titles);
    wrap.appendChild(head);

    wrap.appendChild(h("p", {
      class: "ym-mk-lead",
      text: "These change YouTube Music rather than the lyrics. They keep working with every add-on uninstalled, and they apply the moment you change them.",
    }));

    const views = h("div", { class: "ym-yt-views" });
    wrap.appendChild(views);

    // Locked while a swap is in flight so a fast double click cannot stack two
    // exits on the same view.
    let busy = false;

    /* dir +1 travels INTO a section, -1 comes back out. The outgoing view leaves
       the way the eye is moving (the opposite side) and the incoming one enters
       from that side, so the two motions read as one slide. */
    function ymViewSwap(next, dir) {
      const from = views.firstElementChild;
      const reduce = window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const place = () => {
        views.replaceChildren(next);
        // A section is usually taller than the picker; opening it at whatever
        // scroll the previous view was left at would start mid-page.
        if (mkDetail) mkDetail.scrollTop = 0;
        if (reduce || !next.animate) { busy = false; return; }
        Array.from(next.children).forEach((el, i) => {
          if (!el.animate) return;
          el.animate(
            [
              { opacity: 0, transform: "translateX(" + (dir * 16) + "px)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: 380, delay: 16 + i * 46, easing: "cubic-bezier(.34,1.3,.5,1)", fill: "both" }
          );
        });
        busy = false;
      };
      if (!from || !from.animate || reduce) { place(); return; }
      busy = true;
      const outs = Array.from(from.children).map((el, i) => el.animate(
        [
          { opacity: 1, transform: "none", filter: "blur(0px)" },
          { opacity: 0, transform: "translateX(" + (dir * -14) + "px)", filter: "blur(3px)" },
        ],
        { duration: 150, delay: i * 10, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" }
      ));
      let settled = false;
      const go = () => { if (settled) return; settled = true; place(); };
      const last = outs[outs.length - 1];
      // onfinish is the good path; the timeout is the belt for a background
      // tab, where animation events can be skipped entirely.
      if (last) last.onfinish = go;
      window.setTimeout(go, 176 + outs.length * 10 + 40);
    }

    function open(sec) {
      if (busy || String(ytSection) === sec.id) return;
      ytSection = sec.id;
      ytBackToPicker = back;
      ymViewSwap(ytSectionView(sec, back), 1);
    }

    function back() {
      if (busy || !ytSection) return;
      ytSection = null;
      ytBackToPicker = null;
      ymViewSwap(ytPickerView(open), -1);
    }

    // A quiet re-render keeps the open section; a stale id (a section removed
    // in a later version) falls back to the picker.
    const start = YT_SECTIONS.find((s) => s.id === ytSection) || null;
    ytSection = start ? start.id : null;
    views.appendChild(start ? ytSectionView(start, back) : ytPickerView(open));
    if (start) ytBackToPicker = back;

    return wrap;
  }

  /* ---- Apple Music Style (AJ, 2026-10-23) ----------------------------------
     A theme with nothing to install and no stylesheet of its own: the preset IS
     the YouTube page's prefs, so these switches write YT_PREFS_KEY exactly the
     way the site page's own rows do. That is the point — an installable theme
     would need a second copy of every value and would still have to ask
     content.js to paint the classes, whereas this page opens showing what the
     site is really doing and hands the stock chrome back when every switch is
     off. It is the only place the playbar, the lyrics column, the type and the
     chrome are exposed now. */
  function mkAppleThemePage() {
    const wrap = h("div", { class: "ym-mk-dwrap ym-mk-yt" });

    const head = h("div", { class: "ym-mk-dhead" });
    const glyph = MK_GLYPH[APPLE_THEME_ID];
    const mono = h("div", { class: "ym-mk-dmono" }, svgIcon(glyph.d));
    mono.style.color = glyph.c;
    mono.style.background = mkTint(glyph.c, "1f");
    mono.style.borderColor = mkTint(glyph.c, "3d");
    head.appendChild(mono);
    const titles = h("div", { class: "ym-mk-dtitles" });
    titles.appendChild(h("h1", { text: APPLE_THEME_NAME }));
    titles.appendChild(h("div", {
      class: "ym-mk-disclaimer",
      text: "Built into the extension · not affiliated with Apple",
    }));
    head.appendChild(titles);
    wrap.appendChild(head);

    wrap.appendChild(h("p", {
      class: "ym-mk-lead",
      text: "The player bar, the lyrics column, the type and the chrome. Every switch changes YouTube Music itself, so they keep working with every add-on uninstalled — and with all of them off you get the stock site back.",
    }));

    wrap.appendChild(applePlayerPanel());
    wrap.appendChild(appleTypePanel());
    return wrap;
  }

  /* ---- Settings page (AJ, 2026-10-26) ----------------------------------
     The home for switches that are not an add-on. Performance is the first one:
     one governor over the three Kawarp backdrops (page, Now Playing rail,
     fullscreen), so a slower machine does not have to disable features one by
     one. Reached from the header button, never the rail: it is not something to
     install. */
  function mkSettingsPage() {
    const wrap = h("div", { class: "ym-mk-dwrap" });
    const head = h("div", { class: "ym-mk-dhead" });
    const mono = h("div", { class: "ym-mk-dmono ym-mk-setmono" }, svgIcon(ICON_SETTINGS));
    head.appendChild(mono);
    head.appendChild(h("div", { class: "ym-mk-dtitles" },
      h("h1", { text: "Settings" }),
      h("p", { class: "ym-mk-dby", text: "App-wide switches, not add-ons." })
    ));
    wrap.appendChild(head);
    wrap.appendChild(h("p", {
      class: "ym-mk-lead",
      text: "Performance sets how much of the animated backdrop runs. One choice caps every Kawarp at once — the page backdrop, the Now Playing rail and the fullscreen view — so a slower machine stays smooth without uninstalling anything.",
    }));

    const section = h("section", { class: "ym-perf" });
    section.appendChild(h("div", { class: "ym-detail-setting-section", text: "Performance mode" }));
    const modes = h("div", { class: "ym-perf-modes" });
    const options = [
      ["ultra", "Ultra", "Everything on: uncapped frame rate, and the live video feeds the backdrop."],
      ["normal", "Normal", "30fps backdrop, no video sampling, Now Playing rail at 24fps."],
      ["low", "Low", "24fps, no rail backdrop, no video sampling, a cheaper lyric blur, and no blur under the lyrics in fullscreen."],
    ];
    const buttons = new Map();
    const paint = (mode) => {
      buttons.forEach((b, key) => {
        b.classList.toggle("on", key === mode);
        b.setAttribute("aria-pressed", key === mode ? "true" : "false");
      });
    };
    for (const [mode, name, desc] of options) {
      const b = h("button", { class: "ym-perf-mode", type: "button", "aria-pressed": "false" },
        h("b", { text: name }),
        h("span", { text: desc })
      );
      b.addEventListener("click", () => {
        if (b.classList.contains("on")) return;
        paint(mode); // optimistic: the store round-trip is one tick away
        choosePerformanceMode(mode).catch(() => paint(performanceMode));
      });
      buttons.set(mode, b);
      modes.appendChild(b);
    }
    paint(performanceMode);
    // A value that lands after this page painted (storage read, or a change made
    // from the same page in another tab) repaints the choice.
    performancePaint = (mode) => { if (wrap.isConnected) paint(mode); };
    section.appendChild(modes);
    section.appendChild(h("p", {
      class: "ym-perf-note",
      text: "Applies everywhere the moment you pick one, and is remembered next time.",
    }));
    wrap.appendChild(section);
    loadPerformanceMode().then((mode) => { if (wrap.isConnected) paint(mode); });
    return wrap;
  }

  async function mkRenderDetail(reg, quiet) {
    if (!mkDetail) return;
    const keepScroll = quiet ? mkDetail.scrollTop : 0;
    // Snapshot the bits that should morph instead of snapping on a quiet
    // re-render (install / uninstall).
    const prevBtn = quiet ? mkDetail.querySelector(".ym-mk-btn-un, .ym-mk-btn-in") : null;
    const prevBtnW = prevBtn ? prevBtn.getBoundingClientRect().width : 0;
    const prevPill = quiet ? mkDetail.querySelector(".ym-mk-pill") : null;
    const prevPillBg = prevPill ? getComputedStyle(prevPill).backgroundColor : "";
    // Did the previous view already show a settings block? Used to animate the
    // block growing in after an install instead of snapping the actions row down.
    const prevHadSettings = quiet && !!mkDetail.querySelector(".ym-mk-settings");
    // ⭐ Hold the pane invisible until mkAnimateIn() has ARMED its stagger. Without
    // this the first paint showed the finished layout at full opacity for a frame
    // and THEN the stagger restarted it from 0 — the "home screen flashes, then
    // plays" AJ reported (2026-10-21). The hold is dropped in the same tick the
    // animations are created, so the delay frames are covered by their backwards
    // fill and nothing ever paints un-animated.
    mkDetail.classList.add("ym-mk-anim-hold");
    mkDetail.replaceChildren();
    mkDetail.scrollTop = 0;
    // The YouTube page is not an add-on, so it has to be matched BEFORE the
    // findAvail() fallback below — that check would otherwise bounce it to Home.
    if (mkSel === "youtube") {
      // A fresh visit opens on the picker; only a QUIET re-render keeps the
      // section that is already open.
      if (!quiet) ytSection = null;
      mkDetail.appendChild(mkYoutubePage());
      if (!quiet) mkAnimateIn();
      mkDetail.classList.remove("ym-mk-anim-hold");
      mkDetail.scrollTop = keepScroll;
      return;
    }
    // Apple Music Style is a page like the YouTube one, not a catalog entry with
    // an Install button, so it is matched before the findAvail fallback.
    if (mkSel === APPLE_THEME_ID) {
      mkDetail.appendChild(mkAppleThemePage());
      if (!quiet) mkAnimateIn();
      mkDetail.classList.remove("ym-mk-anim-hold");
      mkDetail.scrollTop = keepScroll;
      return;
    }
    // Not an add-on, so it has to be matched before the findAvail() fallback.
    if (mkSel === "settings") {
      mkDetail.appendChild(mkSettingsPage());
      if (!quiet) mkAnimateIn();
      mkDetail.classList.remove("ym-mk-anim-hold");
      mkDetail.scrollTop = keepScroll;
      return;
    }
    if (mkSel === "home" || !findAvail(mkSel)) {
      mkSel = "home";
      mkDetail.appendChild(mkHome(reg));
      if (!quiet) mkAnimateIn();
      mkDetail.classList.remove("ym-mk-anim-hold");
      mkDetail.scrollTop = keepScroll;
      return;
    }
    const ext = findAvail(mkSel);
    const installed = !!reg[ext.id];
    const wrap = h("div", { class: "ym-mk-dwrap" + (quiet ? " ym-mk-quiet" : "") });

    const head = h("div", { class: "ym-mk-dhead" });
    const dmono = h("div", { class: "ym-mk-dmono" });
    const dg = MK_GLYPH[ext.id];
    if (dg) {
      dmono.appendChild(svgIcon(dg.d));
      dmono.style.color = dg.c;
      dmono.style.background = mkTint(dg.c, "1f");
      dmono.style.borderColor = mkTint(dg.c, "3d");
    } else {
      dmono.textContent = (ext.name || "?").charAt(0).toUpperCase();
    }
    head.appendChild(dmono);
    const titles = h("div", { class: "ym-mk-dtitles" });
    titles.appendChild(h("h1", { text: ext.name }));
    // Small, dimmed provenance line under the name (AJ, 2026-10-19).
    if (ext.disclaimer) {
      titles.appendChild(h("div", { class: "ym-mk-disclaimer", text: ext.disclaimer }));
    }
    const status = h("div", { class: "ym-mk-status" });
    status.appendChild(h("span", { class: "ym-mk-pill" + (installed ? "" : " avail"), text: installed ? "Installed" : "Available" }));
    status.appendChild(h("span", { class: "ym-mk-ver", text: "v" + (ext.version || "?") }));
    titles.appendChild(status);
    head.appendChild(titles);
    wrap.appendChild(head);

    wrap.appendChild(h("div", { class: "ym-mk-sweep" }));
    wrap.appendChild(h("p", { class: "ym-mk-lead", text: ext.description || "" }));

    const src = MK_SOURCES[ext.id];
    if (src) wrap.appendChild(mkSources(src));

    const cols = h("div", { class: "ym-mk-dcols solo" });
    const left = h("div", { class: "ym-mk-left" });
    if (installed && ext.settings && ext.settings.length) {
      const settings = await buildSettingsSection(ext);
      if (settings) {
        settings.classList.add("ym-mk-settings");
        // Aurora Lyrics gets the grouped sub-rail; every other add-on keeps the
        // plain column (AJ, 2026-10-21).
        left.appendChild(ext.id === "ytmod-spicy-lyrics"
          ? groupLyricsSettings(settings)
          : settings);
      }
    } else if (!installed && ext.settings && ext.settings.length) {
      left.appendChild(h("div", { class: "ym-mk-hint", text: "Install this add-on to change its settings." }));
    }
    left.appendChild(mkActions(ext, installed));
    cols.appendChild(left);
    wrap.appendChild(cols);
    mountReportButton(wrap, ext);
    mkDetail.appendChild(wrap);
    if (!quiet) mkAnimateIn();
    else {
      // Settings just appeared (install): grow the block so the actions row
      // slides down instead of snapping (AJ, 2026-10-19).
      if (!prevHadSettings) {
        const se = mkDetail.querySelector(".ym-mk-settings");
        if (se) mkGrowIn(se);
      }
      mkQuietPolish(prevBtnW, prevPillBg);
    }
    mkDetail.classList.remove("ym-mk-anim-hold");
    mkDetail.scrollTop = keepScroll;
  }

  // Spicy Lyrics font for the panel AND the update notice (AJ, 2026-09-28).
  // The stylesheet's relative woff2 URLs resolve against the extension, so a
  // <link> is enough. Extracted so showUpdateModal() can call it too — that card
  // can appear before the panel has ever been opened, and without the sheet the
  // family silently falls back to system-ui.
  function ensurePanelFont() {
    if (document.getElementById("ym-font")) return;
    try {
      const fontLink = document.createElement("link");
      fontLink.id = "ym-font";
      fontLink.rel = "stylesheet";
      fontLink.href = chrome.runtime.getURL("src/extensions/fonts/spicy-lyrics.css");
      document.head.appendChild(fontLink);
    } catch (_) {}
  }

  function buildMarketplace() {
    ensurePanelFont();
    const close = makeIconButton(ICON_CLOSE, () => {
      closeMarketplace();
    }, "Close");
    close.id = "ym-close";

    const collapse = h("button", {
      class: "ym-mk-cbtn", type: "button",
      "aria-label": "Toggle sidebar", title: "Toggle sidebar",
    });
    collapse.appendChild(mkSidebarIcon());
    collapse.addEventListener("click", () => {
      overlay.classList.toggle("ym-mk-collapsed");
      mkAutoCollapsed = false; // manual choice wins over the media query
      mkPositionInd(true);
    });

    const logo = h("div", { class: "ym-mk-logo" });
    const logoUrl = mkLogoUrl();
    if (logoUrl) logo.style.backgroundImage = 'url("' + logoUrl + '")';

    // Settings is a BUTTON, not a rail row (AJ, 2026-10-26): it is an app-wide page,
    // so it must not read as another add-on to install.
    const settingsBtn = h("button", {
      class: "ym-mk-setbtn",
      type: "button",
      title: "Settings",
      "aria-label": "Open settings",
    });
    settingsBtn.appendChild(svgIcon(ICON_SETTINGS));
    settingsBtn.addEventListener("click", () => { if (mkSel !== "settings") mkSelect("settings"); });

    const title = h("h1", { text: "Add-ons" });
    // Secret entry point for developer mode — see onTitleTap(). Bound to
    // pointerdown rather than click on purpose: in floating mode
    // enableMarketplaceDrag() calls preventDefault() on the header's pointerdown,
    // which suppresses the derived mouse events.
    title.addEventListener("pointerdown", onTitleTap);
    const header = h("div", { class: "ym-head ym-mk-head" }, collapse, logo, title, settingsBtn, close);

    const seg = h("div", { class: "ym-mk-seg" });
    mkSegPill = h("span", { class: "ym-mk-segpill" });
    seg.appendChild(mkSegPill);
    for (const c of ["All", "Themes", "Extensions", "Snippets"]) {
      const b = h("button", {
        class: "ym-mk-segbtn" + (c === mkFilter ? " on" : ""),
        type: "button",
        "data-c": c,
        text: c,
      });
      b.addEventListener("click", () => setMkFilter(c));
      seg.appendChild(b);
    }

    const railTop = h("div", { class: "ym-mk-railtop" }, header, seg);
    mkInd = h("div", { class: "ym-mk-ind" });
    mkRows = h("div", { class: "ym-mk-rows" }, mkInd);
    const rail = h("aside", { class: "ym-mk-rail" }, railTop, mkRows);
    mkDetail = h("div", { class: "ym-mk-detail" });
    const paneHandle = h("div", { class: "ym-mk-draghandle", "aria-hidden": "true" });
    const pane = h("main", { class: "ym-mk-pane" }, paneHandle, mkDetail);

    const bg = h("div", { class: "ym-mk-bg" });
    try {
      bg.style.backgroundImage = 'url("' + chrome.runtime.getURL("assets/ambient-gradient.png") + '")';
    } catch (_) {}

    overlay = h("div", { id: "ym-market", class: "hidden ym-mk2" }, bg, rail, pane);
    document.body.appendChild(overlay);
    // Drag from the whole rail header block and from the detail pane's top strip.
    enableMarketplaceDrag(railTop);
    enableMarketplaceDrag(paneHandle);
    applyMarketplaceMode(false);
    document.addEventListener("keydown", marketKey);
    window.addEventListener("resize", syncMkCollapse);
    window.addEventListener("resize", () => mkPositionSegPill(true));
    // Quiet: the panel is hidden at build, so an entrance stagger here is never
    // seen - and a slow storage read would let it replay AFTER openMarketplace()
    // has already faded the panel in. The open path is the only visible one.
    renderSection(true);
  }

  async function renderSection(quiet) {
    if (!mkRows || !mkDetail) return;
    // Read BEFORE clearing: a failed storage read must not leave the panel blank.
    storageReadFailed = false;
    const reg = await getReg();
    if (storageReadFailed) {
      mkDetail.replaceChildren(h("div", {
        class: "ym-mk-empty",
        text: "Couldn't read your add-ons — the extension was reloaded while this tab was open. Refresh the tab (F5) to reconnect.",
      }));
      return;
    }
    const list = mkFilteredList();
    if (mkSel !== "home" && mkSel !== "settings" && !list.some((e) => e.id === mkSel)) mkSel = "home";
    mkBuildRows(list, reg);
    if (quiet && mkRows) {
      const chk = mkRows.querySelector(".ym-mk-card.sel .ym-mk-check");
      if (chk && chk.animate) {
        chk.animate([{ opacity: 0, transform: "scale(.5)" }, { opacity: 1, transform: "scale(1)" }],
          { duration: 320, easing: "cubic-bezier(.34,1.4,.5,1)" });
      }
    }
    await mkRenderDetail(reg, quiet);
    syncMkCollapse();
    mkPositionSegPill(true);
  }


  /* ---- detail view (click a card to open it) ---- */
  function githubLinks(ext) {
    const raw = ext.github;
    if (!raw) return [];
    if (typeof raw === "string") return [{ label: "GitHub", url: raw }];
    if (Array.isArray(raw)) {
      return raw
        .map((g) =>
          typeof g === "string"
            ? { label: "GitHub", url: g }
            : { label: g && g.label ? g.label : "GitHub", url: g && g.url }
        )
        .filter((g) => g.url);
    }
    return [];
  }

  const ICON_GITHUB =
    "M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.66-.22.66-.48 0-.24-.01-.87-.01-1.7-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02.8-.22 1.65-.33 2.5-.34.85.01 1.7.12 2.5.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85 0 1.34-.01 2.42-.01 2.75 0 .27.16.58.67.48A10.02 10.02 0 0 0 22 12c0-5.52-4.48-10-10-10z";

  async function renderDetail(ext, card) {
    if (!ext || typeof ext.id !== "string") {
      console.warn("[YTMod] renderDetail called with no extension", ext);
      return;
    }
    detailExt = ext; // remembered so setDevMode() can re-render this view in place
    const reg = await getReg();
    const installed = !!reg[ext.id];
    const enabled = reg[ext.id] && reg[ext.id].enabled;

    const titles = h("div", { class: "ym-detail-titles" },
      h("h2", { class: "ym-detail-name", text: ext.name }),
      h("span", { class: "ym-detail-cat", text: ext.category || "" })
    );

    const meta = h("div", { class: "ym-detail-meta" });
    meta.appendChild(h("span", { class: "ym-detail-author", text: "by " + (ext.author || "?") }));
    meta.appendChild(h("span", { class: "ym-detail-version", text: "v" + (ext.version || "?") }));

    const head = h("div", { class: "ym-detail-head" }, titles, meta);

    const desc = h("div", { class: "ym-detail-desc" });
    for (const para of String(ext.description || "").split("\n").filter(Boolean)) {
      desc.appendChild(h("p", { text: para }));
    }

    const links = githubLinks(ext);
    let ghWrap = null;
    if (links.length) {
      ghWrap = h("div", { class: "ym-detail-links" });
      for (const g of links) {
        const a = h("a", { class: "ym-detail-link", href: g.url, target: "_blank", rel: "noopener noreferrer" });
        const gh = svgIcon(ICON_GITHUB);
        gh.classList.add("ym-detail-link-icon");
        a.appendChild(gh);
        a.appendChild(h("span", { text: g.label }));
        ghWrap.appendChild(a);
      }
    }

    const action = h("div", { class: "ym-detail-action" });
    if (installed) {
      const status = h("span", { class: "ym-detail-status", text: enabled ? "Enabled" : "Disabled" });
      const tg = document.createElement("tp-yt-paper-toggle-button");
      let state = !!enabled;
      if (state) tg.setAttribute("checked", "");
      tg.addEventListener("click", () => {
        state = !state;
        setEnabled(ext.id, state).then(() => renderDetail(ext, sheetCard));
      });
      action.appendChild(status);
      action.appendChild(tg);
    } else {
      const b = h("tp-yt-paper-button", { class: "ym-install", text: "Install", raised: "" });
      b.addEventListener("click", () => install(ext.id).then(() => renderDetail(ext, sheetCard)));
      action.appendChild(b);
    }

    const wrap = h("div", { class: "ym-detail", id: "ym-detail" }, head, desc);
    if (ghWrap) wrap.appendChild(ghWrap);
    wrap.appendChild(action);
    // buildSettingsSection decides for itself what is visible (see
    // visibleSettings) and returns null when nothing is, so this only has to ask
    // whether the extension HAS settings at all. Nothing replaces them for a
    // normal user: no placeholder, no "settings are hidden" note.
    if (installed && ext.settings && ext.settings.length) {
      const settings = await buildSettingsSection(ext);
      if (settings) wrap.appendChild(settings);
    }
    mountReportButton(wrap, ext);

    // Paint the sheet: a per-add-on video / image if given, else the card's thumb
    // artwork. The video plays only while the sheet is open (paused on close).
    const a = ext.art || {};
    const fallback = thumbArt(card || sheetCard);
    let videoReady = null; // resolves when the sheet video is on the right frame
    // Never let a still inherit the previous add-on's video frame: drop any
    // leftover <video> from BOTH the poster and the blurred cover before painting
    // (AJ, 2026-09-28; cover-video cleanup added 2026-09-29).
    sheetPoster.querySelectorAll("video").forEach((v) => { try { v.pause(); } catch (_) {} v.remove(); });
    sheetCover.querySelectorAll("video").forEach((v) => { try { v.pause(); } catch (_) {} v.remove(); });
    sheetPoster.replaceChildren();
    sheetPoster.style.backgroundImage = "";
    sheetCover.style.backgroundImage = "";
    if (a.video) {
      // No `controls` at all (AJ, 2026-09-28) — no scrubber, no pause. Muted +
      // playsinline so it autoplays; disablepictureinpicture kills the PiP button.
      const srcVid = card && card.querySelector(".ym-thumb-video");
      // One sharp copy in the 3:4 poster, one blurred copy in the full-bleed cover.
      // The cover copy is what makes the background SAMPLE THE LIVE VIDEO (AJ,
      // 2026-09-29): Share-a-Lyric ships no poster image, so before this its
      // sheetCover fell back to a plain category gradient — the user reported the
      // background "doesn't sample the video like the other extensions do". Mounting
      // the same loop into the cover (already blurred + inset:-70px by .ym-sheet-cover)
      // fixes it and upgrades every video add-on's backdrop from a static poster
      // still to the live loop.
      const buildSheetVideo = () => {
        const el = h("video", {
          class: "ym-sheet-video",
          src: extArtUrl(a.video),
          loop: "",
          playsinline: "",
          autoplay: "",
          muted: "",
          disablepictureinpicture: "",
          controlslist: "nodownload noplaybackrate",
        });
        el.muted = true; // the attribute alone does not always satisfy the autoplay policy
        // Pin the size INLINE as well as in CSS: for one frame before the stylesheet
        // applies, a <video> lays out at its INTRINSIC 720×960, which read as "the
        // vid gets big then snaps back to normal" (AJ, 2026-09-28).
        el.style.position = "absolute";
        el.style.inset = "0";
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.objectFit = "cover";
        el.style.opacity = "0"; // hidden until it sits on the list loop's frame
        return el;
      };
      const vp = buildSheetVideo(); // sharp, in the poster
      const vc = buildSheetVideo(); // blurred, in the cover backdrop
      sheetPoster.appendChild(vp);
      sheetCover.appendChild(vc);
      const poster = extArtUrl(a.image || a.poster);
      sheetPoster.style.backgroundImage = poster ? 'url("' + poster + '")' : "";
      sheetCover.style.backgroundImage = ""; // the cover video shows through
      // Resolve once BOTH sheet videos sit on the SAME frame as the list loop. We
      // AWAIT this before the morph, so neither the poster nor the cover paints
      // frame 1 first and there is no still-frame gap (AJ, 2026-09-28).
      videoReady = new Promise((resolve) => {
        let done = false, pending = 2;
        const finish = () => { if (done) return; done = true; vp.style.opacity = ""; vc.style.opacity = ""; resolve(); };
        const onSeeked = () => { if (--pending <= 0) finish(); };
        const syncOne = (el) => {
          if (!srcVid) { onSeeked(); return; }
          const t = srcVid.currentTime;
          if (isFinite(t) && t > 0) {
            try { el.currentTime = t; } catch (_) { onSeeked(); return; }
            el.addEventListener("seeked", onSeeked, { once: true });
            return;
          }
          onSeeked();
        };
        const onReady = (el) => { if (el.readyState >= 1) syncOne(el); else el.addEventListener("loadedmetadata", () => syncOne(el), { once: true }); };
        onReady(vp); onReady(vc);
        window.setTimeout(finish, 400); // never hang the morph
      });
    } else if (a.image || a.poster) {
      // A still. extArtUrl() returns a BARE url, which is an invalid
      // background-image value and paints nothing — that blanked the Sleep Timer
      // poster (AJ, 2026-09-28). Always wrap it.
      const cssImg = 'url("' + extArtUrl(a.image || a.poster) + '")';
      sheetPoster.style.backgroundImage = cssImg;
      sheetCover.style.backgroundImage = cssImg;
    } else {
      // No art at all: mirror the LIST tile — category gradient + monogram — so the
      // poster is not an empty box (AJ, 2026-09-28).
      const catColor = CAT_COLOR[ext.category] || "#888";
      sheetPoster.style.background = "linear-gradient(135deg, " + catColor + "55, " + catColor + "18)";
      sheetPoster.appendChild(h("div", { class: "ym-sheet-mono", text: (ext.name || "?").charAt(0).toUpperCase() }));
      sheetCover.style.backgroundImage = fallback;
    }
    sheetText.replaceChildren(wrap);

    // Wait for the sheet video's frame, but never longer than a beat: a slow
    // metadata load must not stall the whole open (AJ, 2026-09-28). In the common
    // (cached) case the sync lands in a few ms and this is instant.
    if (videoReady) {
      try {
        await Promise.race([videoReady, new Promise((r) => window.setTimeout(r, 120))]);
      } catch (_) {}
    }

    if (card) showSheet(card);            // morph out of the clicked card
    else if (!sheetOpen) showSheet(null); // fade in (reopened without a card)
  }

  /* ---- the detail sheet: a FLIP morph out of the card's thumb ------------- */
  const SHEET_EASE = "cubic-bezier(0.32,0.72,0,1)";
  const SHEET_EASE_CLOSE = "cubic-bezier(1,0,0.68,0.28)";
  const SHEET_DUR = 560;
  const SHEET_CLOSE_DUR = 300; // closing should feel snappy, not a mirror of the open

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // Catalog `art` paths are extension-relative (assets/art/…); turn them into a
  // URL the page can actually load. Absolute URLs pass straight through.
  function extArtUrl(p) {
    if (!p) return "";
    if (/^(https?:|data:|blob:|chrome-extension:)/.test(p)) return p;
    try { return chrome.runtime.getURL(p); } catch (_) { return p; }
  }

  // The card's poster artwork = its .ym-thumb background (the category gradient,
  // or later a per-add-on image / video).
  function thumbArt(card) {
    const t = card && card.querySelector(".ym-thumb");
    return t ? getComputedStyle(t).backgroundImage : "";
  }

  function cancelSheetAnims() {
    sheetAnims.forEach((a) => { try { a.cancel(); } catch (_) {} });
    sheetAnims = [];
  }

  function showSheet(card) {
    if (sheetOpen) { if (card) sheetCard = card; return; }
    sheetCard = card || null;
    if (card) card.classList.add("is-open"); // hide the card's thumb during the morph
    // Freeze the list loop (renderDetail already read its time for the sync).
    const thumbVid = card && card.querySelector(".ym-thumb-video");
    if (thumbVid) { try { thumbVid.pause(); } catch (_) {} }
    sheetEl.classList.add("open");
    // Sit BELOW the header so the header stays visible and draggable while the
    // detail is open (AJ, 2026-09-28) — otherwise the sheet swallowed the drag.
    const head = overlay.querySelector(".ym-head");
    if (head) sheetEl.style.top = head.offsetHeight + "px";
    sheetOpen = true;
    sheetState = "opening";

    if (!card || reducedMotion() || !sheetEl.animate) { sheetState = "open"; return; }

    const pr = sheetEl.getBoundingClientRect();
    const from = card.querySelector(".ym-thumb").getBoundingClientRect();
    const to = sheetPoster.getBoundingClientRect();
    const s = from.width / to.width;
    const cardR = 16, posterR = 20;
    const o = { duration: SHEET_DUR, easing: SHEET_EASE, fill: "both" };

    sheetAnims = [
      sheetBg.animate([
        { top: (from.top - pr.top) + "px", left: (from.left - pr.left) + "px", width: from.width + "px", height: from.height + "px", borderRadius: cardR + "px" },
        { top: "0px", left: "0px", width: pr.width + "px", height: pr.height + "px", borderRadius: "0px" }
      ], o),
      sheetCover.animate([
        { inset: "0px", filter: "blur(0px) saturate(1)" },
        { inset: "-70px", filter: "blur(26px) saturate(1.25)" }
      ], o),
      sheetScrim.animate([{ opacity: 0 }, { opacity: 1 }], o),
      sheetPoster.animate([
        { transform: "translate(" + (from.left - to.left) + "px," + (from.top - to.top) + "px) scale(" + s + ")", borderRadius: (cardR / s) + "px" },
        { transform: "translate(0px,0px) scale(1)", borderRadius: posterR + "px" }
      ], o),
      sheetText.animate([{ opacity: 0, transform: "translateY(18px)" }, { opacity: 1, transform: "translateY(0px)" }],
        { duration: 420, delay: 140, easing: SHEET_EASE, fill: "both" }),
      sheetCloseBtn.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 360, delay: 200, easing: "ease-out", fill: "both" })
    ];
    sheetAnims[0].onfinish = () => { if (sheetState === "opening") sheetState = "open"; };
  }

  function finishCloseDetail() {
    // Flush any deferred source-order change: the user reordered lyrics sources
    // and is now closing the panel, so push the final order to the extension once
    // and let it re-resolve the current track. Cleared so this never double-fires
    // (AJ, 2026-10-19).
    if (pendingOrderPost) {
      postExtensionSettings(pendingOrderPost.id, pendingOrderPost.values);
      pendingOrderPost = null;
    }
    cancelSheetAnims();
    // Hand the time back to the list loop so it resumes where the sheet left off.
    const sv = sheetPoster && sheetPoster.querySelector("video");
    const cv = sheetCover && sheetCover.querySelector("video");
    const thumbVid = sheetCard && sheetCard.querySelector(".ym-thumb-video");
    if (thumbVid) {
      // The time was already handed over in closeDetail() (at close start); just
      // resume so we don't re-seek here and flash a frame (AJ, 2026-09-28).
      const p = thumbVid.play(); if (p && p.catch) p.catch(() => {});
    }
    if (sheetCard) sheetCard.classList.remove("is-open");
    if (sv) { try { sv.pause(); } catch (_) {} }
    if (cv) { try { cv.pause(); } catch (_) {} cv.remove(); }
    if (sheetPoster) sheetPoster.replaceChildren();
    sheetEl.classList.remove("open");
    sheetOpen = false;
    sheetState = "closed";
    sheetCard = null;
  }

  function closeDetail() {
    if (!sheetOpen || sheetState === "closing") return;
    sheetState = "closing";
    const card = sheetCard;
    cancelSheetAnims();
    // Hand the sheet video's time to the list loop NOW, so by the time the morph
    // ends and the loop is revealed it is already in sync — otherwise it briefly
    // shows its old frame first (AJ, 2026-09-28).
    const sheetVid = (sheetPoster && sheetPoster.querySelector("video")) || (sheetCover && sheetCover.querySelector("video"));
    const thumbVid = card && card.querySelector(".ym-thumb-video");
    if (sheetVid && thumbVid && isFinite(sheetVid.currentTime)) {
      try { thumbVid.currentTime = sheetVid.currentTime; } catch (_) {}
    }
    if (!card || reducedMotion() || !sheetEl.animate) { finishCloseDetail(); return; }

    const pr = sheetEl.getBoundingClientRect();
    const from = card.querySelector(".ym-thumb").getBoundingClientRect();
    const to = sheetPoster.getBoundingClientRect();
    const s = from.width / to.width;
    const cardR = 16, posterR = 20;
    const o = { duration: SHEET_CLOSE_DUR, easing: SHEET_EASE_CLOSE, fill: "both" };
    const quick = { duration: 150, easing: "ease-out", fill: "both" };

    sheetAnims = [
      sheetBg.animate([
        { top: "0px", left: "0px", width: pr.width + "px", height: pr.height + "px", borderRadius: "0px" },
        { top: (from.top - pr.top) + "px", left: (from.left - pr.left) + "px", width: from.width + "px", height: from.height + "px", borderRadius: cardR + "px" }
      ], o),
      sheetCover.animate([
        { inset: "-70px", filter: "blur(26px) saturate(1.25)" },
        { inset: "0px", filter: "blur(0px) saturate(1)" }
      ], o),
      sheetScrim.animate([{ opacity: 1 }, { opacity: 0 }], o),
      sheetPoster.animate([
        { transform: "translate(0px,0px) scale(1)", borderRadius: posterR + "px" },
        { transform: "translate(" + (from.left - to.left) + "px," + (from.top - to.top) + "px) scale(" + s + ")", borderRadius: (cardR / s) + "px" }
      ], o),
      sheetText.animate([{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(10px)" }], quick),
      sheetCloseBtn.animate([{ opacity: 1 }, { opacity: 0 }], quick)
    ];
    sheetAnims[0].onfinish = finishCloseDetail;
  }

  /* ---- nav button (top-right, before the utility controls) ---- */
  function mountNavButton() {
    if (document.getElementById("ym-nav-btn")) return true;
    const btn = makeIconButton(ICON_APPS, () => {
      // The hint has done its job the moment they click it.
      clearNavHint();
      // Toggle: the launcher closes an open panel instead of re-opening it
      // (AJ, 2026-10-19).
      const isOpen =
        overlay &&
        !overlay.classList.contains("hidden") &&
        !overlay.classList.contains("ym-leaving");
      if (isOpen) closeMarketplace();
      else openMarketplace();
    }, "Aurora Lyrics — Marketplace");
    btn.id = "ym-nav-btn";
    const bar = $("ytmusic-nav-bar");
    if (bar) {
      const right = $("#right-content", bar) || $(".right-content", bar);
      if (right) { right.insertBefore(btn, right.firstElementChild); return true; }
      const left = $(".left-content", bar) || bar.querySelector("div");
      const logo = $("#mini-guide-logo, a.title-logo, #logo", bar);
      if (left && logo) { left.insertBefore(btn, logo); return true; }
      if (left) { left.insertBefore(btn, left.children[1] || null); return true; }
    }
    btn.classList.add("ym-fallback");
    document.body.appendChild(btn);
    return true;
  }

  /* ---- popup -> page: flash the launcher ------------------------------------
     The toolbar popup exists only to send people to this button, but it closes
     the instant the pointer moves onto the page — so the hint has to OUTLIVE the
     popup. That is why this is a timed burst rather than a state the popup turns
     on and off: by the time the user's cursor reaches the nav bar, the popup is
     already gone and could not switch anything off. */
  const NAV_HINT_MS = 4300; // just past the CSS animation (0.85s x 5)
  let navHintTimer = 0;

  function clearNavHint() {
    if (navHintTimer) { window.clearTimeout(navHintTimer); navHintTimer = 0; }
    const btn = document.getElementById("ym-nav-btn");
    if (btn) btn.classList.remove("ym-nav-hint");
  }

  function highlightNavButton() {
    // Nothing to point at while the marketplace is already open.
    if (overlay && !overlay.classList.contains("hidden")) return;
    let btn = document.getElementById("ym-nav-btn");
    // The nav bar can still be unmounted if the popup opens during page load.
    if (!btn) { mountNavButton(); btn = document.getElementById("ym-nav-btn"); }
    if (!btn) return;
    // Restart cleanly: an animation does not replay while its class is already
    // present, so drop it and force a reflow before re-adding (repeat opens).
    btn.classList.remove("ym-nav-hint");
    void btn.offsetWidth;
    btn.classList.add("ym-nav-hint");
    if (navHintTimer) window.clearTimeout(navHintTimer);
    navHintTimer = window.setTimeout(() => {
      navHintTimer = 0;
      btn.classList.remove("ym-nav-hint");
    }, NAV_HINT_MS);
  }

  /* ---- diagnostics for the toolbar popup -----------------------------------
     The popup cannot read the page; a content script is the only bridge. So it
     asks for ONE snapshot and renders that — nothing here mutates the page or
     persists anything. Errors are captured because "it broke on this song" is
     useless without the message, and the last few are the only ones a user can
     still see by the time they open the popup. */
  const DIAG_ERROR_MAX = 3;
  const diagErrors = [];
  function recordDiagError(kind, message) {
    const text = String(message == null ? "" : message).replace(/\s+/g, " ").trim().slice(0, 200);
    if (!text) return; // resource load errors carry no message - not ours to report
    diagErrors.push({ kind, text, at: Date.now() });
    if (diagErrors.length > DIAG_ERROR_MAX) diagErrors.shift();
  }
  window.addEventListener("error", (e) => recordDiagError("error", e && e.message), true);
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e && e.reason;
    recordDiagError("promise", reason && reason.message ? reason.message : reason);
  }, true);

  function readPlayerBarTrack() {
    const clean = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, " ").trim() : "");
    // New bar: one track-info block whose byline is "artist • album • year".
    const mini = document.querySelector("ytmusic-miniplayer");
    if (mini) {
      const byline = mini.querySelector(".ytmusicTrackInfoByline");
      const links = byline ? Array.from(byline.querySelectorAll("a")).map(clean).filter(Boolean) : [];
      const img = mini.querySelector("img.ytmusicTrackInfoThumbnail") || mini.querySelector("img");
      const src = img && (img.currentSrc || img.getAttribute("src"));
      return {
        title: clean(mini.querySelector(".ytmusicTrackInfoTitle")),
        artist: links.length ? links[0] : clean(byline).split("•")[0].trim(),
        art: src && /^https?:/.test(src) ? src : "",
      };
    }
    const bar = document.querySelector("ytmusic-player-bar");
    const byline = bar && bar.querySelector(".byline");
    let artist = "";
    if (byline) {
      const links = Array.from(byline.querySelectorAll("a")).map(clean).filter(Boolean);
      artist = links.length ? links[0] : clean(byline);
    }
    const img = (bar && (bar.querySelector("img.image") || bar.querySelector("img"))) ||
      document.querySelector("#song-image img");
    const src = img && img.getAttribute("src");
    return {
      title: clean(bar && bar.querySelector(".title")),
      artist,
      art: src && /^https?:/.test(src) ? src : "",
    };
  }

  async function buildDiagnostics() {
    const reg = (await getReg()) || {};
    const installed = Object.keys(reg);
    const enabled = installed.filter((id) => reg[id] && reg[id].enabled);
    return {
      version: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "",
      url: location.href,
      track: readPlayerBarTrack(),
      // Which renderer the page is actually running, and where the panel lives.
      renderer: document.body && document.body.classList.contains("amll-active") ? "amll" : "standard",
      panel: !!document.querySelector("#ym-sl-panel"),
      fullscreen: !!document.querySelector(".ym-sl-fs-overlay"),
      addons: {
        installed: installed.length,
        enabled: enabled.length,
        names: enabled.map((id) => (findAvail(id) || {}).name || id),
      },
      error: diagErrors.length ? diagErrors[diagErrors.length - 1] : null,
      // Layout bugs are almost always size-dependent, and the popup cannot see
      // the page's viewport (its own is the popup's).
      viewport: window.innerWidth + " x " + window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    };
  }

  /* ---- messages from the popup ---- */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "ytmod-open") openMarketplace();
    else if (msg.type === "ytmod-hint-nav") highlightNavButton();
    else if (msg.type === "ytmod-setEnabled") setEnabled(msg.id, msg.on).then(renderSection);
    else if (msg.type === "ytmod-diagnostics") {
      // Async reply: keep the channel open, and never leave the popup hanging
      // on a rejected promise (it would show "checking" forever).
      buildDiagnostics()
        .then((snapshot) => sendResponse(snapshot))
        .catch(() => sendResponse(null));
      return true;
    }
  });

  /* ---- update notice ------------------------------------------------------
     Chrome owns the install step: an extension cannot install its own update,
     so this only ever INFORMS the user.

     Two modes:
       "updated"   - the running version changed since we last looked. Notes come
                     from the BUNDLED changelog.json, so this works offline and
                     can never be wrong about its own version.
       "available" - a newer version exists upstream. A bundled file only knows
                     about itself, so this needs the network: it reads the SAME
                     changelog.json from its raw GitHub URL.

     Every failure is silent on purpose. Offline, rate limited, or a private repo
     all mean "show nothing" — never a broken or empty card. */
  const UPDATE_STORAGE_KEY = "ytmod_update_state";
  const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const UPDATE_REMOTE_URL = "https://raw.githubusercontent.com/xyrodriv/Aurora-Lyrics-/main/changelog.json";
  const UPDATE_REPO_URL = "https://github.com/xyrodriv/Aurora-Lyrics-";
  const UPDATE_FETCH_TIMEOUT_MS = 6000;

  // Persistent top-bar banner (the "waiting for update" notice). Separate from
  // the dismissible popup: this stays until the installed version catches up.
  let updateIndicatorEl = null;
  let updateIndicatorPosIv = null;
  let lastAvailableRelease = null;

  // safeStorageSet takes the payload object itself, so the state has to be
  // nested under its key here. Writing it flat silently stored top-level
  // `lastSeenVersion`, which the getter below never read back — every load
  // looked like a first run and the notice never fired.
  const saveUpdateState = (state) => safeStorageSet({ [UPDATE_STORAGE_KEY]: state });

  function runningVersion() {
    try {
      const v = chrome.runtime.getManifest().version;
      return typeof v === "string" && v ? v : null;
    } catch (err) {
      return null; // orphaned content script: the extension was reloaded
    }
  }

  // Numeric compare, never string compare: "0.5.10" must sort above "0.5.9".
  function compareVersions(a, b) {
    const pa = String(a || "").split(".");
    const pb = String(b || "").split(".");
    for (let i = 0; i < 3; i++) {
      const na = parseInt(pa[i], 10) || 0;
      const nb = parseInt(pb[i], 10) || 0;
      if (na !== nb) return na > nb ? 1 : -1;
    }
    return 0;
  }

  function releaseList(changelog) {
    return changelog && Array.isArray(changelog.releases) ? changelog.releases : [];
  }

  function findRelease(changelog, version) {
    return releaseList(changelog).find((r) => r && r.version === version) || null;
  }

  function newestRelease(changelog) {
    let best = null;
    for (const r of releaseList(changelog)) {
      if (!r || typeof r.version !== "string") continue;
      if (!best || compareVersions(r.version, best.version) > 0) best = r;
    }
    return best;
  }

  async function readBundledChangelog() {
    try {
      const url = chrome.runtime.getURL("changelog.json");
      const res = await fetch(url, { cache: "no-store" });
      console.debug("[Aurora Lyrics] update check: changelog fetch " + url + " -> " + res.status);
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      console.debug("[Aurora Lyrics] update check: changelog fetch threw " + ((err && err.message) || err));
      return null;
    }
  }

  async function readRemoteChangelog() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), UPDATE_FETCH_TIMEOUT_MS);
      const res = await fetch(UPDATE_REMOTE_URL, { cache: "no-store", signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  let updateModalOpen = false;
  function showUpdateModal(opts) {
    if (updateModalOpen) return;
    const release = opts.release || {};
    const version = opts.version || release.version || "";
    const isUpdated = opts.mode === "updated";
    const dismiss = typeof opts.onDismiss === "function" ? opts.onDismiss : null;

    let overlay = null;
    const previousFocus = document.activeElement;
    // aria-modal promises the page behind is unavailable. Without this trap Tab
    // walked straight into the YouTube Music page behind the card.
    const focusables = () => overlay ? Array.from(overlay.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((el) => el.getClientRects().length) : [];
    const onKey = (e) => {
      if (e.key === "Escape") { close(); return; }
      if (e.key !== "Tab" || !overlay) return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !overlay.contains(active);
      if (e.shiftKey && (outside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    const close = () => {
      document.removeEventListener("keydown", onKey);
      if (overlay && overlay.isConnected) {
        const cardEl = overlay.querySelector(".ym-upd-card");
        if (cardEl) cardEl.classList.add("ym-upd-leaving");
        overlay.classList.add("ym-upd-leaving");
        const remove = () => { if (overlay && overlay.isConnected) overlay.remove(); };
        overlay.addEventListener("animationend", remove, { once: true });
        setTimeout(remove, 400); // fallback in case animationend never fires
      }
      updateModalOpen = false;
      if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function") {
        try { previousFocus.focus({ preventScroll: true }); } catch (_) {}
      }
    };
    const dismissAndClose = () => {
      close();
      if (dismiss) Promise.resolve(dismiss()).catch(() => {});
    };

    // Blurred logo layer that fills the panel. Same MV3 workaround: the image
    // source is set from JS via chrome.runtime.getURL, preloaded with an
    // Image() so a failure logs instead of leaving an empty panel.
    const cardface = h("div", { class: "ym-upd-cardface" });
    try {
      const logoSrc = chrome.runtime.getURL("assets/manifest-logo.webp");
      const preload = new Image();
      preload.onload = () => { cardface.style.backgroundImage = 'url("' + logoSrc + '")'; };
      preload.onerror = () => {
        console.debug("[Aurora Lyrics] update check: manifest logo failed to load from " + logoSrc);
      };
      preload.src = logoSrc;
    } catch (err) {
      console.debug("[Aurora Lyrics] update check: logo preload threw " + ((err && err.message) || err));
    }

    const body = h("div", { class: "ym-upd-body" });
    if (release.title) body.appendChild(h("p", { class: "ym-upd-sub", text: release.title }));
    if (release.date) body.appendChild(h("p", { class: "ym-upd-date", text: release.date }));
    const sections = [["New", release.features], ["Fixed", release.fixes]];
    for (const entry of sections) {
      const items = entry[1];
      if (!Array.isArray(items) || !items.length) continue;
      body.appendChild(h("p", { class: "ym-upd-sect", text: entry[0] }));
      const ul = h("ul", { class: "ym-upd-list" });
      for (const item of items) {
        if (typeof item !== "string" || !item) continue;
        ul.appendChild(h("li", { text: item }));
      }
      body.appendChild(ul);
    }
    if (!isUpdated) {
      body.appendChild(h("p", { class: "ym-upd-hint", text:
        "Chrome will install this update for you, usually within a few hours. " +
        "There's nothing to install yourself — just keep using Aurora Lyrics and it'll arrive. " +
        "Restart Chrome if you'd like it sooner." }));
    }

    const foot = h("div", { class: "ym-upd-foot" });
    if (!isUpdated) {
      foot.appendChild(h("a", { class: "ym-upd-btn", href: UPDATE_REPO_URL,
        target: "_blank", rel: "noopener noreferrer", text: "View on GitHub" }));
    }
    const ok = h("button", { class: "ym-upd-btn primary", type: "button",
      text: isUpdated ? "Got it" : "OK" });
    ok.addEventListener("click", dismissAndClose);
    foot.appendChild(ok);

    const x = h("button", { class: "ym-upd-close", type: "button", title: "Close", "aria-label": "Close" });
    x.appendChild(svgIcon(ICON_CLOSE));
    x.addEventListener("click", dismissAndClose);

    const heading = h("div", { class: "ym-upd-heading" },
      h("h2", { class: "ym-upd-title", text: isUpdated ? "Aurora Lyrics updated" : "Update available" }),
      version ? h("span", { class: "ym-upd-ver", text: "v" + version }) : null
    );
    ensurePanelFont();
    const card = h("div", { class: "ym-upd-card", role: "dialog", "aria-modal": "true",
      "aria-label": isUpdated ? "Aurora Lyrics updated" : "Aurora Lyrics update available" },
      cardface,
      h("div", { class: "ym-upd-head" }, heading, x),
      body,
      foot
    );

    overlay = h("div", { class: "ym-upd-overlay" }, card);
    // Clicks on the overlay (but not bubbled from the card) dismiss — replaces
    // the old backdrop element the dark overlay used to provide.
    overlay.addEventListener("click", (e) => { if (e.target === overlay) dismissAndClose(); });
    document.body.appendChild(overlay);
    updateModalOpen = true;
    document.addEventListener("keydown", onKey);
    ok.focus();
  }

  async function runUpdateCheck() {
    const version = runningVersion();
    if (!version) return;
    const state = (await safeStorageGet(UPDATE_STORAGE_KEY, {})) || {};
    const dismissed = Array.isArray(state.dismissed) ? state.dismissed : [];
    // A pending update is shown as a persistent top-bar banner, separate from
    // the dismissible popup. It stays until the installed version catches up.
    if (state.pendingUpdate) {
      if (compareVersions(state.pendingUpdate, version) > 0) {
        showUpdateIndicator(state.pendingUpdate);
      } else {
        await saveUpdateState(Object.assign({}, state, { pendingUpdate: null, pendingRelease: null }));
        hideUpdateIndicator();
      }
    }
    // console.debug is hidden unless the console filter is set to Verbose, so
    // this stays out of the way for real users but is there when diagnosing.
    console.debug("[Aurora Lyrics] update check: running v" + version +
      ", previously seen " + (state.lastSeenVersion || "nothing"));

    // First run on this profile: record the version and stay quiet. Otherwise
    // every existing user would get an "updated" card the day this ships.
    if (!state.lastSeenVersion) {
      console.debug("[Aurora Lyrics] update check: first run, recording v" + version + " and staying quiet");
      await saveUpdateState(Object.assign({}, state, { lastSeenVersion: version }));
      return;
    }

    if (state.lastSeenVersion !== version) {
      const release = findRelease(await readBundledChangelog(), version);
      await saveUpdateState(Object.assign({}, state, { lastSeenVersion: version }));
      console.debug("[Aurora Lyrics] update check: changelog entry for v" + version + " -> " + (release ? "found" : "MISSING"));
      if (release) {
        showUpdateModal({ mode: "updated", version: version, release: release });
      } else {
        console.debug("[Aurora Lyrics] changelog.json has no entry for v" + version);
      }
      return;
    }

    const now = Date.now();
    if (Number.isFinite(state.lastCheckAt) && now - state.lastCheckAt < UPDATE_CHECK_INTERVAL_MS) return;

    const latest = newestRelease(await readRemoteChangelog());
    if (!latest) {
      await saveUpdateState(Object.assign({}, state, { lastCheckAt: now }));
      return;
    }
    if (compareVersions(latest.version, version) <= 0) {
      await saveUpdateState(Object.assign({}, state, { lastCheckAt: now }));
      return;
    }
    if (dismissed.indexOf(latest.version) !== -1) {
      await saveUpdateState(Object.assign({}, state, { lastCheckAt: now }));
      return;
    }
    await saveUpdateState(Object.assign({}, state, {
      lastCheckAt: now,
      pendingUpdate: latest.version,
      pendingRelease: latest
    }));
    lastAvailableRelease = latest;
    showUpdateIndicator(latest.version);
    showUpdateModal({
      mode: "available",
      version: latest.version,
      release: latest,
      onDismiss: async () => {
        const s = (await safeStorageGet(UPDATE_STORAGE_KEY, {})) || {};
        const d = Array.isArray(s.dismissed) ? s.dismissed : [];
        if (d.indexOf(latest.version) === -1) d.push(latest.version);
        if (d.length > 12) d.splice(0, d.length - 12);
        await saveUpdateState(Object.assign({}, s, { dismissed: d }));
      }
    });
  }

  function showUpdateIndicator(version) {
    if (updateIndicatorEl) return;
    const banner = h("div", {
      class: "ym-upd-banner",
      role: "status",
      "aria-label": "A newer version of Aurora Lyrics is available",
      title: "A newer version of Aurora Lyrics is available - Chrome installs it automatically, or restart Chrome to fetch now"
    });
    const logo = h("div", { class: "ym-upd-banner-logo", "aria-hidden": "true" });
    try {
      const logoSrc = chrome.runtime.getURL("assets/manifest-logo.webp");
      const pre = new Image();
      pre.onload = () => { logo.style.backgroundImage = 'url("' + logoSrc + '")'; };
      pre.onerror = () => {};
      pre.src = logoSrc;
    } catch (_) {}
    const text = h("div", { class: "ym-upd-banner-text" },
      h("div", { class: "ym-upd-banner-title", text: "Update available" }),
      h("div", { class: "ym-upd-banner-sub", text: "v" + version })
    );
    banner.appendChild(logo);
    banner.appendChild(text);
    const closeBtn = h("button", {
      class: "ym-upd-banner-close",
      type: "button",
      "aria-label": "Dismiss update reminder",
      title: "Dismiss",
      text: "×"
    });
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dismissUpdateIndicator();
    });
    banner.appendChild(closeBtn);
    banner.addEventListener("click", openAvailableFromIndicator);
    document.body.appendChild(banner);
    updateIndicatorEl = banner;
    // The YTM nav bar (and thus #ym-nav-btn) may not be mounted yet when this
    // fires during boot — runUpdateCheck runs immediately while mountNavButton
    // retries on an interval. Position now, and retry until the button exists.
    if (!positionBanner(banner)) {
      let tries = 0;
      updateIndicatorPosIv = setInterval(() => {
        tries++;
        if (positionBanner(banner) || tries > 40) {
          clearInterval(updateIndicatorPosIv);
          updateIndicatorPosIv = null;
        }
      }, 300);
    }
  }

  // Place the banner just LEFT of the waffle, same height. Returns true once the
  // nav button is found and positioned, false if it isn't mounted yet.
  function positionBanner(banner) {
    const nav = document.getElementById("ym-nav-btn");
    if (!nav) return false;
    try {
      const r = nav.getBoundingClientRect();
      banner.style.top = Math.round(r.top) + "px";
      banner.style.right = (window.innerWidth - r.left + 8) + "px";
      return true;
    } catch (_) {
      banner.style.top = "16px";
      banner.style.right = "16px";
      return true;
    }
  }

  async function openAvailableFromIndicator() {
    let s = {};
    try { s = (await safeStorageGet(UPDATE_STORAGE_KEY, {})) || {}; } catch (_) {}
    const rel = s.pendingRelease || lastAvailableRelease;
    if (!rel) return;
    showUpdateModal({
      mode: "available",
      version: rel.version,
      release: rel,
      onDismiss: async () => {
        const cur = (await safeStorageGet(UPDATE_STORAGE_KEY, {})) || {};
        const d = Array.isArray(cur.dismissed) ? cur.dismissed : [];
        if (d.indexOf(rel.version) === -1) d.push(rel.version);
        if (d.length > 12) d.splice(0, d.length - 12);
        await saveUpdateState(Object.assign({}, cur, { dismissed: d }));
      }
    });
  }

  function hideUpdateIndicator() {
    if (updateIndicatorPosIv) { clearInterval(updateIndicatorPosIv); updateIndicatorPosIv = null; }
    if (updateIndicatorEl && updateIndicatorEl.parentNode) updateIndicatorEl.parentNode.removeChild(updateIndicatorEl);
    updateIndicatorEl = null;
  }

  // Dismiss the persistent banner for good: hide it and clear the pending state
  // (plus record the version as dismissed) so neither the banner nor the modal
  // re-surfaces for this version on the next load.
  async function dismissUpdateIndicator() {
    hideUpdateIndicator();
    try {
      const s = (await safeStorageGet(UPDATE_STORAGE_KEY, {})) || {};
      const d = Array.isArray(s.dismissed) ? s.dismissed : [];
      if (s.pendingUpdate && d.indexOf(s.pendingUpdate) === -1) d.push(s.pendingUpdate);
      if (d.length > 12) d.splice(0, d.length - 12);
      await saveUpdateState(Object.assign({}, s, { pendingUpdate: null, pendingRelease: null, dismissed: d }));
    } catch (_) {}
  }

  /* ---- remember last watch-page tab (always on) ----
     YTM always reopens on its default tab; it never restores the tab you were
     last on. This remembers the last tab you selected (Up next / Lyrics /
     Related / ...) in chrome.storage.local and re-selects it on each new video.
     Intentionally NOT a snippet: AJ wants this as general, always-on behaviour
     with no toggle. The tab is matched by label first, then by index, so it
     survives the Lyrics tab mounting a beat after the page settles. */
  const LAST_TAB_KEY = "ytmod_last_watch_tab";

  function isWatchPage() {
    try {
      return /(\/watch([?#]|$)|[?&]v=)/.test(location.href);
    } catch (e) {
      return false;
    }
  }
  function watchTabBar() {
    return (
      document.querySelector("ytmusic-player-page tp-yt-paper-tabs.tab-header-container") ||
      document.querySelector("ytmusic-player-page tp-yt-paper-tabs") ||
      document.querySelector("tp-yt-paper-tabs.tab-header-container") ||
      document.querySelector("tp-yt-paper-tabs")
    );
  }
  function watchTabs() {
    const bar = watchTabBar();
    if (!bar) return null;
    const tabs = Array.from(bar.querySelectorAll("tp-yt-paper-tab"));
    return tabs.length ? { bar, tabs } : null;
  }
  function tabLabel(tab) {
    return (tab.getAttribute("name") || (tab.textContent || "").trim()).toLowerCase();
  }
  function currentVideoId() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get("v") || u.pathname;
    } catch (e) {
      return location.href;
    }
  }

  let rltAppliedFor = null; // video id we've already applied the remembered tab for
  let rltSaveEnabled = false; // only record user changes AFTER we've applied
  let rltPending = null; // remembered identity we still want to apply
  let rltLoading = false; // guards the async storage read

  function rltSelect(tab) {
    try { tab.click(); } catch (e) {}
  }
  function rltApplyRemembered() {
    if (!isWatchPage()) {
      rltAppliedFor = null;
      rltSaveEnabled = false;
      rltPending = null;
      return;
    }
    const found = watchTabs();
    if (!found) return;
    const id = currentVideoId();
    if (rltAppliedFor === id && !rltPending) return;
    if (!rltPending && !rltLoading) {
      rltLoading = true;
      safeStorageGet(LAST_TAB_KEY, null).then((saved) => {
        rltLoading = false;
        if (!saved) {
          rltAppliedFor = id;
          rltSaveEnabled = true;
          return;
        }
        rltPending = saved;
        rltTryApply();
      });
      return;
    }
    rltTryApply();
  }
  function rltTryApply() {
    const found = watchTabs();
    if (!found) return;
    const { tabs } = found;
    const id = currentVideoId();
    let target = null;
    if (rltPending && typeof rltPending === "object") {
      target =
        tabs.find((t) => tabLabel(t) === rltPending.label) ||
        (rltPending.index >= 0 && tabs[rltPending.index] ? tabs[rltPending.index] : null);
    } else if (typeof rltPending === "string") {
      target = tabs.find((t) => tabLabel(t) === rltPending);
    }
    if (!target) {
      // Remembered tab not present yet (e.g. the Lyrics tab mounts after load).
      // Keep pending so navigation / the observer re-applies when it shows, but
      // let the user override in the meantime.
      rltSaveEnabled = true;
      return;
    }
    if (target.classList.contains("iron-selected")) {
      rltPending = null;
      rltAppliedFor = id;
      rltSaveEnabled = true;
      return;
    }
    console.log("[Aurora Lyrics] restoring last watch tab:", rltPending);
    rltSaveEnabled = false; // suppress the select we are about to trigger
    rltSelect(target);
    rltPending = null;
    rltAppliedFor = id;
    setTimeout(() => { rltSaveEnabled = true; }, 0);
  }
  function rltOnSelect(e) {
    if (!rltSaveEnabled) return;
    const tab = e && e.detail && e.detail.item;
    if (!tab || typeof tab.matches !== "function" || !tab.matches("tp-yt-paper-tab")) return;
    const found = watchTabs();
    if (!found) return;
    const identity = { label: tabLabel(tab), index: found.tabs.indexOf(tab) };
    console.log("[Aurora Lyrics] remembered watch tab:", identity.label);
    rltPending = null;
    rltAppliedFor = currentVideoId();
    safeStorageSet({ [LAST_TAB_KEY]: identity });
  }
  /* ---- song view: the tab capsule's geometry ------------------------------
     paper-tabs positions its selection bar with a percentage transform, which
     can draw a line but never a capsule: scaleX turns the corner radius into an
     ellipse. The capsule itself is CSS; it only needs the selected tab's real
     box, published here as two custom properties. Re-measured on every
     selection, resize and player-page rebuild — a couple of layout reads, and
     only while the lever is on. */
  function songTabGeometry() {
    if (!ytPrefs.songTabs) return;
    const strip = watchTabBar();
    if (!strip) return;
    const selected =
      strip.querySelector("tp-yt-paper-tab.iron-selected") ||
      strip.querySelector('tp-yt-paper-tab[aria-selected="true"]');
    // Zero width means the strip is still hidden (mini player, page building).
    if (!selected || !selected.offsetWidth) return;
    strip.style.setProperty("--ym-song-tab-x", selected.offsetLeft + "px");
    strip.style.setProperty("--ym-song-tab-w", selected.offsetWidth + "px");
  }

  function rltBindBar() {
    const bar = watchTabBar();
    if (bar && !bar.__rltBound) {
      bar.addEventListener("iron-select", rltOnSelect);
      // Separate listener: the capsule must follow even the programmatic
      // re-select this module does, which is deliberately not saved.
      bar.addEventListener("iron-select", () => {
        songTabGeometry();
        requestAnimationFrame(songTabGeometry);
      });
      bar.__rltBound = true;
      songTabGeometry();
    }
  }
  function initRememberLastWatchTab() {
    rltBindBar();
    rltApplyRemembered();
    const root = document.querySelector("ytmusic-player-page") || document.body;
    if (root) {
      let obsRaf = 0;
      const obs = new MutationObserver(() => {
        if (obsRaf) return;
        obsRaf = setTimeout(() => {
          obsRaf = 0;
          rltBindBar();
          rltApplyRemembered();
          songTabGeometry();
        }, 250);
      });
      obs.observe(root, { childList: true, subtree: true });
    }
    window.addEventListener("resize", songTabGeometry);
    document.addEventListener("yt-navigate-finish", () => {
      rltAppliedFor = null;
      rltSaveEnabled = false;
      rltPending = null;
      rltApplyRemembered();
      songTabGeometry();
    });
    window.addEventListener("popstate", () => {
      rltAppliedFor = null;
      rltSaveEnabled = false;
      rltPending = null;
      rltApplyRemembered();
    });
    console.log("[Aurora Lyrics] remember-last-watch-tab active");
  }

  /* ---- song view: the layout switcher -------------------------------------
     The player page is one flex row — #main-panel (cover or video) and
     #side-panel (tabs + the panel under them) — and the four layouts are that
     row's geometry, nothing else. Three of them are classes on <html> (see
     applyYtPrefs); this module is only the control that picks one.

     It is a pill in the empty band above both panels, NOT a fifth tab. Two
     reasons: paper-tabs sizes its labels with `fit-container`, so a foreign
     child inside #tabsContent would be measured into the selection geometry;
     and in "Cover art only" the tab column that would hold it does not exist,
     which would leave the switcher invisible in the one layout it cannot be
     left from. The pill is anchored to ytmusic-player-page (already a
     positioned element, and the parent of both panels), so it survives all
     four. */
  let songLayoutEl = null;
  let songLayoutBtn = null;
  let songLayoutMenu = null;

  // Each layout gets a 22×16 diagram: lyrics as text lines, the picture as a
  // filled block. Drawn rather than described, because the label alone cannot
  // say which side the cover ends up on.
  function songLayoutGlyph(id) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 22 16");
    svg.setAttribute("class", "ym-song-layout-glyph");
    svg.setAttribute("aria-hidden", "true");
    const block = (x, y, w, hgt, cls) => {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", x);
      r.setAttribute("y", y);
      r.setAttribute("width", w);
      r.setAttribute("height", hgt);
      r.setAttribute("rx", "1.5");
      r.setAttribute("class", cls);
      svg.appendChild(r);
    };
    if (id === "split") {
      block(1, 3, 8, 1.8, "ln");
      block(1, 7.1, 8, 1.8, "ln");
      block(1, 11.2, 5.5, 1.8, "ln");
      block(11.5, 2, 9.5, 12, "art");
    } else if (id === "lyrics") {
      block(1, 2.6, 20, 1.8, "ln");
      block(1, 7.1, 20, 1.8, "ln");
      block(1, 11.6, 13.5, 1.8, "ln");
    } else if (id === "art") {
      block(2, 1.5, 18, 13, "art");
    } else {
      block(1, 2, 12, 12, "art");
      block(15.5, 3, 5.5, 1.8, "ln");
      block(15.5, 7.1, 5.5, 1.8, "ln");
      block(15.5, 11.2, 3.5, 1.8, "ln");
    }
    return svg;
  }

  function songLayoutOutside(event) {
    if (songLayoutEl && !songLayoutEl.contains(event.target)) songLayoutOpen(false);
  }

  function songLayoutOnKey(event) {
    if (event.key !== "Escape") return;
    songLayoutOpen(false);
    if (songLayoutBtn) songLayoutBtn.focus();
  }

  function songLayoutOpen(on) {
    if (!songLayoutEl || !songLayoutMenu || !songLayoutBtn) return;
    on = on === true;
    songLayoutMenu.hidden = !on;
    songLayoutBtn.setAttribute("aria-expanded", on ? "true" : "false");
    songLayoutEl.classList.toggle("open", on);
    // Document-level listeners exist only while the menu is open, so the page
    // pays nothing for a control most people open once.
    document.removeEventListener("pointerdown", songLayoutOutside, true);
    document.removeEventListener("keydown", songLayoutOnKey, true);
    if (!on) return;
    document.addEventListener("pointerdown", songLayoutOutside, true);
    document.addEventListener("keydown", songLayoutOnKey, true);
    const current = songLayoutMenu.querySelector('[aria-checked="true"]') ||
      songLayoutMenu.querySelector("[data-layout]");
    if (current && current.focus) current.focus();
  }

  /* ---- motion -------------------------------------------------------------
     A layout change is a hard cut in CSS: a panel goes `display: none`, the
     other takes its place, and `order` swaps instantly — none of those can be
     transitioned. So the transition is split in two beats, and each half is a
     property that CAN be:

       1. the panel that is leaving DISSOLVES first (opacity + blur) while the
          layout is still the old one, so the thing being removed never moves;
       2. the layout is applied, then whatever is visible SHARPENS into place
          from a little blurred + dimmed, which covers the geometry jump.

     A swap where both panels stay (default <-> lyrics-left) has nothing to
     dissolve: the same two panels change places, so they SLIDE past each other
     instead (a FLIP in songLayoutSlideIntoPlace). Nothing fades there — nothing
     is appearing or disappearing. */
  const SONG_LAYOUT_DISSOLVE_MS = 300;
  const SONG_LAYOUT_REBUILD_MS = 220;
  const SONG_LAYOUT_SLIDE_MS = 420;
  const SONG_LAYOUT_ENTER_MS = 520;
  const SONG_LAYOUT_MOTION_CLASSES = [
    "ym-song-panel-dissolve",
    "ym-song-panel-settle",
    "ym-song-panel-enter",
    "ym-song-panel-swap",
  ];

  let songLayoutSwapTimer = 0;
  let songLayoutReleaseFrame = 0;
  let songLayoutEnterTimer = 0;

  function songLayoutPanels() {
    const content = $("ytmusic-player-page > .content") || $("#player-page > .content");
    if (!content) return null;
    return {
      main: content.querySelector(":scope > #main-panel"),
      side: content.querySelector(":scope > #side-panel"),
    };
  }

  function songLayoutVisible(panel) {
    return !!panel && getComputedStyle(panel).display !== "none";
  }

  // Cancels an in-flight transition and strips its classes, so a second pick
  // can never inherit half a dissolve or a stale offset.
  function songLayoutStopMotion() {
    if (songLayoutSwapTimer) {
      clearTimeout(songLayoutSwapTimer);
      songLayoutSwapTimer = 0;
    }
    if (songLayoutReleaseFrame && window.cancelAnimationFrame) {
      window.cancelAnimationFrame(songLayoutReleaseFrame);
    }
    songLayoutReleaseFrame = 0;
    if (songLayoutEnterTimer) {
      clearTimeout(songLayoutEnterTimer);
      songLayoutEnterTimer = 0;
    }
    const panels = songLayoutPanels();
    if (!panels) return;
    for (const panel of [panels.main, panels.side]) {
      if (!panel) continue;
      panel.classList.remove(...SONG_LAYOUT_MOTION_CLASSES);
      panel.style.removeProperty("transform");
    }
  }

  /* The mirror swap (default <-> lyrics-left) has nothing to dissolve — the
     same two panels change places. `order` cannot be transitioned, so this is
     a FLIP: the layout is applied, each panel is offset back to where it just
     was with a transform, and the transform is released so the stylesheet's
     transition carries it home. Both slide at once, in opposite directions. */
  function songLayoutSlideIntoPlace(moves) {
    const sliding = [];
    for (const move of moves) {
      if (!move.panel) continue;
      const dx = Math.round(move.from.left - move.panel.getBoundingClientRect().left);
      if (Math.abs(dx) < 1) continue;
      move.panel.style.transform = "translateX(" + dx + "px)";
      sliding.push(move.panel);
    }
    if (!sliding.length) return;
    // One layout read so the offset is the position that paints.
    void sliding[0].offsetWidth;
    for (const panel of sliding) panel.classList.add("ym-song-panel-swap");
    const settle = () => {
      for (const panel of sliding) panel.style.removeProperty("transform");
    };
    const cleanup = () => {
      for (const panel of sliding) {
        panel.classList.remove("ym-song-panel-swap");
        panel.style.removeProperty("transform");
      }
    };
    if (window.requestAnimationFrame) {
      songLayoutReleaseFrame = window.requestAnimationFrame(() => {
        songLayoutReleaseFrame = window.requestAnimationFrame(settle);
      });
    } else {
      window.setTimeout(settle, 16);
    }
    // The class holds the transition; it outlives the motion (and is the
    // deadline if the tab never produces frames).
    window.setTimeout(cleanup, SONG_LAYOUT_SLIDE_MS + 280);
  }

  // Adds the start state, lets the browser paint it once, then removes it so
  // the base transition carries both panels to their real look. Without the
  // two frames the class is added and removed inside one style recalc and the
  // transition never runs.
  function songLayoutReleaseMotion(panels, className) {
    const list = panels.filter((panel) => panel && songLayoutVisible(panel));
    if (!list.length) return;
    for (const panel of list) panel.classList.add(className);
    const release = () => {
      songLayoutReleaseFrame = 0;
      for (const panel of list) panel.classList.remove(className);
    };
    if (window.requestAnimationFrame) {
      songLayoutReleaseFrame = window.requestAnimationFrame(() => {
        songLayoutReleaseFrame = window.requestAnimationFrame(release);
      });
    } else {
      window.setTimeout(release, 16);
    }
    // A hidden or throttled tab can go a long time without a frame, and these
    // classes hold a half-faded panel on screen — so the release also has a
    // deadline. Removing a class that is already gone is a no-op.
    window.setTimeout(release, 700);
  }

  /* A panel that was `display: none` has no previous rendered style, and a
     transition between "not rendered" and "rendered" is exactly the case
     browsers skip — which is why a panel arriving from "cover art only" used to
     snap in with no fade. A keyframe ANIMATION starts on the first frame the
     element is rendered, so the arrival is a real animation, not a transition. */
  function songLayoutPlayEnter(panels) {
    const list = panels.filter((panel) => panel && songLayoutVisible(panel));
    if (!list.length) return;
    for (const panel of list) {
      panel.classList.remove("ym-song-panel-enter");
      // Reflow so a repeat play of the same class restarts instead of being a no-op.
      void panel.offsetWidth;
      panel.classList.add("ym-song-panel-enter");
    }
    if (songLayoutEnterTimer) clearTimeout(songLayoutEnterTimer);
    songLayoutEnterTimer = window.setTimeout(() => {
      songLayoutEnterTimer = 0;
      for (const panel of list) panel.classList.remove("ym-song-panel-enter");
    }, SONG_LAYOUT_ENTER_MS);
  }

  function songLayoutSet(id) {
    const next = songLayoutNormalized(id);
    const reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const panels = songLayoutPanels();
    if (ytPrefs.songLayout === next && !songLayoutSwapTimer) {
      syncSongLayoutPicker();
      return;
    }
    songLayoutStopMotion();
    // The pill answers the click immediately; the page follows, and on the
    // animated path it follows once the outgoing panel has dissolved.
    ytPrefs.songLayout = next;
    syncSongLayoutPicker();

    const commit = () => {
      songLayoutSwapTimer = 0;
      applyYtPrefs();
      saveYtPrefs();
      syncSongLayoutPicker();
    };

    if (!panels || !panels.main || !panels.side || reduced) {
      commit();
      return;
    }

    const before = { main: songLayoutVisible(panels.main), side: songLayoutVisible(panels.side) };
    // What the next layout shows. "lyrics only" keeps the tab column and drops
    // the cover; "cover art only" is the mirror of that; the other two show both.
    const after = { main: next !== "lyrics", side: next !== "art" };
    const leaving = [];
    const arriving = [];
    const moved = [];
    for (const key of ["main", "side"]) {
      if (before[key] && !after[key]) leaving.push(panels[key]);
      else if (!before[key] && after[key]) arriving.push(panels[key]);
      else if (before[key] && after[key]) moved.push(panels[key]);
    }

    if (leaving.length) {
      // One beat: the panel that is going dissolves in the layout it still
      // belongs to, so it never has to move anywhere first.
      for (const panel of leaving) panel.classList.add("ym-song-panel-dissolve");
      songLayoutSwapTimer = window.setTimeout(() => {
        commit();
        for (const panel of leaving) panel.classList.remove("ym-song-panel-dissolve");
        // The survivor only changed geometry (a column that widens, a column
        // that slides over): it sharpens back rather than sliding, because a
        // width cannot be transitioned. A panel that was hidden ARRIVES.
        songLayoutReleaseMotion(moved, "ym-song-panel-settle");
        songLayoutPlayEnter(arriving);
      }, SONG_LAYOUT_DISSOLVE_MS);
      return;
    }

    if (arriving.length) {
      // Nothing leaves, but the arrangement changes shape (one panel has to
      // appear and the other grows or shrinks by hundreds of pixels). The
      // survivors dip for a beat, the layout swaps while they are soft, and
      // the new panel animates in — the alternative is a hard width jump.
      for (const panel of moved) panel.classList.add("ym-song-panel-settle");
      songLayoutSwapTimer = window.setTimeout(() => {
        commit();
        for (const panel of moved) panel.classList.remove("ym-song-panel-settle");
        songLayoutPlayEnter(arriving);
      }, SONG_LAYOUT_REBUILD_MS);
      return;
    }

    // Both panels stay and only change places: nothing fades, they slide.
    const beforeRects = {
      main: panels.main.getBoundingClientRect(),
      side: panels.side.getBoundingClientRect(),
    };
    commit();
    songLayoutSlideIntoPlace(moved.map((panel) => ({
      panel,
      from: beforeRects[panel === panels.main ? "main" : "side"],
    })));
  }

  /* The pill belongs to the tab strip, so it sits at that strip's right edge
     rather than the page's. In "lyrics only" the column is narrower than the
     page and centred — a page-anchored pill would float hundreds of pixels away
     from the tabs it opens. With no strip on screen ("cover art only") the
     stylesheet's page-padding default is the fallback, which is where the pill
     already sits in the two-column layouts. */
  function syncSongLayoutAnchor() {
    if (!songLayoutEl) return;
    const page = songLayoutEl.parentElement;
    const strip = $("ytmusic-player-page #side-panel > tp-yt-paper-tabs");
    if (!page || !strip || !strip.offsetWidth) {
      songLayoutEl.style.removeProperty("right");
      return;
    }
    const pageBox = page.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    songLayoutEl.style.right = Math.max(0, Math.round(pageBox.right - stripBox.right)) + "px";
  }

  function syncSongLayoutPicker() {
    if (!songLayoutEl) return;
    const active = songLayoutNormalized(ytPrefs.songLayout);
    const entry = SONG_LAYOUTS.find((layout) => layout.id === active) || SONG_LAYOUTS[0];
    const name = songLayoutBtn.querySelector(".ym-song-layout-name");
    if (name) name.textContent = entry.label;
    const slot = songLayoutBtn.querySelector(".ym-song-layout-glyph-slot");
    if (slot) {
      slot.textContent = "";
      slot.appendChild(songLayoutGlyph(active));
    }
    for (const item of Array.from(songLayoutMenu.querySelectorAll("[data-layout]"))) {
      item.setAttribute("aria-checked", item.getAttribute("data-layout") === active ? "true" : "false");
    }
    songLayoutBtn.setAttribute("aria-label", "Song view layout: " + entry.label);
    syncSongLayoutAnchor();
  }

  function buildSongLayoutPicker() {
    songLayoutBtn = h("button", {
      class: "ym-song-layout-btn",
      type: "button",
      "aria-haspopup": "true",
      "aria-expanded": "false",
      title: "Song view layout",
    });
    songLayoutBtn.appendChild(h("span", { class: "ym-song-layout-glyph-slot" }));
    songLayoutBtn.appendChild(h("span", { class: "ym-song-layout-name" }));
    const chevron = svgIcon(ICON_CHEVRON);
    chevron.setAttribute("class", "ym-song-layout-chev");
    songLayoutBtn.appendChild(chevron);

    songLayoutMenu = h("div", { class: "ym-song-layout-menu", role: "menu", hidden: "" });
    for (const layout of SONG_LAYOUTS) {
      const item = h("button", {
        class: "ym-song-layout-item",
        type: "button",
        role: "menuitemradio",
        "aria-checked": "false",
        "data-layout": layout.id,
      });
      item.appendChild(songLayoutGlyph(layout.id));
      item.appendChild(h("span", { class: "ym-song-layout-text" },
        h("span", { class: "ym-song-layout-item-label", text: layout.label }),
        h("span", { class: "ym-song-layout-item-hint", text: layout.hint })
      ));
      item.addEventListener("click", () => {
        songLayoutSet(layout.id);
        songLayoutOpen(false);
        if (songLayoutBtn) songLayoutBtn.focus();
      });
      songLayoutMenu.appendChild(item);
    }

    songLayoutEl = h("div", { class: "ym-song-layout" }, songLayoutBtn, songLayoutMenu);
    songLayoutBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      songLayoutOpen(songLayoutMenu.hidden);
    });
    return songLayoutEl;
  }

  // Mounted on every player-page rebuild, and cheap when it is already there:
  // a connected parent element short-circuits before touching the DOM.
  function ensureSongLayoutPicker() {
    if (!isWatchPage()) return;
    const page = $("#player-page") || $("ytmusic-player-page");
    if (!page) return;
    if (!songLayoutEl) {
      buildSongLayoutPicker();
      syncSongLayoutPicker();
    }
    if (songLayoutEl.parentElement !== page) page.appendChild(songLayoutEl);
    // The strip moves when the layout does (and on resize), so the anchor is
    // re-measured here as well as on a pick.
    syncSongLayoutAnchor();
  }

  function initSongLayoutPicker() {
    ensureSongLayoutPicker();
    const root = $("ytmusic-player-page") || document.body;
    let raf = 0;
    new MutationObserver(() => {
      if (raf) return;
      raf = window.setTimeout(() => {
        raf = 0;
        ensureSongLayoutPicker();
      }, 250);
    }).observe(root, { childList: true, subtree: true });
    window.addEventListener("resize", ensureSongLayoutPicker);
    document.addEventListener("yt-navigate-finish", () => {
      ensureSongLayoutPicker();
      syncSongLayoutPicker();
    });
    console.log("[Aurora Lyrics] song-view layout switcher active");
  }

  /* ---- boot ---- */
  /* ---- current artwork as a custom property -------------------------------
     A theme cannot read an <img> src from CSS, so the cover URL is published as
     --ym-art on the root element and a theme turns it into a backdrop:
         background-image: var(--ym-art)
     Written only when the URL actually changes, so this costs one string
     comparison per observed mutation and nothing at all while the track holds.
     Aurora Bloom paints its own canvas backdrop and ignores it, so the property
     is inert until a theme asks for it. */
  let publishedArtUrl = "";
  function publishArtUrl() {
    const img =
      document.querySelector("ytmusic-miniplayer img.ytmusicTrackInfoThumbnail") ||
      document.querySelector("ytmusic-miniplayer img") ||
      document.querySelector("ytmusic-player-bar img.image") ||
      document.querySelector("ytmusic-player-bar img") ||
      document.querySelector("ytmusic-player-page #song-image img") ||
      document.querySelector("#song-image img") ||
      document.querySelector("ytmusic-player-page img");
    const src = (img && (img.currentSrc || img.src)) || "";
    if (!src || src === publishedArtUrl) return;
    publishedArtUrl = src;
    document.documentElement.style.setProperty("--ym-art", 'url("' + src + '")');
  }

  /* ---- start with the guide collapsed -------------------------------------
     YouTube Music restores its own guide preference on load, and an expanded
     guide is 240px of Home/Explore eating the page for the whole session. When
     the EXPANDED guide is what rendered, click YTM's own toggle instead of
     hiding nodes: the click runs through the component, so its internal model,
     the page offsets and the button's aria-expanded stay in agreement, and the
     animation still plays.

     This runs ONCE per page load and stops as soon as the state is right, so
     expanding the guide by hand later in the session is respected. Polling is
     needed because the guide renders after the player does; 12 tries is about
     five seconds, after which the layout is settled either way. */
  function startGuideCollapsed() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const expanded = document.querySelector("#guide-wrapper");
      const mini = document.querySelector("#mini-guide");
      const isExpanded =
        expanded &&
        expanded.offsetWidth > 100 &&
        getComputedStyle(expanded).visibility !== "hidden";
      if (isExpanded) {
        const button =
          document.querySelector("ytmusic-nav-bar #guide-button") ||
          document.querySelector("#guide-button");
        if (button && typeof button.click === "function") {
          button.click();
          clearInterval(timer);
          console.debug("[YTMod] guide collapsed on load");
          return;
        }
      } else if (mini && mini.offsetWidth > 0) {
        clearInterval(timer); // already collapsed, nothing to do
        return;
      }
      if (tries >= 12) clearInterval(timer);
    }, 400);
  }
  async function boot() {
    injectPublicAPI(); // expose window.YTMod (page world) before any JS extension loads
    // Keep --ym-art current. The src swap fires on the existing node for most
    // track changes, but YTM replaces the node itself on some navigations, so
    // both childList and src attributes are observed.
    try {
      const artObserver = new MutationObserver(publishArtUrl);
      artObserver.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src"],
      });
    } catch (_) {}
    publishArtUrl();
    startGuideCollapsed();
    // The stored value can still turn them off; this early start is only so the
    // default (on) paints without waiting for storage (AJ, 2026-10-23).
    if (ytPrefs.customIcons) ytStartPlayerIcons();
    const reg = await getReg();
    let registryChanged = false;
    for (const removedId of ["ytmod-rose", "ytmod-compact"]) {
      if (reg[removedId]) {
        delete reg[removedId];
        registryChanged = true;
      }
    }
    // Generic sweep for every OTHER row the catalog no longer knows. Deleting an
    // add-on from AVAILABLE (as the discord-presence attempt was) leaves its
    // installed record behind: applyExtension() bails on an unknown id so nothing
    // loads, the marketplace has no card to uninstall it from, and every count
    // (home "installed", the popup's add-on line) keeps including a phantom that
    // shows up as a bare id. Its settings and background go with it, exactly as a
    // real uninstall would (AJ, 2026-10-21).
    for (const id of Object.keys(reg)) {
      if (findAvail(id)) continue;
      delete reg[id];
      registryChanged = true;
      try { await removeExtensionSettings(id); } catch (_) {}
      try { await bgDel(id); } catch (_) {}
      console.debug("[YTMod] dropped orphaned add-on record:", id);
    }
    // First-run seeding: the core add-ons install and enable themselves on a
    // fresh profile, so a new user gets the full experience without opening the
    // Marketplace. Lyrics and the Bloom backdrop were the two it shipped with;
    // Aurora Flow and Centered home joined them on 2026-10-26 — they are the
    // motion and the home layout the rest of the defaults assume. Runs once per
    // browser profile (ytmod_defaults_seeded flag); afterwards the user's own
    // install/uninstall choices are always respected.
    const defaultsSeeded = await new Promise((res) =>
      chrome.storage.local.get("ytmod_defaults_seeded", (r) => res(!!r["ytmod_defaults_seeded"]))
    );
    if (!defaultsSeeded) {
      for (const id of [
        "ytmod-spicy-lyrics",
        "ytmod-dynamic",
        "ytmod-smooth-motion",
        "snippet-centered-home",
      ]) {
        if (!reg[id]) {
          const ext = findAvail(id);
          reg[id] = { enabled: true, version: (ext && ext.version) || "?", installedAt: Date.now() };
          registryChanged = true;
        }
      }
      await new Promise((res) => chrome.storage.local.set({ ytmod_defaults_seeded: true }, res));
    }
    if (registryChanged) await setReg(reg);
    // BEFORE the add-ons mount: a Low mode that suspends one of them must not
    // start it first and tear it down a tick later. Same read the Settings page
    // uses, and it is memoised, so this costs nothing.
    await applyPerformanceRestrictions(await loadPerformanceMode());
    // Re-read: the governor writes the registry when it switches an add-on off,
    // and mounting from the pre-governor copy would start it anyway.
    const bootReg = await getReg();
    for (const id in bootReg) if (bootReg[id].enabled) applyExtension(id, true);
    // view / density / floating are PINNED (toolbar removed, AJ 2026-09-28) and
    // the card is CENTRED: the old dragged position is deliberately NOT restored,
    // so an accidental header drag (e.g. tapping the title 6× for dev mode) can't
    // leave the panel stranded in a corner across reloads.
    const savedUI = await getUI();
    // Before buildMarketplace(), so the Settings page never paints a stale mode.
    await loadPerformanceMode();
    // Deliberately an explicit `=== true`: an absent or junk key means off, and
    // nothing but the 6-tap gesture is allowed to turn this on.
    if (savedUI.dev === true) ui.dev = true;
    // Applied to <html> before the panel exists, because the YouTube page's two
    // settings are page-wide and must be right on the FIRST paint (the panel can
    // stay closed for the whole session).
    await loadYtPrefs();
    buildMarketplace();

    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (mountNavButton() || tries > 60) clearInterval(iv);
    }, 300);

    // Fire-and-forget: never block the marketplace on a network round trip.
    runUpdateCheck();

    // Always-on personalisation: reopen the watch-page tab you last used.
    initRememberLastWatchTab();
    // Always-on, too: the layout of the player page, from a pill beside the tabs.
    initSongLayoutPicker();

    console.log("[Aurora Lyrics] booted v" + (runningVersion() || "unknown"));
  }

  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(boot, 600);
  else window.addEventListener("load", () => setTimeout(boot, 600));
})();
