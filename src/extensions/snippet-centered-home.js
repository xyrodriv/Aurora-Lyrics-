/*
 * Snippet — "Centered home" (v0.1.1).
 *
 * AJ, 2026-10-19. Two home-page layout tweaks, CSS-only:
 *
 *   1. SHELF HEADERS — the artist avatar now sits INLINE with the strapline
 *      ("ALPHAMP5"), and that pair is centered above the title. Before this the
 *      avatar was a 56px block parked at the far-left gutter while the text was
 *      centered, which read as two unrelated columns. The More / arrow buttons
 *      stay pinned to the right edge.
 *   2. FILTER CHIPS — the Podcasts / Energize / Relax row is centered.
 *
 * The soft blur seam at the left guide edge used to live here; it moved into
 * the NPV snippet because the hard cut is caused by the rail's layout.
 *
 * DOM notes (verified live on music.youtube.com, 2026-10-19):
 *   ytmusic-carousel-shelf-basic-header-renderer
 *     > .image                      (56px artist avatar, optional)
 *     > #content-group
 *         > yt-formatted-string.strapline
 *         > #details                (flex: title + #button-group)
 *             > yt-formatted-string.title[role=heading]
 *             > #button-group       (More + prev/next)
 *   ytmusic-chip-cloud-renderer > #chips (flex scroller)
 *
 * No polling: the selectors survive YTM's SPA re-renders, so the stylesheet is
 * injected once and removed on disable.
 */
(function () {
  "use strict";

  const EXT_ID = "snippet-centered-home";
  const TAG = "[snippet:centered-home]";
  const STYLE_ID = "ym-ch-style";

  let armed = false;
  let logoPoll = 0;
  let logoEl = null;       // the moved <ytmusic-logo>
  let logoHome = null;     // where it came from (#left-content)
  let logoNext = null;     // its original next sibling, for an exact restore

  const CSS = `
/* ---- 0. gutter off the left guide ------------------------------------ */
/* YTM butts the first card straight against the Home / Explore rail. A small
   gutter makes the layout read as intentional and gives the NPV's blur seam
   somewhere to fade into (AJ, 2026-10-19). */
ytmusic-section-list-renderer {
  padding-left: 24px !important;
}

/* #header-group lays the header out beside the carousel's prev/next group with
   a 24px column-gap, so even a full-width header stops short of the arrows.
   Drop the gap; the arrow buttons carry their own inner padding, which keeps a
   few pixels of visual breathing room. */
ytmusic-carousel-shelf-renderer #header-group {
  position: relative;
  column-gap: 0 !important;
}
/* Span the FULL shelf width so the title centers on the shelf, not on the
   narrower column left of the arrows. */
ytmusic-carousel-shelf-renderer #header-group > ytmusic-carousel-shelf-basic-header-renderer {
  flex: 0 0 100% !important;
  width: 100% !important;
  min-width: 0 !important;
}
/* Lift the carousel arrows out of the flow so the header can run underneath
   them. #header-group is 32px taller than the header (top padding), so a plain
   50% would centre the arrows 16px above More — offset by half that. */
ytmusic-carousel-shelf-renderer #header-group > .button-group {
  position: absolute !important;
  right: 16px;
  top: calc(50% + 16px);
  transform: translateY(-50%);
  z-index: 2;
}

/* ---- 1. shelf headers ------------------------------------------------ */
/* Wrap the header so the avatar + strapline share the first line and the
   title gets the second. #content-group becomes display:contents so its two
   children can join the header's flex flow directly. */
ytmusic-carousel-shelf-basic-header-renderer {
  flex-wrap: wrap !important;
  justify-content: center !important;
  align-items: center !important;
  row-gap: 2px;
  position: relative;
}
ytmusic-carousel-shelf-basic-header-renderer > .image {
  order: 0;
  width: 28px !important;
  height: 28px !important;
  min-width: 28px !important;
  max-width: 28px !important;
  min-height: 28px !important;
  max-height: 28px !important;
  flex: 0 0 28px !important;
  margin: 0 9px 0 0 !important;
  border-radius: 50%;
  overflow: hidden;
  background-size: cover;
  background-position: center;
}
/* YTM's thumbnail renderer defaults to object-fit:fill, which is what turned
   the avatar into an oval once the box stopped being square. */
ytmusic-carousel-shelf-basic-header-renderer > .image #image,
ytmusic-carousel-shelf-basic-header-renderer > .image img {
  width: 100% !important;
  height: 100% !important;
  object-fit: cover !important;
  object-position: center !important;
  border-radius: 50% !important;
}
ytmusic-carousel-shelf-basic-header-renderer > #content-group {
  display: contents;
}
ytmusic-carousel-shelf-basic-header-renderer > #content-group > .strapline {
  order: 1;
  width: auto !important;
  margin: 0 !important;
  text-align: center !important;
}
/* Center the title as a flex item, then lift the buttons out of the flow so
   they keep hugging the right edge instead of riding along with the title. */
ytmusic-carousel-shelf-basic-header-renderer > #content-group > #details {
  order: 2;
  flex: 0 0 100%;
  width: 100% !important;
  /* static so the absolutely-positioned More button anchors to the HEADER, not
     to this row — that keeps it vertically centred with the carousel arrows
     instead of sitting half a strapline lower. */
  position: static;
  justify-content: center !important;
}
ytmusic-carousel-shelf-basic-header-renderer #details > yt-formatted-string.title {
  text-align: center !important;
}
/* More sits just left of the arrow column (88px wide + 16px edge inset + 8px
   breathing room). #details is static, so this anchors to the header. */
ytmusic-carousel-shelf-basic-header-renderer #details > #button-group {
  position: absolute;
  right: 112px;
  top: 50%;
  transform: translateY(-50%);
}

/* ---- 2. filter chips -------------------------------------------------- */
/* #chips is a flex item narrower than the cloud (room for the arrows), so auto
   margins center it; justify-content covers the case where it fills the row. */
ytmusic-chip-cloud-renderer {
  justify-content: center !important;
}
ytmusic-chip-cloud-renderer > #chips {
  margin-left: auto !important;
  margin-right: auto !important;
}

/* ---- 3. nav: logo beside the search, both centred --------------------- */
/* YTM pins the logo to the far-left guide column and left-aligns the search
   inside .center-content, so with the rail open the search reads off-centre.
   Centering the row puts the logo + search pair on the content's centre. */
ytmusic-nav-bar .center-content {
  justify-content: center !important;
  gap: 12px;
}
ytmusic-nav-bar .center-content ytmusic-logo {
  margin: 0 !important;
  flex: 0 0 auto;
}

/* ---- 4. player-page tabs --------------------------------------------- */
/* Moved to Aurora Flow (smooth-motion.js, module 6). It arms the class from the
   CLICK in the capture phase, so the entrance starts the moment the tab flips
   instead of waiting for the new child to be rendered — that late start is why
   this rule felt delayed. Keeping both would double-play: the cascade picks the
   more specific selector, then the other one re-fires when the class is removed. */
`;

  // YTM renders the logo into #left-content on every nav re-render, so this is
  // re-asserted on a slow poll rather than moved once.
  function placeLogo() {
    const nav = document.querySelector("ytmusic-nav-bar");
    if (!nav) return;
    const center = nav.querySelector(".center-content");
    const logo = nav.querySelector("ytmusic-logo");
    if (!center || !logo) return;
    if (!logoHome) {
      logoHome = logo.parentElement;
      logoNext = logo.nextElementSibling;
    }
    if (center.contains(logo)) return;
    center.insertBefore(logo, center.firstElementChild);
    logoEl = logo;
  }

  function restoreLogo() {
    if (!logoEl || !logoHome || !logoHome.isConnected) return;
    try {
      const ref = logoNext && logoNext.parentElement === logoHome ? logoNext : null;
      logoHome.insertBefore(logoEl, ref);
    } catch (e) {}
    logoEl = null;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function arm() {
    if (armed) return;
    armed = true;
    injectStyle();
    placeLogo();
    logoPoll = window.setInterval(placeLogo, 1000);
    console.log(TAG, "armed");
  }

  function teardown() {
    if (!armed) return;
    armed = false;
    if (logoPoll) { window.clearInterval(logoPoll); logoPoll = 0; }
    restoreLogo();
    const s = document.getElementById(STYLE_ID);
    if (s) s.remove();
    console.log(TAG, "torn down");
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "ytmod-ext" || data.id !== EXT_ID) return;
    if (data.action === "disable") teardown();
  });

  arm();
})();
