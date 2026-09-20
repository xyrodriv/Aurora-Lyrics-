/*
 * Smooth Motion — Aurora Lyrics add-on.
 *
 * Adds tasteful motion to YouTube Music. Every module is independently
 * toggleable from the extension settings (master + 4 modules):
 *
 *   1. guide   — eases the left guide open/close. YTM pins an inline
 *                "transition-duration: 0ms" on the drawer, so the panel snaps
 *                away; we re-enable the slide, fade the panel's opacity, and
 *                ease the content reflow. The mini rail fades in after.
 *   2. search  — the suggestions dropdown fades + slides in on open, and fades
 *                out on close (YTM hides it instantly otherwise).
 *   3. pages   — SPA navigations fade the new page in. The container is
 *                pre-hidden on yt-navigate-start and revealed on the content
 *                swap, so the fade IS the appearance (not after it).
 *   4. micro   — small hover/press transitions on buttons, cards and chips.
 *
 * Runs in the page world (injected as <script src>), so it can read YTM's DOM
 * and receive settings over window.postMessage like the other add-ons.
 *
 * Safety notes baked into the CSS:
 *   - Only composited-friendly props (opacity / transform) are animated, and
 *     never a transform on a scroll container, so sticky/scroll keep working.
 *   - No permanent will-change (that caused the panel perf regression once).
 *   - prefers-reduced-motion disables everything.
 */
(function () {
  "use strict";

  // Diagnostics. Flip SM_DEBUG to true to get the "[SmoothMotion] ..." trace back
  // (build marker, nav triggers, container switches, reveal reasons) — the whole
  // debug loop is: set true, reload the tab, drive the page, read the console.
  const SM_DEBUG = false;
  const dbg = (...args) => { if (SM_DEBUG) console.log("[SmoothMotion]", ...args); };
  dbg("build r15 loaded");

  const EXT_ID = "ytmod-smooth-motion";
  const STYLE_ID = "ym-sm-style";
  const NAV_FINISH = "yt-navigate-finish";
  const NAV_START = "yt-navigate-start";
  const URL_POLL_MS = 250;
  const NAV_WINDOW_MS = 2000;  // how long after a click we keep watching
  const REVEAL_QUIET_MS = 140; // quiet period that means "the page has settled"
  const FALLBACK_MS = 1500;    // last-resort reveal if the swap was never seen

  const DEFAULTS = { master: true, guide: true, search: true, pages: true, micro: true };
  let settings = Object.assign({}, DEFAULTS);
  let urlPoll = 0;
  let lastUrl = location.href;
  let pageAnimTimer = 0;
  let revealTimer = 0;
  let fallbackTimer = 0;
  let navHandler = null;
  let startHandler = null;
  let navUntil = 0;       // deadline; 0 means "no navigation in flight"
  let navStartUrl = "";
  let pageObserver = null;
  let pageHidden = false; // is the page container currently hidden by us?
  let shownEl = null;     // the container we last saw displayed

  const CSS = `
    /* ===== Smooth Motion (Aurora Lyrics) ===== */
    :root {
      --ym-sm-ease: cubic-bezier(.22,.61,.36,1);
      --ym-sm-dur: .3s;
    }

    /* 1. Guide open/close. Content reflow: ease the offset so it glides. */
    html.ym-sm-guide #content-wrapper {
      transition: margin-left var(--ym-sm-dur) var(--ym-sm-ease) !important;
    }
    html.ym-sm-guide #player-page {
      transition: left var(--ym-sm-dur) var(--ym-sm-ease),
                  width var(--ym-sm-dur) var(--ym-sm-ease) !important;
    }
    /* The mini rail toggles display:none -> block, so a transition never runs
       (it pops in instantly and overlaps the sliding panel). Use an animation
       instead, delayed so it fades in after the panel has slid away. */
    html.ym-sm-guide #mini-guide {
      animation: ym-sm-mini-in .2s var(--ym-sm-ease) .2s both;
    }
    @keyframes ym-sm-mini-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    /* The drawer itself. YTM pins transition-duration:0ms inline, so the panel
       vanishes in one frame; an !important stylesheet rule beats a normal inline
       style. We also fade the panel's opacity with the slide. Visibility is
       delayed when collapsing (so the fade is visible) but immediate when
       opening (so it does not appear late). */
    html.ym-sm-guide #guide {
      transition: opacity var(--ym-sm-dur) var(--ym-sm-ease),
                  visibility 0s linear 0s !important;
    }
    html.ym-sm-guide.ym-sm-guide-collapsed #guide {
      opacity: 0;
      transition: opacity var(--ym-sm-dur) var(--ym-sm-ease),
                  visibility 0s linear var(--ym-sm-dur) !important;
    }
    html.ym-sm-guide #guide #contentContainer {
      transition-duration: var(--ym-sm-dur) !important;
      transition-timing-function: var(--ym-sm-ease) !important;
    }

    /* 2. Search suggestions. YTM hides the list by flipping display:none, which
       can't be transitioned, and fighting that with JS just made it flicker.
       Instead keep the list displayed and drive show/hide off the search box's
       own "opened" attribute via opacity + visibility + transform — so BOTH the
       open and the close animate, with no JS.
       NOTE: never use a backtick inside this comment block — the whole
       stylesheet is a JS template literal and a stray backtick kills the file. */
    html.ym-sm-search ytmusic-search-box #suggestion-list {
      display: block !important;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translateY(-8px);
      transform-origin: top center;
      transition: opacity .2s var(--ym-sm-ease),
                  transform .24s var(--ym-sm-ease),
                  visibility 0s linear .24s;
    }
    html.ym-sm-search ytmusic-search-box[opened] #suggestion-list {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: translateY(0);
      transition: opacity .2s var(--ym-sm-ease),
                  transform .24s var(--ym-sm-ease),
                  visibility 0s linear 0s;
    }

    /* 3. Page transitions. The wrapper is pre-hidden on navigate-start and
       revealed (fade/rise) on the content swap, so the fade IS the appearance
       rather than playing after the new content has already shown. */
    html.ym-sm-pages .ym-sm-page-out { opacity: 0 !important; }
    html.ym-sm-pages .ym-sm-page-in {
      animation: ym-sm-page .34s var(--ym-sm-ease) both;
    }
    @keyframes ym-sm-page {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* 4. Micro-interactions: subtle hover/press motion. */
    html.ym-sm-micro ytmusic-carousel-shelf-renderer ytmusic-two-row-item-renderer,
    html.ym-sm-micro ytmusic-grid-renderer ytmusic-two-row-item-renderer,
    html.ym-sm-micro ytmusic-carousel-shelf-renderer ytmusic-responsive-list-item-renderer {
      transition: transform .18s var(--ym-sm-ease) !important;
    }
    html.ym-sm-micro ytmusic-carousel-shelf-renderer ytmusic-two-row-item-renderer:hover,
    html.ym-sm-micro ytmusic-grid-renderer ytmusic-two-row-item-renderer:hover,
    html.ym-sm-micro ytmusic-carousel-shelf-renderer ytmusic-responsive-list-item-renderer:hover {
      transform: translateY(-3px);
    }
    html.ym-sm-micro ytmusic-nav-bar yt-icon-button,
    html.ym-sm-micro ytmusic-nav-bar tp-yt-paper-icon-button,
    html.ym-sm-micro ytmusic-player-bar tp-yt-paper-icon-button,
    html.ym-sm-micro ytmusic-player-bar yt-icon-button {
      transition: transform .16s var(--ym-sm-ease), opacity .16s ease !important;
    }
    html.ym-sm-micro ytmusic-nav-bar yt-icon-button:hover,
    html.ym-sm-micro ytmusic-nav-bar tp-yt-paper-icon-button:hover,
    html.ym-sm-micro ytmusic-player-bar tp-yt-paper-icon-button:hover,
    html.ym-sm-micro ytmusic-player-bar yt-icon-button:hover {
      transform: scale(1.08);
    }
    html.ym-sm-micro ytmusic-chip-cloud-chip-renderer,
    html.ym-sm-micro tp-yt-paper-chip {
      transition: transform .18s var(--ym-sm-ease),
                  background-color .18s ease !important;
    }
    html.ym-sm-micro ytmusic-chip-cloud-chip-renderer:hover {
      transform: translateY(-2px);
    }

    @media (prefers-reduced-motion: reduce) {
      html.ym-sm-guide #content-wrapper,
      html.ym-sm-guide #player-page,
      html.ym-sm-guide #mini-guide,
      html.ym-sm-guide #guide,
      html.ym-sm-guide #guide #contentContainer { transition: none !important; }
      html.ym-sm-search ytmusic-search-box #suggestion-list,
      html.ym-sm-guide #mini-guide,
      html.ym-sm-pages .ym-sm-page-in { animation: none !important; }
      html.ym-sm-micro * { transition: none !important; }
    }
  `;

  function whenYTMod(callback) {
    if (window.YTMod && window.YTMod.player) return callback();
    setTimeout(() => whenYTMod(callback), 200);
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function guideOn() { return settings.master !== false && settings.guide !== false; }
  function pagesOn() { return settings.master !== false && settings.pages !== false; }

  function applySettings(next) {
    settings = Object.assign({}, settings, next || {});
    const master = settings.master !== false;
    const on = (key) => master && settings[key] !== false;
    const root = document.documentElement;
    root.classList.toggle("ym-sm-on", master);
    root.classList.toggle("ym-sm-guide", on("guide"));
    root.classList.toggle("ym-sm-search", on("search"));
    root.classList.toggle("ym-sm-pages", on("pages"));
    root.classList.toggle("ym-sm-micro", on("micro"));
    if (settings.guide !== false) syncGuideState();
    // If the module is switched off mid-transition, don't leave the page hidden.
    if (!on("pages") && pageHidden) {
      if (revealTimer) { clearTimeout(revealTimer); revealTimer = 0; }
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = 0; }
      pageHidden = false;
      navUntil = 0;
    }
  }

  // ---- 1. guide ------------------------------------------------------------
  // The drawer exposes no state attribute, so we track it ourselves: sync on
  // load, and flip it the instant the hamburger is pressed (capture phase, so
  // it lands before YTM's own handler starts the slide).
  function syncGuideState() {
    const guide = document.querySelector("#guide");
    if (!guide) return;
    document.documentElement.classList.toggle(
      "ym-sm-guide-collapsed",
      guide.offsetWidth < 120 // 72 when collapsed, 240 when expanded
    );
  }

  function onPointerDown(event) {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    // Guide toggle (capture phase, so it lands before YTM starts the slide).
    if (guideOn() && target.closest("#guide-button")) {
      document.documentElement.classList.toggle("ym-sm-guide-collapsed");
    }
  }

  // ---- 3. page transitions -------------------------------------------------
  // YTM does NOT rebuild the page container on navigation. Each page type has its
  // own container, all siblings under ytmusic-app-layout, and only the active one
  // is displayed — the rest stay in the DOM at display:none. Inside a container,
  // the content node is static too; the router only re-stamps what is *inside* it.
  // Three consequences that shaped this module:
  //
  //   * A plain querySelector is not enough to find "the page": on a search
  //     results page "ytmusic-browse-response" is still in the DOM but
  //     display:none, so matching it animates an invisible element and the
  //     visible page never animates. Pick the container that has a layout box.
  //   * Observing a whole container fires on the <dom-if> toggles that happen at
  //     click time — long before the page swaps. Acting there animates the page
  //     you are LEAVING (the "old tab fades in" bug). So a mutation only counts
  //     if it landed in the content node.
  //   * "yt-navigate-start" / "yt-navigate-finish" never fire on YTM (verified
  //     live 2026-09-16 — every markNavigating was preceded by a nav click), so a
  //     click or an Enter in the search box is the only "leaving" signal.
  //
  // We therefore never pre-hide. We wait for the content to actually be
  // replaced, hide the container in that same microtask (pre-paint, so a
  // half-rendered page never shows), then reveal once the DOM goes quiet.
  const PAGE_TYPES = [
    { container: "ytmusic-search-page", content: "ytmusic-tabbed-search-results-renderer" },
    { container: "ytmusic-browse-response #content-wrapper", content: "ytmusic-section-list-renderer" },
  ];

  // True while a song view is the real page: either the /watch route, or the
  // expanded player page opened over a browse page. In BOTH cases the browse /
  // search containers are still in the DOM at display:block — YTM does NOT put
  // [hidden] on them, it merely collapses them to a 0x0 box — so they would read
  // as "the current page" below. Animating one there reveals a page the user is
  // not actually on, and it bleeds through the transparent player/watch page
  // (AJ-confirmed 2026-09-16: turning Smooth Motion off stopped the bleed).
  function songViewActive() {
    try {
      if (String(location.pathname || "").indexOf("/watch") === 0) return true;
    } catch (_) {}
    return !!document.querySelector("ytmusic-app-layout[player-page-open]");
  }

  // The page container that is actually on screen, paired with the node inside it
  // that holds the real content. YTM marks the inactive containers with the
  // "hidden" attribute, so the active page is the one without it — an attribute
  // read, deliberately not offsetHeight, which would force a layout flush inside
  // a mutation callback. Falls back to any container that exists so we still
  // behave sensibly mid-transition.
  function currentPage() {
    // No page transition to run on a song view: the watch page is not one of
    // PAGE_TYPES, so anything we animated there would be the wrong element.
    if (songViewActive()) return null;
    let fallback = null;
    for (const type of PAGE_TYPES) {
      const el = document.querySelector(type.container);
      if (!el) continue;
      const page = { el: el, content: type.content };
      if (!fallback) fallback = page;
      if (!el.hasAttribute("hidden")) return page;
    }
    return fallback;
  }

  function pageEl() {
    const page = currentPage();
    return page ? page.el : null;
  }

  // Diagnostics: identify a container in the log (tag, id, hidden state).
  function describe(el) {
    if (!el) return "none";
    return el.tagName + (el.id ? "#" + el.id : "") +
           (el.hasAttribute("hidden") ? "[hidden]" : "[shown]");
  }

  // The node that actually gets re-stamped when the page changes. Null until YTM
  // has rendered it — and while it is null we cannot tell a page change from
  // <dom-if> chrome, so we deliberately do nothing rather than guess.
  function contentHost() {
    const page = currentPage();
    if (!page) return null;
    return page.el.querySelector(page.content);
  }

  // A mutation only counts if it happened inside the current page's content node.
  // Everything else is <dom-if> / #footer / #tabs chrome that toggles on click
  // and would give us a false positive.
  function isPageMutation(mutation, host) {
    const t = mutation.target;
    if (t === host || host.contains(t)) return true;
    // The content node itself being swapped in or out also counts.
    const tag = host.tagName;
    for (const n of mutation.addedNodes) {
      if (n.nodeType === 1 && n.tagName === tag) return true;
    }
    for (const n of mutation.removedNodes) {
      if (n.nodeType === 1 && n.tagName === tag) return true;
    }
    return false;
  }

  // The swap is "an element was removed from the page content" — an insertion
  // alone (a spinner, a lazily-added shelf) is not a page change. The host is
  // resolved once per batch, not once per mutation.
  function looksLikeSwap(mutations) {
    const host = contentHost();
    if (!host) return false;
    for (const m of mutations) {
      if (!isPageMutation(m, host)) continue;
      for (const n of m.removedNodes) if (n.nodeType === 1) return true;
    }
    return false;
  }

  function hidePage() {
    const el = pageEl();
    if (!el) return;
    // Never leave a stale hide on a container we are not animating any more.
    document.querySelectorAll(".ym-sm-page-out").forEach((n) => {
      if (n !== el) n.classList.remove("ym-sm-page-out");
    });
    el.classList.remove("ym-sm-page-in");
    el.classList.add("ym-sm-page-out");
    pageHidden = true;
  }

  function revealPage(reason) {
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = 0; }
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = 0; }
    if (!pageHidden) return;
    pageHidden = false;
    navUntil = 0; // this navigation is done
    const el = pageEl();
    if (!el) {
      // Safety net: never leave a container stranded at opacity:0 just because we
      // could not resolve the current page (e.g. a song view is up and
      // currentPage() deliberately returned null).
      document.querySelectorAll(".ym-sm-page-out").forEach((n) => {
        n.classList.remove("ym-sm-page-out");
      });
      return;
    }
    dbg("reveal", reason, describe(el));
    shownEl = el;
    el.classList.remove("ym-sm-page-out");
    el.classList.remove("ym-sm-page-in");
    void el.offsetWidth; // restart the animation
    el.classList.add("ym-sm-page-in");
    if (pageAnimTimer) clearTimeout(pageAnimTimer);
    pageAnimTimer = window.setTimeout(() => {
      el.classList.remove("ym-sm-page-in");
      pageAnimTimer = 0;
    }, 480);
  }

  // Reveal once the DOM stops changing, so we animate the finished page rather
  // than a partial render.
  function scheduleReveal() {
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = window.setTimeout(() => revealPage("settled"), REVEAL_QUIET_MS);
  }

  function onPageMutations(mutations) {
    if (!pagesOn()) return;
    if (!navUntil || performance.now() > navUntil) return; // not navigating
    const page = currentPage();
    if (!page) return;
    const el = page.el;
    // (a) A different page container just became the visible one. YTM does this
    //     by toggling the "hidden" attribute, which is why the observer watches
    //     attributes too. Hide it in this same microtask so it never paints
    //     un-animated — without this, a slow navigation (search by Enter) shows
    //     the new page first and only then fades it, which reads as a flicker.
    if (el !== shownEl) {
      shownEl = el;
      dbg("page container -> ", describe(el));
      hidePage();
      navUntil = performance.now() + NAV_WINDOW_MS;
      scheduleReveal();
      return;
    }
    // (b) Same container, but its content was re-stamped (search -> search,
    //     playlist -> playlist).
    if (pageHidden) { scheduleReveal(); return; }
    if (!looksLikeSwap(mutations)) return; // dom-if noise / lazy load
    dbg("page swap detected", describe(contentHost()));
    hidePage();
    navUntil = performance.now() + NAV_WINDOW_MS; // keep watching while it renders
    scheduleReveal();
  }

  function ensurePageObserver() {
    // Observed at the app root so switching between page containers (browse ->
    // search) stays inside one observer; the callback filters every batch down to
    // the current page's content node.
    const target =
      document.querySelector("ytmusic-app-layout") ||
      document.querySelector("ytmusic-app");
    if (!target) return;
    if (pageObserver && pageObserver.__target === target) return;
    if (pageObserver) pageObserver.disconnect();
    pageObserver = new MutationObserver(onPageMutations);
    pageObserver.__target = target;
    // attributes + attributeFilter: the page switch IS a "hidden" toggle, and an
    // attribute mutation is delivered pre-paint, so hiding there beats the paint.
    pageObserver.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
    dbg("page observer on", target.tagName);
  }

  function markNavigating() {
    if (!pagesOn()) return;
    dbg("markNavigating");
    navUntil = performance.now() + NAV_WINDOW_MS;
    navStartUrl = location.href;
    ensurePageObserver();
    // Last resort: if the swap never tripped the observer (e.g. the section list
    // was reused wholesale with no removals) reveal once the navigation has
    // certainly finished, so the page can never be left un-animated. Logged
    // distinctly — if you see this in the console, detection failed.
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = window.setTimeout(() => {
      fallbackTimer = 0;
      if (!navUntil) return;                        // already resolved
      if (pageHidden) { revealPage("settled (late)"); return; }
      if (location.href === navStartUrl) return;    // no real navigation
      dbg("swap never detected -> late fallback");
      hidePage();
      scheduleReveal();
    }, FALLBACK_MS);
  }

  // YTM navigates from several element types, not just anchors — cards and the
  // guide entries are custom elements, the top tabs are paper-tabs, and the
  // search dropdown's suggested searches are "ytmusic-search-suggestion", which
  // is NOT an anchor. Leaving a type out here silently disables the animation
  // for that whole route (that is what broke suggested-search clicks).
  const NAV_TARGET_SEL = [
    "a[href]",
    "ytmusic-guide-entry-renderer",
    "ytmusic-nav-bar tp-yt-paper-tab",
    "ytmusic-search-suggestion",
    "ytmusic-carousel-shelf-renderer ytmusic-two-row-item-renderer",
    "ytmusic-grid-renderer ytmusic-two-row-item-renderer",
    "ytmusic-responsive-list-item-renderer",
  ].join(",");

  function onDocClick(event) {
    if (!pagesOn()) return;
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    // Skip plain buttons (play, like, overflow menus) — they don't navigate.
    if (target.closest("button, tp-yt-paper-icon-button, yt-icon-button, ytmusic-play-button-renderer")) return;
    const hit = target.closest(NAV_TARGET_SEL);
    if (!hit) return;
    // Anchors only pre-hide for internal YTM navigations (external links leave
    // the SPA, so there is nothing to animate).
    if (hit.tagName === "A") {
      const href = hit.getAttribute("href") || "";
      if (href.charAt(0) !== "/" && href.indexOf("music.youtube.com") === -1) return;
    }
    dbg("nav click", hit.tagName);
    markNavigating();
  }

  // Submitting the search box (Enter, or picking a suggestion with the keyboard)
  // navigates with no click to hook — and the search results page is its own
  // container, so without this it would be the one page that never animates.
  function onKeyDown(event) {
    if (event.key !== "Enter") return;
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    if (!target.closest("ytmusic-search-box")) return;
    dbg("search submit");
    markNavigating();
  }

  function startPageWatch() {
    navHandler = () => { markNavigating(); };
    startHandler = () => { markNavigating(); };
    // Kept as cheap insurance: these never actually fire on YTM (verified
    // 2026-09-16), but they cost nothing and cover a future nav path.
    document.addEventListener(NAV_FINISH, navHandler);
    window.addEventListener(NAV_FINISH, navHandler);
    document.addEventListener(NAV_START, startHandler);
    window.addEventListener(NAV_START, startHandler);
    // A click or a search submit is the ONLY reliable "leaving" signal YTM gives
    // us, so the whole navigation window is armed from those two.
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    // Keep the tracked guide state fresh across navigations. A URL change is
    // also a safety net: if a route's click target is not in NAV_TARGET_SEL, the
    // observer would stay disarmed and that route would silently never animate
    // (which is exactly how suggested-search clicks broke). The poll lands well
    // before the page container swaps, so path (a) still catches it pre-paint.
    urlPoll = window.setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        syncGuideState();
        markNavigating();
      }
    }, URL_POLL_MS);
    ensurePageObserver();
  }

  // ---- lifecycle -----------------------------------------------------------
  function start() {
    ensureStyle();
    applySettings(settings);
    dbg("start", JSON.stringify(settings));
    document.addEventListener("pointerdown", onPointerDown, true);
    startPageWatch();
    syncGuideState();
    shownEl = pageEl(); // baseline for "a different container became visible"
  }

  function teardown() {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (navHandler) {
      document.removeEventListener(NAV_FINISH, navHandler);
      window.removeEventListener(NAV_FINISH, navHandler);
    }
    if (startHandler) {
      document.removeEventListener(NAV_START, startHandler);
      window.removeEventListener(NAV_START, startHandler);
    }
    navHandler = null;
    startHandler = null;
    if (urlPoll) { clearInterval(urlPoll); urlPoll = 0; }
    if (pageAnimTimer) { clearTimeout(pageAnimTimer); pageAnimTimer = 0; }
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = 0; }
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = 0; }
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
    navUntil = 0;
    navStartUrl = "";
    pageHidden = false;
    shownEl = null;
    const root = document.documentElement;
    root.classList.remove(
      "ym-sm-on", "ym-sm-guide", "ym-sm-search", "ym-sm-pages", "ym-sm-micro",
      "ym-sm-guide-collapsed"
    );
    document.querySelectorAll(".ym-sm-page-in, .ym-sm-page-out")
      .forEach((el) => el.classList.remove("ym-sm-page-in", "ym-sm-page-out"));
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.id !== EXT_ID) return;
    if (data.type === "ytmod-settings") {
      applySettings(data.settings);
      return;
    }
    if (data.type !== "ytmod-ext") return;
    if (data.action === "disable") teardown();
  });

  whenYTMod(() => {
    start();
    window.postMessage({ type: "ytmod-settings-request", id: EXT_ID }, "*");
  });
})();
