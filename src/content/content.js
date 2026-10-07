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
        // Force the animated Kawarp backdrop for EVERY music video, instead of
        // the duplicated blurred-video backdrop. Off = only still uploads
        // (Official Audio / Lyric Video) use Kawarp. Consumed by Aurora Lyrics.
        { key: "preferKawarpAlways", label: "Prefer Aurora Bloom for music videos", type: "toggle", default: false },
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
      description: "Unofficial. Karaoke-style synced lyrics that follow the music line-by-line and word-by-word. Built on the Spicy Lyrics Syllable renderer; community syncs fetched via the Spicy Lyrics API.",
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
        { key: "legibilityBackdrop", label: "Legibility backdrop", type: "toggle", default: false },
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
      art: { video: "assets/art/pip-lyrics.mp4", poster: "assets/art/pip-lyrics.jpg" },
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

    const reset = h("button", { class: "ym-detail-settings-reset", type: "button", text: "Reset to defaults" });
    reset.addEventListener("click", () => {
      values = getExtensionDefaults(ext);
      controls.forEach(({ input, valueEl, setting, syncRangeFill }) => {
        if (setting.type === "toggle") input.checked = Boolean(values[setting.key]);
        else input.value = values[setting.key];
        valueEl.textContent = formatSettingValue(setting, values[setting.key]);
        if (syncRangeFill) syncRangeFill();
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
    if (detailExt && sheetOpen) renderDetail(detailExt);
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
    // Hide any open Support modal so closing the marketplace (via × or Escape)
    // never strands a floating page on top of the main UI.
    if (supportOverlayEl) supportOverlayEl.classList.add("hidden");
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
    if (overlay.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (sheetOpen) closeDetail();
      else closeMarketplace();
      return;
    }
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    if (sheetOpen) return; // no card navigation while the detail sheet is open
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

    // Tabs row (with a sliding indicator)
    const tabsRow = h("div", { class: "ym-tabs-row" });
    tabThumb = h("span", { class: "ym-tab-thumb" });
    for (const t of ["Extensions", "Themes", "Installed"]) {
      const tab = h("button", {
        class: "ym-tab" + (t === ui.category ? " active" : ""),
        type: "button",
        "data-tab": t,
        text: t,
      });
      tab.addEventListener("click", () => {
        if (t === ui.category) return;
        animateTabSwitch(t);
      });
      tabsRow.appendChild(tab);
    }
    tabsRow.appendChild(tabThumb);

    // Toolbar (view / density / float) REMOVED on AJ's call (2026-09-28): the
    // panel is now a single fixed glass card, so there is nothing to switch.
    // ui.view / ui.density / ui.floating stay pinned to their defaults below.

    // Hint about the secret 6-tap developer-mode gesture on the Aurora Lyrics
    // header title. Lives as its own slim bar between the header and the tabs
    // so it is discoverable without cluttering the header row (AJ 2026-09-28).
    const devHint = h("div", {
      class: "ym-dev-hint",
      text: "Want to change settings for an extension? Click the Aurora Lyrics title 6 times to enable developer mode, 6 times to turn it off.",
    });

    const section = h("div", { class: "ym-section", id: "ym-section" });

    // Detail sheet — fills the panel and morphs out of the clicked card.
    sheetCover = h("div", { class: "ym-sheet-cover" });
    sheetScrim = h("div", { class: "ym-sheet-scrim" });
    sheetBg = h("div", { class: "ym-sheet-bg" }, sheetCover, sheetScrim);
    sheetPoster = h("div", { class: "ym-sheet-poster" });
    sheetText = h("div", { class: "ym-sheet-text", id: "ym-sheet-text" });
    const sheetInner = h("div", { class: "ym-sheet-inner" }, sheetPoster, sheetText);
    const sheetScroll = h("div", { class: "ym-sheet-scroll" }, sheetInner);
    sheetCloseBtn = makeIconButton(ICON_CLOSE, () => closeDetail(), "Close");
    sheetCloseBtn.classList.add("ym-sheet-close");
    sheetEl = h("div", { class: "ym-sheet", id: "ym-sheet" }, sheetBg, sheetCloseBtn, sheetScroll);

    // Brand watermark (AJ, 2026-09-28): the logo, large, blurred and dimmed behind
    // the glass — mirrors the demo. Resolved through the extension so the URL works
    // regardless of the page origin.
    try {
      watermarkEl = h("div", { class: "ym-watermark" });
      watermarkAltEl = h("div", { class: "ym-watermark ym-watermark-alt" });
      LOGO_URL = chrome.runtime.getURL("assets/manifest-logo.webp");
    } catch (_) { watermarkEl = null; watermarkAltEl = null; }

    overlay = h("div", { id: "ym-market", class: "hidden" }, watermarkEl, watermarkAltEl, header, devHint, tabsRow, section, sheetEl);
    refreshPanelArt();
    // Keep the ambient background in step with the track while the panel is open
    // (1.2s so a track change lands quickly).
    window.setInterval(() => {
      if (overlay && !overlay.classList.contains("hidden")) refreshPanelArt();
    }, 1200);
    enableMarketplaceDrag(header);
    document.body.appendChild(overlay);
    applyMarketplaceMode(false);
    document.addEventListener("keydown", marketKey);
    window.addEventListener("resize", moveTabThumb);

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
    // Drop the previous cards' video observers before the nodes are removed.
    if (thumbVideoObserver) thumbVideoObserver.disconnect();
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
    moveTabThumb();
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
      openMarketplace();
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

    console.log("[Aurora Lyrics] booted v" + VERSION);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(boot, 600);
  else window.addEventListener("load", () => setTimeout(boot, 600));
})();
