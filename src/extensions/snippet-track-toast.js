/*
 * Snippet — "Track-change notification".
 *
 * v0.1.0.
 *
 * AJ asked for a real WINDOWS notification on every track change, with the cover
 * art. That is reachable directly from the page: `new Notification(title, opts)`
 * raises a genuine OS notification, and `icon` takes a URL — so the player bar's
 * own artwork can be passed straight through. No extension permission and no
 * manifest change are needed, because this uses the PAGE's Notification API
 * rather than chrome.notifications.
 *
 * WHAT IT DOES
 *   - watches the watch URL's `v=` param (same signal the pages module already
 *     polls) and fires on change;
 *   - reads the title, artist and artwork out of the player bar;
 *   - raises one notification per change.
 *
 * DELIBERATE CHOICES
 *   - No notification on load. The first track seen only sets the baseline,
 *     otherwise opening the tab would ping you about whatever is already playing.
 *   - NO `tag`. A tagged notification makes Windows UPDATE the existing one in
 *     place: it shows the new song but never pops again. Without a tag, every
 *     change is a fresh, re-alerting notification. To keep them from piling up
 *     when skipping fast, the previous one is closed explicitly on each change
 *     (and on teardown), leaving exactly one visible at a time.
 *   - Permission is requested on enable. Browsers only honour that from a user
 *     gesture, and toggling the snippet on IS one — but if the prompt was already
 *     dismissed the state is logged rather than fought.
 */
(function () {
  "use strict";

  const EXT_ID = "snippet-track-toast";
  const TAG = "[snippet:toast]";
  const POLL_MS = 900;

  let armed = false;
  let poll = 0;
  let lastId = "";
  let lastNotification = null;

  function currentId() {
    try {
      return new URL(location.href).searchParams.get("v") || "";
    } catch (e) {
      return "";
    }
  }

  function trackInfo() {
    const bar = document.querySelector("ytmusic-player-bar");
    if (!bar) return null;
    const pick = (sel) => {
      const el = bar.querySelector(sel);
      return el ? (el.textContent || "").trim() : "";
    };
    const img = bar.querySelector("img");
    return {
      title: pick(".title"),
      artist: pick(".byline"),
      art: img && img.src ? img.src : "",
    };
  }

  function ensurePermission() {
    try {
      if (typeof Notification === "undefined") {
        console.log(TAG, "Notification API not available");
        return;
      }
      console.log(TAG, "notification permission:", Notification.permission);
      if (Notification.permission === "default") {
        Notification.requestPermission().then(
          (p) => console.log(TAG, "permission now:", p),
          (e) => console.log(TAG, "permission request failed:", String(e && e.message))
        );
      }
    } catch (e) {
      console.log(TAG, "permission probe failed:", String(e && e.message));
    }
  }

  function notify(info) {
    try {
      if (typeof Notification === "undefined") return;
      if (Notification.permission !== "granted") {
        console.log(TAG, "no permission (" + Notification.permission + ") — not shown");
        return;
      }
      // NO tag, on purpose. A tag makes Windows UPDATE the existing notification
      // in place: it shows the new song but never pops again — exactly what AJ
      // hit ("it just changes that existing notification ... and never shows").
      // Without a tag every change is a fresh notification that actually alerts.
      // To stop them piling up when skipping fast, the previous one is closed
      // explicitly instead — one visible notification, and it re-alerts each time.
      if (lastNotification) {
        try { lastNotification.close(); } catch (e) {}
        lastNotification = null;
      }
      const n = new Notification(info.title || "Now playing", {
        body: info.artist || "",
        icon: info.art || undefined,
      });
      lastNotification = n;
      n.onclick = () => {
        try { window.focus(); n.close(); } catch (e) {}
      };
      console.log(TAG, "notified:", info.title, "/", info.artist, "| art:", info.art ? "yes" : "no");
    } catch (e) {
      console.log(TAG, "notify failed:", String(e && e.message));
    }
  }

  function sync() {
    const id = currentId();
    if (!id || id === lastId) return;
    const first = !lastId;
    lastId = id;
    if (first) {
      // Baseline only — do not announce whatever was already playing.
      console.log(TAG, "baseline track:", id);
      return;
    }
    const info = trackInfo();
    if (!info) {
      console.log(TAG, "track changed to " + id + " but the player bar was not readable");
      return;
    }
    console.log(TAG, "track changed ->", id, "|", info.title, "/", info.artist);
    notify(info);
  }

  function arm() {
    if (armed) return;
    armed = true;
    ensurePermission();
    sync();
    poll = window.setInterval(sync, POLL_MS);
    console.log(TAG, "armed — a notification on every track change");
  }

  function teardown() {
    if (!armed) return;
    armed = false;
    if (poll) { window.clearInterval(poll); poll = 0; }
    if (lastNotification) {
      try { lastNotification.close(); } catch (e) {}
      lastNotification = null;
    }
    lastId = "";
    console.log(TAG, "torn down");
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.id !== EXT_ID) return;
    if (data.type !== "ytmod-ext") return;
    if (data.action === "disable") teardown();
  });

  arm();
})();
