/*
 * Animated album artwork — Aurora Lyrics add-on.
 *
 * Apple Music publishes an animated cover for many albums as fMP4 HLS. This
 * add-on resolves it from the public artwork API and plays it behind the cover
 * <img>, on the now-playing square and in the fullscreen media pane.
 *
 * TWO RULES, both learned the expensive way:
 *
 * 1. THE <video> NEVER LIVES IN THE PAGE'S DOM TREE. The page has exactly one
 *    <video> (video.html5-main-video), and both YTM and Aurora locate it with
 *    document-wide lookups. 07-fullscreen-layout.ts documents the bug where
 *    Better Lyrics' animated cover inside #song-image was picked up by those
 *    lookups, reported 2160x2160 and pushed the fullscreen controls off the
 *    screen. Every artwork <video> here lives inside a CLOSED SHADOW ROOT, which
 *    no querySelector, no page CSS and no page click can cross.
 *
 * 2. IT STAYS A BACKGROUND. pointer-events off, no controls, no PiP, no remote
 *    playback, muted, playsinline. If anything fails — 404, no HLS, decode
 *    error — the cover <img> underneath simply stays visible.
 *
 * LOOKUP: artist/album from the player-bar byline (the same line Aurora reads
 * the release year from). One request per album, cached in localStorage; a miss
 * is cached too, so an album with no animated art costs one request ever. YTM
 * prints the SINGLE's name where the album goes, and Apple publishes per ALBUM,
 * so a single falls back to iTunes' public search for the parent album.
 */
(() => {
  "use strict";

  const EXT_ID = "ytmod-animated-art";
  const STYLE_ID = "ym-aa-style";
  const API = "https://artwork.m8tec.top/api/v1/artwork/search";
  const CACHE_KEY = "aurora.animatedArt.v2";
  const TTL_HIT = 30 * 24 * 60 * 60 * 1000;
  const TTL_MISS = 7 * 24 * 60 * 60 * 1000;
  const MAIN_TARGET = 1080;
  const FS_TARGET = 1440;
  const TICK_MS = 1200;
  const PLAY_TICK_MS = 250;

  const CSS = `
    #song-image { position: relative; }
    .ym-aa-host {
      position: absolute;
      inset: 0;
      z-index: 2;
      opacity: 0;
      pointer-events: none;
      transition: opacity .45s ease;
    }
    .ym-aa-host.is-live { opacity: 1; }
    .ym-sl-fs-media .ym-aa-host {
      z-index: 3;
      border-radius: 14px;
      overflow: hidden;
    }
    @media (prefers-reduced-motion: reduce) {
      .ym-aa-host { transition: none; }
    }
  `;

  const surfaces = new Map();
  let key = "";
  let value = null;
  // The track the surface's stream belongs to. A new track must never inherit
  // the previous cover's frames: the old loop kept painting over the new still
  // artwork for as long as the fresh lookup and HLS fetch took.
  let lastTrackId = "";
  let resolving = false;
  let retryAt = 0;
  let failAt = 0;
  let inflight = null;
  let enabled = true;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function cacheKey(artist, album) {
    return (artist + "::" + album).toLowerCase();
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const map = raw ? JSON.parse(raw) : null;
      return map && typeof map === "object" ? map : {};
    } catch (_) {
      return {};
    }
  }

  function writeCache(map) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  // "183M views", "12/03/2024": the byline slot is a stat, not a release. Music
  // videos put a view count where the album goes.
  function looksLikeAlbum(segment) {
    const text = String(segment || "").trim();
    if (!text) return false;
    if (/^\d+(\.\d+)?\s*[kmb]?\s*(views|plays|listeners|likes)$/i.test(text)) return false;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text)) return false;
    return true;
  }

  function byline() {
    try {
      const bar = document.querySelector("ytmusic-player-bar");
      const line = bar && (bar.querySelector(".subtitle") || bar.querySelector(".byline"));
      const text = line ? String(line.textContent || "").trim() : "";
      if (!text) return null;
      const parts = text.split("\u2022").map((part) => part.trim()).filter(Boolean);
      if (parts.length < 2) return null;
      if (!looksLikeAlbum(parts[1])) return null;
      return { artist: parts[0], album: parts[1] };
    } catch (_) {
      return null;
    }
  }

  function sameRelease(a, b) {
    const norm = (v) =>
      String(v || "")
        .toLowerCase()
        .replace(/\s*-\s*(single|ep)\s*$/i, "")
        .replace(/[^a-z0-9]+/g, "");
    return !!norm(a) && norm(a) === norm(b);
  }

  async function search(artist, album) {
    const url = API + "?artist=" + encodeURIComponent(artist) + "&album=" + encodeURIComponent(album);
    try {
      const res = await fetch(url);
      if (res.status === 404) return { at: Date.now(), url: "" };
      if (!res.ok) return null;
      const json = await res.json();
      return { at: Date.now(), url: json && json.url ? String(json.url) : "" };
    } catch (_) {
      return null;
    }
  }

  // Row one is NOT the canonical release: "The Weeknd Blinding Lights" puts the
  // ROSALÍA remix first and the album version second. Walk the list, keep rows
  // whose TRACK name matches, prefer a non-single collection.
  function pickCollection(json, artist, title) {
    const rows = (json && json.results) || [];
    const norm = (v) =>
      String(v || "")
        .toLowerCase()
        .replace(/\s*-\s*single\s*$/i, "")
        .replace(/[^a-z0-9]+/g, "");
    const wantTrack = norm(title);
    const wantArtist = norm(artist);
    let single = "";
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row.collectionName) continue;
      if (wantTrack && norm(row.trackName) !== wantTrack) continue;
      const rowArtist = norm(row.artistName);
      if (wantArtist && rowArtist && rowArtist.indexOf(wantArtist) < 0 && wantArtist.indexOf(rowArtist) < 0) continue;
      const collection = String(row.collectionName);
      if (/\bsingle\b|\bremix/i.test(collection)) {
        if (!single) single = collection;
        continue;
      }
      return collection;
    }
    return single;
  }

  async function itunesAlbum(artist, title) {
    try {
      const url =
        "https://itunes.apple.com/search?term=" +
        encodeURIComponent(artist + " " + title) +
        "&entity=song&media=music&country=US&limit=12";
      const res = await fetch(url);
      if (!res.ok) return "";
      return pickCollection(await res.json(), artist, title);
    } catch (_) {
      return "";
    }
  }

  async function lookup(artist, album, title) {
    const id = cacheKey(artist, album);
    const now = Date.now();
    const cached = readCache()[id];
    if (cached && now - cached.at < (cached.url ? TTL_HIT : TTL_MISS)) return cached;
    if (inflight && inflight.key === id) return inflight.promise;
    const job = (async () => {
      const direct = await search(artist, album);
      if (direct && direct.url) return direct;
      if (!title || !sameRelease(album, title)) return direct || { at: now, url: "" };
      const collection = await itunesAlbum(artist, title);
      if (!collection || sameRelease(collection, album)) return direct || { at: now, url: "" };
      const viaAlbum = await search(artist, collection);
      if (viaAlbum && viaAlbum.url) return viaAlbum;
      return direct || viaAlbum || { at: now, url: "" };
    })();
    inflight = { key: id, promise: job };
    const result = await job;
    inflight = null;
    if (result) {
      const map = readCache();
      map[id] = result;
      writeCache(map);
    }
    return result;
  }

  /* ---- surfaces ---------------------------------------------------------- */
  function ensureSurface(kind, parent) {
    const existing = surfaces.get(kind);
    if (existing && existing.host.isConnected && existing.host.parentElement === parent) return existing;
    if (existing) dropSurface(kind);
    if (!parent) return null;
    const host = document.createElement("div");
    host.className = "ym-aa-host";
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("data-aurora-artwork", kind);
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent =
      ":host{display:block;width:100%;height:100%}" +
      "video{display:block;width:100%;height:100%;object-fit:cover;pointer-events:none;" +
      "background:transparent}";
    const video = document.createElement("video");
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.loop = true;
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("preload", "none");
    video.setAttribute("disablepictureinpicture", "");
    video.setAttribute("disableremoteplayback", "");
    video.setAttribute("tabindex", "-1");
    video.setAttribute("aria-hidden", "true");
    shadow.appendChild(style);
    shadow.appendChild(video);
    parent.appendChild(host);
    const surface = { host, video, shadow, controller: null, objectUrl: "", key: "", rampRaf: 0 };
    // Reveal only once real frames exist, so a slow fetch never shows a black
    // square where the cover was.
    video.addEventListener("loadeddata", () => {
      if (video.videoWidth > 0) host.classList.add("is-live");
    });
    surfaces.set(kind, surface);
    return surface;
  }

  function stopSurface(surface) {
    if (!surface) return;
    if (surface.controller) {
      try {
        surface.controller.abort();
      } catch (_) {}
      surface.controller = null;
    }
    if (surface.rampRaf) {
      try {
        cancelAnimationFrame(surface.rampRaf);
      } catch (_) {}
      surface.rampRaf = 0;
    }
    const video = surface.video;
    try {
      video.pause();
    } catch (_) {}
    try {
      video.removeAttribute("src");
      video.load();
    } catch (_) {}
    if (surface.objectUrl) {
      try {
        URL.revokeObjectURL(surface.objectUrl);
      } catch (_) {}
      surface.objectUrl = "";
    }
    surface.host.classList.remove("is-live");
    surface.key = "";
  }

  function dropSurface(kind) {
    const surface = surfaces.get(kind);
    if (!surface) return;
    stopSurface(surface);
    try {
      if (surface.host.parentElement) surface.host.parentElement.removeChild(surface.host);
    } catch (_) {}
    surfaces.delete(kind);
  }

  function teardownAll() {
    Array.from(surfaces.keys()).forEach(dropSurface);
  }

  /* ---- HLS --------------------------------------------------------------- */
  async function fetchText(url, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error("aa playlist " + res.status);
    return await res.text();
  }

  // Priority: a codec this browser can decode, then a height that covers the
  // element, then the CHEAPEST encode at that height. Apple ships the same 1080
  // artwork at four bitrates; the top rung is ~25MB for a 20s loop.
  function pickVariant(text, base, target) {
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    const candidates = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith("#EXT-X-STREAM-INF:") || /I-FRAME/.test(line)) continue;
      const res = /RESOLUTION=\d+x(\d+)/.exec(line);
      const codecs = /CODECS="([^"]+)"/.exec(line);
      const bandwidth = /BANDWIDTH=(\d+)/.exec(line);
      const uri = lines[i + 1];
      if (!res || !uri || uri.startsWith("#")) continue;
      const codec = codecs ? codecs[1] : "";
      const mime = "video/mp4" + (codec ? '; codecs="' + codec + '"' : "");
      if (codec && !MediaSource.isTypeSupported(mime)) continue;
      candidates.push({
        height: Number(res[1]),
        bandwidth: bandwidth ? Number(bandwidth[1]) : 0,
        url: new URL(uri, base).href,
        codecs: codec,
      });
    }
    if (!candidates.length) return null;
    const covering = candidates.filter((item) => item.height >= target);
    const pool = covering.length ? covering : candidates;
    let best = null;
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i];
      if (!best) {
        best = item;
        continue;
      }
      const nearer = Math.abs(item.height - target) < Math.abs(best.height - target);
      const same = item.height === best.height;
      if (nearer || (same && item.bandwidth < best.bandwidth)) best = item;
    }
    return best;
  }

  // EXT-X-MAP + byterange segments. The artwork playlists use one .mp4 with byte
  // ranges, no encryption, no discontinuities.
  function parseMedia(text, base) {
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    let init = null;
    let end = 0;
    const segments = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("#EXT-X-MAP:")) {
        const uri = /URI="([^"]+)"/.exec(line);
        const range = /BYTERANGE="(\d+)(?:@(\d+))?"/.exec(line);
        if (uri) {
          init = {
            url: new URL(uri[1], base).href,
            length: range ? Number(range[1]) : 0,
            offset: range ? Number(range[2] || 0) : 0,
          };
        }
        continue;
      }
      if (!line.startsWith("#EXT-X-BYTERANGE:")) continue;
      const range = /BYTERANGE:(\d+)(?:@(\d+))?/.exec(line);
      const uri = lines[i + 1];
      if (!range || !uri || uri.startsWith("#")) continue;
      const length = Number(range[1]);
      const offset = range[2] !== undefined ? Number(range[2]) : end;
      end = offset + length;
      segments.push({ url: new URL(uri, base).href, length, offset });
    }
    return { init, segments };
  }

  async function fetchPart(part, signal) {
    const headers = part.length
      ? { Range: "bytes=" + part.offset + "-" + (part.offset + part.length - 1) }
      : undefined;
    const res = await fetch(part.url, { headers, signal });
    if (!res.ok && res.status !== 206) throw new Error("aa segment " + res.status);
    return await res.arrayBuffer();
  }

  // Remove everything buffered and wait for the update, so timestampOffset can
  // be changed (it is an error to set it mid-append).
  function clearBuffer(buffer) {
    return new Promise((resolve) => {
      if (!buffer.buffered.length) {
        resolve();
        return;
      }
      const end = buffer.buffered.end(buffer.buffered.length - 1);
      const done = () => {
        buffer.removeEventListener("updateend", done);
        resolve();
      };
      buffer.addEventListener("updateend", done);
      try {
        buffer.remove(0, end);
      } catch (_) {
        buffer.removeEventListener("updateend", done);
        resolve();
      }
    });
  }

  function attach(surface, pick, media, signal) {
    const video = surface.video;
    const ms = new MediaSource();
    const objectUrl = URL.createObjectURL(ms);
    surface.objectUrl = objectUrl;
    video.src = objectUrl;
    return new Promise((resolve, reject) => {
      ms.addEventListener(
        "sourceopen",
        async () => {
          try {
            const mime = "video/mp4" + (pick && pick.codecs ? '; codecs="' + pick.codecs + '"' : "");
            if (!MediaSource.isTypeSupported(mime)) throw new Error("aa mime");
            const buffer = ms.addSourceBuffer(mime);
            const append = (data) =>
              new Promise((done, fail) => {
                const onEnd = () => {
                  buffer.removeEventListener("updateend", onEnd);
                  done();
                };
                buffer.addEventListener("updateend", onEnd);
                buffer.addEventListener("error", () => fail(new Error("aa buffer")), { once: true });
                buffer.appendBuffer(data);
              });
            const initData = await fetchPart(media.init, signal);
            const parts = [];
            for (let i = 0; i < media.segments.length; i++) {
              if (signal.aborted) return;
              parts.push(await fetchPart(media.segments[i], signal));
            }
            if (signal.aborted) return;
            if (!parts.length) throw new Error("aa empty");
            await append(initData);
            await append(parts[0]);
            // Apple's fMP4 artwork fragments do NOT always start at 0: After
            // Hours' first fragment is stamped 10s, so the buffer was 10..14.57
            // while currentTime stayed at 0. play() then waits forever for data
            // at 0 and `loop` jumps to an unbuffered 0. Re-base to zero.
            const start = buffer.buffered.length ? buffer.buffered.start(0) : 0;
            if (start > 0.05) {
              await clearBuffer(buffer);
              buffer.timestampOffset = -start;
              await append(initData);
              await append(parts[0]);
            }
            for (let i = 1; i < parts.length; i++) {
              if (signal.aborted) return;
              await append(parts[i]);
            }
            if (signal.aborted) return;
            if (ms.readyState === "open") ms.endOfStream();
            video.loop = true;
            await video.play().catch(() => {});
            resolve();
          } catch (error) {
            reject(error);
          }
        },
        { once: true }
      );
    });
  }

  async function load(surface, playlistUrl, target, signal) {
    const master = await fetchText(playlistUrl, signal);
    const pick = master.indexOf("#EXT-X-STREAM-INF") >= 0 ? pickVariant(master, playlistUrl, target) : null;
    const mediaUrl = pick ? pick.url : playlistUrl;
    const mediaText = pick ? await fetchText(mediaUrl, signal) : master;
    const media = parseMedia(mediaText, mediaUrl);
    if (!media.init || !media.segments.length) throw new Error("aa empty");
    if (signal.aborted) return;
    await attach(surface, pick, media, signal);
  }

  function start(surface, playlistUrl, target) {
    stopSurface(surface);
    const controller = new AbortController();
    surface.controller = controller;
    surface.key = playlistUrl;
    load(surface, playlistUrl, target, controller.signal).catch(() => {
      if (controller.signal.aborted) return;
      surface.key = "";
      stopSurface(surface);
      failAt = Date.now() + 30000;
    });
  }

  /* ---- playback follow + speed ramp --------------------------------------
     Pausing does not cut the loop dead: playbackRate eases down to a crawl and
     only then pauses, and resuming eases back to 1. Pitch is preserved, so it
     reads as the artwork slowing to a stop rather than freezing mid-frame. */
  const reducedMotion = () =>
    !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function rampRate(surface, target, duration, done) {
    const video = surface.video;
    if (surface.rampRaf) {
      try {
        cancelAnimationFrame(surface.rampRaf);
      } catch (_) {}
      surface.rampRaf = 0;
    }
    const from = video.playbackRate || 1;
    if (!duration || reducedMotion()) {
      try {
        video.playbackRate = target;
      } catch (_) {}
      if (done) done();
      return;
    }
    const started = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - started) / duration);
      const eased = t * t * (3 - 2 * t);
      try {
        video.playbackRate = from + (target - from) * eased;
      } catch (_) {}
      if (t < 1) surface.rampRaf = requestAnimationFrame(step);
      else {
        surface.rampRaf = 0;
        if (done) done();
      }
    };
    surface.rampRaf = requestAnimationFrame(step);
  }

  function playerPaused() {
    const player = document.querySelector("ytmusic-player video.html5-main-video");
    return player ? player.paused : false;
  }

  function currentTrackId() {
    try {
      const track = window.YTMod && window.YTMod.player && window.YTMod.player.getTrack
        ? window.YTMod.player.getTrack()
        : null;
      if (track && track.videoId) return String(track.videoId);
    } catch (_) {}
    const bar = document.querySelector("ytmusic-player-bar");
    const link = bar && bar.querySelector("a[href*='v=']");
    const match = link ? /[?&]v=([^&]+)/.exec(link.getAttribute("href") || "") : null;
    return match ? match[1] : "";
  }

  function followPlayback() {
    // Track boundary first, before anything is re-presented: drop the previous
    // cover the moment the song changes, so it cannot linger over the new art
    // while the lookup resolves.
    const trackId = currentTrackId();
    if (trackId && trackId !== lastTrackId) {
      lastTrackId = trackId;
      const stale = surfaces.get("art");
      if (stale) stopSurface(stale);
      value = null;
      key = "";
      retryAt = 0;
      failAt = 0;
    }
    // Run the placement check on the fast tick as well: the fullscreen pane
    // appears a beat after the overlay opens, and waiting for the 1.2s sync
    // would put the still cover back on screen for that beat — the exact flash
    // this reparenting exists to remove.
    if (value && value.url) present(value.url);
    if (!surfaces.size) return;
    const paused = playerPaused();
    surfaces.forEach((surface, kind) => {
      if (!surface.key) return;
      if (surface.rampRaf) return;
      try {
        if (paused) {
          if (!surface.video.paused) {
            rampRate(surface, 0.06, 520, () => {
              try {
                surface.video.pause();
              } catch (_) {}
            });
          }
        } else if (surface.video.paused) {
          surface.video.playbackRate = 0.08;
          surface.video.play().catch(() => {});
          rampRate(surface, 1, 650);
        } else if (surface.video.playbackRate < 0.99) {
          rampRate(surface, 1, 650);
        }
      } catch (_) {}
    });
  }

  /* ---- presentation ------------------------------------------------------ */
  function isFullscreen() {
    return !!document.querySelector(".ym-sl-fs-overlay");
  }

  // false = album audio, true = a real music video, null = unknown right now.
  function hasVideoNow() {
    // In fullscreen YTM's <video> is REPARENTED into our pane, so the
    // container-scoped selectors below stop matching and this used to answer
    // "no video" — which let a previous track's animated cover sit on top of a
    // music video. These two reads are the stable signal:
    //   1. the overlay's own class, set by the fullscreen code, and
    //   2. a <video> that is actually inside the media pane.
    const overlay = document.querySelector(".ym-sl-fs-overlay");
    if (overlay && overlay.classList.contains("ym-sl-fs-has-video")) return true;
    if (document.querySelector(".ym-sl-fs-media > video")) return true;
    try {
      const p = document.querySelector("ytmusic-player");
      const resp = p && p.getPlayerResponse && p.getPlayerResponse();
      const type = resp && resp.videoDetails && resp.videoDetails.musicVideoType;
      if (typeof type === "string" && type) return type !== "MUSIC_VIDEO_TYPE_ATV";
    } catch (_) {}
    const v = document.querySelector("ytmusic-player video.html5-main-video") ||
      document.querySelector("video.html5-main-video");
    return v && v.videoWidth > 0 ? true : null;
  }

  // Where the ONE surface belongs right now.
  function surfaceParent() {
    const overlay = document.querySelector(".ym-sl-fs-overlay");
    if (overlay) {
      // Hits draws the cover in its own header card, not in the media pane, so
      // the artwork has to move there too — otherwise Hits kept showing the
      // still <img> while the surface sat unused on the page square.
      if (overlay.classList.contains("ym-sl-fs-mode-hits")) {
        const hitsArt = overlay.querySelector(".ym-sl-fs-hits-artwrap");
        if (hitsArt) return hitsArt;
      }
      if (overlay.classList.contains("ym-sl-fs-stage") ||
          overlay.classList.contains("ym-sl-fs-has-video") ||
          isFullscreen()) {
        const pane = overlay.querySelector(".ym-sl-fs-media");
        if (pane) return pane;
      }
    }
    return document.querySelector("ytmusic-player-page #song-image");
  }

  function present(playlistUrl) {
    if (Date.now() < failAt) return;
    // The URL belongs to the track that resolved it. A music video's byline is
    // "artist • 704K views", which aaByline() rejects — without this guard the
    // fast playback tick kept re-presenting the PREVIOUS track's artwork over
    // the new video, because sync() had already bailed out on the bad byline.
    if (!byline()) {
      const stale = surfaces.get("art");
      if (stale) stopSurface(stale);
      return;
    }
    const byType = hasVideoNow();
    const parent = surfaceParent();
    const surface = surfaces.get("art");
    if (!parent || byType === true) {
      if (surface) stopSurface(surface);
      return;
    }
    // ONE surface, MOVED between the page square and the fullscreen pane.
    // Creating a second one per surface meant every fullscreen entry did a
    // fresh playlist fetch plus a fresh MediaSource, which is the "still cover
    // for a second, then the animation" on each entry. Reparenting keeps the
    // same <video> and the same buffer, so the pane shows the animation on its
    // first frame.
    if (!surface) {
      ensureSurface("art", parent);
    } else if (surface.host.parentElement !== parent) {
      parent.appendChild(surface.host);
    }
    const live = surfaces.get("art");
    if (!live) return;
    if (live.key !== playlistUrl) start(live, playlistUrl, isFullscreen() ? FS_TARGET : MAIN_TARGET);
    adoptKawarp(live);
  }

  // Aurora exposes this bridge because its fullscreen Kawarp instance is closure
  // state. Handing it the artwork <video> by reference lets the backdrop sample
  // the animated cover; the bitrate/perf gate lives on Aurora's side.
  function adoptKawarp(surface) {
    const bridge = window.__ymAuroraKawarp;
    if (!bridge || typeof bridge.adopt !== "function") return;
    if (!surface.host.classList.contains("is-live")) return;
    try {
      bridge.adopt(surface.video);
    } catch (_) {}
  }

  async function sync() {
    if (resolving || document.hidden || !enabled) return;
    const meta = byline();
    if (!meta) return;
    const id = cacheKey(meta.artist, meta.album);
    resolving = true;
    try {
      if (id !== key) {
        teardownAll();
        key = id;
        retryAt = 0;
        const track = window.YTMod && window.YTMod.player && window.YTMod.player.getTrack
          ? window.YTMod.player.getTrack()
          : null;
        value = await lookup(meta.artist, meta.album, track && track.title ? String(track.title) : "");
      }
      if (!value) {
        if (Date.now() > retryAt) {
          retryAt = Date.now() + 15000;
          key = "";
        }
        return;
      }
      if (!value.url) return;
      present(value.url);
      followPlayback();
    } finally {
      resolving = false;
    }
  }

  /* ---- host wiring ------------------------------------------------------- */
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "ytmod-settings" && data.id === EXT_ID) {
      enabled = !data.settings || data.settings.enabled !== false;
      if (!enabled) teardownAll();
      else sync();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      surfaces.forEach((surface) => {
        try {
          surface.video.pause();
        } catch (_) {}
      });
    } else {
      sync();
    }
  });

  // Cross-add-on bridge: every Kawarp in the extension (page backdrop, the NPV
  // rail snippet, PiP) samples artwork through this. Only a surface that is
  // actually presenting frames is offered, so an album with no animated cover
  // never hands them a dead element — they keep the still image.
  window.__ymAuroraAnimatedArt = {
    getVideo() {
      const order = ["art"];
      for (let i = 0; i < order.length; i++) {
        const surface = surfaces.get(order[i]);
        if (!surface || !surface.host.isConnected) continue;
        if (!surface.host.classList.contains("is-live")) continue;
        if (surface.video.readyState < 2) continue;
        return surface.video;
      }
      return null;
    },
  };

  injectStyle();
  try {
    window.postMessage({ type: "ytmod-settings-request", id: EXT_ID }, "*");
  } catch (_) {}
  setInterval(sync, TICK_MS);
  setInterval(followPlayback, PLAY_TICK_MS);
  sync();
})();
