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
  tabBar: document.querySelector(".tabs"),
  pages: $("pages"),
  pagesTrack: $("pagesTrack"),
  addonsScroll: $("addonsScroll"),
  addonsEmpty: $("addonsEmpty"),
  whatsNew: $("whatsNew"),
};

// The status pill is gone from the markup: the popup is a snapshot, not a
// dashboard. Stubs keep every caller in this file valid.
ui.status = ui.status || { dataset: {}, classList: { add() {}, remove() {}, toggle() {} } };
ui.statusText = ui.statusText || { textContent: "" };

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
    // The first page is What's new, but a reload can land on Add-ons; that list
    // only exists once the tab id does.
    if (activeTab === "addons") loadAddons();
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
let activeTab = ORDER[0] || "whatsnew";

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
  resizePages();
  if (focus) TABS[name].focus();
  // Each page re-reads itself on the way in, so a switch flipped on another tab is
  // reflected everywhere without a poll.
  if (name === "addons") loadAddons();
  else if (name === "diagnostics") refreshDiagnostics();
  else if (name === "whatsnew") loadWhatsNew();
}

ORDER.forEach((key) => {
  TABS[key].addEventListener("click", () => selectTab(key));
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

/* ---- add-ons ------------------------------------------------------------ */
const SECTION_ORDER = ["Themes", "Extensions", "Snippets"];

function switchEl(item) {
  const sw = document.createElement("button");
  sw.type = "button";
  sw.className = "switch";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", item.enabled ? "true" : "false");
  sw.setAttribute("aria-label", item.name);
  if (item.soon) {
    // Listed so the catalogue reads complete, but a switch that cannot install
    // anything would be a lie.
    sw.disabled = true;
    sw.title = "Coming soon";
    return sw;
  }
  sw.addEventListener("click", () => toggleAddon(item, sw));
  return sw;
}

function toggleAddon(item, sw) {
  if (tabId == null) return;
  const on = sw.getAttribute("aria-checked") !== "true";
  // Optimistic: the switch answers the click now and the page applies it. A theme
  // is exclusive, so its siblings are re-read instead of guessed.
  sw.setAttribute("aria-checked", on ? "true" : "false");
  item.enabled = on;
  try {
    chrome.tabs.sendMessage(tabId, { type: "ytmod-setEnabled", id: item.id, on }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {
    return;
  }
  // Re-read the list: the id may have just been installed, and a theme switches
  // its siblings off. Cheap, and it keeps every row honest.
  window.setTimeout(loadAddons, 340);
  window.setTimeout(refreshDiagnostics, 340);
}

function addonRow(item) {
  const row = document.createElement("div");
  row.className = "addon";
  // Not installed yet: switched on, it installs. The dim label is the only cue
  // that this row is a catalogue entry rather than something already here.
  if (!item.installed) row.classList.add("not-installed");
  const name = document.createElement("span");
  name.className = "addon-name";
  name.textContent = item.name;
  row.appendChild(name);
  row.appendChild(switchEl(item));
  return row;
}

function renderAddons(items) {
  Array.prototype.forEach.call(ui.addonsScroll.querySelectorAll(".addon-section"), (n) => n.remove());
  const categories = SECTION_ORDER.concat(
    items.map((i) => i.category).filter((c) => SECTION_ORDER.indexOf(c) < 0)
  );
  let shown = 0;
  categories.forEach((category) => {
    const group = items.filter((i) => i.category === category);
    if (!group.length) return;
    shown += group.length;
    const section = document.createElement("section");
    section.className = "addon-section";
    const heading = document.createElement("h2");
    heading.className = "addon-head";
    heading.textContent = category;
    section.appendChild(heading);
    group
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((item) => section.appendChild(addonRow(item)));
    ui.addonsScroll.appendChild(section);
  });
  ui.addonsEmpty.hidden = shown > 0;
  if (!shown) ui.addonsEmpty.textContent = "No add-ons installed yet.";
  if (activeTab === "addons") resizePages();
}

function loadAddons() {
  Array.prototype.forEach.call(ui.addonsScroll.querySelectorAll(".addon-section"), (n) => n.remove());
  const failed = (text) => {
    ui.addonsEmpty.textContent = text;
    ui.addonsEmpty.hidden = false;
    if (activeTab === "addons") resizePages();
  };
  if (tabId == null) {
    failed("Open YouTube Music to change add-ons.");
    return;
  }
  try {
    chrome.tabs.sendMessage(tabId, { type: "ytmod-addons" }, (reply) => {
      if (chrome.runtime.lastError || !reply || !reply.items) {
        failed("Reload YouTube Music to refresh.");
        return;
      }
      renderAddons(reply.items);
    });
  } catch (_) {
    failed("Reload YouTube Music to refresh.");
  }
}

/* ---- first paint -------------------------------------------------------- */
selectTab(activeTab);
window.addEventListener("resize", resizePages);
