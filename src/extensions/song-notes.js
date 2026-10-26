/*
 * Song Notes - Aurora Lyrics extension.
 *
 * Per-song notes with clickable timestamps, autosave, undo/redo, delete-with-
 * undo, and a library view of every saved note.
 *
 * Storage is window.localStorage: a page-world add-on has no chrome.* API and
 * content.js exposes no generic key/value bridge (its ytmod-cmd switch covers
 * settings, the registry and the lyric caches only). Two keys are used:
 *   aurora:notes:<videoId>   the note text
 *   aurora:notesindex        { videoId: {title, artist, updatedAt} }
 * The index exists so the library can list titles without asking the player.
 *
 * Timestamps are plain text: a line that starts with [m:ss] renders as a
 * clickable chip that seeks the player. Nothing is built with innerHTML -
 * YouTube Music enforces a Trusted Types CSP and assigning innerHTML throws.
 */
(function () {
  "use strict";

  const EXT_ID = "ytmod-song-notes";
  const NOTE_PREFIX = "aurora:notes:";
  const INDEX_KEY = "aurora:notesindex";
  const DOT = "•";
  const MAX_CHARS = 4000;
  const AUTOSAVE_MS = 700;
  const UNDO_LIMIT = 80;
  const TS_LINE = /^\s*\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*(.*)$/;

  // Bar glyph (see addPlayerBarButton.iconParts): a note page with its lines, at
  // the bar's 2.4 round weight. The other icons in this file stay Material paths
  // because they are drawn at 16px inside our own popup, not in the bar.
  const ICON_NOTE_PARTS = [
    { d: "M6.4 3.6h11.2a2.8 2.8 0 0 1 2.8 2.8v11.2a2.8 2.8 0 0 1-2.8 2.8H6.4a2.8 2.8 0 0 1-2.8-2.8V6.4a2.8 2.8 0 0 1 2.8-2.8Z" },
    { d: "M7.8 8.4h8.4", width: 2.2 },
    { d: "M7.8 12h8.4", width: 2.2 },
    { d: "M7.8 15.6h5.4", width: 2.2 },
  ];
  const ICON_EDIT = "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z";
  const ICON_LIB = "M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z";

  // Static on purpose: no ${} interpolation, so the CSS-template guard has
  // nothing to trip over and the whole block is one literal.
  const CSS = `
    .ym-sn-popup {
      position: fixed;
      z-index: 2147482000;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      width: 340px;
      max-width: calc(100vw - 16px);
      padding: 12px;
      border: 1px solid rgba(255, 255, 255, .1);
      border-radius: 16px;
      background: rgba(24, 24, 26, .82);
      -webkit-backdrop-filter: blur(24px) saturate(1.6);
      backdrop-filter: blur(24px) saturate(1.6);
      box-shadow: 0 18px 50px rgba(0, 0, 0, .55), 0 2px 10px rgba(0, 0, 0, .3);
      color: #fff;
      font: 400 13px/1.45 Roboto, Arial, sans-serif;
      /* Hidden with visibility, NOT display:none - display cannot be
         transitioned, and a hidden-but-laid-out box is still measurable by
         positionPopup(). It grows out of the button, so the origin is bottom. */
      opacity: 0;
      visibility: hidden;
      transform: translateY(10px) scale(.94);
      transform-origin: bottom center;
      transition:
        opacity .16s ease,
        transform .3s cubic-bezier(.16, 1, .3, 1),
        visibility 0s linear .16s;
    }
    .ym-sn-popup.ym-sn-open {
      opacity: 1;
      visibility: visible;
      transform: translateY(0) scale(1);
      transition:
        opacity .14s ease,
        transform .34s cubic-bezier(.16, 1, .3, 1),
        visibility 0s;
    }
    .ym-sn-head {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 10px;
    }
    .ym-sn-title {
      flex: 1 1 auto;
      overflow: hidden;
      font-weight: 600;
      font-size: 13px;
      letter-spacing: .1px;
      white-space: nowrap;
      text-overflow: ellipsis;
      opacity: .95;
    }
    .ym-sn-iconbtn {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: none;
      color: rgba(255, 255, 255, .62);
      cursor: pointer;
      transition: background-color .16s ease, color .16s ease, transform .16s ease;
    }
    .ym-sn-iconbtn:hover { background: rgba(255, 255, 255, .12); color: #fff; }
    .ym-sn-iconbtn:active { transform: scale(.9); }
    .ym-sn-iconbtn svg { width: 16px; height: 16px; fill: currentColor; }
    .ym-sn-close { font-size: 17px; }
    .ym-sn-close:hover { transform: rotate(90deg); }

    .ym-sn-pane {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      animation: ym-sn-fade-in .22s cubic-bezier(.16, 1, .3, 1) both;
    }
    .ym-sn-pane[hidden] { display: none; }

    /* ---- read view ---- */
    .ym-sn-view {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding-right: 2px;
    }
    .ym-sn-view::-webkit-scrollbar { width: 8px; }
    .ym-sn-view::-webkit-scrollbar-thumb { border-radius: 8px; background: rgba(255, 255, 255, .16); }
    .ym-sn-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 5px 0;
      animation: ym-sn-row-in .28s cubic-bezier(.16, 1, .3, 1) both;
    }
    .ym-sn-chip {
      flex: none;
      padding: 3px 8px;
      border: 0;
      border-radius: 999px;
      background: rgba(255, 255, 255, .14);
      color: #fff;
      font: 600 11px/1.25 Roboto, Arial, sans-serif;
      cursor: pointer;
      transition: background-color .16s ease, transform .16s cubic-bezier(.16, 1, .3, 1);
    }
    .ym-sn-chip:hover { background: rgba(255, 255, 255, .28); transform: translateY(-1px); }
    .ym-sn-chip:active { transform: translateY(0) scale(.95); }
    .ym-sn-blank { flex: none; width: 8px; }
    .ym-sn-text {
      flex: 1 1 auto;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
    }
    .ym-sn-empty {
      padding: 20px 6px;
      text-align: center;
      font-size: 12px;
      color: rgba(255, 255, 255, .48);
    }

    /* ---- edit view ---- */
    .ym-sn-area {
      display: block;
      box-sizing: border-box;
      width: 100%;
      min-height: 60px;
      padding: 10px 12px;
      border: 1px solid rgba(255, 255, 255, .1);
      border-radius: 12px;
      background: rgba(0, 0, 0, .32);
      color: #fff;
      font: inherit;
      line-height: 1.5;
      resize: none;
      outline: none;
      flex: 1 1 auto;
      overflow-y: auto;
      transition: border-color .2s ease, background-color .2s ease, box-shadow .2s ease;
    }
    .ym-sn-area::placeholder { color: rgba(255, 255, 255, .38); }
    .ym-sn-area:hover { border-color: rgba(255, 255, 255, .18); }
    .ym-sn-area:focus {
      border-color: rgba(255, 255, 255, .34);
      background: rgba(0, 0, 0, .42);
      box-shadow: 0 0 0 3px rgba(255, 255, 255, .07);
    }
    .ym-sn-area::-webkit-scrollbar { width: 8px; }
    .ym-sn-area::-webkit-scrollbar-thumb { border-radius: 8px; background: rgba(255, 255, 255, .16); }

    .ym-sn-tools {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
    }
    .ym-sn-btn {
      padding: 5px 10px;
      border: 0;
      border-radius: 999px;
      background: rgba(255, 255, 255, .12);
      color: #fff;
      font: 600 11px/1.35 Roboto, Arial, sans-serif;
      cursor: pointer;
      transition: background-color .16s ease, transform .16s cubic-bezier(.16, 1, .3, 1);
    }
    .ym-sn-btn:hover { background: rgba(255, 255, 255, .22); transform: translateY(-1px); }
    .ym-sn-btn:active { transform: translateY(0) scale(.96); }
    .ym-sn-btn:disabled { opacity: .32; pointer-events: none; }
    .ym-sn-danger:hover { background: rgba(255, 92, 92, .34); }
    .ym-sn-spacer { flex: 1 1 auto; }
    .ym-sn-count { font-size: 11px; color: rgba(255, 255, 255, .42); }
    .ym-sn-count-warn { color: #ffb4a2; }

    .ym-sn-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 8px;
    }
    .ym-sn-status {
      flex: 1 1 auto;
      font-size: 11px;
      letter-spacing: .2px;
      color: rgba(255, 255, 255, .55);
      opacity: 0;
      transform: translateY(2px);
      transition: opacity .22s ease, transform .22s ease;
    }
    .ym-sn-status-on { opacity: 1; transform: translateY(0); }
    .ym-sn-err { color: #ff9d8a; }
    .ym-sn-retry {
      border: 0;
      background: none;
      padding: 0;
      color: #ff9d8a;
      font: inherit;
      text-decoration: underline;
      cursor: pointer;
    }
    .ym-sn-save {
      padding: 7px 16px;
      border: 0;
      border-radius: 999px;
      background: rgba(255, 255, 255, .14);
      color: #fff;
      font-weight: 600;
      font-size: 12px;
      cursor: pointer;
      transition: background-color .18s ease, transform .18s cubic-bezier(.16, 1, .3, 1);
    }
    .ym-sn-save:hover { background: rgba(255, 255, 255, .24); transform: translateY(-1px); }
    .ym-sn-save:active { transform: translateY(0) scale(.97); }

    /* ---- toast ---- */
    .ym-sn-toast {
      display: flex;
      align-items: center;
      gap: 10px;
      max-height: 0;
      margin-top: 0;
      padding: 0 10px;
      overflow: hidden;
      border: 0;
      border-radius: 10px;
      background: rgba(0, 0, 0, .45);
      font-size: 12px;
      opacity: 0;
      transform: translateY(6px);
      transition:
        opacity .2s ease,
        transform .24s cubic-bezier(.16, 1, .3, 1),
        max-height .24s ease,
        margin-top .24s ease,
        padding .24s ease;
    }
    .ym-sn-toast-on {
      max-height: 60px;
      margin-top: 8px;
      padding: 8px 10px;
      opacity: 1;
      transform: translateY(0);
    }
    .ym-sn-toast-msg { flex: 1 1 auto; }
    .ym-sn-toast-act {
      border: 0;
      border-radius: 999px;
      padding: 5px 10px;
      background: rgba(255, 255, 255, .18);
      color: #fff;
      font: 600 11px/1 Roboto, Arial, sans-serif;
      cursor: pointer;
      transition: background-color .16s ease;
    }
    .ym-sn-toast-act:hover { background: rgba(255, 255, 255, .3); }

    /* ---- library ---- */
    .ym-sn-lib {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 2147483000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, .55);
      -webkit-backdrop-filter: blur(6px);
      backdrop-filter: blur(6px);
      opacity: 0;
      visibility: hidden;
      transition: opacity .22s ease, visibility 0s linear .22s;
    }
    .ym-sn-lib-open { opacity: 1; visibility: visible; transition: opacity .18s ease, visibility 0s; }
    .ym-sn-lib-card {
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      width: 560px;
      max-width: 100%;
      max-height: 70vh;
      padding: 16px;
      border: 1px solid rgba(255, 255, 255, .1);
      border-radius: 18px;
      background: rgba(24, 24, 26, .92);
      -webkit-backdrop-filter: blur(26px) saturate(1.6);
      backdrop-filter: blur(26px) saturate(1.6);
      box-shadow: 0 24px 70px rgba(0, 0, 0, .6);
      color: #fff;
      font: 400 13px/1.45 Roboto, Arial, sans-serif;
      transform: translateY(12px) scale(.97);
      transition: transform .3s cubic-bezier(.16, 1, .3, 1);
    }
    .ym-sn-lib-open .ym-sn-lib-card { transform: translateY(0) scale(1); }
    .ym-sn-lib-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .ym-sn-lib-title { flex: 1 1 auto; font-weight: 600; font-size: 14px; }
    .ym-sn-lib-search {
      box-sizing: border-box;
      width: 100%;
      padding: 8px 12px;
      margin-bottom: 10px;
      border: 1px solid rgba(255, 255, 255, .12);
      border-radius: 10px;
      background: rgba(0, 0, 0, .32);
      color: #fff;
      font: inherit;
      outline: none;
      transition: border-color .2s ease, box-shadow .2s ease;
    }
    .ym-sn-lib-search:focus {
      border-color: rgba(255, 255, 255, .32);
      box-shadow: 0 0 0 3px rgba(255, 255, 255, .07);
    }
    .ym-sn-lib-list { overflow-y: auto; padding-right: 4px; }
    .ym-sn-lib-list::-webkit-scrollbar { width: 8px; }
    .ym-sn-lib-list::-webkit-scrollbar-thumb { border-radius: 8px; background: rgba(255, 255, 255, .16); }
    .ym-sn-lib-item {
      box-sizing: border-box;
      padding: 10px 12px;
      margin-bottom: 8px;
      border: 1px solid rgba(255, 255, 255, .08);
      border-radius: 12px;
      background: rgba(255, 255, 255, .04);
      animation: ym-sn-row-in .3s cubic-bezier(.16, 1, .3, 1) both;
      transition: background-color .18s ease;
    }
    .ym-sn-lib-item:hover { background: rgba(255, 255, 255, .09); }
    .ym-sn-lib-name { font-weight: 600; font-size: 13px; }
    .ym-sn-lib-sub { margin-top: 2px; font-size: 11px; color: rgba(255, 255, 255, .5); }
    .ym-sn-lib-lines { margin-top: 8px; }
    .ym-sn-lib-empty { padding: 26px 6px; text-align: center; font-size: 12px; color: rgba(255, 255, 255, .48); }

    @keyframes ym-sn-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes ym-sn-row-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

    @media (prefers-reduced-motion: reduce) {
      .ym-sn-popup, .ym-sn-popup.ym-sn-open, .ym-sn-pane, .ym-sn-lib, .ym-sn-lib-card,
      .ym-sn-chip, .ym-sn-btn, .ym-sn-iconbtn, .ym-sn-status, .ym-sn-toast, .ym-sn-area,
      .ym-sn-lib-item, .ym-sn-lib-search, .ym-sn-save, .ym-sn-toast-act {
        transition: none;
        animation: none;
      }
      .ym-sn-popup, .ym-sn-popup.ym-sn-open { transform: none; }
      .ym-sn-lib-card, .ym-sn-lib-open .ym-sn-lib-card { transform: none; }
      .ym-sn-chip:hover, .ym-sn-btn:hover, .ym-sn-save:hover { transform: none; }
    }
  `;

  let buttonHandle = null;
  let popup = null;
  let titleEl = null;
  let viewEl = null;
  let editEl = null;
  let area = null;
  let countEl = null;
  let statusEl = null;
  let saveBtn = null;
  let delBtn = null;
  let undoBtn = null;
  let redoBtn = null;
  let toastEl = null;
  let toastMsgEl = null;
  let toastActEl = null;
  let libEl = null;
  let libListEl = null;
  let libSearchEl = null;

  let editing = false;
  let currentVideoId = null;
  let undoStack = [];
  let redoStack = [];
  let knownText = "";
  let burstBase = null;
  let burstTimer = 0;
  let saveTimer = 0;
  let toastTimer = 0;
  let pollTimer = 0;
  let lastCheckAt = 0;
  let started = false;
  let unsubLines = null;

  /* ---- storage -------------------------------------------------------------
     Every access is wrapped: localStorage can be refused (private mode, quota)
     and a lost note must never break the player. */

  function keyFor(videoId) {
    return NOTE_PREFIX + (videoId || "");
  }

  function loadNotes(videoId) {
    if (!videoId) return "";
    try {
      return window.localStorage.getItem(keyFor(videoId)) || "";
    } catch (e) {
      return "";
    }
  }

  function saveNotes(videoId, text) {
    if (!videoId) return false;
    try {
      const value = String(text || "").slice(0, MAX_CHARS);
      if (value.trim()) {
        window.localStorage.setItem(keyFor(videoId), value);
        upsertIndex(videoId);
      } else {
        window.localStorage.removeItem(keyFor(videoId));
        dropIndex(videoId);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function removeNotes(videoId) {
    if (!videoId) return false;
    try {
      window.localStorage.removeItem(keyFor(videoId));
      dropIndex(videoId);
      return true;
    } catch (e) {
      return false;
    }
  }

  function hasNotes(videoId) {
    const value = loadNotes(videoId);
    return !!(value && value.trim());
  }

  /* The library needs titles without asking the player, so a tiny index of
     {videoId: {title, artist, updatedAt}} rides alongside the note text. */
  function readIndex() {
    try {
      const raw = window.localStorage.getItem(INDEX_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function writeIndex(index) {
    try {
      window.localStorage.setItem(INDEX_KEY, JSON.stringify(index));
      return true;
    } catch (e) {
      return false;
    }
  }

  function upsertIndex(videoId) {
    const track = getTrack();
    const index = readIndex();
    index[videoId] = {
      title: (track && track.title) || (index[videoId] && index[videoId].title) || "Unknown",
      artist: (track && track.artist) || (index[videoId] && index[videoId].artist) || "",
      updatedAt: Date.now(),
    };
    writeIndex(index);
  }

  function dropIndex(videoId) {
    const index = readIndex();
    if (index[videoId]) {
      delete index[videoId];
      writeIndex(index);
    }
  }

  function allNotes() {
    const index = readIndex();
    const out = [];
    for (const videoId of Object.keys(index)) {
      const text = loadNotes(videoId);
      if (!text) continue; // index entry outlived its note
      const meta = index[videoId] || {};
      out.push({
        videoId: videoId,
        title: meta.title || "Unknown",
        artist: meta.artist || "",
        updatedAt: meta.updatedAt || 0,
        text: text,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /* ---- player --------------------------------------------------------------
     getTrack() is the live track - getMediaMeta() does NOT exist on the player,
     and calling a method that is not there would silently keep currentVideoId
     null forever. getTrack() returns null before the player bar renders. */

  function getTrack() {
    try {
      const p = window.YTMod && window.YTMod.player;
      if (p && typeof p.getTrack === "function") return p.getTrack() || null;
    } catch (e) {}
    return null;
  }

  /* The id is the storage key, so getting it wrong silently drops the note.
     getTrack() can be null/empty before the player resolves, so fall back to
     the watch URL, which always carries ?v= on a watch page. */
  function currentVideo() {
    const track = getTrack();
    if (track && track.videoId) return String(track.videoId);
    try {
      const fromUrl = new URLSearchParams(window.location.search).get("v");
      if (fromUrl) return fromUrl;
    } catch (e) {}
    return null;
  }

  function resolveVideoId() {
    return currentVideoId || currentVideo();
  }

  function positionMs() {
    try {
      const p = window.YTMod && window.YTMod.player;
      if (p && typeof p.getPositionMs === "function") {
        const ms = p.getPositionMs();
        return Number.isFinite(ms) ? Math.max(0, ms) : 0;
      }
    } catch (e) {}
    return 0;
  }

  function seekTo(ms) {
    try {
      const p = window.YTMod && window.YTMod.player;
      if (p && typeof p.seek === "function") {
        p.seek(ms);
        return true;
      }
    } catch (e) {}
    return false;
  }

  /* ---- time helpers ------------------------------------------------------*/

  function formatMs(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, "0");
    return h > 0 ? h + ":" + String(m).padStart(2, "0") + ":" + ss : m + ":" + ss;
  }

  function parseClock(value) {
    const parts = String(value).split(":").map(Number);
    if (parts.length < 2 || parts.length > 3) return null;
    for (const n of parts) if (!Number.isFinite(n)) return null;
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    return (parts[0] * 60 + parts[1]) * 1000;
  }

  function clockStamp(epochMs) {
    try {
      return new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }

  function parseEntries(text) {
    const lines = String(text || "").split("\n");
    const out = [];
    for (const line of lines) {
      const match = TS_LINE.exec(line);
      if (match) {
        out.push({ label: match[1], ms: parseClock(match[1]), text: match[2] || "" });
      } else {
        out.push({ label: null, ms: null, text: line });
      }
    }
    return out;
  }

  /* ---- small DOM helpers (no innerHTML - Trusted Types) ------------------*/

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function iconButton(label, path, extraClass) {
    const btn = el("button", "ym-sn-iconbtn" + (extraClass ? " " + extraClass : ""));
    btn.type = "button";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", path);
    svg.appendChild(p);
    btn.appendChild(svg);
    return btn;
  }

  /* ---- popup -------------------------------------------------------------*/

  function ensurePopup() {
    if (popup) return popup;
    popup = el("div", "ym-sn-popup");
    popup.setAttribute("role", "dialog");

    /* header */
    const head = el("div", "ym-sn-head");
    titleEl = el("div", "ym-sn-title");
    const libBtn = iconButton("All notes", ICON_LIB);
    libBtn.addEventListener("click", openLibrary);
    const editBtn = iconButton("Edit note", ICON_EDIT);
    editBtn.addEventListener("click", () => setMode(true));
    const closeBtn = el("button", "ym-sn-iconbtn ym-sn-close", "\u00d7");
    closeBtn.type = "button";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", hidePopup);
    head.appendChild(titleEl);
    head.appendChild(libBtn);
    head.appendChild(editBtn);
    head.appendChild(closeBtn);

    /* read pane */
    viewEl = el("div", "ym-sn-pane ym-sn-view");

    /* edit pane */
    editEl = el("div", "ym-sn-pane");
    area = document.createElement("textarea");
    area.className = "ym-sn-area";
    area.placeholder = "Notes for this song... try  [1:26] vocal chop enters";
    area.spellcheck = true;
    area.maxLength = MAX_CHARS;
    area.addEventListener("input", onInput);
    area.addEventListener("keydown", onAreaKey);

    const tools = el("div", "ym-sn-tools");
    const tsBtn = el("button", "ym-sn-btn", "+ Time");
    tsBtn.type = "button";
    tsBtn.title = "Insert the current playback position";
    tsBtn.addEventListener("click", insertTimestamp);
    undoBtn = el("button", "ym-sn-btn", "Undo");
    undoBtn.type = "button";
    undoBtn.addEventListener("click", doUndo);
    redoBtn = el("button", "ym-sn-btn", "Redo");
    redoBtn.type = "button";
    redoBtn.addEventListener("click", doRedo);
    countEl = el("span", "ym-sn-count");
    tools.appendChild(tsBtn);
    tools.appendChild(undoBtn);
    tools.appendChild(redoBtn);
    tools.appendChild(el("span", "ym-sn-spacer"));
    tools.appendChild(countEl);
    editEl.appendChild(area);
    editEl.appendChild(tools);

    /* footer */
    const foot = el("div", "ym-sn-foot");
    statusEl = el("span", "ym-sn-status");
    delBtn = el("button", "ym-sn-btn ym-sn-danger", "Delete");
    delBtn.type = "button";
    delBtn.addEventListener("click", deleteNote);
    saveBtn = el("button", "ym-sn-save", "Save");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", () => saveNow(false));
    foot.appendChild(statusEl);
    foot.appendChild(delBtn);
    foot.appendChild(saveBtn);

    /* toast (delete-undo / save failure) */
    toastEl = el("div", "ym-sn-toast");
    toastMsgEl = el("span", "ym-sn-toast-msg");
    toastActEl = el("button", "ym-sn-toast-act");
    toastActEl.type = "button";
    toastEl.appendChild(toastMsgEl);
    toastEl.appendChild(toastActEl);

    popup.appendChild(head);
    popup.appendChild(viewEl);
    popup.appendChild(editEl);
    popup.appendChild(foot);
    popup.appendChild(toastEl);
    document.body.appendChild(popup);
    setMode(false);
    return popup;
  }

  function isOpen() {
    return !!(popup && popup.classList.contains("ym-sn-open"));
  }

  function setMode(next) {
    editing = !!next;
    if (viewEl) viewEl.hidden = editing;
    if (editEl) editEl.hidden = !editing;
    if (saveBtn) saveBtn.hidden = !editing;
    syncButtons();
    if (editing && area) area.focus();
  }

  function syncButtons() {
    if (undoBtn) undoBtn.disabled = !undoStack.length;
    if (redoBtn) redoBtn.disabled = !redoStack.length;
    const has = hasNotes(currentVideoId);
    if (delBtn) delBtn.disabled = !has;
  }

  function renderView() {
    if (!viewEl) return;
    while (viewEl.firstChild) viewEl.removeChild(viewEl.firstChild);
    const text = area ? area.value : "";
    if (!text.trim()) {
      viewEl.appendChild(el("div", "ym-sn-empty", "No notes yet. Hit edit to add one."));
      return;
    }
    const entries = parseEntries(text);
    let index = 0;
    for (const entry of entries) {
      const row = el("div", "ym-sn-row");
      // A gentle stagger, capped so a long note never crawls in.
      row.style.animationDelay = Math.min(index, 8) * 22 + "ms";
      index++;
      if (entry.label) {
        const chip = el("button", "ym-sn-chip", entry.label);
        chip.type = "button";
        chip.title = "Jump to " + entry.label;
        const ms = entry.ms;
        chip.addEventListener("click", () => {
          if (ms !== null) seekTo(ms);
        });
        row.appendChild(chip);
      } else {
        row.appendChild(el("span", "ym-sn-blank"));
      }
      row.appendChild(el("span", "ym-sn-text", entry.text));
      viewEl.appendChild(row);
    }
  }

  function refreshHeader() {
    if (!titleEl) return;
    const track = getTrack();
    titleEl.textContent = track
      ? (track.title || "Unknown") + (track.artist ? " - " + track.artist : "")
      : "No track playing";
  }

  /* The Windows taskbar (and other always-on-top OS chrome) overlays the bottom
     of the browser window when the window is not maximized, so
     window.innerHeight is not always the area we can actually draw in. We use
     screen.availTop/Height (the "work area") to get the safe viewport, then
     flip the popup below the button when above does not fit. The popup's
     maxHeight is capped to the safe viewport so the internal panes scroll
     instead of the popup overflowing under the taskbar. */
  function safeViewport() {
    const w = window.innerWidth;
    let h = window.innerHeight;
    try {
      const availTop = window.screen && window.screen.availTop;
      const availHeight = window.screen && window.screen.availHeight;
      const screenY = window.screenY;
      if (typeof availTop === "number" && typeof availHeight === "number" && typeof screenY === "number") {
        const winBottom = Math.max(0, (availTop + availHeight) - screenY);
        h = Math.max(0, Math.min(h, winBottom));
      }
    } catch (e) {}
    return { w: w, h: h };
  }

  function positionPopup() {
    if (!popup || !buttonHandle) return;
    const rect = buttonHandle.el.getBoundingClientRect();
    const margin = 8;
    const gap = 10;
    const viewport = safeViewport();
    const width = Math.min(popup.offsetWidth, viewport.w - margin * 2);
    // Cap height to the safe viewport - the active pane scrolls within.
    const maxHeight = Math.max(140, viewport.h - margin * 2);
    popup.style.maxHeight = maxHeight + "px";
    // Measure with the constrained width/height so the flip calculation is
    // accurate and the popup never claims more space than it actually gets.
    const height = Math.min(popup.offsetHeight, maxHeight);

    let top = rect.top - height - gap;
    const overflowsAbove = top < margin || top + height > viewport.h - margin;
    if (overflowsAbove) {
      const below = rect.bottom + gap;
      if (below + height <= viewport.h - margin) {
        top = below;
      } else {
        // Neither side fits cleanly: pin to whichever side has more room.
        const aboveRoom = rect.top - margin;
        const belowRoom = Math.max(0, viewport.h - margin - rect.bottom);
        top = belowRoom >= aboveRoom
          ? Math.max(margin, viewport.h - height - margin)
          : margin;
      }
    }
    top = Math.max(margin, Math.min(top, viewport.h - height - margin));

    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, viewport.w - width - margin));

    popup.style.width = width + "px";
    popup.style.left = left + "px";
    popup.style.top = top + "px";
  }

  function showPopup() {
    ensurePopup();
    // Re-resolve the key every time: it may have changed (or still be null)
    // since the last open, and loading with a stale id shows an empty box -
    // which reads as "my note is gone" even though it saved fine.
    currentVideoId = resolveVideoId();
    setText(loadNotes(currentVideoId));
    refreshHeader();
    setMode(false);
    setStatus("");
    popup.classList.add("ym-sn-open");
    positionPopup();
    updateDot();
  }

  function hidePopup() {
    if (isOpen() && area) {
      currentVideoId = resolveVideoId();
      saveNotes(currentVideoId, area.value);
      updateDot();
    }
    if (popup) popup.classList.remove("ym-sn-open");
    hideToast();
  }

  function togglePopup() {
    if (isOpen()) hidePopup();
    else showPopup();
  }

  /* ---- editing -----------------------------------------------------------*/

  function setText(value) {
    const next = value || "";
    if (area) area.value = next;
    knownText = next;
    undoStack.length = 0;
    redoStack.length = 0;
    burstBase = null;
    updateCount();
    renderView();
    syncButtons();
  }

  function updateCount() {
    if (!countEl || !area) return;
    const len = area.value.length;
    countEl.textContent = len + " / " + MAX_CHARS;
    countEl.classList.toggle("ym-sn-count-warn", len > MAX_CHARS * 0.9);
  }

  function onInput() {
    if (burstBase === null) burstBase = knownText;
    clearTimeout(burstTimer);
    burstTimer = setTimeout(() => {
      if (burstBase !== null && burstBase !== area.value) {
        undoStack.push(burstBase);
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack.length = 0;
      }
      knownText = area.value;
      burstBase = null;
      syncButtons();
    }, 500);
    updateCount();
    renderView();
    scheduleAutosave();
  }

  function onAreaKey(event) {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    const key = String(event.key || "").toLowerCase();
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      doUndo();
    } else if ((key === "z" && event.shiftKey) || key === "y") {
      event.preventDefault();
      doRedo();
    }
  }

  function doUndo() {
    if (!area || !undoStack.length) return;
    redoStack.push(area.value);
    applyHistory(undoStack.pop());
  }

  function doRedo() {
    if (!area || !redoStack.length) return;
    undoStack.push(area.value);
    applyHistory(redoStack.pop());
  }

  function applyHistory(value) {
    area.value = value || "";
    knownText = area.value;
    burstBase = null;
    updateCount();
    renderView();
    syncButtons();
    saveNow(true);
  }

  function insertTimestamp() {
    if (!area) return;
    const stamp = "[" + formatMs(positionMs()) + "] ";
    const value = area.value;
    const caret = area.selectionStart;
    const before = value.slice(0, caret);
    const after = value.slice(area.selectionEnd);
    const needsBreak = before.length > 0 && !/\n$/.test(before);
    const insert = (needsBreak ? "\n" : "") + stamp;
    const nextValue = (before + insert + after).slice(0, MAX_CHARS);
    undoStack.push(value);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    area.value = nextValue;
    const caretNext = (before + insert).length;
    try {
      area.setSelectionRange(caretNext, caretNext);
    } catch (e) {}
    knownText = nextValue;
    burstBase = null;
    area.focus();
    updateCount();
    renderView();
    syncButtons();
    saveNow(false);
  }

  /* ---- autosave + status --------------------------------------------------*/

  function scheduleAutosave() {
    clearTimeout(saveTimer);
    setStatus("Saving...");
    saveTimer = setTimeout(() => saveNow(true), AUTOSAVE_MS);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    currentVideoId = resolveVideoId();
    const ok = saveNotes(currentVideoId, area ? area.value : "");
    updateDot();
    syncButtons();
    if (!ok) {
      setStatus("");
      showToast("Couldn't save", "Retry", () => {
        hideToast();
        saveNow();
      });
      return;
    }
    setStatus("Saved " + clockStamp(Date.now()));
    hideToast();
  }

  function setStatus(text) {
    if (!statusEl) return;
    const value = text || "";
    statusEl.textContent = value;
    statusEl.classList.toggle("ym-sn-status-on", !!value.trim());
  }

  /* ---- delete + undo toast ------------------------------------------------*/

  let pendingDelete = null;

  function deleteNote() {
    currentVideoId = resolveVideoId();
    if (!currentVideoId) return;
    const text = loadNotes(currentVideoId);
    if (!text) return;
    pendingDelete = { videoId: currentVideoId, text: text };
    removeNotes(currentVideoId);
    setText("");
    updateDot();
    syncButtons();
    setStatus("");
    showToast("Note deleted", "Undo", restoreDeleted);
  }

  function restoreDeleted() {
    if (!pendingDelete) return;
    saveNotes(pendingDelete.videoId, pendingDelete.text);
    if (currentVideoId === pendingDelete.videoId) setText(pendingDelete.text);
    pendingDelete = null;
    updateDot();
    syncButtons();
    hideToast();
    setStatus("Saved " + clockStamp(Date.now()));
  }

  function showToast(message, actionLabel, onAction) {
    if (!toastEl) return;
    toastMsgEl.textContent = message;
    toastActEl.textContent = actionLabel;
    toastActEl.onclick = (event) => {
      event.preventDefault();
      if (typeof onAction === "function") onAction();
    };
    toastEl.classList.add("ym-sn-toast-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      // Only auto-dismiss the delete-undo toast; a save failure stays until
      // it is retried or the popup closes.
      if (actionLabel === "Undo") {
        pendingDelete = null;
        hideToast();
      }
    }, 7000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.classList.remove("ym-sn-toast-on");
  }

  /* ---- library -----------------------------------------------------------*/

  function ensureLibrary() {
    if (libEl) return libEl;
    libEl = el("div", "ym-sn-lib");
    const card = el("div", "ym-sn-lib-card");
    const head = el("div", "ym-sn-lib-head");
    head.appendChild(el("div", "ym-sn-lib-title", "All notes"));
    const closeBtn = el("button", "ym-sn-iconbtn ym-sn-close", "\u00d7");
    closeBtn.type = "button";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", closeLibrary);
    head.appendChild(closeBtn);

    libSearchEl = document.createElement("input");
    libSearchEl.type = "search";
    libSearchEl.className = "ym-sn-lib-search";
    libSearchEl.placeholder = "Search notes...";
    libSearchEl.addEventListener("input", renderLibrary);

    libListEl = el("div", "ym-sn-lib-list");
    card.appendChild(head);
    card.appendChild(libSearchEl);
    card.appendChild(libListEl);
    libEl.appendChild(card);
    libEl.addEventListener("mousedown", (event) => {
      if (event.target === libEl) closeLibrary();
    });
    document.body.appendChild(libEl);
    return libEl;
  }

  function openLibrary() {
    ensureLibrary();
    if (libSearchEl) libSearchEl.value = "";
    renderLibrary();
    libEl.classList.add("ym-sn-lib-open");
  }

  function closeLibrary() {
    if (libEl) libEl.classList.remove("ym-sn-lib-open");
  }

  function renderLibrary() {
    if (!libListEl) return;
    while (libListEl.firstChild) libListEl.removeChild(libListEl.firstChild);
    const query = (libSearchEl && libSearchEl.value || "").trim().toLowerCase();
    const notes = allNotes().filter((note) => {
      if (!query) return true;
      return (note.title + " " + note.artist + " " + note.text).toLowerCase().indexOf(query) !== -1;
    });
    if (!notes.length) {
      libListEl.appendChild(el("div", "ym-sn-lib-empty",
        query ? "No notes match that search." : "No saved notes yet."));
      return;
    }
    let index = 0;
    for (const note of notes) {
      const item = el("div", "ym-sn-lib-item");
      item.style.animationDelay = Math.min(index, 8) * 24 + "ms";
      index++;
      item.appendChild(el("div", "ym-sn-lib-name", note.title));
      const meta = note.artist ? note.artist + " - " : "";
      item.appendChild(el("div", "ym-sn-lib-sub", meta + clockStamp(note.updatedAt)));
      const lines = el("div", "ym-sn-lib-lines");
      const isCurrent = note.videoId === currentVideoId;
      for (const entry of parseEntries(note.text)) {
        const row = el("div", "ym-sn-row");
        if (entry.label) {
          const chip = el("button", "ym-sn-chip", entry.label);
          chip.type = "button";
          // Seeking only makes sense for the song that is actually loaded.
          if (isCurrent) {
            chip.title = "Jump to " + entry.label;
            const ms = entry.ms;
            chip.addEventListener("click", (event) => {
              event.stopPropagation();
              if (ms !== null) seekTo(ms);
            });
          } else {
            chip.disabled = true;
            chip.style.opacity = ".5";
            chip.style.cursor = "default";
          }
          row.appendChild(chip);
        } else {
          row.appendChild(el("span", "ym-sn-blank"));
        }
        row.appendChild(el("span", "ym-sn-text", entry.text));
        lines.appendChild(row);
      }
      item.appendChild(lines);
      libListEl.appendChild(item);
    }
  }

  /* ---- indicator ---------------------------------------------------------*/

  function updateDot() {
    if (buttonHandle) buttonHandle.setBadge(hasNotes(currentVideoId) ? DOT : "");
  }

  /* ---- track change -------------------------------------------------------
     lyrics:lines fires the moment the lyrics are (re)built, so it is the
     fastest signal. The poll covers everything else - songs with no synced
     lyrics at all, where that topic never fires. */

  function onLines(payload) {
    if (!payload) return;
    const videoId = payload.videoId ? String(payload.videoId) : null;
    if (videoId && videoId !== currentVideoId) applyNewTrack(videoId);
  }

  function applyNewTrack(videoId) {
    const open = isOpen();
    // Never lose what is being typed: flush the old song before swapping.
    if (open && area) saveNotes(currentVideoId, area.value);
    currentVideoId = videoId;
    if (open) {
      setText(loadNotes(currentVideoId));
      refreshHeader();
      setStatus("");
      setMode(false);
      positionPopup();
    }
    updateDot();
  }

  function poll() {
    const now = performance.now();
    if (now - lastCheckAt < 800) return;
    lastCheckAt = now;
    const videoId = currentVideo();
    if (videoId !== currentVideoId) applyNewTrack(videoId);
  }

  /* ---- dismiss ------------------------------------------------------------
     Capture phase, because addPlayerBarButton stops propagation on the button's
     own click. Clicks inside the popup / library (or on the button) must not
     close it. */

  function onDocClick(event) {
    if (libEl && libEl.classList.contains("ym-sn-lib-open")) return;
    if (!isOpen()) return;
    if (popup.contains(event.target)) return;
    if (buttonHandle && buttonHandle.el.contains(event.target)) return;
    hidePopup();
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      if (libEl && libEl.classList.contains("ym-sn-lib-open")) closeLibrary();
      else hidePopup();
    }
  }

  /* ---- lifecycle ---------------------------------------------------------*/

  function injectStyles() {
    if (document.getElementById("ym-sn-style")) return;
    const style = document.createElement("style");
    style.id = "ym-sn-style";
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildUI() {
    injectStyles();
    ensurePopup();
    if (!buttonHandle) {
      buttonHandle = window.YTMod.addPlayerBarButton({
        id: "song-notes",
        label: "Song notes",
        iconParts: ICON_NOTE_PARTS,
        onClick: togglePopup,
      });
    }
    if (!buttonHandle) {
      // The player bar is not in the DOM yet - retry rather than give up.
      setTimeout(buildUI, 500);
      return;
    }
    if (started) return;
    started = true;
    currentVideoId = currentVideo();
    updateDot();
    if (!pollTimer) pollTimer = setInterval(poll, 250);
    const bus = window.YTMod.bus;
    if (bus && bus.on) unsubLines = bus.on("lyrics:lines", onLines, { replay: true });
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKeyDown, true);
  }

  function teardown() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
    if (unsubLines) {
      unsubLines();
      unsubLines = null;
    }
    clearTimeout(saveTimer);
    clearTimeout(burstTimer);
    clearTimeout(toastTimer);
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (popup) popup.remove();
    if (libEl) libEl.remove();
    popup = null;
    libEl = null;
    area = null;
    titleEl = null;
    viewEl = null;
    editEl = null;
    countEl = null;
    statusEl = null;
    saveBtn = null;
    delBtn = null;
    undoBtn = null;
    redoBtn = null;
    toastEl = null;
    toastMsgEl = null;
    toastActEl = null;
    libListEl = null;
    libSearchEl = null;
    if (buttonHandle) buttonHandle.remove();
    buttonHandle = null;
    const style = document.getElementById("ym-sn-style");
    if (style) style.remove();
    started = false;
    currentVideoId = null;
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.id !== EXT_ID) return;
    if (data.type !== "ytmod-ext") return;
    if (data.action === "disable") teardown();
  });

  function whenYTMod(callback) {
    if (window.YTMod && window.YTMod.player) return callback();
    setTimeout(() => whenYTMod(callback), 200);
  }

  whenYTMod(buildUI);
})();
