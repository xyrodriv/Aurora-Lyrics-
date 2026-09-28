// Aurora Lyrics — popup.
//
// This used to list every add-on with a toggle, but those controls now live in
// the marketplace panel inside YouTube Music (top-right apps icon), so the
// toolbar popup is only a pointer to it. Keeping a second, partial copy of the
// registry here meant two places to keep in sync for no real benefit.
//
// The only live bits are the status line and the hint: `tab.url` is readable
// exactly when the tab matches our host permissions, so an undefined url is
// itself the "not on YouTube Music" signal — no "tabs" permission needed.
const hint = document.getElementById("hint");

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  const onYouTubeMusic = !!(tab && typeof tab.url === "string" &&
    tab.url.startsWith("https://music.youtube.com/"));

  hint.textContent = onYouTubeMusic
    ? "You're on YouTube Music — the icon is in the top-right corner."
    : "Open YouTube Music to get started.";
  hint.hidden = false;

  if (!onYouTubeMusic || tab.id == null) return;

  // Flash the launcher in the page, so the popup can point at something the user
  // can actually SEE. Fire-and-forget: the content script in the tab may be
  // stale (reloading the extension orphans it), and a missed hint is not worth
  // surfacing — the popup text above already explains what to do.
  try {
    chrome.tabs.sendMessage(tab.id, { type: "ytmod-hint-nav" }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {}
});
