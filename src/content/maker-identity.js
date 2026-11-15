/* Public maker identity for the community-offset form.
 *
 * The website bridge stores the signed-in maker's display name, avatar, and
 * public profile URL. The page world cannot read chrome.storage, so this
 * isolated content script forwards only those public fields. The request
 * message lets the page ask again if it mounted after the first announcement.
 */
(function () {
  "use strict";
  const KEY = "auroraMakerIdentity";
  const AVATAR_RE = /^https:\/\/cdn\.discordapp\.com\//i;

  function normalizeProfileUrl(value) {
    if (typeof value !== "string") return "";
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      if (url.pathname !== "/community" && url.pathname !== "/community/") return "";
      if (!url.searchParams.get("maker")) return "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function normalize(value) {
    if (!value || typeof value !== "object") return null;
    const username = typeof value.username === "string"
      ? value.username.trim().slice(0, 24)
      : "";
    if (!username) return null;
    const avatar = typeof value.avatar === "string" && AVATAR_RE.test(value.avatar)
      ? value.avatar
      : "";
    const profileUrl = normalizeProfileUrl(value.profileUrl);
    return { username, avatar, profileUrl };
  }

  function post(value) {
    try {
      window.postMessage({
        source: "aurora-maker-identity",
        identity: normalize(value),
      }, location.origin);
    } catch (_) {}
  }

  function read() {
    try {
      chrome.storage.local.get([KEY], (data) => {
        void chrome.runtime.lastError;
        post(data && data[KEY]);
      });
    } catch (_) {}
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    if (!event.data || event.data.type !== "aurora-maker-identity-request") return;
    read();
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[KEY]) return;
      post(changes[KEY].newValue);
    });
  } catch (_) {}

  read();
})();
