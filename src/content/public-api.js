/*
 * Aurora Lyrics public API — runs in the PAGE (main) world.
 *
 * MV3 content scripts execute in an ISOLATED world, so `window.YTMod` set by
 * content.js is NOT visible from the DevTools console (which evaluates in the
 * page's main world) nor from other page-world scripts. To make `window.YTMod`
 * a real, console-callable API (the Spicetify-equivalent surface other mods
 * and user scripts can hook into), content.js injects THIS script via
 * chrome.runtime.getURL so it executes in the page world.
 *
 * Player readers are pure DOM reads and run directly here (the page world has
 * full DOM + Polymer access). Storage/UI controls are bridged to the content
 * script (isolated world) with window.postMessage ({type:"ytmod-cmd", ...})
 * and responses ({type:"ytmod-resp", ...}).
 */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // Parse YTM's player-bar byline ("Artist • Views • Likes") down to just the artist.
  function cleanArtist(s) {
    if (!s) return "";
    return String(s)
      .split(/\s*[•·]\s*/)[0]
      .trim()
      .replace(/^by\s+/i, "")
      .replace(/\s*-\s*Topic$/i, "")
      .trim();
  }

  // YTM titles are frequently polluted with the artist name and/or a
  // type suffix: "underscores — Music", "Starboy (Official Video)",
  // "Song - Remastered 2011". Strip the noise so the lyric services get a
  // title they can actually match. `artist` is passed in when known so an
  // "<artist> <dash> <title>" prefix can be removed — note the dash may be a
  // hyphen, an en dash or an em dash, which YTM uses interchangeably.
  function cleanTrackTitle(s, artist) {
    let title = String(s || "").trim();
    const dash = "[\\-–—|]";
    if (artist) {
      const esc = String(artist).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // "underscores — Music" / "underscores - Music" / "underscores | Music"
      const artistPrefix = new RegExp("^\\s*" + esc + "\\s*" + dash + "\\s*", "i");
      title = title.replace(artistPrefix, "");
    }
    title = title
      .replace(/\s*[\[(](?:official\s+)?(?:audio|video|lyrics?|visualizer|music\s+video)[\])]\s*$/i, "")
      .replace(new RegExp("\\s*[-–—|]\\s*(?:official\\s+)?(?:audio|video|lyrics?|visualizer|music\\s+video)\\s*$", "i"), "")
      .replace(/\s+(?:official\s+)?(?:audio|video|lyrics?|visualizer|music\s+video)\s*$/i, "")
      .trim();
    // A trailing/leading dash left over from stripping ("— Music" -> "Music"
    // is fine, but "- " alone is not) — drop a bare dash remnant.
    title = title.replace(new RegExp("^\\s*" + dash + "\\s*"), "").replace(new RegExp("\\s*" + dash + "\\s*$"), "").trim();
    // If what is left is *only* the artist name, the "title" carried no song
    // information — reject it so callers fall through instead of searching for
    // the artist twice. NOTE: do NOT blacklist generic words like "Music": real
    // songs are genuinely named that (e.g. underscores' track "Music"), and
    // rejecting them would break a valid lookup.
    if (artist && title.toLowerCase() === String(artist).trim().toLowerCase()) return "";
    return title;
  }

  // Opportunistically pull an ISRC out of a YTM player-response object, if one
  // exists. YTM does not reliably expose ISRC (observed: the videoDetails read
  // is often empty at track-change time), so this is a best-effort bonus used
  // as an exact-join key by the Spicy Lyrics resolver; when it returns "" the
  // resolver falls back to title+artist search.
  function extractIsrc(v) {
    if (!v || typeof v !== "object") return "";
    const re = /^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/i;
    const cand = [v.isrc, v.externalVideoId, v.musicExternalVideoId];
    for (const c of cand) {
      if (typeof c !== "string") continue;
      if (c.replace(/-/g, "").length === 12 && re.test(c)) return c.toUpperCase();
    }
    return "";
  }

  function pickArtworkUrl(thumbnails) {
    if (!Array.isArray(thumbnails)) return "";
    const usable = thumbnails
      .filter((thumbnail) => thumbnail && thumbnail.url)
      .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
    return usable[0] ? usable[0].url : "";
  }
  // Normalize a slider value/max (seconds vs already-ms) to milliseconds.
  function sliderToMs(slider) {
    const val = parseFloat(slider.value);
    if (isNaN(val)) return null;
    const max = parseFloat(slider.max);
    if (!isNaN(max) && max > 1e6) return val; // already milliseconds
    return val * 1000; // treat as seconds
  }

  // YTM exposes the playback position as a <tp-yt-paper-slider> in the player bar,
  // NOT via a JS method (none of getCurrentTime/getDuration/... exist on ytmusic-player).
  // Volume sliders are always capped at max=100, while the seek bar's max is the track
  // duration in seconds, so we disambiguate by excluding the volume sliders. Add
  // #slider / #seek-bar for precision where present.
  function findSeekSlider() {
    const exact = $("#progress-bar") || $("#slider") || $("#seek-bar") || $(".seek-bar") || $("ytmusic-player-bar #slider");
    if (exact) return exact;
    const all = $$("tp-yt-paper-slider");
    if (!all.length) return null;
    const nonVolume = all.filter((s) => parseFloat(s.max) !== 100);
    if (nonVolume.length === 1) return nonVolume[0];
    if (nonVolume.length) return nonVolume.reduce((a, b) => (parseFloat(a.max) > parseFloat(b.max) ? a : b));
    // Every slider has max===100 (e.g. a track exactly 100s long): fall back to the last
    // paper-slider in the player bar, which is conventionally the progress bar.
    return all[all.length - 1];
  }

  // The progress slider is a display control and can update only once per
  // second. The underlying HTML media element exposes a continuously advancing
  // currentTime value, which synced renderers need for smooth word animation.
  // Resolving the media element sits on the 60fps path: the lyrics panel calls
  // player.getPositionMs() on every animation frame, and the querySelector chain
  // below is document-scoped, so its cost grows with the page as the user browses
  // and listens. Hold the resolved element instead of re-querying 60x/second.
  // refreshMedia() (called from the panel's 500ms housekeeping pass) drops the
  // cache, so a track change cannot leave a stale element here for long.
  let cachedPlaybackMedia = null;

  function findPlaybackMedia() {
    const cached = cachedPlaybackMedia;
    if (cached && cached.isConnected && Number.isFinite(cached.currentTime)) return cached;
    cachedPlaybackMedia = null;

    const exact =
      $("ytmusic-player video.html5-main-video") ||
      $("ytmusic-player #movie_player video") ||
      $("#movie_player video.html5-main-video") ||
      $("video.html5-main-video") ||
      $("ytmusic-player audio");
    if (exact && Number.isFinite(exact.currentTime)) {
      cachedPlaybackMedia = exact;
      return exact;
    }

    const fallback = $$("video, audio").find(
      (media) => Number.isFinite(media.currentTime) && media.readyState > 0
    ) || null;
    cachedPlaybackMedia = fallback;
    return fallback;
  }

  function readPlayerPauseState() {
    const bar = $("ytmusic-player-bar");
    const button =
      $("#play-pause-button", bar) ||
      $("tp-yt-paper-icon-button#play-pause-button", bar) ||
      $("button[aria-label]", bar && bar.querySelector("#play-pause-button"));
    if (!button) return null;
    const label = [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.textContent,
    ].filter(Boolean).join(" ");
    if (/\bplay\b/i.test(label) && !/\bpause\b/i.test(label)) return true;
    if (/\bpause\b/i.test(label)) return false;
    return null;
  }

  const player = {
    // Drops the cached media-element reference so the next position read
    // re-resolves it. Called from the panel's 500ms housekeeping pass, which is
    // frequent enough that a track change cannot serve a stale element for long.
    refreshMedia() {
      cachedPlaybackMedia = null;
    },

    getTrack() {
      const bar = $("ytmusic-player-bar");
      let title = null, artist = "", album = "", artworkUrl = "", videoId = "", isrc = "";
      const p = $("ytmusic-player");

      // The player response is the authoritative video title. YTM's player
      // bar contains other `.title` nodes (including album metadata), so
      // reading that selector first can send the wrong song to lyric services.
      try {
        const resp = p && p.getPlayerResponse && p.getPlayerResponse();
        const v = resp && (resp.videoDetails || (resp.microformat && resp.microformat.microformatDataRenderer));
        if (v) isrc = extractIsrc(v);
        if (v && v.title) {
          videoId = String(v.videoId || "");
          artist = cleanArtist(v.author || v.ownerChannelName || "");
          title = cleanTrackTitle(v.title, artist);
          artworkUrl = pickArtworkUrl(v.thumbnail && v.thumbnail.thumbnails);
        }
      } catch (e) {}

      if (bar) {
        if (!artworkUrl) {
          const artwork = $("img", bar);
          artworkUrl = artwork && (artwork.currentSrc || artwork.src) || "";
        }
        const barArtist = cleanArtist(($(".subtitle", bar) || $(".byline", bar))?.textContent?.trim());
        if (!artist) artist = barArtist;
        const albumLink =
          $("a[href*='/album/']", bar) ||
          $("a[href*='/browse/']", bar);
        if (albumLink) album = albumLink.textContent.trim();
        if (!title) {
          title = cleanTrackTitle(
            ($(".title", bar) || $(".song-title", bar))?.textContent?.trim() || "",
            artist
          ) || null;
        }
      }
      if (!title) {
        try {
          const resp = p && p.getPlayerResponse && p.getPlayerResponse();
          const v = resp && (resp.videoDetails || (resp.microformat && resp.microformat.microformatDataRenderer));
          if (v && v.title) {
            videoId = videoId || String(v.videoId || "");
            title = cleanTrackTitle(v.title, artist);
            artworkUrl = artworkUrl || pickArtworkUrl(v.thumbnail && v.thumbnail.thumbnails);
            artist = artist || cleanArtist(($(".subtitle", $("ytmusic-player-bar"))?.textContent?.trim()) || "");
          }
        } catch (e) {}
      }
      return title ? { title, artist, album, videoId, isrc, durationMs: this.getDurationMs(), artworkUrl } : null;
    },
    getPositionMs() {
      const media = findPlaybackMedia();
      if (media) {
        const seconds = media.currentTime;
        // currentTime is NaN while the media has no metadata yet, and briefly
        // around a seek or track change. Returning it would hand NaN to the
        // lyrics animator, which writes it into --gradient-position as "NaN%";
        // that makes calc() invalid, which invalidates the whole
        // background-image and paints the glyphs transparent for one frame -
        // the black flicker. Report "no position" instead so the animator
        // simply skips the frame.
        if (Number.isFinite(seconds)) return seconds * 1000;
      }
      const s = findSeekSlider();
      return s ? sliderToMs(s) : null;
    },
    getDurationMs() {
      const media = findPlaybackMedia();
      if (media && Number.isFinite(media.duration) && media.duration > 0) {
        return media.duration * 1000;
      }
      const s = findSeekSlider();
      if (!s) return null;
      const m = parseFloat(s.max);
      return isNaN(m) ? null : (m > 1e6 ? m : m * 1000);
    },
    isPaused() {
      const buttonState = readPlayerPauseState();
      if (buttonState !== null) return buttonState;
      const media = findPlaybackMedia();
      return media ? !!media.paused || !!media.ended : null;
    },
    seek(ms) {
      const p = $("ytmusic-player");
      if (p && typeof p.seekTo === "function") { try { return p.seekTo(ms / 1000); } catch (e) {} }
      const media = findPlaybackMedia();
      if (media) {
        try {
          media.currentTime = ms / 1000;
          return media.currentTime;
        } catch (e) {}
      }
      return null;
    },
    // Best-effort next-track lookup for lyric prefetch. Primary source is the
    // player response's `upcoming` autoplay video (reliable). Best-effort
    // fallback scrapes the YTM queue panel DOM, which is fragile across UI
    // updates, so it is wrapped in try/catch and may return null.
    getNextTrack() {
      const p = $("ytmusic-player");
      try {
        const resp = p && p.getPlayerResponse && p.getPlayerResponse();
        const up = resp && resp.upcoming;
        let item = null;
        if (Array.isArray(up)) item = up[0];
        else if (up && typeof up === "object") item = up.nextVideo || up;
        if (item && item.videoId) {
          const title = item.title && typeof item.title === "object" && item.title.runs
            ? item.title.runs.map((r) => r.text).join("")
            : (item.title || "");
          const artistRaw = item.author || (item.longBylineText && item.longBylineText.runs && item.longBylineText.runs.map((r) => r.text).join(""));
          return {
            videoId: String(item.videoId),
            title: cleanTrackTitle(title, ""),
            artist: cleanArtist(artistRaw || ""),
          };
        }
      } catch (e) {}
      try {
        const queueItem = $(
          "ytmusic-player-queue-item:not([hidden])"
        ) || $("ytmusic-queue ytmusic-player-queue-item:not([hidden])");
        if (queueItem) {
          const titleEl = $(".title", queueItem) || $(".song-title", queueItem);
          const artistEl = $(".subtitle", queueItem) || $(".byline", queueItem);
          const title = titleEl && titleEl.textContent ? titleEl.textContent.trim() : "";
          const artist = artistEl && artistEl.textContent ? cleanArtist(artistEl.textContent.trim()) : "";
          if (title) {
            return {
              videoId: queueItem.getAttribute("video-id") || "",
              title: cleanTrackTitle(title, artist),
              artist,
            };
          }
        }
      } catch (e) {}
      return null;
    },
    // ---- playback control ---------------------------------------------------
    // YTM's own button is the source of truth for play state, so we click it
    // rather than calling media.play()/pause() — that keeps the UI, the media
    // session and YTM's own listeners in sync. The media element is only a
    // fallback for the case where the bar has not rendered yet.
    playPauseButton() {
      return $("#play-pause-button") || $("ytmusic-player-bar .play-pause-button");
    },
    isPlaying() {
      const paused = this.isPaused();
      return paused === null ? null : !paused;
    },
    setPaused(paused) {
      const want = !!paused;
      const now = this.isPaused();
      if (now === null) return null;
      if (now === want) return now;
      const btn = this.playPauseButton();
      if (btn) { try { btn.click(); return want; } catch (e) {} }
      const media = findPlaybackMedia();
      if (media) {
        try { want ? media.pause() : media.play(); return want; } catch (e) {}
      }
      return null;
    },
    togglePlay() {
      const now = this.isPaused();
      if (now === null) return null;
      return this.setPaused(!now);
    },
    next() {
      const btn = $(".next-button") || $("ytmusic-player-bar .next-button");
      if (!btn) return false;
      try { btn.click(); return true; } catch (e) { return false; }
    },
    previous() {
      const btn = $(".previous-button") || $("ytmusic-player-bar .previous-button");
      if (!btn) return false;
      try { btn.click(); return true; } catch (e) { return false; }
    },
    // Volume. "media" is 0..1 and is what a fade must actually ramp; "slider" is
    // YTM's 0..100 control, read so callers can show the user's own level. They
    // are reported separately on purpose: YTM may drive a gain node instead of
    // media.volume, and ramping media.volume works either way because it is a
    // multiplier on whatever the pipeline already produces.
    getVolume() {
      const media = findPlaybackMedia();
      const slider = $("#volume-slider");
      let sliderValue = null;
      if (slider) {
        const raw = Number(slider.value);
        if (Number.isFinite(raw)) sliderValue = raw;
      }
      return {
        media: media ? media.volume : null,
        slider: sliderValue,
        muted: media ? !!media.muted : null,
      };
    },
    setVolume(v) {
      const media = findPlaybackMedia();
      if (!media) return null;
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      const clamped = Math.max(0, Math.min(1, n));
      try { media.volume = clamped; } catch (e) { return null; }
      return media.volume;
    },
    setMuted(muted) {
      const media = findPlaybackMedia();
      if (!media) return null;
      try { media.muted = !!muted; return media.muted; } catch (e) { return null; }
    },
    // Diagnostic: report what's actually on the page so we can finalize selectors.
    // Decisive: calls every candidate method and reports its live return value.
    diagnose() {
      const p = $("ytmusic-player");
      const call = (fn) => {
        try { if (p && typeof p[fn] === "function") { const v = p[fn](); return (v == null) ? "null" : v; } }
        catch (e) { return "ERR:" + (e && e.message ? e.message : e); }
        return "n/a";
      };
      const posCands = ["getCurrentTime", "getCurrentTimeMs", "getMediaTime", "getPosition", "getCurrentTimeSeconds"];
      const durCands = ["getDuration", "getDurationMs", "getMediaDuration", "getDurationSeconds"];
      const sliders = $$("tp-yt-paper-slider").map((s) => ({ id: s.id || "", cls: s.className || "", value: s.value, max: s.max }));
      const seek = findSeekSlider();
      const media = findPlaybackMedia();
      const found = seek ? { id: seek.id || "", cls: seek.className || "", value: seek.value, max: seek.max } : null;
      const diag = {
        playerExists: !!p,
        media: media ? {
          tag: media.tagName,
          cls: media.className || "",
          currentTime: media.currentTime,
          duration: media.duration,
          paused: media.paused,
          readyState: media.readyState,
        } : null,
        hasSliderId: !!($("#slider")),
        positionCalls: posCands.map((fn) => ({ fn, ret: call(fn) })),
        durationCalls: durCands.map((fn) => ({ fn, ret: call(fn) })),
        sliderCount: sliders.length,
        sliders,
        foundSeek: found,
        seekValue: seek ? seek.value : null,
        seekMax: seek ? seek.max : null,
        track: this.getTrack(),
      };
      console.log("[Aurora Lyrics] diagnose ->", JSON.stringify(diag, null, 2));
      return diag;
    },
  };

  function probe() {
    const track = player.getTrack();
    const pos = player.getPositionMs();
    const dur = player.getDurationMs();
    const out = { track, positionMs: pos, durationMs: dur };
    console.log("[Aurora Lyrics] player probe ->", JSON.stringify(out));
    return out;
  }

  function injectCSS(css) {
    const s = document.createElement("style");
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return s;
  }
  function addPanel(dom) { document.body.appendChild(dom); return dom; }

  /* ---- bridge to content script (isolated world) for storage/UI controls ---- */
  const pending = {};
  let seq = 0;
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.type !== "ytmod-resp") return;
    const cb = pending[d.id];
    if (cb) { delete pending[d.id]; cb(d.ok ? null : d.result, d.ok ? d.result : null); }
  });
  function cmd(method, args) {
    return new Promise((res, rej) => {
      const id = "c" + (++seq);
      pending[id] = (err, result) => err ? rej(new Error(err)) : res(result);
      window.postMessage({ type: "ytmod-cmd", id, method, args: args || [] }, "*");
    });
  }

  /* ---- player-bar buttons ---------------------------------------------------
     Add-ons need buttons in the player bar, and the bar's right-hand grid track
     is already exactly full: 100px volume + 144px buttons + 36px toggle = 280px.
     So we widen that track once and pad the middle column by the same amount —
     .middle-controls is justify-content:center, so a narrower track would drag
     the centred song title left by half the difference.

     Measured live 2026-09-16: 36px buttons on a 48px pitch (36px + 12px gap), so
     each button costs 48px. Two buttons = 96px.
  */
  const PLAYER_BAR_STYLE_ID = "ym-pb-style";
  const PLAYER_BAR_EXTRA_PX = 96;

  function ensurePlayerBarStyle() {
    if (document.getElementById(PLAYER_BAR_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PLAYER_BAR_STYLE_ID;
    style.textContent = [
      "ytmusic-player-bar{grid-template-columns:280px 1fr " + (284 + PLAYER_BAR_EXTRA_PX) + "px}",
      // #right-controls carries its OWN width:280px — set INLINE, tuned to
      // exactly its old contents (100px volume + 144px buttons + 36px toggle).
      // Widening only the grid track leaves that element 280px, so the extra 96px
      // of buttons overflow and the volume slider — the only shrinkable child —
      // absorbs all of it and collapses to the knob alone. It must be !important
      // because a stylesheet rule cannot beat an inline style.
      "ytmusic-player-bar #right-controls{width:auto !important}",
      "ytmusic-player-bar .middle-controls{padding-left:" + PLAYER_BAR_EXTRA_PX + "px}",
      ".ym-pb-btn{position:relative;display:flex;align-items:center;justify-content:center;",
      "width:36px;height:36px;padding:0;border:0;border-radius:50%;background:none;",
      // YTM's own buttons carry a 6px side margin (36px button on a 48px pitch)
      // and the row has no gap, so ours must match or the spacing looks uneven.
      "margin:0 6px;",
      "color:#909090;cursor:pointer;transition:color .12s ease,background-color .12s ease}",
      ".ym-pb-btn:hover{color:#fff;background:rgba(255,255,255,.1)}",
      ".ym-pb-btn[data-active='1']{color:#fff}",
      ".ym-pb-btn svg{width:24px;height:24px;fill:currentColor;pointer-events:none}",
      // Generated content, so it never lands in innerText or a text scrape.
      ".ym-pb-btn[data-badge]:not([data-badge=''])::after{content:attr(data-badge);",
      "position:absolute;top:0;right:-2px;padding:1px 3px;border-radius:6px;",
      "background:rgba(0,0,0,.66);color:#fff;font:600 8px/1 Roboto,Arial,sans-serif;",
      "letter-spacing:.2px;pointer-events:none}",
    ].join("");
    (document.head || document.documentElement).appendChild(style);
  }

  function playerBarHandle(btn) {
    return {
      el: btn,
      setActive(on) { btn.dataset.active = on ? "1" : "0"; return this; },
      setBadge(text) {
        if (text === null || text === undefined || text === "") delete btn.dataset.badge;
        else btn.dataset.badge = String(text);
        return this;
      },
      setLabel(text) {
        btn.title = String(text);
        btn.setAttribute("aria-label", String(text));
        return this;
      },
      remove() { if (btn.parentNode) btn.parentNode.removeChild(btn); },
    };
  }

  // YTM re-renders the right-controls row on some player-state changes and our
  // button is not part of its template, so it can be silently dropped — which
  // also silently un-breaks any layout it influenced. Re-append it if it goes
  // missing. Re-appending inside the callback fires one more mutation, but that
  // pass finds parentNode === container and stops, so it converges.
  let playerBarRowObserver = null;

  function watchPlayerBarRow() {
    const row = $("#right-controls");
    if (!row || typeof MutationObserver !== "function") return;
    if (playerBarRowObserver && playerBarRowObserver.__target === row && row.isConnected) return;
    if (playerBarRowObserver) playerBarRowObserver.disconnect();
    playerBarRowObserver = new MutationObserver(() => {
      const live = $(".right-controls-buttons");
      if (!live) return;
      for (const btn of document.querySelectorAll(".ym-pb-btn")) {
        if (btn.parentNode !== live) live.appendChild(btn);
      }
    });
    playerBarRowObserver.__target = row;
    playerBarRowObserver.observe(row, { childList: true, subtree: true });
  }

  function addPlayerBarButton(opts) {
    const o = opts || {};
    if (!o.id) return null;
    const container = $(".right-controls-buttons");
    if (!container) return null;
    ensurePlayerBarStyle();
    watchPlayerBarRow();
    const id = "ym-pb-" + o.id;
    const existing = document.getElementById(id);
    if (existing) {
      // YTM can re-render the row; make sure we are still inside it.
      if (existing.parentNode !== container) container.appendChild(existing);
      return playerBarHandle(existing);
    }
    const btn = document.createElement("button");
    btn.id = id;
    btn.type = "button";
    btn.className = "ym-pb-btn";
    btn.title = String(o.label || o.id);
    btn.setAttribute("aria-label", String(o.label || o.id));
    if (o.iconSvgPath) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", o.iconSvgPath);
      svg.appendChild(path);
      btn.appendChild(svg);
    }
    // Stop the click reaching YTM's bar handlers (it toggles the player page).
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof o.onClick === "function") o.onClick(e, playerBarHandle(btn));
    });
    container.appendChild(btn);
    return playerBarHandle(btn);
  }

  /* ---- inter-add-on bus -----------------------------------------------------
     Add-ons are separate page-world scripts with no way to talk, so each one
     either scraped the DOM or duplicated work. This is a deliberately tiny
     pub/sub: namespaced string topics, synchronous delivery. It is a contract,
     not a framework — keep payloads plain data, and keep the topic names stable
     because other add-ons depend on them.

     The last payload per topic is retained and can be replayed. That matters:
     topics like "lyrics:lines" fire only when the lyrics are (re)built, so an
     add-on that starts LATER — a picture-in-picture window opened mid-track —
     would otherwise never receive anything and show an empty view.

     Topics in use:
       lyrics:lines   { trackKey, videoId, title, artist, lines:[{ text, startMs,
                        endMs, lineTimed, opposite, words:[{text,startMs,endMs}] }] }
       lyrics:active  { trackKey, index }
  */
  const busTopics = new Map();
  const busLast = new Map();
  const bus = {
    on(topic, handler, opts) {
      if (typeof topic !== "string" || typeof handler !== "function") return () => {};
      let set = busTopics.get(topic);
      if (!set) { set = new Set(); busTopics.set(topic, set); }
      set.add(handler);
      if (opts && opts.replay && busLast.has(topic)) {
        try { handler(busLast.get(topic)); }
        catch (e) { console.warn("[Aurora Lyrics] bus replay failed on " + topic, e); }
      }
      return () => bus.off(topic, handler);
    },
    off(topic, handler) {
      const set = busTopics.get(topic);
      if (set) set.delete(handler);
    },
    emit(topic, payload) {
      busLast.set(topic, payload);
      const set = busTopics.get(topic);
      if (!set || !set.size) return 0;
      let delivered = 0;
      for (const handler of Array.from(set)) {
        try { handler(payload); delivered++; }
        catch (e) { console.warn("[Aurora Lyrics] bus handler failed on " + topic, e); }
      }
      return delivered;
    },
    // Pull the current value — for a consumer that arrives after the emit.
    last(topic) { return busLast.has(topic) ? busLast.get(topic) : null; },
    clear() { busTopics.clear(); busLast.clear(); },
  };

  window.YTMod = {
    version: "0.5.11",
    ready: Promise.resolve(),
    player,
    diagnose: () => player.diagnose(),
    probe,
    injectCSS,
    addPanel,
    // Shared plumbing for add-ons (see the notes above each).
    addPlayerBarButton,
    bus,
    // Bridge methods (resolved in the content script's isolated world).
    // saveExtensionSettings lets an add-on persist its OWN settings, for the
    // controls that live in its UI rather than in the marketplace settings list.
    // NOTE: content.js only DELIVERS the keys declared in the catalog schema, so
    // a key an add-on persists this way must still exist there (it can be marked
    // dev:true to keep it out of the visible settings list).
    saveExtensionSettings: (id, values) => cmd("saveExtensionSettings", [id, values]),
    openMarketplace: () => cmd("openMarketplace"),
    closeMarketplace: () => cmd("closeMarketplace"),
    install: (id) => cmd("install", [id]),
    setExtensionEnabled: (id, on) => cmd("setExtensionEnabled", [id, on]),
    getRegistry: () => cmd("getRegistry"),
    getAvailable: () => cmd("getAvailable"),
    registerExtension: (m) => cmd("registerExtension", [m]),
    getPermanentLyrics: (trackKey) => cmd("getPermanentLyrics", [trackKey]),
    setPermanentLyrics: (trackKey, xml) => cmd("setPermanentLyrics", [trackKey, xml]),
    removePermanentLyrics: (trackKey) => cmd("removePermanentLyrics", [trackKey]),
    getSpicyCache: () => cmd("getSpicyCache"),
    setSpicyCache: (cache) => cmd("setSpicyCache", [cache]),
    clearSpicyCache: () => cmd("clearSpicyCache"),
    fetchLRCLIB: (url) => cmd("fetchLRCLIB", [url]),
    fetchUnison: (url) => cmd("fetchUnison", [url]),
    fetchMusicBrainzRecordingSearch: (title, artist, album, durationMs) =>
      cmd("fetchMusicBrainzRecordingSearch", [title, artist, album, durationMs]),
    fetchCoverArt: (title, artist) => cmd("fetchCoverArt", [title, artist]),
  };
  console.log("[Aurora Lyrics] public API ready (page world) v" + window.YTMod.version);
})();
