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
    return Object.fromEntries(
      Object.keys(defaults).map((key) => {
        const setting = ext.settings.find((item) => item.key === key);
        return [key, settingValue(setting, saved[key] == null ? defaults[key] : saved[key])];
      })
    );
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
      name: "Dynamic",
      author: "Aurora Lyrics",
      category: "Themes",
      stars: 5,
      tags: ["theme", "dynamic", "kawarp", "artwork"],
      description: "A full-page Kawarp theme that turns the current track artwork into a moving background with transparent navigation, side rail, search header, and glass player controls.",
      version: "1.0.0",
      lastUpdated: "2026-08-20",
      jsUrl: chrome.runtime.getURL("src/extensions/dynamic.js"),
      settings: [
        { key: "brightness", label: "Brightness", min: 0.5, max: 1.2, step: 0.01, default: 0.78, display: "decimal" },
        { key: "saturation", label: "Saturation", min: 0.5, max: 2.5, step: 0.05, default: 1.7, display: "decimal" },
        { key: "blurPasses", label: "Blur passes", min: 2, max: 8, step: 1, default: 6, display: "passes" },
        { key: "warpIntensity", label: "Warp intensity", min: 0.2, max: 1, step: 0.05, default: 1, display: "decimal" },
      ],
    },
    {
      id: "ytmod-artwork-accent",
      name: "Artwork Accent",
      author: "Aurora Lyrics",
      category: "Themes",
      stars: 5,
      tags: ["artwork", "accent", "dynamic", "theme"],
      description: "Samples the current cover art and uses its strongest color for the progress bar, volume slider, and toggle controls.",
      version: "1.0.2",
      lastUpdated: "2026-08-20",
      jsUrl: chrome.runtime.getURL("src/extensions/artwork-accent.js"),
      settings: [
        { key: "glow", label: "Glow amount", min: 0, max: 1.5, step: 0.05, default: 1, display: "percent" },
      ],
    },
    {
      id: "ytmod-spicy-lyrics",
      name: "Synced Lyrics",
      author: "Spicy Lyrics source (edited)",
      category: "Extensions",
      stars: 5,
      tags: ["lyrics", "synced", "karaoke", "ttml"],
      description: "The edited Spicy Lyrics renderer for YouTube Music: synced TTML and LRCLIB lyrics, karaoke highlighting, background vocals, and temporary or permanent TTML imports. The page-wide Dynamic theme is separate.",
      version: "0.2.0",
      lastUpdated: "2026-08-20",
      github: "https://github.com/Spikerko/spicy-lyrics",
      jsUrl: chrome.runtime.getURL("src/extensions/spicy-lyrics.js"),
      settings: [
        // Order is the reading order of the page. Everything WITHOUT `dev: true`
        // shows to everyone; everything with it is hidden until the 6-tap gesture
        // has been used — see visibleSettings(). Keep the non-dev entries first.
        { key: "size", label: "Lyric size", min: 0.75, max: 3.0, step: 0.05, default: 1.30, display: "percent" },
        { key: "romanizationEnabled", label: "Romanization (JP / KR)", type: "toggle", default: true },
        { key: "legibilityBackdrop", label: "Legibility backdrop", type: "toggle", default: false },
        { type: "header", label: "Scrolling" },
        { key: "smoothScrolling", label: "Smooth scrolling", type: "toggle", default: true },
        { key: "scrollLeadEnabled", label: "Start scrolling early", type: "toggle", default: false },
        { key: "scrollLeadMs", label: "Early scroll lead", min: 0, max: 800, step: 10, default: 250, display: "milliseconds" },
        // ---- developer mode only ------------------------------------------
        { type: "header", label: "TTML settings" },
        { key: "bgOpacity", label: "Background vocals", min: 0.15, max: 1.0, step: 0.05, default: 1.0, display: "percent", dev: true },
        { key: "animation", label: "Animation intensity", min: 0, max: 1.25, step: 0.05, default: 1.0, display: "percent", dev: true },
        { key: "syllableAnimation", label: "Syllable animation intensity", min: 0, max: 1.5, step: 0.05, default: 1.0, display: "percent", dev: true },
        { key: "verticalAnimation", label: "Vertical animation intensity", min: 0, max: 3, step: 0.05, default: 1.25, display: "percent", dev: true },
        { key: "adaptiveSpacing", label: "Adaptive word spacing", type: "toggle", default: true, dev: true },
        // NOTE: "Vertical position" used to live here. It was removed as a setting
        // on AJ's call (2026-09-26) — the slider is gone and spicy-lyrics.js pins
        // the offset at its -80px default, so a value stored while the slider
        // existed cannot keep shifting the lyrics with no UI left to undo it.
      ],
    },
    {
      id: "ytmod-keyboard-shortcuts",
      name: "Keyboard Shortcuts",
      author: "Aurora Lyrics",
      category: "Extensions",
      stars: 5,
      tags: ["keyboard", "shortcuts", "hotkeys", "productivity"],
      description: "Page shortcuts for YouTube Music: Alt+L toggles the Synced Lyrics panel, Alt+M opens the Aurora Lyrics Marketplace. Ignored while typing in a field.",
      version: "0.1.0",
      lastUpdated: "2026-09-02",
      jsUrl: chrome.runtime.getURL("src/extensions/keyboard-shortcuts.js"),
      settings: [
        { key: "togglePanel", label: "Alt+L — toggle lyrics panel", type: "toggle", default: true },
        { key: "openMarketplace", label: "Alt+M — open Marketplace", type: "toggle", default: true },
      ],
    },
    {
      id: "ytmod-smooth-motion",
      name: "Smooth Motion",
      author: "Aurora Lyrics",
      category: "Themes",
      stars: 5,
      tags: ["animation", "motion", "transitions", "ui", "smooth"],
      description: "Adds tasteful motion to YouTube Music: eased left-panel reflow, animated search suggestions, page-change transitions, and micro-interactions. Every module can be toggled independently.",
      version: "1.0.0",
      lastUpdated: "2026-09-16",
      jsUrl: chrome.runtime.getURL("src/extensions/smooth-motion.js"),
      settings: [
        { key: "master", label: "Enable all motion", type: "toggle", default: true },
        { key: "guide", label: "Left panel reflow", type: "toggle", default: true },
        { key: "search", label: "Search suggestions", type: "toggle", default: true },
        { key: "pages", label: "Page transitions", type: "toggle", default: true },
        { key: "micro", label: "Micro-interactions", type: "toggle", default: true },
      ],
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
      settings: [
        { key: "master", label: "Enable sleep timer", type: "toggle", default: true },
        { key: "defaultDelayMin", label: "Default stop after", min: 5, max: 180, step: 5, default: 30, display: "minutes" },
        { key: "defaultFadeSeconds", label: "Default fade duration", min: 5, max: 120, step: 5, default: 20, display: "seconds" },
        { key: "autoPause", label: "Pause when the volume reaches zero", type: "toggle", default: true },
      ],
    },
    {
      id: "ytmod-pip-lyrics",
      name: "PiP Lyrics",
      author: "Aurora Lyrics",
      category: "Extensions",
      stars: 5,
      tags: ["lyrics", "pip", "picture-in-picture", "always-on-top", "window"],
      description: "Puts the synced lyrics in a floating always-on-top picture-in-picture window, so you can keep them on screen while you work in another tab. Reads the live lines from Synced Lyrics, with word-level highlighting.",
      version: "1.0.0",
      lastUpdated: "2026-09-16",
      jsUrl: chrome.runtime.getURL("src/extensions/pip-lyrics.js"),
      settings: [
        { key: "master", label: "Enable PiP lyrics", type: "toggle", default: true },
        { key: "showTransport", label: "Show play / previous / next in the window", type: "toggle", default: true },
      ],
    },
  ];
  const findAvail = (id) => AVAILABLE.find((a) => a.id === id);

  /* ---- Support links -------------------------------------------------------
     AJ pastes his Cash App / PayPal URLs here later. An empty string renders
     that row as a disabled "Coming soon" placeholder; a real https:// URL
     becomes a live "Open" link that opens in a new tab. */
  const SUPPORT_LINKS = {
    cashapp: "https://cash.app/$ajlol101",
    paypal: "https://paypal.me/brandiluvsbts",
  };

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

  async function buildSettingsSection(ext) {
    const list = visibleSettings(ext);
    if (!list.length) return null;
    let values = await getExtensionSettings(ext);
    const section = h("section", { class: "ym-detail-settings" });
    section.appendChild(h("div", { class: "ym-detail-settings-head" },
      h("div", { class: "ym-detail-settings-title", text: "Settings" }),
      h("div", { class: "ym-detail-settings-subtitle", text: "Changes apply immediately and are saved automatically." })
    ));
    const controls = new Map();
    for (const setting of list) {
      if (setting.type === "header") {
        // Visual-only section heading. No key, no input, no entry in `controls`
        // (so the Reset button ignores it) and no entry in `values` (so
        // postExtensionSettings does not post a junk key to the extension).
        section.appendChild(h("div", { class: "ym-detail-setting-section", text: setting.label }));
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
      const updateSetting = () => {
        const value = settingValue(setting, isToggle ? input.checked : input.value);
        values = Object.assign({}, values, { [setting.key]: value });
        if (isToggle) input.checked = value;
        else input.value = value;
        valueEl.textContent = formatSettingValue(setting, value);
        postExtensionSettings(ext.id, values);
        saveExtensionSettings(ext.id, values);
      };
      input.addEventListener(isToggle ? "change" : "input", updateSetting);
      controls.set(setting.key, { input, valueEl, setting });
      section.appendChild(h("div", { class: "ym-detail-setting-row" },
        h("div", { class: "ym-detail-setting-label", text: setting.label }),
        h("div", { class: "ym-detail-setting-control" }, input, valueEl)
      ));
    }

    const reset = h("button", { class: "ym-detail-settings-reset", type: "button", text: "Reset to defaults" });
    reset.addEventListener("click", () => {
      values = getExtensionDefaults(ext);
      controls.forEach(({ input, valueEl, setting }) => {
        if (setting.type === "toggle") input.checked = Boolean(values[setting.key]);
        else input.value = values[setting.key];
        valueEl.textContent = formatSettingValue(setting, values[setting.key]);
      });
      postExtensionSettings(ext.id, values);
      saveExtensionSettings(ext.id, values);
      toast("Settings reset");
    });
    section.appendChild(reset);
    postExtensionSettings(ext.id, values);
    return section;
  }

  /* ---- YTMod API + marketplace state ----
     NOTE: the public `window.YTMod` lives in the PAGE world (src/content/public-api.js),
     injected by boot(). The content script runs in an isolated world, so its own
     window.YTMod is invisible to the console. Player readers + open/install controls
     are bridged to this isolated world via window.postMessage. */
  const VERSION = "0.5.11";
  const ui = {
    category: "Extensions",
    view: "grid",
    density: "comfortable",
    floating: false,
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
    if (detailExt && $("#ym-detail")) renderDetail(detailExt);
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
  let marketplaceCloseTimer = 0;
  let marketplaceCloseHandler = null;
  let marketplaceOpenTimer = 0;
  let supportOverlayEl = null;

  function openMarketplace() {
    if (!overlay) return;
    if (marketplaceCloseTimer) clearTimeout(marketplaceCloseTimer);
    marketplaceCloseTimer = 0;
    if (marketplaceCloseHandler) {
      overlay.removeEventListener("animationend", marketplaceCloseHandler);
      marketplaceCloseHandler = null;
    }
    overlay.classList.remove("hidden", "ym-leaving", "ym-opening");
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
    // Hide any open Support modal so closing the marketplace (via × or Escape)
    // never strands a floating page on top of the main UI.
    if (supportOverlayEl) supportOverlayEl.classList.add("hidden");
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
    renderSection();
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
    renderSection();
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
  function marketKey(e) {
    if (overlay.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if ($("#ym-detail")) renderSection();
      else closeMarketplace();
      return;
    }
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    if ($("#ym-detail")) return; // no card navigation while a detail view is open
    const cards = $$(".ym-card-grid, .ym-card-list", $("#ym-section"));
    if (!cards.length) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); kbIndex++; focusCard(cards); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); kbIndex--; focusCard(cards); }
    else if (e.key === "Home") { e.preventDefault(); kbIndex = 0; focusCard(cards); }
    else if (e.key === "End") { e.preventDefault(); kbIndex = cards.length - 1; focusCard(cards); }
    else if (e.key === "Enter") { e.preventDefault(); if (cards[kbIndex]) cards[kbIndex].click(); }
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
          case "fetchUnison": r = await fetchUnison(args[0]); break;
          case "fetchMusicBrainzRecordingSearch":
            r = await fetchMusicBrainzRecordingSearch(args[0], args[1], args[2], args[3]);
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

  // Build the Support "page": a centered modal over the marketplace with a
  // thanks paragraph, a clear disclaimer (no premium features / just a tip),
  // and Cash App / PayPal links driven by SUPPORT_LINKS.
  function buildSupportOverlay() {
    const overlay = h("div", { class: "ym-support-overlay hidden" });
    const backdrop = h("div", { class: "ym-support-backdrop" });
    const card = h("div", { class: "ym-support-card" });
    const head = h("div", { class: "ym-support-head" });
    head.appendChild(h("h2", { text: "Support Aurora Lyrics" }));
    const closeBtn = h("button", {
      class: "ym-support-close",
      type: "button",
      title: "Close",
      "aria-label": "Close support",
      text: "\u00d7",
    });
    closeBtn.addEventListener("click", () => overlay.classList.add("hidden"));
    head.appendChild(closeBtn);
    const body = h("div", { class: "ym-support-body" });
    body.appendChild(h("p", { class: "ym-support-text" },
      "Thanks for using Aurora Lyrics! If you are enjoying it and want to help keep it free and actively maintained, a small tip goes a long way. It is never required."
    ));
    body.appendChild(h("p", { class: "ym-support-disclaimer" },
      "This is a tip, not a purchase. Supporting does ",
      h("strong", { text: "not" }),
      " unlock premium features, remove ads, or grant anything extra. Aurora Lyrics is and always will be completely free."
    ));
    function makeSupportLink(kind, label, url) {
      const ready = typeof url === "string" && url.trim().length > 0;
      return h("a", {
        class: "ym-support-link " + kind + (ready ? "" : " disabled"),
        href: ready ? url : null,
        target: ready ? "_blank" : null,
        rel: ready ? "noopener noreferrer" : null,
        title: ready ? "Open " + label : label + " link coming soon",
        "aria-label": ready ? "Open " + label : label + " link coming soon",
      }, label, h("span", { class: "ym-support-tag", text: ready ? "Open" : "Soon" }));
    }
    const links = h("div", { class: "ym-support-links" },
      makeSupportLink("cashapp", "Cash App", SUPPORT_LINKS.cashapp),
      makeSupportLink("paypal", "PayPal", SUPPORT_LINKS.paypal)
    );
    body.appendChild(links);
    body.appendChild(h("p", { class: "ym-support-foot", text: "Every bit of support is genuinely appreciated. Thank you!" }));
    card.append(head, body);
    overlay.append(backdrop, card);
    backdrop.addEventListener("click", () => overlay.classList.add("hidden"));
    document.body.appendChild(overlay);
    supportOverlayEl = overlay;
    return overlay;
  }

  function buildMarketplace() {
    // Yellow Support button sits immediately to the left of the × (via
    // margin-left:auto in styles.css) and opens the dedicated Support page.
    const supportBtn = h("button", {
      class: "ym-support-btn",
      type: "button",
      title: "Support Aurora Lyrics",
      "aria-label": "Support Aurora Lyrics",
      text: "Support",
    });
    const supportOverlay = buildSupportOverlay();
    supportBtn.addEventListener("click", () => supportOverlay.classList.toggle("hidden"));

    const close = makeIconButton(ICON_CLOSE, () => {
      // Tearing down the marketplace while Support is open would leave a
      // stranded modal on top of the page; hide Support alongside it.
      supportOverlay.classList.add("hidden");
      closeMarketplace();
    }, "Close");
    close.id = "ym-close";

    const title = h("h1", { text: "Aurora Lyrics" });
    // Secret entry point for developer mode — see onTitleTap(). Bound to
    // pointerdown rather than click on purpose: in floating mode
    // enableMarketplaceDrag() calls preventDefault() on the header's pointerdown,
    // which suppresses the derived mouse events, so a click listener would
    // silently stop counting there.
    title.addEventListener("pointerdown", onTitleTap);
    const header = h("div", { class: "ym-head" },
      title,
      h("span", { class: "ym-sub", text: "Add-ons" }),
      supportBtn,
      close
    );

    // Tabs row
    const tabsRow = h("div", { class: "ym-tabs-row" });
    for (const t of ["Extensions", "Themes", "Installed"]) {
      const tab = h("button", {
        class: "ym-tab" + (t === ui.category ? " active" : ""),
        type: "button",
        "data-tab": t,
        text: t,
      });
      tab.addEventListener("click", () => {
        ui.category = t;
        $$(".ym-tab", tabsRow).forEach((el) => el.classList.toggle("active", el.dataset.tab === t));
        renderSection();
      });
      tabsRow.appendChild(tab);
    }

    // Sort + search
    const toolbar = h("div", { class: "ym-market-toolbar" });

    // View toggle (grid <-> list) + density toggle (comfortable <-> compact)
    const viewBtn = makeIconButton(
      ui.view === "grid" ? ICON_LIST : ICON_GRID,
      () => { ui.view = ui.view === "grid" ? "list" : "grid"; syncViewBtn(); setUI({ view: ui.view }); renderSection(); },
      ui.view === "grid" ? "Switch to list view" : "Switch to grid view"
    );
    viewBtn.classList.add("ym-tool");
    function syncViewBtn() {
      const target = ui.view === "grid" ? "list" : "grid";
      viewBtn.replaceChildren(svgIcon(target === "grid" ? ICON_GRID : ICON_LIST));
      const t = target === "grid" ? "Switch to grid view" : "Switch to list view";
      viewBtn.title = t; viewBtn.setAttribute("aria-label", t);
    }
    const densBtn = makeIconButton(ICON_DENSITY, () => {
      ui.density = ui.density === "comfortable" ? "compact" : "comfortable";
      syncDensBtn(); setUI({ density: ui.density }); renderSection();
    }, "Density: " + ui.density);
    densBtn.classList.add("ym-tool");
    floatBtn = makeIconButton(ICON_FLOAT, () => {
      ui.floating = !ui.floating;
      applyMarketplaceMode(true);
    }, "Use floating marketplace");
    floatBtn.classList.add("ym-tool");
    syncFloatButton();
    function syncDensBtn() {
      const t = "Density: " + ui.density;
      densBtn.title = t; densBtn.setAttribute("aria-label", t);
    }
    toolbar.appendChild(viewBtn);
    toolbar.appendChild(densBtn);
    toolbar.appendChild(floatBtn);

    tabsRow.appendChild(toolbar);

    const section = h("div", { class: "ym-section", id: "ym-section" });

    overlay = h("div", { id: "ym-market", class: "hidden" }, header, tabsRow, section);
    enableMarketplaceDrag(header);
    document.body.appendChild(overlay);
    applyMarketplaceMode(false);
    document.addEventListener("keydown", marketKey);

    renderSection();
  }

  async function renderSection() {
    const section = $("#ym-section");
    if (!section) return;
    // Read BEFORE clearing. This function is async, so clearing first means a
    // failed or hung storage read leaves the marketplace permanently blank —
    // no cards and no empty-state message (see safeStorageGet).
    storageReadFailed = false;
    const reg = await getReg();
    section.replaceChildren();
    kbIndex = -1;

    // The registry could not be read at all. Say so, rather than implying the
    // user has nothing installed: every chrome.* call fails this way once the
    // extension has been reloaded with this tab open, and only a tab refresh
    // brings the content script back.
    if (storageReadFailed) {
      section.className = "ym-section";
      section.appendChild(
        h("div", {
          class: "ym-empty",
          text: "Couldn't read your add-ons — the extension was reloaded while this tab was open. Refresh the tab (F5) to reconnect.",
        })
      );
      return;
    }

    let list;
    if (ui.category === "Installed") {
      list = Object.keys(reg).map((id) => {
        const e = findAvail(id);
        return e
          ? { ...e, installed: true }
          : { id, name: id, description: "(installed)", version: reg[id].version || "?", author: "Aurora Lyrics", stars: 0, tags: ["installed"], lastUpdated: "?", installed: true };
      });
    } else {
      list = AVAILABLE
        .filter((e) => e.category === ui.category)
        .map((e) => (reg[e.id] ? { ...e, installed: true } : e));
    }

    if (!list.length) {
      section.appendChild(
        h("div", {
          class: "ym-empty",
          text: ui.category === "Installed" ? "No extensions installed yet. Browse Available below." : "No extensions match your search.",
        })
      );
      return;
    }

    section.className = "ym-section" + (ui.view === "list" ? " list" : "") + (ui.density === "compact" ? " compact" : "");
    section.appendChild(h("h2", { class: "ym-section-title", text: ui.category }));
    const grid = h("div", { class: ui.view === "list" ? "ym-list" : "ym-grid" });
    list.forEach((ext, i) => {
      const c = gridCard(ext, !!ext.installed, reg[ext.id] && reg[ext.id].enabled);
      c.style.setProperty("--d", i * 45 + "ms");
      grid.appendChild(c);
    });
    section.appendChild(grid);
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

    // Click anywhere on the card (except the action row) opens the detail view.
    card.addEventListener("click", () => renderDetail(ext));
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

  async function renderDetail(ext) {
    const section = $("#ym-section");
    if (!section) return;
    if (!ext || typeof ext.id !== "string") {
      console.warn("[YTMod] renderDetail called with no extension", ext);
      section.replaceChildren();
      section.appendChild(h("div", { class: "ym-empty", text: "Extension not found." }));
      return;
    }
    detailExt = ext; // remembered so setDevMode() can re-render this view in place
    section.replaceChildren();
    const reg = await getReg();
    const installed = !!reg[ext.id];
    const enabled = reg[ext.id] && reg[ext.id].enabled;

    const back = makeIconButton(ICON_BACK, () => renderSection(), "Back");
    back.classList.add("ym-detail-back");

    const titles = h("div", { class: "ym-detail-titles" },
      h("h2", { class: "ym-detail-name", text: ext.name }),
      h("span", { class: "ym-detail-cat", text: ext.category || "" })
    );

    const meta = h("div", { class: "ym-detail-meta" });
    meta.appendChild(h("span", { class: "ym-detail-author", text: "by " + (ext.author || "?") }));
    meta.appendChild(h("span", { class: "ym-detail-version", text: "v" + (ext.version || "?") }));

    const head = h("div", { class: "ym-detail-head" }, back, titles, meta);

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
        setEnabled(ext.id, state).then(() => renderDetail(ext));
      });
      action.appendChild(status);
      action.appendChild(tg);
    } else {
      const b = h("tp-yt-paper-button", { class: "ym-install", text: "Install", raised: "" });
      b.addEventListener("click", () => install(ext.id).then(() => renderDetail(ext)));
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
    section.appendChild(wrap);
  }

  /* ---- nav button (top-right, before the utility controls) ---- */
  function mountNavButton() {
    if (document.getElementById("ym-nav-btn")) return true;
    const btn = makeIconButton(ICON_APPS, () => openMarketplace(), "Aurora Lyrics — Marketplace");
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

  /* ---- messages from the popup ---- */
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "ytmod-open") openMarketplace();
    else if (msg.type === "ytmod-setEnabled") setEnabled(msg.id, msg.on).then(renderSection);
  });

  /* ---- boot ---- */
  async function boot() {
    injectPublicAPI(); // expose window.YTMod (page world) before any JS extension loads
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
    // Restore persisted view preferences (view + density).
    const savedUI = await getUI();
    if (savedUI.view === "grid" || savedUI.view === "list") ui.view = savedUI.view;
    if (savedUI.density === "comfortable" || savedUI.density === "compact") ui.density = savedUI.density;
    if (typeof savedUI.floating === "boolean") ui.floating = savedUI.floating;
    if (Number.isFinite(savedUI.floatX)) ui.floatX = savedUI.floatX;
    if (Number.isFinite(savedUI.floatY)) ui.floatY = savedUI.floatY;
    // Deliberately an explicit `=== true`: an absent or junk key means off, and
    // nothing but the 6-tap gesture is allowed to turn this on.
    if (savedUI.dev === true) ui.dev = true;
    buildMarketplace();

    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (mountNavButton() || tries > 60) clearInterval(iv);
    }, 300);

    console.debug("[Aurora Lyrics] booted v" + VERSION);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(boot, 600);
  else window.addEventListener("load", () => setTimeout(boot, 600));
})();
