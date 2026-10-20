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
    window.postMessage({ type: "ytmod-settings", id, settings }, "*");
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
  // The /v1/lyrics endpoint is rate-limited and the upstream extension caches
  // its results for 3 days (SpicyLyrics_LyricsStore_g1 -> Unit "Days",
  // Duration 3 in fetchLyrics.ts). We honour the same window, expiring every
  // entry well inside the API's acceptable retention. Stored as one object so
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
  // ---- animated-cover-art cache (m8tec m3u8 URL per track key) --------------
  // Same bridge pattern as the lyrics cache: one object, a per-entry `exp`, swept
  // lazily on read. The track -> m3u8 mapping is stable, so a 30-day window is
  // safe, and a persisted hit means the fullscreen cover appears with NO network
  // round-trip (AJ, 2026-10-03).
  const ART_CACHE_KEY = "ytmod_art_cache";
  const getArtCache = () => new Promise((res) => {
    chrome.storage.local.get(ART_CACHE_KEY, (r) => {
      const saved = r[ART_CACHE_KEY];
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        console.debug(`[YTMod] Art cache loaded: ${Object.keys(saved).length} entries.`);
        res(saved);
      } else {
        res({});
      }
    });
  });
  const setArtCache = (cache) => new Promise((res) => {
    const count = cache && typeof cache === "object" ? Object.keys(cache).length : 0;
    chrome.storage.local.set({ [ART_CACHE_KEY]: cache }, () => {
      if (chrome.runtime.lastError) {
        console.warn(`[YTMod] Art cache write FAILED (${count} entries):`, chrome.runtime.lastError.message);
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
  const UNISON_ORIGIN = "https://unison.boidu.dev";
  const UNISON_PATHS = new Set(["/lyrics"]);
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
  const fetchUnison = async (rawUrl) => {
    const url = new URL(String(rawUrl || ""));
    if (url.origin !== UNISON_ORIGIN || !UNISON_PATHS.has(url.pathname)) {
      throw new Error("Unsupported Unison endpoint.");
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
  const fetchMusicBrainzRecordingSearch = async (title, artist, album, durationMs) => {
    const recording = quoteMusicBrainz(title);
    const creditedArtist = quoteMusicBrainz(artist);
    if (!recording) return { ok: false, status: 400, data: null };
    const terms = [`recording:\"${recording}\"`];
    if (creditedArtist) terms.push(`artist:\"${creditedArtist}\"`);
    if (album) terms.push(`release:\"${quoteMusicBrainz(album)}\"`);
    if (Number.isFinite(Number(durationMs)) && Number(durationMs) > 0) {
      // MusicBrainz's `dur` field is milliseconds. Keep this as a scoring hint;
      // the title/artist query remains useful when the duration is rounded.
      terms.push(`dur:${Math.max(0, Math.round(Number(durationMs) - 5000))}..${Math.round(Number(durationMs) + 5000)}`);
    }
    const url = new URL("/ws/2/recording/", MUSICBRAINZ_ORIGIN);
    url.search = new URLSearchParams({
      query: terms.join(" AND "),
      fmt: "json",
      inc: "url-rels",
      limit: "10",
    }).toString();
    await waitForMusicBrainz();
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

  /* Deezer track search, used to obtain an ISRC for lrc.red.
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
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return s;
  }

  /* ---- available catalog (later: fetch from a GitHub-hosted marketplace.json) ----
     Entry shape: { id, name, author, category, stars, tags, description, version,
                    lastUpdated, css?, jsUrl?, comingSoon?, github? }
     github: string URL, OR string[] of URLs, OR {label,url}[] — shown in the detail view.
     categories: Extensions | Themes */
  const CAT_COLOR = { Extensions: "#1DB954", Themes: "#448aff" };

  const AVAILABLE = [
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
      // Per-add-on showcase art (AJ, 2026-09-28). Paths are extension-relative and
      // resolved with chrome.runtime.getURL() at render time.
      art: { video: "assets/art/aurora-bloom.mp4", poster: "assets/art/aurora-bloom.jpg" },
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
      ],
    },
    {
      id: "ytmod-artwork-accent",
      name: "Ambient",
      author: "Aurora Lyrics",
      category: "Themes",
      stars: 5,
      tags: ["artwork", "accent", "dynamic", "theme"],
      description: "Adds a soft glow around the now-playing artwork and tints the player controls to match.",
      version: "1.0.2",
      lastUpdated: "2026-09-28",
      jsUrl: chrome.runtime.getURL("src/extensions/artwork-accent.js"),
      art: { video: "assets/art/ambient.mp4", poster: "assets/art/ambient.jpg" },
      // Glow slider removed from the UI on AJ's call (2026-09-28). The add-on
      // still ships a glow value internally — DEFAULT_SETTINGS.glow = 1.5
      // (150%) — so new installs land on a strong glow without exposing the
      // control. Existing users keep whatever glow they had stored.
      settings: [],
    },
    {
      id: "ytmod-spicy-lyrics",
      name: "Aurora Lyrics",
      author: "Aurora Lyrics",
      category: "Extensions",
      stars: 5,
      tags: ["lyrics", "synced", "karaoke", "ttml"],
      // Terms of Service s5: naming the upstream as a dependency is allowed
      // ("uses or is built on Spicy Lyrics is fine"), but the listing must NOT
      // read as Spicy Lyrics' own product. Hence the plain "Unofficial." and a
      // github link to THIS project rather than to Spikerko's repo, which would
      // imply origin/endorsement.
      // Rewritten in plain language (AJ, 2026-10-19): no renderer/API jargon.
      description: "Unofficial. Shows the lyrics of whatever you're playing, in time with the music — the words light up as they're sung. You can make the text bigger, change how it looks, and open a full-screen lyric view.",
      disclaimer: "Not affiliated with Spicy Lyrics · Unofficial",
      version: "0.2.0",
      lastUpdated: "2026-10-07",
      github: "https://github.com/xyrodriv/Aurora-Lyrics-",
      jsUrl: chrome.runtime.getURL("src/extensions/aurora-lyrics.js"),
      art: { video: "assets/art/aurora-lyrics.mp4", poster: "assets/art/aurora-lyrics.jpg" },
      settings: [
        // Order is the reading order of the page. Everything WITHOUT `dev: true`
        // shows to everyone; everything with it is hidden until the 6-tap gesture
        // has been used — see visibleSettings(). Keep the non-dev entries first.
        // Lyric size ceiling is 600%. Default back to 130% (AJ, 2026-10-07) —
          // 145% (2026-09-28) read too big; 130% is the intended look.
        { key: "size", label: "Lyric size", min: 0.75, max: 6.0, step: 0.05, default: 1.30, display: "percent" },
        { key: "romanizationEnabled", label: "Romanization (JP / KR)", type: "toggle", default: true },
        { key: "legibilityBackdrop", label: "Dark shade behind lyrics", type: "toggle", default: false },
        // Extends the adaptive lyric readability shade (which Video Background
        // already uses) to the SIDE layout for music videos, where the lyrics
        // sit over the blurred video backdrop. AJ, 2026-09-28.
        { key: "mvLyricsShade", label: "Shade lyrics over bright music video", type: "toggle", default: true },
        // Animated Apple Music cover art (m8tec HLS): swaps the cover for a looping
        // clip in the player view and in fullscreen. Network-backed, so it gets a
        // switch — and it defaults OFF (AJ, 2026-10-07): it is an opt-in extra,
        // not something to turn on for every install unasked.
        { key: "animatedArt", label: "Animated cover art", type: "toggle", default: false },
        // Apple-Music-style MOTION only (AJ, 2026-10-01): no bounce, no zoom, no
        // glow — the line just glides up smoothly. The gradient sweep is UNCHANGED
        // from normal mode; an earlier attempt redirected it at a registered
        // custom property and broke the active-line highlight, so the mode is now
        // strictly the spring/spline swap.
        { key: "simpleLyrics", label: "Apple Music style lyrics", type: "toggle", default: false },
        // Joins each word into one whole-word fill — no per-syllable/letter karaoke
        // stepping, so a word lights up as a single unit. The Spicy Lyrics
        // "whole word" toggle (AJ, 2026-10-19).
        { key: "joinSyllables", label: "Join syllables into words", type: "toggle", default: false },
        // lrc.red's TTML often ships one span per syllable ("shi"+"ning"). This
        // merges those runs at parse time so the fill/glow covers the whole word.
        // Separate from the global whole-word renderer toggle above (AJ, 2026-10-20).
        { key: "joinLrcRedSyllables", label: "Join lrc.red syllables into words", type: "toggle", default: true },
        { type: "header", label: "Scrolling" },
        // smoothScrolling back ON by default (AJ, 2026-10-07) — he prefers the
        // eased glide into the active line. `disabledWhen` dims + locks the row
        // while simpleLyrics is ON, because simple mode forces its own spring
        // scroll and ignores this setting entirely (AJ, 2026-10-02).
        { key: "smoothScrolling", label: "Smooth scrolling", type: "toggle", default: true, disabledWhen: "simpleLyrics" },
        { key: "scrollLeadEnabled", label: "Start scrolling early", type: "toggle", default: false },
        { key: "scrollLeadMs", label: "Early scroll lead", min: 0, max: 800, step: 10, default: 250, display: "milliseconds" },
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
        // when it has the track, lrc.red next for new releases, Unison/LRCLIB as
        // fallbacks — so there is no user-facing reordering.
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
      art: { image: "assets/art/sleep-timer.png" }, // still only — no video for this one
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
      id: "ytmod-share-lyric",
      name: "Share a Lyric",
      author: "Aurora Lyrics",
      category: "Extensions",
      stars: 5,
      tags: ["lyrics", "share", "image", "export", "png"],
      description: "Turns the line you are on into a square image you can post anywhere - the lyric, the artwork and the track, drawn on your own machine. Nothing is uploaded.",
      version: "1.0.0",
      lastUpdated: "2026-09-28",
      jsUrl: chrome.runtime.getURL("src/extensions/share-lyric.js"),
      // Showcase clip, recorded by the add-on itself (3:4, Kawarp backdrop). The
      // poster is optional: without it the sheet falls back to the card's thumb
      // and the grid to the category gradient.
      art: { video: "assets/art/share-lyric.mp4" },
      settings: [
        { key: "showArt", label: "Show the artwork on the card", type: "toggle", default: true },
        { key: "showTrackInfo", label: "Show the track name and artist", type: "toggle", default: true },
        { key: "showTimestamp", label: "Show the lyric timestamp on the card", type: "toggle", default: true },
        // These two are driven by the toggles in the share preview popup, not by
        // the settings list. `dev: true` keeps them out of the visible list while
        // leaving them IN the schema — which is what makes them persist and be
        // delivered, since content.js only sends keys it declares here.
        { key: "portrait", label: "3:4 portrait card", type: "toggle", default: false, dev: true },
        { key: "video", label: "4-second video export", type: "toggle", default: false, dev: true },
      ],
    },
    {
      id: "ytmod-next-up",
      name: "Next Up",
      author: "Aurora Lyrics",
      category: "Extensions",
      stars: 5,
      tags: ["queue", "next", "up-next", "pill", "playback"],
      description: "Shows what is playing next in a small pill beside the artwork, so you can see it without opening the queue. Click the pill to skip straight to that track.",
      version: "1.0.0",
      lastUpdated: "2026-09-28",
      jsUrl: chrome.runtime.getURL("src/extensions/next-up.js"),
      // Still-only art: the 3:4 card exported from the preview page
      // (DEVELOPERS/previews/next-up.html, --layout player).
      art: { image: "assets/art/next-up.png" },
      settings: [
        { key: "showArt", label: "Show the cover art in the pill", type: "toggle", default: true },
        { key: "alignRight", label: "Put the pill on the right instead of the left", type: "toggle", default: false },
        // Off by default: it repaints every frame while the pill is visible.
        { key: "smoothGlow", label: "Smooth glow (60fps)", type: "toggle", default: false },
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
      // Still-only art (like Sleep Timer): the 3:4 Kawarp card exported from the
      // preview page. Paths are extension-relative and assets/art/* is already
      // covered by web_accessible_resources.
      art: { image: "assets/art/song-notes.png" },
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
      id: "snippet-copy-lyrics",
      name: "Copy lyrics",
      author: "Aurora Lyrics",
      category: "Snippets",
      stars: 5,
      tags: ["lyrics", "copy", "clipboard"],
      description: "Adds a Copy lyrics button that puts the whole song on your clipboard in one click.",
      version: "0.1.0",
      lastUpdated: "2026-10-08",
      jsUrl: chrome.runtime.getURL("src/extensions/snippet-copy-lyrics.js"),
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
  ];
  const findAvail = (id) => AVAILABLE.find((a) => a.id === id);

  /* ---- applied-style cache (for disable/uninstall) ----
     An extension may ship CSS (injected via injectCSS) and/or JS (a page-world
     script loaded from jsUrl / inline js, so it can use window.YTMod). Both are
     tracked separately and torn down on disable. */
  const applied = {};
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
      if ((ext.jsUrl || ext.js) && !applied[id + "_js"]) {
        applied[id + "_js"] = loadExtensionJS(ext);
        window.postMessage({ type: "ytmod-ext", id, action: "enable" }, "*");
      }
    } else {
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
  const REPORT_DISCORD_URL = "https://example.com"; // TODO: real invite (AJ will supply)
  function reportIssuesFor(ext) {
    const byId = {
      "ytmod-spicy-lyrics": ["Lyrics not showing", "Romanization", "Fullscreen", "Lyric sources", "Other"],
      "ytmod-smooth-motion": ["Animations look wrong", "Panel / corner motion", "Performance / lag", "Buttons / controls", "Other"],
      "ytmod-artwork-accent": ["Ambient glow / accent color", "Colors", "Performance", "Other"],
      "ytmod-dynamic": ["Cover art animation", "Video background / backdrop", "Gallery dimming", "Performance", "Other"],
      "ytmod-sleep-timer": ["Timer never fires", "Fade / volume", "Pause behaviour", "Other"],
      "ytmod-pip-lyrics": ["Picture-in-picture window", "Lyrics inside PiP", "Controls", "Other"],
      "ytmod-share-lyric": ["Sharing", "Exported image", "Other"],
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
    const renderOptions = (issues) => {
      options.replaceChildren();
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
          class: "ym-report-option", type: "button", role: "radio", "aria-checked": "false", "data-value": label,
        }, h("span", { class: "ym-report-option-label", text: label }), circle);
        row.addEventListener("click", () => {
          rows.forEach((r) => { r.classList.remove("selected"); r.setAttribute("aria-checked", "false"); });
          row.classList.add("selected");
          row.setAttribute("aria-checked", "true");
          send.disabled = false;
          if (label === "Other") {
            otherWrap.classList.remove("hidden");
            if (!reducedMotion() && otherWrap.animate) {
              otherWrap.animate(
                [{ opacity: 0, height: "0px" }, { opacity: 1, height: otherWrap.scrollHeight + "px" }],
                { duration: 320, easing: "cubic-bezier(.22,1,.36,1)" }
              );
            }
            otherInput.focus();
          } else {
            otherWrap.classList.add("hidden");
          }
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
        // A change can flip another row's disabledWhen condition (e.g. toggling
        // Simple Lyrics locks Smooth Scrolling), so re-sync every row.
        controls.forEach((entry) => { if (entry.syncDisabled) entry.syncDisabled(); });
      };
      input.addEventListener(isToggle ? "change" : "input", updateSetting);
      syncRangeFill();
      const row = h("div", { class: "ym-detail-setting-row" },
        h("div", { class: "ym-detail-setting-label", text: setting.label }),
        h("div", { class: "ym-detail-setting-control" }, input, valueEl)
      );
      // `disabledWhen`: dim + lock this row while the named setting is truthy
      // (used by Smooth Scrolling, which Simple Lyrics overrides). Inline styles
      // keep it self-contained -- there is no conditional-row CSS to extend.
      const syncDisabled = () => {
        const blocked = !!(setting.disabledWhen && values[setting.disabledWhen]);
        row.style.opacity = blocked ? "0.45" : "";
        row.style.pointerEvents = blocked ? "none" : "";
        row.title = blocked ? "Apple Music style lyrics overrides this setting" : "";
      };
      syncDisabled();
      controls.set(setting.key, { input, valueEl, setting, syncRangeFill, syncDisabled });
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
  const VERSION = "0.5.71";
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
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      renderSection();
      return;
    }
    // Force a fresh animation when reopening quickly after a close.
    void overlay.offsetWidth;
    overlay.classList.add("ym-opening");
    marketplaceOpenTimer = window.setTimeout(() => {
      overlay.classList.remove("ym-opening");
      marketplaceOpenTimer = 0;
    }, 280);
    renderSection();
  }

  function closeMarketplace() {
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
    const reg = await getReg();
    reg[id] = { enabled: true, version: ext.version || "?", installedAt: Date.now() };
    await setReg(reg);
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
    applyExtension(id, on);
    const e = findAvail(id);
    toast((e ? e.name : id) + (on ? " enabled" : " disabled"));
    console.debug("[YTMod] extension", id, on ? "enabled" : "disabled");
  }

  async function uninstall(id) {
    const reg = await getReg();
    if (!reg[id]) return;
    const ext = findAvail(id);
    applyExtension(id, false);
    delete reg[id];
    await setReg(reg);
    await removeExtensionSettings(id);
    toast((ext ? ext.name : id) + " removed");
    renderSection(true);
    console.debug("[YTMod] uninstalled extension:", id);
  }

  // Promote registerExtension to a top-level function so the page-world bridge
  // (which performs the real chrome.storage work) can call it.
  async function registerExtension(manifest) {
    if (!findAvail(manifest.id)) AVAILABLE.push(manifest);
    return install(manifest.id);
  }

  /* ---- marketplace UI (Spicetify-style: tabs + sort + search + grid) ---- */
  let kbIndex = -1;
  function focusCard(cards) {
    if (kbIndex < 0) kbIndex = 0;
    kbIndex = Math.max(0, Math.min(kbIndex, cards.length - 1));
    cards.forEach((c, i) => c.classList.toggle("ym-kbfocus", i === kbIndex));
    const el = cards[kbIndex];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }
  // Ambient panel background (AJ, 2026-09-28): the now-playing cover, blurred and
  // dimmed, so the panel picks up the track's colour. Falls back to the logo.
  function currentTrackArt() {
    const img =
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
  async function animateTabSwitch(t) {
    const sec = $("#ym-section");
    const EASE = "cubic-bezier(0.32,0.72,0,1)";
    let out = null;
    if (sec && !reducedMotion()) {
      out = sec.animate(
        [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-8px)" }],
        { duration: 170, easing: EASE, fill: "both" });
      try { await out.finished; } catch (_) {}
    }
    ui.category = t;
    if (overlay) {
      overlay.querySelectorAll(".ym-tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === t));
    }
    moveTabThumb();
    // Keep the section at opacity 0 THROUGH the re-render, then drop the fade so
    // the new cards run their own ym-card-in stagger. Cancelling before the render
    // (the first cut) flashed the OLD list back at full opacity first.
    await renderSection();
    if (out) { try { out.cancel(); } catch (_) {} }
  }

  function marketKey(e) {
    if (!overlay || overlay.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeMarketplace();
      return;
    }
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    if (!mkRows) return;
    const cards = $$(".ym-mk-card", mkRows);
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
        getExtensionSettings(ext).then((settings) => postExtensionSettings(d.id, settings));
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
          case "getArtCache": r = await getArtCache(); break;
          case "setArtCache": await setArtCache(args[0]); r = true; break;
          case "fetchLRCLIB": r = await fetchLRCLIB(args[0]); break;
          case "fetchUnison": r = await fetchUnison(args[0]); break;
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
  const MK_PROMO = new Set([
    "ytmod-sleep-timer", "ytmod-share-lyric",
    "ytmod-next-up", "ytmod-song-notes",
  ]);

  // Plain-language "what it does / pros / cons" shown from the info button next
  // to each add-on's Settings heading. Kept short and concrete — this is the
  // text a first-time user actually reads before installing (AJ, 2026-10-19).
  const MK_INFO = {
    "ytmod-dynamic": {
      what: "Replaces the flat page background with a live, blurred version of the current artwork (or music video).",
      pros: ["Ties the whole app to the song you're playing", "Follows the video on music videos", "Adjustable brightness, saturation and warp"],
      cons: ["Uses GPU continuously while playing", "Most visible on pages with large empty areas"],
    },
    "ytmod-artwork-accent": {
      what: "Samples the cover art and tints Aurora Lyrics to match it.",
      pros: ["Every song feels themed without any setup", "Keeps lyric colours readable on dark art"],
      cons: ["Very colourful art can shift the accent mid-song", "Tint is subtle on near-monochrome covers"],
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
    "ytmod-share-lyric": {
      what: "Turns the current lyric line into a shareable image card.",
      pros: ["Clean, consistent output", "Includes artwork and track credits"],
      cons: ["Image is rendered locally, so custom fonts must be installed", "No built-in social posting"],
    },
    "ytmod-next-up": {
      what: "Shows what's playing next, with a queue preview and quick jump.",
      pros: ["See the queue without leaving the page", "One click to jump to a track"],
      cons: ["Reads YouTube's queue, so it matches YTM's own ordering", "Long queues need scrolling"],
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
    "snippet-copy-lyrics": {
      what: "Adds a button that copies the full lyric text of the current song.",
      pros: ["One click, no selection dragging", "Works with imported TTML too"],
      cons: ["Plain text only — no timestamps", "Copies the whole song, not a single line"],
    },
    "snippet-centered-home": {
      what: "Centers the home page section headers and filter chips.",
      pros: ["Calmer, more balanced home layout", "No configuration needed"],
      cons: ["Purely cosmetic", "Can look off on very wide screens"],
    },
    "snippet-npv-panel": {
      what: "A docked side rail with cover art or video, title, artist card, lyrics and the up-next queue.",
      pros: ["Keeps lyrics and queue visible while browsing", "Collapses to a thin edge", "Follows the Aurora Bloom backdrop"],
      cons: ["Takes horizontal space while open", "Feels cramped in a narrow window"],
    },
  };

  // Per-add-on glyph + tint for the rail tiles and the detail monogram.
  const MK_GLYPH = {
    "ytmod-dynamic":      { c: "#3fe0c5", d: "M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z" },
    "ytmod-artwork-accent": { c: "#6ee06f", d: "M12 4a8 8 0 100 16 8 8 0 000-16zm0 3a5 5 0 110 10 5 5 0 010-10z" },
    "ytmod-spicy-lyrics": { c: "#ff5c9e", d: "M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" },
    "ytmod-smooth-motion": { c: "#7aa2ff", d: "M3 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0v3c-2-3-4-3-6 0s-4 3-6 0-4-3-6 0z" },
    "ytmod-sleep-timer":  { c: "#9b8cff", d: "M12 3a9 9 0 108.5 12A7 7 0 1112 3z" },
    "ytmod-pip-lyrics":   { c: "#ffb454", d: "M3 5h18v14H3V5zm2 2v10h14V7H5zm6 4h6v4h-6v-4z" },
    "ytmod-share-lyric":  { c: "#ff7a59", d: "M14 3l7 7-7 7v-4c-5 0-8 2-10 5 0-6 4-9 10-9V3z" },
    "ytmod-next-up":      { c: "#4fd1c5", d: "M4 6h12v2H4V6zm0 5h12v2H4v-2zm0 5h8v2H4v-2zm14-5l4 3-4 3v-6z" },
    "ytmod-song-notes":   { c: "#f5c542", d: "M4 4h16v12H8l-4 4V4zm3 4h10v2H7V8zm0 4h7v2H7v-2z" },
    "snippet-track-toast":{ c: "#9aa7ff", d: "M12 22a2 2 0 002-2h-4a2 2 0 002 2zm7-6V11a7 7 0 10-14 0v5l-2 2v1h18v-1l-2-2z" },
    "snippet-copy-lyrics":{ c: "#7bd88f", d: "M8 3h10v14H8V3zm-2 4H4v14h10v-2H6V7z" },
    "snippet-centered-home": { c: "#a78bfa", d: "M7 5h10v2H7zM5 9h14v2H5zM8 13h8v2H8zM6 17h12v2H6z" },
    "snippet-npv-panel":  { c: "#3fe0c5", d: "M3 4h18v16H3V4zm2 2v12h4V6H5zm6 0v12h8V6h-9z" },
  };
  // "#rrggbb" + alpha byte, for the tinted tile background/border.
  const mkTint = (hex, alpha) => hex + alpha;

  // Attribution for Aurora Lyrics. Spicy ToS s6 requires naming the provider
  // on screen wherever lyrics appear.
  const MK_SOURCES = {
    "ytmod-spicy-lyrics": [
      ["Lyrics", [["Spicy Lyrics", "https://spicylyrics.org/"], ["Unison", "https://unison.boidu.dev/"], ["LRCLIB", "https://lrclib.net/"]]],
      ["Track matching", [["MusicBrainz", "https://musicbrainz.org/"], ["ListenBrainz", "https://listenbrainz.org/"]]],
    ],
  };
  const MK_LNK = {
    "Spicy Lyrics": "ym-mk-lnk-spicy",
    Unison: "ym-mk-lnk-unison",
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
    const go = () => { mkSelect(id); };
    card.addEventListener("click", go);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
    return card;
  }

  function mkBuildRows(list, reg) {
    if (!mkRows || !mkInd) return;
    mkRows.replaceChildren(mkInd);
    mkRows.appendChild(mkCard("home", "Home", "", false, true));
    let last = null;
    for (const ext of list) {
      if (ext.category !== last) {
        last = ext.category;
        mkRows.appendChild(h("div", { class: "ym-mk-cat", text: ext.category || "Add-ons" }));
      }
      mkRows.appendChild(mkCard(ext.id, ext.name, (ext.name || "?").charAt(0).toUpperCase(), !!reg[ext.id], false));
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
    const m = w.querySelector(".ym-mk-dmono") || w.querySelector(".ym-mk-mark");
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

  function mkPromoBox(ext, caption) {
    const box = h("div", { class: "ym-mk-promobox" });
    const art = ext.art || {};
    if (art.video) {
      const v = h("video", {
        class: "ym-mk-promomedia",
        src: extArtUrl(art.video),
        poster: extArtUrl(art.poster || art.image || ""),
        loop: "", autoplay: "", muted: "", playsinline: "",
        disablepictureinpicture: "",
      });
      v.muted = true;
      box.appendChild(v);
    } else if (art.image || art.poster) {
      // Still-only add-ons (Sleep Timer, Next Up, Song Notes) ship a 3:4 card.
      const still = h("div", { class: "ym-mk-promomedia ym-mk-promofallback" });
      still.style.backgroundImage = 'url("' + extArtUrl(art.image || art.poster) + '")';
      box.appendChild(still);
    } else {
      const fb = h("div", { class: "ym-mk-promomedia ym-mk-promofallback" });
      const url = mkLogoUrl();
      if (url) fb.style.backgroundImage = 'url("' + url + '")';
      box.appendChild(fb);
    }
    if (!caption) return box;
    return h("div", { class: "ym-mk-promo" }, box, h("div", { class: "ym-mk-promocap", text: caption }));
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
      b.appendChild(svgIcon(MK_PLUS));
      b.appendChild(h("span", { text: "Install" }));
      b.addEventListener("click", async () => {
        if (b.dataset.busy) return;
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

  function mkHome(reg) {
    const installedCount = Object.keys(reg).length;
    const themes = AVAILABLE.filter((e) => e.category === "Themes").length;
    const exts = AVAILABLE.filter((e) => e.category === "Extensions").length;
    const wrap = h("div", { class: "ym-mk-home" });
    const hero = h("div", { class: "ym-mk-hero" });
    const mark = h("div", { class: "ym-mk-mark" });
    const markUrl = mkLogoUrl();
    if (markUrl) mark.style.backgroundImage = 'url("' + markUrl + '")';
    hero.appendChild(mark);
    hero.appendChild(h("h1", { class: "ym-mk-htitle", text: "Make YouTube Music yours." }));
    hero.appendChild(h("p", { class: "ym-mk-hsub", text: "Themes, synced lyrics, and little touches — all in one place. Pick an add-on to dive in." }));
    const stats = h("div", { class: "ym-mk-stats" });
    for (const pair of [[installedCount, "Installed"], [themes, "Themes"], [exts, "Extensions"]]) {
      stats.appendChild(h("div", { class: "ym-mk-stat" }, h("b", { text: String(pair[0]) }), h("span", { text: pair[1] })));
    }
    hero.appendChild(stats);
    const cta = h("button", { class: "ym-mk-cta", type: "button", text: "Browse add-ons" });
    cta.addEventListener("click", () => {
      const first = AVAILABLE.find((e) => mkFilter === "All" || e.category === mkFilter);
      if (first) mkSelect(first.id);
    });
    hero.appendChild(cta);
    wrap.appendChild(hero);

    const prev = h("div", { class: "ym-mk-previews" });
    // PiP Lyrics is deliberately absent: its preview showed copyrighted lyric
    // text (AJ, 2026-10-19).
    for (const id of ["ytmod-sleep-timer", "ytmod-next-up", "ytmod-song-notes"]) {
      const ext = findAvail(id);
      if (!ext) continue;
      const card = h("div", { class: "ym-mk-prev" });
      const box = mkPromoBox(ext, "");
      box.addEventListener("click", () => mkSelect(id));
      card.appendChild(box);
      card.appendChild(h("div", { class: "ym-mk-prevcap", text: ext.name }));
      prev.appendChild(card);
    }
    wrap.appendChild(prev);
    return wrap;
  }

  function mkQuietPolish(prevBtnW, prevPillBg, keepPromo) {
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
    // Preview: put the original node back so the clip does not restart.
    if (keepPromo) {
      const fresh = mkDetail.querySelector(".ym-mk-promo");
      if (fresh) fresh.replaceWith(keepPromo);
      const v = keepPromo.querySelector("video");
      if (v) { try { v.play(); } catch (_) {} }
    }
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
    const keepPromo = quiet ? mkDetail.querySelector(".ym-mk-promo") : null;
    if (keepPromo) keepPromo.remove(); // detach so the <video> keeps its position
    mkDetail.replaceChildren();
    mkDetail.scrollTop = 0;
    if (mkSel === "home" || !findAvail(mkSel)) {
      mkSel = "home";
      mkDetail.appendChild(mkHome(reg));
      if (!quiet) mkAnimateIn();
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

    const cols = h("div", { class: "ym-mk-dcols" + (MK_PROMO.has(ext.id) ? "" : " solo") });
    const left = h("div", { class: "ym-mk-left" });
    if (installed && ext.settings && ext.settings.length) {
      const settings = await buildSettingsSection(ext);
      if (settings) {
        settings.classList.add("ym-mk-settings");
        left.appendChild(settings);
      }
    } else if (!installed && ext.settings && ext.settings.length) {
      left.appendChild(h("div", { class: "ym-mk-hint", text: "Install this add-on to change its settings." }));
    }
    left.appendChild(mkActions(ext, installed));
    cols.appendChild(left);
    if (MK_PROMO.has(ext.id)) cols.appendChild(mkPromoBox(ext, ""));
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
      mkQuietPolish(prevBtnW, prevPillBg, keepPromo);
    }
    mkDetail.scrollTop = keepScroll;
  }

  function buildMarketplace() {
    // Spicy Lyrics font for the whole panel (AJ, 2026-09-28). The stylesheet's
    // relative woff2 URLs resolve against the extension, so a <link> is enough.
    if (!document.getElementById("ym-font")) {
      try {
        const fontLink = document.createElement("link");
        fontLink.id = "ym-font";
        fontLink.rel = "stylesheet";
        fontLink.href = chrome.runtime.getURL("src/extensions/fonts/spicy-lyrics.css");
        document.head.appendChild(fontLink);
      } catch (_) {}
    }
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

    const title = h("h1", { text: "Add-ons" });
    // Secret entry point for developer mode — see onTitleTap(). Bound to
    // pointerdown rather than click on purpose: in floating mode
    // enableMarketplaceDrag() calls preventDefault() on the header's pointerdown,
    // which suppresses the derived mouse events.
    title.addEventListener("pointerdown", onTitleTap);
    const header = h("div", { class: "ym-head ym-mk-head" }, collapse, logo, title, close);

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
    renderSection();
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
    if (mkSel !== "home" && !list.some((e) => e.id === mkSel)) mkSel = "home";
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

  function gridCard(ext, installed, enabled) {
    const card = h("div", { class: "ym-card " + (ui.view === "list" ? "ym-card-list" : "ym-card-grid") + (ext.comingSoon ? " coming-soon" : "") + (installed ? " installed" : "") });

    // Thumbnail (gradient by category, with monogram initial)
    const catColor = CAT_COLOR[ext.category] || "#888";
    const thumb = h("div", { class: "ym-thumb" });
    thumb.style.background = `linear-gradient(135deg, ${catColor}33, ${catColor}11)`;
    const initial = (ext.name || "?").charAt(0).toUpperCase();
    const mono = h("div", { class: "ym-thumb-mono", text: initial });
    mono.style.color = catColor;
    thumb.appendChild(mono);
    // Per-add-on art (AJ, 2026-09-28). A video add-on plays its loop right in the
    // LIST (visibility-gated below); a still-only add-on paints the image; neither
    // -> the gradient + monogram.
    const cardArt = ext.art || {};
    if (cardArt.video) {
      const vid = h("video", {
        class: "ym-thumb-video",
        src: extArtUrl(cardArt.video),
        poster: extArtUrl(cardArt.poster || cardArt.image || ""),
        loop: "", playsinline: "", autoplay: "", muted: "",
        disablepictureinpicture: "", controlslist: "nodownload noplaybackrate",
      });
      vid.muted = true;
      thumb.appendChild(vid);
      observeThumbVideo(vid);
      mono.style.display = "none";
    } else if (cardArt.image || cardArt.poster) {
      thumb.style.backgroundImage = 'url("' + extArtUrl(cardArt.image || cardArt.poster) + '")';
      thumb.style.backgroundSize = "cover";
      thumb.style.backgroundPosition = "center";
      mono.style.display = "none";
    }
    if (installed) {
      const badge = h("div", { class: "ym-thumb-badge", text: "INSTALLED" });
      thumb.appendChild(badge);
    }
    card.appendChild(thumb);

    // Body
    const body = h("div", { class: "ym-card-body" });
    body.appendChild(h("div", { class: "ym-name", text: ext.name }));
    body.appendChild(h("div", { class: "ym-author", text: ext.author || "" }));

    body.appendChild(h("div", { class: "ym-desc", text: ext.description || "" }));

    if (ext.tags && ext.tags.length) {
      const tagsEl = h("div", { class: "ym-tags" });
      for (const t of ext.tags) tagsEl.appendChild(h("span", { class: "ym-tag", text: t }));
      body.appendChild(tagsEl);
    }

    card.appendChild(body);

    // Action
    const action = h("div", { class: "ym-action" });
    if (ext.comingSoon) {
      action.appendChild(h("span", { class: "ym-soon", text: "Coming soon" }));
    } else if (installed) {
      // Track the intended on/off in a closure and flip it on click. We do NOT
      // read tg.checked — in YTM's Polymer build the `change` event can report
      // the previous value, so trusting it could persist the wrong state.
      let state = !!enabled;
      const tg = document.createElement("tp-yt-paper-toggle-button");
      if (state) tg.setAttribute("checked", "");
      tg.addEventListener("click", () => {
        state = !state;
        setEnabled(ext.id, state);
      });
      action.appendChild(tg);
      if (ui.category === "Installed") {
        const remove = makeIconButton(ICON_DELETE, () => uninstall(ext.id), "Remove " + ext.name);
        remove.classList.add("ym-tool", "ym-delete");
        action.appendChild(remove);
      }
    } else {
      const b = h("tp-yt-paper-button", { class: "ym-install", text: "Install", raised: "" });
      b.addEventListener("click", () => install(ext.id));
      action.appendChild(b);
    }
    card.appendChild(action);

    // Click anywhere on the card (except the action row) opens the detail SHEET,
    // which morphs out of this card's thumb.
    card.addEventListener("click", () => renderDetail(ext, card));
    action.addEventListener("click", (e) => e.stopPropagation());

    return card;
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

  /* ---- messages from the popup ---- */
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "ytmod-open") openMarketplace();
    else if (msg.type === "ytmod-hint-nav") highlightNavButton();
    else if (msg.type === "ytmod-setEnabled") setEnabled(msg.id, msg.on).then(renderSection);
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
  const UPDATE_RELEASES_URL = "https://github.com/xyrodriv/Aurora-Lyrics-/releases";
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
    const onKey = (e) => { if (e.key === "Escape") close(); };
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
        "Chrome installs the update on its own, usually within a few hours. Restarting Chrome, " +
        "or pressing Update on the chrome://extensions page, fetches it right away." }));
    }

    const foot = h("div", { class: "ym-upd-foot" });
    if (!isUpdated) {
      foot.appendChild(h("a", { class: "ym-upd-btn", href: UPDATE_RELEASES_URL,
        target: "_blank", rel: "noopener noreferrer", text: "View release" }));
    }
    const ok = h("button", { class: "ym-upd-btn primary", type: "button",
      text: isUpdated ? "Got it" : "Remind me later" });
    ok.addEventListener("click", dismissAndClose);
    foot.appendChild(ok);

    const x = h("button", { class: "ym-upd-close", type: "button", title: "Close", "aria-label": "Close" });
    x.appendChild(svgIcon(ICON_CLOSE));
    x.addEventListener("click", dismissAndClose);

    const heading = h("div", { class: "ym-upd-heading" },
      h("h2", { class: "ym-upd-title", text: isUpdated ? "Aurora Lyrics updated" : "Update available" }),
      version ? h("span", { class: "ym-upd-ver", text: "v" + version }) : null
    );
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
  let rltRaf = 0;

  function rltSelect(tab) {
    try { tab.click(); } catch (e) {}
  }
  function rltScheduleApply() {
    if (rltRaf) return;
    rltRaf = setTimeout(() => {
      rltRaf = 0;
      rltApplyRemembered();
    }, 250);
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
  function rltBindBar() {
    const bar = watchTabBar();
    if (bar && !bar.__rltBound) {
      bar.addEventListener("iron-select", rltOnSelect);
      bar.__rltBound = true;
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
        }, 250);
      });
      obs.observe(root, { childList: true, subtree: true });
    }
    document.addEventListener("yt-navigate-finish", () => {
      rltAppliedFor = null;
      rltSaveEnabled = false;
      rltPending = null;
      rltApplyRemembered();
    });
    window.addEventListener("popstate", () => {
      rltAppliedFor = null;
      rltSaveEnabled = false;
      rltPending = null;
      rltApplyRemembered();
    });
    console.log("[Aurora Lyrics] remember-last-watch-tab active");
  }

  /* ---- boot ---- */
  async function boot() {
    injectPublicAPI(); // expose window.YTMod (page world) before any JS extension loads
    // Vendored hls.js, loaded into the PAGE world (so window.Hls is directly
    // usable by the spicy-lyrics add-on, which also runs page-world). Chrome /
    // Comet cannot play HLS natively, and the animated Apple Music cover art
    // from artwork.m8tec.top is delivered as an HLS .m3u8, so this dependency
    // must be present before any fullscreen art is attached. Not registered as
    // an "extension" — it exposes no UI and the Marketplace must not list it.
    try {
      const hlsNode = document.createElement("script");
      hlsNode.src = chrome.runtime.getURL("src/extensions/hls.min.js");
      hlsNode.className = "ym-vendor-script";
      (document.head || document.documentElement).appendChild(hlsNode);
    } catch (_) {}
    const reg = await getReg();
    let registryChanged = false;
    for (const removedId of ["ytmod-rose", "ytmod-compact"]) {
      if (reg[removedId]) {
        delete reg[removedId];
        registryChanged = true;
      }
    }
    // First-run seeding: the two core add-ons (synced lyrics + dynamic theme)
    // install and enable themselves on a fresh profile, so a new user gets the
    // full experience without opening the Marketplace. Runs once per browser
    // profile (ytmod_defaults_seeded flag); afterwards the user's own
    // install/uninstall choices are always respected.
    const defaultsSeeded = await new Promise((res) =>
      chrome.storage.local.get("ytmod_defaults_seeded", (r) => res(!!r["ytmod_defaults_seeded"]))
    );
    if (!defaultsSeeded) {
      for (const id of ["ytmod-spicy-lyrics", "ytmod-dynamic"]) {
        if (!reg[id]) {
          const ext = findAvail(id);
          reg[id] = { enabled: true, version: (ext && ext.version) || "?", installedAt: Date.now() };
          registryChanged = true;
        }
      }
      await new Promise((res) => chrome.storage.local.set({ ytmod_defaults_seeded: true }, res));
    }
    if (registryChanged) await setReg(reg);
    for (const id in reg) if (reg[id].enabled) applyExtension(id, true);
    // view / density / floating are PINNED (toolbar removed, AJ 2026-09-28) and
    // the card is CENTRED: the old dragged position is deliberately NOT restored,
    // so an accidental header drag (e.g. tapping the title 6× for dev mode) can't
    // leave the panel stranded in a corner across reloads.
    const savedUI = await getUI();
    // Deliberately an explicit `=== true`: an absent or junk key means off, and
    // nothing but the 6-tap gesture is allowed to turn this on.
    if (savedUI.dev === true) ui.dev = true;
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

    console.log("[Aurora Lyrics] booted v" + VERSION);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(boot, 600);
  else window.addEventListener("load", () => setTimeout(boot, 600));
})();
