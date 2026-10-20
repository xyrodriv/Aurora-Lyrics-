/* Minimal JSON fetch proxy.
 *
 * Why this exists (AJ, 2026-10-19): in MV3 a content script makes requests "on
 * behalf of the page origin", so it is bound by the page's CORS policy. Most
 * APIs we use send `Access-Control-Allow-Origin: *` (LRCLIB, MusicBrainz,
 * lrc.red) and work directly. api.deezer.com does NOT send that header — it
 * returns Allow-Headers/Allow-Methods/Allow-Credentials but no Allow-Origin —
 * so a content-script fetch to it is blocked, and the existing cover-art code
 * only appeared to work because it swallows the error and falls back to iTunes.
 *
 * Deezer is the ISRC source for lrc.red (YouTube Music exposes no ISRC at all,
 * and MusicBrainz does not carry new releases), so it has to actually work.
 * A service worker runs on the EXTENSION origin and has host_permissions, so it
 * is not subject to the page's CORS policy.
 *
 * Deliberately narrow: one allow-listed host, JSON only, no credentials.
 */

const ALLOWED_HOSTS = new Set(["api.deezer.com"]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "ym-fetch-json") return false;

  let url;
  try {
    url = new URL(String(message.url || ""));
  } catch (_) {
    sendResponse({ ok: false, status: 0, error: "bad url" });
    return false;
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    sendResponse({ ok: false, status: 0, error: "host not allowed" });
    return false;
  }

  fetch(url.href, { headers: { Accept: "application/json" }, credentials: "omit" })
    .then(async (response) => {
      let data = null;
      if (response.ok) {
        try {
          data = await response.json();
        } catch (_) {
          data = null;
        }
      }
      sendResponse({ ok: response.ok, status: response.status, data });
    })
    .catch((error) => {
      sendResponse({ ok: false, status: 0, error: String((error && error.message) || error) });
    });

  // Keep the message channel open for the async response.
  return true;
});
