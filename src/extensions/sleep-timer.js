/*
 * Sleep Timer — Aurora Lyrics add-on.
 *
 * Adds a button to the YouTube Music player bar that opens a frosted popover.
 * Pick how long until the fade starts (or "end of track"), how long the fade
 * takes, and whether to pause playback once the volume reaches zero.
 *
 * Design notes worth keeping:
 *   - The countdown is measured in PLAYBACK time, not wall-clock. A sleep timer
 *     that burns down while the music is paused is wrong, so we accumulate
 *     elapsed time only on ticks where playback is running.
 *   - "End of track" recomputes from the player position every tick instead of
 *     counting down, so seeking self-corrects.
 *   - The fade ramps "media.volume", NOT YTM's own slider. YTM may drive a gain
 *     node rather than the media element, but media.volume multiplies whatever
 *     the pipeline already produces, so the ramp is correct either way. The
 *     trade-off is that YTM's slider does not visually move during the fade.
 *   - After auto-pausing we put the volume back, so resuming is not silent.
 *
 * Runs in the page world (injected as <script src>), so it can use
 * window.YTMod and receive settings over window.postMessage like the others.
 */
(function () {
  "use strict";
  // Defensive global guard: if this IIFE somehow runs more than once (e.g. the
  // content script's `applied[id+"_js"]` guard is bypassed, or the script tag
  // gets appended twice), make the extra runs a no-op so we never end up with
  // 4 copies of the popup on the page — AJ hit this in the marketplace on
  // 2026-09-28 and the panels stacked into a 2×2 grid. The first run sets the
  // flag, every subsequent run returns immediately before defining any state.
  if (window.__ym_sleep_timer_loaded__) return;
  window.__ym_sleep_timer_loaded__ = true;

  const EXT_ID = "ytmod-sleep-timer";
  const STYLE_ID = "ym-st-style";
  const POPUP_ID = "ym-st-popup";
  const DIM_ID = "ym-st-dim";
  const TICK_MS = 100;

  const DELAY_PRESETS_MIN = [15, 30, 45, 60];
  const FADE_PRESETS_S = [10, 20, 30, 60];
  const DEFAULT_DELAY_MIN = 30;
  const DEFAULT_FADE_S = 20;

  const DEFAULTS = {
    master: true,
    defaultDelayMin: DEFAULT_DELAY_MIN,
    defaultFadeSeconds: DEFAULT_FADE_S,
    autoPause: true,
  };
  let settings = Object.assign({}, DEFAULTS);

  // The bar's own buttons are 36px on a 48px pitch; the host widens the track
  // and pads the middle column so our buttons do not drag the song title left.
  const ICON_TIMER =
    "M15 1H9v2h6V1zm-4 13h2V8h-2v6zm8.03-6.61l1.42-1.42c-.43-.51-.9-.99-1.41-1.41l-1.42 " +
    "1.42C16.07 4.74 14.12 4 12 4c-4.97 0-9 4.03-9 9s4.02 9 9 9 9-4.03 9-9c0-2.12-.74-4.07" +
    "-1.97-5.61zM12 20c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z";

  const CSS = `
    /* ===== Sleep Timer (Aurora Lyrics) ===== */
    #${DIM_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      background: rgba(0, 0, 0, .38);
      opacity: 0;
      transition: opacity .18s ease;
    }
    #${DIM_ID}.ym-st-dim-on { opacity: 1; }

    #${POPUP_ID} {
      position: fixed;
      right: 16px;
      bottom: 84px;
      z-index: 2147483001;
      width: 288px;
      padding: 14px;
      box-sizing: border-box;
      border-radius: 14px;
      background: rgba(255, 255, 255, .08);
      border: 1px solid rgba(255, 255, 255, .22);
      backdrop-filter: blur(20px) saturate(1.5);
      -webkit-backdrop-filter: blur(20px) saturate(1.5);
      box-shadow: 0 10px 34px rgba(0, 0, 0, .42);
      color: #fff;
      font: 400 13px/1.35 Roboto, Arial, sans-serif;
      opacity: 0;
      transform: translateY(6px) scale(.985);
      transition: opacity .16s ease, transform .16s cubic-bezier(.22,.61,.36,1);
    }
    #${POPUP_ID}.ym-st-open { opacity: 1; transform: translateY(0) scale(1); }

    #${POPUP_ID} .ym-st-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 0 0 12px;
    }
    #${POPUP_ID} .ym-st-title { font-size: 14px; font-weight: 600; letter-spacing: .2px; }
    #${POPUP_ID} .ym-st-x {
      width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%;
      background: none; color: rgba(255,255,255,.72); cursor: pointer;
      font: 400 16px/1 Roboto, Arial, sans-serif;
    }
    #${POPUP_ID} .ym-st-x:hover { background: rgba(255,255,255,.12); color: #fff; }

    #${POPUP_ID} .ym-st-label {
      margin: 12px 0 6px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: .9px;
      text-transform: uppercase;
      color: rgba(255,255,255,.55);
    }
    #${POPUP_ID} .ym-st-label:first-of-type { margin-top: 0; }

    #${POPUP_ID} .ym-st-row { display: flex; flex-wrap: wrap; gap: 6px; }
    #${POPUP_ID} .ym-st-chip {
      padding: 6px 10px;
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 999px;
      background: rgba(255,255,255,.05);
      color: rgba(255,255,255,.86);
      cursor: pointer;
      font: 500 12px/1 Roboto, Arial, sans-serif;
      transition: background-color .14s ease, border-color .14s ease, color .14s ease;
    }
    #${POPUP_ID} .ym-st-chip:hover { background: rgba(255,255,255,.14); }
    #${POPUP_ID} .ym-st-chip[data-on="1"] {
      background: rgba(255,255,255,.9);
      border-color: rgba(255,255,255,.9);
      color: #111;
    }

    /* Exact-value entry, in seconds, so short values can be tested without
       waiting out a 15-minute preset. */
    #${POPUP_ID} .ym-st-field {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 7px;
      font-size: 11px;
      color: rgba(255,255,255,.55);
    }
    #${POPUP_ID} .ym-st-num {
      width: 64px;
      padding: 4px 6px;
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 7px;
      background: rgba(0,0,0,.3);
      color: #fff;
      font: 500 12px/1.2 Roboto, Arial, sans-serif;
      text-align: right;
    }
    #${POPUP_ID} .ym-st-num:focus {
      outline: none;
      border-color: rgba(255,255,255,.5);
    }

    #${POPUP_ID} .ym-st-switch-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 12px;
    }
    #${POPUP_ID} .ym-st-switch-row span { color: rgba(255,255,255,.86); }
    #${POPUP_ID} .ym-st-switch {
      position: relative;
      flex: 0 0 36px;
      width: 36px; height: 20px;
      border: 0; padding: 0;
      border-radius: 999px;
      background: rgba(255,255,255,.22);
      cursor: pointer;
      transition: background-color .16s ease;
    }
    #${POPUP_ID} .ym-st-switch::after {
      content: "";
      position: absolute;
      top: 2px; left: 2px;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: #fff;
      transition: transform .18s cubic-bezier(.22,.61,.36,1);
    }
    #${POPUP_ID} .ym-st-switch[data-on="1"] { background: rgba(255,255,255,.9); }
    #${POPUP_ID} .ym-st-switch[data-on="1"]::after { transform: translateX(16px); }

    #${POPUP_ID} .ym-st-status {
      margin-top: 14px;
      min-height: 18px;
      font-size: 12px;
      color: rgba(255,255,255,.66);
    }
    #${POPUP_ID} .ym-st-count {
      font-variant-numeric: tabular-nums;
      font-size: 22px;
      font-weight: 600;
      letter-spacing: .4px;
      color: #fff;
    }
    #${POPUP_ID} .ym-st-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    #${POPUP_ID} .ym-st-go, #${POPUP_ID} .ym-st-cancel {
      flex: 1;
      padding: 9px 10px;
      border-radius: 9px;
      border: 1px solid rgba(255,255,255,.2);
      background: rgba(255,255,255,.9);
      color: #111;
      cursor: pointer;
      font: 600 12.5px/1 Roboto, Arial, sans-serif;
      transition: filter .14s ease, background-color .14s ease;
    }
    #${POPUP_ID} .ym-st-go:hover { filter: brightness(1.06); }
    #${POPUP_ID} .ym-st-cancel {
      background: rgba(255,255,255,.06);
      color: rgba(255,255,255,.9);
    }
    #${POPUP_ID} .ym-st-cancel:hover { background: rgba(255,255,255,.14); }
    #${POPUP_ID} .ym-st-hide { display: none; }
  `;

  // ---- dom helpers (Trusted Types: createElement / textContent only) --------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  // ---- state ---------------------------------------------------------------
  let btnHandle = null;
  let popup = null;
  let dim = null;
  let tickTimer = 0;
  let mode = "off";          // off | armed | fading | faded
  let remainingMs = 0;       // playback time left before the fade starts
  let lastTick = 0;
  let fadeStartedAt = 0;
  let startVolume = 1;
  let endOfTrack = false;
  let chosenDelayMs = DEFAULT_DELAY_MIN * 60000;
  let chosenFadeMs = DEFAULT_FADE_S * 1000;
  let autoPause = true;
  let statusText = "";
  let lastCountdownAt = 0; // throttles the countdown repaint (see tick)

  function player() {
    return (window.YTMod && window.YTMod.player) || null;
  }

  function whenYTMod(callback) {
    if (window.YTMod && window.YTMod.player) return callback();
    setTimeout(() => whenYTMod(callback), 200);
  }

  function formatClock(ms) {
    if (!Number.isFinite(ms)) return "--:--";
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  // ---- style ---------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- the timer -----------------------------------------------------------
  function startTimer(opts) {
    const p = player();
    if (!p) return false;
    const vol = p.getVolume ? p.getVolume() : null;
    if (!vol || vol.media === null) {
      statusText = "No audio element yet — start a track first.";
      render();
      return false;
    }
    startVolume = vol.media;
    setVolumeMarker(startVolume);
    endOfTrack = !!(opts && opts.endOfTrack);
    chosenDelayMs = (opts && opts.delayMs) || chosenDelayMs;
    chosenFadeMs = (opts && opts.fadeMs) || chosenFadeMs;
    autoPause = opts && typeof opts.autoPause === "boolean" ? opts.autoPause : autoPause;

    mode = "armed";
    fadeStartedAt = 0;
    lastTick = performance.now();
    if (endOfTrack) {
      // Compute now rather than waiting for the first tick: remainingMs <= 0
      // triggers the fade, so seeding it with 0 would fade immediately.
      const dur = p.getDurationMs ? p.getDurationMs() : null;
      const pos = p.getPositionMs ? p.getPositionMs() : null;
      remainingMs = (dur && pos !== null && pos !== undefined)
        ? Math.max(0, dur - pos - chosenFadeMs)
        : Infinity;
    } else {
      remainingMs = chosenDelayMs;
    }
    statusText = endOfTrack ? "Fading at the end of this track." : "Counting down.";
    if (btnHandle) btnHandle.setActive(true);
    render();
    if (!tickTimer) startTicking();
    return true;
  }

  function cancelTimer(reason) {
    const wasFading = mode === "fading" || mode === "faded";
    mode = "off";
    stopTicking();
    // Only put the level back if the fade actually moved it — otherwise we would
    // stomp a volume change the user made while the timer was merely counting.
    if (wasFading) {
      const p = player();
      if (p && p.setVolume) p.setVolume(startVolume);
    }
    statusText = reason || "";
    if (btnHandle) { btnHandle.setActive(false); btnHandle.setBadge(""); }
    render();
  }

  function beginFade() {
    mode = "fading";
    fadeStartedAt = performance.now();
    const p = player();
    const vol = p && p.getVolume ? p.getVolume() : null;
    // Re-derive from the live level: the user may have moved the volume since
    // the timer was armed, and the fade should start from where they left it.
    if (vol && vol.media !== null) startVolume = vol.media;
    statusText = "Fading out.";
    render();
  }

  function finishFade() {
    const p = player();
    if (p && p.setVolume) p.setVolume(0);
    mode = "faded";
    if (autoPause && p && p.setPaused) {
      p.setPaused(true);
      // Restore the level so pressing play again is not silent.
      if (p.setVolume) p.setVolume(startVolume);
      setVolumeMarker(startVolume);
      statusText = "Paused. Volume restored.";
    } else {
      setVolumeMarker(0);
      statusText = "Faded to silence.";
    }
    stopTicking();
    if (btnHandle) { btnHandle.setActive(false); btnHandle.setBadge(""); }
    render();
  }

  // The countdown must keep running while the tab is in the background — that is
  // the normal way a sleep timer gets used. requestAnimationFrame is suspended
  // entirely in a hidden tab, so it is the wrong driver here. setInterval is
  // throttled to roughly 1s in the background, which is fine for a countdown, and
  // a page that is playing audio is exempt from Chrome's aggressive throttling.
  // The delta-based accounting below self-corrects for uneven tick spacing.
  function startTicking() {
    if (tickTimer) return;
    lastTick = performance.now();
    tickTimer = window.setInterval(tick, TICK_MS);
  }

  function stopTicking() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
  }

  function tick() {
    if (mode !== "armed" && mode !== "fading") { stopTicking(); return; }
    const p = player();
    if (!p) return;
    const now = performance.now();
    const delta = Math.max(0, now - lastTick);
    lastTick = now;

    if (mode === "armed") {
      const paused = p.isPaused ? p.isPaused() : false;
      if (endOfTrack) {
        const dur = p.getDurationMs ? p.getDurationMs() : null;
        const pos = p.getPositionMs ? p.getPositionMs() : null;
        if (dur && pos !== null && pos !== undefined) {
          remainingMs = Math.max(0, dur - pos - chosenFadeMs);
        }
      } else if (!paused) {
        // Only burn the countdown while playback is actually running.
        remainingMs = Math.max(0, remainingMs - delta);
      }
      if (btnHandle) btnHandle.setBadge(mode === "armed" ? shortBadge(remainingMs) : "");
      if (remainingMs <= 0) beginFade();
    } else if (mode === "fading") {
      const progress = chosenFadeMs <= 0 ? 1 : (now - fadeStartedAt) / chosenFadeMs;
      if (progress >= 1) { finishFade(); return; }
      const level = startVolume * (1 - progress);
      if (p.setVolume) p.setVolume(level);
      setVolumeMarker(level);
      if (btnHandle) btnHandle.setBadge(Math.round((1 - progress) * 100) + "%");
    }
    // The volume ramp runs every frame, but the countdown only needs to be read
    // a few times a second — rebuilding its DOM per frame is pure waste.
    if (now - lastCountdownAt >= 200) {
      lastCountdownAt = now;
      renderCountdown();
    }
  }

  function shortBadge(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total >= 3600) return Math.floor(total / 3600) + "h";
    if (total >= 60) return Math.ceil(total / 60) + "m";
    return total + "s";
  }

  // Observable diagnostic: the fade ramps media.volume, which YTM's own slider
  // does not reflect, so without this there is nothing to inspect from outside.
  // Check <html data-ym-st-volume="..."> while a fade is running.
  function setVolumeMarker(level) {
    try {
      document.documentElement.dataset.ymStVolume =
        Number.isFinite(level) ? level.toFixed(3) : "?";
    } catch (e) {}
  }

  // Same idea for the timer state, so the countdown is observable from outside
  // without opening the popup. Check <html data-ym-st-mode data-ym-st-remaining>.
  function setStateMarker() {
    try {
      const root = document.documentElement;
      root.dataset.ymStMode = mode;
      root.dataset.ymStRemaining =
        Number.isFinite(remainingMs) ? String(Math.round(remainingMs / 1000)) : "?";
    } catch (e) {}
  }

  // ---- popup ---------------------------------------------------------------
  // A small numeric field, in seconds, wired to a setter. The 1s minimum exists
  // so a fade can be tested quickly instead of waiting out a preset.
  function buildExactField(id, ariaLabel, onCommit) {
    const field = el("div", "ym-st-field");
    field.appendChild(el("span", "", "Exact"));
    const input = el("input", "ym-st-num");
    input.id = id;
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.setAttribute("aria-label", ariaLabel);
    input.addEventListener("input", () => {
      const secs = Number(input.value);
      if (!Number.isFinite(secs) || secs <= 0) return;
      onCommit(secs);
    });
    field.appendChild(input);
    field.appendChild(el("span", "", "s"));
    return field;
  }

  function buildPopup() {
    const root = el("div", "");
    root.id = POPUP_ID;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Sleep timer");
    root.setAttribute("aria-modal", "false");

    const head = el("div", "ym-st-head");
    head.appendChild(el("div", "ym-st-title", "Sleep timer"));
    const x = el("button", "ym-st-x", "\u00D7");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", () => closePopup());
    head.appendChild(x);
    root.appendChild(head);

    root.appendChild(el("div", "ym-st-label", "Stop after"));
    const delayRow = el("div", "ym-st-row");
    delayRow.id = "ym-st-delay";
    root.appendChild(delayRow);
    root.appendChild(buildExactField("ym-st-delay-input", "Exact stop after in seconds", (secs) => {
      chosenDelayMs = secs * 1000;
      endOfTrack = false;
      if (mode === "armed") startTimer({ delayMs: chosenDelayMs, endOfTrack: false });
      renderChips();
    }));

    root.appendChild(el("div", "ym-st-label", "Fade out over"));
    const fadeRow = el("div", "ym-st-row");
    fadeRow.id = "ym-st-fade";
    root.appendChild(fadeRow);
    root.appendChild(buildExactField("ym-st-fade-input", "Exact fade duration in seconds", (secs) => {
      chosenFadeMs = secs * 1000;
      renderChips();
    }));

    const swRow = el("div", "ym-st-switch-row");
    swRow.appendChild(el("span", "", "Pause when it goes silent"));
    const sw = el("button", "ym-st-switch");
    sw.id = "ym-st-autopause";
    sw.type = "button";
    sw.setAttribute("role", "switch");
    sw.addEventListener("click", () => {
      autoPause = !autoPause;
      if (mode === "armed") { /* applies at finish time */ }
      render();
    });
    swRow.appendChild(sw);
    root.appendChild(swRow);

    const status = el("div", "ym-st-status");
    status.id = "ym-st-status";
    root.appendChild(status);

    const actions = el("div", "ym-st-actions");
    const go = el("button", "ym-st-go", "Start");
    go.id = "ym-st-go";
    go.type = "button";
    go.addEventListener("click", () => {
      if (mode === "off" || mode === "faded") {
        startTimer({ delayMs: chosenDelayMs, fadeMs: chosenFadeMs, autoPause, endOfTrack });
      } else {
        cancelTimer("Timer cancelled.");
      }
    });
    const cancel = el("button", "ym-st-cancel", "Close");
    cancel.type = "button";
    cancel.addEventListener("click", () => closePopup());
    actions.appendChild(go);
    actions.appendChild(cancel);
    root.appendChild(actions);

    return root;
  }

  function buildDim() {
    const node = el("div", "");
    node.id = DIM_ID;
    node.addEventListener("click", () => closePopup());
    return node;
  }

  function render() {
    if (!popup) return;
    renderChips();
    const sw = popup.querySelector("#ym-st-autopause");
    if (sw) {
      sw.dataset.on = autoPause ? "1" : "0";
      sw.setAttribute("aria-checked", autoPause ? "true" : "false");
    }
    const go = popup.querySelector("#ym-st-go");
    if (go) go.textContent = (mode === "off" || mode === "faded") ? "Start" : "Cancel timer";
    syncExactFields();
    renderCountdown();
  }

  // Only the chips are rebuilt on their own, so typing in an exact field does not
  // tear down and recreate the input the user is typing into.
  function renderChips() {
    if (!popup) return;
    const delayRow = popup.querySelector("#ym-st-delay");
    const fadeRow = popup.querySelector("#ym-st-fade");
    if (delayRow) {
      clear(delayRow);
      DELAY_PRESETS_MIN.forEach((min) => {
        const chip = el("button", "ym-st-chip", min + "m");
        chip.type = "button";
        chip.dataset.on = !endOfTrack && chosenDelayMs === min * 60000 ? "1" : "0";
        chip.addEventListener("click", () => {
          endOfTrack = false;
          chosenDelayMs = min * 60000;
          if (mode === "armed") startTimer({ delayMs: chosenDelayMs, endOfTrack: false });
          render();
        });
        delayRow.appendChild(chip);
      });
      const eot = el("button", "ym-st-chip", "End of track");
      eot.type = "button";
      eot.dataset.on = endOfTrack ? "1" : "0";
      eot.addEventListener("click", () => {
        endOfTrack = true;
        if (mode === "armed") startTimer({ endOfTrack: true });
        render();
      });
      delayRow.appendChild(eot);
    }
    if (fadeRow) {
      clear(fadeRow);
      FADE_PRESETS_S.forEach((s) => {
        const chip = el("button", "ym-st-chip", s + "s");
        chip.type = "button";
        chip.dataset.on = chosenFadeMs === s * 1000 ? "1" : "0";
        chip.addEventListener("click", () => { chosenFadeMs = s * 1000; render(); });
        fadeRow.appendChild(chip);
      });
    }
  }

  // Keep the exact-value inputs showing the live values — but never while the
  // user is typing in one, or the caret fights the value being written back.
  function syncExactFields() {
    if (!popup) return;
    const d = popup.querySelector("#ym-st-delay-input");
    if (d && document.activeElement !== d) d.value = String(Math.round(chosenDelayMs / 1000));
    const f = popup.querySelector("#ym-st-fade-input");
    if (f && document.activeElement !== f) f.value = String(Math.round(chosenFadeMs / 1000));
  }

  function renderCountdown() {
    setStateMarker();
    if (!popup) return;
    const status = popup.querySelector("#ym-st-status");
    if (!status) return;
    clear(status);
    if (mode === "armed") {
      status.appendChild(el("div", "ym-st-count", formatClock(remainingMs)));
      status.appendChild(el("div", "", statusText));
    } else if (mode === "fading") {
      status.appendChild(el("div", "", statusText));
    } else if (mode === "faded") {
      status.appendChild(el("div", "", statusText));
    } else {
      status.appendChild(el("div", "", statusText || "Not running."));
    }
  }

  function openPopup() {
    ensureStyle();
    if (!dim) { dim = buildDim(); document.body.appendChild(dim); }
    if (!popup) { popup = buildPopup(); document.body.appendChild(popup); }
    render();
    requestAnimationFrame(() => {
      if (dim) dim.classList.add("ym-st-dim-on");
      if (popup) popup.classList.add("ym-st-open");
    });
    document.addEventListener("keydown", onKeyDown, true);
  }

  function closePopup() {
    document.removeEventListener("keydown", onKeyDown, true);
    if (dim) dim.classList.remove("ym-st-dim-on");
    if (popup) popup.classList.remove("ym-st-open");
    const d = dim, p = popup;
    setTimeout(() => {
      if (d && d.parentNode && !d.classList.contains("ym-st-dim-on")) d.parentNode.removeChild(d);
      if (p && p.parentNode && !p.classList.contains("ym-st-open")) p.parentNode.removeChild(p);
      if (dim === d) dim = null;
      if (popup === p) popup = null;
    }, 220);
  }

  function onKeyDown(event) {
    if (event.key === "Escape") { event.stopPropagation(); closePopup(); }
  }

  function isOpen() {
    return !!(popup && popup.classList.contains("ym-st-open"));
  }

  // ---- settings ------------------------------------------------------------
  function applySettings(next) {
    settings = Object.assign({}, settings, next || {});
    const master = settings.master !== false;
    if (!master) {
      cancelTimer("");
      if (btnHandle) { btnHandle.remove(); btnHandle = null; }
      closePopup();
      return;
    }
    if (!btnHandle) mountButton();
    if (typeof settings.defaultDelayMin === "number") {
      chosenDelayMs = Math.max(1, settings.defaultDelayMin) * 60000;
    }
    if (typeof settings.defaultFadeSeconds === "number") {
      chosenFadeMs = Math.max(1, settings.defaultFadeSeconds) * 1000;
    }
    if (typeof settings.autoPause === "boolean") autoPause = settings.autoPause;
    render();
  }

  function mountButton() {
    if (!window.YTMod || !window.YTMod.addPlayerBarButton) return;
    btnHandle = window.YTMod.addPlayerBarButton({
      id: "sleep-timer",
      label: "Sleep timer",
      iconSvgPath: ICON_TIMER,
      onClick: () => { if (isOpen()) closePopup(); else openPopup(); },
    });
  }

  // ---- lifecycle -----------------------------------------------------------
  function start() {
    ensureStyle();
    applySettings(settings);
    window.postMessage({ type: "ytmod-settings-request", id: EXT_ID }, "*");
  }

  function teardown() {
    cancelTimer("");
    closePopup();
    document.removeEventListener("keydown", onKeyDown, true);
    if (btnHandle) { btnHandle.remove(); btnHandle = null; }
    if (dim && dim.parentNode) dim.parentNode.removeChild(dim);
    if (popup && popup.parentNode) popup.parentNode.removeChild(popup);
    dim = null;
    popup = null;
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

  whenYTMod(() => {
    start();
  });
})();
