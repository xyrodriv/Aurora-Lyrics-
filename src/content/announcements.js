/*
 * Aurora Lyrics - remote announcements.
 *
 * The relay exposes one public read-only announcement. This script polls it,
 * shows a compact pill in the same top-bar slot as the update notice, and opens
 * the full note in a card that reuses the update modal's visual language.
 *
 * Rules:
 *   - The update notice wins the slot; announcements wait until it is gone.
 *   - A seen or dismissed announcement never comes back.
 *   - No account, no identifier, no track metadata: just GET /latest.
 */
(function () {
  "use strict";
  // Console branding: a red Aurora badge on every log, shaped like the
  // coloured tags Better Lyrics prints. Bound helpers keep the real call
  // site in DevTools instead of pointing at a wrapper.
  const AURORA_BADGE = "background:#dc2626;color:#fff;padding:1px 5px;border-radius:3px;font-weight:600";
  const alDebug = console.debug.bind(console, "%cAurora Lyrics", AURORA_BADGE);


  const FEED_URL = "https://site-ecb11ddf30644a24b5d9f12c57480dbd.freebuff.page/latest";
  const POLL_MS = 5 * 60 * 1000;
  const FIRST_CHECK_MS = 3500;
  const MIN_CHECK_GAP_MS = 60 * 1000;
  const SEEN_KEY = "ymAnnouncementSeenId";
  const DISMISSED_KEY = "ymAnnouncementDismissedId";
  const PILL_ID = "ym-announcement-pill";
  const STYLE_ID = "ym-announcement-style";

  let pill = null;
  let latest = null;
  let detailOpen = false;
  let seenId = "";
  let dismissedId = "";
  let lastCheck = 0;
  let positionTimer = 0;
  let warned = false;
  let started = false;

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (key === "text") node.textContent = value == null ? "" : String(value);
        else if (key === "class") node.className = value;
        else node.setAttribute(key, value);
      }
    }
    for (const child of children) {
      if (child) node.appendChild(child);
    }
    return node;
  }

  function storageGet(keys) {
    try {
      return new Promise((resolve) => {
        chrome.storage.local.get(keys, (data) => resolve(data || {}));
      });
    } catch (_) {
      return Promise.resolve({});
    }
  }

  function storageSet(values) {
    try {
      return new Promise((resolve) => {
        chrome.storage.local.set(values, () => resolve());
      });
    } catch (_) {
      return Promise.resolve();
    }
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #ym-announcement-pill {
        position: fixed;
        z-index: 2147483000;
        display: flex;
        align-items: stretch;
        width: 236px;
        min-height: 38px;
        box-sizing: border-box;
        overflow: hidden;
        border: 1px solid rgba(255,180,190,.45);
        border-radius: 10px;
        background: linear-gradient(135deg, rgba(224,16,64,.95), rgba(255,77,106,.95));
        box-shadow: 0 8px 26px rgba(0,0,0,.32), inset 0 0 0 1px rgba(255,255,255,.08);
        backdrop-filter: blur(12px) saturate(140%);
        -webkit-backdrop-filter: blur(12px) saturate(140%);
        color: #fff;
        font-family: "Roboto", "YouTube Sans", system-ui, -apple-system, sans-serif;
        animation: ym-announcement-in .26s cubic-bezier(.22,.61,.36,1);
      }
      #ym-announcement-pill[hidden] { display: none !important; }
      @keyframes ym-announcement-in {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: none; }
      }
      .ym-announcement-pill-main {
        display: flex;
        align-items: center;
        gap: 9px;
        flex: 1 1 auto;
        min-width: 0;
        padding: 4px 4px 4px 9px;
        border: 0;
        background: transparent;
        color: inherit;
        text-align: left;
        font: inherit;
        cursor: pointer;
      }
      .ym-announcement-pill-main:hover { background: rgba(255,255,255,.08); }
      .ym-announcement-pill-main:focus-visible {
        outline: 2px solid rgba(255,255,255,.75);
        outline-offset: -2px;
        border-radius: 8px 0 0 8px;
      }
      .ym-announcement-logo {
        width: 28px;
        height: 28px;
        flex: 0 0 auto;
        border-radius: 7px;
        background-size: cover;
        background-position: center;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,.18);
      }
      .ym-announcement-pill-text {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .ym-announcement-pill-kicker {
        font-size: 9px;
        font-weight: 700;
        line-height: 1.2;
        letter-spacing: .11em;
        text-transform: uppercase;
        white-space: nowrap;
        opacity: .78;
      }
      .ym-announcement-pill-title {
        max-width: 150px;
        overflow: hidden;
        font-size: 12.5px;
        font-weight: 700;
        line-height: 1.25;
        letter-spacing: .005em;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .ym-announcement-pill-close {
        flex: 0 0 auto;
        width: 26px;
        border: 0;
        background: transparent;
        color: rgba(255,255,255,.82);
        font: 16px/1 system-ui, sans-serif;
        cursor: pointer;
      }
      .ym-announcement-pill-close:hover { background: rgba(255,255,255,.16); color: #fff; }
      .ym-announcement-pill-close:focus-visible {
        outline: 2px solid rgba(255,255,255,.75);
        outline-offset: -2px;
        border-radius: 0 8px 8px 0;
      }
      .ym-announcement-card { width: 520px; }
      .ym-announcement-head {
        display: flex;
        align-items: center;
        gap: 12px;
        flex: 0 0 auto;
        padding: 18px 22px 0;
      }
      .ym-announcement-kicker {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: .14em;
        text-transform: uppercase;
        color: rgba(255,122,143,.92);
      }
      .ym-announcement-close { font-size: 20px; line-height: 1; }
      .ym-announcement-body {
        flex: 1 1 auto;
        min-height: 0;
        padding: 12px 22px 24px;
        overflow-y: auto;
      }
      .ym-announcement-title {
        margin: 0;
        color: #fff;
        font-size: 22px;
        font-weight: 700;
        line-height: 1.2;
        letter-spacing: -.02em;
        text-wrap: balance;
      }
      .ym-announcement-copy {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 12px;
        color: rgba(255,255,255,.74);
        font-size: 14px;
        line-height: 1.65;
      }
      .ym-announcement-copy p {
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .ym-announcement-date {
        margin-top: 18px;
        color: rgba(255,255,255,.38);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: .04em;
        text-transform: uppercase;
      }
      @media (max-width: 640px) {
        #ym-announcement-pill { width: min(236px, calc(100vw - 24px)); }
        .ym-announcement-card { width: min(520px, calc(100vw - 32px)); }
      }
      @media (prefers-reduced-motion: reduce) {
        #ym-announcement-pill { animation: none; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function stopPositionRetry() {
    if (positionTimer) {
      window.clearInterval(positionTimer);
      positionTimer = 0;
    }
  }

  function positionPill() {
    if (!pill) return false;
    if (document.querySelector(".ym-upd-banner")) {
      pill.hidden = true;
      return true;
    }
    const nav = document.getElementById("ym-nav-btn");
    if (!nav || !nav.isConnected) {
      pill.style.visibility = "hidden";
      return false;
    }
    const rect = nav.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      pill.style.visibility = "hidden";
      return false;
    }
    pill.style.top = Math.round(rect.top) + "px";
    pill.style.right = Math.max(8, Math.round(window.innerWidth - rect.left + 8)) + "px";
    pill.style.visibility = "visible";
    pill.hidden = false;
    return true;
  }

  function startPositionRetry() {
    stopPositionRetry();
    if (positionPill()) return;
    let tries = 0;
    positionTimer = window.setInterval(() => {
      tries += 1;
      if (!pill || positionPill() || tries > 40) stopPositionRetry();
    }, 300);
  }

  function removePill() {
    stopPositionRetry();
    if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
    pill = null;
  }

  function dismissPill(announcement) {
    if (announcement) {
      dismissedId = announcement.id;
      storageSet({ [DISMISSED_KEY]: announcement.id });
    }
    removePill();
  }

  function formatDate(value) {
    const time = Number(value);
    if (!Number.isFinite(time) || time <= 0) return "";
    try {
      return new Date(time).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    } catch (_) {
      return "";
    }
  }

  function openDetail(announcement) {
    if (!announcement || detailOpen) return;

    seenId = announcement.id;
    storageSet({ [SEEN_KEY]: announcement.id });
    detailOpen = true;

    const previousFocus = document.activeElement;
    const overlay = el("div", { class: "ym-upd-overlay ym-announcement-overlay" });
    const card = el("div", {
      class: "ym-upd-card ym-announcement-card",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Aurora announcement: " + announcement.title,
    });

    const closeButton = el("button", {
      class: "ym-upd-close ym-announcement-close",
      type: "button",
      title: "Close",
      "aria-label": "Close announcement",
      text: "\u00d7",
    });

    const head = el("div", { class: "ym-announcement-head" },
      el("div", { class: "ym-announcement-kicker", text: "Aurora announcement" }),
      closeButton
    );

    const body = el("div", { class: "ym-announcement-body" });
    body.appendChild(el("h2", { class: "ym-announcement-title", text: announcement.title }));

    const copy = el("div", { class: "ym-announcement-copy" });
    const paragraphs = String(announcement.body || "")
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (paragraphs.length) {
      for (const part of paragraphs) copy.appendChild(el("p", { text: part }));
    } else {
      copy.appendChild(el("p", { text: "No further details." }));
    }
    body.appendChild(copy);

    const date = formatDate(announcement.createdAt);
    if (date) body.appendChild(el("div", { class: "ym-announcement-date", text: date }));

    const ok = el("button", { class: "ym-upd-btn primary", type: "button", text: "Got it" });
    const foot = el("div", { class: "ym-upd-foot" }, ok);
    card.append(head, body, foot);
    overlay.appendChild(card);

    const focusables = () => Array.from(overlay.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((node) => node.getClientRects().length);

    function close() {
      document.removeEventListener("keydown", onKey);
      if (overlay.isConnected) {
        card.classList.add("ym-upd-leaving");
        overlay.classList.add("ym-upd-leaving");
        const remove = () => {
          if (overlay.isConnected) overlay.remove();
        };
        overlay.addEventListener("animationend", remove, { once: true });
        window.setTimeout(remove, 400);
      }
      detailOpen = false;
      if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function") {
        try {
          previousFocus.focus({ preventScroll: true });
        } catch (_) {}
      }
      removePill();
    }

    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !overlay.contains(active);
      if (event.shiftKey && (outside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    closeButton.addEventListener("click", close);
    ok.addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });

    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    ok.focus();
  }

  function normalize(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!id || !title) return null;
    return {
      id,
      title: title.slice(0, 90),
      body: typeof raw.body === "string" ? raw.body.slice(0, 420) : "",
      createdAt: Number(raw.createdAt) || 0,
    };
  }

  function showPill(announcement) {
    if (!announcement || detailOpen) return;
    if (announcement.id === seenId || announcement.id === dismissedId) {
      removePill();
      return;
    }
    if (document.visibilityState !== "visible") return;
    if (pill && pill.dataset.id === announcement.id) {
      positionPill();
      return;
    }

    removePill();
    const root = el("div", {
      id: PILL_ID,
      class: "ym-announcement-pill",
      role: "region",
      "aria-label": "Aurora announcement",
    });
    root.dataset.id = announcement.id;
    root.style.visibility = "hidden";

    const main = el("button", {
      class: "ym-announcement-pill-main",
      type: "button",
      title: announcement.title,
      "aria-label": "Open announcement: " + announcement.title,
    });
    const logo = el("span", { class: "ym-announcement-logo", "aria-hidden": "true" });
    try {
      const src = chrome.runtime.getURL("assets/manifest-logo.webp");
      logo.style.backgroundImage = 'url("' + src + '")';
    } catch (_) {}

    main.append(
      logo,
      el("span", { class: "ym-announcement-pill-text" },
        el("span", { class: "ym-announcement-pill-kicker", text: "Aurora announcement" }),
        el("span", { class: "ym-announcement-pill-title", text: announcement.title })
      )
    );
    main.addEventListener("click", () => openDetail(announcement));

    const close = el("button", {
      class: "ym-announcement-pill-close",
      type: "button",
      title: "Dismiss",
      "aria-label": "Dismiss announcement",
      text: "\u00d7",
    });
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      dismissPill(announcement);
    });

    root.append(main, close);
    document.body.appendChild(root);
    pill = root;
    startPositionRetry();
  }

  function maybeShowPill() {
    if (!latest || detailOpen) return;
    if (latest.id === seenId || latest.id === dismissedId) {
      removePill();
      return;
    }
    if (document.visibilityState !== "visible") return;
    showPill(latest);
  }

  async function check(force) {
    if (!force && document.visibilityState !== "visible") return;
    const now = Date.now();
    if (!force && now - lastCheck < MIN_CHECK_GAP_MS) return;
    lastCheck = now;

    let response;
    try {
      response = await fetch(FEED_URL, {
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      if (!warned) {
        alDebug("announcement feed unavailable", error);
        warned = true;
      }
      return;
    }
    warned = false;
    if (!response.ok) return;

    let data;
    try {
      data = await response.json();
    } catch (_) {
      return;
    }
    if (!data || typeof data !== "object") return;

    const announcement = normalize(data.announcement);
    if (!announcement) {
      latest = null;
      removePill();
      return;
    }

    latest = announcement;
    const stored = await storageGet([SEEN_KEY, DISMISSED_KEY]);
    if (typeof stored[SEEN_KEY] === "string") seenId = stored[SEEN_KEY];
    if (typeof stored[DISMISSED_KEY] === "string") dismissedId = stored[DISMISSED_KEY];

    if (announcement.id === seenId || announcement.id === dismissedId) {
      removePill();
      return;
    }
    maybeShowPill();
  }

  function schedulePoll() {
    const delay = POLL_MS + Math.floor(Math.random() * 30000);
    window.setTimeout(async () => {
      await check(false);
      schedulePoll();
    }, delay);
  }

  function start() {
    if (started) return;
    started = true;

    const stalePill = document.getElementById(PILL_ID);
    if (stalePill) stalePill.remove();
    document.querySelectorAll(".ym-announcement-overlay").forEach((node) => node.remove());
    const staleStyle = document.getElementById(STYLE_ID);
    if (staleStyle) staleStyle.remove();
    ensureStyle();

    storageGet([SEEN_KEY, DISMISSED_KEY]).then((stored) => {
      if (typeof stored[SEEN_KEY] === "string") seenId = stored[SEEN_KEY];
      if (typeof stored[DISMISSED_KEY] === "string") dismissedId = stored[DISMISSED_KEY];
    });

    window.setTimeout(() => check(true), FIRST_CHECK_MS);
    schedulePoll();

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      check(false);
      maybeShowPill();
    });
    window.addEventListener("online", () => check(true));
    window.addEventListener("resize", () => {
      if (pill) positionPill();
    });

    const observer = new MutationObserver(() => {
      if (!document.body) return;
      if (document.querySelector(".ym-upd-banner")) {
        if (pill) pill.hidden = true;
        return;
      }
      maybeShowPill();
    });
    observer.observe(document.body, { childList: true });
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
