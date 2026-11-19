// Aurora Lyrics — toolbar popup.
//
// The Add-ons tab is a compact version of the YouTube Music marketplace: same
// catalogue, categories, install/toggle flow and settings, sized for the popup.
// The other two tabs answer the two
// questions that make someone click the icon: "is it working on this song?" and
// "what do I send when it isn't?" (one read-only diagnostics snapshot).
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
  tabBar: document.querySelector(".tabs"),
  pages: $("pages"),
  pagesTrack: $("pagesTrack"),
  mkList: $("mkList"),
  mk: $("mk"),
  mkOff: $("mkOff"),
  mkOffOpen: $("mkOffOpen"),
  embedSwitch: $("embedSwitch"),
  mkDetailView: $("mkDetailView"),
  mkTabs: $("mkTabs"),
  mkRows: $("mkRows"),
  mkSearch: $("mkSearch"),
  mkDetail: $("mkDetail"),
  mkBack: $("mkBack"),
  whatsNew: $("whatsNew"),
};

// The status pill is gone from the markup: the popup is a snapshot, not a
// dashboard. Stubs keep every caller in this file valid.
ui.status = ui.status || { dataset: {}, classList: { add() {}, remove() {}, toggle() {} } };
ui.statusText = ui.statusText || { textContent: "" };

const SITE = "https://music.youtube.com/";
const COPY_RESET_MS = 1500;
const YT_URL = "https://music.youtube.com/*";

let snapshot = null; // last reply from the page, also the copy payload
let tabId = null;

function setStatus(state, text) {
  ui.status.dataset.state = state;
  ui.statusText.textContent = text;
}

function setActionsEnabled(on) {
  // The marketplace now lives in this popup, so its button must still work when
  // no YouTube Music tab is open; it simply falls back to the Add-ons tab.
  ui.openBtn.disabled = false;
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

function rendererLabel(renderer) {
  if (renderer === "amll") return "Apple Music style";
  if (renderer === "braccato") return "Better Lyrics";
  return "Standard";
}

function paintFacts(snap) {
  ui.renderer.textContent = rendererLabel(snap.renderer);
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
    "Renderer: " + rendererLabel(snap.renderer),
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
  // On YouTube Music this opens the full in-page panel. Everywhere else it
  // switches to the compact marketplace that lives in this popup.
  if (tabId != null && chrome.tabs) {
    try {
      chrome.tabs.sendMessage(tabId, { type: "ytmod-open" }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
    window.setTimeout(() => window.close(), 90);
    return;
  }
  selectTab("addons");
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
    // The first page is What's new, but a reload can land on Add-ons; that list
    // only exists once the tab id does.
    if (activeTab === "addons") loadMarketplace();
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
/* ---- tabs --------------------------------------------------------------- */
// Three pages in one horizontal track. Switching SLIDES the track: the pages are
// laid side by side and only the frame moves, so nothing fades or re-enters.
const TABS = {};
const PAGES = {};
Array.prototype.forEach.call(ui.tabBar.querySelectorAll(".tab"), (btn) => {
  TABS[btn.getAttribute("data-page")] = btn;
});
Array.prototype.forEach.call(ui.pagesTrack.children, (page) => {
  PAGES[page.getAttribute("data-page")] = page;
});
const ORDER = Object.keys(TABS);
// The compact marketplace is the point of this popup; release notes and
// diagnostics are one click away, not the landing page.
let activeTab = TABS.addons ? "addons" : (ORDER[0] || "whatsnew");

// The track is as tall as its TALLEST page, so the frame is pinned to the page
// that is showing and animated between the heights; otherwise the popup would be
// permanently as tall as the longest list.
function resizePages() {
  const page = PAGES[activeTab];
  if (!page) return;
  ui.pages.style.height = page.offsetHeight + "px";
}

function selectTab(name, focus) {
  if (!PAGES[name]) return;
  activeTab = name;
  ORDER.forEach((key) => {
    const on = key === name;
    TABS[key].setAttribute("aria-selected", on ? "true" : "false");
    TABS[key].tabIndex = on ? 0 : -1;
    PAGES[key].classList.toggle("current", on);
    PAGES[key].setAttribute("aria-hidden", on ? "false" : "true");
  });
  ui.pagesTrack.style.transform = "translateX(-" + ORDER.indexOf(name) * 100 + "%)";
  // The tab chip is one pill; moving this index slides it to the selected tab.
  ui.tabBar.style.setProperty("--i", ORDER.indexOf(name));
  ui.tabBar.style.removeProperty("--peek-left");
  ui.tabBar.style.removeProperty("--peek-right");
  resizePages();
  if (focus) TABS[name].focus();
  // Each page re-reads itself on the way in, so a switch flipped on another tab is
  // reflected everywhere without a poll.
  if (name === "addons") loadMarketplace();
  else if (name === "diagnostics") refreshDiagnostics();
  else if (name === "whatsnew") loadWhatsNew();
}

// Hovering the tab beside the active one stretches the chip toward it; the
// index is re-read on every enter so the preview follows the current tab.
function setTabPeek(hovered) {
  const active = ORDER.indexOf(activeTab);
  const index = hovered == null ? -1 : ORDER.indexOf(hovered);
  if (index >= 0 && index === active - 1) ui.tabBar.style.setProperty("--peek-left", 1);
  else ui.tabBar.style.removeProperty("--peek-left");
  if (index >= 0 && index === active + 1) ui.tabBar.style.setProperty("--peek-right", 1);
  else ui.tabBar.style.removeProperty("--peek-right");
}

ORDER.forEach((key) => {
  TABS[key].addEventListener("click", () => selectTab(key));
  TABS[key].addEventListener("pointerenter", () => setTabPeek(key));
  TABS[key].addEventListener("pointerleave", () => setTabPeek(null));
});

// A tablist is one tab stop; arrows move within it, as on any real tab strip.
if (ui.tabBar) {
  ui.tabBar.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const step = e.key === "ArrowRight" ? 1 : ORDER.length - 1;
    const next = ORDER[(ORDER.indexOf(activeTab) + step) % ORDER.length];
    selectTab(next, true);
    e.preventDefault();
  });
}

/* ---- diagnostics refresh ------------------------------------------------ */
// The bootstrap below runs once on open; this is the same request again, so
// coming back to Diagnostics never shows a stale count.
function refreshDiagnostics() {
  if (tabId == null) return;
  try {
    chrome.tabs.sendMessage(tabId, { type: "ytmod-diagnostics" }, (reply) => {
      if (chrome.runtime.lastError || !reply) return;
      snapshot = reply;
      paintStatusLine(reply);
      paintTrack(reply.track);
      paintFacts(reply);
      setActionsEnabled(true);
      if (activeTab === "diagnostics") resizePages();
    });
  } catch (_) {}
}

/* ---- what's new --------------------------------------------------------- */
// Read straight from the bundled changelog.json. It is an extension resource, so
// the popup can fetch it from its own origin with no host permission and no
// message to the page.
let whatsNewState = "idle";

function bulletList(label, entries) {
  const items = (entries || [])
    .map((e) => (typeof e === "string" ? e : (e && (e.text || e.title)) || ""))
    .filter(Boolean);
  if (!items.length) return [];
  const sub = document.createElement("h3");
  sub.className = "wn-sub";
  sub.textContent = label;
  const list = document.createElement("ul");
  list.className = "wn-list";
  items.forEach((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    list.appendChild(li);
  });
  return [sub, list];
}

function paintWhatsNew(data) {
  const releases = data && Array.isArray(data.releases) ? data.releases : [];
  const release = releases.filter((r) => r && !r.skipped)[0] || null;
  ui.whatsNew.replaceChildren();

  if (!release) {
    const empty = document.createElement("p");
    empty.className = "wn-empty";
    empty.textContent = "No release notes available.";
    ui.whatsNew.appendChild(empty);
    if (activeTab === "whatsnew") resizePages();
    return;
  }

  const head = document.createElement("div");
  head.className = "wn-head";
  const ver = document.createElement("span");
  ver.className = "wn-ver";
  ver.textContent = "v" + (release.version || "?");
  const date = document.createElement("span");
  date.className = "wn-date";
  date.textContent = release.date || "";
  head.append(ver, date);

  const title = document.createElement("h2");
  title.className = "wn-title";
  title.textContent = release.title || "What's new";
  ui.whatsNew.append(head, title);

  bulletList("New", release.features).forEach((n) => ui.whatsNew.appendChild(n));
  bulletList("Fixes", release.fixes).forEach((n) => ui.whatsNew.appendChild(n));

  // The five before the newest, one collapsed line each: the release itself in
  // full, the recent history behind it.
  const older = releases.filter((r) => r && !r.skipped && r !== release).slice(0, 5);
  if (older.length) {
    const earlier = document.createElement("h3");
    earlier.className = "wn-sub";
    earlier.textContent = "Earlier";
    ui.whatsNew.appendChild(earlier);
    older.forEach((r) => ui.whatsNew.appendChild(olderRelease(r)));
  }

  if (activeTab === "whatsnew") resizePages();
}

// One earlier release: a closed line that opens into the same New/Fixes block the
// newest one gets. Deliberately instant. The height animation could not be kept in
// step with the popup's own frame height, so the list jittered as it opened.
function olderRelease(release) {
  const box = document.createElement("details");
  box.className = "wn-item";
  const sum = document.createElement("summary");
  sum.className = "wn-sum";
  const ver = document.createElement("span");
  ver.className = "wn-item-ver";
  ver.textContent = "v" + (release.version || "?");
  const title = document.createElement("span");
  title.className = "wn-item-title";
  title.textContent = release.title || "";
  sum.append(ver, title);
  box.appendChild(sum);
  bulletList("New", release.features).forEach((n) => box.appendChild(n));
  bulletList("Fixes", release.fixes).forEach((n) => box.appendChild(n));
  // The frame is pinned to the page's height, so an opened block needs the frame
  // to follow it; without this the extra lines are clipped.
  box.addEventListener("toggle", () => {
    if (activeTab === "whatsnew") resizePages();
  });
  return box;
}

function loadWhatsNew() {
  if (whatsNewState !== "idle") return;
  whatsNewState = "loading";
  // A placeholder, so the frame is not 0px tall for the one frame before the
  // bundled JSON arrives — otherwise the popup visibly grows on open.
  const reading = document.createElement("p");
  reading.className = "wn-empty";
  reading.textContent = "Reading release notes…";
  ui.whatsNew.replaceChildren(reading);
  if (activeTab === "whatsnew") resizePages();
  let url = "";
  try {
    url = chrome.runtime.getURL("changelog.json");
  } catch (_) {}
  if (!url || typeof fetch !== "function") {
    whatsNewState = "done";
    paintWhatsNew(null);
    return;
  }
  fetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      whatsNewState = "done";
      paintWhatsNew(data);
    })
    .catch(() => {
      whatsNewState = "done";
      paintWhatsNew(null);
    });
}

/* ---- compact marketplace ------------------------------------------------ */
// Same catalogue and settings schema as the YouTube Music panel, laid out for
// 400px. The full offering is still the page panel; this is the quick version:
// category tabs, search, names, install/enable, and the settings most people
// touch.
const MK_GROUPS = ["Extensions", "Themes", "Snippets"];
// The embedded marketplace's category switch: both lists ride one 380ms reel,
// the outgoing one leaving in the direction of travel and the incoming one
// following it in from the opposite edge.
const MK_REEL_MS = 380;
const MK_REEL_EASE = "cubic-bezier(.32,.72,0,1)";
const MK_REGISTRY_KEY = "ytmod_registry";
const MK_SETTINGS_KEY = "ytmod_settings";
const MK_EMBED_KEY = "ytmod_popup_embedded";
const MK_PANEL_SURFACE_KEY = "ytmod_panel_surface";
let mkEmbedOn = true;
const MK_APPLE_ID = window.AURORA_ADDONS ? window.AURORA_ADDONS.APPLE_THEME_ID : "apple-music";
const MK_AVAILABLE = window.AURORA_ADDONS ? window.AURORA_ADDONS.AVAILABLE : [];
const mkState = { group: "Extensions", selected: "", query: "", registry: {}, settings: {} };

function mkById(id) {
  return MK_AVAILABLE.find((ext) => ext.id === id);
}

function mkBuiltin(ext) {
  return ext.id === MK_APPLE_ID;
}

function mkInstalled(ext) {
  return mkBuiltin(ext) || Boolean(mkState.registry[ext.id]);
}

function mkEnabled(ext) {
  return mkBuiltin(ext) || Boolean(mkState.registry[ext.id] && mkState.registry[ext.id].enabled);
}

function mkShortLine(ext) {
  const text = String(ext.description || "").split(/(?<=\.)\s/)[0].replace(/\.$/, "");
  return text.length > 70 ? text.slice(0, 67).trimEnd() + "…" : text;
}

function mkButton(label, onClick, primary) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "mk-btn" + (primary ? " primary" : "");
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function mkWithTab(callback) {
  try {
    chrome.tabs.query({ url: YT_URL }, (tabs) => {
      void chrome.runtime.lastError;
      callback(tabs && tabs[0] ? tabs[0] : null);
    });
  } catch (_) {
    callback(null);
  }
}

function mkSend(tab, message) {
  try {
    chrome.tabs.sendMessage(tab.id, message, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {}
}

function mkBroadcast(message) {
  try {
    chrome.tabs.query({ url: YT_URL }, (tabs) => {
      void chrome.runtime.lastError;
      for (const tab of tabs || []) mkSend(tab, message);
    });
  } catch (_) {}
}

function mkWriteRegistry() {
  if (!chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.set({ [MK_REGISTRY_KEY]: mkState.registry }, () => {
    void chrome.runtime.lastError;
  });
}

function mkEnsureSelection() {
  if (MK_AVAILABLE.some((ext) => ext.id === mkState.selected && ext.category === mkState.group)) return;
  const first = MK_AVAILABLE.find((ext) => ext.category === mkState.group) || MK_AVAILABLE[0];
  mkState.selected = first ? first.id : "";
}

let mkReelSeq = 0;

function mkPrefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

// A second category click can land mid-reel. Its incoming box is the one on
// screen, so settle it before the next render reads the rows.
function mkSettleReel() {
  mkReelSeq += 1;
  const host = ui.mkRows;
  const reel = host && host.querySelector(".mk-reel");
  if (!reel) return;
  const boxes = reel.querySelectorAll(".mk-reelbox");
  const keep = boxes[boxes.length - 1];
  boxes.forEach((box) => {
    if (box.getAnimations) box.getAnimations().forEach((a) => a.cancel());
  });
  if (keep) host.replaceChildren(...Array.from(keep.children));
}

function mkReelRows(dir, rebuild) {
  const host = ui.mkRows;
  if (!host) return;
  mkSettleReel();
  if (mkPrefersReducedMotion() || typeof host.animate !== "function") {
    rebuild();
    return;
  }
  // Snapshot the list that is leaving, then rebuild the live one underneath.
  const snapshot = host.cloneNode(true);
  rebuild();
  const oldBox = document.createElement("div");
  oldBox.className = "mk-reelbox";
  while (snapshot.firstChild) oldBox.appendChild(snapshot.firstChild);
  const newBox = document.createElement("div");
  newBox.className = "mk-reelbox";
  while (host.firstChild) newBox.appendChild(host.firstChild);
  const reel = document.createElement("div");
  reel.className = "mk-reel";
  reel.append(oldBox, newBox);
  host.appendChild(reel);
  host.scrollTop = 0;
  const width = reel.clientWidth || 360;
  const t = (v) => "translateX(" + v + "px)";
  const seq = ++mkReelSeq;
  const leaving = oldBox.animate(
    [{ transform: t(0) }, { transform: t(-dir * width) }],
    { duration: MK_REEL_MS, easing: MK_REEL_EASE, fill: "forwards" }
  );
  const arriving = newBox.animate(
    [{ transform: t(dir * width) }, { transform: t(0) }],
    { duration: MK_REEL_MS, easing: MK_REEL_EASE, fill: "forwards" }
  );
  // Same beat, opposite directions: the list leaving dissolves as it goes and
  // the incoming one fades up as it arrives. Ease-in-out so the crossfade is
  // still visible halfway through, instead of being over in the first frames.
  oldBox.animate([{ opacity: 1 }, { opacity: 0 }],
    { duration: MK_REEL_MS, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards" });
  newBox.animate([{ opacity: 0 }, { opacity: 1 }],
    { duration: MK_REEL_MS, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "backwards" });
  let done = false;
  const finish = () => {
    // A storage update or detail view can rebuild the list mid-reel; that render
    // is newer than this one, and the reel is already gone from the host.
    if (done || seq !== mkReelSeq || !host.contains(reel)) return;
    done = true;
    host.replaceChildren(...Array.from(newBox.children));
  };
  leaving.onfinish = finish;
  arriving.onfinish = finish;
  window.setTimeout(finish, MK_REEL_MS + 90);
}

// The category chip gets the same hover preview as the main one.
function mkPeekTab(group) {
  if (!ui.mkTabs) return;
  const active = MK_GROUPS.indexOf(mkState.group);
  const index = group == null ? -1 : MK_GROUPS.indexOf(group);
  if (index >= 0 && index === active - 1) ui.mkTabs.style.setProperty("--peek-left", 1);
  else ui.mkTabs.style.removeProperty("--peek-left");
  if (index >= 0 && index === active + 1) ui.mkTabs.style.setProperty("--peek-right", 1);
  else ui.mkTabs.style.removeProperty("--peek-right");
}

function mkRenderTabs() {
  if (!ui.mkTabs) return;
  ui.mkTabs.replaceChildren();
  ui.mkTabs.style.setProperty("--i", MK_GROUPS.indexOf(mkState.group));
  ui.mkTabs.style.removeProperty("--peek-left");
  ui.mkTabs.style.removeProperty("--peek-right");
  for (const group of MK_GROUPS) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "mk-tab" + (group === mkState.group ? " on" : "");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", group === mkState.group ? "true" : "false");
    tab.textContent = group;
    tab.addEventListener("pointerenter", () => mkPeekTab(group));
    tab.addEventListener("pointerleave", () => mkPeekTab(null));
    tab.addEventListener("click", () => {
      if (group === mkState.group) return;
      const dir = MK_GROUPS.indexOf(group) > MK_GROUPS.indexOf(mkState.group) ? 1 : -1;
      mkState.group = group;
      mkState.query = "";
      if (ui.mkSearch) ui.mkSearch.value = "";
      mkEnsureSelection();
      mkRenderTabs();
      mkReelRows(dir, mkRenderRows);
    });
    ui.mkTabs.append(tab);
  }
}

function mkVisibleItems() {
  const query = mkState.query.trim().toLowerCase();
  return MK_AVAILABLE.filter((ext) => ext.category === mkState.group).filter((ext) => {
    if (!query) return true;
    const haystack = [ext.name, ext.description, ext.author, ...(ext.tags || [])].join(" ").toLowerCase();
    return haystack.indexOf(query) !== -1;
  });
}

function mkSwitch(ext) {
  const enabled = mkEnabled(ext);
  const sw = document.createElement("button");
  sw.type = "button";
  sw.className = "switch";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", enabled ? "true" : "false");
  sw.setAttribute("aria-label", (enabled ? "Disable " : "Enable ") + ext.name);
  sw.addEventListener("click", (event) => {
    event.stopPropagation();
    mkSetEnabled(ext, !mkEnabled(ext));
  });
  return sw;
}

function mkOpenDetail(id) {
  mkState.selected = id;
  mkRenderDetail();
  ui.mkDetail.scrollTop = 0;
  if (!ui.mkDetailView) return;
  // The sheet covers the whole popup, but the list stays mounted underneath:
  // closing rebuilds it only after the fade, so nothing snaps in mid-fade.
  ui.mkDetailView.classList.add("open");
  ui.mkDetailView.setAttribute("aria-hidden", "false");
  document.body.classList.add("mk-detail-open");
}

function mkCloseDetail() {
  if (!ui.mkDetailView) return;
  // Close any disclosures left open in the sheet. The sheet itself fades to
  // visibility:hidden, but an open collapse body sets visibility:visible and
  // pointer-events:auto, so it would survive as an invisible click-catcher over
  // the list underneath. That is what made every add-on row unclickable after
  // leaving Kawarp with its settings open.
  ui.mkDetail.querySelectorAll(".mk-settings-collapse.open, .mk-set-collapse.open").forEach((body) => {
    body.classList.remove("open");
    body.setAttribute("aria-hidden", "true");
    body.setAttribute("inert", "");
  });
  ui.mkDetail.querySelectorAll('.mk-settings-toggle[aria-expanded="true"], .mk-set-toggle[aria-expanded="true"]').forEach((head) => {
    head.setAttribute("aria-expanded", "false");
    head.classList.remove("is-open");
  });
  ui.mkDetailView.classList.remove("open");
  ui.mkDetailView.setAttribute("aria-hidden", "true");
  document.body.classList.remove("mk-detail-open");
  window.setTimeout(() => {
    if (ui.mkDetailView.classList.contains("open")) return;
    mkRenderRows();
  }, 240);
}

function mkRenderRows() {
  if (!ui.mkRows) return;
  ui.mkRows.replaceChildren();
  const items = mkVisibleItems();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "mk-empty";
    empty.textContent = mkState.query ? "No add-ons match that search." : "Nothing here yet.";
    ui.mkRows.append(empty);
    return;
  }

  for (const ext of items) {
    const installed = mkInstalled(ext);
    const row = document.createElement("div");
    row.className = "mk-row" + (ext.id === mkState.selected ? " on" : "");
    row.setAttribute("role", "button");
    row.tabIndex = 0;

    const main = document.createElement("div");
    main.className = "mk-row-main";
    const name = document.createElement("div");
    name.className = "mk-name";
    name.textContent = ext.name;
    const line = document.createElement("div");
    line.className = "mk-line";
    line.textContent = mkShortLine(ext);
    main.append(name, line);

    const tail = document.createElement("div");
    tail.className = "mk-tail";

    if (mkBuiltin(ext)) {
      // The state label already says "Built in"; no second badge needed.
    } else if (installed) {
      tail.append(mkSwitch(ext));
    } else {
      const get = document.createElement("button");
      get.type = "button";
      get.className = "mk-get";
      get.textContent = "Install";
      get.addEventListener("click", (event) => {
        event.stopPropagation();
        mkInstall(ext);
      });
      tail.append(get);
    }

    row.append(main, tail);
    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      mkOpenDetail(ext.id);
    });
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      mkOpenDetail(ext.id);
    });
    ui.mkRows.append(row);
  }
}

function mkDefaultsFor(ext) {
  const out = {};
  for (const setting of ext.settings || []) {
    if (setting.type === "header") continue;
    out[setting.key] = mkSettingValue(setting, setting.default);
  }
  return out;
}

function mkSettingNumber(setting, value) {
  const numeric = Number(value);
  const fallback = Number(setting.default);
  const clamped = Number.isFinite(numeric) ? numeric : fallback;
  return Math.min(Number(setting.max), Math.max(Number(setting.min), clamped));
}

function mkSettingValue(setting, value) {
  if (setting.type === "text") {
    const text = value == null ? "" : String(value);
    return text.slice(0, Number(setting.maxLength) || 200);
  }
  if (setting.type === "toggle") {
    if (typeof value === "string") return !/^(false|0|off|no)$/i.test(value.trim());
    return value == null ? Boolean(setting.default) : Boolean(value);
  }
  if (setting.type === "select") {
    const allowed = (setting.options || []).map((option) => String(option.value));
    const chosen = value == null ? "" : String(value);
    return allowed.indexOf(chosen) !== -1 ? chosen : String(setting.default);
  }
  if (setting.type === "file") {
    if (typeof value === "string") return !/^(false|0|off|no|)$/i.test(value.trim());
    return value === true || value === 1;
  }
  return mkSettingNumber(setting, value);
}

function mkValuesFor(ext) {
  const saved = mkState.settings[ext.id] || {};
  const defaults = mkDefaultsFor(ext);
  const out = { ...saved };
  for (const setting of ext.settings || []) {
    if (setting.type === "header") continue;
    out[setting.key] = mkSettingValue(setting, saved[setting.key] == null ? defaults[setting.key] : saved[setting.key]);
  }
  const savedTrue = (value) => value === true || value === 1 || String(value).toLowerCase() === "true";
  if (saved.wordRenderer == null && savedTrue(saved.amllWordTracks)) out.wordRenderer = "amll";
  if (saved.lineRenderer == null && savedTrue(saved.spicyLineTracks)) out.lineRenderer = "spicy";
  return out;
}

function mkVisibleSettings(ext) {
  const all = ext.settings || [];
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const setting = all[i];
    if (setting.type === "header") {
      let hasVisibleChild = false;
      for (let j = i + 1; j < all.length && all[j].type !== "header"; j++) {
        if (!all[j].dev) {
          hasVisibleChild = true;
          break;
        }
      }
      if (hasVisibleChild) out.push(setting);
      continue;
    }
    if (!setting.dev) out.push(setting);
  }
  return out;
}

function mkConditionTrue(values, condition) {
  if (!condition) return true;
  if (Array.isArray(condition)) return condition.some((entry) => mkConditionTrue(values, entry));
  if (typeof condition === "string") return Boolean(values[condition]);
  if (typeof condition !== "object") return Boolean(condition);
  if (condition.key) {
    if (Object.prototype.hasOwnProperty.call(condition, "value")) {
      return String(values[condition.key]) === String(condition.value);
    }
    if (Object.prototype.hasOwnProperty.call(condition, "equals")) {
      return String(values[condition.key]) === String(condition.equals);
    }
    if (Object.prototype.hasOwnProperty.call(condition, "oneOf")) {
      return (condition.oneOf || []).map(String).indexOf(String(values[condition.key])) !== -1;
    }
    if (Object.prototype.hasOwnProperty.call(condition, "not")) {
      return !mkConditionTrue(values, condition.not);
    }
    return Boolean(values[condition.key]);
  }
  if (Array.isArray(condition.all)) return condition.all.every((entry) => mkConditionTrue(values, entry));
  if (Array.isArray(condition.any)) return condition.any.some((entry) => mkConditionTrue(values, entry));
  return true;
}

function mkFormatSetting(setting, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value == null ? "" : value);
  switch (setting.display) {
    case "percent":
      return Math.round(number * 100) + "%";
    case "pixels":
      return Math.round(number) + " px";
    case "passes":
      return number + (number === 1 ? " pass" : " passes");
    case "seconds":
      return number + "s";
    case "milliseconds":
      return number + " ms";
    case "minutes":
      return number + " min";
    case "decimal":
      return number.toFixed(2);
    default:
      return String(number);
  }
}

function mksaveValues(ext, values) {
  mkState.settings[ext.id] = values;
  if (!chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.set({ [MK_SETTINGS_KEY]: mkState.settings }, () => {
    void chrome.runtime.lastError;
  });
  mkBroadcast({ type: "ytmod-saveSettings", id: ext.id, values });
}

function mkInstall(ext) {
  mkWithTab((tab) => {
    if (tab) {
      mkBroadcast({ type: "ytmod-setEnabled", id: ext.id, on: true });
      window.setTimeout(loadMarketplace, 500);
      return;
    }
    mkState.registry[ext.id] = {
      enabled: true,
      version: ext.version || "?",
      installedAt: Date.now(),
    };
    mkWriteRegistry();
    mkRenderRows();
    mkRenderDetail();
  });
}

function mkSetEnabled(ext, on) {
  const record = mkState.registry[ext.id];
  if (!record) return;
  record.enabled = on;
  mkWithTab((tab) => {
    if (tab) {
      mkBroadcast({ type: "ytmod-setEnabled", id: ext.id, on });
      window.setTimeout(loadMarketplace, 420);
    } else {
      mkWriteRegistry();
    }
  });
  mkRenderRows();
  if (ui.mkDetailView && ui.mkDetailView.classList.contains("open")) mkRenderDetail();
}

function mkLocalRemove(ext) {
  delete mkState.registry[ext.id];
  delete mkState.settings[ext.id];
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({
      [MK_REGISTRY_KEY]: mkState.registry,
      [MK_SETTINGS_KEY]: mkState.settings,
    }, () => {
      void chrome.runtime.lastError;
    });
  }
  mkCloseDetail();
  mkRenderRows();
}

function mkRemove(ext) {
  if (mkBuiltin(ext)) return;
  if (!window.confirm("Remove " + ext.name + "? Its settings will be deleted. YouTube Music needs a reload to finish removing it.")) return;
  mkWithTab((tab) => {
    if (!tab) {
      mkLocalRemove(ext);
      return;
    }
    mkBroadcast({ type: "ytmod-uninstall", id: ext.id });
    window.setTimeout(() => loadMarketplace(() => {
      if (mkState.registry[ext.id]) mkLocalRemove(ext);
    }), 1000);
  });
}

function mkOpenPanel() {
  mkWithTab((tab) => {
    if (tab) {
      chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true });
      mkSend(tab, { type: "ytmod-open" });
      window.setTimeout(() => window.close(), 110);
      return;
    }
    // No page is open yet. Ask the content script to open the full panel as
    // soon as the new YouTube Music tab boots (see ytmod_open_panel_once).
    // Write the one-shot flag first, then create the tab. The popup stays open
    // for the storage callback, so the tab can never boot before the flag.
    const open = () => {
      chrome.tabs.create({ url: "https://music.youtube.com/" });
      window.setTimeout(() => window.close(), 110);
    };
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ ytmod_open_panel_once: true }, () => {
        void chrome.runtime.lastError;
        open();
      });
    } else {
      open();
    }
  });
}

function mkChevron() {
  const chev = document.createElement("span");
  chev.className = "mk-chev";
  chev.setAttribute("aria-hidden", "true");
  return chev;
}

const MK_FONT_MIME = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" };

function mkReadFontFile(file) {
  return new Promise((resolve, reject) => {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const mime = MK_FONT_MIME[ext];
    if (!mime) return reject(new Error("Use a .ttf, .otf, .woff or .woff2 font."));
    if (file.size > 8 * 1024 * 1024) return reject(new Error("Font file is too large (8 MB max)."));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      // Re-wrap in a typed Blob so a font that arrives with an empty file.type
      // still gets a real font/... MIME; the extension's sanitiser rejects
      // `data:;base64` URLs.
      const blob = new Blob([reader.result], { type: mime });
      const asUrl = new FileReader();
      asUrl.onerror = () => reject(new Error("Could not read that file."));
      asUrl.onload = () => resolve(String(asUrl.result));
      asUrl.readAsDataURL(blob);
    };
    reader.readAsArrayBuffer(file);
  });
}

function mkFontSection(ext, values) {
  const section = document.createElement("div");
  section.className = "mk-set-section";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "mk-set-group mk-set-toggle";
  head.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  label.textContent = "Custom font";
  head.append(label, mkChevron());
  const body = document.createElement("div");
  body.className = "mk-set-collapse";
  body.setAttribute("aria-hidden", "true");
  body.setAttribute("inert", "");
  const rows = document.createElement("div");
  rows.className = "mk-set-rows";

  const row = document.createElement("div");
  row.className = "mk-set";
  const main = document.createElement("div");
  main.className = "mk-set-main";
  const rowLabel = document.createElement("span");
  rowLabel.className = "mk-set-label";
  rowLabel.textContent = "Lyrics font";
  const hint = document.createElement("span");
  hint.className = "mk-set-hint";
  const hintText = "Load a .ttf, .otf, .woff or .woff2 file (8 MB max).";
  hint.textContent = hintText;
  main.append(rowLabel, hint);

  const ctl = document.createElement("div");
  ctl.className = "mk-set-ctl";
  const status = document.createElement("span");
  status.className = "mk-set-value";
  const choose = document.createElement("button");
  choose.type = "button";
  choose.className = "mk-btn";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "mk-btn";
  clear.textContent = "Default";
  ctl.append(status, choose, clear);
  row.append(main, ctl);
  rows.append(row);

  const sizeRow = document.createElement("div");
  sizeRow.className = "mk-set";
  const sizeMain = document.createElement("div");
  sizeMain.className = "mk-set-main";
  const sizeLabel = document.createElement("span");
  sizeLabel.className = "mk-set-label";
  sizeLabel.textContent = "Font size";
  const sizeHint = document.createElement("span");
  sizeHint.className = "mk-set-hint";
  sizeHint.textContent = "Applied to the custom lyrics font.";
  sizeMain.append(sizeLabel, sizeHint);
  const sizeCtl = document.createElement("div");
  sizeCtl.className = "mk-set-ctl";
  const size = document.createElement("input");
  size.type = "range";
  size.className = "mk-range";
  size.min = "50";
  size.max = "200";
  size.step = "5";
  const savedScale = Number(values.customFontScale);
  size.value = String(Math.round((Number.isFinite(savedScale) && savedScale > 0 ? savedScale : 2) * 100));
  size.setAttribute("aria-label", "Custom font size");
  const sizeOut = document.createElement("span");
  sizeOut.className = "mk-set-value";
  const paintSize = () => {
    const pct = ((Number(size.value) - 50) / 150) * 100;
    size.style.setProperty("--v", pct + "%");
    sizeOut.textContent = size.value + "%";
  };
  paintSize();
  size.addEventListener("input", paintSize);
  size.addEventListener("change", () => {
    values.customFontScale = Number(size.value) / 100;
    mksaveValues(ext, values);
  });
  sizeCtl.append(size, sizeOut);
  sizeRow.append(sizeMain, sizeCtl);
  rows.append(sizeRow);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2";
  fileInput.hidden = true;
  rows.append(fileInput);

  const paint = () => {
    const custom = typeof values.customFont === "string" && values.customFont !== "";
    status.textContent = custom ? "Custom" : "Default";
    choose.textContent = custom ? "Replace" : "Choose";
    clear.hidden = !custom;
    size.disabled = !custom;
    hint.textContent = hintText;
    hint.classList.remove("is-error");
  };
  paint();

  choose.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    status.textContent = "Reading…";
    try {
      const dataUrl = await mkReadFontFile(file);
      const check = new FontFace("ym-popup-font-check-" + Date.now(), 'url("' + dataUrl + '")');
      await check.load();
      values.customFont = dataUrl;
      values.customFontScale = 2;
      size.value = "200";
      paintSize();
      mksaveValues(ext, values);
      paint();
    } catch (error) {
      status.textContent = "Error";
      hint.textContent = error && error.message ? error.message : "Could not read that font.";
      hint.classList.add("is-error");
    }
  });
  clear.addEventListener("click", () => {
    values.customFont = "";
    values.customFontScale = 2;
    size.value = "200";
    paintSize();
    mksaveValues(ext, values);
    paint();
  });

  head.addEventListener("click", () => {
    const open = head.getAttribute("aria-expanded") !== "true";
    head.setAttribute("aria-expanded", open ? "true" : "false");
    head.classList.toggle("is-open", open);
    body.classList.toggle("open", open);
    body.setAttribute("aria-hidden", open ? "false" : "true");
    if (open) body.removeAttribute("inert");
    else body.setAttribute("inert", "");
  });

  body.append(rows);
  section.append(head, body);
  return section;
}

function mkBuildSettings(ext) {
  const values = mkValuesFor(ext);
  const block = document.createElement("div");
  block.className = "mk-settings";
  const syncers = [];

  const syncAll = () => {
    for (const entry of syncers) {
      const setting = entry.setting;
      const visible = setting.childOf
        ? Boolean(values[setting.childOf])
        : mkConditionTrue(values, setting.visibleWhen);
      entry.row.hidden = !visible;
      const blocked = Boolean(setting.disabledWhen && mkConditionTrue(values, setting.disabledWhen));
      entry.row.classList.toggle("is-disabled", blocked);
      if (entry.control) entry.control.disabled = blocked;
    }
  };

  let target = block;
  for (const setting of mkVisibleSettings(ext)) {
    if (setting.type === "header") {
      if (setting.collapsible) {
        const section = document.createElement("div");
        section.className = "mk-set-section";
        const head = document.createElement("button");
        head.type = "button";
        head.className = "mk-set-group mk-set-toggle";
        head.setAttribute("aria-expanded", "false");
        const label = document.createElement("span");
        label.textContent = setting.label;
        head.append(label, mkChevron());
        const body = document.createElement("div");
        body.className = "mk-set-collapse";
        body.setAttribute("aria-hidden", "true");
        body.setAttribute("inert", "");
        const rows = document.createElement("div");
        rows.className = "mk-set-rows";
        body.append(rows);
        section.append(head, body);
        target = rows;
        block.append(section);
        head.addEventListener("click", () => {
          const open = head.getAttribute("aria-expanded") !== "true";
          head.setAttribute("aria-expanded", open ? "true" : "false");
          head.classList.toggle("is-open", open);
          body.classList.toggle("open", open);
          body.setAttribute("aria-hidden", open ? "false" : "true");
          if (open) body.removeAttribute("inert");
          else body.setAttribute("inert", "");
        });
      } else {
        const heading = document.createElement("h3");
        heading.className = "mk-set-group";
        heading.textContent = setting.label;
        block.append(heading);
        target = block;
      }
      continue;
    }

    const row = document.createElement("div");
    row.className = "mk-set";
    const main = document.createElement("div");
    main.className = "mk-set-main";
    const label = document.createElement("span");
    label.className = "mk-set-label";
    label.textContent = setting.label || setting.key;
    main.append(label);
    if (setting.note) {
      const hint = document.createElement("span");
      hint.className = "mk-set-hint";
      hint.textContent = setting.note;
      main.append(hint);
    }
    row.append(main);

    const ctl = document.createElement("div");
    ctl.className = "mk-set-ctl";
    const entry = { row, setting, control: null };

    if (setting.type === "file") {
      const value = document.createElement("span");
      value.className = "mk-set-value";
      value.textContent = values[setting.key] ? "Set" : "None";
      ctl.append(value, mkButton("Open", mkOpenPanel));
    } else if (setting.type === "toggle") {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "switch";
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", String(Boolean(values[setting.key])));
      sw.setAttribute("aria-label", setting.label || setting.key);
      sw.addEventListener("click", () => {
        values[setting.key] = !values[setting.key];
        sw.setAttribute("aria-checked", String(Boolean(values[setting.key])));
        mksaveValues(ext, values);
        syncAll();
      });
      ctl.append(sw);
      entry.control = sw;
    } else if (setting.type === "select") {
      const select = document.createElement("select");
      select.className = "mk-select";
      select.setAttribute("aria-label", setting.label || setting.key);
      for (const option of setting.options || []) {
        const opt = document.createElement("option");
        opt.value = String(option.value);
        opt.textContent = option.label || String(option.value);
        select.append(opt);
      }
      select.value = String(values[setting.key]);
      select.addEventListener("change", () => {
        values[setting.key] = mkSettingValue(setting, select.value);
        mksaveValues(ext, values);
        syncAll();
      });
      ctl.append(select);
      entry.control = select;
    } else if (setting.type === "text") {
      const input = document.createElement("input");
      input.className = "mk-text";
      input.type = "text";
      input.value = values[setting.key];
      input.maxLength = Number(setting.maxLength) || 200;
      input.setAttribute("aria-label", setting.label || setting.key);
      input.addEventListener("change", () => {
        values[setting.key] = mkSettingValue(setting, input.value);
        input.value = values[setting.key];
        mksaveValues(ext, values);
      });
      ctl.append(input);
      entry.control = input;
    } else {
      const output = document.createElement("span");
      output.className = "mk-set-value";
      output.textContent = mkFormatSetting(setting, values[setting.key]);
      const input = document.createElement("input");
      input.className = "mk-range";
      input.type = "range";
      input.min = setting.min;
      input.max = setting.max;
      input.step = setting.step || 1;
      input.value = values[setting.key];
      input.setAttribute("aria-label", setting.label || setting.key);
      const paint = () => {
        const numeric = Number(input.value);
        const min = Number(setting.min);
        const max = Number(setting.max);
        const percent = max > min ? ((numeric - min) / (max - min)) * 100 : 0;
        input.style.setProperty("--v", percent + "%");
        output.textContent = mkFormatSetting(setting, numeric);
      };
      paint();
      input.addEventListener("input", paint);
      input.addEventListener("change", () => {
        values[setting.key] = mkSettingValue(setting, input.value);
        input.value = values[setting.key];
        paint();
        mksaveValues(ext, values);
        syncAll();
      });
      ctl.append(input, output);
      entry.control = input;
    }

    row.append(ctl);
    target.append(row);
    syncers.push(entry);
  }

  if (ext.id === "ytmod-spicy-lyrics") {
    block.append(mkFontSection(ext, values));
  }

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "mk-reset";
  reset.textContent = "Reset to defaults";
  reset.addEventListener("click", () => {
    const defaults = mkDefaultsFor(ext);
    for (const key of Object.keys(defaults)) values[key] = defaults[key];
    if (ext.id === "ytmod-spicy-lyrics") {
      values.customFont = "";
      values.customFontScale = 2;
    }
    mksaveValues(ext, values);
    mkRenderDetail();
  });
  block.append(reset);
  syncAll();
  return block;
}

function mkRenderDetail() {
  if (!ui.mkDetail) return;
  const ext = mkById(mkState.selected);
  ui.mkDetail.replaceChildren();
  if (!ext) {
    const empty = document.createElement("p");
    empty.className = "mk-empty";
    empty.textContent = "Choose an add-on to see what it does.";
    ui.mkDetail.append(empty);
    return;
  }

  const installed = mkInstalled(ext);
  const builtin = mkBuiltin(ext);
  const title = document.createElement("h2");
  title.className = "mk-dt-title";
  title.textContent = ext.name;
  ui.mkDetail.append(title);

  const meta = document.createElement("p");
  meta.className = "mk-dt-meta";
  meta.textContent = [ext.author, ext.category, "v" + (ext.version || "?")].join(" · ");
  ui.mkDetail.append(meta);

  const actions = document.createElement("div");
  actions.className = "mk-actions";
  if (builtin) {
    const built = document.createElement("span");
    built.className = "mk-action-note";
    built.textContent = "Built in";
    actions.append(built, mkButton("Open full panel", mkOpenPanel));
  } else if (!installed) {
    actions.append(mkButton("Install", () => mkInstall(ext), true));
    const note = document.createElement("span");
    note.className = "mk-action-note";
    note.textContent = "Free · stored locally";
    actions.append(note);
  } else {
    actions.append(mkSwitch(ext));
    const remove = mkButton("Remove", () => mkRemove(ext));
    remove.classList.add("danger");
    actions.append(remove);
  }
  if (ext.github) {
    const source = document.createElement("a");
    source.className = "mk-link";
    source.href = ext.github;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.textContent = "Source";
    actions.append(source);
  }
  ui.mkDetail.append(actions);

  const desc = document.createElement("p");
  desc.className = "mk-dt-desc";
  desc.textContent = ext.description || "";
  ui.mkDetail.append(desc);
  if (ext.disclaimer) {
    const disclaimer = document.createElement("p");
    disclaimer.className = "mk-note";
    disclaimer.textContent = ext.disclaimer;
    ui.mkDetail.append(disclaimer);
  }

  const settingsHead = document.createElement("h3");
  settingsHead.className = "mk-settings-head";
  settingsHead.textContent = "Settings";
  ui.mkDetail.append(settingsHead);

  if (builtin) {
    const note = document.createElement("p");
    note.className = "mk-note";
    note.textContent = "Its page controls live in YouTube Music, under YouTube modifications in the full panel.";
    ui.mkDetail.append(note);
    return;
  }
  if (!installed) {
    const note = document.createElement("p");
    note.className = "mk-note";
    note.textContent = "Install this add-on to change its settings.";
    ui.mkDetail.append(note);
    return;
  }
  if (!(ext.settings || []).length) {
    const note = document.createElement("p");
    note.className = "mk-note";
    note.textContent = "No settings — it just works.";
    ui.mkDetail.append(note);
    return;
  }
  ui.mkDetail.append(mkBuildSettings(ext));
}

function mkApplyEmbedded(on) {
  mkEmbedOn = on;
  if (ui.mk) ui.mk.hidden = !on;
  if (ui.mkOff) ui.mkOff.hidden = on;
  if (ui.embedSwitch) ui.embedSwitch.setAttribute("aria-checked", on ? "true" : "false");
}

function mkPersistEmbedded(on) {
  if (!chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.set({
    [MK_EMBED_KEY]: on,
    // The content script watches this key to mount or remove the top-bar
    // launcher. Keeping both keys in one write avoids a half-switched state.
    [MK_PANEL_SURFACE_KEY]: on ? "popup" : "page",
  }, () => { void chrome.runtime.lastError; });
}

function mkLoadEmbedded() {
  if (!chrome.storage || !chrome.storage.local) {
    // Off by default: the embedded list only appears once the switch is turned on.
    mkApplyEmbedded(false);
    return;
  }
  chrome.storage.local.get([MK_EMBED_KEY, MK_PANEL_SURFACE_KEY], (data) => {
    void chrome.runtime.lastError;
    const saved = data && data[MK_EMBED_KEY];
    const surface = data && data[MK_PANEL_SURFACE_KEY];
    // No switch value yet: OFF. Only an explicit "popup" surface (the user
    // turned this on in an earlier build) shows the switch as on.
    const on = saved == null ? surface === "popup" : saved !== false;
    mkApplyEmbedded(on);
    const desired = on ? "popup" : "page";
    if (surface !== desired) {
      chrome.storage.local.set({ [MK_PANEL_SURFACE_KEY]: desired }, () => { void chrome.runtime.lastError; });
    }
  });
}

function loadMarketplace(done) {
  if (!chrome.storage || !chrome.storage.local) {
    mkEnsureSelection();
    mkRenderTabs();
    mkRenderRows();
    if (done) done();
    return;
  }
  chrome.storage.local.get([MK_REGISTRY_KEY, MK_SETTINGS_KEY], (data) => {
    void chrome.runtime.lastError;
    mkState.registry = (data && data[MK_REGISTRY_KEY]) || {};
    mkState.settings = (data && data[MK_SETTINGS_KEY]) || {};
    mkEnsureSelection();
    mkRenderTabs();
    if (ui.mkDetailView && ui.mkDetailView.classList.contains("open") && mkState.selected) mkRenderDetail();
    else if (ui.mkRows) mkRenderRows();
    if (done) done();
  });
}

if (ui.mkTabs) {
  if (ui.mkSearch) {
    ui.mkSearch.addEventListener("input", () => {
      mkState.query = ui.mkSearch.value || "";
      mkRenderRows();
    });
  }
  if (ui.mkBack) ui.mkBack.addEventListener("click", mkCloseDetail);
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let structural = false;
      if (changes[MK_REGISTRY_KEY]) {
        mkState.registry = changes[MK_REGISTRY_KEY].newValue || {};
        structural = true;
      }
      if (changes[MK_SETTINGS_KEY]) mkState.settings = changes[MK_SETTINGS_KEY].newValue || {};
      if (!structural) return;
      mkRenderTabs();
      if (ui.mkDetailView && ui.mkDetailView.classList.contains("open") && mkState.selected) mkRenderDetail();
      else mkRenderRows();
    });
  }
}

// The switch chooses the panel surface. On keeps the compact marketplace in
// the popup; off mounts the waffle in YouTube Music's top bar, next to Cast,
// and lets the full page marketplace open from there.
if (ui.embedSwitch) {
  ui.embedSwitch.addEventListener("click", () => {
    const next = !mkEmbedOn;
    mkApplyEmbedded(next);
    mkPersistEmbedded(next);
  });
}
if (ui.mkOffOpen) ui.mkOffOpen.addEventListener("click", mkOpenPanel);
mkLoadEmbedded();

/* ---- first paint -------------------------------------------------------- */
selectTab(activeTab);
window.addEventListener("resize", resizePages);
