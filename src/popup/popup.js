// Aurora Lyrics — toolbar popup.
//
// The add-on switches live in the marketplace panel inside YouTube Music, so the
// popup is not a second control surface. It answers the two questions that make
// someone click the icon: "is it working on this song?" and "what do I send when
// it isn't?". One read-only snapshot is requested from the content script
// (ytmod-diagnostics) and rendered here; nothing is toggled or stored.
const $ = (id) => document.getElementById(id);

const ui = {
  ver: $("ver"),
  status: $("status"),
  statusText: $("statusText"),
  now: $("now"),
  art: $("art"),
  artFallback: $("artFallback"),
  title: $("trackTitle"),
  artist: $("trackArtist"),
  facts: $("facts"),
  renderer: $("fRenderer"),
  panel: $("fPanel"),
  addons: $("fAddons"),
  errorRow: $("errorRow"),
  error: $("fError"),
  openBtn: $("openBtn"),
  copyBtn: $("copyBtn"),
};

const SITE = "https://music.youtube.com/";
const COPY_RESET_MS = 1500;

let snapshot = null; // last reply from the page, also the copy payload
let tabId = null;

function setStatus(state, text) {
  ui.status.dataset.state = state;
  ui.statusText.textContent = text;
}

function setActionsEnabled(on) {
  ui.openBtn.disabled = !on;
  ui.copyBtn.disabled = !on;
}

/* ---- version ------------------------------------------------------------ */
// Read from the manifest rather than hardcoding: a version string that can drift
// from manifest.json is worse than none.
try {
  const manifest = chrome.runtime.getManifest();
  if (manifest && manifest.version) ui.ver.textContent = "v" + manifest.version;
} catch (_) {
  /* Opened outside the extension (or a stale context): leave the chip empty. */
}

/* ---- rendering ---------------------------------------------------------- */
function paintStatusLine() {
  // Reaching this point means the page answered, which is the only claim the
  // popup can make. "Playing" would be wrong the moment the track is paused.
  setStatus("on", "YouTube Music connected");
}

function paintTrack(track) {
  const hasTrack = !!(track && track.title);
  ui.now.hidden = false;
  ui.title.textContent = hasTrack ? track.title : "Nothing playing";
  ui.artist.textContent = hasTrack ? (track.artist || "Unknown artist") : "Start a song to inspect its lyrics";

  const art = hasTrack && track.art ? track.art : "";
  // Monogram fallback: a broken <img> is the one thing that makes a popup look
  // abandoned, and the player bar's art URL can go stale mid-track.
  ui.now.classList.toggle("no-art", !art);
  ui.artFallback.textContent = hasTrack ? (track.title.trim().charAt(0) || "?").toUpperCase() : "?";
  if (!art) {
    ui.art.removeAttribute("src");
    ui.art.hidden = true;
    return;
  }
  ui.art.hidden = false;
  ui.art.onerror = () => ui.now.classList.add("no-art");
  ui.art.src = art;
}

function paintFacts(snap) {
  ui.renderer.textContent = snap.renderer === "amll" ? "Apple Music style" : "Standard";
  ui.panel.textContent = !snap.panel ? "Not mounted" : (snap.fullscreen ? "Fullscreen" : "Mounted");

  const addons = snap.addons || { installed: 0, enabled: 0, names: [] };
  ui.addons.textContent = addons.installed
    ? addons.enabled + " of " + addons.installed + " on"
    : "None installed";
  if (addons.names && addons.names.length) ui.addons.title = addons.names.join(", ");

  const err = snap.error;
  if (err && err.text) {
    ui.error.textContent = err.text;
    ui.error.title = (err.kind ? "[" + err.kind + "] " : "") + err.text;
    ui.errorRow.hidden = false;
  } else {
    ui.errorRow.hidden = true;
  }

  ui.facts.hidden = false;
}

/* ---- copy block --------------------------------------------------------- */
function relTime(ms) {
  if (!ms) return "";
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + " min ago";
  return Math.round(mins / 60) + " h ago";
}

function browserVersion() {
  const match = /(?:Chrome|Chromium)\/(\d+(?:\.\d+)?)/.exec(navigator.userAgent || "");
  return match ? "Chrome " + match[1] : (navigator.userAgent || "unknown");
}

function buildCopyText(snap) {
  const track = snap.track || {};
  const addons = snap.addons || { installed: 0, enabled: 0, names: [] };
  const lines = [
    "Aurora Lyrics " + (ui.ver.textContent || "v?"),
    "URL:      " + (snap.url || "-"),
    "Track:    " + (track.title ? track.title + " - " + (track.artist || "unknown artist") : "nothing playing"),
    "Renderer: " + (snap.renderer === "amll" ? "Apple Music style" : "Standard"),
    "Panel:    " + (!snap.panel ? "not mounted" : (snap.fullscreen ? "fullscreen" : "mounted")),
    "Add-ons:  " + addons.enabled + " of " + addons.installed + " on" +
      (addons.names && addons.names.length ? " (" + addons.names.join(", ") + ")" : ""),
    "Viewport: " + (snap.viewport || "?") + (snap.dpr ? " @" + snap.dpr + "x" : ""),
  ];
  if (snap.error && snap.error.text) {
    const when = relTime(snap.error.at);
    lines.push("Error:    [" + (snap.error.kind || "error") + "] " + snap.error.text + (when ? " (" + when + ")" : ""));
  }
  lines.push("Browser:  " + browserVersion());
  return lines.join("\n");
}

async function copyText(text) {
  // Extension pages are secure contexts, and a click is a user gesture, so the
  // async clipboard path normally just works. The textarea fallback covers the
  // cases where the document lost focus while the message round-trip ran.
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {}
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

let copyTimer = 0;
function flashCopied(ok) {
  if (copyTimer) window.clearTimeout(copyTimer);
  if (!ok) {
    const idle = ui.copyBtn.querySelector(".swap-idle");
    if (idle) {
      idle.textContent = "Copy failed";
      copyTimer = window.setTimeout(() => { idle.textContent = "Copy diagnostics"; }, COPY_RESET_MS);
    }
    return;
  }
  ui.copyBtn.classList.add("copied");
  ui.copyBtn.setAttribute("aria-label", "Diagnostics copied");
  copyTimer = window.setTimeout(() => {
    ui.copyBtn.classList.remove("copied");
    ui.copyBtn.setAttribute("aria-label", "Copy diagnostics");
  }, COPY_RESET_MS);
}

/* ---- wire up ------------------------------------------------------------ */
ui.copyBtn.addEventListener("click", async () => {
  if (!snapshot) return;
  flashCopied(await copyText(buildCopyText(snapshot)));
});

ui.openBtn.addEventListener("click", () => {
  if (tabId == null || typeof chrome === "undefined" || !chrome.tabs) return;
  // The marketplace lives in the page, so this popup is done the moment it opens.
  try {
    chrome.tabs.sendMessage(tabId, { type: "ytmod-open" }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {}
  window.setTimeout(() => window.close(), 90);
});

const extensionContext = typeof chrome !== "undefined" && chrome.tabs && chrome.runtime;
if (!extensionContext) {
  setStatus("off", "Open YouTube Music to see diagnostics.");
  setActionsEnabled(false);
} else {
  setActionsEnabled(false);
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    // tab.url is readable exactly when the tab matches our host permissions, so
    // an undefined url is itself the "not on YouTube Music" signal.
    const onSite = !!(tab && typeof tab.url === "string" && tab.url.startsWith(SITE));

    if (!onSite) {
      setStatus("off", "Open YouTube Music to see diagnostics.");
      return;
    }

    tabId = tab.id;
    setStatus("checking", "Reading this tab\u2026");

    if (tabId == null) {
      setStatus("warn", "Reload YouTube Music to reconnect.");
      return;
    }

    try {
      chrome.tabs.sendMessage(tabId, { type: "ytmod-diagnostics" }, (reply) => {
        // A missed reply is a stale content script (page loaded before an
        // extension reload). Say so plainly instead of spinning forever.
        if (chrome.runtime.lastError || !reply) {
          setStatus("warn", "Reload YouTube Music to refresh.");
          return;
        }
        snapshot = reply;
        paintStatusLine(reply);
        paintTrack(reply.track);
        paintFacts(reply);
        setActionsEnabled(true);
      });
    } catch (_) {
      setStatus("warn", "Reload YouTube Music to refresh.");
    }
  });
}
