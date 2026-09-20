/*
 * Keyboard Shortcuts — Aurora Lyrics extension.
 *
 * Adds page-level shortcuts while you're on YouTube Music:
 *   Alt + L : toggle the Synced Lyrics panel
 *   Alt + M : open the Aurora Lyrics Marketplace
 *
 * Bindings match on event.code (keyboard-layout independent) and are ignored
 * while you're typing in an input/textarea. Alt+combinations are used so they
 * don't collide with YouTube's own single-key shortcuts (j/l/k/f/m/...).
 */
(function () {
  "use strict";

  const EXT_ID = "ytmod-keyboard-shortcuts";

  const DEFAULT_SETTINGS = {
    togglePanel: true,
    openMarketplace: true,
  };
  let currentSettings = Object.assign({}, DEFAULT_SETTINGS);

  function applySettings(next) {
    currentSettings = Object.assign({}, currentSettings, next || {});
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  // Alt + L — toggle the Synced Lyrics panel by clicking its tab.
  function toggleLyricsPanel() {
    if (currentSettings.togglePanel === false) return false;
    const tab = document.querySelector("tp-yt-paper-tab.ym-sl-tab");
    if (tab) {
      tab.click();
      return true;
    }
    console.warn("[Aurora Lyrics Shortcuts] Lyrics panel toggle: SYNCED tab not found (is the lyrics extension enabled / on a song?).");
    return false;
  }

  // Alt + M — open the Aurora Lyrics Marketplace.
  function openMarketplace() {
    if (currentSettings.openMarketplace === false) return false;
    if (window.YTMod && typeof window.YTMod.openMarketplace === "function") {
      window.YTMod.openMarketplace();
      return true;
    }
    console.warn("[Aurora Lyrics Shortcuts] Aurora Lyrics marketplace unavailable.");
    return false;
  }

  function handleKeydown(e) {
    // Alt + a letter/code only; ignore Ctrl/AltGr/Meta combos and typing contexts.
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (isTypingTarget(e.target)) return;
    let handled = false;
    if (e.code === "KeyL") handled = toggleLyricsPanel();
    else if (e.code === "KeyM") handled = openMarketplace();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.id !== EXT_ID) return;
    if (data.type === "ytmod-settings") {
      applySettings(data.settings);
      return;
    }
    if (data.type !== "ytmod-ext") return;
    if (data.action === "disable") teardown();
  });

  function teardown() {
    document.removeEventListener("keydown", handleKeydown, true);
  }

  document.addEventListener("keydown", handleKeydown, true);
  window.postMessage({ type: "ytmod-settings-request", id: EXT_ID }, "*");

  console.log("[Aurora Lyrics] Keyboard Shortcuts ready — Alt+L panel, Alt+M marketplace");
})();
