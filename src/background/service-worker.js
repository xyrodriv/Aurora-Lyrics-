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

const REPORT_HOSTS = new Set(["site-5aa52a9653ee459eaa8c6b433dad2937.freebuff.page"]);
const REPORT_PATH = "/v1/reports";
const REPORT_BODY_MAX = 8 * 1024;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

  // Reports and feedback: POST JSON to the ONE reporting endpoint, allow-listed
  // by host AND path so this proxy can never be pointed anywhere else. The
  // Discord token lives on the server; the extension never holds it.
  if (message.type === "ym-post-report") {
    let url;
    try {
      url = new URL(String(message.url || ""));
    } catch (_) {
      sendResponse({ ok: false, status: 0 });
      return false;
    }
    const body = typeof message.body === "string" ? message.body : "";
    if (
      url.protocol !== "https:" ||
      !REPORT_HOSTS.has(url.hostname) ||
      url.pathname !== REPORT_PATH ||
      !body ||
      body.length > REPORT_BODY_MAX
    ) {
      sendResponse({ ok: false, status: 0 });
      return false;
    }
    fetch(url.href, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    })
      .then(async (response) => {
        let data = null;
        try {
          data = await response.json();
        } catch (_) {
          data = null;
        }
        sendResponse({ ok: response.ok, status: response.status, data });
      })
      .catch(() => sendResponse({ ok: false, status: 0 }));
    return true;
  }

  if (message.type !== "ym-fetch-json") return false;

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
