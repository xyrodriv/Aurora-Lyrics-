/* Aurora Lyrics — Next Up (add-on)
   ---------------------------------------------------------------------------
   What plays next, shown IN the player bar instead of floating over the page.

   WHY IT MOVED (AJ, 2026-10-26): the old pill sat in the gutter above the bar
   inside a translucent glass shell with a two-colour conic glow spinning on a
   requestAnimationFrame loop — a repaint every ~42ms for as long as a track was
   playing, and it still read as a badge stuck to the page rather than part of
   the player. This version is a quiet row in the bar: no animation loop, no
   backdrop-filter, no gradient, no shadow. The only motion is a 140ms opacity
   crossfade when the NEXT track changes, and none at all under reduced motion.

   WHERE IT SITS — two seats, one preferred:
     1. LAST child of .middle-controls, the song row on the left end of the bar
        (under the theme's "Song info left, controls centred" arrangement, the
        zone with slack beside the title). Last rather than between the title and
        the like buttons, so leaving that seat never shifts anything YouTube
        drew: it just stops.
     2. FIRST child of #right-controls, immediately left of the volume slider, so
        the same row of controls reads as "next up · volume · the rest". That is
        where it goes when the song row cannot spare the room.

   WIDTH: the chip has no cap. It takes exactly the width its next-track title
   needs and stops where the row stops, so a long "up next" title is allowed to
   run all the way to the transport and only then gets its ellipsis. When the row
   is tight the chip gives way 20:1 before the current song name does.

   The seat is chosen from the live layout, never from a breakpoint (see
   fitChip): the chip takes seat 1 while the title keeps a readable width and the
   chip clears the transport and the right cluster; otherwise it tries seat 2
   while it clears the transport and the song row; otherwise it hides. On a
   1109px bar the song row is already touching the transport, so the chip lives
   beside the volume slider; on 2100px it sits with the song. In the stock
   arrangement both rows are the rows it uses anyway.

   COMPACT MODE: the Apple Music Style theme's compact bar is 60px instead of
   ~100px, so the chip drops to 34px, a 26px thumbnail and a slightly smaller
   title. One row of CSS under html.ym-yt-compact; nothing measured in JS.

   WHERE THE DATA COMES FROM — verified live before writing the first version:
     document.querySelector("ytmusic-player-queue").data
   is the FULL queue model straight from YouTube's API: an array of
   `{ playlistPanelVideoRenderer: { videoId, title, byline, thumbnail, selected } }`.
   That beats scraping on every axis — real order, no virtualization, no selector
   fragility. Verified facts from the live probe:
     - `#movie_player.getPlaylist()` EXISTS BUT RETURNS EMPTY (playlistLen 0) even
       with a real mix loaded, so that API is a dead end here.
     - The queue DOM is NOT virtualized (all 50 items were present), so scraping is
       a usable FALLBACK.
     - The playing row carries the `selected` attribute.
     - There is NO `video-id` attribute on the row, and NO `.title` element inside
       it — which is why public-api.js's getNextTrack() DOM fallback never worked:
       it looks for `.title`, while the real class is `.song-title`.

   NOTE this shows the QUEUE's next item, not `playerResponse.upcoming` —
   `upcoming` is the AUTOPLAY recommendation, which is what plays after the queue
   runs out, not the next track in it.
   --------------------------------------------------------------------------- */
(() => {
  "use strict";

  const EXT_ID = "ytmod-next-up";
  const STYLE_ID = "ym-nu-style";
  const CHIP_ID = "ym-nu-next";
  // The queue changes rarely; matching the queue panel's own cadence keeps the
  // reads off the critical path. The same tick re-seats the chip if YTM
  // re-rendered the row underneath us.
  const TICK_MS = 700;
  // Time the content stays invisible while it is replaced (see swapContent).
  const SWAP_MS = 150;
  // Clearance the chip keeps from a zone YouTube owns before it hides, and the
  // narrowest the song title may get while the chip is on screen.
  const TRANSPORT_CLEARANCE_PX = 12;
  const MIN_INFO_PX = 150;

  const DEFAULT_SETTINGS = {
    showArt: true,
  };

  // Every property that matters is set here because `all: unset` starts the
  // element from nothing: the bar is full of YTM's own button/toolbar rules and
  // inheriting them is how a stray border or 14px font shows up.
  //
  // The look is deliberately NOT a pill and NOT glass: artwork, a 9px "up next"
  // kicker and one line of title, on nothing. Hover is the only state that draws
  // a surface, and the chevron is the only thing that moves.
  const CSS = `
#${CHIP_ID} {
  all: unset;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 9px;
  height: 40px;
  margin-left: 14px;
  margin-right: 14px;
  padding: 4px 12px 4px 4px;
  border-radius: 10px;
  color: #b9b9b9;
  font-family: "Roboto", "YouTube Sans", system-ui, -apple-system, sans-serif;
  /* No max-width: the chip takes exactly the width its next-track title needs
     and stops where the row stops — just before the transport. It yields 20:1
     before the song name does, so a long next title never squeezes the current
     one; below MIN_PX it is a readable stub with an ellipsis. The floor matters:
     a flex item's automatic minimum is its min-content, which for a nowrap title
     is the whole string — without it the chip could never shrink at all. */
  flex: 0 20 auto;
  min-width: 120px;
  cursor: pointer;
  transition: background-color .14s ease;
}
#${CHIP_ID}[hidden] { display: none; }
#${CHIP_ID}:hover { background: rgba(255, 255, 255, .075); }
#${CHIP_ID}:active { background: rgba(255, 255, 255, .12); }
#${CHIP_ID}:focus-visible { outline: 2px solid rgba(255, 255, 255, .55); outline-offset: 2px; }

#${CHIP_ID} .ym-nu-art {
  width: 32px; height: 32px; flex: 0 0 auto;
  border-radius: 6px;
  object-fit: cover;
  background: rgba(255, 255, 255, .06);
}
#${CHIP_ID} .ym-nu-art[hidden] { display: none; }
#${CHIP_ID}.ym-nu-no-art { padding-left: 10px; }
#${CHIP_ID} .ym-nu-copy {
  display: flex; flex-direction: column; gap: 2px;
  min-width: 0;
}
#${CHIP_ID} .ym-nu-label {
  font-size: 9px; font-weight: 700; line-height: 1.15;
  letter-spacing: .1em; text-transform: uppercase;
  color: rgba(255, 255, 255, .42);
}
#${CHIP_ID} .ym-nu-title {
  font-size: 12.5px; font-weight: 500; line-height: 1.25;
  color: #e4e4e4;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#${CHIP_ID}:hover .ym-nu-title { color: #fff; }
#${CHIP_ID}:hover .ym-nu-label { color: rgba(255, 255, 255, .6); }

/* Revealed on hover only: it says "this is a control", not "here is a badge". */
#${CHIP_ID} .ym-nu-chev {
  width: 13px; height: 13px; flex: 0 0 auto;
  opacity: 0; transform: translateX(-2px);
  transition: opacity .12s ease, transform .12s ease;
}
#${CHIP_ID}:hover .ym-nu-chev { opacity: .7; transform: none; }

/* Content crossfade when the next track changes. Opacity only — no layout, no
   filter, nothing that would make the bar repaint while a track plays. */
#${CHIP_ID} .ym-nu-art,
#${CHIP_ID} .ym-nu-copy { transition: opacity .14s ease; }
#${CHIP_ID}.ym-nu-swap .ym-nu-art,
#${CHIP_ID}.ym-nu-swap .ym-nu-copy { opacity: 0; }

/* The theme's compact bar: 60px tall, so the chip loses 6px of height and 6px of
   artwork rather than looking wedged. */
html.ym-yt-compact #${CHIP_ID} {
  height: 34px; gap: 8px;
  margin-left: 12px; margin-right: 12px;
  min-width: 96px;
  padding: 3px 10px 3px 3px;
}
html.ym-yt-compact #${CHIP_ID} .ym-nu-art { width: 26px; height: 26px; border-radius: 5px; }
html.ym-yt-compact #${CHIP_ID} .ym-nu-title { font-size: 12px; }

/* Seat 2, squeezed bar: the right cluster is anchored to the right edge, so
   every pixel the chip keeps comes out of the time label on its left. It gives
   up text before it gives up its seat — the kicker and the chevron first, then
   the title. What is left is the artwork, which still says "next track", with
   the full name in the tooltip. */
html.ym-yt-compact #${CHIP_ID}.ym-nu-tight,
#${CHIP_ID}.ym-nu-tight {
  gap: 7px;
  min-width: 0;
  padding: 3px 9px 3px 3px;
}
#${CHIP_ID}.ym-nu-tight .ym-nu-label,
#${CHIP_ID}.ym-nu-tight .ym-nu-chev { display: none; }

html.ym-yt-compact #${CHIP_ID}.ym-nu-artonly,
#${CHIP_ID}.ym-nu-artonly {
  gap: 0;
  min-width: 0;
  padding: 3px;
}
#${CHIP_ID}.ym-nu-artonly .ym-nu-copy,
#${CHIP_ID}.ym-nu-artonly .ym-nu-chev { display: none; }

@media (prefers-reduced-motion: reduce) {
  #${CHIP_ID},
  #${CHIP_ID} .ym-nu-art,
  #${CHIP_ID} .ym-nu-copy,
  #${CHIP_ID} .ym-nu-chev { transition: none; }
}
`;

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  // Which seat the chip is in. Left is preferred; fitChip moves it.
  const PLACE_LEFT = "left";
  const PLACE_RIGHT = "right";

  let chip = null;
  let artEl = null;
  let titleEl = null;
  let tickTimer = 0;
  let swapTimer = 0;
  let fitTimer = 0;
  let currentKey = "";
  let placement = PLACE_LEFT;
  let rowObservers = [];

  function makeEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  }

  function whenYTMod(cb) {
    if (window.YTMod && window.YTMod.player) { cb(); return; }
    let tries = 0;
    const timer = setInterval(() => {
      if (window.YTMod && window.YTMod.player) { clearInterval(timer); cb(); return; }
      if (++tries > 200) clearInterval(timer);
    }, 100);
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ---- queue model ------------------------------------------------------- */
  // `title` / `byline` are YouTube renderer objects: either { simpleText } or
  // { runs: [{ text }] }. Handle both rather than assuming one.
  function textOf(node) {
    if (!node) return "";
    if (typeof node.simpleText === "string") return node.simpleText.trim();
    if (Array.isArray(node.runs)) {
      return node.runs.map((r) => (r && r.text) || "").join("").trim();
    }
    return "";
  }

  function thumbnailOf(renderer) {
    const list = renderer && renderer.thumbnail && renderer.thumbnail.thumbnails;
    if (!Array.isArray(list) || !list.length) return "";
    // Largest available; CSS scales it down to the chip, so this stays crisp.
    return list[list.length - 1].url || "";
  }

  // The queue array, or null when there is no queue to read.
  function queueRenderers() {
    try {
      const host = document.querySelector("ytmusic-player-queue");
      const data = host && host.data;
      if (!Array.isArray(data) || !data.length) return null;
      const out = data
        .map((entry) => entry && entry.playlistPanelVideoRenderer)
        .filter(Boolean);
      return out.length ? out : null;
    } catch (_) {
      return null;
    }
  }

  // The id the player is actually on. Used only as a tie-breaker: `selected` is
  // the primary signal, but it is worth a second opinion.
  function currentVideoId() {
    try {
      const mp = document.querySelector("#movie_player");
      const data = mp && mp.getVideoData && mp.getVideoData();
      return (data && data.video_id) || "";
    } catch (_) {
      return "";
    }
  }

  function playingIndex(list) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].selected === true) return i;
    }
    const vid = currentVideoId();
    if (vid) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].videoId === vid) return i;
      }
    }
    return -1;
  }

  // DOM fallback, used only when the queue model is unavailable. Selectors taken
  // from a live dump of a real row: .song-title / .byline / img inside
  // yt-img-shadow.thumbnail. NOTE `.title` does NOT exist — that is the bug that
  // made public-api.js's getNextTrack() fallback useless.
  function nextFromDom() {
    try {
      const rows = Array.from(document.querySelectorAll("ytmusic-player-queue-item"));
      if (!rows.length) return null;
      let idx = rows.findIndex((r) => r.hasAttribute("selected") || r.selected === true);
      if (idx < 0) idx = 0;
      const next = rows[idx + 1];
      if (!next) return null;
      const titleEl = next.querySelector(".song-title") || next.querySelector("yt-formatted-string");
      const img = next.querySelector("yt-img-shadow.thumbnail img") || next.querySelector("img");
      const title = titleEl && titleEl.textContent ? titleEl.textContent.trim() : "";
      if (!title) return null;
      return { title, artist: "", thumb: (img && (img.currentSrc || img.src)) || "" };
    } catch (_) {
      return null;
    }
  }

  function readNext() {
    const list = queueRenderers();
    if (list) {
      const idx = playingIndex(list);
      if (idx >= 0 && idx + 1 < list.length) {
        const r = list[idx + 1];
        const title = textOf(r.title);
        if (title) {
          return { title, artist: textOf(r.shortBylineText || r.longBylineText), thumb: thumbnailOf(r) };
        }
      }
      // A queue with a known playing index but nothing after it: there IS no next
      // track, so the chip should hide rather than guess.
      if (idx >= 0) return null;
    }
    return nextFromDom();
  }

  /* ---- the chip ---------------------------------------------------------- */
  function buildChip() {
    ensureStyle();
    artEl = makeEl("img", "ym-nu-art");
    artEl.alt = "";
    titleEl = makeEl("span", "ym-nu-title");
    const copy = makeEl("span", "ym-nu-copy");
    copy.appendChild(makeEl("span", "ym-nu-label", "Up next"));
    copy.appendChild(titleEl);

    const chev = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chev.setAttribute("viewBox", "0 0 24 24");
    chev.setAttribute("aria-hidden", "true");
    chev.setAttribute("class", "ym-nu-chev");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M9 6l6 6-6 6");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2.4");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    chev.appendChild(path);

    chip = makeEl("button");
    chip.id = CHIP_ID;
    chip.type = "button";
    chip.hidden = true;
    chip.appendChild(artEl);
    chip.appendChild(copy);
    chip.appendChild(chev);
    chip.addEventListener("click", (event) => {
      // The bar itself is clickable in places; never let a skip also toggle it.
      event.preventDefault();
      event.stopPropagation();
      // The chip shows the track IMMEDIATELY after the current one, so a single
      // `next()` is exactly what the user asked for.
      try {
        if (window.YTMod && window.YTMod.player && window.YTMod.player.next) {
          window.YTMod.player.next();
        }
      } catch (_) {}
    });
  }

  function barEl() {
    return document.querySelector("ytmusic-player-bar");
  }
  function leftHost() {
    const bar = barEl();
    return (bar && bar.querySelector(".middle-controls")) || document.querySelector(".middle-controls");
  }
  function rightHost() {
    const bar = barEl();
    return (bar && bar.querySelector("#right-controls")) || document.querySelector("#right-controls");
  }

  // Seat 1 ends the song row, after the artwork, the title and the like buttons;
  // seat 2 opens the right cluster, before the volume slider. Either way the
  // chip goes where it adds nothing to reorder — a repair never nudges YouTube.
  function ensureMounted() {
    if (!chip) return false;
    const right = rightHost();
    const row = placement === PLACE_RIGHT ? right : leftHost();
    if (!row) return false;
    if (row === right) {
      if (chip.parentElement !== row || row.firstElementChild !== chip) {
        row.insertBefore(chip, row.firstElementChild);
      }
    } else if (chip.parentElement !== row || row.lastElementChild !== chip) {
      row.appendChild(chip);
    }
    return true;
  }

  function setPlacement(next) {
    if (placement === next) return;
    placement = next;
    // The cap and the shrink stage below belong to seat 2 only; seat 1 sizes
    // itself with flex.
    if (next !== PLACE_RIGHT && chip) {
      chip.style.removeProperty("max-width");
      applyStage("");
    }
    ensureMounted();
  }

  // YTM re-renders both rows on some player-state changes and our chip is not
  // part of either template, so it can be silently dropped. Watch both so a
  // re-render is repaired at once rather than up to a tick later. childList only:
  // our own insert fires one callback, and ensureMounted is a no-op the second
  // time round.
  function watchRows() {
    if (!chip || typeof MutationObserver !== "function") return;
    const rows = [leftHost(), rightHost()].filter(Boolean);
    const same = rows.length === rowObservers.length &&
      rows.every((row, i) => rowObservers[i].__target === row && row.isConnected);
    if (same) return;
    for (const observer of rowObservers) observer.disconnect();
    rowObservers = rows.map((row) => {
      const observer = new MutationObserver(() => { if (chip) ensureMounted(); });
      observer.__target = row;
      observer.observe(row, { childList: true });
      return observer;
    });
  }

  // A guest in a bar YTM owns: rather than a breakpoint guess, ask the layout.
  //   1. seat 1 holds while the title keeps a readable width AND the chip clears
  //      the transport and the right cluster. The title is the row's only
  //      shrinkable child, so a chip that "fits" can still leave "Song na…";
  //   2. seat 2 holds while the chip clears the transport's time label and the
  //      song row — at which point the volume slider is untouched, because the
  //      right track sizes to its own contents;
  //   3. neither: hide. Everything here is measured, so the seat follows the
  //      window instead of a number picked on one monitor.
  // Runs on mount, on a track change (the new title changes what fits) and on
  // resize.
  function fitChip() {
    if (!chip) return;
    const left = leftHost();
    const right = rightHost();
    if (!left && !right) return;

    if (left) {
      setPlacement(PLACE_LEFT);
      // Seat 2's cap and shrink stage do not travel to seat 1.
      chip.style.removeProperty("max-width");
      applyStage("");
      const rect = measureChip();
      if (rect && !titleSqueezed() &&
          !overlapsZone(rect, ["#left-controls", "#right-controls"])) {
        chip.hidden = false;
        return;
      }
    }
    if (right) {
      setPlacement(PLACE_RIGHT);
      if (fitRightSeat()) {
        chip.hidden = false;
        return;
      }
    }
    chip.hidden = true;
  }

  // Seat 2 lives in a row that is sized to its contents (#right-controls is
  // width:auto), so flexbox cannot shrink the chip there — a long next title
  // would push the cluster left onto the time label, and the chip would have to
  // hide for a reason that is fixable. So: ask for the natural width, then give
  // back exactly the width that is not there, in the order the chip can bear to
  // lose it — text first, artwork last. Because the right cluster is anchored
  // to the right edge, every pixel a stage gives back also moves the chip right,
  // away from the label. The cap and the stage class are cleared the moment the
  // chip leaves this seat.
  const RIGHT_STAGES = [
    { cls: "", min: 0, artOnly: false },          // min 0 = the stylesheet's floor
    { cls: "ym-nu-tight", min: 88, artOnly: false },
    { cls: "ym-nu-artonly", min: 32, artOnly: true },
  ];

  function fitRightSeat() {
    const barrier = rightBarrier() + TRANSPORT_CLEARANCE_PX;
    const artShown = !!(artEl && !artEl.hidden);
    for (const stage of RIGHT_STAGES) {
      if (stage.artOnly && !artShown) continue;
      applyStage(stage.cls);
      chip.style.removeProperty("max-width");
      const rect = measureChip();
      if (!rect) return false;
      if (rect.left >= barrier) return true;
      const room = Math.floor(rect.width - (barrier - rect.left));
      const floor = stage.min || parseFloat(getComputedStyle(chip).minWidth) || 0;
      if (room < floor) continue;
      chip.style.maxWidth = room + "px";
      const capped = measureChip();
      if (capped && capped.left >= barrier - 0.5) return true;
    }
    chip.style.removeProperty("max-width");
    applyStage("");
    return false;
  }

  function applyStage(cls) {
    chip.classList.remove("ym-nu-tight", "ym-nu-artonly");
    if (cls) chip.classList.add(cls);
  }

  // Everything YTM owns that the right cluster could reach backwards into.
  // The container's own box is not enough: when the bar is squeezed YTM lets
  // the time label overhang #left-controls by tens of pixels, so the chip has to
  // clear the label, not the box that was meant to hold it.
  function rightBarrier() {
    const bar = barEl();
    if (!bar) return 0;
    let edge = 0;
    for (const sel of ["#left-controls", ".middle-controls"]) {
      const zone = bar.querySelector(sel);
      if (!zone || zone.contains(chip)) continue;
      edge = Math.max(edge, rightEdgeOf(zone));
    }
    return edge;
  }

  // Deepest right edge in a subtree; the chip is skipped so a fit never reads
  // its own current width back as a constraint.
  function rightEdgeOf(root) {
    let edge = root.getBoundingClientRect().right;
    for (const el of root.querySelectorAll("*")) {
      if (chip && (el === chip || el.contains(chip))) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0) edge = Math.max(edge, r.right);
    }
    return edge;
  }

  // display:none reports a 0x0 rect, so the chip is laid out for the length of
  // one task; nothing is painted between the unhide and the decision.
  function measureChip() {
    if (chip.hidden) chip.hidden = false;
    const rect = chip.getBoundingClientRect();
    return rect.width > 0 ? rect : null;
  }

  // Measured with the chip in seat 1: this is the width the title is left with.
  function titleSqueezed() {
    const info = infoEl();
    if (!info) return false;
    return info.getBoundingClientRect().width < MIN_INFO_PX;
  }

  function infoEl() {
    const row = leftHost();
    if (!row) return null;
    return row.querySelector(".content-info-wrapper") || row.querySelector(".content-info");
  }

  function overlapsZone(rect, selectors) {
    const bar = barEl();
    if (!bar) return false;
    for (const sel of selectors) {
      const zone = bar.querySelector(sel);
      if (!zone || zone.contains(chip)) continue;
      const r = zone.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (rect.left < r.right + TRANSPORT_CLEARANCE_PX &&
          rect.right > r.left - TRANSPORT_CLEARANCE_PX &&
          rect.top < r.bottom && rect.bottom > r.top) return true;
    }
    return false;
  }

  function scheduleFit() {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = 0;
      fitChip();
    }, 150);
  }

  function swapContent(next, animate) {
    const apply = () => {
      const title = next.title || "Unknown track";
      titleEl.textContent = title;
      const label = "Play next: " + (next.artist ? title + " \u2014 " + next.artist : title);
      chip.title = label;
      chip.setAttribute("aria-label", label);
      if (settings.showArt && next.thumb) {
        artEl.src = next.thumb;
        artEl.hidden = false;
      } else {
        artEl.removeAttribute("src");
        artEl.hidden = true;
      }
      chip.classList.toggle("ym-nu-no-art", artEl.hidden);
      fitChip();
    };
    const reduce = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduce) {
      if (swapTimer) { clearTimeout(swapTimer); swapTimer = 0; chip.classList.remove("ym-nu-swap"); }
      apply();
      return;
    }
    if (swapTimer) clearTimeout(swapTimer);
    chip.classList.add("ym-nu-swap");
    // A timer rather than transitionend: the chip may be hidden by the fit check
    // (or the bar re-rendered) between the two halves of the swap, and a missed
    // event would leave the label stuck at opacity 0.
    swapTimer = setTimeout(() => {
      swapTimer = 0;
      apply();
      chip.classList.remove("ym-nu-swap");
    }, SWAP_MS);
  }

  function hideChip() {
    currentKey = "";
    if (chip) chip.hidden = true;
  }

  function tick() {
    if (!chip) return;
    if (!ensureMounted()) return;
    watchRows();
    const next = readNext();
    if (!next) { hideChip(); return; }
    // Keyed so the DOM is only touched when the next track actually changes.
    const key = next.title + "|" + next.artist + "|" + next.thumb;
    if (key === currentKey) return;
    const firstRender = currentKey === "";
    currentKey = key;
    swapContent(next, !firstRender);
  }

  function applySettings(next) {
    if (!next || typeof next !== "object") return;
    settings.showArt = typeof next.showArt === "boolean" ? next.showArt : DEFAULT_SETTINGS.showArt;
    currentKey = ""; // force a re-render with the new shape
    tick();
  }

  function start() {
    buildChip();
    ensureMounted();
    watchRows();
    tickTimer = window.setInterval(tick, TICK_MS);
    tick();
    window.postMessage({ type: "ytmod-settings-request", id: EXT_ID }, "*");
    window.addEventListener("resize", scheduleFit);
  }

  function teardown() {
    if (tickTimer) { window.clearInterval(tickTimer); tickTimer = 0; }
    if (swapTimer) { clearTimeout(swapTimer); swapTimer = 0; }
    if (fitTimer) { clearTimeout(fitTimer); fitTimer = 0; }
    for (const observer of rowObservers) observer.disconnect();
    rowObservers = [];
    window.removeEventListener("resize", scheduleFit);
    if (chip && chip.parentNode) chip.parentNode.removeChild(chip);
    chip = null;
    artEl = null;
    titleEl = null;
    currentKey = "";
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.id !== EXT_ID) return;
    if (data.type === "ytmod-settings") { applySettings(data.settings); return; }
    if (data.type !== "ytmod-ext") return;
    if (data.action === "disable") teardown();
  });

  whenYTMod(() => { start(); });
})();
