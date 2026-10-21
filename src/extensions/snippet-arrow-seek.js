/*
 * Snippet — "Arrow-key seeking".
 *
 * v0.1.0.
 *
 * AJ (2026-10-20): YouTube Music does not let you scrub a song with the arrow
 * keys, even though every other player does. Left/Right currently do nothing on
 * the player page, so this claims them.
 *
 * WHAT IT DOES
 *   ArrowLeft  / ArrowRight  -> seek back / forward by "Skip step" (default 5s)
 *   Shift+Left / Shift+Right -> seek back / forward by 3x that step
 *   Holding the key repeats (no `event.repeat` guard) so you can scrub.
 *
 * The step is a SETTING (1-30s), pushed over the usual ytmod-settings message, so
 * the snippet never needs a reload when it changes.
 *
 * DELIBERATE CHOICES
 *   - Capture phase, so we run before YouTube's own handlers. We only call
 *     preventDefault() on the paths we actually handle, so anything we do not
 *     claim keeps its default behaviour.
 *   - Ctrl / Meta / Alt combinations are IGNORED entirely. Those are browser and
 *     OS shortcuts (Ctrl+Left is "back a word", Cmd+Left is history), and
 *     swallowing them would be worse than not having the feature.
 *   - Typing is never intercepted: if the event target is an input, textarea,
 *     select or contenteditable, we bail. That covers YTM's search box, the
 *     lyrics offset inputs and the Report textarea.
 *   - The seek is clamped to [0, duration]. YTMod.player.seek() already falls
 *     back to the media element when seekTo() silently no-ops on some builds.
 *   - No visual feedback of its own: the player bar's own progress readout moves,
 *     which is enough. A toast here would be noise.
 */
(function () {
  "use strict";

  const EXT_ID = "snippet-arrow-seek";
  const TAG = "[snippet:arrow-seek]";
  const DEFAULT_STEP_SECONDS = 5;
  const MAX_STEP_SECONDS = 30;
  const LARGE_MULTIPLIER = 3; // Shift

  let armed = false;
  let onKeyDown = null;
  let stepMs = DEFAULT_STEP_SECONDS * 1000;

  function isTypingTarget(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (node.isContentEditable) return true;
    // Some YTM fields are wrappers around an inner input.
    return !!(node.closest && node.closest("input, textarea, select, [contenteditable='true']"));
  }

  function arm() {
    if (armed) return;
    armed = true;

    onKeyDown = (event) => {
      if (event.defaultPrevented) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // Browser / OS shortcuts win. Shift is ours, the rest are not.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      const player = window.YTMod && window.YTMod.player;
      if (!player || typeof player.seek !== "function") return;
      if (typeof player.getPositionMs !== "function") return;

      const position = player.getPositionMs();
      if (!Number.isFinite(position)) return;

      const delta = (event.shiftKey ? stepMs * LARGE_MULTIPLIER : stepMs) *
        (event.key === "ArrowRight" ? 1 : -1);
      let target = position + delta;

      if (typeof player.getDurationMs === "function") {
        const duration = player.getDurationMs();
        if (Number.isFinite(duration) && duration > 0) {
          target = Math.min(duration - 250, target); // stop just shy of the end
        }
      }
      target = Math.max(0, target);

      // Only now do we claim the key, so unhandled arrows keep their default.
      event.preventDefault();
      event.stopPropagation();
      player.seek(target);
    };

    window.addEventListener("keydown", onKeyDown, true);
    console.log(TAG, "armed — ArrowLeft/Right seek 5s (Shift 15s)");
  }

  function teardown() {
    if (!armed) return;
    armed = false;
    if (onKeyDown) {
      window.removeEventListener("keydown", onKeyDown, true);
      onKeyDown = null;
    }
    console.log(TAG, "torn down");
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.id !== EXT_ID) return;
    if (data.type === "ytmod-settings") {
      // Clamp on THIS side too: a stored value can predate the slider's range.
      const seconds = Number(data.settings && data.settings.step);
      stepMs = (Number.isFinite(seconds)
        ? Math.min(MAX_STEP_SECONDS, Math.max(1, seconds))
        : DEFAULT_STEP_SECONDS) * 1000;
      return;
    }
    if (data.type !== "ytmod-ext") return;
    if (data.action === "disable") teardown();
  });

  // Ask for the saved settings BEFORE arming, so the very first keypress already
  // uses the user's step instead of the default.
  try { window.postMessage({ type: "ytmod-settings-request", id: EXT_ID }, "*"); } catch (e) {}

  arm();
})();
