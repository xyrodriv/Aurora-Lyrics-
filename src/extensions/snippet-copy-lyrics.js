/*
 * Snippet — "Copy lyrics".
 *
 * v0.1.0.
 *
 * AJ asked for a button that copies the WHOLE currently-loaded song's lyrics to
 * the clipboard. The lyrics panel (#ym-sl-panel.SpicyRenderer) already has a
 * .ym-sl-tools-scroll toolbar (it holds the "Options" button), so this drops a
 * "Copy lyrics" button next to it.
 *
 * WHERE THE TEXT COMES FROM
 *   The panel renders every line as a .line element inside .VirtualLyricsContainer
 *   (the name is legacy — there is no scroll windowing; all lines are in the DOM
 *   at once). So copying is just: read every .line's text, in document order.
 *   - Each .line may carry a .translation child (a display-only gloss); that
 *     is stripped so we copy the sung text, not the English underneath it.
 *   - Background-vocal lines (.bg-line) are kept — they are part of the song.
 *   - The empty-state placeholder and the credits footer are not .line elements,
 *     so they are naturally excluded.
 *
 * LIFECYCLE
 *   content.js injects this script and then posts {type:"ytmod-ext", id,
 *   action:"enable"}; on disable it posts "disable" and removes the script 60ms
 *   later. We auto-arm at load (mirrors the track-toast snippet) which sidesteps
 *   the race where the enable message is posted before this file's listener
 *   exists. We only listen for "disable".
 *
 * THE BUTTON IS RE-INJECTED, NOT PERMANENT
 *   The panel element is owned by the aurora-lyrics add-on and can be rebuilt
 *   (e.g. on an extension reload) — that would orphan our button with the old
 *   panel. A slow interval re-runs ensureButton(), so the button comes back
 *   whenever the panel/toolbar exist without it. The button is tagged with a
 *   stable class so re-runs never stack duplicates.
 */
(function () {
  "use strict";

  const EXT_ID = "snippet-copy-lyrics";
  const TAG = "[snippet:copy-lyrics]";
  const BTN_CLASS = "ym-sl-copy-lyrics-btn";
  const POLL_MS = 1500;
  const FLASH_MS = 1500;
  const DEFAULT_LABEL = "Copy lyrics";

  let armed = false;
  let poll = 0;
  let btn = null;

  // Read every .line's text, in document order, with the display-only sub-lines
  // (the on-device translation) stripped: copying lyrics should give the sung
  // words, not the gloss underneath them.
  function extractLyrics() {
    const panel = document.querySelector("#ym-sl-panel.SpicyRenderer");
    if (!panel) return "";
    const root =
      panel.querySelector(".VirtualLyricsContainer") ||
      panel.querySelector(".LyricsContent");
    if (!root) return "";
    const lines = root.querySelectorAll(".line");
    const out = [];
    lines.forEach((line) => {
      const clone = line.cloneNode(true);
      clone.querySelectorAll(".translation").forEach((r) => r.remove());
      const t = (clone.textContent || "").replace(/[ \t]+/g, " ").trim();
      if (t) out.push(t);
    });
    return out.join("\n");
  }

  // Clipboard write with a legacy fallback for insecure/denied contexts.
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      console.log(TAG, "clipboard API failed, trying fallback:", String(e && e.message));
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      console.log(TAG, "fallback copy failed:", String(e && e.message));
      return false;
    }
  }

  function flash(msg) {
    if (!btn) return;
    btn.textContent = msg;
    if (btn._flashTimer) clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => {
      if (btn) btn.textContent = DEFAULT_LABEL;
    }, FLASH_MS);
  }

  async function onCopy() {
    const text = extractLyrics();
    if (!text) {
      flash("No lyrics");
      return;
    }
    const ok = await copyText(text);
    flash(ok ? "Copied!" : "Copy failed");
    console.log(TAG, ok ? "copied " + text.length + " chars" : "copy failed");
  }

  // (Re)create the button if the toolbar exists without it.
  function ensureButton() {
    const scroll = document.querySelector(
      "#ym-sl-panel.SpicyRenderer .ym-sl-tools-scroll"
    );
    if (!scroll) return;
    if (scroll.querySelector("." + BTN_CLASS)) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ym-sl-import " + BTN_CLASS;
    b.textContent = DEFAULT_LABEL;
    b.title = "Copy the full lyrics to the clipboard";
    b.setAttribute("aria-label", "Copy lyrics");
    b.addEventListener("click", onCopy);
    scroll.appendChild(b);
    btn = b;
    console.log(TAG, "button injected");
  }

  function arm() {
    if (armed) return;
    armed = true;
    ensureButton();
    poll = window.setInterval(ensureButton, POLL_MS);
    console.log(TAG, "armed — Copy lyrics button watching the panel");
  }

  function teardown() {
    if (!armed) return;
    armed = false;
    if (poll) {
      window.clearInterval(poll);
      poll = 0;
    }
    if (btn && btn.parentElement) {
      try { btn.remove(); } catch (e) {}
    }
    btn = null;
    console.log(TAG, "torn down");
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "ytmod-ext" || data.id !== EXT_ID) return;
    if (data.action === "disable") teardown();
  });

  arm();
})();
