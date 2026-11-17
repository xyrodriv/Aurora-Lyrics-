/* Minimal JSON POST proxy for reports and feedback.
 *
 * Why this exists (AJ, 2026-10-19): in MV3 a content script makes requests "on
 * behalf of the page origin", so it is bound by the page's CORS policy. Most
 * APIs we use send `Access-Control-Allow-Origin: *` (LRCLIB, Unison,
 * MusicBrainz) and work directly from the content script, so they need no
 * worker at all.
 *
 * A worker runs on the EXTENSION origin and carries host_permissions, so it is
 * not subject to the page's CORS policy - which is why the one endpoint that
 * needs a POST with a JSON body goes through here.
 *
 * The general JSON-fetch proxy that used to sit beside this was built for
 * api.deezer.com, which sent no Allow-Origin header. That host permission is
 * gone (AJ, 2026-11-16), so the proxy went with it: this worker can now only
 * reach the reporting endpoint, by host AND path.
 */

const REPORT_HOSTS = new Set(["aurora-community-api.mitsyonsp.workers.dev"]);
const REPORT_PATH = "/v1/reports";
const REPORT_BODY_MAX = 8 * 1024;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;
  if (message.type !== "ym-post-report") return false;

  // Reports and feedback: POST JSON to the ONE reporting endpoint, allow-listed
  // by host AND path so this proxy can never be pointed anywhere else. The
  // Discord token lives on the server; the extension never holds it.
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

  // Keep the message channel open for the async response.
  return true;
});
