/* Aurora website -> extension handoff.
 *
 * The website announces the signed-in maker's public display name, avatar, and
 * profile URL. This isolated-world content script stores only those public
 * fields; the website session token never leaves localStorage.
 */
(function () {
  "use strict";
  const IDENTITY_KEY = "auroraMakerIdentity";
  const AVATAR_RE = /^https:\/\/cdn\.discordapp\.com\//i;

  function normalizeProfileUrl(value) {
    if (typeof value !== "string") return "";
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin) return "";
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      if (url.pathname !== "/community" && url.pathname !== "/community/") return "";
      if (!url.searchParams.get("maker")) return "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function normalizeIdentity(value) {
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

  function writeIdentity(value) {
    const identity = normalizeIdentity(value);
    try {
      if (identity) chrome.storage.local.set({ [IDENTITY_KEY]: identity });
      else chrome.storage.local.remove(IDENTITY_KEY);
    } catch (_) {}
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data) return;

    if (data.type === "aurora-maker-session") writeIdentity(data.session);
  });
})();
