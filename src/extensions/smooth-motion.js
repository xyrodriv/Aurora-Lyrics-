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
  dbg("build r17 loaded");

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

    /* 1. Guide open/close. Ease the browse-content offset so it glides. Gated on
       the ym-sm-guiding class, armed for ONE interaction and then removed — it is
       NEVER left on.

       #player-page is deliberately NOT in this list any more. It is the element
       the VIDEO lives in, and YTM owns both its left/width and the video's inline
       size. It also already gives #player-page its own
       "transition: transform .3s cubic-bezier(.2,0,.6,1)" plus
       "will-change: transform" (both measured live) — and ours carried !important,
       so we were silently REPLACING that transform transition with a layout one.

       A live left/width transition on that element glides the box while the video
       inside keeps its OLD size for the whole 0.3s: the container grows, the
       content does not, and the page behind shows through the difference. That is
       the "black space". It is not a rendering glitch — it is the container and
       its content disagreeing about how big the container is.

       So let the geometry SNAP (nothing measured ever moves) and animate the video
       itself instead — a compositor-only FLIP. See the video-glide block below.
       NO BACKTICKS ANYWHERE IN THIS COMMENT BLOCK — this whole stylesheet is a JS
       template literal and a stray backtick terminates it early. */
    html.ym-sm-guide.ym-sm-guiding #content-wrapper {
      transition: margin-left var(--ym-sm-dur) var(--ym-sm-ease) !important;
    }
    /* The mini rail toggles display:none -> block, so a transition never runs
       (it pops in instantly and overlaps the sliding panel). Use an animation
       instead, delayed so it fades in after the panel has slid away.
       Gated on the collapsed class rather than on .ym-sm-guiding alone: the rail
       fades IN when collapsing and OUT when opening, and .ym-sm-guiding is armed
       for BOTH directions, so it cannot pick between them on its own. */
    html.ym-sm-guide.ym-sm-guiding.ym-sm-guide-collapsed #mini-guide {
      animation: ym-sm-mini-in .2s var(--ym-sm-ease) .2s both;
    }
    @keyframes ym-sm-mini-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    /* ...and the OUT direction. YTM takes the rail out of the layout the instant
       the guide expands, so by the time our opening class lands there is nothing
       left to animate and it pops away. Hold it displayed for the length of the
       opening window, fade it out underneath, and let YTM's own display:none
       collect it once it is already invisible. pointer-events:none so a
       half-faded rail is never clickable. */
    html.ym-sm-guide.ym-sm-guide-opening #mini-guide {
      display: block !important;
      pointer-events: none !important;
      animation: ym-sm-mini-out .2s var(--ym-sm-ease) both;
    }
    @keyframes ym-sm-mini-out {
      from { opacity: 1; }
      to   { opacity: 0; }
    }
    /* The drawer itself. YTM pins transition-duration:0ms inline, so the panel
       vanishes in one frame; an !important stylesheet rule beats a normal inline
       style. We also fade the panel's opacity with the slide. Visibility is
       delayed when collapsing (so the fade is visible) but immediate when
       opening (so it does not appear late). */
    html.ym-sm-guide.ym-sm-guiding #guide {
      transition: opacity var(--ym-sm-dur) var(--ym-sm-ease),
                  visibility 0s linear 0s !important;
    }
    html.ym-sm-guide.ym-sm-guiding.ym-sm-guide-collapsed #guide {
      transition: opacity var(--ym-sm-dur) var(--ym-sm-ease),
                  visibility 0s linear var(--ym-sm-dur) !important;
    }
    /* The collapsed END STATE, on the persistent class. This used to hang off the
       transient .ym-sm-guiding, which is dropped 380ms after the click — at which
       point opacity snapped back to 1 and the panel flashed back into view until
       YTM's own teardown got round to hiding it. That was the "panel opacity goes
       down which is good, but briefly shows for a second then disappears".
       .ym-sm-guide-collapsed is the class that outlives the interaction, so the
       end state belongs there; .ym-sm-guiding only supplies the TRANSITION
       between the two states, never a state of its own. */
    html.ym-sm-guide.ym-sm-guide-collapsed #guide {
      opacity: 0 !important;
    }
    /* Opening. While collapsed #guide is display:none, and a transition cannot
       run out of a display:none start state — there is no computed style to
       animate FROM, so the panel just pops open. An ANIMATION does run on a
       newly-displayed element: its first keyframe supplies the missing start
       value. So the open fade is an animation, on a class added only when
       opening. (Where #guide is merely visibility:hidden the persistent rule
       above already hands the transition an opacity:0 to start from; the
       animation then simply does the same job. Both paths, one visual.) */
    html.ym-sm-guide.ym-sm-guide-opening #guide {
      animation: ym-sm-guide-in var(--ym-sm-dur) var(--ym-sm-ease) both;
    }
    @keyframes ym-sm-guide-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    html.ym-sm-guide.ym-sm-guiding #guide #contentContainer {
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
    /* Hover/press scale for the chrome buttons. Two separate traps here, and both
       of them made a button look dead rather than wrong:

       1. The individual "scale" property, NOT transform: scale(). These buttons
          carry transforms of their own — .toggle-player-page-button (the arrow at
          the far right of the player bar) is rotate(180deg) — and transform:
          scale() REPLACES that, so the chevron flipped upside down instead of
          growing. "scale" is a separate property and composes with transform.

       2. The selector list has to name every button SHAPE. YTM's newer spec
          buttons (like / dislike / action menu) are plain elements carrying
          ytSpecButtonShapeNextHost, NOT yt-icon-button, so the original
          yt-icon-button-only rule silently skipped all three. .ym-pb-btn is ours
          (PiP + sleep timer).
          Deliberately NOT a blanket "ytmusic-player-bar button": every
          yt-icon-button wraps an inner <button>, and scaling both compounds to
          1.08 squared. */
    html.ym-sm-micro ytmusic-nav-bar yt-icon-button,
    html.ym-sm-micro ytmusic-nav-bar tp-yt-paper-icon-button,
    html.ym-sm-micro ytmusic-player-bar yt-icon-button,
    html.ym-sm-micro ytmusic-player-bar tp-yt-paper-icon-button,
    html.ym-sm-micro ytmusic-player-bar [class*="ytSpecButtonShapeNextHost"] {
      transition: scale .16s var(--ym-sm-ease), opacity .16s ease !important;
    }
    /* Ours already animate colour, so keep those in the list rather than
       replacing them with a scale-only transition. */
    html.ym-sm-micro ytmusic-player-bar .ym-pb-btn {
      transition: scale .16s var(--ym-sm-ease), color .16s ease,
                  background-color .16s ease !important;
    }
    html.ym-sm-micro ytmusic-nav-bar yt-icon-button:hover,
    html.ym-sm-micro ytmusic-nav-bar tp-yt-paper-icon-button:hover,
    html.ym-sm-micro ytmusic-player-bar yt-icon-button:hover,
    html.ym-sm-micro ytmusic-player-bar tp-yt-paper-icon-button:hover,
    html.ym-sm-micro ytmusic-player-bar [class*="ytSpecButtonShapeNextHost"]:hover,
    html.ym-sm-micro ytmusic-player-bar .ym-pb-btn:hover {
      scale: 1.08;
    }
    html.ym-sm-micro ytmusic-chip-cloud-chip-renderer,
    html.ym-sm-micro tp-yt-paper-chip {
      transition: transform .18s var(--ym-sm-ease),
                  background-color .18s ease !important;
    }
    html.ym-sm-micro ytmusic-chip-cloud-chip-renderer:hover {
      transform: translateY(-2px);
    }

    /* 5. YTM action-menu popup (the ... overflow menu on the player bar). YTM
       ships it with transition: all at 0s, so it pops in AND out instantly.
       - OPEN: JS pre-hides it for one frame (.ym-sm-menu-popup-pre, opacity 0)
         so the user never sees a flash of the final state, then runs a brief
         fade+rise (.ym-sm-menu-popup-open).
       - CLOSE: YTM collapses the real popup (and drops its content) on the
         same click, so a clone has nothing to render. Instead we INTERCEPT
         the close click, hold YTM off for .15s while the real content is still
         visible, fade the popup's opacity to 0, then let YTM collapse it
         (.ym-sm-menu-popup-closing). All gated on html.ym-sm-on. */
    @keyframes ym-sm-menu-in {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    html.ym-sm-on ytmusic-menu-popup-renderer.ym-sm-menu-popup-pre {
      opacity: 0 !important;
    }
    html.ym-sm-on ytmusic-menu-popup-renderer.ym-sm-menu-popup-open {
      animation: ym-sm-menu-in .18s var(--ym-sm-ease) both !important;
    }
    html.ym-sm-on ytmusic-menu-popup-renderer.ym-sm-menu-popup-closing {
      opacity: 0 !important;
      pointer-events: none !important;
      transition: opacity .15s var(--ym-sm-ease) !important;
    }

    @media (prefers-reduced-motion: reduce) {
      /* These selectors MUST carry the same .ym-sm-guiding class as the rules
         they override. Both sides are !important, so specificity decides — and
         a bare "html.ym-sm-guide #content-wrapper" would LOSE to the gated rule
         and the transition would still run with reduced motion requested.
         (The collapsed variant has one extra class, so it needs its own entry.)
         armGuideWindow() also refuses to add the class under reduced motion, and
         applyFlip() bails on it, so this block is the second line of defence
         rather than the only one. */
      html.ym-sm-guide.ym-sm-guiding #content-wrapper,
      html.ym-sm-guide.ym-sm-guiding #mini-guide,
      html.ym-sm-guide.ym-sm-guiding #guide,
      html.ym-sm-guide.ym-sm-guide-collapsed #guide,
      html.ym-sm-guide.ym-sm-guiding #guide #contentContainer { transition: none !important; }
      html.ym-sm-search ytmusic-search-box #suggestion-list,
      html.ym-sm-guide.ym-sm-guiding #mini-guide,
      html.ym-sm-guide.ym-sm-guide-opening #guide,
      html.ym-sm-guide.ym-sm-guide-opening #mini-guide,
      html.ym-sm-pages .ym-sm-page-in,
      html.ym-sm-on ytmusic-menu-popup-renderer.ym-sm-menu-popup-open,
      html.ym-sm-on ytmusic-menu-popup-renderer.ym-sm-menu-popup-closing { animation: none !important; }
      /* Reduced motion: the close fade is a transition, not an animation, so
         switch the transition off too — the popup snaps closed instantly. */
      html.ym-sm-on ytmusic-menu-popup-renderer.ym-sm-menu-popup-closing { transition: none !important; }
      /* The opening rail rule forces display:block so the fade-out has something
         left to fade. With the animation switched off above it would just linger
         on screen for the whole window, so hand the display back to YTM. */
      html.ym-sm-guide.ym-sm-guide-opening #mini-guide { display: none !important; }
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
    // AJ 2026-09-28: Aurora Flow has no settings UI — every module is always
    // on. Ignore the incoming `next` and force all gates true so the gates
    // below (guideOn / pagesOn / etc.) and the root class toggles land in the
    // enabled state regardless of what content.js sends.
    settings = Object.assign({}, settings, next || {});
    const master = true;
    const on = (_key) => true;
    const root = document.documentElement;
    root.classList.toggle("ym-sm-on", master);
    root.classList.toggle("ym-sm-guide", on("guide"));
    root.classList.toggle("ym-sm-search", on("search"));
    root.classList.toggle("ym-sm-pages", on("pages"));
    root.classList.toggle("ym-sm-micro", on("micro"));
    syncGuideState();
    // The video glide belongs to this module too: it is what keeps the player
    // looking right while the panel reflows, and it covers a devtools open or a
    // window resize with the same code. Drop the observer when the module is off.
    if (on("guide")) observeVideo();
    else if (flipObserver) {
      flipObserver.disconnect();
      flipObserver = null;
      flipEl = null;
      flipPrev = null;
    }
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
    // Never resample mid-interaction. The drawer's width is only half-way there
    // during the slide, so a sync landing inside that window latches whatever it
    // happened to catch — and now that the collapsed class also drives opacity, a
    // wrong latch would hide a panel that is actually open. While the window is
    // armed, the toggle path owns the class.
    if (guidingTimer) return;
    const guide = document.querySelector("#guide");
    if (!guide) return;
    const w = guide.offsetWidth; // 72 collapsed, 240 expanded
    // Anything in between is a width the drawer is only PASSING THROUGH, so leave
    // the class alone rather than latch a state that is about to stop being true.
    // This matters because a sync can be triggered by a route change or a settings
    // write that lands while YTM is animating the drawer on its own — neither of
    // which goes anywhere near our interaction window.
    if (w > 100 && w < 200) return;
    document.documentElement.classList.toggle("ym-sm-guide-collapsed", w < 120);
  }

  let guidingTimer = 0;
  // The CSS transition is 0.3s. Hold the class a little longer so it is still
  // on when the transition ends, then drop it.
  const GUIDE_ANIM_MS = 380;
  const REDUCED_MOTION =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Arm the cosmetic guide transitions for ONE interaction, then remove them.
  // The class now only drives the panel slide/fade and the browse-content offset
  // — #player-page is deliberately NOT transitioned (see the CSS comment), so
  // nothing that gets MEASURED is moving while this is armed.
  //
  // "opening" is the DIRECTION, and it travels as its own class rather than being
  // read back off ym-sm-guide-collapsed. onPointerDown flips that class in the
  // same frame, so by the time any CSS matches it the direction is already gone —
  // and the two directions genuinely need opposite rules (#guide fades IN on open
  // and OUT on close; the mini rail does the exact reverse). So the direction has
  // to be carried for the length of the window.
  function armGuideWindow(opening) {
    if (REDUCED_MOTION) return; // never arm; the guide simply snaps
    const root = document.documentElement;
    root.classList.add("ym-sm-guiding");
    root.classList.toggle("ym-sm-guide-opening", !!opening);
    if (guidingTimer) clearTimeout(guidingTimer);
    guidingTimer = window.setTimeout(() => {
      guidingTimer = 0;
      root.classList.remove("ym-sm-guiding", "ym-sm-guide-opening");
      // The end of the window is the natural place to re-derive the class from
      // ground truth: by now the drawer has stopped, so its width is authoritative
      // again. This is what repairs a latch that came from anywhere OTHER than a
      // real pointer interaction — a keyboard-activated hamburger fires click with
      // no pointerdown at all.
      syncGuideState();
    }, GUIDE_ANIM_MS);
  }

  /* ---- video re-fit glide (FLIP) -------------------------------------------
     Why the video is animated HERE instead of by a CSS transition on its
     container — and why the container transition had to go.

     #player-page is position:fixed and YTM owns its left/width. YTM also owns the
     <video>'s inline width/height/left/top, and it re-fits that size in response
     to a resize event. It does NOT re-fit from a ResizeObserver on the player,
     which is why a size computed mid-flight stays wrong until something else
     forces another pass — AJ's "it all resets when the next song plays".

     So: let the geometry SNAP, let YTM re-fit against the settled box, then FLIP
     the video from its old box to its new one. A FLIP is a transform on an
     element nothing measures, so no measurement can land inside it — the failure
     mode the container transition had is structurally impossible here.

     The observer watches the VIDEO, not the container. YTM re-fits for several
     reasons (guide toggle, devtools open, window resize, fullscreen enter/exit)
     and every one of them shows up as the same event, so there is no per-trigger
     code to get out of sync with the reason. */
  const FLIP_MS = 300;
  const FLIP_EASE = "cubic-bezier(.22,.61,.36,1)";
  let flipEl = null;
  let flipPrev = null; // last LAYOUT box; null until the first report
  let flipTimer = 0;
  let flipObserver = null;

  // Transform-BLIND box of el, in viewport coordinates. Deliberately NOT
  // getBoundingClientRect(): that one includes the transform our own FLIP has in
  // flight, so reading it while animating returns the ANIMATED position and
  // poisons the next step's "before" endpoint. The offset* reads ignore transforms.
  function layoutBox(el) {
    const parent = el.offsetParent;
    const base = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
    return {
      left: base.left + (parent ? parent.clientLeft : 0) + el.offsetLeft,
      top: base.top + (parent ? parent.clientTop : 0) + el.offsetTop,
      width: el.offsetWidth,
      height: el.offsetHeight,
    };
  }

  function videoEl() {
    const page = document.querySelector("#player-page");
    return page ? page.querySelector("video.video-stream") : null;
  }

  function applyFlip(el, prev, next) {
    if (REDUCED_MOTION) return;
    if (!prev || !next || !prev.width || !next.width || !next.height) return;
    // The video keeps its aspect ratio, so both axes change by the same factor —
    // one uniform scale is enough, and it is what stops the frame distorting
    // mid-flight. A translate carries the centre across.
    const scale = prev.width / next.width;
    const dx = prev.left + prev.width / 2 - (next.left + next.width / 2);
    const dy = prev.top + prev.height / 2 - (next.top + next.height / 2);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.005) return;
    // Clear any flip still running first: it has left an inline transform behind,
    // and starting a second one on top of it would compound the two offsets.
    if (flipTimer) { clearTimeout(flipTimer); flipTimer = 0; }
    el.style.transition = "none";
    el.style.transformOrigin = "center center";
    el.style.transform =
      "translate(" + dx + "px, " + dy + "px) scale(" + scale.toFixed(5) + ")";
    void el.offsetWidth; // flush, so the transition below starts from the inverted state
    el.style.transition = "transform " + FLIP_MS + "ms " + FLIP_EASE;
    el.style.transform = "";
    flipTimer = window.setTimeout(() => {
      flipTimer = 0;
      el.style.transition = "";
      el.style.transform = "";
      el.style.transformOrigin = "";
    }, FLIP_MS + 60);
  }

  function observeVideo() {
    const el = videoEl();
    if (!el) return;
    if (flipObserver && flipEl === el) return; // already watching this element
    if (flipObserver) flipObserver.disconnect();
    flipEl = el;
    flipPrev = layoutBox(el); // baseline — the first report has nothing to glide from
    flipObserver = new ResizeObserver(() => {
      if (!flipEl) return;
      const next = layoutBox(flipEl);
      const prev = flipPrev;
      flipPrev = next;
      if (prev) applyFlip(flipEl, prev, next);
    });
    flipObserver.observe(el);
    dbg("video glide observing", el.tagName);
  }

  /* ---- video re-fit --------------------------------------------------------
     YTM re-fits the video in response to a resize event, but it measures
     #player-page AT THAT INSTANT — and its own geometry write lands a frame or
     two AFTER our capture-phase handler runs. So asking once on the next frame
     asks too early, and the video ends up fitted to a box that no longer exists.
     Measured live: 957x479 after a reload versus 850x425 after a guide toggle —
     identical 2:1 aspect, a uniformly stale scale. That is exactly the reported
     "the video still cuts off when you collapse the panel ... when you click the
     panel again it does the fix, but then cuts the video again".

     So: watch #player-page and ask for the re-fit the moment its box STOPS
     moving, with a deadline as the fallback for a toggle that moves nothing at
     all. The re-fit is idempotent, so a redundant ask costs a measurement and
     never a visible frame — and the video observer turns the real size change
     into the glide.

     The rect below is transform-INCLUSIVE on purpose: it is only a change
     detector, and YTM may well move the page with a transform. It is never fed
     to the FLIP, so the transform-poisoning that layoutBox() exists to avoid
     cannot reach it. */
  function refitVideo() {
    if (REDUCED_MOTION) return; // the guide snaps, so YTM's own re-fit is already right
    const ask = () => window.dispatchEvent(new Event("resize"));
    const page = document.querySelector("#player-page");
    if (!page) { requestAnimationFrame(ask); return; }
    const key = () => {
      const r = page.getBoundingClientRect();
      return r.left.toFixed(1) + ":" + r.width.toFixed(1);
    };
    const deadline = performance.now() + GUIDE_ANIM_MS + 400;
    let last = key();
    let still = 0;
    const step = () => {
      const now = key();
      if (now !== last) { last = now; still = 0; } else { still += 1; }
      // Two consecutive still frames means the box has landed, so the ask below
      // measures the geometry the video will actually live in. "still" keeps
      // counting past 2, so one settle produces exactly one ask however long the
      // animation runs.
      if (still === 2) ask();
      if (performance.now() < deadline) requestAnimationFrame(step);
      else if (still < 2) ask(); // never settled inside the window — last resort
    };
    requestAnimationFrame(step);
  }

  function beginGuideMotion(opening) {
    armGuideWindow(opening);
    observeVideo();
    refitVideo();
  }

  let lastGuideToggle = 0;

  // One place that flips the tracked state, so the pointer and keyboard paths
  // cannot drift apart. "collapsed" is read off the ELEMENT rather than off our
  // own class: syncGuideState derives it the same way, and if a sync was ever
  // missed the direction — and with it every fade — would come out inverted.
  function toggleGuideMotion() {
    const root = document.documentElement;
    const guide = document.querySelector("#guide");
    const collapsed = guide
      ? guide.offsetWidth < 120
      : root.classList.contains("ym-sm-guide-collapsed");
    beginGuideMotion(!collapsed);
    root.classList.toggle("ym-sm-guide-collapsed", !collapsed);
    lastGuideToggle = performance.now();
  }

  function onPointerDown(event) {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    // Guide toggle (capture phase, so it lands before YTM starts the slide).
    if (guideOn() && target.closest("#guide-button")) toggleGuideMotion();
  }

  // The hamburger is a real button, so Tab + Enter activates it with a click and
  // NO pointerdown. Without this path nothing would flip the class — and because
  // the collapsed class also drives opacity, a keyboard toggle would leave the
  // drawer present in the DOM but invisible on screen. A pointer interaction has
  // already been handled by the time its click arrives, so the timestamp keeps
  // this to one toggle per interaction (a genuine fast double-click still fires
  // two pointerdowns, and those are not gated).
  function onGuideClick(event) {
    if (!guideOn()) return;
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    if (!target.closest("#guide-button")) return;
    if (performance.now() - lastGuideToggle < 400) return;
    toggleGuideMotion();
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

  // Animate the YTM action-menu popup (ytmusic-menu-popup-renderer) on OPEN
  // and CLOSE. YTM ships it with transition: all at 0s, so it pops in and out
  // instantly. Two problems to solve:
  //   OPEN: YTM paints the popup at full opacity for a frame BEFORE our async
  //     poll adds the animation class, so it reads as a flash of the final
  //     state (AJ: "looks like it's lagging"). Fix: pre-hide it for one frame
  //     (.ym-sm-menu-popup-pre -> opacity 0) synchronously in the capture
  //     click, then once visible swap to the fade+rise (.ym-sm-menu-popup-open).
  //   CLOSE: YTM removes the menu's content and collapses the popup to 0x0 in
  //     the same frame, so afterwards there is nothing left to fade. A clone
  //     cannot help either — cloneNode does NOT copy shadow DOM, and YTM's menu
  //     items are custom elements, so a cloned menu renders as an EMPTY box
  //     (AJ saw exactly that: a bare sliver, then nothing at all). Fix: swallow
  //     the close click, fade the REAL popup's opacity to 0 with its content
  //     still on screen, then re-dispatch the same (trusted) event so YTM does
  //     its normal close. A safety net force-closes if YTM ignores the
  //     re-dispatch, so the menu can never be left stuck open.
  const MENU_POPUP_OPEN_CLASS = "ym-sm-menu-popup-open";
  const MENU_POPUP_PRE_CLASS = "ym-sm-menu-popup-pre";
  let menuAnimPollRAF = 0;

  function menuPopupVisible(popup) {
    return !!popup && popup.offsetWidth > 0 && getComputedStyle(popup).display !== "none";
  }

  // Clear our transient state so a reopen starts clean.
  function resetMenuPopup(popup) {
    if (!popup) return;
    popup.classList.remove(MENU_POPUP_OPEN_CLASS, MENU_POPUP_PRE_CLASS);
    popup.__ymOpenArmed = false;
  }

  // ---- CLOSE: fade the REAL popup -----------------------------------------
  // YTM strips the menu's content on the close click, so the only way to fade
  // something real is to hold YTM off for the fade window. We swallow the click
  // in the capture phase, let CSS transition the popup's opacity to 0 (content
  // intact), then re-dispatch the SAME event object — it is still trusted, so
  // YTM's handler accepts it — and YTM closes exactly as it normally would.
  const MENU_POPUP_CLOSING_CLASS = "ym-sm-menu-popup-closing";
  const MENU_CLOSE_MS = 150;
  let menuReclosing = false; // true only while we re-dispatch our own event

  function beginMenuCloseFade(popup, event) {
    if (menuReclosing || popup.__ymClosing) return false;
    // The fade is a CSS rule gated on html.ym-sm-on. With the module off there
    // is nothing to animate, so swallowing the click would just stall it for
    // 150ms — bail and let YTM close instantly.
    if (!document.documentElement.classList.contains("ym-sm-on")) return false;
    popup.__ymClosing = true;
    // Capture phase: stopping here means YTM's own listener never runs this
    // time, so the content stays on screen for the whole fade.
    event.stopImmediatePropagation();
    popup.classList.remove(MENU_POPUP_OPEN_CLASS, MENU_POPUP_PRE_CLASS);
    popup.classList.add(MENU_POPUP_CLOSING_CLASS);
    setTimeout(() => {
      popup.classList.remove(MENU_POPUP_CLOSING_CLASS);
      popup.__ymClosing = false;
      menuReclosing = true;
      try {
        // Same event object: isTrusted stays true. Dispatch on the original
        // target so it propagates exactly the way it would have.
        (event.target || popup).dispatchEvent(event);
      } catch (e) {
        /* target detached — the safety net below still runs */
      }
      menuReclosing = false;
      // Safety net: if YTM ignored the re-dispatch the menu would sit there
      // open forever, which is far worse than no fade. Give it a beat, then
      // close it the way YTM closes any popup: an Escape keydown.
      setTimeout(() => {
        if (!menuPopupVisible(popup)) return;
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            which: 27,
            bubbles: true,
          })
        );
      }, 120);
    }, MENU_CLOSE_MS);
    return true;
  }

  // Run the OPEN animation exactly once per open. Pre-hide (MENU_POPUP_PRE_CLASS)
  // is applied immediately so the popup's first painted frame is invisible, then
  // on the next rAF we swap to the fade+rise. Doing the swap inside rAF (after
  // the pre-hide has painted) means the user sees the keyframe's from-state,
  // never a flash of the final state. Works whether the popup is the persistent
  // node (pre-hidden by the capture click) or a fresh node YTM created later.
  function armMenuPopupOpen(popup) {
    if (popup.__ymOpenArmed) return;
    popup.__ymOpenArmed = true;
    popup.classList.add(MENU_POPUP_PRE_CLASS);
    requestAnimationFrame(() => {
      popup.classList.remove(MENU_POPUP_PRE_CLASS);
      popup.classList.add(MENU_POPUP_OPEN_CLASS);
      const cleanup = (e) => {
        if (e && e.animationName && e.animationName !== "ym-sm-menu-in") return;
        popup.classList.remove(MENU_POPUP_OPEN_CLASS);
        popup.__ymOpenArmed = false;
        popup.removeEventListener("animationend", cleanup);
      };
      popup.addEventListener("animationend", cleanup);
    });
  }

  // Closing by clicking OUTSIDE the popup (empty space, another control). YTM
  // collapses it for any outside click, so fade those too. Clicks INSIDE the
  // popup are a menu item being chosen — never intercept those, because the
  // re-dispatch is what would perform the action and we must not risk eating
  // it. Everything else is safe: we swallow only the JS listeners, and no
  // preventDefault means the browser's own default action is untouched.
  function onMenuOutsideClickCapture(event) {
    if (menuReclosing || REDUCED_MOTION) return;
    const popup = document.querySelector("ytmusic-menu-popup-renderer");
    if (!menuPopupVisible(popup)) return;
    const t = event.target;
    if (!t || !t.closest) return;
    if (t.closest("ytmusic-menu-popup-renderer")) return; // menu item: let it be
    beginMenuCloseFade(popup, event);
  }

  function tryAnimateMenuPopup() {
    const popup = document.querySelector("ytmusic-menu-popup-renderer");
    if (!menuPopupVisible(popup)) return false;
    armMenuPopupOpen(popup);
    return true;
  }

  // Poll for visibility for up to ~600ms after the open click (YTM shows the
  // popup asynchronously, often several frames after the click).
  function pollMenuPopupOpen(deadline) {
    if (tryAnimateMenuPopup()) { menuAnimPollRAF = 0; return; }
    if (performance.now() < deadline) {
      menuAnimPollRAF = requestAnimationFrame(() => pollMenuPopupOpen(deadline));
    } else {
      menuAnimPollRAF = 0;
    }
  }

  function onActionMenuClickCapture(event) {
    if (menuReclosing) return; // our own re-dispatch — let YTM handle it
    const host = event.target && event.target.closest
      ? event.target.closest('ytmusic-player-bar [aria-label="Action menu"]')
      : null;
    if (!host) return;
    const existing = document.querySelector("ytmusic-menu-popup-renderer");
    // Capture phase fires BEFORE YTM's toggle, so a visible popup means this
    // click is a CLOSE. Fade the real popup first, then let YTM close it.
    if (menuPopupVisible(existing)) {
      if (REDUCED_MOTION) return; // no fade — let YTM close instantly
      beginMenuCloseFade(existing, event);
      return;
    }
    resetMenuPopup(existing);
    // OPEN: pre-hide synchronously so YTM's first paint is invisible, then poll
    // until the popup is actually visible and run the fade+rise.
    existing && existing.classList.remove(MENU_POPUP_OPEN_CLASS);
    const fresh = document.querySelector("ytmusic-menu-popup-renderer");
    fresh && fresh.classList.add(MENU_POPUP_PRE_CLASS);
    if (menuAnimPollRAF) cancelAnimationFrame(menuAnimPollRAF);
    menuAnimPollRAF = requestAnimationFrame(() => pollMenuPopupOpen(performance.now() + 600));
  }

  // ---- lifecycle -----------------------------------------------------------
  function start() {
    ensureStyle();
    applySettings(settings);
    dbg("start", JSON.stringify(settings));
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onGuideClick, true);
    startPageWatch();
    syncGuideState();
    document.addEventListener("click", onActionMenuClickCapture, true);
    // Registered AFTER the action-menu handler: when the close click lands on
    // the button, that handler calls stopImmediatePropagation, which stops this
    // one from also firing for the same event.
    document.addEventListener("click", onMenuOutsideClickCapture, true);
    shownEl = pageEl(); // baseline for "a different container became visible"
  }

  function teardown() {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("click", onGuideClick, true);
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
    if (guidingTimer) { clearTimeout(guidingTimer); guidingTimer = 0; }
    // Never leave a half-finished glide on the video: the inline transform is
    // ours, and leaving it behind would offset the player permanently.
    if (flipTimer) { clearTimeout(flipTimer); flipTimer = 0; }
    if (flipObserver) { flipObserver.disconnect(); flipObserver = null; }
    if (flipEl) {
      flipEl.style.transition = "";
      flipEl.style.transform = "";
      flipEl.style.transformOrigin = "";
    }
    flipEl = null;
    flipPrev = null;
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
    document.removeEventListener("click", onActionMenuClickCapture, true);
    document.removeEventListener("click", onMenuOutsideClickCapture, true);
    if (menuAnimPollRAF) { cancelAnimationFrame(menuAnimPollRAF); menuAnimPollRAF = 0; }
    document.querySelectorAll("ytmusic-menu-popup-renderer")
      .forEach((el) => {
        try {
          el.classList.remove(
            MENU_POPUP_OPEN_CLASS,
            MENU_POPUP_PRE_CLASS,
            MENU_POPUP_CLOSING_CLASS
          );
          delete el.__ymClosing;
          delete el.__ymOpenArmed;
        } catch {}
      });
    menuReclosing = false;
    navUntil = 0;
    navStartUrl = "";
    pageHidden = false;
    shownEl = null;
    const root = document.documentElement;
    root.classList.remove(
      "ym-sm-on", "ym-sm-guide", "ym-sm-search", "ym-sm-pages", "ym-sm-micro",
      "ym-sm-guide-collapsed", "ym-sm-guiding", "ym-sm-guide-opening"
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
