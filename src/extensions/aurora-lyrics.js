/*
 * Aurora Lyrics — YTMod extension (unofficial).
 *
 * Renders lyrics using the Spicy Lyrics Syllable RENDERER, adapted from the
 * original Spicy Lyrics project by Spikerko (AGPL-3.0). Aurora Lyrics is an
 * UNOFFICIAL project: it is not made, endorsed, or supported by Spicy Lyrics
 * or by Spikerko, and is not affiliated with either. Preserve the upstream
 * license and attribution when distributing adapted builds.
 *
 * Community syncs come from the Spicy Lyrics API and are credited ON SCREEN
 * wherever lyrics appear (see buildCreditsFooter / buildProviderRow), as the
 * API terms require; API responses are cached for at most 30 days.
 *
 * YTMod-specific boundaries:
 *   - playback position and seeking come from window.YTMod.player,
 *   - lyrics are initially loaded from TTML imports,
 *   - the renderer lives inside YT Music's native side panel.
 */
(function () {
  "use strict";

  // LOAD MARKER — confirms the updated Spicy Lyrics script actually executed in
  // the page. If this line does NOT appear in the DevTools console after a full
  // extension + tab reload, the new code is not being loaded (stale cache /
  // wrong reload procedure), and any lyric-rendering change will have no effect.
  console.log("[Aurora Lyrics] Synced Lyrics loaded — Written By footer · build 2026-09-04a");

  // Keep the original internal ID so existing installs and saved lyrics remain active.
  const EXT_ID = "ytmod-spicy-lyrics";
  const UNISON_API = "https://unison.boidu.dev/lyrics";
  const LRCLIB_API = "https://lrclib.net/api/get";
  const LRCLIB_SEARCH_API = "https://lrclib.net/api/search";
  const SPICY_LYRICS_API = "https://api.spicylyrics.org/v1/lyrics";
  // PUBLISHABLE key only (sl_pk_…). Never embed the secret sl_sk_ here — it is
  // server-side only and would be exposed in this client-side extension.
  const SPICY_LYRICS_PUBLISHABLE_KEY = "sl_pk_R2hLeH1gpObvT6Dugj8pf54sVFMWdtH1vu2w8rWHcMA";
  // YTM -> Spotify id resolver. Song.link/Odesli was shut down
  // (PUBLIC_API_ACCESS_DEPRECATED, HTTP 401). The free resolver is layered:
  // resolver cache -> ListenBrainz direct mapping -> MusicBrainz recording
  // search + Spotify URL relations. MusicBrainz is deliberately last in the ID
  // layer because it is slower/rate-limited, but it covers mappings LB misses.
  //
  // ListenBrainz runs `labs.api.listenbrainz.org`, MetaBrainz's free dataset
  // hoster. It publishes the recording->Spotify mapping directly — no key, no
  // account, no backend, and CORS `*` so we can call it from here.
  const LISTENBRAINZ_LABS_API = "https://labs.api.listenbrainz.org";
  // Per-request cap. This sits on the critical path of a track change, so it
  // must never be the reason a song hangs.
  const LB_TIMEOUT_MS = 5000;
  // Bounds the total work across the whole variant ladder. Without this, a
  // pathological title (lots of parens variants) could issue dozens of calls
  // and stall the panel while the user is already on the next song.
  const LB_MAX_ATTEMPTS = 12;
  // Set when ListenBrainz returns 429/5xx. While it is in the future we stop
  // trying and report the failure as transient, instead of burning the rest of
  // the song's budget on calls that cannot succeed.
  let lbThrottledUntil = 0;
  // The extension script is injected into the page world, where chrome.runtime
  // is unavailable. Resolve the local font CSS from this script's own extension
  // URL instead of resolving it against music.youtube.com.
  const SCRIPT_URL = document.currentScript && document.currentScript.src || "";
  const SPICY_LYRICS_FONT_CSS = SCRIPT_URL
    ? new URL("fonts/spicy-lyrics.css", SCRIPT_URL).href
    : "https://fonts.spikerko.org/spicy-lyrics/source.css";
  // Bundled Kawarp WebGL module (the same one the Dynamic add-on uses). Resolved
  // from this script's own extension URL because the page world cannot fetch
  // chrome-extension:// resources by bare name.
  const KAWARP_CORE_URL = SCRIPT_URL ? new URL("kawarp-core.js", SCRIPT_URL).href : "";
  // Bundled AMLL engine (the real @applemusic-like-lyrics DomLyricPlayer). Same
  // resolution rule as Kawarp: this script runs in the PAGE world, where
  // chrome.runtime does not exist, so chrome.runtime.getURL() throws and the
  // engine silently falls back. document.currentScript.src already points at
  // chrome-extension://<id>/src/extensions/aurora-lyrics.js, so a sibling
  // relative URL is all we need.
  const AMLL_CORE_URL = SCRIPT_URL ? new URL("amll-core.js", SCRIPT_URL).href : "";
  // Match the Dynamic add-on's defaults so the fullscreen backdrop looks like
  // the page-wide one. animationSpeed is overridden per playback state.
  const FS_KAWARP_OPTIONS = {
    warpIntensity: 1,
    blurPasses: 6,
    animationSpeed: 0.1,
    saturation: 1.5,
    dithering: 0.008,
    transitionDuration: 1000,
    tintIntensity: 0,
    scale: 1,
  };
  const GAP_DOTS_AFTER_SECONDS = 3;
  const PRE_HIDDEN_DOT_LINE_MS = 500;
  const LRCLIB_CACHE_LIMIT = 12;

  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null) continue;
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k.startsWith("on") && typeof v === "function") {
          e.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
          e.setAttribute(k, v);
        }
      }
    }
    for (const kid of kids) {
      if (kid == null) continue;
      e.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return e;
  };

  function whenYTMod(cb) {
    if (window.YTMod && window.YTMod.player) return cb();
    setTimeout(() => whenYTMod(cb), 200);
  }

  /* ===================== TTML adapter ===================== */

  function tsToSec(value) {
    if (value == null) return 0;
    const s = String(value).trim();
    let m = /^([\d.]+)ms$/i.exec(s);
    if (m) return parseFloat(m[1]) / 1000;
    m = /^([\d.]+)s$/i.exec(s);
    if (m) return parseFloat(m[1]);
    m = /^([\d.]+)m$/i.exec(s);
    if (m) return parseFloat(m[1]) * 60;
    m = /^([\d.]+)h$/i.exec(s);
    if (m) return parseFloat(m[1]) * 3600;
    m = /^(\d+)f(?:@(\d+))?$/i.exec(s);
    if (m) return parseInt(m[1], 10) / (m[2] ? parseInt(m[2], 10) : 30);

    // Clock time: seconds, minutes:seconds, or hours:minutes:seconds.
    // Splitting the fields avoids treating `01:02.345` as one hour.
    if (!/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(s)) return 0;
    const fields = s.split(":");
    const seconds = parseFloat(fields.pop());
    if (fields.length === 0) return seconds;
    if (fields.length === 1) return parseInt(fields[0], 10) * 60 + seconds;
    return parseInt(fields[0], 10) * 3600 +
      parseInt(fields[1], 10) * 60 +
      seconds;
  }

  function attrsOf(source) {
    const out = {};
    const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
    let match;
    while ((match = re.exec(source))) out[match[1].toLowerCase()] = match[2];
    return out;
  }

  function decodeEntities(text) {
    return String(text)
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'");
  }

  function textOf(markup) {
    return decodeEntities(String(markup).replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseSpanTree(markup) {
    const root = { children: [] };
    const stack = [root];
    const tokenRe = /<\/?span\b[^>]*>/gi;
    let token;

    while ((token = tokenRe.exec(markup))) {
      const source = token[0];
      if (source[1] === "/") {
        if (stack.length === 1) continue;
        const node = stack.pop();
        node.closeStart = token.index;
        node.closeEnd = tokenRe.lastIndex;
        node.inner = markup.slice(node.openEnd, node.closeStart);
        node.text = textOf(node.inner);
      } else {
        const node = {
          attrs: attrsOf(source),
          openStart: token.index,
          openEnd: tokenRe.lastIndex,
          children: [],
        };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      }
    }

    return root.children.filter((node) => node.closeEnd != null);
  }

  function parseTimedSpanNodes(nodes, markup, fallbackStart, fallbackEnd) {
    const words = nodes
      .map((node) => {
        const start = tsToSec(node.attrs.begin || node.attrs["ttm:begin"]) || fallbackStart;
        const duration = tsToSec(node.attrs.dur || node.attrs["ttm:dur"]);
        const end =
          tsToSec(node.attrs.end || node.attrs["ttm:end"]) ||
          (duration ? start + duration : fallbackEnd);
        return {
          text: node.text || textOf(node.inner),
          start,
          end,
          // True only when this span carried real timing. Drives the
          // no-karaoke decision so partially-synced TTML lines that lack
          // genuine timing are rendered as a static block (AJ, 2026-09-17).
          timed: !!(
            node.attrs.begin ||
            node.attrs["ttm:begin"] ||
            node.attrs.end ||
            node.attrs["ttm:end"] ||
            node.attrs.dur ||
            node.attrs["ttm:dur"]
          ),
          node,
          hasSpaceBefore: false,
          explicitPartOfWord:
            node.attrs["part-of-word"] ||
            node.attrs["itunes:part-of-word"] ||
            node.attrs["ttm:part-of-word"],
        };
      })
      .filter((word) => word.text);

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const next = words[i + 1];
      const previous = words[i - 1];
      if (previous) {
        const between = markup.slice(previous.node.closeEnd, word.node.openStart);
        word.hasSpaceBefore = /\s/.test(between);
      }
      if (word.explicitPartOfWord != null) {
        word.isPartOfWord = /^(1|true|yes)$/i.test(word.explicitPartOfWord);
        word.partOfWordExplicit = true;
      } else if (next) {
        const between = markup.slice(word.node.closeEnd, next.node.openStart);
        word.isPartOfWord = !/\s/.test(between);
        // INFERRED, not declared. The join only trusts explicit markers: the
        // inference says "no whitespace between the tags", which is also true
        // for adjacent whole words and was merging entire lines (AJ, 2026-10-20).
        word.partOfWordExplicit = false;
      } else {
        word.isPartOfWord = false;
        word.partOfWordExplicit = false;
      }
    }
    for (const word of words) {
      delete word.node;
      delete word.explicitPartOfWord;
    }

    return words;
  }

  // lrc.red TTML often splits one word into syllable spans ("shi" + "ning").
  // Merge each part-of-word run back into its head word so the renderer fills
  // and glows the WHOLE word instead of per syllable. The settings toggle can
  // turn this off (AJ, 2026-10-20).
  function joinPartOfWordRuns(words) {
    const merged = [];
    for (const word of words || []) {
      const prev = merged[merged.length - 1];
      // Only EXPLICIT part-of-word markers merge. The whitespace-inferred flag
      // is true for any two adjacent spans, including separate words, and was
      // producing "don'twan na talkto" (AJ, 2026-10-20). A real space at either
      // edge always wins.
      const canJoin =
        !!prev &&
        word.isPartOfWord &&
        word.partOfWordExplicit &&
        !/\s$/.test(prev.text) &&
        !/^\s/.test(word.text);
      if (canJoin) {
        prev.text += word.text;
        prev.end = word.end;
        prev.timed = !!(prev.timed || word.timed);
      } else {
        merged.push(Object.assign({}, word, { isPartOfWord: false }));
      }
    }
    return merged;
  }

  // Group spans by the line's OWN whitespace: a run of non-space characters is
  // one word, so "Un"+"der" merges and " con" starts a new word. This follows
  // the text instead of the tag adjacency (which is true for every adjacent
  // span and was merging whole lines). Falls back to explicit markers when the
  // line has no usable word boundary (CJK, or a single word).
  function joinWordsByWhitespace(words) {
    const list = words || [];
    if (list.length < 2) return list;
    let full = "";
    const ranges = [];
    for (const word of list) {
      // The space between spans lives in hasSpaceBefore, NOT in the span text.
      // Put it back so the tokenizer sees the real word boundary.
      if (word.hasSpaceBefore && full.length) full += " ";
      const start = full.length;
      full += word.text;
      ranges.push({ word, start, end: full.length });
    }
    const tokens = [];
    const re = /\S+/g;
    let match;
    while ((match = re.exec(full))) {
      tokens.push({ start: match.index, end: match.index + match[0].length });
    }
    if (tokens.length < 2) return joinPartOfWordRuns(list);
    const out = [];
    for (const token of tokens) {
      const parts = [];
      for (const range of ranges) {
        if (range.end <= token.start || range.start >= token.end) continue;
        const from = Math.max(0, token.start - range.start);
        const to = Math.min(range.word.text.length, token.end - range.start);
        const piece = range.word.text.slice(from, to);
        if (piece) parts.push({ piece, word: range.word });
      }
      if (!parts.length) continue;
      out.push(Object.assign({}, parts[0].word, {
        text: parts.map((part) => part.piece).join(""),
        start: parts[0].word.start,
        end: parts[parts.length - 1].word.end,
        timed: parts.some((part) => part.word.timed),
        isPartOfWord: false,
      }));
    }
    return out.length ? out : joinPartOfWordRuns(list);
  }

  function joinTTMLSyllables(parsed) {
    return (parsed || []).map((line) => Object.assign({}, line, {
      words: joinWordsByWhitespace(line.words),
      background: (line.background || []).map((bg) => Object.assign({}, bg, {
        words: joinWordsByWhitespace(bg.words),
      })),
    }));
  }

  // Returns the compact TTML form used by the YTMod adapter.
  function parseTTML(xml) {
    const parsed = [];
    const lineRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    // Collect every timed line first so the primary (lead) artist can be chosen
    // by how many lines they sing, not by whoever happens to open the file. A
    // duet that begins on the second artist's line would otherwise annotate the
    // whole file backwards — lead on the right, partner on the left.
    const rawLines = [];
    const agentCounts = new Map();
    let lineMatch;
    while ((lineMatch = lineRe.exec(xml))) {
      const lineAttrs = attrsOf(lineMatch[1]);
      const agent = lineAttrs["ttm:agent"] || lineAttrs.agent || "";
      rawLines.push({ lineAttrs, body: lineMatch[2], agent });
      if (agent) agentCounts.set(agent, (agentCounts.get(agent) || 0) + 1);
    }

    // The primary artist is the one with the most timed lines. Ties keep the
    // first-seen agent (harmless); the case that matters is a duet opening on the
    // partner's line, where the majority vote still lands on the real lead.
    let primaryAgent = "";
    let primaryCount = -1;
    for (const [agent, count] of agentCounts) {
      if (count > primaryCount) {
        primaryCount = count;
        primaryAgent = agent;
      }
    }
    if (!primaryAgent) {
      const firstAgented = rawLines.find((l) => l.agent);
      primaryAgent = firstAgented ? firstAgented.agent : "";
    }

    for (const { lineAttrs, body, agent } of rawLines) {
      let start = tsToSec(lineAttrs.begin || lineAttrs["ttm:begin"]);
      const lineDuration = tsToSec(lineAttrs.dur || lineAttrs["ttm:dur"]);
      let end = tsToSec(lineAttrs.end || lineAttrs["ttm:end"]);
      if (!end && lineDuration) end = start + lineDuration;
      const topLevelSpans = parseSpanTree(body);
      const leadNodes = topLevelSpans.filter((node) => node.attrs["ttm:role"] !== "x-bg");
      const backgroundNodes = topLevelSpans.filter((node) => node.attrs["ttm:role"] === "x-bg");
      const words = parseTimedSpanNodes(leadNodes, body, start, end);
      if (!start && words.length) start = words[0].start;
      if (!end && words.length) end = words[words.length - 1].end;

      // An x-bg wrapper usually carries NO timing of its own — the times live on
      // its child spans. Resolving the window wrapper-first and falling back to
      // the PARENT LINE put the background's window entirely BEFORE it played.
      // Measured on a real file (glaive "60.000 ISK", L15): the line ran 46.448
      // to 49.066 while its bg ran 49.176 to 51.876. So the bg line was Active
      // while every one of its words was still NotSung, and Sung by the time they
      // were due — the fill never ran and the vocal rendered dead (no fill at
      // all). Upstream's order is children -> wrapper -> line; ours never
      // consulted the children.
      //
      // NOTE: untimed wrappers are not an exotic input — parseSpicyLyrics BELOW
      // emits exactly this shape (`<span ttm:role="x-bg">` with the timing only on
      // the child spans), so our own API round-trip manufactures it. The parser
      // must therefore never rely on the wrapper's timing.
      const background = backgroundNodes
        .map((node) => {
          const rawBegin = node.attrs.begin || node.attrs["ttm:begin"];
          const rawEnd = node.attrs.end || node.attrs["ttm:end"];
          const rawDur = node.attrs.dur || node.attrs["ttm:dur"];
          // null, NOT 0: tsToSec reports a missing value as 0, and 0 is a legal
          // timestamp, so a falsy sentinel would be indistinguishable from a real
          // one — and the Math.min below would then drag the window to t=0.
          const wrapStart = rawBegin ? tsToSec(rawBegin) : null;
          const wrapEnd = rawEnd ? tsToSec(rawEnd) : null;
          const wrapDur = rawDur ? tsToSec(rawDur) : 0;

          const bgWords = parseTimedSpanNodes(
            node.children,
            body,
            wrapStart == null ? start : wrapStart,
            wrapEnd == null ? end : wrapEnd
          );
          if (!bgWords.length) return null;

          const wordStart = bgWords.reduce((a, w) => Math.min(a, w.start), Infinity);
          const wordEnd = bgWords.reduce((a, w) => Math.max(a, w.end), -Infinity);
          // children first, then the wrapper — and never narrower than the
          // children either way. Trusting the wrapper verbatim would clip what it
          // wraps, which is the whole failure this block exists to avoid.
          const bgStart = wrapStart == null ? wordStart : Math.min(wrapStart, wordStart);
          let bgEnd = wrapEnd == null ? wordEnd : Math.max(wrapEnd, wordEnd);
          if (wrapDur) {
            bgEnd = Math.max(bgEnd, (wrapStart == null ? wordStart : wrapStart) + wrapDur);
          }
          return { start: bgStart, end: bgEnd, words: bgWords };
        })
        .filter(Boolean);

      // ⭐ Background vocals can start before, or run past, the lead line, and the
      // lead's window has to COVER them or they get clipped. Every bg fill rule is
      // gated on `.line.bg-line.Active`, so a bg that outlives its line would sit
      // at WordNotSung for the whole of the line's window and Sung afterwards —
      // never filled. Upstream widens the lead here for exactly this reason.
      //
      // ⚠️ This makes the line's window OVERLAP its neighbour's — measured 494 ms
      // on a real file. The renderer is fine with that (it states each line from
      // its own times, so a widened line cannot suppress its neighbour), but the
      // active-line lookup was NOT: it used to be a binary search, which is only
      // valid on disjoint windows and would return the previous line, or -1
      // ("no line playing", which dims the whole panel). findLineIndexAt is now a
      // linear scan for exactly this reason — do NOT reintroduce a binary search
      // over these windows.
      for (const bg of background) {
        if (bg.start < start) start = bg.start;
        if (bg.end > end) end = bg.end;
      }

      const plainText = words.length
        ? words
            .map((word) => (word.hasSpaceBefore ? " " : "") + word.text)
            .join("")
            .trim()
        : // No inner spans: a line-only body (lrc.red `lrc:timing="Line"`, plain
          // TTML exports) carries its whole line as bare <p> text. Derive the text
          // from the body so the line SURVIVES — otherwise empty plainText hits the
          // `continue` below, the parse returns nothing, and loadTTML reports a
          // failure. That is why lrc.red fetched line-level TTML and then silently
          // fell through to the next source (AJ, 2026-10-19).
          decodeEntities(String(body).replace(/<[^>]*>/g, " "))
            .replace(/\s+/g, " ")
            .trim();
      if (!plainText && !words.length && !background.length) continue;
      const pTiming = !!(
        lineAttrs.begin ||
        lineAttrs["ttm:begin"] ||
        lineAttrs.end ||
        lineAttrs["ttm:end"] ||
        lineAttrs.dur ||
        lineAttrs["ttm:dur"]
      );
      const hasSpanTiming = words.some((w) => w.timed);
      parsed.push({
        start,
        end,
        words,
        background,
        text: plainText,
        oppositeAligned: !!agent && !!primaryAgent && agent !== primaryAgent,
        // True when the line carried at least one genuinely-timed span. Lines
        // without it are rendered as a static block, not karaoke (AJ, 2026-09-17).
        timed: hasSpanTiming,
        // True when the line had any real timing (a <p> begin/end/dur or a timed
        // span). Lines without it get a synthesized t=0 and would pile at the top
        // of the panel, burying the synced lines — see the gap-fill pass below.
        positioned: !!(pTiming || hasSpanTiming),
      });
    }

    // Some exports contain no inner spans. Treat each line as one timed word
    // so the original Syllable renderer still handles the file gracefully.
    // NOTE: we deliberately do NOT sort here. The gap-fill pass below must see
    // the lines in their original document order so it can slide each untimed
    // line into the gap between the timed neighbours it actually sits between
    // (an untimed line that follows S1 in the file must land between S1 and S2,
    // not get swept to the top by a t=0 sort). The final time sort happens
    // after the gap-fill (see just before the return) — AJ, 2026-09-17.
    for (let i = 0; i < parsed.length; i++) {
      const line = parsed[i];
      const nextStart = parsed[i + 1] ? parsed[i + 1].start : 0;
      if (!line.end || line.end <= line.start) {
        const lastWordEnd = line.words.length
          ? line.words[line.words.length - 1].end
          : 0;
        line.end = lastWordEnd > line.start
          ? lastWordEnd
          : (nextStart > line.start ? nextStart : line.start + 4);
      }
      if (!line.words.length && line.text) {
        line.words.push({ text: line.text, start: line.start, end: line.end, timed: false });
      }
      for (const word of line.words) {
        if (!word.end || word.end <= word.start) word.end = line.end;
        word.start = Math.max(line.start, word.start);
        word.end = Math.max(word.start + 0.01, Math.min(line.end, word.end));
      }
      for (const bg of line.background || []) {
        if (!bg.end || bg.end <= bg.start) {
          bg.end = bg.words.length ? bg.words[bg.words.length - 1].end : line.end;
        }
        for (const word of bg.words) {
          if (!word.end || word.end <= word.start) word.end = bg.end;
          word.start = Math.max(bg.start, word.start);
          word.end = Math.max(word.start + 0.01, Math.min(bg.end, word.end));
        }
      }
    }

    // Untimed lines (no <p> begin/end and no span timing) were pinned to t=0 by
    // the fallback above, so they all pile at the top of the panel and bury the
    // synced lines underneath. Slide each one into the gap between the nearest
    // timed line before and after it so it sits roughly where it belongs in the
    // song (AJ, 2026-09-17).
    {
      const timedIdx = [];
      parsed.forEach((line, idx) => {
        if (line.positioned) timedIdx.push(idx);
      });
      if (timedIdx.length) {
        for (let t = 0; t <= timedIdx.length; t++) {
          const prevTimedIdx = t === 0 ? -1 : timedIdx[t - 1];
          const nextTimedIdx = t === timedIdx.length ? parsed.length : timedIdx[t];
          const prevEnd = prevTimedIdx >= 0 ? parsed[prevTimedIdx].end : 0;
          const nextStart = nextTimedIdx < parsed.length ? parsed[nextTimedIdx].start : prevEnd + 4000;
          const untimed = [];
          for (let i = (prevTimedIdx >= 0 ? prevTimedIdx + 1 : 0); i < nextTimedIdx; i++) {
            if (!parsed[i].positioned) untimed.push(i);
          }
          if (!untimed.length) continue;
          const gap = Math.max(1, nextStart - prevEnd);
          untimed.forEach((lineIdx, k) => {
            const frac = (k + 1) / (untimed.length + 1);
            const at = prevEnd + gap * frac;
            const line = parsed[lineIdx];
            line.start = at;
            line.end = at + 1;
            line.words.forEach((w) => { w.start = at; w.end = at + 1; });
            if (line.background) line.background.forEach((bg) => {
              bg.start = at;
              bg.end = at + 1;
              bg.words.forEach((w) => { w.start = at; w.end = at + 1; });
            });
          });
        }
      }
    }

    // Final time sort. The gap-fill above has now assigned every line its final
    // start time (untimed lines slid into the gaps between their document-order
    // timed neighbours), but the array is still in document order. Sort by start
    // here so untimed lines interleave with the synced lines at their real
    // position in the song instead of piling on top and burying the synced
    // words (AJ, 2026-09-17).
    parsed.sort((a, b) => a.start - b.start);

    return parsed.filter((line) => line.text || line.words.length);
  }

  // Pulls songwriter credits out of a TTML string. Apple Music exports nest them
  // in <iTunesMetadata><songwriters><songwriter>NAME</songwriter>…</songwriters></iTunesMetadata>,
  // which lives outside the timed <p> lines and is skipped by parseTTML. Some AMLT
  // exports instead expose them as a comma/semicolon list on amll:meta, so we catch
  // that as a fallback. Returns a de-duplicated array of display names.
  function extractSongwriters(xml) {
    const names = [];
    const pushName = (raw) => {
      const name = decodeEntities(raw).replace(/\s+/g, " ").trim();
      if (name && !names.includes(name)) names.push(name);
    };

    const metaBlock = /<iTunesMetadata\b[^>]*>([\s\S]*?)<\/iTunesMetadata>/i.exec(xml);
    if (metaBlock) {
      const swBlock = /<songwriters\b[^>]*>([\s\S]*?)<\/songwriters>/i.exec(metaBlock[1]);
      const source = swBlock ? swBlock[1] : metaBlock[1];
      const tagRe = /<songwriter\b[^>]*>([\s\S]*?)<\/songwriter>/gi;
      let match;
      while ((match = tagRe.exec(source))) pushName(match[1]);
    }

    if (!names.length) {
      const metaRe = /<amll:meta\b[^>]*\bkey="(songwriters|lyricists?)"[^>]*\bvalue="([^"]*)"/gi;
      let match;
      while ((match = metaRe.exec(xml))) {
        match[2]
          .split(/[,;、]/)
          .forEach((part) => pushName(part));
      }
    }
    return names;
  }

  // Adapts parseTTML's line model into the renderer's content shape.
  //
  // `LineTimed` IS NOT "THIS LINE IS SYNCED" — that mistake collapses the whole
  // animation. It means "this line has NO word-level timing", and it feeds
  // straight into karaoke suppression:
  //
  //   makeWord(word, isLast, lineTimed, noKaraoke)
  //     suppressKaraoke = !!(noKaraoke && !lineTimed)      // lineTimed true => keep? No:
  //   noKaraoke = !!(contentLine.LineTimed || !contentLine.Timed)
  //
  // A true `LineTimed` marks the line `line-timed`, which forces the whole line
  // to fill as ONE unit instead of sweeping word by word, AND short-circuits the
  // background-vocal pass. Setting it for a word-by-word body (Spicy
  // `Body.Type:"Syllable"`, i.e. anything with per-syllable times) turns CRANK's
  // syllable karaoke into a line fill and makes its `<span ttm:role="x-bg">`
  // background vocals disappear entirely.
  //
  // So derive it from the WORDS, exactly like the LRC producer does (one word,
  // letter animation disabled). The two producers that must stay `true` are
  // `parseLRC` (line-synced LRC) and nothing else; a Syllable body has real
  // per-word timing and must stay `false` to keep its karaoke.
  //
  // `positioned` (timing exists somewhere) is NOT a substitute for any of this —
  // it is true for word-timed lines too. It only distinguishes "has a time
  // window" from "fully unsynced", which is what `Timed` already covers for the
  // noKaraoke calculation.
  function toSyllableContent(sourceLines) {
    return sourceLines.map((line) => {
      const syllables = line.words || [];
      // Word-level timing present? Then this is a karaoke line, not a line-filled
      // one. Mirrors parseLRC's contract: lineTimed === no word timing.
      const hasWordTiming = syllables.some((word) => word.timed === true);
      const explicitLineTimed = line.lineTimed === true;
      if (explicitLineTimed) {
        // parseLRC / parsePlain speak this dialect directly — trust it verbatim
        // so the LRCLIB path keeps behaving exactly as it did.
        return {
          Type: "Vocal",
          LineTimed: true,
          Timed: true,
          OppositeAligned: !!line.oppositeAligned,
          Lead: {
            StartTime: line.start,
            EndTime: line.end,
            Syllables: buildRendererSyllables(syllables),
          },
          Background: buildRendererBackground(line.background),
        };
      }
      return {
        Type: "Vocal",
        LineTimed: !hasWordTiming,
        Timed: !!(line.timed || line.positioned),
        OppositeAligned: !!line.oppositeAligned,
        Lead: {
          StartTime: line.start,
          EndTime: line.end,
          Syllables: buildRendererSyllables(syllables),
        },
        Background: buildRendererBackground(line.background),
      };
    });
  }

  function buildRendererSyllables(words) {
    return (words || []).map((word) => ({
      Text: word.text,
      StartTime: word.start,
      EndTime: word.end,
      IsPartOfWord: !!word.isPartOfWord,
      // HasSpaceBefore is the ONLY trustworthy word-boundary signal: it comes
      // from the real markup between the two <span>s. IsPartOfWord is inferred
      // from "no whitespace between the tags", which is also true for adjacent
      // whole words, so it cannot be used to decide where spaces go.
      HasSpaceBefore: word.hasSpaceBefore === true,
      DisableLetterAnimation: !!word.disableLetterAnimation,
    }));
  }

  function buildRendererBackground(background) {
    return (background || []).map((bg) => ({
      StartTime: bg.start,
      EndTime: bg.end,
      Syllables: buildRendererSyllables(bg.words),
    }));
  }

  /* ===================== original renderer primitives ===================== */

  // Adapted from Fraktality/spr, matching the source project's Spring.ts.
  class Spring {
    constructor(startPosition, frequency, dampingRatio, goal) {
      this.d = dampingRatio;
      this.f = frequency;
      this.g = goal == null ? startPosition : goal;
      this.p = startPosition;
      this.v = 0;
    }

    Step(dt) {
      const d = this.d;
      const f = this.f * (2 * Math.PI);
      const g = this.g;
      let p = this.p;
      let v = this.v;

      if (d === 1) {
        const q = Math.exp(-f * dt);
        const w = dt * q;
        const c0 = q + w * f;
        const c2 = q - w * f;
        const c3 = w * f * f;
        const o = p - g;
        p = o * c0 + v * w + g;
        v = v * c2 - o * c3;
      } else if (d < 1) {
        const q = Math.exp(-d * f * dt);
        const c = Math.sqrt(1 - d * d);
        const i = Math.cos(dt * f * c);
        const j = Math.sin(dt * f * c);
        const z = c > 1e-5
          ? j / c
          : dt * f + (((dt * f) ** 2) * (c ** 4) / 20 - c * c) * (dt * f) ** 3 / 6;
        const y = f * c > 1e-5
          ? j / (f * c)
          : dt + (((dt * f * c) ** 2) * (f * f * c * c) / 20 - f * f * c * c) * dt ** 3 / 6;
        const o = p - g;
        p = (o * (i + z * d) + v * y) * q + g;
        v = (v * (i - z * d) - o * (z * f)) * q;
      } else {
        const c = Math.sqrt(d * d - 1);
        const r1 = -f * (d + c);
        const r2 = -f * (d - c);
        const ec1 = Math.exp(r1 * dt);
        const ec2 = Math.exp(r2 * dt);
        const o = p - g;
        const co2 = (v - o * r1) / (2 * f * c);
        const co1 = ec1 * (o - co2);
        p = co1 + co2 * ec2 + g;
        v = co1 * r1 + co2 * ec2 * r2;
      }

      this.p = p;
      this.v = v;
      return p;
    }

    SetGoal(goal, replacePosition) {
      this.g = goal;
      if (replacePosition) {
        this.p = goal;
        this.v = 0;
      }
    }

    CanSleep() {
      const offset = this.p - this.g;
      return this.v * this.v <= 1e-4 && offset * offset <= (1 / 3840) ** 2;
    }
  }

  // Natural cubic spline — byte-for-byte the interpolation the `cubic-spline`
  // npm package (v3.0.3, MIT, (c) 2014 Morgan Herlocker) performs, which is what
  // upstream Spicy Lyrics imports at LyricsAnimator.ts:2. Vendored rather than
  // bundled so the extension stays a single trusted-types-safe asset with no
  // runtime dependency loading. Verified against the real package to 0.00e+0
  // over every upstream range (see .scratch/verify-natural.mjs).
  //
  // This REPLACED a Catmull-Rom / finite-difference Hermite implementation that
  // looked equivalent — same control points, same shape — but is a genuinely
  // different curve. A natural cubic spline OVERSHOOTS its own control points on
  // a sharp kink; Catmull-Rom does not. Measured 2026-09-20:
  //
  //   range              old Catmull-Rom      new natural         what it changed
  //   Scale              1.0509 @ t=0.718     1.0536 @ t=0.615    shrink starts 10% sooner
  //   LetterScale        1.1752 @ t=0.706     1.1940 @ t=0.573    shrink starts 13% sooner
  //   YOffset           -0.01667 @ t=0.901   -0.03722 @ t=0.600    2.23x deeper rise
  //   LetterYOffset     -0.01786 @ t=0.901   -0.04000 @ t=0.599    2.24x deeper rise
  //   Glow               1.1611 @ t=0.356     1.4330 @ t=0.340    1.23x brighter
  //
  // The YOffset row is AJ's "it does go up a little but barely": -1/60 is only a
  // CONTROL POINT, the real curve reaches -0.0372. Equally important, the peak
  // TIME moves 0.901 -> 0.600, so the old curve held the word flat for 90% of its
  // life and then twitched at the very end — which is why it read as "just zooms
  // in". And the Scale row's earlier peak is literally "make it go smaller when
  // it's close to ending".
  //
  // Solve the tangents ONCE in the constructor: at() is called per word per frame.
  class Spline {
    constructor(points) {
      const sorted = points.slice().sort((a, b) => a.Time - b.Time);
      this.xs = sorted.map((point) => point.Time);
      this.ys = sorted.map((point) => point.Value);
      this.ks = this.solveTangents();
    }

    // Tridiagonal solve for the first derivative (tangent) at every knot, with
    // natural boundary conditions — second derivative zero at both ends, which in
    // the tangent formulation is 2*m0 + m1 = 3*slope0 (mirrored at the far end).
    // NOTE the two end rows are NOT 1/0/0 rows; seeding them as such makes b[0]
    // zero and the whole solve returns NaN.
    solveTangents() {
      const xs = this.xs;
      const ys = this.ys;
      const n = xs.length - 1;
      const a = new Array(n + 1).fill(0);
      const b = new Array(n + 1).fill(0);
      const c = new Array(n + 1).fill(0);
      const r = new Array(n + 1).fill(0);

      for (let i = 1; i < n; i++) {
        const hPrev = xs[i] - xs[i - 1];
        const hNext = xs[i + 1] - xs[i];
        a[i] = 1 / hPrev;
        b[i] = 2 * (1 / hPrev + 1 / hNext);
        c[i] = 1 / hNext;
        r[i] = 3 * ((ys[i] - ys[i - 1]) / (hPrev * hPrev) +
          (ys[i + 1] - ys[i]) / (hNext * hNext));
      }

      const firstH = xs[1] - xs[0];
      a[0] = 1 / firstH;
      b[0] = 2 / firstH;
      c[0] = 1 / firstH;
      r[0] = (3 * (ys[1] - ys[0])) / (firstH * firstH);

      const lastH = xs[n] - xs[n - 1];
      a[n] = 1 / lastH;
      b[n] = 2 / lastH;
      c[n] = 0;
      r[n] = (3 * (ys[n] - ys[n - 1])) / (lastH * lastH);

      // Thomas algorithm — forward eliminate, then back substitute.
      for (let i = 1; i <= n; i++) {
        const m = a[i] / b[i - 1];
        b[i] -= m * c[i - 1];
        r[i] -= m * r[i - 1];
      }
      const ks = new Array(n + 1).fill(0);
      ks[n] = r[n] / b[n];
      for (let i = n - 1; i >= 0; i--) ks[i] = (r[i] - c[i] * ks[i + 1]) / b[i];
      return ks;
    }

    // Cubic Hermite, written the way the package writes it: the tangents ARE the
    // Hermite slopes, so this is the same curve the second-derivative formulation
    // produces.
    //
    // Clamped at both ends. The real package returns NaN past the last knot and
    // extrapolates below the first, but every upstream call site feeds a value
    // already clamped to [0,1] by getProgressPercentage(), so clamping is
    // behaviourally identical in-range and strictly safer outside it.
    at(value) {
      const xs = this.xs;
      const ys = this.ys;
      const ks = this.ks;
      if (value <= xs[0]) return ys[0];
      if (value >= xs[xs.length - 1]) return ys[ys.length - 1];

      let index = 0;
      while (index < xs.length - 2 && value > xs[index + 1]) index++;
      const x0 = xs[index];
      const x1 = xs[index + 1];
      const width = x1 - x0 || 1;
      const t = (value - x0) / width;
      const rise = ys[index + 1] - ys[index];
      const from = ks[index] * width - rise;
      const to = -ks[index + 1] * width + rise;
      return (1 - t) * ys[index] + t * ys[index + 1] +
        t * (1 - t) * (from * (1 - t) + to * t);
    }
  }

  const easeSinOut = (value) => Math.sin(Math.max(0, Math.min(1, value)) * Math.PI / 2);
  const getSpline = (range) => new Spline(range);
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

  // Spline values are copied verbatim from upstream Spicy Lyrics
  // (LyricsAnimator.ts, v6.3.20). They are the entire "feel" of the karaoke
  // motion — the spring tuning only governs how fast a value chases its target,
  // while these curves define what the target IS. Keep them in lockstep with
  // upstream or the animation visibly diverges (AJ, 2026-09-20).
  // Resting scale is IdleLyricsScale = 0.95 upstream.
  const ScaleSpline = getSpline([
    { Time: 0, Value: 0.95 }, { Time: 0.7, Value: 1.0505 }, { Time: 1, Value: 1 },
  ]);
  // LetterScale / YOffset / LetterYOffset / DotOpacity each have a SIMPLE-LYRICS
  // variant upstream, so they are `let` and get re-pointed when the mode changes
  // (see applySimpleLyricsSplines). Simple mode's whole point is GENTLER CURVES:
  // the letter scale peaks at 1.07 instead of 1.175, and the line Y offset becomes
  // a straight drift to -0.033 instead of a dip-and-return. That is what AJ
  // describes as "smoothly move up a bit" instead of a bounce (2026-10-01).
  // Our 0 resting value is kept in BOTH variants — it is the twice-confirmed fix
  // for the "word glitches slightly down as it starts" bug documented below, and
  // it is independent of which curve set is active.
  const LETTER_SCALE_RANGE = [
    { Time: 0, Value: 0.95 }, { Time: 0.7, Value: 1.175 }, { Time: 1, Value: 1 },
  ];
  const SIMPLE_LETTER_SCALE_RANGE = [
    { Time: 0, Value: 0.95 }, { Time: 0.7, Value: 1.045 }, { Time: 1, Value: 1 },
  ];
  // Resting Y offset is 0, NOT upstream's +1/100. This is a deliberate, twice-
  // confirmed divergence — do not "restore parity" here a third time.
  //
  // WHY the non-zero resting value is a visible BUG and not just a sub-pixel
  // offset: a word's springs are created LAZILY, the first time it is animated,
  // with `SetGoal(..., true)` — and `replacePosition: true` SNAPS the spring to
  // the new value. There is no spring resting at +1/100 beforehand, so the word
  // is sitting at its natural position (translateY 0) and then JUMPS DOWN by 1%
  // of the font size (0.48px at 48px) the instant it first animates. That is a
  // step discontinuity, and it is what AJ reports as "as soon as a word starts,
  // it kinda glitches and goes very slightly down."
  //
  // With Time:0 = 0 the snap is a no-op, so the word simply begins at rest and
  // rises. That also makes the end pose consistent: both endpoints are 0, so a
  // fully sung word settles exactly where an unsung one sits.
  //
  // COST: none that matters. The dip is actually DEEPER without the offset
  // (-0.03901 vs upstream's -0.03722) because the natural spline has to travel
  // from 0 instead of from +0.01. Only the travel measured from the resting pose
  // is smaller (1.87px vs 2.27px at 48px), and 1.87px is still 2.34x the 0.80px
  // this whole exercise started from.
  //
  // The 0.9 overshoot and the 1.0 settle are byte-identical to upstream; only the
  // Time:0 control point differs.
  const Y_OFFSET_RANGE = [
    { Time: 0, Value: 0 }, { Time: 0.9, Value: -(1 / 60) }, { Time: 1, Value: 0 },
  ];
  // Upstream's Simple variant is a TWO-POINT line — it drifts up and STAYS there,
  // with no return to 0. That absence of a return is most of why it reads as a
  // smooth glide rather than a bounce. Time:0 is 0 for the reason above.
  const SIMPLE_Y_OFFSET_RANGE = [
    { Time: 0, Value: 0 }, { Time: 1, Value: -0.033 },
  ];
  const LETTER_Y_OFFSET_RANGE = [
    { Time: 0, Value: 0 }, { Time: 0.9, Value: -(1 / 56) }, { Time: 1, Value: 0 },
  ];
  const SIMPLE_LETTER_Y_OFFSET_RANGE = [
    { Time: 0, Value: 0 }, { Time: 0.9, Value: -(1 / 85) }, { Time: 1, Value: 0 },
  ];
  const DOT_OPACITY_RANGE = [
    { Time: 0, Value: 0.35 }, { Time: 0.6, Value: 1 }, { Time: 1, Value: 1 },
  ];
  const SIMPLE_DOT_OPACITY_RANGE = [
    { Time: 0, Value: 0.27 }, { Time: 0.6, Value: 1 }, { Time: 1, Value: 1 },
  ];

  let LetterScaleSpline = getSpline(LETTER_SCALE_RANGE);
  let YOffsetSpline = getSpline(Y_OFFSET_RANGE);
  let LetterYOffsetSpline = getSpline(LETTER_Y_OFFSET_RANGE);
  let DotOpacitySpline = getSpline(DOT_OPACITY_RANGE);

  // Re-point the four mode-dependent splines. Called from applySettings on every
  // settings pass, so a toggle takes effect without a reload. The springs read
  // these every frame to set their goals, so re-pointing is enough — there is no
  // spring to rebuild.
  function applySimpleLyricsSplines() {
    const simple = !!currentSettings.simpleLyrics;
    LetterScaleSpline = getSpline(simple ? SIMPLE_LETTER_SCALE_RANGE : LETTER_SCALE_RANGE);
    YOffsetSpline = getSpline(simple ? SIMPLE_Y_OFFSET_RANGE : Y_OFFSET_RANGE);
    LetterYOffsetSpline = getSpline(simple ? SIMPLE_LETTER_Y_OFFSET_RANGE : LETTER_Y_OFFSET_RANGE);
    DotOpacitySpline = getSpline(simple ? SIMPLE_DOT_OPACITY_RANGE : DOT_OPACITY_RANGE);
  }

  const GlowSpline = getSpline([
    { Time: 0, Value: 0 }, { Time: 0.15, Value: 1 }, { Time: 0.6, Value: 1 }, { Time: 1, Value: 0 },
  ]);
  const DotScaleSpline = getSpline([
    { Time: 0, Value: 0.75 }, { Time: 0.7, Value: 1.05 }, { Time: 1, Value: 1 },
  ]);
  const DotYOffsetSpline = getSpline([
    { Time: 0, Value: 0 }, { Time: 0.9, Value: -0.12 }, { Time: 1, Value: 0 },
  ]);
  const DotGlowSpline = getSpline([
    { Time: 0, Value: 0 }, { Time: 0.6, Value: 1 }, { Time: 1, Value: 1 },
  ]);

  // Upstream's residual-glow point for a sung letter in a word with no active
  // letter. NOTE it evaluates to ~1.21 (the natural spline overshoots its own
  // 0 -> 1 rise), NOT a small dim value — see the letter branch in
  // animateLetters() for why we deliberately do NOT apply it. Kept here as the
  // documented upstream value so an A/B can flip the behaviour in one line.
  // (Was documented as ~1.07 before the 2026-09-20 spline fix; the corrected
  // curve moves it to 1.21, which is 18.5px blur / 224% opacity, not less.)
  const SungLetterGlow = 0.2;

  // Simple lyrics (Apple Music style): upstream STUBS the Scale and Glow springs
  // out in this mode. createWordSprings and createDotSprings both return no-ops
  // for them and keep only the positional spring. That is exactly what removes the
  // per-word ZOOM and the wavy GLOW while leaving the smooth rise intact
  // (AJ, 2026-10-01: "the words still like zoom … they have that wavy glowy
  // animation too when a word is longer than a second").
  // The LETTER springs are deliberately NOT stubbed — upstream leaves those alone
  // and only gives them the gentler Simple splines.
  // The stubs RETURN THE RESTING VALUE rather than undefined: our animator feeds
  // the results straight into --ym-sl-base-scale and --text-shadow-opacity, so a
  // bare no-return would write NaN into both.
  // The stub must satisfy the FULL spring contract: storeNeedsAnimation() calls
  // CanSleep() on every channel, and a stub without it threw a TypeError on every
  // frame — which aborted animate() right after the scroll step. That was the
  // whole "it scrolls but nothing animates or highlights once the toggle is on"
  // symptom (AJ, 2026-10-01). CanSleep returns TRUE: a stub is always settled.
  const simpleSpring = (resting) => ({
    Step: () => resting,
    SetGoal: () => {},
    CanSleep: () => true,
  });

  function createWordSprings(word) {
    if (currentSettings.simpleLyrics) {
      return {
        // A LINE-TIMED word must rest at scale 1, not the 0.95 word resting
        // value: its scale goal is a constant 1 (animateWord pins it), and with
        // a stub holding 0.95 the whole line-span rendered 5% small and its
        // wrapped rows pulled inward -- AJ's "some rows shifted to the right"
        // on line-synced tracks (2026-10-02).
        Scale: simpleSpring(word && word.LineTimed ? 1 : ScaleSpline.at(0)),
        YOffset: new Spring(YOffsetSpline.at(0), 1.45, 0.4),
        // A LINE-TIMED word keeps a real Glow spring: its goal tracks the line's
        // sweep progress, and that glow IS the line-fill highlight AJ expects
        // ("they dont have glow when simple lyrics are on", 2026-10-02). The
        // no-glow rule stays for word-synced words, where the glow is the
        // per-syllable bounce this mode exists to remove.
        Glow: word && word.LineTimed
          ? new Spring(GlowSpline.at(0), 1.18, 0.56)
          : simpleSpring(GlowSpline.at(0)),
      };
    }
    return {
      Scale: new Spring(ScaleSpline.at(0), 0.88, 0.64),
      YOffset: new Spring(YOffsetSpline.at(0), 1.45, 0.4),
      Glow: new Spring(GlowSpline.at(0), 1.18, 0.56),
    };
  }

  function createLetterSprings() {
    // Simple lyrics: the letters KEEP their motion springs (the wavy drift AJ
    // wants to stay) and already read the gentler SIMPLE splines via
    // applySimpleLyricsSplines, but the Glow channel is stubbed — the letter glow
    // is the per-syllable highlight this mode exists to remove. The springs stay
    // real otherwise, so the progress-driven goals keep the letters awake and
    // writing (see the selfAwake note in animateWord).
    if (currentSettings.simpleLyrics) {
      return {
        Scale: new Spring(LetterScaleSpline.at(0), 0.88, 0.64),
        YOffset: new Spring(LetterYOffsetSpline.at(0), 1.45, 0.4),
        Glow: simpleSpring(GlowSpline.at(0)),
      };
    }
    return {
      Scale: new Spring(LetterScaleSpline.at(0), 0.88, 0.64),
      YOffset: new Spring(LetterYOffsetSpline.at(0), 1.45, 0.4),
      Glow: new Spring(GlowSpline.at(0), 1.18, 0.56),
    };
  }

  function createDotSprings() {
    if (currentSettings.simpleLyrics) {
      return {
        // Scale stays REAL in Simple mode: the dots' entrance zoom (0.75 -> 1) is
        // how they arrive, and stubbing it made them hard-pop in with no
        // animation at all (AJ, 2026-10-02: "they still snap when the 3 dots come
        // in"). The bounce this mode removes is the WORD karaoke, not the dots'
        // arrival. YOffset/Glow stay stubbed -- the dots must not drift.
        Scale: new Spring(DotScaleSpline.at(0), 0.7, 0.6),
        YOffset: simpleSpring(DotYOffsetSpline.at(0)),
        Glow: simpleSpring(DotGlowSpline.at(0)),
        Opacity: new Spring(DotOpacitySpline.at(0), 1, 0.5),
      };
    }
    return {
      Scale: new Spring(DotScaleSpline.at(0), 0.7, 0.6),
      YOffset: new Spring(DotYOffsetSpline.at(0), 1.25, 0.4),
      Glow: new Spring(DotGlowSpline.at(0), 1, 0.5),
      Opacity: new Spring(DotOpacitySpline.at(0), 1, 0.5),
    };
  }

  function isRtl(text) {
    if (!text) return false;
    const rtl = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/;
    for (const char of String(text)) {
      if (/[\d\s,.;:?!()[\]{}"'\\/<>@#$%^&*_=+-]/.test(char)) continue;
      return rtl.test(char);
    }
    return false;
  }

  function isLetterCapable(text, durationMs) {
    return durationMs >= 1000 && !isRtl(text);
  }

  // "4.5px" -> { value: 4.5, unit: "px" }. Returns null for anything that is not a
  // number with an optional trailing unit: colours, var(), calc(), translate3d().
  //
  // The unit must match on BOTH sides before a numeric comparison is allowed.
  // parseFloat alone is not enough: "rgba(255,255,255,.42)" and "rgba(255,255,255,.5)"
  // both read as 255, so a real colour change would be skipped as "no change".
  function splitNumericValue(text) {
    const match = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(text);
    return match ? { value: parseFloat(match[1]), unit: match[2].toLowerCase() } : null;
  }

  // `compareValue` is the number behind a value whose string cannot be parsed —
  // specifically `translate3d(0, calc(var(--DefaultLyricsSize) * 0.037), 0)`, which
  // starts with "translate3d(" so parseFloat returns NaN and the write degrades to an
  // exact string comparison. That string embeds a FULL-PRECISION spring value which
  // changes every frame, so the transform was rewritten (and a fresh string allocated)
  // every frame for every awake word and letter, and `epsilon` did nothing at all.
  // Callers that build such a string pass the underlying number here.
  // (Upstream Spicy Lyrics fixed the same thing in 6.3.98 the same way.)
  function setStyleIfChanged(element, property, value, epsilon, compareValue) {
    const previous = element.__ymSpicyStyleCache || (element.__ymSpicyStyleCache = {});
    const old = previous[property];
    const next =
      compareValue !== undefined && Number.isFinite(compareValue)
        ? { value: compareValue, unit: "" }
        : splitNumericValue(value);

    if (old !== undefined) {
      // Both frames comparable, same unit -> the epsilon applies.
      if (old !== null && typeof old === "object" && next !== null) {
        if (old.unit === next.unit && Math.abs(old.value - next.value) <= (epsilon || 0)) {
          return;
        }
      } else if (old === value) {
        return;
      }
    }
    previous[property] = next === null ? value : next;
    element.style.setProperty(property, value);
  }

  function getState(positionMs, startMs, endMs) {
    if (positionMs < startMs) return "NotSung";
    if (positionMs >= endMs) return "Sung";
    return "Active";
  }

  function getProgress(positionMs, startMs, endMs) {
    // NaN-safe. Every comparison against NaN is false, so without this guard a
    // non-finite playhead or span falls straight through to clamp(NaN) = NaN and
    // gets written into --gradient-position as "NaN%", which invalidates the
    // whole background-image and blanks the glyph for a frame. See tick().
    if (
      !Number.isFinite(positionMs) ||
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs)
    ) {
      return 0;
    }
    if (positionMs <= startMs) return 0;
    if (positionMs >= endMs) return 1;
    return clamp((positionMs - startMs) / (endMs - startMs), 0, 1);
  }

  function cacheLRCLyrics(key, data) {
    if (lrclibCache.has(key)) lrclibCache.delete(key);
    lrclibCache.set(key, data);
    while (lrclibCache.size > LRCLIB_CACHE_LIMIT) {
      lrclibCache.delete(lrclibCache.keys().next().value);
    }
  }

  // ---- Persistent LRC cache -------------------------------------------------
  // In-memory lrclibCache (above) is lost on every page reload, so the same
  // songs get re-fetched. This layer persists the last N songs in localStorage
  // (origin: music.youtube.com) so playback/reload reuses them. LRU eviction.
  const LYRICS_CACHE_KEY = "ytmod_lyrics_cache_v1";
  const LYRICS_CACHE_LIMIT = 15;

  function loadPersistentLyricsCache() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(LYRICS_CACHE_KEY);
      if (!raw) return new Map();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Map();
      return new Map(arr);
    } catch (_) {
      return new Map();
    }
  }

  function persistLyricsCache() {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify([...persistentLyricsCache]));
    } catch (_) {
      /* storage unavailable or full — non-fatal */
    }
  }

  const persistentLyricsCache = loadPersistentLyricsCache();

  function cacheLyricsPersistent(key, data) {
    if (!key || !data) return;
    persistentLyricsCache.delete(key);
    persistentLyricsCache.set(key, data);
    while (persistentLyricsCache.size > LYRICS_CACHE_LIMIT) {
      persistentLyricsCache.delete(persistentLyricsCache.keys().next().value);
    }
    persistLyricsCache();
  }

  function getLyricsPersistent(key) {
    if (!key) return null;
    if (!persistentLyricsCache.has(key)) return null;
    const data = persistentLyricsCache.get(key);
    // Refresh LRU position (most-recently-used) and persist the new order.
    persistentLyricsCache.delete(key);
    persistentLyricsCache.set(key, data);
    persistLyricsCache();
    return data;
  }

  /* ===================== renderer state ===================== */

  let modelLines = [];
  let lineElements = [];
  let lastRendererContent = null;
  const pendingAnimationLines = new Set();
  let tabEl = null;
  // The node the SYNCED tab was inserted into, captured at mount time. Comparing
  // against this is an O(1) liveness check that stays correct even if YTM nests
  // its tabs one level deeper than the element `findTabBar()` returns.
  let tabMountParent = null;
  let tabBar = null;
  let panelEl = null;
  let panelHost = null;
  let fontLinkEl = null;
  let panelVisible = false;
  let nativeTabAtOpen = null;
  let lyricsTabObserver = null;
  /* ---- external host (NPV dock) ----
     The Now Playing snippet can claim the live panel and dock it inside its own
     rail. Same idea as fullscreen: park the tab-driven visibility state, force
     the render loop on, and stop mountPanel() from reclaiming the node. */
  let externalHostActive = false;
  let externalHostSavedVisible = null;
  /* ---- fullscreen (video left, lyrics right) ----
     Deliberately minimal: only one flag plus the DOM restore points needed to
     put YTM's real <video> and our live lyrics panel back where they came from. */
  let fsActive = false;
  // Tab-driven panel state, parked while fullscreen owns the panel. Fullscreen
  // forces panelVisible on (the render loop gates on it) but must put the tab
  // state back on exit, or leaving fullscreen while another tab is active
  // strands the panel on screen. null = nothing parked.
  let fsSavedPanelVisible = null;
  let fsOverlay = null;
  let fsMediaHost = null;
  let fsLyricsHost = null;
  let fsSavedVideo = null; // { node, parent, next }
  let fsVideoModeSwapTimer = 0; // setTimeout handle for the in-flight backdrop swap
  // True while the OLD cover card is deliberately kept on screen across a
  // cover -> music-video swap, so the cut has something to cut FROM (AJ,
  // 2026-10-20). Cleared the moment the video is revealed, so the 2s reconcile
  // can resume tearing stray cards down.
  let fsHoldCoverCard = false;
  // ---- track-change media dissolve (AJ, 2026-10-20) ----------------------
  // ONE opacity value on the media host drives every transition: fade out on the
  // track change, fade back in when the incoming media can paint. Deliberately
  // sequential (out -> in), not a crossfade, so it works identically for
  // cover->cover, cover->MV, MV->cover and MV->MV (where there is no swap at
  // all — the same <video> is reused).
  let fsMediaFadingOut = false;
  let fsMediaFadeOutAt = 0;
  let fsMediaFadeTimer = 0;
  // Hard ceiling on how long the media may stay dissolved. Whatever the incoming
  // media does (no artwork URL, a broken image, a stalled stream), the pane comes
  // back — a dark pane is worse than a late one.
  let fsMediaFadeSafetyTimer = 0;
  // Which track the dissolve was last started for, plus when. Dedupes the two
  // signals that can both report the same skip (see fsMaybeFadeForTrackChange).
  let fsFadeTrackId = "";
  let fsFadeAt = 0;
  // When findPlayerVideo() first reported videoWidth 0 while a video was still
  // attached. Debounces "the source is reloading" against "this is an audio
  // track" (musicVideoType is NOT available on this build — probe confirmed).
  let fsVideoZeroSince = 0;
  // True while the CHROME (credit + transport + scrubber) is dissolved for a
  // cover <-> MV mode change. MV -> MV never sets it, so those skips leave the
  // chrome completely still (AJ, 2026-10-21).
  let fsChromeFading = false;
  // Backstop watchdog handle: force-restores the chrome if a mode-change fade is
  // ever left stranded (see fsChromeFadeOut). Cleared by fsChromeFadeIn and on
  // fullscreen exit.
  let fsChromeFadeHealTimer = 0;
  // Timestamp of the last fsChromeFadeOut, so fsChromeFadeIn can enforce a minimum
  // visible hold (see FS_CHROME_FADE_MIN_MS). Without it an MV -> MV-style instant
  // media-ready wipes the chrome-out class the same tick it was added and the
  // dissolve is never seen (AJ, 2026-10-21).
  let fsChromeFadeOutAt = 0;
  // Deferred restore handle for the minimum-hold above; cleared on fullscreen exit.
  let fsChromeFadeHoldTimer = 0;
  let fsSavedPanel = null; // { parent, next }
  let fsLayoutMode = "side";
  let fsControls = null;
  let fsLayoutSelect = null;
  let fsOptionsButton = null;
  let fsOffsetRange = null;
  let fsOffsetValue = null;
  let fsLyricsToggle = null;
  let fsLyricsHidden = false;
  let fsLyricsGapDimmed = false;
  let fsLyricsIntroDimmed = false;
  let fsLyricsFinalDimmed = false;
  let fsPlayerControls = null;
  let fsPlayerPlayButton = null;
  // Shuffle / Repeat chip buttons. They are TOGGLES and hold no state of their
  // own — refreshFullscreenPlayerState() reads YTM's real buttons each tick and
  // mirrors the result onto these.
  let fsPlayerShuffleButton = null;
  let fsPlayerRepeatButton = null;
  let fsPlayerLikeButton = null;   // fullscreen "like" button (clones YTM's own icon)
  let fsPlayerDislikeButton = null; // fullscreen "dislike" button (clones YTM's own icon)
  let fsPlayerVolumeRange = null; // the custom <div> track (replaces native range input)
  let fsPlayerVolumeValue = 100;   // numeric 0-100 volume, source of truth for the custom slider
  let fsPlayerSeekRange = null;
  let fsTimeCurrent = null;
  let fsTimeTotal = null;
  let fsScrubTip = null; // time bubble above the seek thumb while dragging
  let fsPlayerStateTimer = 0;
  let fsBgImg = null; // cover-art layer used when fullscreen has no live video
  let fsArtImg = null; // sharp cover-art card in fsMediaHost (no-video tracks)
  let fsArtVideo = null;        // animated Apple Music cover <video> (m8tec HLS stream)
  let fsArtWarmHost = null;     // off-screen host that keeps the stream warm out of fullscreen
  let fsArtNoAlbumKey = "";     // rough track key for the "album not settled yet" retry
  let fsArtNoAlbumTries = 0;
  let fsArtVideoHls = null;     // hls.js instance bound to fsArtVideo
  let fsArtVideoKey = "";       // track key whose animated art the video currently shows
  let fsArtVideoLoadingKey = ""; // track key currently being fetched
  const fsArtVideoFail = new Set();  // track keys with no animated art (skip re-fetch)
  const fsArtVideoCache = new Map(); // track key -> m3u8 url | false
  // ---- persisted animated-art cache (30-day TTL) ---------------------------
  // The Map above is the in-memory mirror; this is the chrome.storage copy, so a
  // URL survives reloads and a replayed track shows its cover with NO API call.
  // Only POSITIVE results persist — "this album has no animated art" can change
  // (a later upload), so a miss stays session-only (AJ, 2026-10-03).
  const ART_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const ART_CACHE_VERSION = 1;
  const ART_CACHE_LIMIT = 200;
  let artCache = null;
  let artCacheLoad = null;
  let artCacheDirty = false;
  let artCacheFlushTimer = 0;
  let fsBgRefresh = null; // interval id for tracking track changes during fs
  // Kawarp WebGL backdrop for song fullscreen (handed off from the Dynamic add-on).
  let fsKawarpCanvas = null;
  let fsKawarp = null;
  let fsKawarpModulePromise = null;
  let fsKawarpArtUrl = ""; // artwork currently loaded into the Kawarp instance
  let fsKawarpVideoEl = null; // live <video> currently feeding the Kawarp instance
  let fsKawarpSeq = 0; // guards async module/loadImage races
  let fsKawarpActive = false;
  let fsKawarpResizeObserver = null;
  let fsLyricsShade = null; // adaptive readability gradient in video-background mode
  let fsLyricsShadeTimer = 0;
  let fsLyricsShadeLevel = 0;
  let fsLyricsShadeTarget = 0;
  let fsLyricsShadeLastSampleAt = 0;
  let fsLyricsShadeCanvas = null;
  let fsLyricsShadeCtx = null;
  let fsLyricsShadeCanvasTainted = false;
  let fsLyricsShadeStream = null;
  let fsLyricsShadeTrack = null;
  let fsLyricsShadeCapture = null;
  let fsLyricsShadeReader = null;
  let fsLyricsShadeSampleInFlight = false;
  // Bright-video controls scrim (AJ, 2026-09-28 QoL). The fullscreen controls
  // are deliberately surface-less, so over a bright / near-white music video
  // (especially once the lyrics — and their readability shade — are hidden)
  // they wash out completely. This flag drives a dark scrim behind the chrome
  // only while the sampled video brightness is high. Hysteresis lives in
  // setFullscreenBrightVideo() so a video hovering at the threshold cannot
  // strobe it.
  let fsBrightVideo = false;
  // "Artist Track" overlay title. Rendered in BOTH fullscreen variants; the
  // no-video variant gets it larger (see the CSS and refreshFsTitle()).
  let fsTitleEl = null;
  // Fullscreen "Next up" list (bottom-left). Its OWN element, separate from the
  // next-up add-on's pill (which hides in fullscreen).
  let fsNextUp = null;
  // Long-title marquee state (2026-09-28). fsTitleInner is the nowrap wrapper
  // that gets the translateX animation; the shift is passed in via the
  // --ym-sl-fs-title-shift CSS variable on the inner. fsTitleRO watches
  // fsTitleEl for resize and re-measures (text width or container width
  // can change with layout, font size, or track info).
  let fsTitleInner = null;
  let fsTitleRO = null;
  // Cover-card crossfade state. fsArtImgSeq invalidates stale onload handlers
  // when src changes mid-decode — without it a slow second load could land
  // AFTER a third src swap and "reveal" the wrong src.
  let fsArtImgSeq = 0;
  // Blurred ambient backdrop: a low-res duplicate of the live video, scaled
  // up and CSS-blurred to fill the overlay behind the sharp video. Drawn at
  // the video's own paint cadence so it never competes with the lyrics loop.
  let fsBgCanvas = null;
  let fsBgCtx = null;
  let fsBgRaf = null;
  let fsBgLastDrawAt = 0;
  // The ambient layer is blurred beyond recognition, so 24fps and a very small
  // backing store are visually close to 60fps while costing a fraction of the
  // draw + upload work. AJ asked for 60fps anyway (2026-09-27) - the canvas is
  // only ever created for music videos, so this raises the MV backdrop refresh
  // rate without touching cover-art tracks (they use the static blurred image
  // or Kawarp, not this loop). The loop is driven by requestVideoFrameCallback,
  // so it draws once per real video frame and cannot outrun the source.
  const FS_BG_RENDER_FPS = 60;
  const FS_BG_FRAME_INTERVAL_MS = 1000 / FS_BG_RENDER_FPS;
  // NOTE (AJ, 2026-10-20): FS_BAND_GAP was removed with the measured band anchor.
  // Chrome positions are fixed lengths in 05-styles.jsfrag now, so nothing needs
  // the old 18px pane-to-title gap as a variable.
  const FS_LYRICS_SHADE_SAMPLE_MS = 240;
  // Shade sampling geometry. The sample covers the FULL lyric band: from the
  // left edge of the shade/lyric region, bottom to top, through to the right
  // edge. .ym-sl-fs-lyrics-shade is `left: 53%; right: 0; top: 0; bottom: 0`,
  // and the lyric column sits inside that at `left: 61%; width: 39%`, so 53% is
  // the true start of the area that gets darkened.
  const FS_SHADE_SAMPLE_W = 48;
  const FS_SHADE_SAMPLE_H = 32;
  const FS_SHADE_REGION_LEFT = 0.53; // matches the shade element's left: 53%
  // Fallback band used only when the video/overlay geometry is unavailable.
  const FS_SHADE_SAMPLE_X = Math.floor(FS_SHADE_SAMPLE_W * FS_SHADE_REGION_LEFT);
  const FS_SHADE_SAMPLE_SW = FS_SHADE_SAMPLE_W - FS_SHADE_SAMPLE_X;
  const FS_IDLE_HIDE_MS = 2000; // no input for this long -> hide cursor + controls
  const FS_LYRICS_GAP_DIM_MS = 3000; // only dim genuinely long lyric gaps
  const FS_LYRICS_RESTORE_LEAD_MS = 850; // restore shortly before the next line
  const FS_FINAL_LYRICS_HIDE_MS = 6000; // stale final lyric -> hide after 6s
  let fsIdleTimer = 0; // setTimeout id for the idle countdown
  let fsIdleHidden = false; // is the overlay currently in the idle state?
  let fsPointerDown = false; // is a button held (i.e. actively dragging)?
  let mountTabTimer = 0;
  let raf = 0;
  // Auto-scroll state. The spring glide's own state (the Spring instance, its
  // goal, the frame timestamps) lives with the glide in 13-loading-scroll.
  // `lastScrollTargetLine` is the line we are currently gliding toward, which is
  // NOT always `lastActiveLine` — see the early-scroll block in animate().
  let lastScrollTargetLine = -1;
  // Set by any structural change that invalidates the scroll position: a new
  // track, entering or leaving fullscreen, or switching the fullscreen layout.
  // While set, the next placement snaps instead of gliding. See
  // recentreActiveLine().
  let pendingInstantScroll = false;
  // While `performance.now() < recentreUntilMs`, animate() pins the camera to the
  // active line EVERY frame, instantly. A one-shot placement is not enough for
  // the fullscreen layout switch: that resizes the lyrics column with a CSS
  // transition, so the geometry keeps moving for a few hundred ms and a single
  // placement would be correct only for the first frame of it.
  let recentreUntilMs = 0;
  const RECENTRE_WINDOW_MS = 600;
  let lastFrameTime = performance.now();
  let lastActiveLine = -1;
  let manualScrollActive = false;
  // After the user scrolls/keys away to browse lyrics, automatically return to
  // the active line if they stop interacting this long.
  const FS_JUMP_RETURN_MS = 8000;
  let manualScrollReturnTimer = 0;
  let jumpButton = null;
  // MUST be module scope, not a `const` inside buildUI(). refreshPermanentDeleteState()
  // and deletePermanentTTMLForCurrentTrack() both live out here and read it, so
  // declaring it inside buildUI made every call throw ReferenceError — which,
  // because both callers are `async`, surfaced only as an unhandled rejection in
  // the console while silently breaking the whole "Delete saved" button.
  let deletePermanentButton = null;
  let wpObserver = null;
  let lineScrollEl = null;
  let linesRoot = null;
  // QOL #1 (2026-09-28): end-of-track credits reveal. When a SYNCHRONISED track
  // reaches its final ~1.5s, glide the panel to the bottom so the .ym-sl-credits
  // block (provider / uploaded-by / made-by) scrolls into view. Static (unsynced)
  // lyrics already reach the bottom on their own via driveStaticAutoScroll, so
  // this only engages for synced lyrics.
  let creditsFooterEl = null;        // the footer element, or null when there are no credits
  let creditsRevealEngaged = false;  // we are in the end zone and have taken over the scroll
  let creditsRevealActive = false;   // owns the scroll target on the current frame
  let creditsRevealDismissed = false;// the user manually scrolled away -> stay out until next track
  const CREDITS_REVEAL_MS = 1500;    // reveal during the final 1.5s of the track
  let scrollCandidateIndices = [];
  // Loading-skeleton plumbing. `lyricsSkeletonToken` is bumped by every panel
  // reset, which invalidates a skeleton paint still queued on rAF/`setTimeout`.
  // Without it the placeholder can land AFTER the lyrics it stood in for: the
  // paint is deferred on purpose (see showLyricsSkeleton), so a fast fetch wins
  // the race and then gets clobbered a frame later.
  let lyricsSkeletonToken = 0;
  let lyricsSkeletonShown = false;
  let currentTrackKey = "";
  // Separate sequence for prefetch so an in-flight next-track lookup can never
  // collide with or abort the current track's lyric request (which uses
  // trackRequestSeq / activeTrackAbort).
  let prefetchSeq = 0;
  // Per-track offset slots: one for music-video playback, one for the regular
  // (audio) song. See setVideoOffsetMs / loadVideoOffsetForTrack.
  let offsetVideoMs = 0;
  let offsetSongMs = 0;
  let activeOffsetMode = "video";   // which slot is applied to playback (auto by hasMusicVideo)
  let editingOffsetMode = "video";  // which slot the on-screen control edits / displays
  let lastOffsetModeCheckAt = 0;

  /* ---- MV pause re-sync state ------------------------------------------------
     A music video can stop the MUSIC while the video keeps playing, so after the
     pause every lyric line is early by the pause length. ONE sync point per track:
     { line: <original startTime ms of the chosen line>, offset: ms }.
     Lines from `line` onward use `offset`; lines before it keep the normal
     per-track offset. The offset is set by hand with a slider — nothing is derived
     from the video position. See getOffsetForPosition(). */
  let pauseSync = null;
  // True while the user is picking a line. Suspends auto-scroll and makes line
  // clicks select instead of seek.
  let pausePickMode = false;
  // DOM refs for the options-overlay PAUSE SYNC section and the in-panel banner.
  let pauseUi = null;
  let pauseBanner = null;
  let pauseBannerText = null;
  let manualLyricsTrackKey = "";
  let manualLyricsIsPermanent = false;
  let currentLyricsIsTTML = false;
  // Raw TTML is retained only for user-imported lyrics so export can preserve
  // the original file. Auto-fetched lyrics never populate this value.
  let importedTTMLXml = "";
  let currentTTMLSource = "none";
  // True when the currently displayed lyrics are plain (unsynced) text loaded
  // from an LRCLIB result that had no synced lyrics. Static lines render fully
  // filled and never auto-scroll — see loadLRCLyrics / makeWord (AJ, 2026-09-18).
  let staticLyricsActive = false;
  // For static (unsynced) lyrics: when the user manually scrolls, auto-scroll is
  // paused and a "Auto scroll" popup is shown to resume it (AJ, 2026-09-18).
  let autoScrollUserPaused = false;
  let lastObservedTrackKey = "";
  let lastObservedPositionMs = null;
  let currentSongwriters = [];
  // Attribution for the currently loaded lyrics. `currentProvider` is a display
  // name ("Spicy Lyrics", "Apple Music", ...) and is set for EVERY API source.
  // `currentUploader` / `currentMaker` are the credited people and are only ever
  // non-null for a community sync (source === "spicy_lyrics"). Shape mirrors the
  // API's Body.UploadAttribution.{Uploader,Maker}:
  //   { id, username, avatar, hasProfileBanner, url }
  let currentUploader = null;
  let currentMaker = null;
  let currentProvider = "";
  // Credits carried by the *next* loadTTML call. Set immediately before an
  // external load so loadTTML (which is also used for imports and cached TTML)
  // can attach them without changing its signature for every caller.
  let pendingSpicyCredits = null;
  let cachedFirstRealLyricStartMs = Infinity;
  let cachedLastRealLyricEndMs = 0;
  let trackRequestSeq = 0;
  let activeTrackAbort = null;
  const lrclibCache = new Map();
  let adaptiveLayoutLastAt = 0;
  // Defaults track the Synced Lyrics settings popup so a fresh install (and the
  // host's "Reset to defaults" button) open at AJ's preferred look: big lyrics,
  // pushed up, full-strength background vocals, adaptive spacing + romanization
  // on. The popup schema in src/content/content.js mirrors these values; if you
  // change one, change both.
  //
  // These three intensity sliders multiply together and then scale a curve that
  // is already upstream-shaped, so they are a pure amplitude boost. See
  // blendSyllableAnimation. Current defaults (AJ, 2026-09-26) are 1.0 / 1.0 /
  // 1.25, i.e. scale+glow are at EXACT upstream parity (1.0 x 1.0) while the
  // vertical rise is x1.25 — deliberately, that is the one place he wants more
  // travel than Spicy Lyrics. All three at 1.0 is full parity.
  const DEFAULT_SETTINGS = {
    // 1.30 (AJ, 2026-10-07). Was 1.45 (2026-09-28); that read too big, so it is
    // back to the original 130% look. The slider ceiling stays at 600%.
    size: 1.30,
    offset: -80,
    // Scales the background line's dim and active paint values together.
    // Keep the ceiling at 1 so old over-range settings cannot flatten its
    // dim-to-bright distinction.
    bgOpacity: 1.0,
    animation: 1.0,
    syllableAnimation: 1.0,
    verticalAnimation: 1.25,
    adaptiveSpacing: true,
    romanizationEnabled: true,
    legibilityBackdrop: false,
    // Animated Apple Music cover art (m8tec HLS) — the player view's cover AND the
    // fullscreen pane. OFF by default (AJ, 2026-10-07): it is a network-backed
    // extra, so it is opt-in rather than something every fresh install starts
    // fetching. The toggle turns it on.
    animatedArt: false,
    // Scroll behaviour. smoothScrolling ON by default (AJ, 2026-10-07): he
    // prefers the eased glide into the active line. (It was flipped OFF on
    // 2026-09-28 to match an older screenshot; that is reverted.) Ignored
    // entirely while simpleLyrics is ON, which forces its own spring scroll.
    smoothScrolling: true,
    scrollLeadEnabled: false,
    scrollLeadMs: 250,
    // MV ambient backdrop brightness. Drives the baked ctx.filter in
    // drawBgFrame() — the blurred live-video canvas behind the MV in
    // fullscreen. The SLIDER lives in the Aurora Bloom add-on (ytmod-dynamic),
    // NOT here (AJ, 2026-09-28): music videos don't use Kawarp, so this is a
    // separate control from Bloom's "Brightness" (which drives Kawarp). This
    // value is the fallback used until Aurora Bloom's setting arrives — see
    // handleHostMessage(), which accepts ytmod-dynamic settings and picks out
    // just this key. Kept in sync with the catalog default (1.15).
    backdropBrightness: 1.15,
    // Force the Kawarp backdrop for EVERY music video instead of the
    // duplicated blurred-video backdrop. The toggle lives in Aurora Bloom
    // (cross-add-on); this is the fallback. Off = only still uploads
    // (Official Audio / Lyric Video) use Kawarp — see FS_STATIC_VIDEO_RE.
    // AJ, 2026-09-28.
    preferKawarpAlways: false,
    // Extend the adaptive lyric readability shade (the black gradient behind
    // the lyrics) to the SIDE layout for music videos, where the lyrics sit
    // over the blurred video backdrop — not just Video Background. ON by
    // default (AJ, 2026-09-28: "i would default it to on").
    mvLyricsShade: true,
    // Apple-Music-style rendering (schema row lives in content.js). OFF by default
    // so the existing karaoke look is unchanged until the user opts in. When ON,
    // the gradient sweep is driven by a CSS animation on a registered custom
    // property instead of per-frame JS writes — see the Simple lyrics CSS block.
    simpleLyrics: false,
    // Join syllables: paint each word as ONE whole-word fill instead of the
    // per-letter syllable karaoke, so a word lights up whole with no syllable
    // stepping (the Spicy Lyrics toggle; AJ, 2026-10-19). OFF by default so the
    // karaoke look is unchanged until opted in. Reuse: when ON, makeWord() forces
    // a plain .word instead of a letterGroup.
    joinSyllables: false,
    // Whether the whole-word join above also applies to BACKGROUND-vocal lines.
    // ON by default, which is the historical behaviour (bg lines joined too);
    // turning it off keeps per-syllable karaoke on the bg lines while the lead
    // lines stay joined (AJ, 2026-10-20). Only meaningful while joinSyllables is
    // ON — joinApplies() checks the master switch first.
    joinBgSyllables: true,
    // lrc.red TTML often ships one span per syllable ("shi" + "ning"). Merge
    // those runs into words at PARSE time so the fill/glow covers the whole
    // word. ON by default (AJ, 2026-10-20); separate from the global whole-word
    // renderer toggle above, which only changes how each word is painted.
    joinLrcRedSyllables: true,
    // Custom lyrics font. Empty = the bundled SpicyLyrics face. When set, holds a
    // CSS url() value for a user-uploaded @font-face (HTTPS/data: URLs only; an
    // http:/host-relative URL is rejected server-side and downgraded here), e.g.
    // `url(https://...) format("woff2")`. A scale multiplier on top lets a font
    // nudge bigger/smaller without touching the size slider (AJ, 2026-10-20).
    customFont: "",
    // AJ wants a newly-uploaded face to start at 200% (2026-10-20). size-adjust
    // is a percentage of the font's own advance width, so 2.0 doubles it.
    customFontScale: 2.0,
    // Which lyrics source is tried first. The resolver walks this list top to
    // bottom and stops at the first source that has the track. (The user-facing
    // reordering UI was removed — AJ, 2026-10-19 — but the value is still used
    // as the resolver fallback order.)
    sourceOrder: ["spicy", "lrc.red", "unison", "lrclib"],
  };

  // Every source id, in the canonical fallback order. Kept as a literal inside
  // the function so it cannot be read before its fragment has initialised.
  function normalizeSourceOrder(value) {
    const all = ["spicy", "lrc.red", "unison", "lrclib"];
    const seen = new Set();
    const out = [];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const id = String(entry || "");
        if (all.indexOf(id) === -1 || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }
    // Anything the user removed from the list still runs, at the end — a
    // corrupted or partial value must never silently disable a source.
    for (const id of all) if (!seen.has(id)) out.push(id);
    return out;
  }
  let currentSettings = Object.assign({}, DEFAULT_SETTINGS);

  // ---- Custom lyrics font (AJ, 2026-10-20) -----------------------------------
  // `customFont` is the src descriptor of a user-supplied @font-face (already
  // sanitised in applySettings) or "" for the bundled SpicyLyrics face.
  // `customFontScale` is baked into the @font-face as `size-adjust` so a swapped
  // font lands near the built-in's optical size without nudging the size slider.
  // The family is published through `--ym-sl-lyric-font`, which every lyric
  // font-family rule reads first and falls back to SpicyLyrics when unset.
  let appliedCustomFontKey = "";
  let customFontStyleEl = null;
  function applyCustomFont() {
    const css = currentSettings.customFont || "";
    // The size slider is PREVIEW-ONLY (AJ, 2026-10-20): the lyrics already have
    // their own Lyrics size setting, and letting the custom face carry a second
    // size-adjust made the two fight. The face is always registered at 100%.
    const key = css;
    if (key === appliedCustomFontKey) return;
    appliedCustomFontKey = key;
    if (!customFontStyleEl || !customFontStyleEl.isConnected) {
      customFontStyleEl = document.createElement("style");
      customFontStyleEl.id = "ym-sl-custom-font";
      document.head.appendChild(customFontStyleEl);
    }
    if (css) {
      // `src` MUST be a url()/local() function — a bare data:/https: token is an
      // invalid descriptor, so the browser silently drops the whole @font-face
      // and the lyrics fall back to the system font (the "apply does nothing,
      // it just goes to the Windows font" bug, AJ 2026-10-20). Escape quotes so
      // a crafted URL can never break out of the descriptor. `format()` hints
      // are optional; the browser sniffs from the URL. Registered at 100% on
      // purpose: the preview slider must NOT resize the real lyrics, which
      // already have their own Lyrics size setting.
      const srcUrl = String(css).replace(/["\\]/g, "\\$&");
      customFontStyleEl.textContent =
        '@font-face{font-family:"ym-sl-custom-font";src:url("' + srcUrl +
        '");font-display:swap;size-adjust:100%;}';
      document.documentElement.style.setProperty("--ym-sl-lyric-font", '"ym-sl-custom-font"');
    } else {
      customFontStyleEl.textContent = "";
      document.documentElement.style.removeProperty("--ym-sl-lyric-font");
    }
  }

  function applySettings(next) {
    const prevRomanization = currentSettings.romanizationEnabled;
    const prevSize = currentSettings.size;
    const prevSimpleLyrics = currentSettings.simpleLyrics;
    const prevJoinSyllables = currentSettings.joinSyllables;
    const prevAnimatedArt = currentSettings.animatedArt;
    // Only merge a plain object. `Object.assign` will happily spread a string or
    // an array by index, so a corrupted stored value would inject junk keys
    // ("0", "1", ...) into the settings object and leave it permanently out of
    // shape. Spicy Lyrics shipped a release where a bad settings entry made the
    // extension unusable until storage was cleared by hand; the clamps below
    // cover bad VALUES, this covers a bad SHAPE.
    const incoming = next && typeof next === "object" && !Array.isArray(next) ? next : {};
    currentSettings = Object.assign({}, currentSettings, incoming);
    const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const booleanValue = (value, fallback) => {
      if (value == null) return fallback;
      if (typeof value === "string") return !/^(false|0|off|no)$/i.test(value.trim());
      return Boolean(value);
    };
    currentSettings.size = clamp(finite(currentSettings.size, DEFAULT_SETTINGS.size), 0.75, 6.0);
    // Source order is a user-editable list, so it is normalised on every apply:
    // unknown ids dropped, duplicates dropped, missing sources appended.
    currentSettings.sourceOrder = normalizeSourceOrder(currentSettings.sourceOrder);
    // "Vertical position" is no longer a user setting (AJ, 2026-09-26): its slider
    // is gone and the panel simply sits at the default -80px. PINNED rather than
    // merely defaulted, because a value stored back when the slider existed would
    // otherwise keep shifting the lyrics with no UI left to move it back.
    currentSettings.offset = DEFAULT_SETTINGS.offset;
    // The CSS scales each background-line paint state by this value. An older
    // stored value above 1 must still land at the intended default brightness.
    currentSettings.bgOpacity = clamp(finite(currentSettings.bgOpacity, DEFAULT_SETTINGS.bgOpacity), 0.15, 1.0);
    currentSettings.animation = clamp(finite(currentSettings.animation, DEFAULT_SETTINGS.animation), 0, 1.25);
    currentSettings.syllableAnimation = clamp(
      finite(currentSettings.syllableAnimation, DEFAULT_SETTINGS.syllableAnimation),
      0,
      1.5
    );
    currentSettings.verticalAnimation = clamp(
      finite(currentSettings.verticalAnimation, DEFAULT_SETTINGS.verticalAnimation),
      0,
      3
    );
    currentSettings.adaptiveSpacing = booleanValue(
      currentSettings.adaptiveSpacing,
      DEFAULT_SETTINGS.adaptiveSpacing
    );
    currentSettings.romanizationEnabled = booleanValue(
      currentSettings.romanizationEnabled,
      DEFAULT_SETTINGS.romanizationEnabled
    );
    currentSettings.legibilityBackdrop = booleanValue(
      currentSettings.legibilityBackdrop,
      DEFAULT_SETTINGS.legibilityBackdrop
    );
    currentSettings.smoothScrolling = booleanValue(
      currentSettings.smoothScrolling,
      DEFAULT_SETTINGS.smoothScrolling
    );
    currentSettings.scrollLeadEnabled = booleanValue(
      currentSettings.scrollLeadEnabled,
      DEFAULT_SETTINGS.scrollLeadEnabled
    );
    currentSettings.scrollLeadMs = clamp(
      finite(currentSettings.scrollLeadMs, DEFAULT_SETTINGS.scrollLeadMs),
      0,
      800
    );
    // MV ambient backdrop brightness. The slider lives in Aurora Bloom; the
    // value arrives via handleHostMessage. Read live by drawBgFrame() every
    // frame, so no extra wiring is needed for the slider to take effect.
    currentSettings.backdropBrightness = clamp(
      finite(currentSettings.backdropBrightness, DEFAULT_SETTINGS.backdropBrightness),
      0,
      2.0
    );
    // Also from Aurora Bloom: force Kawarp for every MV. Boolean coercion
    // (handles a stored "false" string from the marketplace form).
    currentSettings.preferKawarpAlways = booleanValue(
      currentSettings.preferKawarpAlways,
      DEFAULT_SETTINGS.preferKawarpAlways
    );
    currentSettings.mvLyricsShade = booleanValue(
      currentSettings.mvLyricsShade,
      DEFAULT_SETTINGS.mvLyricsShade
    );
    currentSettings.simpleLyrics = booleanValue(
      currentSettings.simpleLyrics,
      DEFAULT_SETTINGS.simpleLyrics
    );
    currentSettings.joinSyllables = booleanValue(
      currentSettings.joinSyllables,
      DEFAULT_SETTINGS.joinSyllables
    );
    currentSettings.joinLrcRedSyllables = booleanValue(
      currentSettings.joinLrcRedSyllables,
      DEFAULT_SETTINGS.joinLrcRedSyllables
    );
    currentSettings.joinBgSyllables = booleanValue(
      currentSettings.joinBgSyllables,
      DEFAULT_SETTINGS.joinBgSyllables
    );
    // Custom lyrics font normalisation. Only a safe src survives: an https: URL or
    // a base64 data: URL whose MIME is a real font type. Anything else — a stale
    // relative path, javascript:, an SVG (which can smuggle markup) — is dropped
    // to "" so we keep the bundled SpicyLyrics face instead of a broken @font-face.
    {
      const rawFont = typeof currentSettings.customFont === "string" ? currentSettings.customFont.trim() : "";
      currentSettings.customFont =
        (/^https:\/\/\S+$/.test(rawFont) ||
          /^data:(?:font\/[\w.+-]+|application\/(?:font-[\w.+-]+|x-font-[\w.+-]+|octet-stream)|application\/vnd\.ms-fontobject);base64,[A-Za-z0-9+/=]+$/i.test(rawFont))
          ? rawFont
          : "";
      const cfsRaw = Number(currentSettings.customFontScale);
      currentSettings.customFontScale = Number.isFinite(cfsRaw)
        ? clamp(cfsRaw, 0.5, 2.0)
        : DEFAULT_SETTINGS.customFontScale;
    }
    currentSettings.animatedArt = booleanValue(
      currentSettings.animatedArt,
      DEFAULT_SETTINGS.animatedArt
    );
    // Simple lyrics is MOSTLY a curve swap: the letter-scale and Y-offset splines
    // get gentler, non-bouncing variants. Re-point them on every settings pass so
    // the toggle lands without a reload.
    applySimpleLyricsSplines();
    applyCustomFont();
    // The published kit holds a SNAPSHOT of the spline objects, and
    // applySimpleLyricsSplines REPLACES them — so a consumer (the PiP) would keep
    // the NORMAL-mode curves, which is why its Apple Music style motion kept
    // bouncing. FORCE, because publishRendererKit is otherwise one-shot and the
    // re-publish would be a silent no-op (AJ, 2026-10-07).
    try { publishRendererKit(true); } catch (e) {}
    // Reflect the MV-shade option on the overlay (no-op before fullscreen).
    syncFsMvShadeClass();
    // Animated cover art toggle, applied LIVE (AJ, 2026-10-03). OFF tears the
    // stream down immediately; ON re-runs the lookup for the current track.
    if (currentSettings.animatedArt === false) {
      if (prevAnimatedArt !== false) destroyAnimatedArt();
    } else if (prevAnimatedArt === false) {
      refreshAnimatedArt(getCurrentTrack());
    }
    document.body.classList.toggle("ym-sl-legibility-backdrop", !!currentSettings.legibilityBackdrop);
    // Simple lyrics is a RENDER MODE, not a per-element tweak, so it is a BODY
    // class — the same shape as the legibility backdrop above. A body class also
    // covers the fullscreen overlay, which reparents the panel but leaves body
    // alone, so the mode follows the lyrics into fullscreen for free.
    document.body.classList.toggle("ym-sl-simple-lyrics", !!currentSettings.simpleLyrics);
    // Simple lyrics now renders through the REAL AMLL engine (see 22-amll-integration).
    // When the mode flips, activate/deactivate it; when it stays on, just ensure it
    // is shown. On any failure the engine falls back to Aurora's glow-free Simple
    // renderer, so this can never break the lyrics view.
    if (prevSimpleLyrics !== currentSettings.simpleLyrics) {
      if (currentSettings.simpleLyrics) amllActivate();
      else amllDeactivate();
    } else if (currentSettings.simpleLyrics) {
      amllShow();
    }
    // When Simple Lyrics is switched OFF, drop the per-line depth alpha that
    // animate() injected while it was on, so normal mode's state-class alpha
    // (NotSung/Sung/Active) takes over again instead of a stale inline value.
    if (!currentSettings.simpleLyrics && prevSimpleLyrics) {
      for (const ln of modelLines) {
        if (ln.HTMLElement) {
          ln.HTMLElement.style.removeProperty("--ym-sl-line-alpha");
          ln.HTMLElement.style.removeProperty("--amll-depth-scale");
        }
      }
    }
    // Turning Smooth Scrolling off mid-glide hands the move off to the instant
    // path (upstream does the same — their $smoothScrolling listener calls
    // _handOffSmoothScroll). Stopping here means the glide cannot keep steering
    // the list after the setting that owns it is gone.
    if (!currentSettings.smoothScrolling) stopScrollGlide();
    // Publish the live scroll/motion settings so a consumer (the PiP) follows a
    // toggle IMMEDIATELY instead of waiting for the next lyrics payload. The
    // payload only re-emits on a track/lyrics change, which is exactly why
    // turning Smooth Scrolling off — or Simple Lyrics on — did nothing in the PiP
    // until the next song (AJ, 2026-10-07).
    try {
      if (window.YTMod && window.YTMod.bus) {
        window.YTMod.bus.emit("lyrics:settings", {
          smoothScrolling: currentSettings.smoothScrolling !== false,
          simpleLyrics: currentSettings.simpleLyrics === true,
          scrollLeadEnabled: currentSettings.scrollLeadEnabled === true,
          scrollLeadMs: Number(currentSettings.scrollLeadMs) || 0,
        });
      }
    } catch (e) {}
    adaptiveLayoutLastAt = 0;
    if (!currentSettings.adaptiveSpacing) resetAdaptiveSpacing();
    if (lineScrollEl) {
      lineScrollEl.style.setProperty("--ym-sl-lyrics-scale", String(currentSettings.size));
      lineScrollEl.style.setProperty("--ym-sl-lyrics-offset", `${currentSettings.offset}px`);
      lineScrollEl.style.setProperty("--ym-sl-bg-vocal-scale", String(currentSettings.bgOpacity));
    }
    // A size change reflows EVERY line, so the scroll offset that was correct for
    // the old line heights no longer points at the active line — the same "camera
    // drifted off the line" complaint as a track change or a fullscreen toggle,
    // with a fifth trigger. Re-centre after the write. recentreActiveLine() holds
    // a window open and re-pins each frame, which is what covers the reflow
    // actually landing a frame after the custom property is set.
    if (prevSize !== currentSettings.size) recentreActiveLine();
    // Romanization is computed at build time, so toggling it means rebuilding the
    // current lines. No lines yet (e.g. first init) -> nothing to do.
    if (prevRomanization !== currentSettings.romanizationEnabled && lastRendererContent) {
      buildRendererLines(lastRendererContent);
    }
    // Simple lyrics changes how the gradient is DRIVEN, and existing words hold
    // their old inline --gradient-position. The CSS redirect is !important so it
    // beats those, but an already-Sung word would then fall back to the registered
    // property's -50% default and read as un-sung until it next changed state. A
    // rebuild puts every word back through the animator under the new mode.
    if (prevSimpleLyrics !== currentSettings.simpleLyrics && lastRendererContent) {
      buildRendererLines(lastRendererContent);
    }
    // Join syllables flips makeWord between letterGroup (per-letter karaoke) and
    // plain .word (whole-word fill), so the current lines must rebuild too.
    if (prevJoinSyllables !== currentSettings.joinSyllables && lastRendererContent) {
      buildRendererLines(lastRendererContent);
    }
  }

  // NOTE: these three settings MULTIPLY, and they are applied on top of a curve
  // that is already the same shape as upstream's. So the net amplitude is
  //   scale & glow  : animation * syllableAnimation                      (max 1.5)
  //   y-offset      : animation * syllableAnimation * verticalAnimation  (max 3.0)
  // At the current defaults (1.25 / 0.9 / 1.55) that is x1.125 for scale+glow and
  // x1.744 for the vertical rise — i.e. noticeably MORE motion than upstream, not
  // less. All three at 1.0 is exact upstream parity.
  // This matters because the defaults were originally tuned AGAINST the old
  // Catmull-Rom curve, whose vertical dip was 2.23x too shallow; the spline fix
  // (2026-09-20) corrected the curve, so the slider boost now stacks on a
  // correct curve instead of compensating for a broken one.
  // resolver-worker/test-animation-parity.mjs guard D prints the live numbers.
  function blendAnimation(resting, target) {
    return resting + (target - resting) * currentSettings.animation;
  }

  function blendSyllableAnimation(resting, target) {
    const intensity = clamp(
      currentSettings.animation * currentSettings.syllableAnimation,
      0,
      1.5
    );
    return resting + (target - resting) * intensity;
  }

  function blendVerticalAnimation(resting, target) {
    const intensity = clamp(
      currentSettings.animation *
        currentSettings.syllableAnimation *
        currentSettings.verticalAnimation,
      0,
      3
    );
    return resting + (target - resting) * intensity;
  }

  const CSS = `
    .ym-sl-panel {
      position: relative !important;
      inset: auto !important;
      width: 100% !important;
      height: 100% !important;
      min-height: 0;
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      overflow: hidden;
      background: transparent !important;
      color: #fff;
      /* The panel's own chrome (credits, chips, buttons, the options overlay)
         keeps the bundled face. The custom font is scoped to .LyricsContent
         below, so it only reaches the lyric lines (AJ, 2026-10-20). */
      font-family: "SpicyLyrics", "Noto Sans Georgian", "Vazirmatn",
        "SF Pro Display", "SF Pro Text", "SF Pro", -apple-system,
        BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Arial, sans-serif;
      container-type: size;
      isolation: isolate;
    }
    /* Page-wide background styling moved to the Dynamic theme. */
    /*
    .ym-sl-page-bg-root {
      isolation: isolate !important;
      background: transparent !important;
      --ytmusic-app-background: transparent !important;
      --ytmusic-player-page-background: transparent !important;
      --ytmusic-player-bar-background: transparent !important;
      --ytmusic-nav-bar-background: transparent !important;
      --ytmusic-general-background-a: transparent !important;
      --ytmusic-general-background-b: transparent !important;
      --ytmusic-general-background-c: transparent !important;
      --ytmusic-general-background-d: transparent !important;
    }
    html.ym-sl-page-bg-active,
    body.ym-sl-page-bg-active {
      background: transparent !important;
    }
    .ym-sl-page-bg-root.ym-sl-page-bg-needs-position {
      position: relative !important;
    }
    .ym-sl-page-bg-host {
      position: fixed !important;
      inset: 0 !important;
      z-index: 0 !important;
      display: block;
      overflow: hidden;
      pointer-events: none;
      background: #0f0f0f;
    }
    .ym-sl-page-bg-host .ym-sl-kawarp-bg {
      transform: none;
      -webkit-mask-image: none;
      mask-image: none;
      filter: saturate(1.7) brightness(.78);
    }
    .ym-sl-page-bg-host .ym-sl-kawarp-bg.ready { opacity: .88; }
    .ym-sl-page-bg-host .ym-sl-kawarp-shade {
      background:
        linear-gradient(
          180deg,
          rgba(5,5,8,.28),
          rgba(5,5,8,.1) 28%,
          rgba(5,5,8,.1) 72%,
          rgba(5,5,8,.32)
        );
    }
    .ym-sl-page-divider {
      position: absolute;
      top: 84px;
      bottom: 72px;
      left: 68%;
      width: 1px;
      z-index: 2;
      background: linear-gradient(
        180deg,
        transparent,
        rgba(255,255,255,.38) 12%,
        rgba(255,255,255,.38) 88%,
        transparent
      );
      box-shadow: 0 0 8px rgba(255,255,255,.1);
      opacity: .56;
    }
    .ym-sl-page-bg-root ytmusic-app-layout,
    .ym-sl-page-bg-root ytmusic-nav-bar,
    .ym-sl-page-bg-root ytmusic-player-page,
    .ym-sl-page-bg-root ytmusic-watch-page,
    .ym-sl-page-bg-root ytmusic-player-bar,
    .ym-sl-page-bg-root ytmusic-guide-renderer,
    .ym-sl-page-bg-root ytmusic-left-nav-bar,
    .ym-sl-page-bg-root #layout,
    .ym-sl-page-bg-root #nav-bar,
    .ym-sl-page-bg-root #nav-bar-background,
    .ym-sl-page-bg-root #guide,
    .ym-sl-page-bg-root #guide-spacer,
    .ym-sl-page-bg-root #mini-guide,
    .ym-sl-page-bg-root #mini-guide-background,
    .ym-sl-page-bg-root #guide-wrapper,
    .ym-sl-page-bg-root #left-content,
    .ym-sl-page-bg-root #player-bar {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    .ym-sl-page-bg-root #player-bar-background {
      background: rgba(6,6,10,.22) !important;
      background-color: rgba(6,6,10,.22) !important;
      background-image: none !important;
      -webkit-backdrop-filter: blur(28px) saturate(1.45) brightness(.94);
      backdrop-filter: blur(28px) saturate(1.45) brightness(.94);
      border-top: 1px solid rgba(255,255,255,.1);
      box-shadow: 0 -10px 30px rgba(0,0,0,.12);
    }
    .ym-sl-page-bg-root.ym-sl-topbar-scrolled #nav-bar-background {
      background: rgba(6,6,10,.22) !important;
      background-color: rgba(6,6,10,.22) !important;
      background-image: none !important;
      -webkit-backdrop-filter: blur(28px) saturate(1.45) brightness(.94);
      backdrop-filter: blur(28px) saturate(1.45) brightness(.94);
      border-bottom: 1px solid rgba(255,255,255,.1);
      box-shadow: 0 10px 30px rgba(0,0,0,.12);
    }
    .ym-sl-page-bg-root ytmusic-nav-bar::before,
    .ym-sl-page-bg-root ytmusic-nav-bar::after,
    .ym-sl-page-bg-root ytmusic-guide-renderer::before,
    .ym-sl-page-bg-root ytmusic-guide-renderer::after,
    .ym-sl-page-bg-root ytmusic-player-bar::before,
    .ym-sl-page-bg-root ytmusic-player-bar::after {
      background: transparent !important;
    }
    .ym-sl-page-bg-root ytmusic-player-page .html5-video-container,
    .ym-sl-page-bg-root ytmusic-player-page video.html5-main-video {
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 2px;
      box-shadow:
        0 0 0 1px rgba(0,0,0,.28),
        0 18px 42px rgba(0,0,0,.38);
    }
    .ym-sl-page-bg-root.ym-sl-song-mode {
      --ym-sl-left-rail-width: 245px;
    }
    .ym-sl-page-bg-root.ym-sl-song-mode
      :is(ytmusic-guide-renderer, ytmusic-left-nav-bar, #guide-wrapper, #guide, #left-content) {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    .ym-sl-page-bg-root.ym-sl-home-mode
      :is(ytmusic-guide-renderer, ytmusic-left-nav-bar, #guide-wrapper, #guide, #left-content) {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    .ym-sl-page-bg-root.ym-sl-home-mode
      :is(
        ytmusic-browse-response,
        ytmusic-homepage,
        ytmusic-browse-page,
        ytmusic-section-list-renderer,
        ytmusic-carousel-shelf-renderer,
        ytmusic-shelf-renderer,
        ytmusic-music-shelf-renderer,
        ytmusic-grid-renderer,
        #page-manager,
        #main-panel,
        #content,
        #content-page,
        #browse-page,
        #home-page,
        #contents
      ) {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    .ym-sl-page-bg-root.ym-sl-home-mode
      :is(ytmusic-fullbleed-thumbnail-renderer, ytmusic-fullbleed-thumbnail-renderer img) {
      opacity: 0 !important;
      visibility: hidden !important;
    }
    .ym-sl-page-bg-root.ym-sl-home-mode ytmusic-browse-response > *,
    .ym-sl-page-bg-root.ym-sl-home-mode ytmusic-section-list-renderer > #contents,
    .ym-sl-page-bg-root.ym-sl-home-mode ytmusic-section-list-renderer > #contents > * {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    .ym-sl-page-bg-root.ym-sl-home-mode
      :is(
        ytmusic-browse-response,
        ytmusic-homepage,
        ytmusic-section-list-renderer,
        ytmusic-carousel-shelf-renderer,
        ytmusic-shelf-renderer,
        ytmusic-music-shelf-renderer
      )::before,
    .ym-sl-page-bg-root.ym-sl-home-mode
      :is(
        ytmusic-browse-response,
        ytmusic-homepage,
        ytmusic-section-list-renderer,
        ytmusic-carousel-shelf-renderer,
        ytmusic-shelf-renderer,
        ytmusic-music-shelf-renderer
      )::after {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    .ym-sl-page-bg-root.ym-sl-home-mode .ym-sl-kawarp-shade {
      background: rgba(5,5,8,.16);
    }
    .ym-sl-page-bg-root:not(.ym-sl-song-mode) .ym-sl-page-divider {
      display: none !important;
    }
    .ym-sl-page-bg-root.ym-sl-home-mode
      ytmusic-search-page > ytmusic-tabbed-search-results-renderer > ytmusic-tabs {
      background: rgba(6,6,10,.18) !important;
      background-color: rgba(6,6,10,.18) !important;
      background-image: none !important;
      -webkit-backdrop-filter: blur(24px) saturate(1.35);
      backdrop-filter: blur(24px) saturate(1.35);
    }
    .ym-sl-page-bg-root.ym-sl-home-mode
      ytmusic-search-page > ytmusic-tabbed-search-results-renderer > ytmusic-tabs > #tabs {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
      -webkit-backdrop-filter: none !important;
      backdrop-filter: none !important;
    }
    .ym-sl-page-bg-root.ym-sl-song-mode ytmusic-player-bar {
      left: var(--ym-sl-left-rail-width) !important;
      right: 0 !important;
      width: auto !important;
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    .ym-sl-page-bg-root.ym-sl-home-mode ytmusic-player-bar {
      left: 0 !important;
      right: 0 !important;
      width: auto !important;
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
    }
    */
    .ym-sl-native-hidden { display: none !important; }
    /* When Aurora's panel owns the Lyrics tab: hide EVERY native child of
       #tab-renderer — including ones YTM adds LATER, like the "Lyrics not
       available" message (ytmusic-message-renderer) — and drop the host's
       always-on scrollbar (overflow-y:scroll), which is redundant with the
       panel's own internal scroll. */
    #tab-renderer.ym-sl-panel-active > :not(.ym-sl-panel) {
      display: none !important;
    }
    #tab-renderer.ym-sl-panel-active {
      overflow: hidden !important;
    }
    .ym-sl-panel.hidden { display: none !important; }
    .ym-sl-panel.drag { outline: 2px dashed rgba(255,255,255,.6); outline-offset: -4px; }
    /*
    .ym-sl-kawarp-bg {
      position: absolute;
      inset: 0;
      z-index: 0;
      display: block;
      width: 100%;
      height: 100%;
      opacity: 0;
      pointer-events: none;
      transform: scaleX(1.08);
      transform-origin: center center;
      filter: saturate(1.7) brightness(.72);
      -webkit-mask-image: linear-gradient(
        90deg,
        transparent 0%,
        rgba(0,0,0,.5) 3%,
        #000 9%,
        #000 91%,
        rgba(0,0,0,.5) 97%,
        transparent 100%
      );
      mask-image: linear-gradient(
        90deg,
        transparent 0%,
        rgba(0,0,0,.5) 3%,
        #000 9%,
        #000 91%,
        rgba(0,0,0,.5) 97%,
        transparent 100%
      );
      transition: opacity .65s ease;
    }
    .ym-sl-kawarp-bg.ready { opacity: .98; }
    .ym-sl-kawarp-shade {
      position: absolute;
      inset: 0;
      z-index: 1;
      background:
        linear-gradient(
          90deg,
          rgba(5,5,8,.26) 0%,
          rgba(5,5,8,.07) 9%,
          rgba(5,5,8,.07) 91%,
          rgba(5,5,8,.26) 100%
        ),
        linear-gradient(
          180deg,
          rgba(5,5,8,.14),
          transparent 26%,
          transparent 72%,
          rgba(5,5,8,.24)
        );
      pointer-events: none;
    }
    */
    .ym-sl-tools {
      position: absolute;
      top: 2px;
      right: 14px;
      left: 14px;
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 30px;
      padding: 8px 0;
      pointer-events: auto;
      opacity: 0;
      transition: opacity .2s ease;
    }
    .ym-sl-tools:hover,
    .ym-sl-tools:focus-within { opacity: 1; }
    /* At short widths the action row behaves like YT Music's tab strip:
       controls stay in one horizontal rail and the arrows move the rail
       left/right instead of clipping Fullscreen or Offset off-screen. */
    .ym-sl-tools-scroll {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1 1 auto;
      min-width: 0;
      overflow-x: auto;
      overflow-y: hidden;
      scroll-behavior: smooth;
      scrollbar-width: none;
    }
    .ym-sl-tools-scroll::-webkit-scrollbar { display: none; }
    .ym-sl-tools-arrow {
      display: none;
      flex: 0 0 26px;
      width: 26px;
      min-height: 30px;
      padding: 0;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 7px;
      background: rgba(255,255,255,.07);
      color: rgba(255,255,255,.9);
      font: inherit;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      pointer-events: auto;
    }
    .ym-sl-tools-arrow:hover { background: rgba(255,255,255,.16); }
    /* Consolidated options overlay. Holds track / offset / import so the toolbar
       is just [Options] [Fullscreen]. Lives on <body> (see buildUI). The fullscreen
       options overlay reuses the same chrome but with a higher z-index so it
       floats above the fullscreen overlay. */
    .ym-sl-options-overlay,
    .ym-sl-fs-options-overlay {
      position: fixed;
      top: 96px;
      right: 28px;
      z-index: 2147483200;
      width: 430px;
      max-width: calc(100vw - 32px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border-radius: 20px;
      border: 1px solid rgba(255,255,255,.12);
      /* FROSTED GLASS on AJ's call (2026-10-19): a blurred translucent shell so
         the panel floats over the lyrics instead of being a solid dark slab.
         The inset top highlight still keeps a crisp top edge. */
      background: rgba(16,18,24,.55);
      -webkit-backdrop-filter: blur(24px) saturate(1.7);
      backdrop-filter: blur(24px) saturate(1.7);
      box-shadow: 0 40px 120px -40px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.15);
      color: #fff;
      /* The panel is appended to body, so inheriting gave it YTM's Roboto rather
         than the panel face. Same stack the marketplace uses. */
      font-family: "SpicyLyrics", "Roboto", "YouTube Sans", system-ui, -apple-system, sans-serif;
    }
    /* Fullscreen variant: sit above the fullscreen overlay (also 2147483000)
       and anchor to the top-right where the controls normally live. */
    .ym-sl-fs-options-overlay {
      z-index: 2147483100;
      top: 64px;
      right: 24px;
      width: 360px;
    }
    .ym-sl-options-overlay.hidden,
    .ym-sl-fs-options-overlay.hidden {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translateY(-8px) scale(.97);
    }
    /* ⭐ A closed overlay was still INTERACTIVE (AJ, 2026-10-20). visibility:hidden
       on a parent does NOT beat a child that sets visibility:visible, and
       pointer-events:none does not block a child that sets pointer-events:auto —
       and .ym-sl-options-panel.active sets BOTH. So the
       active tab's slider and toggles stayed clickable while invisible, swallowing
       hover over the lyrics underneath and changing the offset at random.
       These selectors carry the extra class specifically to out-rank .active. */
    .ym-sl-options-overlay.hidden .ym-sl-options-panel,
    .ym-sl-fs-options-overlay.hidden .ym-sl-options-panel,
    .ym-sl-options-overlay.hidden .ym-sl-options-panel.active,
    .ym-sl-fs-options-overlay.hidden .ym-sl-options-panel.active {
      visibility: hidden;
      pointer-events: none;
    }
    .ym-sl-options-overlay,
    .ym-sl-fs-options-overlay {
      opacity: 1;
      visibility: visible;
      transform: translateY(0) scale(1);
      transition:
        opacity .2s ease,
        transform .28s cubic-bezier(.22,.61,.36,1),
        visibility 0s linear 0s;
    }
    .ym-sl-options-overlay.hidden,
    .ym-sl-fs-options-overlay.hidden {
      transition:
        opacity .16s ease,
        transform .22s cubic-bezier(.4,0,1,1),
        visibility 0s linear .22s;
    }
    .ym-sl-options-header,
    .ym-sl-fs-options-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 14px 16px;
      cursor: grab;
      user-select: none;
      touch-action: none;
      background: transparent;
      border-bottom: 1px solid rgba(255,255,255,.08);
    }
    .ym-sl-options-header:active,
    .ym-sl-fs-options-header:active { cursor: grabbing; }
    .ym-sl-options-title,
    .ym-sl-fs-options-title {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -.01em;
      color: #f4f1ee;
    }
    .ym-sl-options-close,
    .ym-sl-fs-options-close {
      appearance: none;
      background: transparent;
      border: 0;
      padding: 0 4px;
      font: inherit;
      font-size: 20px;
      line-height: 1;
      color: rgba(255,255,255,.7);
      cursor: pointer;
    }
    .ym-sl-options-close:hover,
    .ym-sl-fs-options-close:hover { color: #fff; }
    .ym-sl-options-body,
    .ym-sl-fs-options-body {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 16px;
      padding: 18px;
    }
    .ym-sl-options-section,
    .ym-sl-options-body .ym-sl-options-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .ym-sl-options-body .ym-sl-video-offset {
      margin-top: 2px;
      padding-top: 4px;
      border-top: 1px solid rgba(255,255,255,.07);
    }
    /* Divider + section title separate the lyrics controls (track, offset)
       from the TTML import controls (mode, upload). */
    .ym-sl-options-divider {
      appearance: none;
      height: 1px;
      width: calc(100% + 36px);
      margin: 2px -18px 0;
      border: 0;
      background: rgba(255,255,255,.1);
    }
    .ym-sl-options-section-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: rgba(244,241,238,.6);
      padding: 4px 2px 0;
    }
    /* Grouped settings-list cards (AJ, 2026-10-19). Each concern lives in a
       frosted inset panel with a title + comfortable rows; replaces the old flat
       <hr>-separated stack. */
    .ym-sl-options-group {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px 12px 14px;
      border-radius: 14px;
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.09);
    }
    .ym-sl-options-group > .ym-sl-options-section-title {
      padding: 0;
      color: rgba(244,241,238,.5);
      font-size: 10.5px;
      letter-spacing: .09em;
    }
    .ym-sl-options-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .ym-sl-options-row-actions {
      flex-wrap: wrap;
      row-gap: 8px;
    }
    .ym-sl-options-row .ym-sl-import {
      flex: 0 0 auto;
    }
    /* Tabbed side-rail layout (AJ, 2026-10-19): vertical tab rail on the LEFT,
       the active section's controls on the RIGHT, one panel visible at a time. */
    .ym-sl-options-body.ym-sl-options-tabbed {
      flex-direction: row;
      align-items: stretch;
      gap: 0;
      padding: 0;
    }
    .ym-sl-options-rail {
      display: flex;
      flex-direction: column;
      gap: 3px;
      flex: 0 0 126px;
      width: 126px;
      padding: 12px 9px;
      border-right: 1px solid rgba(255,255,255,.08);
      background: rgba(255,255,255,.035);
    }
    .ym-sl-options-tab {
      appearance: none;
      background: transparent;
      border: 0;
      border-radius: 10px;
      padding: 9px 11px;
      text-align: left;
      font: inherit;
      font-size: 12.5px;
      line-height: 1.2;
      color: rgba(255,255,255,.62);
      cursor: pointer;
      transition: background .16s ease, color .16s ease;
    }
    .ym-sl-options-tab:hover { background: rgba(255,255,255,.07); color: #fff; }
    .ym-sl-options-tab.active {
      background: rgba(255,255,255,.13);
      color: #fff;
      font-weight: 600;
    }
    .ym-sl-options-panels {
      position: relative;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 120px;
      transition: height .34s cubic-bezier(.34,1.4,.5,1);
    }
    .ym-sl-options-panel {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 6px 18px 18px;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translateY(10px);
      transition: opacity .24s ease, transform .24s ease, visibility 0s linear .24s;
    }
    /* Incoming panel is opaque instantly — its children do the spring (staggerIn);
       the panel being left fades out via the base transition above. */
    .ym-sl-options-panel.active {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transition: opacity 0s, visibility 0s;
    }
    .ym-sl-options-panel-title {
      font-size: 15px;
      font-weight: 650;
      letter-spacing: -.01em;
      color: #f4f1ee;
      padding: 14px 0 2px;
    }
    /* Custom dropdown (AJ, 2026-10-19): styled button + popup menu instead of a
       native <select>, matching the frosted panel. */
    .ym-sl-select { position: relative; }
    .ym-sl-select-button {
      appearance: none;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 128px;
      padding: 8px 12px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,.18);
      background: rgba(255,255,255,.08);
      color: #fff;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    .ym-sl-select-button:hover { background: rgba(255,255,255,.13); }
    .ym-sl-select.open .ym-sl-select-button { border-color: rgba(255,255,255,.35); }
    .ym-sl-select-label { flex: 1 1 auto; white-space: nowrap; }
    .ym-sl-select-caret {
      flex: 0 0 auto;
      width: 0;
      height: 0;
      margin-left: auto;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 5px solid rgba(255,255,255,.6);
      transition: transform .2s ease, border-top-color .2s ease;
    }
    .ym-sl-select.open .ym-sl-select-caret {
      transform: rotate(180deg);
      border-top-color: #fff;
    }
    .ym-sl-select-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 2147483100;
      min-width: 100%;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,.14);
      background: rgba(22,24,30,.92);
      -webkit-backdrop-filter: blur(18px) saturate(1.6);
      backdrop-filter: blur(18px) saturate(1.6);
      box-shadow: 0 22px 55px -22px rgba(0,0,0,.75);
    }
    .ym-sl-select-menu.hidden { display: none; }
    .ym-sl-select-option {
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 13px;
      color: rgba(255,255,255,.82);
      cursor: pointer;
      white-space: nowrap;
    }
    .ym-sl-select-option:hover { background: rgba(255,255,255,.08); color: #fff; }
    .ym-sl-select-option.selected { background: rgba(255,255,255,.14); color: #fff; font-weight: 600; }
    /* Segmented control (pill row) — the cleaner replacement for the dropdown. */
    .ym-sl-segmented {
      display: inline-flex;
      gap: 3px;
      padding: 3px;
      border-radius: 11px;
      background: rgba(0,0,0,.28);
      border: 1px solid rgba(255,255,255,.14);
    }
    .ym-sl-segmented-option {
      appearance: none;
      background: transparent;
      border: 0;
      border-radius: 8px;
      padding: 6px 14px;
      font: inherit;
      font-size: 12.5px;
      line-height: 1.2;
      color: rgba(255,255,255,.72);
      cursor: pointer;
      transition: background .16s ease, color .16s ease;
      white-space: nowrap;
    }
    .ym-sl-segmented-option:hover { color: #fff; }
    .ym-sl-segmented-option.active {
      background: rgba(255,255,255,.92);
      color: #14161a;
      font-weight: 600;
    }
    /* File tab: full-width segmented track so each pill lines up with the action
       buttons below; Upload + Delete saved share a 2-col row at the same width. */
    .ym-sl-options-panel .ym-sl-segmented { width: 100%; }
    .ym-sl-options-panel .ym-sl-segmented-option { flex: 1 1 0; text-align: center; }
    .ym-sl-options-file-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .ym-sl-options-file-actions .ym-sl-import {
      width: 100%;
      justify-content: center;
      text-align: center;
    }
    .ym-sl-options-body .ym-sl-track { width: 100%; }
    /* The offset row is a wide horizontal rail; let it wrap and give the slider
       its own line so nothing overflows the 340px panel. */
    .ym-sl-options-body .ym-sl-video-offset { flex-wrap: wrap; row-gap: 8px; }
    .ym-sl-options-body .ym-sl-video-offset input[type="range"] { width: 100%; min-width: 0; }
    .ym-sl-options-button { white-space: nowrap; }
    /* Cache section: a short status line above the purge button. */
    .ym-sl-cache-section { gap: 10px; }
    .ym-sl-cache-status {
      font-size: 12px;
      line-height: 1.4;
      color: rgba(255,255,255,.6);
      padding: 0 2px;
    }
    .ym-sl-options-body .ym-sl-cache-clear {
      align-self: flex-start;
    }
    .ym-sl-cache-clear.hidden { display: none; }
    /* Confirmation step for "Clear cache" (AJ, 2026-10-19): a red delete action
       so the irreversible wipe is never a single accidental click. */
    .ym-sl-cache-confirm {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 11px 12px;
      border-radius: 12px;
      background: rgba(229,72,77,.10);
      border: 1px solid rgba(229,72,77,.30);
    }
    .ym-sl-cache-confirm.hidden { display: none; }
    .ym-sl-cache-confirm-text {
      font-size: 12px;
      line-height: 1.45;
      color: rgba(255,255,255,.82);
    }
    .ym-sl-cache-confirm-row {
      display: flex;
      gap: 10px;
    }
    .ym-sl-cache-delete {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 8px 14px;
      border: none;
      border-radius: 10px;
      background: #e5484d;
      color: #fff;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .ym-sl-cache-delete:hover { background: #d23b40; }
    .ym-sl-cache-delete:disabled { opacity: .55; cursor: default; }
    .ym-sl-trash-icon {
      width: 16px;
      height: 16px;
      display: block;
      fill: currentColor;
    }
    .ym-sl-cache-cancel {
      padding: 8px 14px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,.2);
      background: transparent;
      color: rgba(255,255,255,.8);
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    .ym-sl-cache-cancel:hover { background: rgba(255,255,255,.06); }
    .ym-sl-cache-cancel:disabled { opacity: .5; cursor: default; }
    .ym-sl-export-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding-top: 2px;
    }
    .ym-sl-export-actions.hidden {
      display: none;
    }
    .ym-sl-export-actions .ym-sl-import {
      flex: 1 1 140px;
      min-width: 0;
    }
    /* Fullscreen overlay is always block; media + lyrics are absolute so
       layout changes (side / background / lyrics-only) animate via CSS
       transitions instead of snapping. */
    /* ⭐ STATIC CHROME MODEL (AJ, 2026-10-20).
       The title / transport chip / scrubber used to be positioned from
       --ym-sl-fs-band-top and --ym-sl-fs-title-h, both measured in JS off the
       media pane's live rect and both transitioned over .35s. That made the
       whole stack chase the media: every aspect-ratio change, every art swap and
       every video-metadata arrival moved the anchor, so the controls drifted and
       then settled ("moves a lot, then goes back to normal", AJ 2026-10-20).
       The band vars, their @property registrations and the transition on them
       are GONE. Every chrome position is now a fixed CSS length below, identical
       on every track. Nothing measures the media to place the controls any more.
       Animations are being rebuilt from this static base. */
    .ym-sl-fs-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      display: block;
      padding: 0;
      box-sizing: border-box;
      background: #0a0a0c;
      color: #fff;
      overflow: hidden;
    }
    /* Media and lyrics are ALWAYS absolute and animate their geometry. The
       transition list covers every property that changes between layouts.
       Media gets a 3% padding in background mode; the video's inline 100%
       sizing fills the padding box, producing the rounded-card look without
       a per-layout video rule, and animating the padding smoothly resizes
       the video inside. */
    .ym-sl-fs-media,
    .ym-sl-fs-lyrics {
      position: absolute;
      top: 0;
      bottom: 0;
      overflow: hidden;
      transition:
        left .45s cubic-bezier(.22, .61, .36, 1),
        width .45s cubic-bezier(.22, .61, .36, 1),
        transform .45s cubic-bezier(.22, .61, .36, 1),
        opacity .35s ease,
        padding .45s cubic-bezier(.22, .61, .36, 1);
      will-change: left, width, transform, opacity, padding;
    }
    /* AJ 2026-10-09: on entry the layout is applied while this class is present,
       so the panes jump straight to their final geometry instead of sliding in
       from the CSS default (the "side layout" cover-art flash). buildFullscreen
       Controls drops the class via a double-rAF once the overlay has painted, so
       layout cycling on the cycle button still animates normally. */
    .ym-sl-fs-overlay.ym-sl-fs-no-anim .ym-sl-fs-media,
    .ym-sl-fs-overlay.ym-sl-fs-no-anim .ym-sl-fs-lyrics {
      transition: none;
    }
    .ym-sl-fs-media { z-index: 2; }
    .ym-sl-fs-lyrics { z-index: 3; }

    /* Legibility backdrop (Synced Lyrics setting "Legibility backdrop"): a very
       dark, slightly transparent panel with a light frost behind the lyrics so
       they stay readable over bright artwork / video. Body-level class so it
       survives renderer rebuilds. */
    .ym-sl-legibility-backdrop .LyricsContainer {
      background: rgba(0, 0, 0, 0.55);
      -webkit-backdrop-filter: blur(8px) saturate(1.1);
      backdrop-filter: blur(8px) saturate(1.1);
      border-radius: 12px;
    }
    .ym-sl-legibility-backdrop .ym-sl-fs-lyrics {
      background: rgba(0, 0, 0, 0.45);
      -webkit-backdrop-filter: blur(10px) saturate(1.1);
      backdrop-filter: blur(10px) saturate(1.1);
    }

    /* Default "side" layout: video left, lyrics right. No padding on the media
       host — padding here would push the element's padding-box past the lyrics
       panel's left edge and create a dark sliver that reads as "video under the
       lyrics". Clean position + clean width keeps the video fully inside its
       own column. */
    .ym-sl-fs-overlay .ym-sl-fs-media {
      left: 2%;
      width: 50%;
    }
    .ym-sl-fs-overlay .ym-sl-fs-lyrics {
      left: 57.4%;
      width: 42.6%;
      padding: clamp(28px, 6vh, 84px) clamp(24px, 4vw, 72px);
      box-sizing: border-box;
    }
    /* "Background" layout: media fills the overlay (3% padding = card inset
       via the video's inline padding-box sizing); lyrics float on the right
       with a backdrop blur and a left-edge fade. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-background .ym-sl-fs-media {
      left: 0;
      width: 100%;
      padding: 0;
      box-sizing: border-box;
      z-index: 1;
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-background .ym-sl-fs-media > video:not(.ym-sl-fs-art-video) {
      border-radius: 0;
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-background .ym-sl-fs-lyrics {
      left: 61%;
      width: 39%;
      min-width: 320px;
      /* Asymmetric padding so lyric text starts past the left-edge fade. */
      padding: clamp(28px, 6vh, 84px) clamp(24px, 4vw, 72px) clamp(28px, 6vh, 84px) clamp(80px, 6vw, 120px);
      box-sizing: border-box;
      /* No permanent black surface: the shade layer below activates only when
         the sampled video behind the lyrics is genuinely near-white. */
      background: transparent;
      -webkit-mask-image: linear-gradient(90deg, transparent 0, rgba(0,0,0,.5) 4%, #000 16%, #000 100%);
      mask-image: linear-gradient(90deg, transparent 0, rgba(0,0,0,.5) 4%, #000 16%, #000 100%);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
      --ym-sl-fs-lyrics-shade-opacity: 0;
      transition:
        opacity 1.1s ease,
        left .45s cubic-bezier(.22, .61, .36, 1),
        width .45s cubic-bezier(.22, .61, .36, 1),
        transform .45s cubic-bezier(.22, .61, .36, 1),
        padding .45s cubic-bezier(.22, .61, .36, 1);
    }
    .ym-sl-fs-lyrics-shade {
      display: none;
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      left: 53%;
      z-index: 2;
      pointer-events: none;
      opacity: var(--ym-sl-fs-lyrics-shade-opacity, 0);
      background: linear-gradient(
        90deg,
        transparent 0%,
        rgba(0,0,0,.16) 14%,
        rgba(0,0,0,.62) 52%,
        rgba(0,0,0,.9) 100%
      );
      -webkit-mask-image: linear-gradient(90deg, transparent 0, rgba(0,0,0,.5) 8%, #000 24%, #000 100%);
      mask-image: linear-gradient(90deg, transparent 0, rgba(0,0,0,.5) 8%, #000 24%, #000 100%);
      transition: opacity .22s ease;
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-background .ym-sl-fs-lyrics-shade {
      display: block;
      opacity: var(--ym-sl-fs-lyrics-shade-opacity, 0);
    }
    /* Opt-in: the SAME adaptive readability shade, but for a music video in
       the SIDE layout, where the lyrics column sits over the blurred video
       backdrop. Driven by the "Shade lyrics over bright music video" setting
       (-> .ym-sl-fs-mv-shade on the overlay, see syncFsMvShadeClass). No video
       means no shade, so Lyrics Only and cover-art tracks are untouched. */
    .ym-sl-fs-overlay.ym-sl-fs-mv-shade.ym-sl-fs-has-video .ym-sl-fs-lyrics-shade {
      display: block;
      opacity: var(--ym-sl-fs-lyrics-shade-opacity, 0);
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-background .ym-sl-fs-lyrics > * {
      position: relative;
      z-index: 3;
    }
    /* The readability shade is adaptive: it is transparent unless the video
       under the lyric column contains enough near-white pixels. */
    /* During a long intro or instrumental gap, dim rather than remove the
       lyrics so the video remains the visual focus. The hidden-toggle rule
       below still wins when the user explicitly hides lyrics. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-gap-dim .ym-sl-fs-lyrics {
      opacity: 0;
    }
    /* Let the user preview the hidden lyric area without fully bringing it
       back. Opacity 0 still participates in hit testing, so hovering the
       lyric panel can reveal it at a quiet 60% while the gap continues. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-gap-dim .ym-sl-fs-lyrics:hover {
      opacity: .6;
    }
    /* Intro lyrics stay completely hidden until the first real line begins,
       including on hover. Later instrumental gaps retain the 60% hover preview. */
    /* TTML credits stay visible while the lyrics auto-hide (AJ, 2026-10-01).
       The panel is no longer faded out WHOLESALE, because the credits footer lives
       INSIDE it, after the last line — fading the panel took the attribution with
       it. Instead only the LINE elements are hidden, so the credits survive.
       - visibility, not display: the renderer measures line boxes for scrolling,
         and display:none would collapse them all to zero.
       - the credits are stuck to the bottom of the scrollport, because their
         natural position is below the fold while the lines still occupy space. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-intro-dim .ym-sl-fs-lyrics,
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-intro-dim .ym-sl-fs-lyrics:hover,
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-final-dim .ym-sl-fs-lyrics,
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-final-dim .ym-sl-fs-lyrics:hover {
      opacity: 1;
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-intro-dim .VirtualLyricsContainer > *:not(.ym-sl-credits),
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-final-dim .VirtualLyricsContainer > *:not(.ym-sl-credits) {
      visibility: hidden;
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-intro-dim .ym-sl-credits,
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-final-dim .ym-sl-credits {
      position: sticky;
      bottom: 0;
    }
    /* Background-mode toggle state: the live lyrics stay mounted so timing
       continues, but the whole lyric surface fades away smoothly. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-lyrics-hidden .ym-sl-fs-lyrics {
      opacity: 0;
      pointer-events: none;
      transform: translateX(18px);
    }
    /* "Lyrics only" layout: media fades out (kept in the tree so the
       transition has a source geometry), lyrics center and widen. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-lyrics-only .ym-sl-fs-media {
      left: 0;
      width: 100%;
      padding: 0;
      opacity: 0;
      pointer-events: none;
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-lyrics-only .ym-sl-fs-lyrics {
      left: 50%;
      width: min(980px, calc(100% - 2 * 120px));
      transform: translateX(-50%);
      /* Bigger top padding reserves a band for the top caption title (see the
         lyrics-only .ym-sl-fs-title rule) so the two never overlap (AJ 2026-09-28). */
      padding: clamp(84px, 12vh, 140px) clamp(28px, 7vw, 120px);
      box-sizing: border-box;
      background: transparent;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
    /* Reserve a bottom-safe band for the centered playback row and the
       fullscreen bar. On compact screens the lyric viewport becomes slightly
       shorter instead of allowing the controls to sit over the active line. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-lyrics-only .ym-sl-fs-lyrics .LyricsContent {
      padding-bottom: clamp(148px, 18vh, 220px);
      box-sizing: border-box;
    }
    /* Backdrop layers (full-overlay absolutes). Visibility unchanged. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-background .ym-sl-fs-bg-img {
      display: none !important;
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-background .ym-sl-fs-bg-canvas {
      display: block !important;
      z-index: 0;
      /* The sharp video is the focus; this canvas is a very low-res duplicate
         of it, scaled up to fill the entire overlay as an ambient backdrop.
         The blur, saturation and brightness are baked into the canvas with
         ctx.filter in drawBgFrame() — a CSS filter here was being silently
         dropped on <canvas>, so the layer rendered crisp. Keep this set to
         none so the effect is not applied twice. */
      filter: none;
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-background .ym-sl-fs-bg-tint {
      display: block !important;
      z-index: 1;
      background: rgba(0,0,0,.18);
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-lyrics-only .LyricsContent {
      --ym-sl-lyrics-scale: 1.16;
    }
    /* The fullscreen pane deliberately has NO --DefaultLyricsSize override any
       more. It used to carry a fixed 3.5rem base, which is the same value the
       shared .LyricsContent clamp already lands on at that width -- so it was
       redundant on a big monitor and actively wrong on a small one, where a
       fixed base refused to shrink. One rule, one source of truth. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-lyrics-only .SpicyLyricsScrollContainer {
      width: 100%;
      max-width: 980px;
      margin: 0 auto;
    }
    /* Fullscreen playback controls use the same chrome as the layout controls,
       but their placement follows the selected layout. */
    /* ===== fullscreen playback chrome: floating play chip + bottom scrubber =====
       The container is a full-overlay layer (inset: 0) and the chip and
       scrubber are positioned absolutely inside it. It MUST be full size, not
       a zero-height anchor pinned to the bottom: an absolutely-positioned
       child resolves top against its containing block, so with the old
       inset: auto 0 0 0 anchor a top of 775px put the chip at y=1855, off
       the bottom of the screen (AJ: "i dont see the controls at all", 2026-09-28).
       Full size also keeps every existing bottom value resolving to the same
       pixel, since the container's bottom edge was already the overlay's.
       pointer-events stays none so the layer never blocks the lyrics; the chip
       and scrubber re-enable it for themselves. */
    .ym-sl-fs-player-controls {
      position: absolute;
      inset: 0;
      z-index: 21;
      pointer-events: none;
      /* The fade-IN of a mode change. .22s out / .32s in — a deliberate, visible
         dissolve so the controls read as "polished" rather than snapping. The out
         is a touch quicker than the in so the restructure settles while the layer
         is already near-invisible, and the reveal eases back in with the media. */
      transition: opacity .32s ease;
    }
    .ym-sl-fs-overlay.ym-sl-fs-idle .ym-sl-fs-player-controls {
      opacity: 1;
      pointer-events: none;
    }
    /* ===== chrome dissolve on a MODE CHANGE (AJ, 2026-10-21) ================
       Between cover and MV the whole control column restructures — the credit
       moves from under the artwork to under the video, the transport changes from
       a spread row to a centred one, the volume changes rows. None of that can be
       interpolated, so the column fades out, the swap happens while it is
       invisible, and it fades back in with the media.
       MV -> MV never gets this class: nothing restructures, so the chrome must
       stay perfectly still and only the media dissolves.
       MUST stay AFTER the .ym-sl-fs-idle rule above: same specificity (0,3,0), so
       source order decides — and the idle rule forces opacity 1, which is the
       state the overlay is in most of the time. */
    .ym-sl-fs-overlay.ym-sl-fs-chrome-out .ym-sl-fs-player-controls {
      opacity: 0;
      transition: opacity .22s ease;
    }
    /* Floating play chip (prev / play / next + volume), centered just above the
       scrubber.
       NO SURFACE AT ALL (AJ 2026-09-27, then 2026-09-28 x3): the border was
       removed, then the inset shadows, then the fill was cut from 7% to 2.5%
       (measured: the 7% fill read as a hard 49 -> 66 step, and
       0.93*49 + 0.07*255 = 63.6 pinned it exactly on the fill). At 2.5% the
       step is still ~8/255 against a bright backdrop, which is still visible,
       because ANY fill over a backdrop IS an edge - there is no alpha that
       shows a surface without also showing its boundary. So the fill, the
       backdrop filter and the drop shadow are all gone. The transport buttons
       keep their own circles, so the group still reads as controls; only the
       container outline disappears.
       If a surface is ever wanted back, the two options that do not draw a
       line are a radial-gradient fill that fades to zero AT the box edge
       (radial-gradient(closest-side, ...)) or a dark scrim - not a flat tint. */
    .ym-sl-fs-play-chip {
      position: absolute;
      left: 50%;
      bottom: 46px;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 10px 16px;
      border-radius: 999px;
      background: none;
      border: 0;
      box-shadow: none;
      opacity: 0;
      pointer-events: auto;
      transition: opacity .22s ease, background-color .3s ease,
        transform .35s cubic-bezier(.22,.61,.36,1);
    }
    .ym-sl-fs-overlay:hover .ym-sl-fs-play-chip,
    .ym-sl-fs-overlay:focus-within .ym-sl-fs-play-chip {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-idle .ym-sl-fs-play-chip {
      opacity: 0;
      pointer-events: none;
    }
    /* The three transport buttons as one group. Spaced 14px to match the chip's
       own gap, so wrapping them changed nothing visually — it exists so the side
       layout can centre THIS group on the title (AJ, 2026-10-01). */
    .ym-sl-fs-transport {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    /* Transient "no lyrics" notice — fullscreen Video Background only. The lyrics
       panel there stays hidden until the first line actually plays, so a track
       with no lyrics used to fail completely silently (AJ, 2026-10-01). Sits dead
       centre, non-interactive, and self-dismissing, so it can never block the
       video it is reporting on. */
    .ym-sl-fs-notice {
      position: absolute;
      /* Right-hand side, aligned with the lyrics column's own right padding so it
         reads as part of that surface rather than a floating banner, and keeps
         the middle of the video clear (AJ, 2026-10-01). */
      top: 50%;
      right: clamp(24px, 4vw, 72px);
      z-index: 5;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 13px 20px;
      border-radius: 14px;
      background: rgba(10, 11, 14, .74);
      -webkit-backdrop-filter: blur(14px) saturate(120%);
      backdrop-filter: blur(14px) saturate(120%);
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: .01em;
      /* The load-failure line is far longer than "No lyrics found.", so wrap
         instead of running off the screen. */
      max-width: min(560px, 80vw);
      line-height: 1.4;
      opacity: 0;
      pointer-events: none;
      transform: translateY(-50%) scale(.97);
      transition: opacity .3s ease, transform .3s cubic-bezier(.22, .61, .36, 1);
    }
    .ym-sl-fs-notice.show {
      opacity: 1;
      transform: translateY(-50%) scale(1);
    }
    /* Dismissal countdown. Tabular figures so the pill does not twitch as the
       digit's width changes. */
    .ym-sl-fs-notice-count {
      flex: 0 0 auto;
      min-width: 1.1em;
      text-align: right;
      font-size: 13px;
      font-weight: 700;
      color: rgba(255, 255, 255, .6);
      font-variant-numeric: tabular-nums;
    }
    @media (prefers-reduced-motion: reduce) {
      .ym-sl-fs-notice,
      .ym-sl-fs-notice.show {
        transform: translateY(-50%);
        transition: opacity .3s ease;
      }
    }
    .ym-sl-fs-options-button {
      white-space: nowrap;
    }
    /* Volume: a thin bar beside the chip (the mute button was removed) */
    .ym-sl-fs-volume-group {
      display: flex;
      align-items: center;
      gap: 8px;
      padding-left: 6px;
      padding-right: 0; /* the chip's own 16px right padding absorbs the hover grow */
      margin-left: 4px;
      border-left: 1px solid rgba(255,255,255,.16);
      /* No reserved width on the chip: the custom <div> slider expands via a
         composited transform, which never reflows the chip and leaves no gap. */
      flex: 0 0 auto;
    }
    /* Bottom scrubber: a full-width thin line pinned to the bottom edge. It is
       hidden by default and only appears while the overlay is hovered/focused,
       so the video stays clean when the pointer is away. */
    .ym-sl-fs-scrubber {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 18px;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 18px;
      pointer-events: auto;
      opacity: 0;
      transition: opacity .25s ease, background-color .3s ease;
    }
    .ym-sl-fs-overlay:hover .ym-sl-fs-scrubber,
    .ym-sl-fs-overlay:focus-within .ym-sl-fs-scrubber {
      opacity: 1;
    }
    .ym-sl-fs-time {
      flex: 0 0 auto;
      min-width: 38px;
      color: rgba(255,255,255,.82);
      /* SpicyLyrics, same family the credit and the lyrics themselves use, so the
         progress readouts are part of the composition rather than browser chrome
         (AJ, 2026-10-03). Written as longhands instead of the font shorthand:
         the shorthand RESETS font-variant-numeric, which would drop the
         tabular-nums below and make the clock twitch as the digits change.
         600 maps to the bundled LyricsSemibold face. */
      font-family: "SpicyLyrics", "Noto Sans Georgian", "Vazirmatn",
        "SF Pro Display", "SF Pro Text", "SF Pro", -apple-system,
        BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Arial, sans-serif;
      font-weight: 600;
      font-size: 11px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      letter-spacing: .02em;
      user-select: none;
      /* NO shadow (AJ, 2026-10-03): the times sit in the dark band under the
         media, so they never need one - and it read as a smudge behind the
         numerals. Spelled out as none rather than deleting the line, because
         text-shadow INHERITS and an ancestor could reintroduce it. */
      text-shadow: none;
    }
    .ym-sl-fs-time[data-time="total"] { text-align: right; }
    /* thin range track for the seek bar (volume is a custom <div> slider) */
    .ym-sl-fs-scrubber input[type="range"] {
      appearance: none;
      -webkit-appearance: none;
      height: 3px;
      margin: 0;
      border: 0;
      border-radius: 999px;
      background: transparent;
      outline: none;
      cursor: pointer;
      transition: height .18s ease;
    }
    .ym-sl-fs-scrubber .ym-sl-fs-player-seek { flex: 1 1 auto; min-width: 0; }
    /* seek fill driven by --slider-fill (percent) and --ym-sl-fs-accent. The
       accent defaults to soft white; an artwork-derived color can override it
       by setting --ym-sl-fs-accent on the overlay. */
    .ym-sl-fs-player-seek {
      --slider-fill: 0%;
      --seek-played: var(--ym-sl-fs-accent, rgba(255,255,255,.92));
      --seek-unplayed: rgba(255,255,255,.18);
    }
    .ym-sl-fs-player-seek::-webkit-slider-runnable-track {
      height: 3px;
      border-radius: 999px;
      background: linear-gradient(to right,
        var(--seek-played) 0%, var(--seek-played) var(--slider-fill),
        var(--seek-unplayed) var(--slider-fill), var(--seek-unplayed) 100%);
      box-shadow:
        inset 0 0 0 1px rgba(255,255,255,.16),
        inset 0 1px 0 rgba(255,255,255,.22);
      transition: height .18s ease;
    }
    .ym-sl-fs-player-seek::-moz-range-track { height: 3px; border-radius: 999px; background: var(--seek-unplayed); }
    .ym-sl-fs-player-seek::-moz-range-progress { height: 3px; border-radius: 999px; background: var(--seek-played); }
    .ym-sl-fs-player-seek::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 12px; height: 12px; margin-top: -4.5px;
      border: 0; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 5px rgba(0,0,0,.5);
      opacity: 0; transition: opacity .2s ease;
    }
    .ym-sl-fs-scrubber:hover .ym-sl-fs-player-seek::-webkit-slider-thumb,
    .ym-sl-fs-player-seek:focus::-webkit-slider-thumb { opacity: 1; }
    .ym-sl-fs-player-seek::-moz-range-thumb {
      width: 12px; height: 12px; border: 0; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 5px rgba(0,0,0,.5); opacity: 0;
    }
    .ym-sl-fs-scrubber:hover .ym-sl-fs-player-seek::-moz-range-thumb,
    .ym-sl-fs-player-seek:focus::-moz-range-thumb { opacity: 1; }
    /* Progress bar grows a little thicker while hovered for easier seeking. */
    .ym-sl-fs-scrubber:hover .ym-sl-fs-player-seek { height: 9px; }
    .ym-sl-fs-scrubber:hover .ym-sl-fs-player-seek::-webkit-slider-runnable-track { height: 9px; }
    .ym-sl-fs-scrubber:hover .ym-sl-fs-player-seek::-moz-range-track { height: 9px; }
    .ym-sl-fs-scrubber:hover .ym-sl-fs-player-seek::-moz-range-progress { height: 9px; }
    .ym-sl-fs-scrubber:hover .ym-sl-fs-player-seek::-webkit-slider-thumb { margin-top: -1.5px; }
    /* Slider drag state (AJ's "for tmr" note, 2026-10-03): while a slider is
       being dragged the cursor hides — an accident AJ found and liked. Scoped
       to the overlay so the rest of the page keeps its normal cursor. */
    .ym-sl-fs-overlay.ym-sl-fs-dragging,
    .ym-sl-fs-overlay.ym-sl-fs-dragging * {
      cursor: none !important;
    }
    /* Scrub time bubble: while dragging the seek bar, a small readout floats
       above the thumb showing the timestamp at that position. Absolutely
       positioned against .ym-sl-fs-player-controls (inset:0 over the overlay),
       with JS writing left/top from the live thumb ratio. */
    .ym-sl-fs-scrub-tip {
      position: absolute;
      transform: translateX(-50%);
      background: rgba(18, 18, 20, .92);
      color: #fff;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      line-height: 1;
      padding: 7px 10px;
      border-radius: 8px;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity .15s ease;
      z-index: 23;
    }
    .ym-sl-fs-scrub-tip.ym-sl-fs-scrub-tip-on { opacity: 1; }
    /* Custom <div> volume slider. The track is the hit area; the unplayed line is
       drawn with ::before, the white fill with .ym-sl-fs-volume-fill, the knob with
       .ym-sl-fs-volume-knob. On hover the track GROWS IN THICKNESS (3px -> 9px),
       the same way the seek bar does, so the two bars read as one family. The knob
       stays round and simply appears on hover/focus (no counter-scale needed). */
    .ym-sl-fs-player-volume {
      --vol-fill: 100%;
      position: relative;
      width: 150px;            /* long at rest; hover grows to 159px (stays short of pill edge) */
      height: 14px;            /* generous hit area */
      border-radius: 999px;
      cursor: pointer;
      touch-action: none;
      transform-origin: left center;
      transition: transform .28s cubic-bezier(.22,.61,.36,1);
    }
    .ym-sl-fs-player-volume::before {
      content: "";
      position: absolute;
      left: 0; right: 0; top: 50%; transform: translateY(-50%);
      height: 3px; border-radius: 999px;
      background: rgba(255,255,255,.18);
      box-shadow:
        inset 0 0 0 1px rgba(255,255,255,.16),
        inset 0 1px 0 rgba(255,255,255,.22);
      transition: height .18s ease;
    }
    .ym-sl-fs-volume-fill {
      position: absolute;
      left: 0; top: 50%; transform: translateY(-50%);
      height: 3px; width: var(--vol-fill, 100%);
      border-radius: 999px;
      background: #fff;
      box-shadow:
        inset 0 0 0 1px rgba(255,255,255,.16),
        inset 0 1px 0 rgba(255,255,255,.22);
      pointer-events: none;
      transition: height .18s ease;
    }
    .ym-sl-fs-volume-knob {
      position: absolute;
      top: 50%; left: var(--vol-fill, 100%);
      width: 12px; height: 12px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,.5);
      transform: translate(-50%, -50%);
      transform-origin: center;
      opacity: 0;
      transition: opacity .2s ease;
      pointer-events: none;
    }
    /* Grow the volume track in thickness on hover, matching the seek bar (3px -> 9px).
       The knob shows on hover and for KEYBOARD focus only (:focus-visible) — the
       plain :focus trigger is gone: pointerdown calls .focus(), which used to fade
       the knob in right as the drag hid the cursor, reading as a random circle
       animation (AJ, 2026-10-03). While a slider is being dragged the knob is
       suppressed outright: the moving fill edge is the indicator, and with the
       cursor hidden a fading-in circle reads as a glitch. */
    .ym-sl-fs-volume-group:hover .ym-sl-fs-player-volume::before,
    .ym-sl-fs-volume-group:hover .ym-sl-fs-volume-fill { height: 9px; }
    .ym-sl-fs-volume-group:hover .ym-sl-fs-volume-knob,
    .ym-sl-fs-player-volume:focus-visible .ym-sl-fs-volume-knob { opacity: 1; }
    .ym-sl-fs-overlay.ym-sl-fs-dragging .ym-sl-fs-volume-knob { opacity: 0 !important; }
    .ym-sl-fs-player-volume:focus-visible { outline: none; }
    .ym-sl-fs-player-volume:focus-visible::after {
      content: "";
      position: absolute;
      left: 0; right: 0; top: 50%; transform: translateY(-50%);
      height: 14px; border-radius: 999px;
      box-shadow: 0 0 0 2px rgba(255,255,255,.55);
    }
    /* NO SURFACE (AJ 2026-10-03): the transport buttons float on the backdrop
       without a background, border or shadow. The translucent fill was the
       last layer of chrome - removed so they read as icons, not as buttons
       with skins. The hit target keeps its circular min-width/min-height.
       Bumped up a size (34->40, play 50->56) so they sit comfortably as the
       only thing in the row. */
    .ym-sl-fs-player-controls button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      min-width: 40px;
      min-height: 40px;
      padding: 0;
      border: 0;
      /* No focus ring. Chrome draws a default focus outline on click, which
         appeared as a "circle border" behind the like/dislike buttons (AJ,
         2026-10-08). These are fullscreen transport buttons with a dedicated
         active pill, so the focus ring is redundant. */
      outline: none;
      -webkit-tap-highlight-color: transparent;
      border-radius: 50%;
      position: relative;
      background: none;
      color: rgba(255, 255, 255, .88);
      font: inherit;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      box-shadow: none;
      transition: transform .22s cubic-bezier(.34,1.56,.64,1),
        color .22s ease;
    }
    .ym-sl-fs-player-controls button:focus,
    .ym-sl-fs-player-controls button:focus-visible,
    .ym-sl-fs-player-controls button:focus-within { outline: none; }
    .ym-sl-fs-player-controls button:hover {
      transform: scale(1.08);
      background: none;
      color: #fff;
      box-shadow: none;
    }
    .ym-sl-fs-player-controls button:active { transform: scale(.92); }
    /* Prev / Next flank the play button and AJ wants them BIGGER than the
       40px shuffle/repeat pair, but still smaller than play. Play/pause is the
       primary control so it stays the largest. */
    .ym-sl-fs-player-controls .ym-sl-fs-player-prev,
    .ym-sl-fs-player-controls .ym-sl-fs-player-next {
      width: 48px;
      height: 48px;
      min-width: 48px;
      min-height: 48px;
    }
    .ym-sl-fs-player-controls .ym-sl-fs-player-play {
      width: 64px;
      height: 64px;
      min-width: 64px;
      min-height: 64px;
      font-size: 22px;
      background: none;
    }
    /* Spicy transport glyphs. Prev / Next use a 35x20 viewBox (a wide double
       triangle) and Play / Pause a narrow one, so each is sized on its own
       instead of inheriting a single font-size. pointer-events:none keeps the
       button itself the only hit target. Sizes bumped to match the larger
       hit targets. */
    .ym-sl-fs-player-controls button svg {
      width: 22px;
      height: 22px;
      display: block;
      pointer-events: none;
    }
    .ym-sl-fs-player-controls .ym-sl-fs-player-prev svg,
    .ym-sl-fs-player-controls .ym-sl-fs-player-next svg {
      width: 26px;
      height: 26px;
    }
    .ym-sl-fs-player-controls .ym-sl-fs-player-play svg {
      width: 32px;
      height: 32px;
    }
    /* Active shuffle/repeat: no fill (the buttons float), so the engaged signal
       is the full-white icon + the dot under it (see ::after below). Do NOT put
       a permanent scale here - it would make the button look hovered forever and
       swallow the click/press animation (the scale is a hover/press thing only,
       on the generic :hover / :active rules). */
    .ym-sl-fs-player-controls .ym-sl-fs-player-shuffle.active,
    .ym-sl-fs-player-controls .ym-sl-fs-player-repeat.active {
      background: none;
      color: #fff;
      box-shadow: none;
    }
    .ym-sl-fs-player-controls .ym-sl-fs-player-shuffle.active:hover,
    .ym-sl-fs-player-controls .ym-sl-fs-player-repeat.active:hover {
      background: none;
    }
    /* YTM-style "engaged" dot under the icon. With no fill on the buttons now,
       the active state was only a faint whitening of the glyph (.88 -> #fff),
       which reads as "no change". This dot is the unambiguous ON signal for
       shuffle and for repeat-all (repeat-one already carries the "1" in its
       glyph, so it needs no extra cue). The dot is always present but
       opacity-gated so it fades in/out instead of popping. */
    .ym-sl-fs-player-controls .ym-sl-fs-player-shuffle::after,
    .ym-sl-fs-player-controls .ym-sl-fs-player-repeat::after {
      content: "";
      position: absolute;
      bottom: 2px;
      left: 50%;
      transform: translateX(-50%);
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: #fff;
      opacity: 0;
      transition: opacity .2s ease;
    }
    .ym-sl-fs-player-controls .ym-sl-fs-player-shuffle.active::after,
    .ym-sl-fs-player-controls .ym-sl-fs-player-repeat.active::after {
      opacity: 1;
    }
    /* Like / Dislike are OUR OWN buttons. Inactive = outline thumb; active =
       the GLYPH itself fills (CSS fills the path) — there is NO background pill
       / circle highlight (AJ, 2026-10-08 evening: "take away the little circle
       highlight"). Container-agnostic selectors so the rule works regardless of
       which layer the button is parented to. */
    .ym-sl-fs-player-like.active,
    .ym-sl-fs-player-dislike.active {
      background: none;
      color: #fff;
      box-shadow: none;
    }
    .ym-sl-fs-player-like.active:hover,
    .ym-sl-fs-player-dislike.active:hover {
      background: none;
    }
    /* Filled glyph when engaged: CSS fill overrides the path's presentation
       fill="none", turning the outline thumb into a solid filled thumb. The
       stroke stays currentColor (set by fsThumbSvg) so the edges read cleanly. */
    .ym-sl-fs-player-like.active svg path,
    .ym-sl-fs-player-dislike.active svg path {
      fill: currentColor;
    }
    /* Edge placement: the buttons live in the CONTROLS LAYER (inset:0,
       z-index 21) so they paint ABOVE the lyrics pane (z-index 3) instead of
       being hidden behind it in side layout. JS (positionFsEdgeButtons) pins
       them to the media pane's left/right edges and to the transport row's
       vertical centre, so they sit on the same line as the controls. */
    .ym-sl-fs-player-controls .ym-sl-fs-player-like--edge,
    .ym-sl-fs-player-controls .ym-sl-fs-player-dislike--edge {
      position: absolute;
      z-index: 4;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      min-width: 44px;
      min-height: 44px;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: none;
      outline: none;
      color: rgba(255, 255, 255, .88);
      cursor: pointer;
      pointer-events: auto;
      box-shadow: none;
      -webkit-tap-highlight-color: transparent;
      transition: transform .22s cubic-bezier(.34, 1.56, .64, 1), color .22s ease;
    }
    .ym-sl-fs-player-controls .ym-sl-fs-player-like--edge:hover,
    .ym-sl-fs-player-controls .ym-sl-fs-player-dislike--edge:hover {
      transform: scale(1.08);
      color: #fff;
      background: none;
    }
    .ym-sl-fs-player-controls .ym-sl-fs-player-like--edge:active,
    .ym-sl-fs-player-controls .ym-sl-fs-player-dislike--edge:active {
      transform: scale(.92);
    }
    .ym-sl-fs-player-controls .ym-sl-fs-player-like--edge svg,
    .ym-sl-fs-player-controls .ym-sl-fs-player-dislike--edge svg {
      width: 24px;
      height: 24px;
      display: block;
      pointer-events: none;
    }
    /* Cover-art-only songs: NO rating buttons at all (AJ, 2026-10-18). The
       Apple Music stack already carries title, progress, transport and volume;
       two more edge controls read as clutter, and there is no video edge to
       anchor them to. Music videos keep them. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-player-like--edge,
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-player-dislike--edge {
      display: none;
    }
    /* Video Background layout: the video IS the backdrop, so the edge rating
       buttons would float over it with nothing to anchor to (AJ, 2026-10-19). */
    .ym-sl-fs-overlay.ym-sl-fs-mode-background .ym-sl-fs-player-like--edge,
    .ym-sl-fs-overlay.ym-sl-fs-mode-background .ym-sl-fs-player-dislike--edge {
      display: none;
    }
    /* offset rail (inside the options overlay) — keep the original look */
    .ym-sl-fs-control-offset input[type="range"] {
      appearance: none;
      -webkit-appearance: none;
      height: 6px;
      width: 104px;
      border: 0;
      border-radius: 999px;
      background: linear-gradient(90deg, rgba(255,255,255,.96) 0 var(--slider-fill, 50%), rgba(255,255,255,.18) var(--slider-fill, 50%) 100%);
      outline: none;
      accent-color: #fff;
      cursor: pointer;
      transition: none;
    }
    .ym-sl-fs-options-body .ym-sl-fs-control-offset {
      flex-wrap: wrap;
      row-gap: 8px;
    }
    .ym-sl-fs-options-body .ym-sl-fs-control-offset input[type="range"] {
      width: 100%;
      min-width: 0;
    }
    .ym-sl-fs-control-offset input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      margin-top: -4px;
      border: 2px solid rgba(255,255,255,.94);
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 5px rgba(0,0,0,.45);
    }
    .ym-sl-fs-control-offset input[type="range"]::-moz-range-thumb {
      width: 12px;
      height: 12px;
      transform: translateY(-1px);
      border: 2px solid rgba(255,255,255,.94);
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 5px rgba(0,0,0,.45);
    }
    .ym-sl-fs-controls {
      position: absolute;
      top: 18px;
      right: 18px;
      left: auto;
      bottom: auto;
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      /* No surface at all - same defect as the play chip, same fix. */
      border: 0;
      border-radius: 10px;
      background: none;
      box-shadow: none;
      opacity: 0;
      pointer-events: none;
      transform: translateY(-8px);
      transition: opacity .18s ease, background-color .3s ease,
        transform .35s cubic-bezier(.22,.61,.36,1);
    }
    .ym-sl-fs-overlay:hover .ym-sl-fs-controls,
    .ym-sl-fs-overlay:focus-within .ym-sl-fs-controls {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }
    /* Idle state: after a couple of seconds without input, hide the pointer in
       EVERY layout, and hide the hover controls in EVERY layout too (AJ,
       2026-10-02 — he originally wanted Side / Lyrics Only to keep the chrome,
       but the EXIT + LAYOUT buttons need to clear on idle there as well; they
       were the only chrome that stayed). The play chip and scrubber still stay
       put in those layouts (see the end-of-sheet block). Placed AFTER the
       :hover rule above so it wins on equal specificity. Any input clears it. */
    .ym-sl-fs-overlay.ym-sl-fs-idle,
    .ym-sl-fs-overlay.ym-sl-fs-idle * {
      cursor: none !important;
    }
    .ym-sl-fs-overlay.ym-sl-fs-idle .ym-sl-fs-controls {
      opacity: 0;
      pointer-events: none;
      transform: translateY(-8px);
    }
    /* Bright-video controls scrim (AJ, 2026-09-28 QoL). The chrome is
       surface-less by design, so over a bright / near-white music video it
       washes out completely — worst once the lyrics (and their readability
       shade) are hidden. In Video Background only, a high sampled video
       brightness adds a soft dark fill so the transport stays legible. Toggled
       from setFullscreenBrightVideo() with hysteresis; the fill is transitioned
       so crossing the threshold is not a hard pop. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-bright-video .ym-sl-fs-controls,
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-bright-video .ym-sl-fs-play-chip,
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-bright-video .ym-sl-fs-scrubber {
      background: rgba(0,0,0,.45);
    }
    /* ===== idle "fill ring" cursor indicator ==============================
       Shown in fullscreen once the pointer STOPS moving: a hollow white ring
       at the cursor that draws itself over the idle delay (a stroke-dashoffset
       tween on an SVG circle, so it reads as a ring filling — NOT a solid
       disc), then fades out and shrinks as the chrome auto-hides. An
       affordance that the cursor is about to vanish (AJ, 2026-09-28). Driven
       by resetFsIdleRing() / leaveFsIdleRing(); position via CSS vars. */
    .ym-sl-fs-idle-ring {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 30;
      width: 36px;
      height: 36px;
      margin: -18px 0 0 -18px;
      pointer-events: none;
      opacity: 0;
      transform: translate(var(--ym-sl-fs-idle-ring-x, 0px), var(--ym-sl-fs-idle-ring-y, 0px)) scale(1);
      transition: opacity .3s ease, transform .3s ease;
    }
    .ym-sl-fs-idle-ring.visible { opacity: 1; }
    .ym-sl-fs-idle-ring.leaving {
      opacity: 0;
      transform: translate(var(--ym-sl-fs-idle-ring-x, 0px), var(--ym-sl-fs-idle-ring-y, 0px)) scale(.55);
    }
    .ym-sl-fs-idle-ring-svg { display: block; width: 36px; height: 36px; }
    .ym-sl-fs-idle-ring-track {
      fill: none;
      stroke: rgba(255,255,255,.25);
      stroke-width: 2.5;
    }
    .ym-sl-fs-idle-ring-fill {
      fill: none;
      stroke: #fff;
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-dasharray: var(--ym-sl-fs-idle-ring-circ, 94.25);
      stroke-dashoffset: var(--ym-sl-fs-idle-ring-circ, 94.25);
      transform-box: fill-box;
      transform-origin: center;
      transform: rotate(-90deg);
    }
    .ym-sl-fs-idle-ring.visible .ym-sl-fs-idle-ring-fill {
      animation: ym-sl-fs-idle-ring-fill var(--ym-sl-fs-idle-ring-fill-ms, 1740ms) linear forwards;
    }
    @keyframes ym-sl-fs-idle-ring-fill {
      from { stroke-dashoffset: var(--ym-sl-fs-idle-ring-circ, 94.25); }
      to   { stroke-dashoffset: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      /* Keep the indicator (it is informative) but drop the shrink travel. */
      .ym-sl-fs-idle-ring, .ym-sl-fs-idle-ring.leaving { transition: opacity .2s ease; }
      .ym-sl-fs-idle-ring.leaving {
        transform: translate(var(--ym-sl-fs-idle-ring-x, 0px), var(--ym-sl-fs-idle-ring-y, 0px)) scale(1);
      }
    }
    .ym-sl-fs-controls button,
    .ym-sl-fs-controls select {
      min-height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      /* Borderless (AJ 2026-09-27). */
      border: 0;
      border-radius: 7px;
      background: rgba(255,255,255,.08);
      color: rgba(255,255,255,.9);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .ym-sl-fs-controls button { padding: 0 10px; }
    .ym-sl-fs-controls select {
      padding: 0 24px 0 8px;
      /* Tell Chrome to paint the native dropdown popup in dark mode; without
         this it falls back to a white panel and the option text becomes
         white-on-white / unreadable. */
      color-scheme: dark;
    }
    .ym-sl-fs-controls select option {
      /* Explicit fallback for browsers that ignore color-scheme on <option>. */
      background: #1a1a1a;
      color: #fff;
    }
    .ym-sl-fs-controls button:hover,
    .ym-sl-fs-controls select:hover { background: rgba(255,255,255,.15); }
    /* The generic fullscreen button rule has higher specificity than a plain
       class selector, so keep the hidden state equally specific. */
    /* The Hide lyrics button is always in the flex row, but collapses to zero
       width outside Video Background. This makes appearance/disappearance
       interpolate instead of snapping between display:none and inline-flex. */
    .ym-sl-fs-controls button.ym-sl-fs-lyrics-toggle {
      display: inline-flex !important;
      overflow: hidden;
      max-width: 0;
      min-width: 0;
      width: 0;
      padding-left: 0 !important;
      padding-right: 0 !important;
      border-left-width: 0;
      border-right-width: 0;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: scale(.88) translateY(4px);
      transition:
        max-width .32s cubic-bezier(.22,.61,.36,1),
        width .32s cubic-bezier(.22,.61,.36,1),
        padding .32s cubic-bezier(.22,.61,.36,1),
        border-width .32s cubic-bezier(.22,.61,.36,1),
        opacity .22s ease, visibility 0s linear .32s,
        transform .32s cubic-bezier(.22,.61,.36,1);
    }
    .ym-sl-fs-overlay.ym-sl-fs-has-video.ym-sl-fs-mode-background .ym-sl-fs-lyrics-toggle {
      max-width: 120px;
      width: auto;
      padding-left: 10px !important;
      padding-right: 10px !important;
      border-left-width: 1px;
      border-right-width: 1px;
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: scale(1) translateY(0);
      transition-delay: 0s;
    }
    /* Keep the reverse transition symmetric. The hidden state waits only for
       opacity/geometry to finish before becoming non-interactive, instead of
       instantly removing the button from layout. */
    .ym-sl-fs-controls button.ym-sl-fs-lyrics-toggle:not(:hover) {
      transition-delay: 0s;
    }
    /* ===== no-video fullscreen: icon-pill chrome =====
       Audio-only tracks get the Ableton-parity look: a pill control row of
       circular icon buttons plus a pill progress bar. Music videos keep their
       original text buttons and thin hover-only scrubber; per spec they gain
       the title and nothing else. So every control carries BOTH a text label
       and a glyph, and the variant decides which one is visible. */
    .ym-sl-fs-controls .ym-sl-fs-btn-icon { display: none; }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-controls .ym-sl-fs-btn-label {
      display: none;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-controls .ym-sl-fs-btn-icon {
      display: block;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-controls button.ym-sl-fs-icon-btn {
      width: 36px;
      height: 36px;
      min-width: 36px;
      max-width: 36px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: rgba(255,255,255,.85);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      cursor: pointer;
      transition: background .18s ease, color .18s ease, transform .18s ease;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-controls button.ym-sl-fs-icon-btn svg {
      width: 18px;
      height: 18px;
      display: block;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-controls button.ym-sl-fs-icon-btn:hover {
      background: rgba(255,255,255,.14);
      color: #fff;
      transform: scale(1.06);
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-controls button.ym-sl-fs-icon-btn:focus-visible {
      outline: 2px solid rgba(255,255,255,.7);
      outline-offset: 1px;
    }
    /* Hide-lyrics only expands in Video Background mode, which requires a live
       video. With no video it stays collapsed, sized for the round icon
       button; the music-video variant keeps its original text collapse above.
       NO BACKTICKS IN THIS COMMENT BLOCK - it sits inside a template literal. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video)
      .ym-sl-fs-controls button.ym-sl-fs-icon-btn.ym-sl-fs-lyrics-toggle {
      width: 0;
      min-width: 0;
      max-width: 0;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: scale(.88);
      /* Cancel the flex gap a zero-width child still contributes. */
      margin-left: -8px;
      transition:
        width .32s cubic-bezier(.22,.61,.36,1),
        max-width .32s cubic-bezier(.22,.61,.36,1),
        margin-left .32s cubic-bezier(.22,.61,.36,1),
        opacity .22s ease, visibility 0s linear .32s,
        transform .32s cubic-bezier(.22,.61,.36,1);
    }
    /* Pill surface for the control row, no-video only. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-controls {
      border-radius: 999px;
      padding: 6px 8px;
      gap: 2px;
    }
    /* Pill progress bar, no-video only: always visible and substantial,
       replacing the thin hover-only line the music-video variant keeps.
       Sits at the very bottom of the stack, under the transport chip. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-scrubber {
      bottom: 24px;
      left: 50%;
      right: auto;
      width: min(620px, calc(100% - 48px));
      transform: translateX(-50%);
      opacity: 1;
      gap: 10px;
      padding: 10px 16px;
      /* No surface at all - see the long note on .ym-sl-fs-play-chip: any fill
         is an edge. */
      border: 0;
      border-radius: 999px;
      background: none;
      box-shadow: none;
    }
    /* Idle auto-hide is scoped to Video Background only (AJ, 2026-09-28): the
       transport chrome stays put in Side and Lyrics Only. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-background:not(.ym-sl-fs-has-video).ym-sl-fs-idle .ym-sl-fs-scrubber {
      opacity: 0;
      pointer-events: none;
    }
    /* The MUSIC-VIDEO counterpart of the rule above (AJ, 2026-10-01). Without it
       the playbar stayed up on idle whenever the track HAS a video: the rule above
       is scoped to :not(.ym-sl-fs-has-video), and with the pointer still sitting
       inside the window the overlay's own :hover rule kept re-asserting opacity 1.
       So the transport chip faded out on the idle timer and the scrubber did not.
       Leaving the window already hid it — that drops :hover — which is why the bug
       only showed up when the mouse was parked inside the browser. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-has-video.ym-sl-fs-idle .ym-sl-fs-scrubber {
      opacity: 0;
      pointer-events: none;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-scrubber input[type="range"] {
      height: 4px;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-scrubber:hover input[type="range"] {
      height: 6px;
    }
    /* Lyrics-only: the playbar has to leave with the transport chip, not
       linger until the 2s idle timer. It inherited the no-video "always
       visible" rule above, so un-hover left it on screen while the controls
       vanished - the mismatch AJ reported (2026-09-28). Reuse the chip's
       hover/focus reveal and a matching .22s fade so they disappear together.
       Specificity ties the no-video base rule; this block is later in source
       so it wins, and the higher-specificity idle rule keeps hiding it once
       idle actually fires. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-lyrics-only .ym-sl-fs-scrubber {
      opacity: 0;
      transition: opacity .22s ease;
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-lyrics-only:hover .ym-sl-fs-scrubber,
    .ym-sl-fs-overlay.ym-sl-fs-mode-lyrics-only:focus-within .ym-sl-fs-scrubber {
      opacity: 1;
    }

    /* ===== fullscreen overlay title =====
       Both variants get a title, and in both it sits DIRECTLY UNDER the media
       (cover art / video), with the playback chrome under it. The media host
       is inset at the bottom by the mode rules further down so this band is
       always clear - the title never overlaps the artwork. */
    .ym-sl-fs-title {
      position: absolute;
      left: 50%;
      z-index: 22;
      pointer-events: none;
      display: block;
      text-align: center;
      max-width: 92%;
      color: #fff;
      /* Same family the lyrics themselves use, so the title reads as part of
         the same composition rather than as browser chrome. */
      font-family: "SpicyLyrics", "Noto Sans Georgian", "Vazirmatn",
        "SF Pro Display", "SF Pro Text", "SF Pro", -apple-system,
        BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Arial, sans-serif;
      /* NO shadow (AJ, 2026-10-03). The credit sits in the dark band UNDER the
         media - over the overlay's own backdrop, never over the video itself -
         so it does not need one, and even the tight 3px version read as a smudge
         behind the text. It had already been cut down once, from an 18px blurred
         layer that read as a dark BACKDROP on bright art (AJ's friend, 2026-09-28). */
      text-shadow: none;
      opacity: 0;
      transform: translateX(-50%) translateY(6px);
      animation: ym-sl-fs-title-in .34s cubic-bezier(.22,.61,.36,1) .08s forwards;
      /* Crossfade on a track change - see .ym-sl-fs-title-leaving below.
         NO top/bottom here (AJ, 2026-10-20): the position is static now, and
         transitioning it was what made the credit glide after the media. */
      transition: opacity .24s ease, transform .24s ease,
        font-size .35s cubic-bezier(.22,.61,.36,1),
        filter .3s ease;
    }
    .ym-sl-fs-title-artist { font-weight: 800; }
    .ym-sl-fs-title-track { font-weight: 400; opacity: .82; }
    /* Rendered empty when there is no track yet: take up no space at all. */
    .ym-sl-fs-title:empty { display: none; }
    /* Fullscreen "Next up" list, bottom-left. Native queue-row look (rounded
       thumb + bold track + dimmer artist) in the Spicy Lyrics family. */
    .ym-sl-fs-nextup {
      position: absolute;
      left: 22px;
      top: 22px;
      z-index: 22;
      display: flex;
      flex-direction: column;
      max-width: min(340px, 42vw);
      color: #fff;
      /* Hoverable: the extra tracks reveal on hover (AJ, 2026-10-03). */
      pointer-events: auto;
      opacity: 0;
      transform: translateY(-8px);
      transition: opacity .3s cubic-bezier(.22,.61,.36,1),
        transform .3s cubic-bezier(.22,.61,.36,1);
    }
    .ym-sl-fs-nextup.ym-sl-fs-nextup-in {
      opacity: 1;
      transform: translateY(0);
    }
    /* Frost panel behind the list, on HOVER only (AJ, 2026-10-03). At rest the
       list is one row and clears the artwork; unfurling it to four rows makes it
       overlap the cover art on smaller monitors, and white text over bright art
       is unreadable. So the surface appears with the unfurl.
       A PSEUDO-ELEMENT, not a background + padding on the list itself: padding
       would reflow the rows the moment the class flips, so the unfurl would jump
       before it animated. Bleeding outward (-14px / -16px) also gives the text
       real breathing room instead of hugging the panel edge.
       z-index: -1 sits behind the rows; .ym-sl-fs-nextup carries z-index 22 so it
       is its own stacking context and the -1 cannot escape behind the artwork. */
    .ym-sl-fs-nextup::before {
      content: "";
      position: absolute;
      inset: -14px -16px;
      z-index: -1;
      border-radius: 16px;
      background: rgba(10, 11, 14, .55);
      border: 1px solid rgba(255, 255, 255, .09);
      -webkit-backdrop-filter: blur(18px) saturate(130%);
      backdrop-filter: blur(18px) saturate(130%);
      opacity: 0;
      pointer-events: none;
      transition: opacity .3s cubic-bezier(.22, .61, .36, 1);
    }
    .ym-sl-fs-nextup:hover::before {
      opacity: 1;
    }
    /* Hide with the cursor (AJ, 2026-10-03). The overlay drops into
       .ym-sl-fs-idle after FS_IDLE_HIDE_MS (2s) without input - the same state
       that hides the cursor - so the list goes with it and the corner is clean.
       It rides back up to its entry offset (-8px) so leaving mirrors arriving.
       pointer-events: none matters as much as opacity: without it the list stays
       hoverable while invisible, and a pointer left resting on it would pop the
       frost back in on an empty corner. (0,3,0) beats the (0,2,0) -in rule. */
    .ym-sl-fs-overlay.ym-sl-fs-idle .ym-sl-fs-nextup {
      opacity: 0;
      transform: translateY(-8px);
      pointer-events: none;
    }
    /* Next-up rows are display-only (click-to-jump abandoned 2026-10-03): strip
       any UA chrome so they keep the box the old rows had. margin is deliberately
       NOT reset - the row rule below supplies margin-top: 10px. */
    .ym-sl-fs-nextup-row {
      -webkit-appearance: none;
      appearance: none;
      background: none;
      border: 0;
      padding: 0;
      color: inherit;
      font: inherit;
      text-align: left;
      width: 100%;
    }

    /* "See all" queue-panel CSS removed 2026-10-03 with the panel itself
       (click-to-jump was abandoned). The Next up list above is display-only. */
    .ym-sl-fs-nextup-head {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, .55);
      text-shadow: 0 1px 3px rgba(0, 0, 0, .55);
      margin-bottom: 10px;
    }
    .ym-sl-fs-nextup-row {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      margin-top: 10px;
    }
    .ym-sl-fs-nextup-thumb {
      width: 42px;
      height: 42px;
      flex: 0 0 auto;
      border-radius: 6px;
      object-fit: cover;
      background: rgba(255, 255, 255, .08);
      box-shadow: 0 1px 6px rgba(0, 0, 0, .4);
    }
    .ym-sl-fs-nextup-meta { min-width: 0; display: flex; flex-direction: column; }
    .ym-sl-fs-nextup-title {
      font-size: 15px;
      font-weight: 800;
      line-height: 1.25;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-shadow: 0 1px 3px rgba(0, 0, 0, .6);
    }
    .ym-sl-fs-nextup-artist {
      font-size: 13px;
      font-weight: 400;
      line-height: 1.3;
      color: rgba(255, 255, 255, .72);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-shadow: 0 1px 3px rgba(0, 0, 0, .6);
    }
    /* Every row AFTER the first is folded away at rest; hovering the list
       unfurls them, staggered, so only ONE track shows by default. */
    .ym-sl-fs-nextup-row ~ .ym-sl-fs-nextup-row {
      max-height: 0;
      margin-top: 0;
      opacity: 0;
      overflow: hidden;
      transform: translateY(-10px) scale(.96);
      transform-origin: top left;
      transition: max-height .34s cubic-bezier(.22,.61,.36,1),
        margin-top .34s cubic-bezier(.22,.61,.36,1),
        opacity .26s ease,
        transform .34s cubic-bezier(.22,.61,.36,1);
    }
    .ym-sl-fs-nextup:hover .ym-sl-fs-nextup-row ~ .ym-sl-fs-nextup-row {
      max-height: 64px;
      margin-top: 10px;
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    .ym-sl-fs-nextup:hover .ym-sl-fs-nextup-row ~ .ym-sl-fs-nextup-row:nth-of-type(3) {
      transition-delay: .05s;
    }
    .ym-sl-fs-nextup:hover .ym-sl-fs-nextup-row ~ .ym-sl-fs-nextup-row:nth-of-type(4) {
      transition-delay: .10s;
    }
    .ym-sl-fs-nextup:hover .ym-sl-fs-nextup-row ~ .ym-sl-fs-nextup-row:nth-of-type(5) {
      transition-delay: .15s;
    }
    /* ===== cover-art fullscreen: Apple Music-style stack ===================
       Title, then progress + time, then transport, then volume — one
       left-aligned column under the artwork, spanning its width. Scoped to
       NO-VIDEO side mode; music videos keep their own layout (AJ, 2026-10-03). */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-title {
      /* FLOW ITEM, not an overlay child (AJ, 2026-10-21). stackFsChrome() moves
         the credit INTO .ym-sl-fs-player-controls for this layout, so the block
         is one column: art -> 16px -> title -> 14px -> seek -> transport ->
         volume. That is what makes "title directly under the art, controls
         directly under the title" exact — as a separate absolutely-positioned
         element its gap to the controls depended on the column's unknown content
         height. */
      position: static;
      order: 0;
      left: auto;
      bottom: auto;
      width: auto;
      max-width: none;
      /* MUST match the 16px the column is offset from the artwork's bottom edge
         (see .ym-sl-fs-player-controls), or the two gaps read as different by a
         couple of pixels — which AJ spotted immediately (2026-10-21). */
      margin: 0 0 16px;
      text-align: left;
      /* Explicit, viewport-relative size so it scales on smaller monitors. */
      font-size: clamp(20px, 2.9vh, 36px);
      transform: translateY(6px);
      /* MUST override the base keyframe: ym-sl-fs-title-in bakes in
         translateX(-50%), which dragged the left-aligned title off-screen. */
      animation-name: ym-sl-fs-title-in-l;
    }
    /* COVER ART ONLY: pull the lyrics column in beside the artwork. The base rule
       keeps MVs at 57.4% (AJ, 2026-10-03). */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-lyrics {
      left: 44%;
      width: 54%;
    }
    /* Stacked credit: track on top (bold), artist under it (dimmer). The inner is
       authored artist-then-track, so column-REVERSE puts the track on top. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-title-inner {
      display: flex;
      flex-direction: column-reverse;
      align-items: flex-start;
      white-space: normal;
      padding-inline: 0;
      gap: 1px;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-title-track {
      font-weight: 800;
      opacity: 1;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-title-artist {
      font-weight: 500;
      opacity: .55;
      font-size: .82em;
    }
    /* Cover-art credit swap is a SCROLL-UP, not a fade: the old credit lifts out
       upward and the new one rises up into its place, so the track + artist read
       as rolling over rather than dissolving (AJ, 2026-10-03). 22px (was 6px) so
       the direction actually reads at the cover-art font size. */
    @keyframes ym-sl-fs-title-in-l {
      from { opacity: 0; transform: translateY(22px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    /* The leaving state for cover art. It MUST carry the full :not() chain PLUS
       the leaving class (0,6,0): the cover rule above sets animation-name at
       (0,5,0), so a plain .ym-sl-fs-title.ym-sl-fs-title-leaving (0,2,0) loses
       to it. That is exactly why MVs animated on a track change and cover art
       did not - MV has no cover rule to outrank (AJ, 2026-10-03).
       Ease-IN on the way out: the credit accelerates away, so the new one
       rising from below reads as one continuous roll. Duration matches
       FS_TITLE_SWAP_MS (240ms). */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-title.ym-sl-fs-title-leaving {
      animation: ym-sl-fs-title-out-l .24s cubic-bezier(.4, 0, 1, 1) forwards;
    }
    @keyframes ym-sl-fs-title-out-l {
      from { opacity: 1; transform: translateY(0); }
      to   { opacity: 0; transform: translateY(-22px); }
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-player-controls {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      /* No uniform gap: the transport chip owns the space BELOW it (see its
         margin-bottom) so it can be optically centred between the seek bar and
         the volume. The scrubber's time row sits ABOVE the chip and adds height
         on that side, so a symmetric 12px gap left the transport ~12px low
         (AJ, 2026-10-18). gap:0 + chip margin-bottom:24px keeps the same total
         stack height while equalising the two distances. */
      gap: 0;
      /* STATIC (AJ, 2026-10-20): pinned to the bottom of the overlay instead of
         being stacked off the measured band + title height. 18px matches the
         old gap to the scrubber, so the column composition is unchanged — it
         just no longer moves when the artwork changes size. */
      /* Anchored to the ARTWORK's bottom edge, not the overlay's (AJ, 2026-10-21).
         The art is 54vh tall, centred in a pane that stops 218px above the bottom
         and nudged down 4vh, so its bottom edge is at
             (100% - 218px) / 2 + 31vh
         The block then flows DOWN from 16px below it. 218px mirrors the pane's
         own bottom: 218px rule — if that changes, change it here too.
         Width/left are the art's box: min(50%, 54vh) starting at
         27% - min(25%, 27vh) (27% is the column midpoint). */
      top: calc((100% - 218px) / 2 + 31vh + 16px);
      bottom: auto;
      left: calc(27% - min(25%, 27vh));
      right: auto;
      width: min(50%, 54vh);
      height: auto;
    }
    /* order: progress+times, then the transport chip, then the volume. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-scrubber {
      order: 1;
      position: static;
      width: auto;
      transform: none;
      /* GRID, not a column: the seek spans row 1 and the two time labels sit
         left/right on row 2 (a column stacked them, which read wrong). */
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 6px 10px;
      padding: 0;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-scrubber .ym-sl-fs-player-seek {
      grid-row: 1;
      grid-column: 1 / -1;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-scrubber .ym-sl-fs-time {
      grid-row: 2;
      line-height: 1;
      font-size: clamp(12px, 1.5vh, 18px);
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-scrubber .ym-sl-fs-time:nth-of-type(1) {
      grid-column: 1;
      justify-self: start;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-scrubber .ym-sl-fs-time:nth-of-type(2) {
      grid-column: 2;
      justify-self: end;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-play-chip {
      order: 2;
      position: static;
      width: auto;
      transform: none;
      display: flex;
      justify-content: center;
      padding: 0;
      /* The whole gap below the transport. Paired with gap:0 on the stack above,
         this centres the transport between the seek bar and the volume even
         though the time row adds height on the seek side (AJ, 2026-10-18). */
      margin-bottom: 16px;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-volume-group {
      order: 3;
      margin: 0;
      padding-left: 0;
      border-left: 0;
      width: 100%;
      pointer-events: auto;
    }
    /* No hover grow on the volume bar here (AJ, 2026-10-03). */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-volume-group:hover .ym-sl-fs-player-volume,
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-player-volume {
      transform: none !important;
    }
    /* Transport spans the row: shuffle hard left, repeat hard right. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-transport {
      width: 100%;
    }
    /* Only SHUFFLE (first) and REPEAT (last) go to the edges; the skip buttons stay
       grouped around play (AJ, 2026-10-03). */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-transport > :first-child {
      margin-right: auto;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-transport > :last-child {
      margin-left: auto;
    }
    /* The volume slider must FILL the row rather than keep its 150px default. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-player-volume {
      flex: 1 1 auto;
      width: auto;
      min-width: 0;
    }
    @keyframes ym-sl-fs-title-in {
      from { opacity: 0; transform: translateX(-50%) translateY(6px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
    /* Track change: the old credit lifts and fades out, refreshFsTitle() swaps
       the text, then dropping this class re-arms the entrance animation above,
       which fades the new credit back in from opacity 0 with a small rise.
       The fade-out runs as its OWN animation instead of animation:none plus a
       transition. The entrance animation ends with a forwards fill that keeps
       forcing opacity:1, and releasing that fill in the SAME style recalc as a
       class change did NOT reliably start the opacity transition in Chrome, so
       the old credit just snapped away instead of fading (AJ: "the title
       doesn't fade out at the end of a song"). A dedicated ym-sl-fs-title-out
       animation overrides the entrance animation outright, so the fade-out
       always runs; its forwards fill holds opacity 0 until paint() drops the
       class and re-arms the entrance. */
    .ym-sl-fs-title.ym-sl-fs-title-leaving {
      animation: ym-sl-fs-title-out .24s ease forwards;
    }
    @keyframes ym-sl-fs-title-out {
      from { opacity: 1; transform: translateX(-50%) translateY(0); }
      to   { opacity: 0; transform: translateX(-50%) translateY(-8px); }
    }
    /* Long-title marquee + edge fade (2026-09-28). Long artist + title
       strings used to wrap to two lines (AJ). The inner wrapper is forced
       to one line with white-space:nowrap; the container clips and
       edge-fades when overflow is detected. The marquee is a ping-pong
       with two 3s pauses: pause at the LEFT, scroll to show the END at
       the RIGHT, pause there, scroll back to LEFT, repeat. Shift =
       -(textWidth - containerWidth) puts the END of the text right at
       the container's right edge so the right fade can take it out
       smoothly. Duration stays a flat 12s so the scroll speed scales
       naturally with how much the title overflows; AJ preferred a
       constant-pause feel (2026-09-28) over a constant-speed scroll. */
    .ym-sl-fs-title {
      overflow: hidden;
    }
    .ym-sl-fs-title.ym-sl-fs-title-overflow {
      -webkit-mask-image: linear-gradient(
        to right,
        transparent 0,
        black 32px,
        black calc(100% - 32px),
        transparent 100%
      );
      mask-image: linear-gradient(
        to right,
        transparent 0,
        black 32px,
        black calc(100% - 32px),
        transparent 100%
      );
    }
    .ym-sl-fs-title-inner {
      display: inline-block;
      white-space: nowrap;
      padding-inline: .35em;
      will-change: transform;
    }
    .ym-sl-fs-title-inner.ym-sl-fs-title-marquee {
      animation: ym-sl-fs-title-marquee 12s linear infinite;
    }
    @keyframes ym-sl-fs-title-marquee {
      0%, 25%   { transform: translateX(0); }
      50%, 75%  { transform: translateX(var(--ym-sl-fs-title-shift, 0px)); }
      100%      { transform: translateX(0); }
    }
    /* ===== fullscreen loading spinner =====================================
       Only appears when a track change runs past FS_SPINNER_DELAY_MS (2s).
       It stretches over whichever host it was placed in at show time (see
       fsSpinnerTargetHost()): the lyrics column when the lyrics are the thing
       loading, or the media pane when the VIDEO is the sole thing still
       buffering. inset: 0 fills that host, so it follows the host's geometry
       (layout mode + video aspect ratio) with no extra math. Icon is Spicy
       Lyrics' own; the spin is slowed to 1.4s from their 0.8s per AJ.
       Fades in and out via the opacity transition below. Deliberately no
       backdrop: any fill is an edge (see the play chip note), so legibility
       comes from a drop shadow instead. */
    .ym-sl-fs-spinner {
      position: absolute;
      inset: 0;
      z-index: 3;
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255,255,255,.92);
      opacity: 0;
      pointer-events: none;
      filter: drop-shadow(0 2px 10px rgba(0,0,0,.7));
      transition: opacity .4s ease-in-out;
    }
    .ym-sl-fs-spinner.visible {
      opacity: 1;
    }
    .ym-sl-fs-spinner-icon {
      display: block;
      width: 46px;
      height: 46px;
    }
    /* Only animated while visible, so a hidden spinner costs nothing. */
    .ym-sl-fs-spinner.visible .ym-sl-fs-spinner-icon {
      animation: ym-sl-fs-spin 1.4s linear infinite;
    }
    @keyframes ym-sl-fs-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    /* ===== Video Background: the title rides the chrome's reveal ==========
       In this layout the media is the full-bleed backdrop, so the title has
       nothing to sit under and used to stay on screen permanently over the
       video (found by AJ's friend, 2026-09-28). It now follows exactly the
       pattern .ym-sl-fs-controls uses: hidden at rest, fades in on
       hover/focus-within, and hides again on idle - so the hover rule comes
       first and the idle rule after it, since they carry equal specificity.
       animation:none is REQUIRED, not cosmetic: the entrance animation ends
       with a forwards fill that keeps forcing opacity 1, and an animation-origin
       value outranks a normal declaration, so without it the title would never
       hide. Side and Lyrics Only are untouched - there the title is part of the
       composition. */
    .ym-sl-fs-overlay.ym-sl-fs-mode-background .ym-sl-fs-title {
      animation: none;
      opacity: 0;
      transform: translateX(-50%) translateY(-4px);
      transition: opacity .24s ease, transform .24s ease;
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-background:hover .ym-sl-fs-title,
    .ym-sl-fs-overlay.ym-sl-fs-mode-background:focus-within .ym-sl-fs-title {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-idle .ym-sl-fs-title {
      opacity: 0;
      transform: translateX(-50%) translateY(-4px);
    }
    /* ===== bottom stack: title -> transport chip -> scrubber pill =========
       BOTH variants put the title under the media and the chrome under the
       title, and BOTH align horizontally to the media pane instead of the
       overlay centre. AJ reported the group sitting in the middle of the screen
       while the cover art was off to the left (2026-09-27) - the earlier pass
       only applied the pane alignment to the music-video branch, which is why
       the no-video case stayed centred.
       Video Background is excluded: there the media is the full-bleed backdrop
       and a centred title is correct. The title keeps its translateX(-50%)
       centring, so only the left value changes.
       The title anchors to the pane's MIDPOINT, NOT a hard 29%. 29% was the
       midpoint of the OLD pane (left: 4% + 50% / 2); the pane has since moved to
       left: 2%, and the stale anchor left the title ~2% (38px at 1920) to the
       RIGHT of the video - and of the transport, which IS centred on the pane
       (AJ, 2026-10-03: "the title is not directly under the video"). Deriving it
       from the published pane box keeps it centred for any pane width.
       The chip is deliberately NOT listed here: it anchors to the pane's own
       left/width further down (.ym-sl-fs-play-chip), which already outranked
       this rule. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-title {
      /* 27% = the midpoint of the fixed 2% / 50% media column (2 + 50/2).
         STATIC (AJ, 2026-10-20) — it used to be derived from the measured pane
         box, so it re-centred itself whenever the pane's reported width moved. */
      left: 27%;
      max-width: 50%;
    }
    /* No-video: hero title, cover art sits directly above it.
       210px clears the bottom-anchored control column (seek row + transport +
       volume, height is content-driven) and keeps the art -> title gap at ~64px.
       Tuned DOWN from 190px + a 14px column in one pass for "slightly more
       compact" (AJ, 2026-10-21): title up 20, column up 10, transport->volume
       gap 24 -> 16. These three numbers are the whole vertical rhythm. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-title {
      bottom: 210px;
      font-size: 42px;
      line-height: 1.1;
      letter-spacing: -.015em;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-play-chip {
      bottom: 74px;
    }
    /* Music video: smaller caption under the video pane. The POSITION comes from
       the flow block further down (the whole chrome is one column anchored to the
       video's bottom edge), so no bottom offset here. */
    .ym-sl-fs-overlay.ym-sl-fs-has-video .ym-sl-fs-title {
      font-size: 22px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    @media (max-height: 700px) {
      /* Same stacking ORDER as the full-size rules above (title, then chip, then
         scrubber), just compressed. The previous values were written for the old
         measured band, where the chip sat below the title by construction — kept
         as-is they overlapped once the positions became fixed (AJ, 2026-10-20). */
      .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-title {
        bottom: 176px;
        font-size: 32px;
      }
      .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-play-chip {
        bottom: 66px;
      }
      .ym-sl-fs-overlay.ym-sl-fs-has-video .ym-sl-fs-title {
        font-size: 18px;
      }
    }
    /* Lyrics-only has no media under the title, so the "hero title at the
       bottom" rules above (bottom: 160px / 150px) collide with the lyrics and
       the control band. Float it as a top caption instead. This MUST sit after
       those rules (and the max-height media query) or they win on source order.
       The lyrics' bigger top padding (see the lyrics-only .ym-sl-fs-lyrics
       rule) reserves this band, so the two never overlap (AJ 2026-09-28). */
    .ym-sl-fs-overlay.ym-sl-fs-mode-lyrics-only .ym-sl-fs-title {
      bottom: auto;
      top: clamp(20px, 3.5vh, 44px);
      font-size: clamp(17px, 2.2vh, 25px);
      line-height: 1.15;
    }
    @media (prefers-reduced-motion: reduce) {
      .ym-sl-fs-title { animation: none; opacity: 1; transition: none; }
      /* Keep the track-change swap, but make it an instant cut. */
      .ym-sl-fs-title.ym-sl-fs-title-leaving { animation: none; opacity: 0; }
      /* SAME specificity as the cover-art leaving rule (0,6,0) - without this
         that rule beats this whole media block and animates anyway. */
      .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-title.ym-sl-fs-title-leaving {
        animation: none;
        opacity: 0;
      }
    }

    .ym-sl-fs-control-offset {
      display: none;
      align-items: center;
      gap: 5px;
      color: rgba(255,255,255,.72);
      white-space: nowrap;
    }
    .ym-sl-fs-control-offset.visible { display: inline-flex; }
    .ym-sl-fs-control-offset input[type="range"] {
      width: 104px;
      accent-color: #fff;
      cursor: pointer;
      transition: none;
    }
    .ym-sl-fs-options-body .ym-sl-fs-control-offset {
      flex-wrap: wrap;
      row-gap: 8px;
    }
    .ym-sl-fs-options-body .ym-sl-fs-control-offset input[type="range"] {
      width: 100%;
      min-width: 0;
    }
    .ym-sl-fs-control-offset-value { min-width: 42px; text-align: right; font-variant-numeric: tabular-nums; }
    .ym-sl-fs-control-offset .ym-sl-offset-scope {
      background: rgba(255,255,255,.12); color: #fff; border: 0; border-radius: 6px;
      font-size: 10px; padding: 2px 4px; cursor: pointer;
    }
    .ym-sl-fs-control-offset .ym-sl-offset-number {
      width: 52px; font-size: 11px; color: #fff; background: rgba(255,255,255,.12);
      border: 0; border-radius: 6px; padding: 2px 4px;
      -moz-appearance: textfield;
    }
    .ym-sl-fs-control-offset .ym-sl-offset-scope {
      background: rgba(255,255,255,.12); color: #fff; border: 0; border-radius: 6px;
      font-size: 10px; padding: 2px 4px; cursor: pointer;
    }
    .ym-sl-fs-control-offset .ym-sl-offset-number::-webkit-outer-spin-button,
    .ym-sl-fs-control-offset .ym-sl-offset-number::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .ym-sl-fs-control-offset .ym-sl-offset-applied {
      font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: rgba(255,255,255,.5);
    }
    /* The range is useful on any track: on cover-art tracks it remains a
       harmless manual lyric timing nudge, while music videos use the same
       persisted per-track offset as the normal panel. */
    .ym-sl-fs-control-offset.force-visible { display: inline-flex; }
    .ym-sl-video-offset {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      color: rgba(255,255,255,.78);
      font-size: 11px;
      white-space: nowrap;
    }
    .ym-sl-video-offset.visible { display: inline-flex; }
    .ym-sl-video-offset input[type="range"] {
      width: 92px;
      accent-color: #fff;
      cursor: pointer;
    }
    .ym-sl-video-offset-value {
      min-width: 48px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      color: rgba(255,255,255,.66);
    }
    .ym-sl-video-offset .ym-sl-offset-scope {
      background: rgba(255,255,255,.1); color: #fff; border: 0; border-radius: 6px;
      font-size: 10px; padding: 2px 4px; cursor: pointer;
    }
    .ym-sl-video-offset .ym-sl-offset-number {
      width: 52px; font-size: 11px; color: #fff; background: rgba(255,255,255,.1);
      border: 0; border-radius: 6px; padding: 2px 4px;
      -moz-appearance: textfield;
    }
    .ym-sl-video-offset .ym-sl-offset-number::-webkit-outer-spin-button,
    .ym-sl-video-offset .ym-sl-offset-number::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .ym-sl-video-offset .ym-sl-offset-applied {
      font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: rgba(255,255,255,.45);
    }
    /* Fullscreen view: YTM's real <video> on the left, the live lyrics panel on
       the right. Nothing is re-created — both are the existing live elements, so
       playback, timing and scroll state all keep working. No artwork fetching,
       no blurred backdrop, and no extension controls in this view. */
    /* Geometry comes from the mode rules (.ym-sl-fs-mode-* / default "side")
       higher up; only the visual treatment and overflow are pinned here. */
    .ym-sl-fs-media {
      position: absolute;
      display: block;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      background: transparent !important;
    }
    /* NOTE: the animated cover-art <video> (ym-sl-fs-art-video) is EXCLUDED via
       :not() — this rule's !important width/height/inset fill would otherwise
       beat the cover-card sizing rules no matter their specificity, and the
       animated cover rendered at the full pane size (960x862, AJ, 2026-10-03). */
    .ym-sl-fs-media > video:not(.ym-sl-fs-art-video) {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      margin: 0 !important;
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      max-height: none !important;
      /* Fill the media pane edge-to-edge so the 16:9 video never leaves the
         two horizontal black bars AJ reported (2026-09-27). The video is
         cropped instead of letterboxed - matches what Ableton / Spicy do for
         their fullscreen MV pane, and the host already has rounded corners
         so the cropped edges look intentional rather than truncated. */
      object-fit: cover !important;
      border-radius: 14px;
      background: transparent;
      /* No drop shadow: .ym-sl-fs-media has overflow:hidden and the pane's
         bottom edge IS the video's bottom edge, so the shadow was cut off dead
         straight under the media (AJ, 2026-09-28). The blurred ambient backdrop
         already separates the frame from its surroundings. */
      box-shadow: none;
    }
    .ym-sl-fs-overlay.ym-sl-fs-has-video .ym-sl-fs-media > video {
      /* Restore the pre-letterbox presentation. */
      background: transparent;
    }
    /* Music videos: rounding only; column geometry comes from the layout mode. */
    .ym-sl-fs-overlay.ym-sl-fs-has-video .ym-sl-fs-media {
      border-radius: 14px;
    }
    /* Smooth fade when the backdrop swaps between cover-art and the live video
       mid-fullscreen. syncFsVideoMode toggles fsMediaHost opacity around the
       swap so the transition (cover art fading out / new backdrop fading in)
       replaces the snap AJ reported (2026-09-16). */
    .ym-sl-fs-media {
      transition: opacity .25s ease;
    }
    /* ===== track-change dissolve (AJ, 2026-10-21) ==========================
       ⭐ Fading ONLY .ym-sl-fs-media was invisible for music videos. The ambient
       backdrop behind it (Kawarp / the blurred-video canvas) is a blurred copy of
       the SAME frame, so dropping the sharp layer to opacity 0 just revealed a
       blurry version of itself — it read as "music videos don't fade at all".
       The backdrop fades WITH the media now, so the pane genuinely goes dark
       between tracks and the incoming one fades up into place.
       This is a class, not an inline opacity, on purpose: the OUT is .22s, while
       the IN falls back to each element's own transition (media .25s, Kawarp
       .6s), which is exactly the asymmetry we want and cannot express with a
       single inline value. */
    .ym-sl-fs-overlay.ym-sl-fs-dissolving .ym-sl-fs-media,
    .ym-sl-fs-overlay.ym-sl-fs-dissolving .ym-sl-fs-kawarp,
    .ym-sl-fs-overlay.ym-sl-fs-dissolving .ym-sl-fs-bg-canvas,
    .ym-sl-fs-overlay.ym-sl-fs-dissolving .ym-sl-fs-bg-img {
      opacity: 0;
      transition: opacity .22s ease;
    }
    /* Music videos: the hero on the left is the unblurred live video (the
       clone behind supplies the blurred light). Remove any softening filter
       so the left video stays crisp. */
    .ym-sl-fs-overlay.ym-sl-fs-has-video .ym-sl-fs-media > video {
      filter: none;
    }
    /* Music videos: give the left column more room so the unblurred hero is
       visually prominent instead of feeling offset inside a narrow slice.
       (Dead code now that the overlay is display:block — left here as a
       no-op anchor in case we ever reintroduce a grid track for side mode.)
       Grid-template-columns rule removed. */
    /* Cover art: a centered square card sized off the viewport height so it
       never dwarfs the lyrics column. The blurred backdrop fills the space
       around it, so there are no black bars. Reduced 70vh -> 50vh: the cover
       read too large beside the lyrics (AJ, 2026-10-03). Music videos are a
       <video>, and this <img> is only created for cover-art tracks, so MVs are
       untouched by this rule. */
    /* Two cover arts for the first second of fullscreen (AJ, 2026-10-20). The
       static card is shown while the animated art loads — deliberately, so the
       pane is never blank — and the card is only REMOVED once the video has been
       attached, which is what left both visible at once. Hide the card the moment
       a READY art video exists in the pane, so it crossfades instead of
       double-exposing. :has() keeps this pure CSS: no extra JS timing to desync. */
    .ym-sl-fs-media:has(> video.ym-sl-fs-art-video.ym-sl-fs-art-video-ready) > img {
      opacity: 0;
      transition: opacity .3s ease;
    }
    .ym-sl-fs-media > img,
    .ym-sl-fs-media > video.ym-sl-fs-art-video {
      display: block;
      width: min(100%, 54vh);
      height: auto;
      max-width: 100%;
      max-height: 54vh;
      aspect-ratio: 1 / 1;
      /* Nudge the centred cover very slightly DOWN: the pane it centres in stops
         short of the overlay bottom (the 218px title/controls band), so pure
         centring reads a touch high (AJ, 2026-10-03). */
      transform: translateY(4vh);
      object-fit: cover;
      border-radius: 16px;
      background: #000;
      /* No drop shadow, same reason as the video: the pane has overflow:hidden
         and the cover is bottom-aligned in it, so the shadow was sliced off
         immediately below the artwork (AJ, 2026-09-28). */
      box-shadow: none;
    }
    /* In side mode, center the square cover in the media column without
       stretching it to the full column height. The old height:100% override
       made the square's contain box span the entire screen, creating huge
       black bars above and below the artwork. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-media {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-media > img,
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-media > video.ym-sl-fs-art-video {
      /* MORE specific than the base .ym-sl-fs-media > img rule, so in side mode
         THIS is what actually sizes the cover art — keep it in step with the
         base (AJ, 2026-10-03). */
      width: min(100%, 54vh);
      max-height: 54vh;
      flex: 0 1 auto;
    }
    /* Animated cover only: INTEGER-pixel sizing. A fractional box (54vh =
       583.2px -> 583.188 after layout) makes the video's composited layer snap
       short of the element's far edges, so the #000 background peeked out as a
       thin line along the bottom + right only (origin-anchored top/left never
       show it; static <img> paints its own box and is immune). Rounding the
       box down to whole pixels removes the gap. Must sit AFTER the side-mode
       sizing rule above and match its specificity to win (AJ, 2026-10-03). */
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-media > video.ym-sl-fs-art-video {
      width: round(down, min(100%, 54vh), 1px);
    }
    /* ===== bottom band: reserve room for the title + playback chrome ======
       AJ's spec (2026-09-27): everything lives UNDER the media, so the media
       pane stops short of the overlay bottom and the title/controls occupy
       the band that is left. Scoped to side mode only - in Video Background
       the video IS the backdrop and must stay full-bleed, and Lyrics Only has
       no media at all. The media host transition does not list bottom, so
       this inset snaps between layouts rather than animating; that is
       deliberate (animating a host that carries JS-measured media is what
       produced the stale-size black bars noted in the project memory). */
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-media {
      bottom: 218px;
    }
    /* Music video: size the pane to the video's OWN aspect ratio, and centre it
       on the viewport's vertical middle.
       ASPECT: the pane used to be 50% wide but nearly full height (AR ~1.2)
       while the video is 1.78, so object-fit: cover cropped the sides and
       contain left letterbox bars - AJ hit both, one round apart. Matching the
       ratios makes cover a no-op: full frame AND filled pane. The var comes
       from the real videoWidth/videoHeight in drawBgFrame(); 16/9 is the
       fallback for the frames before metadata arrives.
       POSITION: centred on 50% - the pane's height is width/AR, so a 16:9 video
       in a 50%-wide column is only 540px tall. Bottom-pinning it left a 340px
       void above (AJ: "too low"); centring on the band midpoint instead put it
       100px above the screen's middle (AJ: "a little too high"). Dead centre
       is what he wants. Measured clearance: the title's top edge sits at
       y=904, and a 16:9 pane centred at 540 ends at 810, so there is 94px of
       air; a 4:3 pane ends at 900 and just clears it.
       max-height keeps a very tall / vertical video from covering the whole
       screen and the band; it is a no-op for anything wider than ~1.09.
       Nothing else writes transform on this host (only opacity does), so the
       translateY cannot collide with the layout-switch animation. */
    .ym-sl-fs-overlay.ym-sl-fs-has-video:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-media {
      top: 50%;
      bottom: auto;
      height: auto;
      transform: translateY(-50%);
      aspect-ratio: var(--ym-sl-fs-video-ar, 16 / 9);
      max-height: calc(100% - 200px);
    }
    /* Cover art must shrink into the shortened pane instead of overflowing
       the band. aspect-ratio keeps it square; max-height:100% clamps it. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-media > img,
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-media > video.ym-sl-fs-art-video {
      max-height: 100%;
    }
    /* CENTRE the cover inside the shortened pane. The title / controls are at
       fixed offsets from the overlay bottom (AJ, 2026-10-20), so they no longer
       follow the art's bottom edge. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-media {
      align-items: center;
    }
    /* Both variants: the scrubber spans the MEDIA COLUMN, not the overlay centre,
       so it sits exactly under the cover art / video. STATIC (AJ, 2026-10-20):
       the column is a fixed 2% / 50% box, so the bar reads those numbers directly
       instead of the measured pane rect. box-sizing MUST be border-box: this rule
       is content-box by default, so the base padding of 0 18px used to ADD 36px
       and push the bar 36px past the video's right edge. transform must be reset
       because the no-video pill base centres itself with translateX(-50%), which
       would drag a column-anchored bar off the column. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-scrubber {
      left: 2%;
      right: auto;
      width: 50%;
      box-sizing: border-box;
      transform: none;
      bottom: auto;
      /* NO side padding: the base rule's 0 18px inset the row from the video's
         edges by 18px each side, so the seek bar never lined up with the pane
         (AJ, 2026-10-21: "same length as the video"). The row now spans the pane
         exactly and the time labels sit flush against its edges. */
      padding: 0;
    }

    /* ===== MV side layout: ONE flow under the video (AJ, 2026-10-21) ========
       Credit, transport and scrubber are a single flex column starting 20px below
       the VIDEO's bottom edge, not the viewport's. The pane is 50% wide, centred,
       and aspect-ratio'd, so its bottom edge is
           50% + 25vw / var(--ym-sl-fs-video-ratio)
       That is why the ratio is published as a NUMBER: CSS can divide by a number
       but not by a "1920 / 960" token. Anchoring to the viewport instead is what
       made the gap under the video change with its shape.
       LIMIT: max-height clamps very tall videos, so for those the real bottom
       edge is higher than this formula and the gap grows. */
    .ym-sl-fs-overlay.ym-sl-fs-has-video:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-player-controls {
      display: flex;
      flex-direction: column;
      /* STRETCH, not center, and the column IS the media column (2% / 50%). A
         full-width column with align-items:center centred the transport and the
         scrubber on the SCREEN while the title sat under the video — two
         different axes (AJ, 2026-10-21). */
      align-items: stretch;
      justify-content: flex-start;
      top: calc(50% + 25vw / var(--ym-sl-fs-video-ratio, 1.7777778) + 20px);
      bottom: auto;
      left: 2%;
      right: auto;
      width: 50%;
      height: auto;
    }
    .ym-sl-fs-overlay.ym-sl-fs-has-video:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-title {
      position: static;
      order: 0;
      left: auto;
      bottom: auto;
      width: auto;
      max-width: none;
      /* 20px, matching the column's 20px offset from the video's bottom edge. It
         looked BIGGER than the top gap because the chip below carried 10px of
         vertical padding, which added to the space without appearing in either
         number — the chip's padding is 0 now, so both gaps are honestly 20px. */
      margin: 0 0 20px;
      text-align: center;
      transform: none;
      /* ⭐ MUST swap the KEYFRAMES, not just the property. The base entrance
         animation bakes translateX(-50%) into every frame and ends with a
         forwards fill, so it keeps forcing the shift forever and outranks a
         plain transform: none — that is why the caption sat 480px to the left
         (measured: box x -442 with translateX(-480), AJ 2026-10-21). The -l
         variant is the same rise without the translate. */
      animation-name: ym-sl-fs-title-in-l;
    }
    /* Same for the leave animation, which also carries translateX(-50%). */
    .ym-sl-fs-overlay.ym-sl-fs-has-video:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-title.ym-sl-fs-title-leaving {
      animation: ym-sl-fs-title-out-l .24s cubic-bezier(.4, 0, 1, 1) forwards;
    }
    .ym-sl-fs-overlay.ym-sl-fs-has-video:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-play-chip {
      position: static;
      order: 1;
      left: auto;
      bottom: auto;
      width: auto;
      margin: 0 0 16px;
      transform: none;
      /* No vertical padding: it added 10px to the gap ABOVE the transport (which
         is what made that gap read wider than the one under the video) and
         inflated the row the edge buttons centre on. The buttons carry their own
         hit area. */
      padding: 0;
    }
    .ym-sl-fs-overlay.ym-sl-fs-has-video:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-scrubber {
      position: static;
      order: 2;
      left: auto;
      right: auto;
      bottom: auto;
      width: auto;
      margin: 0;
      transform: none;
      padding: 0;
    }
    /* The SEPARATOR sits dead under the title (AJ, 2026-10-01). The chip spans the
       pane and lays out as 1fr / auto / 1fr: the transport is pushed to the END of
       the left column and the volume to the START of the right one, so whatever
       either side weighs, the middle column — the divider — lands on the chip's
       midpoint, which is the pane's midpoint, which is the title's.
       The divider is the chip's own ::after rather than the volume group's
       border-left, because it has to be its own grid item to hold that column.
       Equal 14px gutters keep it centred IN the gap instead of hugging either side.
       minmax(0, 1fr) not plain 1fr: a plain 1fr keeps an auto minimum, so a wide
       volume would widen its own column and drag the divider off centre. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-play-chip {
      left: 2%;
      width: 50%;
      max-width: none;
      transform: none;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: center;
      gap: 0;
      padding: 10px 0;
    }
    /* TRANSPORT CENTRED ON THE PANE, VOLUME ON THE SCRUBBER ROW (AJ, 2026-10-01).
       Shuffle and Repeat made the transport five buttons wide — wide enough that
       centring the chip AS A UNIT left the transport visibly left of the title. So
       the middle column carries the transport, and the volume left the chip
       entirely: it now sits on the scrubber row, after the total time. The seek
       range is the flex child that gives up the room, so bar + volume still span
       the media pane together — which is exactly what AJ asked for.
       Every item is pinned to grid-row 1 EXPLICITLY: auto-placement walks items in
       SOURCE order with a cursor that only moves forward, so an item whose column
       sits BEHIND the cursor gets pushed onto the next row. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-transport {
      grid-row: 1;
      grid-column: 2;
      justify-self: center;
    }
    /* A plain flex child of .ym-sl-fs-scrubber now, so it needs no grid placement —
       only the divider separating it from the total time beside it. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-volume-group {
      margin-left: 0;
      padding-left: 14px;
      /* The 1px divider is removed too (AJ 2026-10-03) so the volume sits flush
         against the scrubber row without a line of chrome between them. */
      border-left: 0;
    }

    /* Self-contained blurred backdrop. We render our own (rather than
       reparenting dynamic.js's Kawarp node) because dynamic.js's rootObserver
       actively yanks pageBgHost back to pageBgRoot, stealing it from the overlay
       within a frame. For music videos, a muted clone of the live video plays
       blurred in the background AND the original plays unblurred on the left,
       so the music video actually lights up the background with live motion. */
    .ym-sl-fs-bg-img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform: scale(1.06);
      will-change: transform, filter;
      z-index: 0;
    }
    /* Cover art: brighter than before so the blurred album art reads as a
       proper background, not a near-black veil. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-bg-img {
      filter: blur(30px) saturate(1.75) brightness(.78);
    }
    /* Music videos: hide the static artwork backdrop because the live video
       itself fills the fullscreen media layer. */
    .ym-sl-fs-overlay.ym-sl-fs-has-video .ym-sl-fs-bg-img {
      display: none;
    }
    /* Kawarp WebGL backdrop for song fullscreen. Sits behind everything at
       z-index 0; when it owns the backdrop the static blurred cover is hidden.
       The .ready class fades it in once the module + image have loaded. */
    .ym-sl-fs-kawarp {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      z-index: 0;
      pointer-events: none;
      opacity: 0;
      transform: scale(1.06);
      transition: opacity .6s ease;
    }
    .ym-sl-fs-kawarp.ready { opacity: 1; }
    .ym-sl-fs-overlay.ym-sl-fs-has-kawarp .ym-sl-fs-bg-img { display: none; }
    /* Music videos normally use the blurred-video canvas, but a still upload
       (Official Audio / Lyric Video) hands the backdrop to Kawarp instead. The
       canvas has to be hidden too: both sit at z-index 0 and the canvas comes
       LATER in DOM order, so it would paint straight over Kawarp. Keeping the
       element (rather than removing it) means the draw loop keeps running,
       which is what publishes --ym-sl-fs-video-ar, and it gives a free fallback
       - if Kawarp fails it drops the class and the canvas is visible again. */
    .ym-sl-fs-overlay.ym-sl-fs-has-kawarp .ym-sl-fs-bg-canvas { display: none; }
    /* Music-video backdrop: a <canvas> holding a very low-res copy of the live
       <video>. The heavy blur is applied by CSS (see the background-mode rule)
       to a static layer, so the browser never re-blurs the live video per
       frame. Overscan is larger than before because a 64px blur would
       otherwise fade out at the element edges. */
    .ym-sl-fs-bg-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      /* Decorative ambient backdrop only. It covers the whole overlay, so it
         must never intercept clicks meant for the lyrics (the sibling
         .ym-sl-fs-bg-tint already sets this; the canvas was missing it). */
      pointer-events: none;
      /* Larger overscan than the old 1.06: ctx.filter's blur fades toward the
         canvas edges, and this scales the faded border outside the viewport. */
      transform: scale(1.3);
      transform-origin: center center;
      will-change: transform;
      z-index: 0;
    }
    .ym-sl-fs-bg-tint {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, .2);
      z-index: 1;
      pointer-events: none;
    }
    /* Cover card. It has NO opacity animation of its own any more (AJ,
       2026-10-21). It used to carry a .ym-sl-fs-art-loading modifier that
       dropped it to 0 while a new src decoded, to stop the sharp OLD bitmap
       showing next to the new Kawarp backdrop. That modifier was a second
       opacity animation fighting the track-change dissolve, and reconcile can
       re-set the src up to 2s after a skip — outside any dissolve window — so
       the card blinked by itself. The dissolve now covers every track change
       (the pane is dark while the art swaps), and outside a track change the
       src only changes between resolution variants of the SAME artwork, so the
       old bitmap is never the wrong cover. */
    .ym-sl-fs-art {
      opacity: 1;
    }
    /* Animated Apple Music cover (m8tec HLS stream, played via hls.js). It
       shares the cover-card box with the static <img> and only ONE shows at a
       time: while the stream loads the static card stays put (its own
       crossfade handles the track-swap), and once the video can play we fade
       it in and hide the card. The video is muted + loops + autoplays inline,
       so it behaves like a living album cover with no chrome of its own. */
    .ym-sl-fs-art-video {
      opacity: 0;
      transition: opacity .5s ease;
      pointer-events: none;
      object-fit: cover;
      background: #000;
    }
    .ym-sl-fs-art-video.ym-sl-fs-art-video-ready { opacity: 1; }
    /* SAFETY NET (AJ, 2026-10-20). YTM's player SIZES any <video> living inside
       #player as if it were its own media element: it writes inline
       inset: 140px 0 0; width: 637px; height: 358px onto our animated art video,
       letterboxing a 16:9 stream inside the SQUARE #song-image and exposing
       #player's own #606060 background above and below — the grey box.
       !important is REQUIRED here: an inline style normally beats a stylesheet, and
       !important in CSS is the only thing that outranks a non-important inline
       declaration. Without it the geometry holds only until YTM's next sizing pass,
       which is why switching tabs appeared to "fix" it (that re-runs
       placeArtVideo(), which rewrites the style) and why it came back afterwards. */
    #player video.ym-sl-fs-art-video {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
      border-radius: inherit;
    }
    /* A not-ready animated cover must never occupy flex space. Two 583px squares
       in the 960px pane row shove the static card to x=-65 and clip the whole
       title/seek/transport stack (live-measured, AJ, 2026-10-18). This must
       outrank the display:block in .ym-sl-fs-media > video.ym-sl-fs-art-video
       (0,2,1), hence the same scope plus the :not() class (0,3,1). */
    .ym-sl-fs-media > video.ym-sl-fs-art-video:not(.ym-sl-fs-art-video-ready) {
      display: none;
    }
    /* .ym-sl-fs-media / .ym-sl-fs-lyrics base position + z-index are set by
       the animated rules higher up. */
    .ym-sl-fs-lyrics {
      min-width: 0;
      min-height: 0;
      height: 100%;
      display: flex;
      overflow: hidden;
    }
    .ym-sl-fs-lyrics .ym-sl-tools { display: none !important; }
    .ym-sl-fs-lyrics .ym-sl-tools { display: none !important; }
    .ym-sl-track { 
      min-width: 0;
      flex: 1 1 auto;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 12px;
      font-weight: 600;
      color: rgba(255,255,255,.66);
      pointer-events: none;
    }
    .ym-sl-import {
      flex: 0 0 auto;
      min-height: 30px;
      padding: 0 10px;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 7px;
      background: rgba(255,255,255,.07);
      color: rgba(255,255,255,.82);
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      pointer-events: auto;
      transition: background .15s ease, transform .12s ease;
    }
    .ym-sl-import:hover { background: rgba(255,255,255,.14); }
    .ym-sl-import:active { transform: scale(.97); }
    /* Inside the OPTIONS panel, match the selects they sit beside: same radius,
       slightly larger type. Scoped, so the panel's own toolbar buttons keep their
       compact sizing (AJ, 2026-10-01). */
    .ym-sl-options-overlay .ym-sl-import,
    .ym-sl-fs-options-overlay .ym-sl-import {
      min-height: 32px;
      border-radius: 8px;
      font-size: 12px;
    }
    .ym-sl-import.active {
      background: rgba(96,165,250,.28);
      border-color: rgba(96,165,250,.6);
      color: #eaf2ff;
    }
    /* Empty / failed state, styled after Spicy Lyrics' .LyricsNotice
       (default.scss): a centred notice with a title-weight message and a pill
       action, rather than the old small grey line. */
    .ym-sl-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: safe center;
      gap: 0;
      padding: 2rem 8%;
      text-align: center;
      animation: ym-sl-notice-in .35s cubic-bezier(.22,1,.36,1) both;
    }
    .ym-sl-empty-msg {
      max-width: 34em;
      font-size: 1.35em;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: -.025em;
      text-wrap: balance;
      color: rgba(255,255,255,.92);
    }
    .ym-sl-empty-body {
      margin-top: .85em;
      max-width: 34em;
      font-size: .95em;
      font-weight: 400;
      line-height: 1.55;
      color: rgba(255,255,255,.62);
      text-wrap: pretty;
    }
    .ym-sl-empty-search {
      margin-top: 1.6em;
      display: inline-flex;
      align-items: center;
      gap: .5em;
      height: 2.6em;
      padding: 0 1.15em;
      border: 0;
      border-radius: 999px;
      background: rgba(255,255,255,.08);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.14);
      color: rgba(255,255,255,.92);
      font-size: .9em;
      font-weight: 600;
      cursor: pointer;
      transition: background .18s ease, transform .18s ease;
    }
    .ym-sl-empty-search:hover {
      background: rgba(255,255,255,.14);
      transform: translateY(-1px);
    }
    @keyframes ym-sl-notice-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: none; }
    }
    /* Loading skeleton. Sized off --DefaultLyricsSize so it tracks the size
       slider: a real .line rule is font-size: var(--DefaultLyricsSize) at
       line-height 1.4 plus .12em block padding, i.e. ~1.64x, so a 0.6x bar with
       a 0.95x gap puts the placeholder rows on roughly the same pitch as real
       lyrics and the panel does not jump when they arrive.
       Only transform/opacity animate. A background-position shimmer would
       repaint the whole block every frame — the exact cost the skeleton exists
       to hide. */
    .ym-sl-skeleton {
      display: flex;
      flex-direction: column;
      gap: calc(var(--DefaultLyricsSize) * .95);
      padding: calc(var(--DefaultLyricsSize) * .5) 2px;
    }
    .ym-sl-skeleton-row {
      position: relative;
      flex: 0 0 auto;
      height: calc(var(--DefaultLyricsSize) * .6);
      border-radius: 6px;
      background: rgba(255,255,255,.075);
      overflow: hidden;
    }
    .ym-sl-skeleton-row::after {
      content: "";
      position: absolute;
      inset: 0;
      transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.10), transparent);
      animation: ym-sl-skeleton-sweep 1.15s ease-in-out infinite;
    }
    @keyframes ym-sl-skeleton-sweep {
      from { transform: translateX(-100%); }
      to   { transform: translateX(100%); }
    }
    @media (prefers-reduced-motion: reduce) {
      .ym-sl-skeleton-row::after { display: none; }
    }
    .ym-sl-search {
      position: absolute;
      top: 48px;
      left: 14px;
      right: 14px;
      z-index: 30;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 16px;
      background: rgba(20,20,26,.97);
      pointer-events: auto;
      animation: ym-sl-search-in .42s cubic-bezier(.32,.72,0,1) both;
    }
    .ym-sl-search.hidden { display: none !important; }
    .ym-sl-search.closing {
      animation: ym-sl-search-out .2s cubic-bezier(.4,0,1,1) both;
      pointer-events: none;
    }
    @keyframes ym-sl-search-out {
      from { opacity: 1; transform: none; filter: blur(0); }
      to { opacity: 0; transform: translateY(6px) scale(.972); filter: blur(6px); }
    }
    @keyframes ym-sl-search-in {
      from { opacity: 0; transform: translateY(10px) scale(.965); filter: blur(8px); }
      to { opacity: 1; transform: none; filter: blur(0); }
    }
    .ym-sl-search-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .ym-sl-search-title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -.01em;
      color: rgba(255,255,255,.94);
    }
    .ym-sl-search-close {
      flex: 0 0 auto;
      width: 26px;
      height: 26px;
      border: 0;
      border-radius: 8px;
      background: rgba(255,255,255,.08);
      color: rgba(255,255,255,.7);
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      transition: background .18s ease, color .18s ease, transform .18s ease;
    }
    .ym-sl-search-close:hover {
      background: rgba(255,255,255,.16);
      color: #fff;
      transform: scale(1.06);
    }
    .ym-sl-search-form { display: flex; gap: 8px; }
    .ym-sl-search-input {
      flex: 1 1 auto;
      min-height: 34px;
      padding: 0 12px;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 10px;
      background: rgba(255,255,255,.06);
      color: rgba(255,255,255,.94);
      font: inherit;
      font-size: 12.5px;
      transition: border-color .2s ease, background .2s ease, box-shadow .2s ease;
    }
    .ym-sl-search-input:focus {
      outline: none;
      border-color: rgba(63,224,197,.55);
      background: rgba(255,255,255,.09);
      box-shadow: 0 0 0 3px rgba(63,224,197,.14);
    }
    .ym-sl-search-input::placeholder { color: rgba(255,255,255,.4); }
    .ym-sl-search-remember {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      color: rgba(255,255,255,.62);
      cursor: pointer;
      user-select: none;
    }
    .ym-sl-search-status {
      min-height: 14px;
      font-size: 11px;
      color: rgba(255,255,255,.55);
    }
    .ym-sl-search-foot {
      font-size: 10.5px;
      line-height: 1.4;
      letter-spacing: .01em;
      color: rgba(255,140,140,.82);
    }
    .ym-sl-search-foot:empty { display: none; }
    .ym-sl-search-results {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 250px;
      overflow-y: auto;
      margin: 0;
      padding: 2px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,.2) transparent;
    }
    .ym-sl-search-results::-webkit-scrollbar { width: 6px; }
    .ym-sl-search-results::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,.18);
      border-radius: 3px;
    }
    /* Each row rises + unblurs in, staggered down the list. --r-op carries the
       per-state opacity so .no-sync can stay dim without the animation's
       fill-mode overriding it. */
    .ym-sl-search-result {
      --r-op: 1;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      text-align: left;
      padding: 9px 11px;
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 10px;
      background: rgba(255,255,255,.045);
      color: rgba(255,255,255,.92);
      font: inherit;
      cursor: pointer;
      opacity: var(--r-op);
      animation: ym-sl-result-in .44s cubic-bezier(.34,1.3,.5,1) both;
      transition: background .16s ease, border-color .16s ease, transform .16s ease;
    }
    .ym-sl-search-result:nth-child(2) { animation-delay: .04s; }
    .ym-sl-search-result:nth-child(3) { animation-delay: .08s; }
    .ym-sl-search-result:nth-child(4) { animation-delay: .12s; }
    .ym-sl-search-result:nth-child(5) { animation-delay: .16s; }
    .ym-sl-search-result:nth-child(6) { animation-delay: .2s; }
    .ym-sl-search-result:nth-child(n+7) { animation-delay: .24s; }
    @keyframes ym-sl-result-in {
      from { opacity: 0; transform: translateY(9px); filter: blur(5px); }
      to { opacity: var(--r-op, 1); transform: none; filter: blur(0); }
    }
    .ym-sl-search-result:hover {
      background: rgba(255,255,255,.08);
      border-color: rgba(63,224,197,.38);
      transform: translateX(2px);
    }
    .ym-sl-search-result.no-sync {
      --r-op: .42;
      cursor: not-allowed;
      background: rgba(255,255,255,.03);
    }
    .ym-sl-search-result.no-sync:hover {
      background: rgba(255,255,255,.03);
      border-color: rgba(255,255,255,.08);
      transform: none;
    }
    .ym-sl-search-result.no-sync-available {
      --r-op: .62;
      cursor: pointer;
    }
    .ym-sl-search-result.no-sync-available:hover {
      background: rgba(255,255,255,.08);
      border-color: rgba(63,224,197,.38);
      transform: translateX(2px);
    }
    .ym-sl-search-name { font-size: 12.5px; font-weight: 600; }
    .ym-sl-search-meta { font-size: 11px; color: rgba(255,255,255,.55); }
    .ym-sl-jump {
      position: absolute;
      right: 18px;
      bottom: 18px;
      z-index: 25;
      min-height: 32px;
      padding: 0 12px;
      border: 1px solid rgba(255,255,255,.2);
      border-radius: 8px;
      background: rgba(0,0,0,.88);
      color: rgba(255,255,255,.9);
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      pointer-events: auto;
      opacity: 1;
      transform: translateY(0);
      transition:
        opacity .18s ease,
        background .15s ease,
        transform .18s ease;
    }
    .ym-sl-jump:hover { background: rgba(0,0,0,.98); }
    .ym-sl-jump:active { transform: scale(.97); }
    .ym-sl-jump.hidden {
      opacity: 0;
      pointer-events: none;
      transform: translateY(6px);
    }
    /* ---- MV pause re-sync ---------------------------------------------------
       Pick mode: hovering a primary line shows the existing .line::before box in a
       stronger form plus a floating "Sync from here" label (.line::after is unused
       on lines, only .word/.letterGroup use ::after for spacing). The label is
       absolutely positioned, so it is not treated as a flex item of the .line. */
    .ym-sl-pause-mode .line:not(.bg-line):not(.musical-line)::after {
      content: "Sync from here";
      position: absolute;
      right: -4px;
      top: -11px;
      z-index: 3;
      padding: 1px 6px;
      border-radius: 6px;
      background: rgba(0,0,0,.86);
      color: rgba(255,255,255,.88);
      font-size: 9px;
      font-weight: 600;
      letter-spacing: .02em;
      line-height: 1.5;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity .15s ease;
    }
    .ym-sl-pause-mode .line:not(.bg-line):not(.musical-line):hover::after { opacity: 1; }
    .ym-sl-pause-mode .line:not(.bg-line):not(.musical-line):hover::before {
      opacity: 1;
      transform: scale(1);
      border-color: rgba(255,255,255,.55);
      background: rgba(255,255,255,.10);
    }
    .ym-sl-pause-mode .line.bg-line,
    .ym-sl-pause-mode .line.musical-line { cursor: default; }
    /* Persistently mark the chosen sync point even outside pick mode. */
    .line.ym-sl-pause-mark::before {
      opacity: 1;
      transform: scale(1);
      border-color: rgba(255,255,255,.45);
      background: rgba(255,255,255,.05);
    }
    .ym-sl-pause-banner {
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 58px;
      z-index: 26;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px solid rgba(255,255,255,.2);
      border-radius: 8px;
      background: rgba(0,0,0,.9);
      color: rgba(255,255,255,.92);
      font-size: 11px;
      font-weight: 600;
    }
    .ym-sl-pause-banner.hidden { display: none; }
    .ym-sl-pause-banner-text { flex: 1 1 auto; min-width: 0; }
    .ym-sl-pause-cancel {
      flex: 0 0 auto;
      min-height: 24px;
      padding: 0 10px;
      border: 1px solid rgba(255,255,255,.2);
      border-radius: 6px;
      background: rgba(255,255,255,.08);
      color: rgba(255,255,255,.9);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .ym-sl-pause-section { display: flex; flex-direction: column; gap: 6px; }
    .ym-sl-pause-editor { display: flex; flex-direction: column; gap: 6px; }
    .ym-sl-pause-editor.hidden { display: none; }
    .ym-sl-pause-line {
      font-size: 11px;
      color: rgba(255,255,255,.62);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ym-sl-pause-row { display: flex; align-items: center; gap: 8px; }
    .ym-sl-pause-range { flex: 1 1 auto; min-width: 0; accent-color: #fff; }
    .ym-sl-pause-number {
      flex: 0 0 auto;
      width: 58px;
      min-height: 26px;
      padding: 0 6px;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 6px;
      background: rgba(0,0,0,.35);
      color: rgba(255,255,255,.9);
      font: inherit;
      font-size: 11px;
    }
    .ym-sl-pause-value { font-size: 11px; color: rgba(255,255,255,.72); }
    .ym-sl-pause-clear { flex: 0 0 auto; min-height: 26px; padding: 0 10px; }
    .ym-sl-pause-pick.hidden { display: none; }
    .ym-sl-pause-pick:disabled { opacity: .45; cursor: not-allowed; }
    .ym-sl-import-mode {
      flex: 0 0 auto;
      min-height: 30px;
      padding: 0 24px 0 8px;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 7px;
      background: rgba(255,255,255,.07);
      color: rgba(255,255,255,.82);
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      pointer-events: auto;
    }
    .ym-sl-import-mode option {
      background: #202020;
      color: #000;
    }
    /* The OPTIONS panel's selects are dark, matching its buttons and the rest of
       the panel. color-scheme: dark (not light) so Chrome also draws the native
       arrow and the open dropdown dark — the white select was the single most
       jarring thing in the panel (AJ, 2026-10-01). */
    .ym-sl-options-overlay select,
    .ym-sl-fs-options-overlay select {
      color-scheme: dark;
      box-sizing: border-box;
      width: 100%;
      padding: 8px 10px;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 8px;
      background-color: rgba(255,255,255,.07);
      color: rgba(255,255,255,.9);
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background-color .2s ease, border-color .2s ease;
    }
    .ym-sl-options-overlay select option,
    .ym-sl-fs-options-overlay select option {
      background: #14161b;
      color: #f1f1f1;
    }
    .ym-sl-options-overlay select:hover,
    .ym-sl-options-overlay select:focus,
    .ym-sl-fs-options-overlay select:hover,
    .ym-sl-fs-options-overlay select:focus {
      background-color: rgba(255,255,255,.12);
      border-color: rgba(255,255,255,.3);
      outline: none;
    }
    /* The fullscreen layout picker keeps its light treatment — it floats over
       video, where a dark pill disappears. */
    .ym-sl-fs-controls select {
      color-scheme: light;
      background-color: #fff;
      color: #000;
      transition: background-color .2s ease, color .2s ease, border-color .2s ease;
    }
    .ym-sl-fs-controls select option {
      background: #fff;
      color: #000;
    }
    .ym-sl-fs-controls select:hover,
    .ym-sl-fs-controls select:focus {
      background-color: #f2f2f2;
      border-color: rgba(0,0,0,.35);
      color: #000;
      outline: none;
    }

/* Fullscreen controls must stay reachable on short/lower-resolution screens.
       They remain over the overlay but have a safe-area clamp so the native
       fullscreen browser chrome and YTM player bar cannot cover them. */
    .ym-sl-fs-controls {
      top: max(18px, env(safe-area-inset-top, 0px));
      right: max(18px, env(safe-area-inset-right, 0px));
    }
    @media (max-height: 700px) {
      .ym-sl-fs-controls {
        top: max(8px, env(safe-area-inset-top, 0px));
        right: max(8px, env(safe-area-inset-right, 0px));
        transform: translateY(-8px) scale(.92);
        transform-origin: top right;
      }
      .ym-sl-fs-overlay:hover .ym-sl-fs-controls,
      .ym-sl-fs-overlay:focus-within .ym-sl-fs-controls {
        transform: translateY(0) scale(.92);
      }
    }
    @media (max-height: 560px) {
      .ym-sl-fs-controls {
        gap: 4px;
        padding: 5px 6px;
        top: max(4px, env(safe-area-inset-top, 0px));
        right: max(4px, env(safe-area-inset-right, 0px));
        transform: translateY(-4px) scale(.82);
      }
      .ym-sl-fs-overlay:hover .ym-sl-fs-controls,
      .ym-sl-fs-overlay:focus-within .ym-sl-fs-controls {
        transform: translateY(0) scale(.82);
      }
    }
    /* YT Music-style arrows are only needed below 1920x1080. At or above
       that resolution the complete options row stays clean and arrow-free. */
    @media (max-width: 1919px), (max-height: 1079px) {
      #ym-sl-panel.SpicyRenderer .ym-sl-tools-arrow {
        display: block;
      }
    }
    /* Lower-resolution YTM pages can have a short viewport where the native
       tab row is clipped by the player/header stack. Keep the existing panel
       mount, but reserve a compact top-safe position for the tab controls. */
    @media (max-height: 700px) {
      #ym-sl-panel.SpicyRenderer .ym-sl-tools {
        top: 0;
        right: 8px;
        left: 8px;
        min-height: 26px;
        padding: 4px 0;
        gap: 4px;
      }
      #ym-sl-panel.SpicyRenderer .ym-sl-tools-scroll { gap: 6px; }
      #ym-sl-panel.SpicyRenderer .ym-sl-tools-arrow {
        flex-basis: 24px;
        width: 24px;
        min-height: 26px;
        font-size: 16px;
      }
      #ym-sl-panel.SpicyRenderer .ym-sl-import,
      #ym-sl-panel.SpicyRenderer .ym-sl-import-mode,
      #ym-sl-panel.SpicyRenderer .ym-sl-video-offset {
        min-height: 26px;
        font-size: 10px;
      }
    }
    @media (max-height: 560px) {
      #ym-sl-panel.SpicyRenderer .ym-sl-tools {
        min-height: 22px;
        padding: 2px 0;
        gap: 3px;
      }
      #ym-sl-panel.SpicyRenderer .ym-sl-tools-scroll { gap: 4px; }
      #ym-sl-panel.SpicyRenderer .ym-sl-tools-arrow {
        flex-basis: 21px;
        width: 21px;
        min-height: 22px;
        font-size: 14px;
      }
      #ym-sl-panel.SpicyRenderer .ym-sl-import,
      #ym-sl-panel.SpicyRenderer .ym-sl-import-mode,
      #ym-sl-panel.SpicyRenderer .ym-sl-video-offset {
        min-height: 22px;
        font-size: 9px;
      }
    }

    #ym-sl-panel.SpicyRenderer .LyricsContainer {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      flex-direction: column;
      justify-content: center;
      overflow: hidden;
      z-index: 4;
    }
    #ym-sl-panel.SpicyRenderer .LyricsContent {
      --TextGlowDef: rgba(255,255,255,.15) 0 0 6px;
      --ActiveTextGlowDef: rgba(255,255,255,.4) 0 0 14px;
      --StrongTextGlowDef: rgba(255,255,255,.68) 0 0 16.4px;
      --ym-sl-lyrics-scale: 1;
      --ym-sl-lyrics-offset: 0px;
      /* The glide's sub-pixel remainder (see setScrollFraction). Written by JS as
         a NEGATIVE px value and folded into the transform below, so it needs no
         element of its own. */
      --ym-sl-scroll-frac: 0px;
      /* Background-vocal opacity as a MULTIPLE of a lead line's, so 1 = the
         same dimming a normal line gets (see the .line.bg-line block). Named
         "-scale" and not "-opacity" because it is not used as an opacity value
         directly: calling it --ym-sl-bg-vocal-opacity and then feeding it
         straight to the opacity property is what broke background vocals in
         the first place. applySettings() overwrites this with the user's
         setting.
         NO BACKTICKS ANYWHERE IN THIS COMMENT BLOCK — this CSS lives inside a
         JS template literal, so a stray backtick terminates it early. */
      --ym-sl-bg-vocal-scale: 1;
      /* Container-relative base, RESTORED 2026-09-26. A fixed rem base was tried
         for a week to hold the size constant across monitors, but AJ called it
         out: the pane gets narrower and the type does not, so the lyrics crowd
         the panel. The 7cqw term tracks the pane instead.

         Which pane: the query container is .ym-sl-panel (container-type: size,
         above), NOT this element -- a container cannot query itself, so cqw in a
         declaration here resolves against the nearest ANCESTOR container.
         Measured live: panel content box 522px => 7cqw = 36.5px, already past
         the 3.5rem ceiling. So on a normal-size pane this sits AT the ceiling
         (35px) and only starts shrinking once the pane drops below ~500px. That
         is exactly the wanted behaviour.

         The fullscreen pane needs no override of its own: it is much wider, so
         its 7cqw is even further past the same ceiling and the two agree.

         The user's size setting still multiplies via --ym-sl-lyrics-scale.
         NO BACKTICKS ANYWHERE IN THIS COMMENT BLOCK -- this CSS lives inside a
         JS template literal, so a stray backtick terminates it early. */
      --DefaultLyricsSize: calc(clamp(1.7rem, calc(1cqw * 7), 3.5rem) * var(--ym-sl-lyrics-scale));
      --amll-lyric-player-font-size: var(--DefaultLyricsSize);
      --vertical-gap: 0px;
      width: 100%;
      height: 100%;
      overflow-x: hidden !important;
      overflow-y: auto !important;
      /* Eases the NON-spring scroll path. "Smooth scrolling off" means the user
         did not ask for our spring; it does not mean the panel should teleport,
         which is what it used to do while "smooth scrolling off" was folded into
         "immediate". Every per-frame writer passes an explicit behavior of
         "instant" so this never fights the spring — see writeScrollTop().
         NO BACKTICKS IN THIS COMMENT BLOCK — it lives inside a template literal. */
      scroll-behavior: smooth;
      font-size: var(--DefaultLyricsSize) !important;
      font-weight: 700;
      font-family: var(--ym-sl-lyric-font, "SpicyLyrics"), "Noto Sans Georgian", "Vazirmatn",
        "SF Pro Display", "SF Pro Text", "SF Pro", -apple-system,
        BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Arial, sans-serif !important;
      font-kerning: normal;
      scrollbar-width: thin;
      scrollbar-color: transparent transparent;
      container-type: size;
      opacity: 1;
      /* The lyric offset AND the glide's sub-pixel remainder share ONE transform.
         scrollTop is integer-only, so the glide writes whole pixels there and
         carries the fraction here (--ym-sl-scroll-frac, written by
         setScrollFraction) — the same trick upstream uses on their virtual
         container, without needing an extra wrapper element. */
      transform: translateY(calc(var(--ym-sl-lyrics-offset) + var(--ym-sl-scroll-frac, 0px)));
      transform-origin: center center;
      -webkit-mask-image: linear-gradient(180deg, transparent 0, transparent 16px, #0f0f0f 64px, #0f0f0f calc(100% - 64px), transparent calc(100% - 16px), transparent);
      mask-image: linear-gradient(180deg, transparent 0, transparent 16px, #0f0f0f 64px, #0f0f0f calc(100% - 64px), transparent calc(100% - 16px), transparent);
      transition: opacity .25s ease;
    }
    /* Honour a reduced-motion request: the native ease above is a scroll
       animation like any other. The spring path is already off for these users
       (see applySettings), so this only has to cover the fallback. */
    @media (prefers-reduced-motion: reduce) {
      #ym-sl-panel.SpicyRenderer .LyricsContent { scroll-behavior: auto; }
    }
    #ym-sl-panel.SpicyRenderer .LyricsContent.offline {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    /* Music-video off-sync notice (see syncMvSyncNotice). A pill at the top of
       the panel with a shrinking timer bar: no pointer events, no layout shift,
       fades and removes itself after the 5s countdown. */
    .ym-sl-mv-sync-chip {
      position: absolute;
      top: 10px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 5;
      padding: 5px 12px 8px;
      border-radius: 999px;
      background: rgba(0, 0, 0, .55);
      color: rgba(255, 255, 255, .8);
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: .02em;
      white-space: nowrap;
      pointer-events: none;
      opacity: 1;
      transition: opacity .45s ease;
      -webkit-backdrop-filter: blur(8px);
      backdrop-filter: blur(8px);
    }
    .ym-sl-mv-sync-chip.ym-sl-fading {
      opacity: 0;
    }
    /* Source warning (lrc.red) — same pill, nudged down so it can coexist with
       the music-video sync chip instead of covering it (AJ, 2026-10-19). */
    .ym-sl-source-chip {
      top: 40px;
    }
    .ym-sl-mv-sync-chip-timer {
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: 4px;
      height: 2px;
      border-radius: 1px;
      background: rgba(255, 255, 255, .35);
      transform-origin: left center;
      animation: ym-sl-mv-sync-timer 5s linear forwards;
    }
    @keyframes ym-sl-mv-sync-timer {
      from { transform: scaleX(1); }
      to   { transform: scaleX(0); }
    }
    #ym-sl-panel.SpicyRenderer .SpicyLyricsScrollContainer {
      width: 100%;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      margin-top: 25cqh;
      margin-bottom: 45cqh;
    }
    #ym-sl-panel.SpicyRenderer .VirtualLyricsContainer {
      position: relative;
      width: 100%;
      box-sizing: border-box;
      /* Clip-safe horizontal inset. .LyricsContent has overflow-x: hidden, so
         lyric glyphs (and the hover highlight box, which bleeds .35em past the
         line) get cut at the panel edge. Widening the inner padding keeps the
         text layout/formatting identical and just reserves a safe band, so the
         right edge clips inside the tab boundary instead of on the glyphs. */
      padding: 0 28px;
      container-type: inline-size;
    }
    #ym-sl-panel.SpicyRenderer .line {
      --font-size: var(--DefaultLyricsSize);
      --BlurAmount: 0px;
      --DefaultLyricsScale: .95;
      --DefaultEmphasisLyricsScale: .95;
      --DefaultLineScale: 1;
      --Vocal-NotSung-opacity: .51;
      --Vocal-Active-opacity: 1;
      --Vocal-Sung-opacity: .497;
      --Vocal-Hover-opacity: 1;
      --ym-sl-line-alpha: var(--Vocal-NotSung-opacity);
      --ym-sl-entry-shadow-alpha: .4;
      --gradient-position: -20%;
      --gradient-color: 255;
      --gradient-alpha: .85;
      --gradient-alpha-end: .5;
      --gradient-degrees: 90deg;
      --gradient-offset: 0%;
      display: flex;
      position: relative;
      flex-wrap: wrap;
      align-items: baseline;
      margin: 1cqw 0;
      opacity: 1;
      /* Fade the gradient paint. Group opacity briefly blanks clipped glyphs
         while their per-word sweep repaints at the line's onset. */
      transition:
        --ym-sl-line-alpha .2s cubic-bezier(.61,1,.88,1),
        --ym-sl-entry-shadow-alpha .2s cubic-bezier(.61,1,.88,1);
      font-size: var(--font-size) !important;
      /* SF Pro's descenders need a little more line-box room than the
         original SpicyLyrics font, especially while the glyphs are lifted. */
      line-height: 1.4 !important;
      letter-spacing: 0;
      direction: ltr;
      cursor: pointer;
      transform-origin: left center;
      isolation: isolate;
      overflow: visible;
      padding-block: .12em;
    }
    /* Static (unsynced) lines: paint at full alpha / opacity and use tighter
       spacing, mirroring Spicy Lyrics' data-lyrics-type="Static" look so an
       unkaraoked LRCLIB result reads like real lyrics rather than dim ghosts.
       Scoped to .line.static only — synced lyrics keep their own rhythm
       (AJ, 2026-09-18). */
    #ym-sl-panel.SpicyRenderer .line.static {
      opacity: 1 !important;
      --ym-sl-line-alpha: 1 !important;
      --gradient-alpha: 1 !important;
      --gradient-alpha-end: 1 !important;
      margin: .12cqw 0;
      --font-size: calc(var(--DefaultLyricsSize) * .9);
      padding-block: .04em;
      line-height: 1.2 !important;
      cursor: default;
      transition: none;
    }
    #ym-sl-panel.SpicyRenderer .line.static .word,
    #ym-sl-panel.SpicyRenderer .line.static .letter {
      --gradient-alpha: 1 !important;
      --gradient-alpha-end: 1 !important;
      --gradient-position: 100% !important;
      --text-shadow-blur-radius: 4px;
      --text-shadow-opacity: 0%;
      transform: none;
      --ym-sl-base-scale: 1;
    }
    #ym-sl-panel.SpicyRenderer .line::before {
      content: "";
      position: absolute;
      inset: -.08em -.35em;
      z-index: 0;
      border: 1px solid rgba(255,255,255,.2);
      border-radius: 10px;
      background: rgba(255,255,255,.055);
      opacity: 0;
      transform: scale(.985);
      pointer-events: none;
      transition:
        opacity .18s ease,
        transform .22s cubic-bezier(.22,.61,.36,1);
    }
    #ym-sl-panel.SpicyRenderer .line > * {
      position: relative;
      z-index: 1;
    }
    #ym-sl-panel.SpicyRenderer .line .romaji {
      flex-basis: 100%;
      width: 100%;
      order: 99;
      font-size: .52em;
      line-height: 1.25;
      font-weight: 500;
      letter-spacing: .04em;
      text-transform: none;
      margin-top: .28em;
      color: rgba(255,255,255,.62);
      text-shadow: 0 1px 3px rgba(0,0,0,.45);
      opacity: var(--ym-sl-line-alpha);
      pointer-events: none;
    }
    #ym-sl-panel.SpicyRenderer .line.Active .romaji {
      opacity: calc(.85 * var(--ym-sl-line-alpha));
    }
    #ym-sl-panel.SpicyRenderer .line:hover {
      z-index: 2;
    }
    #ym-sl-panel.SpicyRenderer .line:hover::before {
      opacity: var(--ym-sl-line-alpha);
      transform: scale(1);
    }
    /* Static (unsynced) lines can't be clicked to seek (no time mapping), so the
       hover highlight box is misleading — suppress it for them (AJ, 2026-09-18). */
    #ym-sl-panel.SpicyRenderer .line.static:hover::before {
      opacity: 0;
      transform: scale(.985);
    }
    #ym-sl-panel.SpicyRenderer .line.static:hover {
      z-index: auto;
    }
    #ym-sl-panel.SpicyRenderer .line.OppositeAligned:not(.rtl) {
      transform-origin: right center;
    }
    #ym-sl-panel.SpicyRenderer .line.rtl.OppositeAligned {
      transform-origin: left center !important;
    }
    #ym-sl-panel.SpicyRenderer .line.line-timed {
      transition:
        --ym-sl-line-alpha .2s cubic-bezier(.61,1,.88,1),
        --ym-sl-entry-shadow-alpha .2s cubic-bezier(.61,1,.88,1),
        scale .28s cubic-bezier(.22,.61,.36,1);
    }
    #ym-sl-panel.SpicyRenderer .line.line-timed.Active {
      scale: 1.05;
    }
    #ym-sl-panel.SpicyRenderer
      .SpicyLyricsScrollContainer.HasDuetLines
      .line:not(.OppositeAligned, .rtl) {
      width: 100%;
      box-sizing: border-box;
      padding-right: 14cqw;
    }
    #ym-sl-panel.SpicyRenderer
      .SpicyLyricsScrollContainer.HasDuetLines
      .line.OppositeAligned:not(.rtl) {
      width: 100%;
      box-sizing: border-box;
      justify-content: flex-end;
      padding-left: 14cqw;
      text-align: right;
      transform-origin: right center;
    }
    #ym-sl-panel.SpicyRenderer .line .word,
    #ym-sl-panel.SpicyRenderer .line .letter,
    #ym-sl-panel.SpicyRenderer .line .letterGroup {
      position: relative;
      display: inline-block;
      font-weight: 700 !important;
      transform-origin: center center;
      --gradient-position: -20%;
      --gradient-color: 255;
      --gradient-alpha: .85;
      --gradient-alpha-end: .5;
      --gradient-degrees: 90deg;
      --gradient-offset: 0%;
      --text-shadow-blur-radius: 4px;
      --text-shadow-opacity: 0%;
      --ym-sl-base-scale: 1;
      --ym-sl-adaptive-scale: 1;
      scale: calc(var(--ym-sl-base-scale) * var(--ym-sl-adaptive-scale));
      overflow: visible;
    }
    #ym-sl-panel.SpicyRenderer .line .letterGroup {
      display: inline-flex;
    }
    /* A letter that is just whitespace collapses to a 0px inline-block, which
       glues multi-word syllables together. Keep the space rendered and give it
       a floor. Mirrors upstream Spicy Lyrics Emphasize.ts / Mixed.css. */
    #ym-sl-panel.SpicyRenderer .line .letter.SpaceLetter {
      white-space: pre;
      min-width: 0.3ch;
    }
    /* Register --gradient-position so a bad write can never blank the fill.
       As an UNREGISTERED custom property it accepts ANY token, so a bad value
       stores without complaint and then makes
       calc(var(--gradient-position) + 20% + var(--gradient-offset)) invalid -
       which invalidates the whole background-image declaration and paints the
       glyph transparent for a frame (the black flicker). Registered as a
       percentage, an out-of-syntax value resolves to the initial value instead
       of poisoning the gradient. The JS guards its own writes too (see tick());
       this is the second line of defence.
       Upstream was developing exactly this: default_backup.css:383. */
    @property --gradient-position {
      syntax: "<percentage>";
      inherits: true;
      initial-value: -20%;
    }
    @property --gradient-alpha {
      syntax: "<number>";
      inherits: true;
      initial-value: 1;
    }
    @property --ym-sl-line-alpha {
      syntax: "<number>";
      inherits: true;
      initial-value: 1;
    }
    @property --ym-sl-entry-shadow-alpha {
      syntax: "<number>";
      inherits: true;
      initial-value: 0;
    }
    /* The scroll glide's sub-pixel remainder. REGISTERED, and inherits:false is the
       whole point: an UNREGISTERED custom property inherits, so writing it on the
       scroller every frame invalidated the computed style of EVERY descendant
       (70 lines + 571 words) — the glide ran but the panel crawled (AJ, 2026-10-07).
       Non-inheriting means only the scroller's own transform is invalidated.
       NO BACKTICKS IN THIS COMMENT — it lives inside a template literal. */
    @property --ym-sl-scroll-frac {
      syntax: "<length>";
      inherits: false;
      initial-value: 0px;
    }
    /* Simple lyrics — Apple Music / AMLL style. The spring factories are stubbed
       and the splines swapped in JS (applySimpleLyricsSplines). The look is the
       AMLL preview renderer: a per-word white gradient sweep on the active line,
       the active line scaled up with a soft white halo, and depth dimming (lines
       fade AND recede with distance from the active line, injected per-line as
       --ym-sl-line-alpha / --amll-depth-scale in animate()). Word-synced only —
       line-timed and static lines fill as whole blocks, so the AMLL line motion
       would just blur them. AJ: make simple lyrics the apple music style. */
    body.ym-sl-simple-lyrics #ym-sl-panel.SpicyRenderer .line:not(.line-timed):not(.static):not(.bg-line) {
      transition:
        transform .5s cubic-bezier(.22, .61, .36, 1),
        --ym-sl-line-alpha .4s cubic-bezier(.61, 1, .88, 1),
        --ym-sl-entry-shadow-alpha .4s cubic-bezier(.61, 1, .88, 1);
      /* AMLL uses a larger, more confident lyric size. */
      --font-size: calc(var(--DefaultLyricsSize) * 1.08);
      /* Per-line scale set in animate() by distance from the active line, so the
         stack recedes like AMLL as it scrolls instead of sitting flat. */
      transform: scale(var(--amll-depth-scale, 1));
      transform-origin: left center;
    }
    body.ym-sl-simple-lyrics #ym-sl-panel.SpicyRenderer .line:not(.line-timed):not(.static):not(.bg-line).Active {
      --ym-sl-line-alpha: 1;
    }
    /* No text glow in Simple lyrics: AMLL's "glow" comes from a blurred album-art
       backdrop behind the lyrics, NOT a text-shadow on the glyphs. With no such
       backdrop here the shadow just reads as a fuzzy halo, so kill it — the text
       stays crisp white like AMLL. The !important also overrides the base
       .line.Active .word shadow so nothing glows in this mode. */
    body.ym-sl-simple-lyrics #ym-sl-panel.SpicyRenderer .line .word,
    body.ym-sl-simple-lyrics #ym-sl-panel.SpicyRenderer .line .letter,
    body.ym-sl-simple-lyrics #ym-sl-panel.SpicyRenderer .line .letterGroup,
    body.ym-sl-simple-lyrics #ym-sl-panel.SpicyRenderer .line .bg-word {
      text-shadow: none !important;
    }
    /* Depth lines: no blur — AMLL keeps them still and dims them by opacity. The
       exact opacity/scale per distance is injected in animate(); the state
       classes supply the floor when a line is far away. */
    body.ym-sl-simple-lyrics #ym-sl-panel.SpicyRenderer .line:not(.line-timed):not(.static):not(.bg-line).Sung,
    body.ym-sl-simple-lyrics #ym-sl-panel.SpicyRenderer .line:not(.line-timed):not(.static):not(.bg-line).NotSung {
      filter: none;
    }
    /* Only the leaf text elements (.word/.letter) carry the gradient clip.
       Putting background-clip:text on the .letterGroup wrapper clips its child
       letters to the (empty) wrapper box and makes them vanish once the active
       gradient is removed — the "long words turn dark after being sung" bug. */
    /* Lines keep their opacity layer stable; words and letters get a transform
       hint only while their springs move. Dot opacity also changes per frame. */
    #ym-sl-panel.SpicyRenderer .line.ym-sl-animating .word,
    #ym-sl-panel.SpicyRenderer .line.ym-sl-animating .letter {
      will-change: transform;
    }
    #ym-sl-panel.SpicyRenderer .line.ym-sl-animating .dot {
      will-change: transform, opacity;
    }
    #ym-sl-panel.SpicyRenderer .line .word,
    #ym-sl-panel.SpicyRenderer .line .letter {
      -webkit-text-fill-color: transparent;
      background-clip: text;
      /* Paint every state with the same gradient-clip technique (only the
         gradient's brightness differs per state). This keeps stroke weight
         identical while a line is Active vs Sung/NotSung; swapping to a solid
         fill on Sung made the glyphs read fuller/bolder (the "thicker after
         the line ends" bug). */
      background-image: linear-gradient(
        var(--gradient-degrees),
        rgba(255,255,255,calc(var(--gradient-alpha) * var(--ym-sl-line-alpha))) var(--gradient-position),
        rgba(255,255,255,calc(var(--gradient-alpha-end) * var(--ym-sl-line-alpha)))
          calc(var(--gradient-position) + 20% + var(--gradient-offset))
      );
    }
    #ym-sl-panel.SpicyRenderer .line .word.PartOfWord,
    #ym-sl-panel.SpicyRenderer .line .letterGroup.PartOfWord {
      transform-origin: right center;
    }
    #ym-sl-panel.SpicyRenderer .line .word.PartOfWord
      + :is(.word.PartOfWord, .letterGroup.PartOfWord),
    #ym-sl-panel.SpicyRenderer .line .letterGroup.PartOfWord
      + :is(.word.PartOfWord, .letterGroup.PartOfWord) {
      transform-origin: center center;
    }
    #ym-sl-panel.SpicyRenderer .line .word.PartOfWord
      + :is(.word, .letterGroup),
    #ym-sl-panel.SpicyRenderer .line .letterGroup.PartOfWord
      + :is(.word, .letterGroup) {
      transform-origin: left center;
    }
    #ym-sl-panel.SpicyRenderer .line.rtl .word.PartOfWord,
    #ym-sl-panel.SpicyRenderer .line.rtl .letterGroup.PartOfWord {
      transform-origin: left center;
    }
    #ym-sl-panel.SpicyRenderer .line.rtl .word.PartOfWord
      + :is(.word, .letterGroup),
    #ym-sl-panel.SpicyRenderer .line.rtl .letterGroup.PartOfWord
      + :is(.word, .letterGroup) {
      transform-origin: right center;
    }
    #ym-sl-panel.SpicyRenderer .line .word:not(.PartOfWord, .dot, .LastWordInLine)::after,
    #ym-sl-panel.SpicyRenderer .line .letterGroup:not(.PartOfWord, .dot, .LastWordInLine)::after {
      content: "";
      margin-right: .32ch;
    }
    #ym-sl-panel.SpicyRenderer .line.Active .word,
    #ym-sl-panel.SpicyRenderer .line.Active .letter,
    #ym-sl-panel.SpicyRenderer .line.Active .letterGroup {
      /* Carry the unsung halo through the state flip while the word glow grows.
         Dropping it in one frame made both lead and background text dip before
         the gradient fade could brighten them. */
      text-shadow:
        0 0 var(--BlurAmount) rgba(255,255,255,calc(var(--ym-sl-entry-shadow-alpha) * var(--Vocal-NotSung-opacity))),
        0 0 var(--text-shadow-blur-radius) rgba(255,255,255,calc(var(--text-shadow-opacity) * var(--ym-sl-line-alpha)));
    }
    #ym-sl-panel.SpicyRenderer .line.NotSung {
      --ym-sl-line-alpha: var(--Vocal-NotSung-opacity);
      --ym-sl-entry-shadow-alpha: .4;
      --gradient-position: -20% !important;
      /* Dim gradient (same clip technique as Active) instead of a solid fill,
         so the stroke weight never changes between states. */
      --gradient-alpha: .4;
      --gradient-alpha-end: .4;
      text-shadow: 0 0 var(--BlurAmount) rgba(255,255,255,calc(var(--gradient-alpha-end) * var(--ym-sl-line-alpha)));
    }
    #ym-sl-panel.SpicyRenderer .line.NotSung .word,
    #ym-sl-panel.SpicyRenderer .line.NotSung .letter {
      --gradient-position: -20% !important;
      --text-shadow-opacity: 0% !important;
      --text-shadow-blur-radius: 4px !important;
    }
    #ym-sl-panel.SpicyRenderer .line.Sung {
      --ym-sl-line-alpha: var(--Vocal-Sung-opacity);
      --ym-sl-entry-shadow-alpha: 0;
      --gradient-position: 100% !important;
      /* Dim gradient (same clip technique as Active) instead of a solid fill,
         so a finished line keeps the exact stroke weight it had while playing.
         (Earlier theory blamed the line-level text-shadow halo; that rests at 0
         on Sung and was not the cause — the solid-fill swap was.) */
      --gradient-alpha: .32;
      --gradient-alpha-end: .32;
      --BlurAmount: 0px !important;
      text-shadow: 0 0 var(--BlurAmount) rgba(255,255,255,calc(var(--gradient-alpha) * var(--ym-sl-line-alpha)));
    }
    #ym-sl-panel.SpicyRenderer .line.Sung .word,
    #ym-sl-panel.SpicyRenderer .line.Sung .letter {
      --gradient-position: 100% !important;
    }
    /* WordSung keeps the gradient-clip from the base rule; no solid-fill
       override, so weight stays consistent with the active line. */
    /* WordNotSung keeps the gradient-clip from the base rule; no solid-fill
       override, so weight stays consistent with the active line. */
    /* Letter-group words are governed by EXACTLY the same rules as regular
       words (the .line.Sung/.line.NotSung .word,.letter pairs above plus the
       WordSung/WordNotSung pairs), so a long "wavy" word matches its
       neighbours in every state. Do not add letter-specific fill overrides
       here: an author !important declaration outranks a normal inline style,
       which silently makes the animateLetters inline fills dead code.
       Letters must also keep inheriting the line's text-shadow — the
       .letterGroup wrapper must never set 'text-shadow: none', or the letters
       lose the glow layer that regular words get and read dimmer. */
    #ym-sl-panel.SpicyRenderer .line.Active {
      --ym-sl-line-alpha: var(--Vocal-Active-opacity);
      --ym-sl-entry-shadow-alpha: 0;
    }
    #ym-sl-panel.SpicyRenderer .line.bg-line.Active .bg-word.WordNotSung:not(.letterGroup),
    #ym-sl-panel.SpicyRenderer .line.bg-line.Active .bg-word.WordNotSung .letter {
      /* Keep unsung bg words dim and glow-less until they are sung; the sweep
         itself comes from the BASE .word/.letter gradient rule and already
         rests at -20%.
         The gradient-clip must NOT be re-declared here. A state-class rule that
         declares background-image drags that property into the class-toggle
         invalidation set, and re-rasterising a clipped gradient at the instant
         the state class flips is what painted the glyphs black for a frame.
         (AJ: "when a new word plays the last word gets dimmer" - the bg-word
         flicker.) Only custom properties are set here: the per-frame sweep
         already animates those without glitching. */
      --gradient-position: -20%;
      --text-shadow-opacity: 0;
    }
    /* A rule used to live here that re-declared the gradient-clip for
       .bg-word.Active and .bg-word.WordSung with !important. It was pure
       duplication of the base .word/.letter rule - bg words carry BOTH the
       "word" and "bg-word" classes (see appendWords), so the base rule already
       paints them - and the duplication WAS the bug: it put background-image
       into the invalidation set of the Active and WordSung state classes, so
       every Active-to-Sung flip re-rasterised the clipped gradient and flashed
       the glyphs black. Removing it leaves the base rule as the single source
       of the gradient in every state.
       The :not(.letterGroup) exclusion it needed is no longer required either:
       the base rule never targets .letterGroup, so a wrapper can only receive a
       background-image from animateWord()'s inline none, and stays inert. */
    #ym-sl-panel.SpicyRenderer .line.rtl {
      direction: rtl !important;
      transform-origin: right center !important;
    }
    #ym-sl-panel.SpicyRenderer .line.rtl .word,
    #ym-sl-panel.SpicyRenderer .line.rtl .letter { --gradient-degrees: -90deg; }
    #ym-sl-panel.SpicyRenderer .line.line-timed .word,
    #ym-sl-panel.SpicyRenderer .line.line-timed .letter,
    #ym-sl-panel.SpicyRenderer .line.line-timed .letterGroup {
      --gradient-degrees: 180deg;
    }
    #ym-sl-panel.SpicyRenderer .word-group {
      display: inline-flex;
      flex-wrap: wrap;
      white-space: nowrap;
      --ym-sl-base-scale: 1;
      --ym-sl-adaptive-scale: 1;
      scale: calc(var(--ym-sl-base-scale) * var(--ym-sl-adaptive-scale));
      transform-origin: center center;
    }
    #ym-sl-panel.SpicyRenderer .line.bg-line {
      /* The normal line fade also covers background vocals. Scale all three
         states together so the background-vocal setting keeps its meaning. */
      --Vocal-NotSung-opacity: calc(.5 * var(--ym-sl-bg-vocal-scale));
      --Vocal-Sung-opacity: calc(.5 * var(--ym-sl-bg-vocal-scale));
      --Vocal-Active-opacity: calc(.95 * var(--ym-sl-bg-vocal-scale));
      --font-size: calc(var(--DefaultLyricsSize) * 0.75);
      margin: -1cqw 0 1cqw !important;
    }
    #ym-sl-panel.SpicyRenderer .line.bg-line.Sung .word,
    #ym-sl-panel.SpicyRenderer .line.bg-line.Sung .letter,
    #ym-sl-panel.SpicyRenderer .line.bg-line.Sung .letterGroup {
      transition: text-shadow .3s ease;
    }
    #ym-sl-panel.SpicyRenderer .line.musical-line {
      --ym-sl-line-alpha: 1 !important;
      cursor: default;
      margin: 0;
      padding: 0 0.9em;
      display: grid;
      grid-template-rows: 0fr;
      opacity: 0;
      transition: grid-template-rows .35s ease, opacity .35s ease;
    }
    #ym-sl-panel.SpicyRenderer .line.musical-line.playing {
      grid-template-rows: 1fr;
      opacity: 1;
    }
    #ym-sl-panel.SpicyRenderer .line.musical-line .dotGroup {
      --dot-gap: clamp(.005rem, 1.7cqw, .18rem);
      display: flex;
      flex-direction: row;
      gap: var(--dot-gap);
      padding: 0.45em 0.2em;
      min-height: 0;
      overflow: hidden;
    }
    #ym-sl-panel.SpicyRenderer .line.musical-line.playing .dotGroup,
    #ym-sl-panel.SpicyRenderer .line.musical-line.bounce-out .dotGroup {
      overflow: visible;
    }
    #ym-sl-panel.SpicyRenderer .line.musical-line.bounce-out .dotGroup {
      /* The WHOLE GROUP scales, keeping the dots' spacing -- AJ: "not the
         individual dots but the group's scale goes down" (2026-10-02). A small
         bounce-in first, then the group shrinks toward 40% and the line leaves
         with the scroll. Origin pinned centre so the cluster shrinks toward its
         own middle instead of an edge. */
      transform-origin: 50% 50%;
      animation: ymSlDotExit 420ms cubic-bezier(.45, 0, .55, 1) forwards;
    }
    @keyframes ymSlDotExit {
      0%   { transform: scale(1); }
      40%  { transform: scale(1.12); }
      100% { transform: scale(0.4); }
    }
    #ym-sl-panel.SpicyRenderer .line.musical-line .dot {
      --font-size: calc(var(--DefaultLyricsSize) * 1.3);
      --opacity-size: .35;
      display: inline-block;
      min-width: .35ch;
      border-radius: 50%;
      scale: .75;
      font-size: var(--font-size) !important;
      line-height: .65;
      opacity: var(--opacity-size);
      --gradient-position: 100%;
      --ym-sl-base-scale: .75;
      --ym-sl-adaptive-scale: 1;
      scale: calc(var(--ym-sl-base-scale) * var(--ym-sl-adaptive-scale));
    }
    #ym-sl-panel.SpicyRenderer .line.static {
      cursor: default;
      --gradient-position: 100%;
      --gradient-alpha: 1;
      --gradient-alpha-end: 1;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-empty {
      width: min(92%, 34em);
      margin: auto;
      color: inherit;
      font-size: 14px;
      line-height: 1.5;
      text-align: center;
      padding: 2rem 6%;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-credits {
      margin: 48px 4px 22px;
      padding-top: 18px;
      border-top: 1px solid rgba(255,255,255,.12);
      opacity: .85;
      pointer-events: none;
      user-select: none;
      /* Credits are chrome, not lyrics: keep the bundled face even though the
         footer sits inside .LyricsContent (which carries the custom lyric
         font). Covers Written By / Uploaded by / Made by (AJ, 2026-10-20). */
      font-family: "SpicyLyrics", "Noto Sans Georgian", "Vazirmatn",
        "SF Pro Display", "SF Pro Text", "SF Pro", -apple-system,
        BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Arial, sans-serif;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-credits-label {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: rgba(255,255,255,.5);
      margin-bottom: 6px;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-credits-names {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.5;
      color: rgba(255,255,255,.8);
    }
    /* "Uploaded by <avatar> <username>" — only present on Spicy Lyrics API
       results. The parent .ym-sl-credits is pointer-events:none, so the link
       opts itself back in; without that the click never reaches it. */
    #ym-sl-panel.SpicyRenderer .ym-sl-uploader {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 22px;
      font-size: 13px;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-uploader-label {
      color: rgba(255,255,255,.5);
      font-weight: 600;
      letter-spacing: .02em;
      /* Keep the label above the pill's glow halo (the halo is a negative-z
         pseudo that would otherwise wash over this text). */
      position: relative;
      z-index: 1;
    }
    /* Pill styling lives on the link itself (AJ, 2026-09-28 v8: v7's clip wrapper
       caused the conic to fill the pill interior; reverting to the direct link). */
    #ym-sl-panel.SpicyRenderer .ym-sl-uploader-link {
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 3px 9px 3px 4px;
      border-radius: 999px;
      background: rgba(255,255,255,.07);
      color: rgba(255,255,255,.9);
      text-decoration: none;
      position: relative;
      isolation: isolate;
      transition: background-color .18s ease, color .18s ease;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-uploader-link:hover {
      background: rgba(255,255,255,.14);
      color: #fff;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-uploader-link.no-link {
      pointer-events: none;
      background: rgba(255,255,255,.05);
      cursor: default;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-uploader-avatar {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      object-fit: cover;
      flex: none;
      background: rgba(255,255,255,.12);
    }
    /* Registered so Chrome definitely re-resolves the conic when the JS rAF loop
       updates the angle on :root (AJ's Chrome would not reliably repaint a conic
       driven by an UNregistered custom property — the v6 failure). inherits:true
       so the :root value cascades to every pill's ::before/::after. No CSS
       animation targets it, so it simply follows the JS-set value. */
    @property --ym-sl-pfp-spin {
      syntax: "<angle>";
      inherits: true;
      initial-value: 0deg;
    }
    /* Attribution glow v9 (AJ, 2026-09-28): two colours as a THIN BAND HUGGING
       the pill's EDGE. The pill itself stays pill-shaped and STATIC — only the
       COLOUR SEAM glides around the perimeter (a light travelling round the
       border), so it reads as "gliding", never a rigid spin.

       Mechanism: a masked pill-shaped ring (XOR mask; padding = ring
       thickness) painted with a conic-gradient whose 'from' angle is the
       registered --ym-sl-pfp-spin (inherits). A single CSS animation on the
       PANEL drives that angle — pure CSS, no JS rAF, no per-frame style
       invalidation (v8's rAF loop tanked fps to ~20 by setProperty-ing the root
       every frame; v9 is compositor-friendly). The soft glow is a SECOND masked
       ring, wider (10px) and blurred (10px), so the halo follows the seam.
       No fill inside the pill. --ym-sl-pfp-accent-a/-b set on the ROW by
       buildPersonRow (complementary default pair; sampleAvatarColor() upgrades
       when the canvas is readable). */
    /* Glide driver (v10, AJ, 2026-09-28): a JS rAF (startPfpGlowEngine())
       sets --ym-sl-pfp-spin on EACH .ym-sl-uploader-link every frame — scoped
       to the pill (NOT :root), so only the pill + its pseudos get invalidated
       (v8's root-level setProperty tanked fps to ~20 by cascade-invalidating
       the whole tree). JS-driven because AJ's Chrome reliably repaints the
       conic on JS setProperty but NOT on CSS @keyframes animation of the
       same registered @property (v6/v9 freeze). Crisp ::before ring (z:-1)
       sits on top; soft glow ::after (z:-2) paints behind it.
       prefers-reduced-motion is handled in the JS engine. */
    #ym-sl-panel.SpicyRenderer .ym-sl-uploader-link::before {
      content: "";
      position: absolute;
      inset: -2px;
      border-radius: inherit;
      padding: 2px;
      background: conic-gradient(
        from var(--ym-sl-pfp-spin, 0deg),
        var(--ym-sl-pfp-accent-a, #ff5b8e) 0deg 180deg,
        var(--ym-sl-pfp-accent-b, #5be0ff) 180deg 360deg
      );
      -webkit-mask:
        linear-gradient(#000 0 0) content-box,
        linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask:
        linear-gradient(#000 0 0) content-box,
        linear-gradient(#000 0 0);
      mask-composite: exclude;
      pointer-events: none;
      z-index: -1;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-uploader-link::after {
      content: "";
      position: absolute;
      inset: -8px;
      border-radius: inherit;
      background: conic-gradient(
        from var(--ym-sl-pfp-spin, 0deg),
        var(--ym-sl-pfp-accent-a, #ff5b8e) 0deg 180deg,
        var(--ym-sl-pfp-accent-b, #5be0ff) 180deg 360deg
      );
      filter: blur(6px);
      opacity: .35;
      pointer-events: none;
      z-index: -2;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-uploader-name {
      font-weight: 600;
      line-height: 1;
    }
    /* "Lyrics provided by <provider>" — shown for EVERY API source, because
       developers.spicylyrics.org/md/attribution makes displaying the provider a
       binding condition (ToS section 6), not a nicety. Plain text: the provider
       carries no url of its own. */
    #ym-sl-panel.SpicyRenderer .ym-sl-provider {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 22px;
      font-size: 13px;
      color: rgba(255,255,255,.5);
      /* This credit lives INSIDE .LyricsContent, which carries the custom lyric
         face. Pin it to the bundled font: the custom font is for the lyrics
         themselves, not attribution (AJ, 2026-10-20). */
      font-family: "SpicyLyrics", "Noto Sans Georgian", "Vazirmatn",
        "SF Pro Display", "SF Pro Text", "SF Pro", -apple-system,
        BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Arial, sans-serif;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-provider-name {
      color: rgba(255,255,255,.85);
      font-weight: 600;
    }
    /* Provider name as a link (lrc.red / Unison / LRCLIB) — keeps the same
       weight and colour, underlines only on hover. */
    #ym-sl-panel.SpicyRenderer a.ym-sl-provider-name {
      text-decoration: none;
      cursor: pointer;
    }
    #ym-sl-panel.SpicyRenderer a.ym-sl-provider-name:hover {
      text-decoration: underline;
    }
    /* Machine-aligned sources (lrc.red) get a persistent red warning pill —
       same family as the transient chip above the lyrics, but it stays. */
    #ym-sl-panel.SpicyRenderer .ym-sl-provider-warn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      width: fit-content;
      padding: 5px 12px 5px 10px;
      border-radius: 999px;
      background: rgba(229, 72, 77, .14);
      border: 1px solid rgba(229, 72, 77, .42);
      color: rgba(255, 255, 255, .9);
      font-size: 12px;
      letter-spacing: .01em;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-provider-warn-icon {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      display: block;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-provider-warn .ym-sl-provider-label {
      color: rgba(255, 255, 255, .72);
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-provider-warn .ym-sl-provider-name {
      color: #ffffff;
    }
    /* Pill + explanation as one block: the block owns the top margin, so the
       pill sits tight above its note. */
    #ym-sl-panel.SpicyRenderer .ym-sl-provider-block {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 7px;
      margin-top: 22px;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-provider-block .ym-sl-provider-warn {
      margin-top: 0;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-provider-note {
      font-size: 11.5px;
      line-height: 1.4;
      color: rgba(255, 255, 255, .42);
      max-width: 42ch;
    }
    /* Tighter leading when the provider is followed by a person row, and when
       two person rows stack (uploader then maker) — otherwise the three
       attribution lines float apart. */
    #ym-sl-panel.SpicyRenderer .ym-sl-provider + .ym-sl-uploader,
    #ym-sl-panel.SpicyRenderer .ym-sl-uploader + .ym-sl-uploader {
      margin-top: 6px;
    }
    tp-yt-paper-tab.ym-sl-tab { position: relative; cursor: pointer; }
    tp-yt-paper-tab.ym-sl-tab .tab-content { pointer-events: none; }
    /* YTM disables the native Lyrics tab (pointer-events:none, disabled, tabindex
       -1, and a 0.3-alpha label) when the track has no lyrics on YTM. Aurora
       re-enables it so its own lyrics live in the REAL tab. */
    tp-yt-paper-tab.ym-sl-lyrics-tab {
      pointer-events: auto !important;
      cursor: pointer !important;
      color: rgba(255, 255, 255, .7) !important;
    }
    tp-yt-paper-tab.ym-sl-lyrics-tab .tab-content {
      pointer-events: auto !important;
      color: rgba(255, 255, 255, .7) !important;
    }
    tp-yt-paper-tab.ym-sl-lyrics-tab[aria-selected="true"],
    tp-yt-paper-tab.ym-sl-lyrics-tab[aria-selected="true"] .tab-content {
      color: #fff !important;
    }
    /* The SYNCED tab is a clone of the selected LYRICS tab, so its label
       inherited the selected tab's styling. Force the same label colour and
       opacity as the other (unselected) tabs. */
    /* Colour-only dimming with opacity pinned to 1: our cloned tab nests a
       SECOND .tab-content, so an opacity here stacked with itself (0.8 x 0.8 =
       0.64) and made SYNCED read darker than the native tabs (AJ, 2026-09-28,
       verified with the browser bridge). The native unselected label is
       rgba(255,255,255,.7) at opacity .8, i.e. an effective 0.56 white — bake
       that into the colour and leave opacity alone so it cannot stack. */
    tp-yt-paper-tab.ym-sl-tab .tab-content {
      color: rgba(255,255,255,.56) !important;
      opacity: 1 !important;
    }
    /* Selected-state parity (AJ, 2026-09-28). Verified live with the browser
       bridge: YTM marks the selected tab with the class iron-selected and its
       label renders rgb(255,255,255) / opacity 1, while unselected labels are
       rgba(255,255,255,.7) / .8. Clicking SYNCED does NOT move that native
       selection (our tab is not part of YTM's iron-pages), so the previously
       selected tab stayed bright and SYNCED stayed dim. While our tab is the
       active one (.ym-sl-custom-active on the bar) brighten SYNCED and dim the
       native selected tab, so the highlight follows the visible panel.
       NO BACKTICKS ANYWHERE IN THIS COMMENT BLOCK — it lives inside the CSS
       template literal, so one stray backtick terminates the whole stylesheet
       (and node --check does NOT catch it). */
    tp-yt-paper-tab.ym-sl-tab.ym-sl-active .tab-content {
      color: #fff !important;
      opacity: 1 !important;
    }
    tp-yt-paper-tabs.ym-sl-custom-active
      tp-yt-paper-tab.iron-selected:not(.ym-sl-tab) .tab-content {
      color: rgba(255,255,255,.7) !important;
      opacity: .8 !important;
    }
    /* Crossfade the label colours with the panel swap instead of snapping. */
    tp-yt-paper-tab.ym-sl-tab .tab-content,
    tp-yt-paper-tabs.ym-sl-custom-active
      tp-yt-paper-tab.iron-selected:not(.ym-sl-tab) .tab-content {
      transition: color .18s ease, opacity .18s ease;
    }
    /* The bar ships with NO CSS transition of its own (verified live: computed
       transition-duration 0s, animation-name none — YTM drives it in JS), so a
       transform WE set would snap while the native tabs glide. Give it one so
       the SYNCED underline animates the same way (AJ, 2026-09-28). This cannot
       disturb the native tabs: YTM's own animation takes precedence over a CSS
       transition. */
    tp-yt-paper-tabs #selectionBar {
      transition: transform .25s ease;
    }
    /* The tab underline is YTM's OWN #selectionBar — a full-width element whose
       1px white border-bottom is moved + resized onto the selected tab via
       transform: translateX(%) scaleX(fraction) (verified live with the browser
       bridge). We used to hide it and draw a per-tab ::after instead, but that
       animated as a centre-out scaleX "zoom" (AJ, 2026-09-28). We now keep the
       real bar and drive it from JS (syncSelectionBar), so the underline moves
       exactly like a native tab switch — same element, same transition. */
    tp-yt-paper-tabs.ym-sl-custom-active
      tp-yt-paper-tab.iron-selected:not(.ym-sl-tab)::after,
    tp-yt-paper-tabs.ym-sl-custom-active
      tp-yt-paper-tab.iron-selected:not(.ym-sl-tab) .tab-content::after {
      opacity: 0 !important;
      visibility: hidden !important;
    }

    /* Final fullscreen geometry rules. These intentionally come after the
       short-viewport media queries above: the mode selectors carry higher
       specificity, so switching to Lyrics Only animates the control bars to
       their new locations instead of the media-query transform winning and
       making them snap. */
    /* The redesigned fullscreen controls are layout-agnostic: the chrome lives
       top-right (see .ym-sl-fs-controls at the top of this block) and the play
       chip + scrubber sit inside the full-size .ym-sl-fs-player-controls layer
       (see .ym-sl-fs-player-controls above). In the side layouts every position
       is a FIXED length — nothing is measured off the media any more.
       The legacy per-layout repositioning that used to live here pushed the
       chrome to bottom-center and shrank the player-controls anchor to content
       width, which squeezed the play chip into the bottom-left corner on the
       side and video-background layouts. It is removed; only the lyrics scroll
       clearance that genuinely still applies is kept. */
    @media (max-height: 720px) {
      .ym-sl-fs-overlay.ym-sl-fs-mode-lyrics-only .ym-sl-fs-lyrics .LyricsContent {
        padding-bottom: 142px;
      }
    }
    @media (max-height: 560px) {
      .ym-sl-fs-overlay.ym-sl-fs-mode-lyrics-only .ym-sl-fs-lyrics .LyricsContent {
        padding-bottom: 112px;
      }
    }

    /* ===== STATIC SIDE STACK (AJ, 2026-10-20) =============================
       Every control position is a fixed length. This block used to re-anchor the
       title, chip and scrubber to --ym-sl-fs-band-top (measured from the media's
       live rect and transitioned over .35s), which is what made the controls
       drift on every aspect-ratio change, art swap and metadata arrival.
       The base rules above already carry the static bottom values
       (title 170/150, chip 74/72), so nothing is overridden here — the measured
       system is simply gone. Animations are rebuilt from this base. */

    /* ===== side + lyrics-only: transport chip + scrubber never hide ========
       AJ wants the transport chip and the scrubber permanently visible in the
       video-left / lyrics-right (side) layout instead of fading in on hover
       (2026-09-28), and extended that to Lyrics Only (2026-09-28). The EXIT +
       LAYOUT controls DO hide on idle in every layout now (2026-10-02 — see the
       .ym-sl-fs-idle controls rule above). The MOUSE still hides on idle in
       EVERY layout (see the .ym-sl-fs-idle cursor rule above). Placed last in
       the block so it also wins over the .ym-sl-fs-idle rules, which carry the
       same specificity for the scrubber. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background) .ym-sl-fs-play-chip,
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background) .ym-sl-fs-scrubber {
      opacity: 1;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background).ym-sl-fs-idle .ym-sl-fs-play-chip,
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background).ym-sl-fs-idle .ym-sl-fs-scrubber {
      opacity: 1;
      pointer-events: auto;
    }

    /* ===== media-mode swap: NO CROSSFADE (AJ, 2026-10-20) ==================
       The .ym-sl-fs-swapping class and its two rules (title filter fade +
       player-controls opacity fade) are REMOVED. syncFsVideoMode() no longer
       hides the pane either, so a cover <-> music-video switch is a hard cut:
       the outgoing image stays up until the incoming one can paint (the cover
       card is held until the video is ready), then both swap in one frame.
       Nothing to fade, nothing to time. */
  `;

  function findTabBar() {
    return (
      document.querySelector("ytmusic-player-page tp-yt-paper-tabs.tab-header-container") ||
      document.querySelector("tp-yt-paper-tabs.tab-header-container") ||
      document.querySelector("ytmusic-player-page tp-yt-paper-tabs") ||
      document.querySelector("tp-yt-paper-tabs")
    );
  }

  /* ---- tab watcher -------------------------------------------------------
     YTM re-renders the watch page on track and route changes, which destroys the
     injected SYNCED tab, so a MutationObserver watches for its disappearance.

     Observing `ytmusic-app` with `subtree: true` means the callback fires on
     EVERY mutation anywhere in the app, and during playback YTM mutates
     constantly (progress bar, elapsed time, recommendations, queue). The old
     callback ran `findTabBar()` — up to four document-wide querySelectors — on
     every one of those, so its cost scaled with both YTM's mutation rate and its
     growing DOM. That is a genuine contributor to "FPS falls the longer the
     session runs", and unlike the animation-loop fix it is not bounded per song.

     Narrowing the observed root is NOT safe here: the re-render that removes the
     tab is exactly the one we must not miss. So the coverage stays identical and
     the callback is made cheap instead:
       1. Fast path — if our tab is still a direct child of the bar we mounted it
          into, nothing changed. One property read instead of four querySelectors.
          This is the overwhelmingly common case, so the steady-state cost is
          effectively zero.
       2. Coalesce — bursts of mutations collapse into a single check per frame. */
  let tabWatchRaf = 0;
  function tabWatcherNeedsMount() {
    // Steady state: our Lyrics tab is still mounted where we found it.
    if (tabEl && tabMountParent &&
      tabEl.parentElement === tabMountParent && tabMountParent.isConnected) {
      return false;
    }
    // Otherwise re-mount (initial mount, or YTM re-rendered the bar away). The
    // Lyrics tab is YTM's OWN now, so there is no marker class to look for.
    return true;
  }
  function runTabWatcher() {
    tabWatchRaf = 0;
    if (tabWatcherNeedsMount()) scheduleMountTab();
  }
  function onWatchMutations() {
    if (tabWatchRaf) return;
    tabWatchRaf = requestAnimationFrame(runTabWatcher);
  }

  /* ---- draggable overlay panel ---- */
  // Pointer events (not mouse events) so a drag works with touch as well, and
  // setPointerCapture on the panel so a fast drag that outruns the cursor still
  // tracks instead of dropping the panel mid-move. The first drag converts the
  // CSS anchor (top/right) into explicit left/top, so the panel continues from
  // wherever it currently sits rather than jumping to the pointer.
  function makeDraggable(panel, handle) {
    let dragging = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener("pointerdown", (event) => {
      // Let the close button and any real control inside the header behave
      // normally instead of starting a drag.
      if (event.target.closest("button, input, select, textarea, a")) return;
      const rect = panel.getBoundingClientRect();
      dragging = true;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.left = startLeft + "px";
      panel.style.top = startTop + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      try { panel.setPointerCapture(pointerId); } catch (_) {}
      event.preventDefault();
    });

    panel.addEventListener("pointermove", (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      panel.style.left = (startLeft + event.clientX - startX) + "px";
      panel.style.top = (startTop + event.clientY - startY) + "px";
    });

    const endDrag = (event) => {
      if (!dragging || (event && event.pointerId !== pointerId)) return;
      dragging = false;
      if (pointerId != null) {
        try { panel.releasePointerCapture(pointerId); } catch (_) {}
      }
      pointerId = null;
    };
    panel.addEventListener("pointerup", endDrag);
    panel.addEventListener("pointercancel", endDrag);
  }

  function buildUI() {
    // On extension reload Chrome re-injects the content script but does NOT remove
    // DOM we created earlier, so a stale (possibly open) panel/style from the previous
    // injection can linger. Clear any orphaned UI first so we always start clean and closed.
    const stalePanel = document.getElementById("ym-sl-panel");
    if (stalePanel) stalePanel.remove();
    const staleStyle = document.getElementById("ym-sl-style");
    if (staleStyle) staleStyle.remove();
    const staleFonts = document.getElementById("ym-sl-fonts");
    if (staleFonts) staleFonts.remove();
    // The options overlay is a <body> child, so it survives a panel rebuild and
    // would otherwise stack up as duplicates on every extension reload.
    const staleOptions = document.querySelector(".ym-sl-options-overlay");
    if (staleOptions) staleOptions.remove();
    // A rebuild (e.g. extension reload) orphaned the old panel; drop the stale
    // search popover reference and any in-flight request so we recreate cleanly.
    if (searchAbortController) {
      searchAbortController.abort();
      searchAbortController = null;
    }
    searchPanelEl = null;

    const style = document.createElement("style");
    style.id = "ym-sl-style";
    style.textContent = CSS;
    document.head.appendChild(style);
    fontLinkEl = document.createElement("link");
    fontLinkEl.id = "ym-sl-fonts";
    fontLinkEl.rel = "stylesheet";
    fontLinkEl.href = SPICY_LYRICS_FONT_CSS;
    document.head.appendChild(fontLinkEl);
    // Segmented control (AJ, 2026-10-19): a compact row of pill buttons for a small
    // set of choices — cleaner than a dropdown for 2-3 options. Exposes `.value`
    // (getter) + `.setValue()` so callers that read `el.value` keep working.
    const buildSegmentedControl = (config) => {
      const options = config.options || [];
      let current = config.value != null ? config.value : (options[0] ? options[0].value : "");
      const root = h("div", { class: "ym-sl-segmented" + (config.class ? " " + config.class : "") });
      const els = options.map((option) => {
        const el = h("button", {
          class: "ym-sl-segmented-option" + (option.value === current ? " active" : ""),
          type: "button",
          "data-value": option.value,
          text: option.label,
        });
        el.addEventListener("click", () => {
          if (current === option.value) return;
          current = option.value;
          els.forEach((x) => x.classList.toggle("active", x.getAttribute("data-value") === current));
          if (config.onChange) config.onChange(current);
        });
        root.appendChild(el);
        return el;
      });
      Object.defineProperty(root, "value", { get() { return current; } });
      root.setValue = (value) => {
        current = value;
        els.forEach((x) => x.classList.toggle("active", x.getAttribute("data-value") === current));
      };
      return root;
    };
    panelEl = h("div", { id: "ym-sl-panel", class: "ym-sl-panel hidden SpicyRenderer" });
    const trackEl = h("div", { id: "ym-sl-track", class: "ym-sl-track", text: "Synced Lyrics" });
    const importButton = h("button", {
      class: "ym-sl-import",
      type: "button",
      title: "Import TTML lyrics",
      "aria-label": "Import TTML lyrics",
      text: "Upload",
    });
    const importMode = buildSegmentedControl({
      "aria-label": "TTML import duration",
      value: "permanent",
      options: [
        { value: "permanent", label: "Permanent" },
        { value: "temporary", label: "Temporary" },
      ],
    });
    jumpButton = h("button", {
      class: "ym-sl-jump hidden",
      type: "button",
      title: "Jump to the currently playing lyric",
      "aria-label": "Jump to the currently playing lyric",
      text: "Jump to current",
    });
    jumpButton.addEventListener("click", onJumpButtonClick);
    const fileInput = h("input", {
      id: "ym-sl-file",
      type: "file",
      accept: ".ttml,.xml,application/ttml+xml",
      style: "display:none",
    });
    importButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) readFile(file, importMode.value);
      event.target.value = "";
    });

    const videoOffsetWrap = h("div", { class: "ym-sl-video-offset", title: "Shift lyric timing for this track" });
    const videoOffsetLabel = h("span", { text: "Offset" });
    // "Video vs Song" offset-scope picker removed (AJ, 2026-10-19):
    // recomputeActiveOffsetMode() already auto-switches the control between the
    // video/song slot by track type (music video vs audio-only), so the manual
    // override was redundant. The read-only .ym-sl-offset-applied badge still
    // shows which slot is active.
    // (+/- 60s each way — the clamp in setVideoOffsetMs enforces it.)
    // Offset range is +/- 60s — a full minute each way, raised from +/- 30s.
    // The SAME limit is declared in three places and they all have to agree:
    // here, the fullscreen pair in 08-fullscreen-controls.jsfrag, and the clamp
    // in setVideoOffsetMs (12-track-offset-sync.jsfrag). The clamp is the one
    // that actually ENFORCES it, so changing only the sliders would silently cap
    // the value back to 30s.
    const videoOffsetRange = h("input", {
      type: "range",
      min: "-60000",
      max: "60000",
      step: "100",
      value: "0",
      "aria-label": "Lyric offset",
    });
    const videoOffsetNumber = h("input", {
      type: "number",
      class: "ym-sl-offset-number",
      step: "0.1",
      min: "-60",
      max: "60",
      value: "0",
      title: "Offset in seconds (typed)",
      "aria-label": "Lyric offset in seconds",
    });
    const videoOffsetValue = h("span", { class: "ym-sl-video-offset-value", text: "0.0s" });
    const offsetApplied = h("span", { class: "ym-sl-offset-applied", text: "video" });
    videoOffsetWrap.append(videoOffsetLabel, videoOffsetRange, videoOffsetNumber, videoOffsetValue, offsetApplied);
    videoOffsetRange.addEventListener("input", () => {
      setVideoOffsetMs(Number(videoOffsetRange.value) || 0, true);
    });
    videoOffsetNumber.addEventListener("input", () => {
      const seconds = parseFloat(videoOffsetNumber.value);
      if (Number.isFinite(seconds)) setVideoOffsetMs(seconds * 1000, true);
    });

    const optionsButton = h("button", {
      class: "ym-sl-import ym-sl-options-button",
      type: "button",
      title: "Lyrics options — offset, import, and more",
      "aria-label": "Open lyrics options",
      text: "Options",
    });
    // NOTE: the panel's own "Fullscreen" button was removed here (AJ, 2026-10-02):
    // new users reach for YouTube Music's native fullscreen button, and that
    // button is wired to OUR fullscreen, so the panel duplicate only added a
    // second way in. enterFullscreenMode() is still reachable via the YTM path.
    const toolsScroll = h("div", { class: "ym-sl-tools-scroll" }, optionsButton);
    const tools = h("div", { class: "ym-sl-tools" }, toolsScroll);

    // The remaining controls (track, offset, import mode, upload) moved out of
    // the toolbar into a draggable overlay. The overlay is a child of <body> on
    // purpose: .ym-sl-panel sets container-type: size, which makes the panel a
    // containing block for fixed-position descendants and would trap + clip a
    // nested overlay (the panel also has overflow: hidden).
    const optionsOverlay = h("div", { class: "ym-sl-options-overlay hidden" });
    const optionsHeader = h("div", { class: "ym-sl-options-header" });
    const optionsTitle = h("span", { class: "ym-sl-options-title", text: "Options" });
    const optionsClose = h("button", {
      class: "ym-sl-options-close",
      type: "button",
      text: "\u00d7",
      title: "Close options",
      "aria-label": "Close options",
    });
    optionsHeader.append(optionsTitle, optionsClose);
    const optionsTop = h("div", { class: "ym-sl-options-section" });
    optionsTop.append(trackEl, videoOffsetWrap);
    const optionsDivider = h("hr", { class: "ym-sl-options-divider" });
    const optionsTtmlTitle = h("div", { class: "ym-sl-options-section-title", text: "TTML" });
    const optionsBottom = h("div", { class: "ym-sl-options-section" });
    const exportButton = h("button", {
      class: "ym-sl-import ym-sl-export-button",
      type: "button",
      title: "Download the imported TTML without applying the current offset",
      "aria-label": "Export imported TTML",
      text: "Export",
    });
    const exportSyncButton = h("button", {
      class: "ym-sl-import ym-sl-export-sync-button",
      type: "button",
      title: "Download the imported TTML with the current offset applied",
      "aria-label": "Export imported TTML with sync",
      text: "Export + sync",
    });
    const exportActions = h("div", { class: "ym-sl-export-actions hidden" }, exportButton, exportSyncButton);
    exportButton.addEventListener("click", () => exportImportedTTML(false));
    exportSyncButton.addEventListener("click", () => exportImportedTTML(true));
    deletePermanentButton = h("button", {
      class: "ym-sl-import ym-sl-delete-permanent-button hidden",
      type: "button",
      title: "Delete the permanently-saved TTML for this track",
      "aria-label": "Delete permanently saved TTML",
      text: "Delete saved",
    });
    deletePermanentButton.addEventListener("click", deletePermanentTTMLForCurrentTrack);
    optionsBottom.append(importMode, importButton, exportActions, deletePermanentButton);
    /* MV pause re-sync REMOVED entirely on AJ's call (2026-10-19): the section,
       the "Set pause point" picker, its editor, and the pick banner are all gone
       from the panel. The low-level offset machinery in 12-track-offset-sync is
       left in place but dormant — nothing calls enterPausePickMode() now, and
       every pauseUi/pauseBanner consumer is null-safe. */

    // (H) Cache section. Spicy Lyrics (API) results are cached for 3 days; this
    // exposes an explicit purge so a stale or wrong match can be cleared without
    // nuking unrelated LRCLIB data. Mirrors upstream's "Clear Stored Lyrics
    // Cache" row.
    const cacheDivider = h("hr", { class: "ym-sl-options-divider" });
    const cacheTitle = h("div", { class: "ym-sl-options-section-title", text: "Cache" });
    const cacheSection = h("div", { class: "ym-sl-options-section ym-sl-cache-section" });
    const cacheStatus = h("div", { class: "ym-sl-cache-status", text: "Spicy Lyrics results are cached for 3 days." });
    const cacheClear = h("button", {
      class: "ym-sl-import ym-sl-cache-clear",
      type: "button",
      "aria-label": "Clear Spicy Lyrics cache",
      text: "Clear cache",
    });
    // The button wipes the cache instantly and irreversibly, so gate it behind an
    // explicit confirmation: clicking "Clear cache" reveals an "Are you sure?" row
    // with a RED delete action (trash icon) + a Cancel. The user expected a
    // confirm step here and was surprised it fired immediately (AJ, 2026-10-19).
    const cacheConfirm = h("div", { class: "ym-sl-cache-confirm hidden" });
    const cacheConfirmText = h("div", {
      class: "ym-sl-cache-confirm-text",
      text: "Clear all cached lyrics? This cannot be undone.",
    });
    const cacheConfirmRow = h("div", { class: "ym-sl-cache-confirm-row" });
    const cacheDelete = h("button", {
      class: "ym-sl-cache-delete",
      type: "button",
      "aria-label": "Delete cached lyrics",
      title: "Delete cached lyrics",
    });
    // Trash-can icon (SVG, white on the red button via currentColor).
    const trashNS = "http://www.w3.org/2000/svg";
    const trashSvg = document.createElementNS(trashNS, "svg");
    trashSvg.setAttribute("viewBox", "0 0 24 24");
    trashSvg.setAttribute("class", "ym-sl-trash-icon");
    trashSvg.setAttribute("aria-hidden", "true");
    trashSvg.setAttribute("focusable", "false");
    const trashPath = document.createElementNS(trashNS, "path");
    trashPath.setAttribute("d", "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z");
    trashPath.setAttribute("fill", "currentColor");
    trashSvg.appendChild(trashPath);
    cacheDelete.append(trashSvg, document.createTextNode("Delete"));
    const cacheCancel = h("button", {
      class: "ym-sl-cache-cancel",
      type: "button",
      text: "Cancel",
      "aria-label": "Cancel clearing the cache",
    });
    cacheConfirmRow.append(cacheDelete, cacheCancel);
    cacheConfirm.append(cacheConfirmText, cacheConfirmRow);

    function showCacheConfirm() {
      cacheClear.classList.add("hidden");
      cacheConfirm.classList.remove("hidden");
      cacheDelete.focus();
    }
    function hideCacheConfirm() {
      cacheConfirm.classList.add("hidden");
      cacheClear.classList.remove("hidden");
    }
    cacheClear.addEventListener("click", () => {
      if (cacheClear.disabled) return;
      showCacheConfirm();
    });
    cacheCancel.addEventListener("click", () => hideCacheConfirm());
    cacheDelete.addEventListener("click", async () => {
      if (cacheDelete.disabled) return;
      cacheDelete.disabled = true;
      cacheCancel.disabled = true;
      cacheStatus.textContent = "Clearing…";
      try {
        const count = await spicyCacheEntryCount();
        await clearSpicyLyricsCache();
        cacheStatus.textContent = count
          ? `Cleared ${count} cached ${count === 1 ? "song" : "songs"}.`
          : "Nothing to clear — the cache was already empty.";
      } catch (error) {
        cacheStatus.textContent = "Could not clear the cache.";
        console.warn("[SpicyLyrics] clear cache failed:", error);
      }
      cacheDelete.disabled = false;
      cacheCancel.disabled = false;
      hideCacheConfirm();
    });
    cacheSection.append(cacheStatus, cacheClear, cacheConfirm);

    // ---- Options body: TABBED SIDE-RAIL (AJ, 2026-10-19) ------------------------
    // A vertical tab rail on the LEFT, the selected section's controls on the
    // RIGHT, one panel visible at a time. Reuses the addon settings panel's clean
    // spring — opacity + rise + a touch of blur, staggered per child — on open and
    // on every tab switch.
    const optionsBody = h("div", { class: "ym-sl-options-body ym-sl-options-tabbed" });
    const optionsRail = h("div", { class: "ym-sl-options-rail", role: "tablist", "aria-label": "Options sections" });
    const optionsPanels = h("div", { class: "ym-sl-options-panels" });

    const panelNowPlaying = h("div", { class: "ym-sl-options-panel", role: "tabpanel" },
      h("div", { class: "ym-sl-options-panel-title", text: "Now playing" }),
      trackEl
    );
    const panelSync = h("div", { class: "ym-sl-options-panel", role: "tabpanel" },
      h("div", { class: "ym-sl-options-panel-title", text: "Sync & timing" }),
      videoOffsetWrap
    );
    const panelFile = h("div", { class: "ym-sl-options-panel", role: "tabpanel" },
      h("div", { class: "ym-sl-options-panel-title", text: "Lyrics file" }),
      importMode,
      h("div", { class: "ym-sl-options-file-actions" }, deletePermanentButton, importButton),
      exportActions
    );
    const panelCache = h("div", { class: "ym-sl-options-panel", role: "tabpanel" },
      h("div", { class: "ym-sl-options-panel-title", text: "Cache" }),
      cacheSection
    );

    const optionSections = [
      { label: "Playing", panel: panelNowPlaying },
      { label: "Sync", panel: panelSync },
      { label: "File", panel: panelFile },
      { label: "Cache", panel: panelCache },
    ];
    // Options opens on Sync rather than Playing (AJ, 2026-10-20): Sync is what the
    // panel is opened for (offset + pause sync), so defaulting to Playing made
    // every visit start with a click. Index into optionSections above.
    const DEFAULT_OPTION_TAB = 1;

    const optionsMotionOK = () =>
      !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    // Panels absolutely overlap inside a fixed-height stack so switching fades the
    // old panel out, springs the new one in, and animates the container HEIGHT to
    // the new panel's size — no abrupt jump when a taller tab (e.g. File) opens.
    let panelsHeightRaf = 0;
    let panelsHeightEmptyTries = 0;
    const syncPanelsHeight = () => {
      const active = optionSections.find((section) => section.panel.classList.contains("active"));
      if (!active) return;
      const next = active.panel.offsetHeight;
      if (next) {
        panelsHeightEmptyTries = 0;
        optionsPanels.style.height = Math.ceil(next) + "px";
      } else if (panelsHeightEmptyTries < 8) {
        // Not laid out yet (fonts still loading, or measured too early). Retry for a
        // few frames instead of collapsing the stack to 0 and showing an EMPTY panel
        // — the intermittent "no content" bug (AJ, 2026-10-19). The CSS min-height
        // also floors it so it can never fully collapse.
        panelsHeightEmptyTries++;
        requestAnimationFrame(syncPanelsHeight);
      }
    };
    const scheduleSyncPanelsHeight = () => {
      if (panelsHeightRaf) return;
      panelsHeightRaf = requestAnimationFrame(() => { panelsHeightRaf = 0; syncPanelsHeight(); });
    };
    if (window.ResizeObserver) {
      // Keeps height in sync when a panel's content changes size after it is shown
      // (cache status text, Export/Saved rows appearing, etc.).
      const ro = new ResizeObserver(scheduleSyncPanelsHeight);
      optionSections.forEach((section) => ro.observe(section.panel));
    }
    // SpicyLyrics font load reflows line/row heights — resync once it settles.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(scheduleSyncPanelsHeight).catch(() => {});
    }
    window.addEventListener("resize", scheduleSyncPanelsHeight);
    // Same clean spring the addon settings panel uses (cubic-bezier(.34,1.4,.5,1)):
    // opacity + rise + a touch of blur, staggered per child. fromLeft slides the
    // rail in from the left; otherwise rows rise up with a blur.
    const staggerIn = (container, fromLeft) => {
      if (!container || !container.children || !optionsMotionOK()) return;
      Array.from(container.children).forEach((el, i) => {
        if (!el.animate) return;
        el.animate(
          fromLeft
            ? [{ opacity: 0, transform: "translateX(-16px)" }, { opacity: 1, transform: "none" }]
            : [{ opacity: 0, transform: "translateY(16px)", filter: "blur(7px)" },
               { opacity: 1, transform: "none", filter: "blur(0px)" }],
          { duration: 520, delay: 40 + i * 55, easing: "cubic-bezier(.34,1.4,.5,1)", fill: "backwards" }
        );
      });
    };

    const optionTabs = optionSections.map((section, index) => {
      const tab = h("button", {
        class: "ym-sl-options-tab" + (index === DEFAULT_OPTION_TAB ? " active" : ""),
        type: "button",
        role: "tab",
        "aria-selected": index === DEFAULT_OPTION_TAB ? "true" : "false",
        text: section.label,
      });
      if (index === DEFAULT_OPTION_TAB) section.panel.classList.add("active");
      optionsPanels.appendChild(section.panel);
      tab.addEventListener("click", () => {
        if (tab.classList.contains("active")) return;
        optionTabs.forEach((t) => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
        tab.classList.add("active");
        tab.setAttribute("aria-selected", "true");
        optionSections.forEach((s) => s.panel.classList.remove("active"));
        section.panel.classList.add("active");
        syncPanelsHeight(); // animate container height to the new panel
        staggerIn(section.panel, false); // clean spring on the newly shown panel
      });
      optionsRail.appendChild(tab);
      return tab;
    });

    optionsBody.append(optionsRail, optionsPanels);
    optionsOverlay.append(optionsHeader, optionsBody);
    // Size the stack to the default active panel (rAF so fonts/content settle).
    scheduleSyncPanelsHeight();
    // Entrance choreography used by the Options button (below).
    optionsOverlay._staggerOpen = () => {
      syncPanelsHeight();
      staggerIn(optionsRail, true);
      staggerIn(optionSections[DEFAULT_OPTION_TAB].panel, false);
    };
    optionsButton.addEventListener("click", () => {
      const opening = optionsOverlay.classList.contains("hidden");
      optionsOverlay.classList.toggle("hidden");
      if (opening) {
        refreshPermanentDeleteState();
        if (optionsOverlay._staggerOpen) optionsOverlay._staggerOpen();
      }
    });
    optionsClose.addEventListener("click", () => optionsOverlay.classList.add("hidden"));
    optionsOverlay._exportActions = exportActions;
    makeDraggable(optionsOverlay, optionsHeader);
    document.body.appendChild(optionsOverlay);
    const lyricsContainer = h("div", { class: "LyricsContainer" });
    const content = h("div", { class: "LyricsContent offline" });
    const scrollContainer = h("div", {
      class: "SpicyLyricsScrollContainer",
      "data-lyrics-type": "Syllable",
    });
    linesRoot = h("div", { class: "VirtualLyricsContainer" });
    linesRoot.appendChild(h("div", {
      class: "ym-sl-empty",
      text: "Drop a .ttml file here, or use Upload to load synced lyrics.",
    }));
    scrollContainer.appendChild(linesRoot);
    content.appendChild(scrollContainer);
    lyricsContainer.appendChild(content);
    panelEl.append(tools, fileInput, lyricsContainer, jumpButton);
    panelEl.addEventListener("dragover", (event) => {
      event.preventDefault();
      panelEl.classList.add("drag");
    });
    panelEl.addEventListener("dragleave", () => panelEl.classList.remove("drag"));
    panelEl.addEventListener("drop", (event) => {
      event.preventDefault();
      panelEl.classList.remove("drag");
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) readFile(file, importMode.value);
    });

    lineScrollEl = content;
    lineScrollEl.addEventListener("wheel", handleManualScrollIntent, { passive: true });
    lineScrollEl.addEventListener("touchstart", handleManualScrollIntent, { passive: true });
    lineScrollEl.addEventListener("pointerdown", handleManualScrollIntent, { passive: true });
    lineScrollEl.addEventListener("keydown", handleManualScrollKey);
    applySettings(currentSettings);
    document.body.appendChild(panelEl);
    refreshTrack();
    mountTab();
    startTick();

    const watchRoot = document.querySelector("ytmusic-app") ||
      document.querySelector("ytmusic-player-page");
    if (watchRoot) {
      wpObserver = new MutationObserver(onWatchMutations);
      wpObserver.observe(watchRoot, { childList: true, subtree: true });
    }
  }

  function mountPanel(bar) {
    // Inject INTO YTM's own tab content node (#tab-renderer), like the Better
    // Lyrics extension, so the lyrics sit truly inside the native Lyrics tab
    // rather than in a sibling panel. Falls back to the tab bar's parent.
    const renderer = document.querySelector("#tab-renderer");
    const host = renderer || (bar && bar.parentElement);
    // Never yank the panel back into the YTM tab while fullscreen is active —
    // it currently lives inside the fullscreen overlay. Same while the NPV
    // snippet has docked it into its own rail.
    if (!host || !panelEl || fsActive || externalHostActive) return;
    panelHost = host;
    if (panelEl.parentElement !== host) host.appendChild(panelEl);
  }

  function findPlayerVideo() {
    // NEVER fall back to a document-wide `document.querySelector("video")`.
    // While fullscreen is open, YTM's video has been reparented into
    // fsMediaHost — so both container selectors below stop matching, and that
    // fallback picked up the FIRST <video> in the document instead. On AJ's
    // Chrome that is another extension's 720x960 element, which reports
    // videoWidth > 0, so findPlayerVideo() claimed "a video is live" forever
    // (AJ, 2026-09-28; the trace caught vids[0] as a chrome-extension: source
    // alongside our own pane node at 0x0).
    // Consequence of the false positive: syncFsVideoMode() never got past its
    // `liveVideo && hasAttached` early return, so the MV -> cover-art detach
    // never ran — no cover card, no Kawarp, and the band never re-anchored.
    // ORDER MATTERS: our own reparented node first (it is the only candidate
    // once it is outside ytmusic-player), then YTM's containers for the case
    // where we do not own a video yet (the cover -> MV attach path).
    const video =
      (fsSavedVideo && fsSavedVideo.node) ||
      document.querySelector("ytmusic-player video") ||
      document.querySelector("#movie_player video");
    // A song with no music video still leaves an empty <video> in the DOM, so
    // only treat it as real media once it actually has frame dimensions. The
    // trace confirms YTM's recycled element drops to 0x0 on an audio-only
    // track, and that is exactly what lets the MV -> cover detach fire.
    return video && video.videoWidth > 0 ? video : null;
  }

  // Bump a YouTube image CDN URL to a larger size so the cover art fills the
  // fullscreen pane crisply instead of rendering as a tiny thumbnail. The CDN
  // accepts a trailing =wWIDTH-hHEIGHT hint and resizes server-side.
  function hiResArt(url) {
    if (!url || typeof url !== "string") return url;
    if (/=w\d+(-h\d+)?/.test(url)) return url.replace(/=w\d+(-h\d+)?/, "=w1024-h1024");
    return url + "=w1024-h1024";
  }

  function setFullscreenLyricsShadeTarget(target) {
    // Do not smooth this in JavaScript. The CSS opacity transition already
    // provides a short visual fade, while assigning the sampled value directly
    // prevents the old brightness sample from keeping a stale black gradient
    // visible after the video has returned to a dark or colorful frame.
    fsLyricsShadeTarget = Math.max(0, Math.min(0.9, target));
    fsLyricsShadeLevel = fsLyricsShadeTarget;
    if (fsOverlay) {
      const opacity = fsLyricsShadeLevel.toFixed(3);
      fsOverlay.style.setProperty("--ym-sl-fs-lyrics-shade-opacity", opacity);
      if (fsLyricsShade) fsLyricsShade.style.opacity = opacity;
    }
  }

  // Count "bright" pixels of ANY hue, not just near-white.
  // Perceptual luma weights green heavily (0.7152), so a vivid red scores only
  // ~54 and a vivid blue ~18 — both would be missed by a luma test even though
  // they wash out lyric text just as badly as white. HSV value (the max RGB
  // channel) treats saturated bright colours and near-white the same way, which
  // is the behaviour that actually protects readability.
  function getBrightResponse(pixels) {
    const BRIGHT_CHANNEL = 190;
    let bright = 0;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const red = pixels[i];
      const green = pixels[i + 1];
      const blue = pixels[i + 2];
      const max = red > green ? (red > blue ? red : blue) : (green > blue ? green : blue);
      if (max > BRIGHT_CHANNEL) bright++;
      count++;
    }
    return count ? bright / count : 0;
  }

  function applyFullscreenShadePixels(pixels, shadeAllowed) {
    const response = getBrightResponse(pixels);
    // Bright colours are far more common than near-white, so require a slightly
    // larger share of the panel before the gradient starts, then ramp to full.
    // Skipped when the lyrics are hidden/dimmed — the sample is then only
    // feeding the controls scrim below.
    if (shadeAllowed !== false) {
      const target = Math.max(0, Math.min(1, (response - 0.2) / 0.45)) * 0.9;
      setFullscreenLyricsShadeTarget(target);
    }
    setFullscreenBrightVideo(response);
  }

  // Toggle the controls scrim with hysteresis: ON above 0.5 bright-pixel share,
  // OFF below 0.38. The gap keeps a video that sits near the threshold from
  // flickering the scrim on and off every sample.
  function setFullscreenBrightVideo(response) {
    // The scrim is a Video Background thing only; ignore samples that were
    // taken purely for the MV side-layout lyric shade.
    if (fsLayoutMode !== "background") { clearFullscreenBrightVideo(); return; }
    let on = fsBrightVideo;
    if (!on && response > 0.5) on = true;
    else if (on && response < 0.38) on = false;
    if (on === fsBrightVideo) return;
    fsBrightVideo = on;
    if (fsOverlay) fsOverlay.classList.toggle("ym-sl-fs-bright-video", on);
  }

  function clearFullscreenBrightVideo() {
    if (!fsBrightVideo) return;
    fsBrightVideo = false;
    if (fsOverlay) fsOverlay.classList.remove("ym-sl-fs-bright-video");
  }

  // Opt-in MV lyric shade: a class on the overlay turns the readability shade
  // on in the SIDE layout too (see the .ym-sl-fs-mv-shade CSS rule). No-op
  // before the overlay exists; applyFullscreenLayout() re-syncs it on entry.
  function syncFsMvShadeClass() {
    if (!fsOverlay) return;
    fsOverlay.classList.toggle("ym-sl-fs-mv-shade", !!currentSettings.mvLyricsShade);
  }

  // True when the current layout should run the adaptive lyric shade: always in
  // Video Background, plus the SIDE layout for music videos when the opt-in
  // mvLyricsShade setting is on. Shared by the sampler and applyFullscreenLayout.
  function fsShadeLayoutActive() {
    if (fsLayoutMode === "background") return true;
    return !!currentSettings.mvLyricsShade && fsLayoutMode === "side" && hasFsVideo();
  }

  // Map the on-screen lyric band to sample-canvas coordinates.
  // The <video> fills the overlay and paints with object-fit: cover (changed
  // from contain on 2026-09-27 so the fullscreen MV pane no longer shows the
  // two black letterbox bands). Cover means the frame OVERFLOWS the overlay
  // instead of being letterboxed, so the scale factor is max() rather than
  // min() and the horizontal offset is negative. Sampling the raw frame by
  // screen percentage alone still drifts whenever the video aspect differs
  // from the overlay's, so convert the screen band (53%..100%, full height)
  // into frame pixels first, then scale into the canvas, which always holds
  // the whole frame.
  function getShadeSampleRect() {
    const fallback = { x: FS_SHADE_SAMPLE_X, y: 0, w: FS_SHADE_SAMPLE_SW, h: FS_SHADE_SAMPLE_H };
    // MV side layout: the lyrics sit over the AMBIENT CANVAS, which is a
    // full-stretch copy of the frame (drawBgFrame draws it to fill the canvas),
    // so screen x% maps straight to frame x%. The cover math below assumes the
    // video fills the overlay, which is only true in Video Background — use the
    // raw 53%..100% band here.
    if (fsLayoutMode !== "background") return fallback;
    const video = fsSavedVideo && fsSavedVideo.node;
    if (!fsOverlay || !video || !video.videoWidth || !video.videoHeight) return fallback;
    const overlayW = fsOverlay.clientWidth;
    const overlayH = fsOverlay.clientHeight;
    if (!overlayW || !overlayH) return fallback;

    // cover: the frame is scaled until it covers the overlay on both axes, so
    // the larger ratio wins and at least one axis overflows.
    const scale = Math.max(overlayW / video.videoWidth, overlayH / video.videoHeight);
    if (!(scale > 0)) return fallback;
    const contentW = video.videoWidth * scale;
    const offsetX = (overlayW - contentW) / 2;

    // Frame pixels covered by the on-screen lyric band.
    const fx0 = Math.max(0, Math.min(video.videoWidth, (overlayW * FS_SHADE_REGION_LEFT - offsetX) / scale));
    const fx1 = Math.max(0, Math.min(video.videoWidth, (overlayW - offsetX) / scale));
    if (fx1 <= fx0) return fallback;

    // Frame pixels -> canvas pixels (canvas is the whole frame, stretched).
    const sx = Math.floor((fx0 / video.videoWidth) * FS_SHADE_SAMPLE_W);
    const ex = Math.ceil((fx1 / video.videoWidth) * FS_SHADE_SAMPLE_W);
    const x = Math.max(0, Math.min(FS_SHADE_SAMPLE_W - 1, sx));
    const w = Math.max(1, Math.min(FS_SHADE_SAMPLE_W - x, ex - x));
    // Full height: the lyric band runs bottom to top.
    return { x, y: 0, w, h: FS_SHADE_SAMPLE_H };
  }

  function ensureFullscreenShadeCapture() {
    const video = fsSavedVideo && fsSavedVideo.node;
    if (!video || fsLyricsShadeStream || typeof video.captureStream !== "function") return false;
    try {
      fsLyricsShadeStream = video.captureStream();
      fsLyricsShadeTrack = fsLyricsShadeStream.getVideoTracks()[0] || null;
      if (!fsLyricsShadeTrack) return false;
      if (typeof MediaStreamTrackProcessor === "function") {
        fsLyricsShadeReader = new MediaStreamTrackProcessor({ track: fsLyricsShadeTrack }).readable.getReader();
      }
      if (typeof ImageCapture === "function") fsLyricsShadeCapture = new ImageCapture(fsLyricsShadeTrack);
      return !!(fsLyricsShadeReader || fsLyricsShadeCapture);
    } catch (_) {
      fsLyricsShadeReader = null;
      fsLyricsShadeCapture = null;
      fsLyricsShadeTrack = null;
      fsLyricsShadeStream = null;
      return false;
    }
  }

  async function sampleFullscreenLyricsBrightness() {
    if (fsLyricsShadeSampleInFlight) return;
    // The shade normally runs only in Video Background (lyrics over the
    // full-bleed video). The opt-in mvLyricsShade extends it to the SIDE
    // layout for music videos, where the lyrics sit over the blurred video
    // backdrop. Anywhere else there is nothing to measure: clear both the
    // lyric shade and the controls scrim.
    if (!fsActive || !fsShadeLayoutActive() || !fsSavedVideo) {
      setFullscreenLyricsShadeTarget(0);
      clearFullscreenBrightVideo();
      return;
    }
    // The LYRIC shade is pointless whenever the lyrics are not actually visible:
    // the manual hide toggle plus the intro / gap / final dim states all set the
    // lyric column to opacity:0 and show only the "..." dots, so a shade over a
    // bright video would read as a stray black band behind the dots. But the
    // CONTROLS scrim still needs a brightness reading in exactly that case (AJ:
    // bright video, lyrics hidden, controls invisible), so keep sampling and
    // only suppress the shade.
    const shadeAllowed =
      !fsLyricsHidden && !fsLyricsGapDimmed && !fsLyricsIntroDimmed && !fsLyricsFinalDimmed;
    if (!shadeAllowed) setFullscreenLyricsShadeTarget(0);
    const now = performance.now();
    if (now - fsLyricsShadeLastSampleAt < FS_LYRICS_SHADE_SAMPLE_MS) return;
    fsLyricsShadeLastSampleAt = now;
    const video = fsSavedVideo.node;
    if (!video.videoWidth || !video.videoHeight) return;
    if (!fsLyricsShadeCanvas) {
      fsLyricsShadeCanvas = document.createElement("canvas");
      fsLyricsShadeCanvas.width = FS_SHADE_SAMPLE_W;
      fsLyricsShadeCanvas.height = FS_SHADE_SAMPLE_H;
      fsLyricsShadeCtx = fsLyricsShadeCanvas.getContext("2d", { willReadFrequently: true });
    }
    fsLyricsShadeSampleInFlight = true;
    try {
      if (!fsLyricsShadeCanvasTainted && fsLyricsShadeCtx) {
        try {
          fsLyricsShadeCtx.drawImage(video, 0, 0, FS_SHADE_SAMPLE_W, FS_SHADE_SAMPLE_H);
          const rect = getShadeSampleRect();
          applyFullscreenShadePixels(
            fsLyricsShadeCtx.getImageData(rect.x, rect.y, rect.w, rect.h).data,
            shadeAllowed
          );
          return;
        } catch (_) {
          fsLyricsShadeCanvasTainted = true;
        }
      }
      if (!ensureFullscreenShadeCapture()) {
        setFullscreenLyricsShadeTarget(0);
        clearFullscreenBrightVideo();
        return;
      }
      let frame = null;
      if (fsLyricsShadeReader) {
        const result = await fsLyricsShadeReader.read();
        frame = result && result.value;
      } else if (fsLyricsShadeCapture) {
        frame = await fsLyricsShadeCapture.grabFrame();
      }
      if (!frame) {
        setFullscreenLyricsShadeTarget(0);
        clearFullscreenBrightVideo();
        return;
      }
      fsLyricsShadeCtx.drawImage(frame, 0, 0, FS_SHADE_SAMPLE_W, FS_SHADE_SAMPLE_H);
      const rect = getShadeSampleRect();
      applyFullscreenShadePixels(
        fsLyricsShadeCtx.getImageData(rect.x, rect.y, rect.w, rect.h).data,
        shadeAllowed
      );
      if (typeof frame.close === "function") frame.close();
    } catch (_) {
      setFullscreenLyricsShadeTarget(0);
      clearFullscreenBrightVideo();
    } finally {
      fsLyricsShadeSampleInFlight = false;
    }
  }

  function formatFullscreenOffset(ms) {
    const sign = ms > 0 ? "+" : "";
    return sign + (ms / 1000).toFixed(1) + "s";
  }

  // Paint the live <video> into the ambient backdrop canvas at ~1/6 overlay
  // resolution. The CSS blur on the canvas then smooths + scales it to fill
  // the entire overlay as the ambient backdrop. One drawImage per video frame
  // is all this costs; the heavy blur is applied once to a static layer
  // instead of re-blurring the live video every compositor frame. At a 64px
  // blur the 1/6 backing store is invisible, so this is free quality to trade
  // away for performance.
  function drawBgFrame() {
    if (!fsActive || !fsBgCanvas || !fsBgCtx || !fsSavedVideo || !fsSavedVideo.node) return;
    const now = performance.now();
    if (now - fsBgLastDrawAt < FS_BG_FRAME_INTERVAL_MS) return;
    fsBgLastDrawAt = now;
    const v = fsSavedVideo.node;
    if (!v.videoWidth || !v.videoHeight) return;
    // Publish the real frame aspect ratio so the CSS can size the media pane to
    // match it (see the .ym-sl-fs-has-video .ym-sl-fs-media rule). Matching the
    // ratios makes object-fit: cover a no-op, which is what removes the side
    // cropping without bringing back letterbox bars. Only written when it
    // changes, so this is not a per-frame style invalidation.
    if (fsOverlay) {
      const ar = v.videoWidth + " / " + v.videoHeight;
      if (fsOverlay.style.getPropertyValue("--ym-sl-fs-video-ar") !== ar) {
        fsOverlay.style.setProperty("--ym-sl-fs-video-ar", ar);
        // ⭐ A plain NUMBER alongside the ratio (AJ, 2026-10-21). CSS can divide
        // by a number but NOT by a "1920 / 960" token, so without this the chrome
        // could not be anchored to the video's bottom edge — it had to be
        // bottom-anchored to the viewport, which is why the gap under the video
        // changed with its aspect ratio. The pane is 50% wide and centred, so its
        // bottom edge is `50% + 25vw / ratio`.
        if (v.videoWidth > 0 && v.videoHeight > 0) {
          fsOverlay.style.setProperty(
            "--ym-sl-fs-video-ratio",
            String(v.videoWidth / v.videoHeight)
          );
        }
        // No re-measure here any more (AJ, 2026-10-20): the chrome positions are
        // fixed lengths, so a new aspect ratio only resizes the pane itself.
      }
    }
    const targetW = Math.max(2, Math.round(fsBgCanvas.clientWidth / 6));
    const targetH = Math.max(2, Math.round(fsBgCanvas.clientHeight / 6));
    if (fsBgCanvas.width !== targetW || fsBgCanvas.height !== targetH) {
      fsBgCanvas.width = targetW;
      fsBgCanvas.height = targetH;
    }
    try {
      // Bake the blur into the canvas instead of applying it with CSS. A
      // stylesheet filter on a <canvas> was being silently dropped in the live
      // build; ctx.filter is a canvas API and cannot be overridden by CSS, so
      // the result is deterministic. Blurring a ~320x180 backing store costs
      // almost nothing, and the upscale to fullscreen multiplies the radius:
      // 10px here renders as roughly 70px of blur on a 1080p overlay (turned
      // down from 18px / ~130px at AJ's request — still clearly blurred but
      // less heavy). Brightness is now user-controlled: the "Music video
      // backdrop brightness" slider in AURORA BLOOM feeds
      // currentSettings.backdropBrightness (default 1.15), delivered
      // cross-add-on via handleHostMessage.
      fsBgCtx.filter = "blur(10px) saturate(1.4) brightness(" + currentSettings.backdropBrightness + ")";
      fsBgCtx.drawImage(v, 0, 0, targetW, targetH);
      fsBgCtx.filter = "none";
    } catch (_) {
      try { fsBgCtx.filter = "none"; } catch (_e) {}
      // Direct draw can be blocked by cross-origin taint. The canvas keeps
      // its last frame, which is fine for an ambient backdrop.
    }
  }

  // Drive the backdrop redraw from the video's actual paint cadence so we
  // only do work when a new frame is available, and never compete with the
  // 60Hz lyrics animation loop.
  function startBgDrawLoop() {
    if (fsBgRaf) return;
    const v = fsSavedVideo && fsSavedVideo.node;
    if (v && typeof v.requestVideoFrameCallback === "function") {
      const loop = () => {
        if (!fsActive) return;
        drawBgFrame();
        fsBgRaf = v.requestVideoFrameCallback(loop);
      };
      fsBgRaf = v.requestVideoFrameCallback(loop);
    } else {
      const step = () => {
        fsBgRaf = null;
        if (!fsActive) return;
        drawBgFrame();
        fsBgRaf = requestAnimationFrame(step);
      };
      fsBgRaf = requestAnimationFrame(step);
    }
  }

  function stopBgDrawLoop() {
    const v = fsSavedVideo && fsSavedVideo.node;
    if (fsBgRaf) {
      if (v && typeof v.cancelVideoFrameCallback === "function") {
        try { v.cancelVideoFrameCallback(fsBgRaf); } catch (_) {}
      } else {
        cancelAnimationFrame(fsBgRaf);
      }
    }
    fsBgRaf = null;
  }

  function updateFullscreenGapDimming(lyricPositionMs, activeIndex) {
    if (!fsOverlay) return;
    const canDim = fsLayoutMode === "background" && !!fsSavedVideo;
    if (!canDim || !modelLines.length || !scrollCandidateIndices.length) {
      if (fsLyricsGapDimmed || fsLyricsIntroDimmed || fsLyricsFinalDimmed) {
        fsOverlay.classList.remove("ym-sl-fs-gap-dim", "ym-sl-fs-intro-dim", "ym-sl-fs-final-dim");
        fsLyricsGapDimmed = false;
        fsLyricsIntroDimmed = false;
        fsLyricsFinalDimmed = false;
      }
      return;
    }

    const activeLine = activeIndex >= 0 ? modelLines[activeIndex] : null;
    const finalHideDelay = currentLyricsIsTTML ? 0 : FS_FINAL_LYRICS_HIDE_MS;
    const finalExpired = cachedLastRealLyricEndMs > 0 &&
      lyricPositionMs >= cachedLastRealLyricEndMs + finalHideDelay;
    const beforeFirstLyric = Number.isFinite(cachedFirstRealLyricStartMs) &&
      lyricPositionMs < cachedFirstRealLyricStartMs;
    let shouldDim = beforeFirstLyric || finalExpired;

    if (!finalExpired && !beforeFirstLyric && activeLine && activeLine.DotLine) {
      // Later generated dot lines span instrumental gaps. Keep the lyrics
      // hidden until shortly before the next real lyric starts.
      shouldDim = activeLine.EndTime - lyricPositionMs > FS_LYRICS_RESTORE_LEAD_MS;
    } else if (!finalExpired && !beforeFirstLyric && !activeLine) {
      // A gap without generated dots: only dim when there is no active line AND a real next line.
      const previousLine = activeIndex > 0 ? modelLines[activeIndex - 1] : null;
      const nextLine = activeIndex >= 0 ? modelLines[activeIndex + 1] : null;
      const previousEnd = previousLine ? previousLine.EndTime : lyricPositionMs;
      const nextStart = nextLine ? nextLine.StartTime : Infinity;
      const gapMs = nextStart - previousEnd;
      shouldDim = Number.isFinite(nextStart) &&
        gapMs >= FS_LYRICS_GAP_DIM_MS &&
        nextStart - lyricPositionMs > FS_LYRICS_RESTORE_LEAD_MS;
    }

    if (shouldDim !== fsLyricsGapDimmed) {
      fsLyricsGapDimmed = shouldDim;
      fsOverlay.classList.toggle("ym-sl-fs-gap-dim", shouldDim);
    }
    if (beforeFirstLyric !== fsLyricsIntroDimmed) {
      fsLyricsIntroDimmed = beforeFirstLyric;
      fsOverlay.classList.toggle("ym-sl-fs-intro-dim", beforeFirstLyric);
    }
    if (finalExpired !== fsLyricsFinalDimmed) {
      fsLyricsFinalDimmed = finalExpired;
      fsOverlay.classList.toggle("ym-sl-fs-final-dim", finalExpired);
    }
    // No lyrics are on screen in any hidden / intro / gap / final state, so the
    // readability shade has nothing to protect. Clear it immediately so a bright
    // video doesn't leave a black band behind the "..." dots until the next
    // 240ms brightness sample. The sampler also guards on these flags, this just
    // removes the stale-gradient delay.
    if (fsLyricsHidden || fsLyricsGapDimmed || fsLyricsIntroDimmed || fsLyricsFinalDimmed) {
      setFullscreenLyricsShadeTarget(0);
    }
  }

  const FS_LAYOUT_NAMES = {
    side: "Video + Lyrics",
    background: "Video Background",
    lyrics: "Lyrics Only",
  };
  const FS_LAYOUT_ORDER = ["side", "background", "lyrics"];

  function hasFsVideo() {
    return !!(fsOverlay && fsOverlay.classList.contains("ym-sl-fs-has-video"));
  }

  // The "Video Background" mode blurs the live music video as a backdrop. For
  // audio-only tracks (cover art, no MV) there is nothing to use, so the cycle
  // button SKIPS it instead of offering a broken layout. AJ 2026-09-28.
  function nextFsLayoutMode(current) {
    const i0 = FS_LAYOUT_ORDER.indexOf(current);
    for (let step = 1; step <= FS_LAYOUT_ORDER.length; step++) {
      const cand = FS_LAYOUT_ORDER[(i0 + step) % FS_LAYOUT_ORDER.length];
      if (cand !== "background" || hasFsVideo()) return cand;
    }
    return "side";
  }

  /**
   * Spell out the current layout AND the next one in the cycle button's
   * tooltip. A cycle button has no open state to browse, so without this the
   * order would be unguessable.
   */
  function updateFsLayoutButtonTitle() {
    if (!fsLayoutSelect) return;
    const current = FS_LAYOUT_NAMES[fsLayoutMode] || fsLayoutMode;
    const nextMode = nextFsLayoutMode(fsLayoutMode);
    const next = FS_LAYOUT_NAMES[nextMode] || nextMode;
    const text = "Layout: " + current + " - click for " + next;
    fsLayoutSelect.title = text;
    fsLayoutSelect.setAttribute("aria-label", text);
    // Keep the text label in step too: music videos show the label rather than
    // the glyph, so it has to name the mode the user is actually on.
    const label = fsLayoutSelect.querySelector(".ym-sl-fs-btn-label");
    if (label) label.textContent = current;
  }

  function applyFullscreenLayout(mode) {
    if (!fsOverlay) return;
    // Belt-and-suspenders: never land on Video Background without an MV
    // (e.g. if savedMode was "background" and the track has no video).
    if (mode === "background" && !hasFsVideo()) mode = "side";
    fsLayoutMode = mode === "background" || mode === "lyrics" ? mode : "side";
    if (fsLayoutMode !== "background") {
      // The controls scrim only exists in Video Background; drop it at once
      // rather than waiting up to a sample tick to clear it.
      clearFullscreenBrightVideo();
      fsLyricsGapDimmed = false;
      fsLyricsIntroDimmed = false;
      fsLyricsFinalDimmed = false;
      fsOverlay.classList.remove("ym-sl-fs-gap-dim", "ym-sl-fs-intro-dim", "ym-sl-fs-final-dim");
    }
    // Clear the lyric shade only when the NEW layout cannot show it — the MV
    // side layout can, when mvLyricsShade is on.
    if (!fsShadeLayoutActive()) setFullscreenLyricsShadeTarget(0);
    // The column's left/width are CSS-transitioned (no frost re-measure needed).
    fsOverlay.classList.toggle("ym-sl-fs-mode-background", fsLayoutMode === "background");
    fsOverlay.classList.toggle("ym-sl-fs-mode-lyrics-only", fsLayoutMode === "lyrics");
    // Keep the opt-in MV-shade class in step with the setting on entry/switches.
    syncFsMvShadeClass();
    // The volume group's home and the edge buttons follow the composition, so
    // re-home them once per layout switch (AJ, 2026-10-20). Positions themselves
    // are static — this only moves the volume node between the chip and the
    // scrubber row, and re-pins the two edge buttons.
    syncFsChromeStructure();
    if (fsLayoutSelect) {
      // Now a button rather than a <select>, so the mode rides on the dataset
      // instead of .value, and the tooltip is refreshed so the announced
      // "current - next" pair stays accurate after every switch.
      if (fsLayoutSelect.dataset.layoutMode !== fsLayoutMode) {
        fsLayoutSelect.dataset.layoutMode = fsLayoutMode;
      }
      updateFsLayoutButtonTitle();
    }
    try { localStorage.setItem("better_lyrics_fullscreen_layout_v1", fsLayoutMode); } catch (_) {}
    recomputeActiveOffsetMode(true);
    // Switching layout resizes and moves the lyrics column with a CSS transition,
    // so the old scrollTop no longer centres the active line — and nothing
    // corrected it until the next line change happened to retarget the spring.
    // Hence "the camera doesn't stay on the active line". The window keeps
    // re-placing it for the length of the transition.
    recentreActiveLine();
  }

  function findPlayerButton(labels) {
    const bar = document.querySelector("ytmusic-player-bar");
    if (!bar) return null;
    const buttons = Array.from(bar.querySelectorAll("button, tp-yt-paper-icon-button"));
    return buttons.find((button) => {
      const text = [button.getAttribute("aria-label"), button.getAttribute("title"), button.id, button.textContent]
        .filter(Boolean).join(" ");
      return labels.some((label) => new RegExp(label, "i").test(text));
    }) || null;
  }

  function clickPlayerButton(kind) {
    // Shuffle / Repeat are ANCHORED with ^: the player bar holds unrelated
    // controls whose text can contain these words, whereas YTM's own buttons are
    // labelled "Shuffle" and "Repeat off" / "Repeat all" / "Repeat one" — so the
    // aria-label is always at the START of the joined text findPlayerButton builds.
    const labels = kind === "previous"
      ? ["previous", "back", "prev"]
      : kind === "next"
        ? ["next", "skip"]
        : kind === "shuffle"
          ? ["^shuffle"]
          : kind === "repeat"
            ? ["^repeat"]
            : ["play", "pause"];
    const button = findPlayerButton(labels);
    if (button) button.click();
  }

  function findPlayerVolumeRange() {
    return document.querySelector("ytmusic-player-bar tp-yt-paper-slider[aria-label*='volume' i]") ||
      document.querySelector("ytmusic-player-bar input[type='range'][aria-label*='volume' i]");
  }

  function setPlayerVolume(value) {
    const range = findPlayerVolumeRange();
    if (range) {
      range.value = String(clamp(value, 0, 100));
      range.dispatchEvent(new Event("input", { bubbles: true }));
      range.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function syncFullscreenVolumeControl() {
    if (!fsPlayerVolumeRange) return;
    const source = findPlayerVolumeRange();
    if (!source) return;
    const sourceValue = Number(source.value);
    const sourceMax = Number(source.max);
    if (!Number.isFinite(sourceValue) || !Number.isFinite(sourceMax) || sourceMax <= 0) return;
    const percent = clamp((sourceValue / sourceMax) * 100, 0, 100);
    // The track is a <div> (no .value). Skip while the user is driving it so the
    // 500ms refresh loop doesn't fight an in-progress drag/focus.
    if (document.activeElement !== fsPlayerVolumeRange) {
      fsPlayerVolumeValue = percent;
      fsPlayerVolumeRange.style.setProperty("--vol-fill", percent + "%");
      fsPlayerVolumeRange.setAttribute("aria-valuenow", String(percent));
    }
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.floor(Number(ms) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  // While the user is driving the seek bar the 500ms sync must not fight them.
  // This used to key off `document.activeElement !== fsPlayerSeekRange`, but a
  // range KEEPS focus after a click, so the guard never lifted: the thumb froze
  // wherever it was clicked while --slider-fill (written outside the guard)
  // kept advancing underneath it. Exactly AJ's 2026-09-28 report - "the dot
  // just stays there and doesnt follow the fill". A short timestamp window is
  // self-healing: a real drag refreshes it through the input event, and it
  // expires on its own if the pointerup is missed.
  const FS_SEEK_USER_GRACE_MS = 1200;
  let fsSeekUserAt = 0;

  function syncFullscreenSeekControl() {
    if (!fsPlayerSeekRange || !window.YTMod || !window.YTMod.player) return;
    const position = Number(window.YTMod.player.getPositionMs());
    const duration = Number(window.YTMod.player.getDurationMs());
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
    const percent = clamp((position / duration) * 100, 0, 100);
    if (performance.now() - fsSeekUserAt > FS_SEEK_USER_GRACE_MS) {
      fsPlayerSeekRange.value = String(position);
    }
    fsPlayerSeekRange.max = String(duration);
    fsPlayerSeekRange.style.setProperty("--slider-fill", percent + "%");
    if (fsTimeCurrent) fsTimeCurrent.textContent = formatClock(position);
    if (fsTimeTotal) fsTimeTotal.textContent = formatClock(duration);
  }

  /* ---- fullscreen loading spinner ----------------------------------------
     A track change can take a while (the lyrics fetch over the network, or the
     video buffering), and the fullscreen overlay has no other affordance for
     it - the lyrics skeleton only covers the lyrics column. So: after
     FS_SPINNER_DELAY_MS show a centred spinner, and fade it out the moment the
     lyrics land. 2s delay and a 0.4s fade are exactly what Spicy Lyrics uses
     for its own loader (fetchLyrics.ts: setTimeout(..., 2000), and
     LoaderContainer.css: transition opacity 0.4s ease-in-out), and the icon +
     spin are theirs too.
     Driven from the lyrics skeleton's lifecycle because that is the only
     reliable "this track is loading" signal the extension has. */
  const FS_SPINNER_DELAY_MS = 2000;
  let fsSpinnerEl = null;
  let fsSpinnerTimer = 0;

  function ensureFsSpinner() {
    if (fsSpinnerEl) return fsSpinnerEl;
    if (!fsOverlay) return null;
    fsSpinnerEl = h("div", { class: "ym-sl-fs-spinner", "aria-hidden": "true" });
    const svg = fsSvgIcon(FS_ICON_SPINNER, "0 0 24 24");
    // fsSvgIcon stamps the chrome's icon class, which is not what this is.
    svg.setAttribute("class", "ym-sl-fs-spinner-icon");
    fsSpinnerEl.appendChild(svg);
    // The PARENT is decided at SHOW time by placeFsSpinner(fsSpinnerTargetHost())
    // — it depends on which element is still loading, which is only known once
    // the spinner is about to become visible. It is appended there and not here
    // so a reparent can never happen while it is on screen.
    return fsSpinnerEl;
  }

  // Where the spinner belongs. It is armed by the lyrics skeleton, so while it
  // is showing the LYRICS are still loading, and the rule (AJ 2026-09-28) puts
  // it with the lyrics then — covering both "lyrics not loaded" and "both not
  // loaded". It only sits over the video pane when the VIDEO is the sole thing
  // still buffering (lyrics already landed). A track with no MV has nothing
  // pending on the media side, so it always goes with the lyrics.
  function fsSpinnerTargetHost() {
    const videoPending =
      hasFsVideo() && fsSavedVideo && fsSavedVideo.node && fsSavedVideo.node.videoWidth === 0;
    if (videoPending && !lyricsSkeletonShown) return fsMediaHost || fsOverlay;
    return fsLyricsHost || fsMediaHost || fsOverlay;
  }

  // Move the spinner into its host. Only ever called while it is HIDDEN
  // (opacity 0), so the move is invisible — that is why a plain appendChild is
  // safe here and needs no fade dance.
  function placeFsSpinner(host) {
    if (!fsSpinnerEl || !host) return;
    if (fsSpinnerEl.parentElement !== host) host.appendChild(fsSpinnerEl);
  }

  function showFsSpinnerSoon() {
    if (!fsActive) return;
    if (fsSpinnerTimer) window.clearTimeout(fsSpinnerTimer);
    fsSpinnerTimer = window.setTimeout(() => {
      fsSpinnerTimer = 0;
      if (!fsActive) return;
      const el = ensureFsSpinner();
      if (!el) return;
      placeFsSpinner(fsSpinnerTargetHost());
      // Force a style flush between the (possible) first insertion and the
      // class add, so the browser sees opacity 0 first and actually fades the
      // spinner IN rather than snapping it on. On later shows it is already in
      // the DOM, so this is a no-op reflow.
      void el.offsetWidth;
      el.classList.add("visible");
    }, FS_SPINNER_DELAY_MS);
  }

  function hideFsSpinner() {
    if (fsSpinnerTimer) { window.clearTimeout(fsSpinnerTimer); fsSpinnerTimer = 0; }
    if (fsSpinnerEl) fsSpinnerEl.classList.remove("visible");
  }

  function refreshFullscreenPlayerState() {
    if (!fsPlayerPlayButton) return;
    syncFullscreenSeekControl();
    if (!fsPlayerPlayButton) return;
    syncFullscreenVolumeControl();
    if (!fsPlayerPlayButton) return;
    const paused = window.YTMod && window.YTMod.player && window.YTMod.player.isPaused
      ? window.YTMod.player.isPaused()
      : null;
    // Only rebuild the glyph when the transport state actually flips. This
    // runs on a 500ms interval, so an unconditional replaceChildren would
    // recreate the SVG node twice a second for the whole session.
    const playState = paused === true ? "play" : (paused === false ? "pause" : "");
    if (playState && fsPlayerPlayButton.dataset.playState !== playState) {
      fsPlayerPlayButton.dataset.playState = playState;
      fsPlayerPlayButton.replaceChildren(
        playState === "play"
          ? fsSvgIcon(FS_ICON_PLAY, "0 0 18 20")
          : fsSvgIcon(FS_ICON_PAUSE, "0 0 15 20")
      );
      fsPlayerPlayButton.setAttribute("aria-label", playState === "play" ? "Play" : "Pause");
    }
    syncFullscreenModeButtons();
    refreshFsRatingState();
    // NOTE (AJ, 2026-10-20): the edge Like / Dislike buttons are no longer
    // re-pinned on this 500ms tick. Every chrome position is a fixed length now,
    // so there is nothing to chase; re-pinning was itself a source of the
    // "controls move a lot" behaviour. They are positioned once on entry and once
    // per mode change (syncFsChromeStructure).
  }

  /* ---- shuffle / repeat mirroring -----------------------------------------
     Both are TOGGLES, so the chip has to reflect YTM's real state or the buttons
     lie about it. YTM exposes that state differently per control:
       Repeat  -> aria-label "Repeat off" | "Repeat all" | "Repeat one"
       Shuffle -> aria-label STAYS "Shuffle" in both states; only the icon
                  brightens (grey -> white). So readPlayerToggle() falls back to
                  the live icon colour for shuffle.
     Read from the real control, not our own toggle state, so the buttons can
     never lie about the real YTM mode. */
  function readPlayerToggle(kind) {
    const bar = document.querySelector("ytmusic-player-bar");
    if (!bar) return null;
    const buttons = Array.from(bar.querySelectorAll("button, tp-yt-paper-icon-button"));
    const button = buttons.find((candidate) => {
      const text = [candidate.getAttribute("aria-label"), candidate.getAttribute("title"), candidate.id]
        .filter(Boolean).join(" ");
      return new RegExp("^" + kind, "i").test(text);
    });
    if (!button) return null;
    const label = (button.getAttribute("aria-label") || "").toLowerCase().trim();
    if (kind === "repeat") {
      if (/\boff\b/.test(label)) return "off";
      if (/\bone\b/.test(label)) return "one";
      return "all";
    }
    // Shuffle: YTM keeps the aria-label as "Shuffle" in BOTH states and only
    // brightens the icon (grey -> white), so the label-suffix trick does not
    // work here. Detect via the live icon colour. Older YTM builds that expose
    // aria-pressed, or append an "on" suffix, are handled first as fallbacks.
    const pressed = button.getAttribute("aria-pressed");
    if (pressed === "true") return "on";
    if (pressed === "false") return "off";
    if (label.replace(/^shuffle\b/, "").trim()) return "on";
    const colour = (window.getComputedStyle(button).color || "");
    const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(colour);
    if (m) {
      // off grey ~ rgb(144,144,144) (sum ~432); on white ~ rgb(255,255,255) (765).
      return (Number(m[1]) + Number(m[2]) + Number(m[3])) > 600 ? "on" : "off";
    }
    return "off";
  }

  function syncFullscreenModeButtons() {
    if (fsPlayerShuffleButton) {
      const on = readPlayerToggle("shuffle") === "on";
      fsPlayerShuffleButton.classList.toggle("active", on);
      fsPlayerShuffleButton.setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (!fsPlayerRepeatButton) return;
    const mode = readPlayerToggle("repeat") || "off";
    fsPlayerRepeatButton.classList.toggle("active", mode !== "off");
    fsPlayerRepeatButton.setAttribute("aria-pressed", mode !== "off" ? "true" : "false");
    fsPlayerRepeatButton.dataset.repeatMode = mode;
    fsPlayerRepeatButton.setAttribute(
      "title",
      mode === "off" ? "Repeat off" : mode === "one" ? "Repeat one" : "Repeat all"
    );
    // Swap the glyph only when the mode actually CHANGES. This runs on a 500ms
    // interval, so an unconditional replaceChildren would rebuild the SVG twice a
    // second for the whole session — the same reason the play button caches its
    // state rather than rewriting it.
    const wantOne = mode === "one";
    if (fsPlayerRepeatButton.dataset.repeatOne !== String(wantOne)) {
      fsPlayerRepeatButton.dataset.repeatOne = String(wantOne);
      fsPlayerRepeatButton.replaceChildren(
        fsSvgIcon(wantOne ? FS_ICON_REPEAT_ONE : FS_ICON_REPEAT, "0 0 24 24")
      );
    }
  }

  /* ---- fullscreen icon-pill chrome ----------------------------------------
     Spicy Lyrics' own icon set, ported over from
     src/components/Styling/Icons.ts so the no-video fullscreen row visually
     matches Ableton-parity chrome and the transport buttons match the upstream
     pill. Each icon is an array of {tag, attrs} parts so the builder can mix
     rects and paths without any innerHTML / DOMParser (Trusted-Types-safe).
     content.js svgIcon() lives in the isolated world and is NOT reachable
     from this page-world add-on, so the builder is duplicated here to keep
     the add-on self-contained. fill / stroke attrs are honoured per-part so
     outline icons (NoFill) and solid icons (PrevTrack/Play/Pause) both work.
     NO BACKTICKS IN THIS COMMENT BLOCK - it sits inside a template literal. */
  const FS_ICON_EXIT = [
    { tag: "path", attrs: { d: "M18 6 6 18", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" } },
    { tag: "path", attrs: { d: "m6 6 12 12", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" } },
  ];
  // LyricsManager from Spicy: rect with a vertical bar (the lyrics column)
  // and a folding diagonal that suggests a music note - visually reads as
  // "lyrics panel" without competing with the close / layout icons.
  const FS_ICON_LYRICS = [
    { tag: "rect", attrs: { x: "3", y: "3", width: "7", height: "18", rx: "1.5", fill: "none", stroke: "currentColor", "stroke-width": "2" } },
    { tag: "path", attrs: { d: "M6.5 3v18", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" } },
    { tag: "path", attrs: { d: "M14.5 3.7 13 4.3a1 1 0 0 0-.56 1.3l5.4 14.1a1 1 0 0 0 1.3.56l1.5-.6a1 1 0 0 0 .56-1.3L15.8 4.26a1 1 0 0 0-1.3-.56Z", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" } },
  ];
  // EnableCompactModeIcon reads as "cycle through layouts" - top row spans,
  // two rows of cells below, exactly the kind of grid the cycle button is
  // claiming it can rearrange.
  const FS_ICON_LAYOUT = [
    { tag: "rect", attrs: { x: "3", y: "3", width: "18", height: "7", rx: "1.5", fill: "none", stroke: "currentColor", "stroke-width": "2" } },
    { tag: "rect", attrs: { x: "3", y: "14", width: "7", height: "7", rx: "1.5", fill: "none", stroke: "currentColor", "stroke-width": "2" } },
    { tag: "rect", attrs: { x: "14", y: "14", width: "7", height: "7", rx: "1.5", fill: "none", stroke: "currentColor", "stroke-width": "2" } },
  ];
  // Sliders/adjust icon — reads as "options" (AJ, 2026-10-19). Opens the SAME
  // tabbed options overlay the normal panel uses, so fullscreen has it too.
  const FS_ICON_OPTIONS = [
    { tag: "line", attrs: { x1: "4", y1: "6", x2: "20", y2: "6", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" } },
    { tag: "circle", attrs: { cx: "9", cy: "6", r: "2.4", fill: "currentColor" } },
    { tag: "line", attrs: { x1: "4", y1: "12", x2: "20", y2: "12", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" } },
    { tag: "circle", attrs: { cx: "15", cy: "12", r: "2.4", fill: "currentColor" } },
    { tag: "line", attrs: { x1: "4", y1: "18", x2: "20", y2: "18", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" } },
    { tag: "circle", attrs: { cx: "7", cy: "18", r: "2.4", fill: "currentColor" } },
  ];
  // Solid-fill Spicy icons for the transport chip (Prev / Play / Pause /
  // Next). The path data is byte-for-byte from Icons.ts; only the wrapping
  // <svg> viewBox is normalised so the chip's square buttons can render it
  // without distorting the aspect ratio.
  const FS_ICON_PREV = [
    { tag: "path", attrs: { d: "M 19.467 19.905 C 20.008 19.905 20.463 19.746 21.005 19.426 L 33.61 12.023 C 34.533 11.482 35 10.817 35 9.993 C 35 9.158 34.545 8.53 33.61 7.977 L 21.005 0.574 C 20.463 0.254 19.998 0.094 19.456 0.094 C 18.374 0.094 17.475 0.917 17.475 2.418 L 17.475 9.49 C 17.315 8.898 16.873 8.408 16.135 7.977 L 3.529 0.574 C 3 0.254 2.533 0.094 1.993 0.094 C 0.911 0.094 0 0.917 0 2.418 L 0 17.582 C 0 19.083 0.91 19.906 1.993 19.906 C 2.533 19.906 3 19.746 3.529 19.426 L 16.135 12.023 C 16.861 11.593 17.315 11.088 17.475 10.485 L 17.475 17.582 C 17.475 19.083 18.386 19.906 19.467 19.906 L 19.467 19.905 Z", fill: "currentColor", "fill-rule": "nonzero" } },
  ];
  const FS_ICON_NEXT = [
    { tag: "path", attrs: { d: "M 19.467 19.905 C 20.008 19.905 20.463 19.746 21.005 19.426 L 33.61 12.023 C 34.533 11.482 35 10.817 35 9.993 C 35 9.158 34.545 8.53 33.61 7.977 L 21.005 0.574 C 20.463 0.254 19.998 0.094 19.456 0.094 C 18.374 0.094 17.475 0.917 17.475 2.418 L 17.475 9.49 C 17.315 8.898 16.873 8.408 16.135 7.977 L 3.529 0.574 C 3 0.254 2.533 0.094 1.993 0.094 C 0.911 0.094 0 0.917 0 2.418 L 0 17.582 C 0 19.083 0.91 19.906 1.993 19.906 C 2.533 19.906 3 19.746 3.529 19.426 L 16.135 12.023 C 16.861 11.593 17.315 11.088 17.475 10.485 L 17.475 17.582 C 17.475 19.083 18.386 19.906 19.467 19.906 L 19.467 19.905 Z", fill: "currentColor", "fill-rule": "nonzero" } },
  ];
  const FS_ICON_PLAY = [
    { tag: "path", attrs: { d: "M 1.558 20 C 2.006 20 2.381 19.838 2.874 19.561 L 16.622 11.572 C 17.527 11.053 17.894 10.65 17.894 9.997 C 17.894 9.35 17.527 8.948 16.622 8.419 L 2.874 0.439 C 2.381 0.153 2.006 0 1.558 0 C 0.706 0 0.106 0.654 0.106 1.694 L 0.106 18.298 C 0.106 19.346 0.706 20 1.558 20 L 1.558 20 Z", fill: "currentColor", "fill-rule": "nonzero" } },
  ];
  // Pause is two vertical bars in one path; keep them as a single d so the
  // builder sees exactly one part (the same way Spicy's Icons.ts does).
  const FS_ICON_PAUSE = [
    { tag: "path", attrs: { d: "M 4.427 19.963 C 5.513 19.963 6.06 19.416 6.06 18.33 L 6.06 1.66 C 6.06 0.545 5.513 0.037 4.427 0.037 L 1.633 0.037 C 0.548 0.037 0 0.575 0 1.66 L 0 18.331 C -0.009 19.416 0.538 19.963 1.633 19.963 L 4.427 19.963 Z M 13.377 19.963 C 14.462 19.963 15 19.416 15 18.33 L 15 1.66 C 15 0.545 14.462 0.037 13.376 0.037 L 10.573 0.037 C 9.487 0.037 8.949 0.575 8.949 1.66 L 8.949 18.331 C 8.949 19.416 9.487 19.963 10.573 19.963 L 13.376 19.963 L 13.377 19.963 Z", fill: "currentColor", "fill-rule": "nonzero" } },
  ];
  // Shuffle / Repeat / Repeat-one for the transport chip. These are NOT from
  // Icons.ts — Spicy's transport set has no equivalent — so they are plain 24x24
  // solid paths, square like the chip's own buttons, and Repeat-one carries its
  // state in the glyph rather than needing a second badge.
  const FS_ICON_SHUFFLE = [
    { tag: "path", attrs: { d: "M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z", fill: "currentColor", "fill-rule": "nonzero" } },
  ];
  const FS_ICON_REPEAT = [
    { tag: "path", attrs: { d: "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z", fill: "currentColor", "fill-rule": "nonzero" } },
  ];
  const FS_ICON_REPEAT_ONE = [
    { tag: "path", attrs: { d: "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z", fill: "currentColor", "fill-rule": "nonzero" } },
  ];
  // Spicy Lyrics' Volume SVG, namespaced so it does not collide with the
  // upstream extension if both happen to load. All four sub-paths ship at once
  // and CSS toggles their visibility based on .ym-sl-fs-volume-{muted,low,high}
  // on the button - the level decides the glyph exactly the way Spicy's
  // .VolumeControl does (one markup, three states, no re-render on volume
  // change).
  // Spicy Lyrics' Spinner icon (Icons.ts), byte-for-byte: eight round-capped
  // spokes on a 24x24 grid. Spun by their SL_spin keyframes - 0.8s linear,
  // infinite - which is the animation their own loading UI uses.
  const FS_ICON_SPINNER = [
    { tag: "path", attrs: { d: "M12 3v3" } },
    { tag: "path", attrs: { d: "M12 18v3" } },
    { tag: "path", attrs: { d: "M21 12h-3" } },
    { tag: "path", attrs: { d: "M6 12H3" } },
    { tag: "path", attrs: { d: "m18.36 5.64-2.12 2.12" } },
    { tag: "path", attrs: { d: "m7.76 16.24-2.12 2.12" } },
    { tag: "path", attrs: { d: "m18.36 18.36-2.12-2.12" } },
    { tag: "path", attrs: { d: "m7.76 7.76-2.12-2.12" } },
  ].map((part) => ({
    tag: part.tag,
    attrs: Object.assign({
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }, part.attrs),
  }));

  function fsSvgIcon(parts, viewBox) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", viewBox || "0 0 24 24");
    // Carries the icon class so the no-video variant can show the glyph and the
    // music-video variant can show the text label instead.
    svg.setAttribute("class", "ym-sl-fs-btn-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const el = document.createElementNS(NS, part.tag);
      const attrs = part.attrs || {};
      for (const k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) {
          el.setAttribute(k, attrs[k]);
        }
      }
      svg.appendChild(el);
    }
    return svg;
  }

  /* ---- like / dislike buttons in fullscreen --------------------------------
     AJ (2026-10-08, evening): drop the YTM-native mirroring entirely. The old
     build cloned YTM's icon and mirrored its like-status every 500ms, which
     flickered and showed a permanently-filled thumb (YTM's aria-pressed is
     unreliable). These buttons are now 100% OURS: our own glyph, our own state,
     our own persistence. We STILL fire YTM's real rating (updateLikeStatus) as a
     best-effort sync so the like persists to the YouTube account, but our visual
     state is the sole source of truth and never reads YTM's renderer for display.

     State lives in window.localStorage keyed by the current videoId (the `v` URL
     param — available in the page world, unlike chrome.storage). On video change
     the buttons re-seed from that saved map; a one-time seed from YTM's
     like-status lets a like made on the native bar show up once. No per-tick YTM
     reads, so no flicker. */

  const FS_RATINGS_KEY = "ytmod_spicy_lyrics_fs_ratings";
  let fsRatings = loadFsRatings();          // { [videoId]: "like" | "dislike" }
  let fsCurrentFsVideoId = null;            // last videoId we painted for

  function loadFsRatings() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(FS_RATINGS_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === "object" ? obj : {};
    } catch (_) {
      return {};
    }
  }
  function saveFsRatings() {
    try {
      if (window.localStorage) window.localStorage.setItem(FS_RATINGS_KEY, JSON.stringify(fsRatings));
    } catch (_) {}
  }
  function getCurrentFsVideoId() {
    try {
      const v = new URLSearchParams(window.location.search).get("v");
      return v || null;
    } catch (_) {
      return null;
    }
  }
  function getFsRating(videoId) {
    if (!videoId) return null;
    return fsRatings[videoId] || null;      // "like" | "dislike" | null
  }

  // Pin the Like / Dislike to the MEDIA PANE's left/right edges, but on the
  // CONTROLS ROW's vertical centre (AJ, 2026-10-18).
  //
  // The buttons live in .ym-sl-fs-player-controls (inset:0 over the overlay,
  // z-index 21) rather than inside .ym-sl-fs-media. Two reasons:
  //   1. .ym-sl-fs-media is z-index 2 and .ym-sl-fs-lyrics is z-index 3, so a
  //      button parented to the media is painted UNDER the lyrics pane and the
  //      dislike disappeared behind the lyrics in side layout (AJ's report).
  //      The controls layer is above everything.
  //   2. The controls layer is a full-overlay layer, so we can compute BOTH the
  //      media's horizontal edges and the transport chip's vertical centre in
  //      the same coordinate space.
  //
  // Horizontal: media pane edges (so they track cover art / MV width).
  // Vertical:   the play chip's centre (so they sit on the same line as the
  //             transport controls, not floating at the video's mid-height).
  // Sum of offsetTop from `node` up to `ancestor`, in LAYOUT space. Returns null
  // when `ancestor` is not in the offsetParent chain, so the caller can fall back
  // to rect maths. Used to measure past an in-flight transform.
  function offsetWithin(node, ancestor) {
    let y = 0;
    let el = node;
    while (el && el !== ancestor) {
      y += el.offsetTop || 0;
      el = el.offsetParent;
    }
    return el === ancestor ? y : null;
  }

  function positionFsEdgeButtons() {
    if (!fsPlayerLikeButton || !fsPlayerDislikeButton) return;
    const layer = fsPlayerControls;
    const media = document.querySelector(".ym-sl-fs-media");
    if (!layer || !media) return;
    const lc = layer.getBoundingClientRect();
    const mc = media.getBoundingClientRect();
    if (!lc.width || !lc.height || !mc.width) return;
    const pad = 14, bW = 44, bH = 44;
    const left = mc.left - lc.left + pad;
    const right = mc.right - lc.left - pad - bW;
    // Vertical: centre on the transport chip. Its rect is valid even while the
    // chip is faded out (opacity does not affect layout). Fall back to the
    // chip's own CSS bottom offset (46px) if it is not in the DOM yet.
    //
    // ⭐ LAYOUT offsets, not getBoundingClientRect (AJ, 2026-10-20). The chip
    // animates with a TRANSFORM during fullscreen entry and on track change, and
    // a rect includes that transform — so measuring mid-animation pinned the
    // buttons to a half-slid position ("sometimes random, sometimes lower") until
    // something re-ran this several seconds later. offsetTop is transform-free.
    const chip = layer.querySelector(".ym-sl-fs-play-chip");
    let top;
    if (chip) {
      const rel = offsetWithin(chip, layer);
      top = rel === null
        // Not in the offsetParent chain of the layer (some intermediate positioned
        // wrapper): fall back to the rects, which is still correct at rest.
        ? (() => {
            const cc = chip.getBoundingClientRect();
            return cc.top - lc.top + cc.height / 2 - bH / 2;
          })()
        : rel + chip.offsetHeight / 2 - bH / 2;
    } else {
      top = lc.height - 46 - bH / 2;
    }
    for (const btn of [fsPlayerLikeButton, fsPlayerDislikeButton]) {
      btn.style.position = "absolute";
      btn.style.top = top + "px";
    }
    fsPlayerLikeButton.style.left = left + "px";
    fsPlayerDislikeButton.style.left = right + "px";
  }

  // Our OWN thumb glyph: outline by default (fill:none, stroke:currentColor).
  // CSS fills it when .active (see 05-styles.jsfrag). Not cloned from YTM.
  function fsThumbSvg(kind) {
    const d = kind === "like"
      ? "M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"
      : "M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2h-1zm4 0v12h4V3h-4z";
    return fsSvgIcon(
      [{ tag: "path", attrs: { d, fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linejoin": "round", "stroke-linecap": "round" } }],
      "0 0 24 24"
    );
  }

  // YTM renderer — used ONLY for the best-effort real-rating sync, never for our
  // visual state. updateLikeStatus is the only way to rate without firing a DOM
  // click (which would trigger smooth-motion's emoji particles).
  function getYtmLikeRenderer() {
    const bar = document.querySelector("ytmusic-player-bar");
    if (!bar) return null;
    return bar.querySelector("ytmusic-like-button-renderer") || null;
  }
  function getYtmLikeStatus() {
    // Reliable, label-independent (INDIFFERENT / LIKE / DISLIKE). Used only to
    // converge YTM to our state and for the one-time seed — NOT as our truth.
    const renderer = getYtmLikeRenderer();
    if (!renderer) return "INDIFFERENT";
    const attr = renderer.getAttribute("like-status");
    if (attr) return attr.toUpperCase();
    const prop = renderer.likeStatus;
    if (prop) return String(prop).toUpperCase();
    return "INDIFFERENT";
  }

  function applyFsRatingToButtons(videoId) {
    if (!fsPlayerLikeButton || !fsPlayerDislikeButton) return;
    const state = getFsRating(videoId);
    const likeOn = state === "like";
    const dislikeOn = state === "dislike";
    fsPlayerLikeButton.classList.toggle("active", likeOn);
    fsPlayerLikeButton.setAttribute("aria-pressed", likeOn ? "true" : "false");
    fsPlayerDislikeButton.classList.toggle("active", dislikeOn);
    fsPlayerDislikeButton.setAttribute("aria-pressed", dislikeOn ? "true" : "false");
  }

  // Best-effort: converge YTM's REAL like to our state. Our visual never waits on
  // this. NOTE: disliking on YTM advances the queue (native YTM behaviour) — that
  // is expected when syncing a real dislike.
  function syncFsRatingToYtm(target) {
    const renderer = getYtmLikeRenderer();
    if (!renderer || typeof renderer.updateLikeStatus !== "function") return;
    const current = getYtmLikeStatus();
    try {
      if (target === "like" && current !== "LIKE") renderer.updateLikeStatus("LIKE");
      else if (target === "dislike" && current !== "DISLIKE") renderer.updateLikeStatus("DISLIKE");
      else if (target === null && (current === "LIKE" || current === "DISLIKE")) renderer.updateLikeStatus(current);
    } catch (_) { /* visual state is authoritative; ignore YTM sync failure */ }
  }

  function clickFsRating(kind) {
    const videoId = getCurrentFsVideoId();
    if (!videoId) return;
    const current = getFsRating(videoId);
    // Toggle: pressing the active one clears it; pressing the other switches.
    const newState = current === kind ? null : kind;
    if (newState === null) delete fsRatings[videoId];
    else fsRatings[videoId] = newState;
    saveFsRatings();
    applyFsRatingToButtons(videoId);
    syncFsRatingToYtm(newState);
  }

  // Called on the 500ms tick AND on build. Only does work when the video changes:
  // re-seed our buttons from saved state (one-time seed from YTM for videos we
  // haven't rated ourselves). No per-tick YTM reads, so no flicker.
  function refreshFsRatingState() {
    const videoId = getCurrentFsVideoId();
    if (!videoId) return;
    if (videoId !== fsCurrentFsVideoId) {
      fsCurrentFsVideoId = videoId;
      if (fsRatings[videoId] === undefined) {
        const yt = getYtmLikeStatus();
        if (yt === "LIKE" || yt === "DISLIKE") fsRatings[videoId] = yt.toLowerCase();
      }
      applyFsRatingToButtons(videoId);
    }
  }
  // (Like/Dislike handlers are defined above: clickFsRating() and
  // refreshFsRatingState(). The old YTM-mirroring functions were removed
  // 2026-10-08 — our buttons no longer read YTM's renderer for display.)

  function buildFullscreenControls() {
    if (!fsOverlay || fsControls) return;
    const exit = h(
      "button",
      {
        type: "button",
        class: "ym-sl-fs-icon-btn",
        title: "Exit fullscreen",
        "aria-label": "Exit fullscreen",
      },
      h("span", { class: "ym-sl-fs-btn-label", text: "Exit fullscreen" }),
      fsSvgIcon(FS_ICON_EXIT),
    );
    // Layout is a cycle button rather than a <select>: a native select cannot
    // be an icon, and the pill row has no space for its text. The tooltip
    // carries the current mode AND the next one so the order stays discoverable
    // without opening anything. applyFullscreenLayout() syncs the label.
    fsLayoutSelect = h(
      "button",
      {
        type: "button",
        class: "ym-sl-fs-icon-btn ym-sl-fs-layout-btn",
        title: "Fullscreen layout",
        "aria-label": "Fullscreen layout",
      },
      h("span", { class: "ym-sl-fs-btn-label", text: "Layout" }),
      fsSvgIcon(FS_ICON_LAYOUT),
    );
    const offsetWrap = h("div", { class: "ym-sl-fs-control-offset" });
    const offsetLabelFs = h("span", { text: "Offset" });
    const offsetScopeFs = h("select", { class: "ym-sl-offset-scope", title: "Apply offset to", "aria-label": "Offset applies to" });
    offsetScopeFs.append(
      h("option", { value: "video", text: "Video" }),
      h("option", { value: "song", text: "Song" })
    );
    offsetScopeFs.value = editingOffsetMode;
    // +/- 60s, kept in step with the options panel (06-panel-ui.jsfrag) and the
    // clamp in 12-track-offset-sync.jsfrag.
    fsOffsetRange = h("input", {
      type: "range", min: "-60000", max: "60000", step: "100",
      value: "0", "aria-label": "Lyric offset",
    });
    const fsOffsetNumber = h("input", {
      type: "number", class: "ym-sl-offset-number", step: "0.1", min: "-60", max: "60",
      value: "0", "aria-label": "Lyric offset in seconds", title: "Offset in seconds (typed)",
    });
    fsOffsetValue = h("span", { class: "ym-sl-fs-control-offset-value", text: "0.0s" });
    const fsOffsetApplied = h("span", { class: "ym-sl-offset-applied", text: "video" });
    offsetWrap.append(offsetLabelFs, offsetScopeFs, fsOffsetRange, fsOffsetNumber, fsOffsetValue, fsOffsetApplied);
    offsetScopeFs.addEventListener("change", () => {
      editingOffsetMode = offsetScopeFs.value;
      refreshVideoOffsetControl();
    });
    fsLyricsToggle = h(
      "button",
      {
        type: "button",
        class: "ym-sl-fs-icon-btn ym-sl-fs-lyrics-toggle",
        title: "Show or hide lyrics",
        "aria-label": "Hide lyrics",
      },
      h("span", { class: "ym-sl-fs-btn-label", text: "Hide lyrics" }),
      fsSvgIcon(FS_ICON_LYRICS),
    );
    // Options button (AJ, 2026-10-19): fullscreen now reuses the SAME tabbed
    // options overlay as the normal panel (it is a <body> child floated at a higher
    // z-index), so no duplicate FS overlay is needed. offsetWrap (built above) stays
    // a local unused variable; the overlay's Sync tab carries the offset.
    fsOptionsButton = h(
      "button",
      {
        type: "button",
        class: "ym-sl-fs-icon-btn ym-sl-fs-options-btn",
        title: "Options",
        "aria-label": "Open lyrics options",
      },
      h("span", { class: "ym-sl-fs-btn-label", text: "Options" }),
      fsSvgIcon(FS_ICON_OPTIONS),
    );
    fsOptionsButton.addEventListener("click", () => {
      const overlay = document.querySelector(".ym-sl-options-overlay");
      if (!overlay) return;
      const opening = overlay.classList.contains("hidden");
      overlay.classList.toggle("hidden");
      if (opening && overlay._staggerOpen) overlay._staggerOpen();
    });
    // Order: Exit (left) · Hide lyrics · Layout · Options (right). Cycling the
    // layout must never sit next to Exit, or a mis-click exits fullscreen
    // (AJ, 2026-10-19).
    fsControls = h("div", { class: "ym-sl-fs-controls" }, exit, fsLyricsToggle, fsLayoutSelect, fsOptionsButton);
    // Transport buttons use Spicy Lyrics' own solid icons. Prev is the same
    // TrackSkip path as Next, rotated 180deg - exactly how upstream does it
    // (.PlaybackControl.TrackSkip.PrevTrack { rotate: 180deg }).
    const prevIcon = fsSvgIcon(FS_ICON_PREV, "0 0 35 20");
    prevIcon.style.transform = "rotate(180deg)";
    const previousButton = h("button", { class: "ym-sl-fs-player-prev", type: "button", title: "Previous song", "aria-label": "Previous song" }, prevIcon);
    const playButton = h("button", { class: "ym-sl-fs-player-play", type: "button", title: "Play or pause", "aria-label": "Play or pause" }, fsSvgIcon(FS_ICON_PAUSE, "0 0 15 20"));
    const nextButton = h("button", { class: "ym-sl-fs-player-next", type: "button", title: "Next song", "aria-label": "Next song" }, fsSvgIcon(FS_ICON_NEXT, "0 0 35 20"));
    // Shuffle and Repeat FLANK the transport, the way every other player does it.
    // Both are TOGGLES, so refreshFullscreenPlayerState() mirrors YTM's own state
    // onto them on the 500ms tick — see syncFullscreenModeButtons().
    const shuffleButton = h("button", { class: "ym-sl-fs-player-shuffle", type: "button", title: "Shuffle", "aria-label": "Shuffle", "aria-pressed": "false" }, fsSvgIcon(FS_ICON_SHUFFLE, "0 0 24 24"));
    const repeatButton = h("button", { class: "ym-sl-fs-player-repeat", type: "button", title: "Repeat", "aria-label": "Repeat", "aria-pressed": "false" }, fsSvgIcon(FS_ICON_REPEAT, "0 0 24 24"));
    fsPlayerShuffleButton = shuffleButton;
    fsPlayerRepeatButton = repeatButton;
    // Like / Dislike sit on the MEDIA PANE's left/right edges, but on the
    // CONTROLS ROW's vertical centre (AJ, 2026-10-18). They are appended into
    // .ym-sl-fs-player-controls (z-index 21) so they paint above the lyrics
    // pane; positionFsEdgeButtons() computes the media's horizontal edges and
    // the transport chip's vertical centre. These are our OWN buttons (see the
    // like/dislike section): our own glyph, our own state, our own persistence.
    // The click fires YTM's real rating as a best-effort sync, but our visual
    // state is the source of truth and never reads YTM's renderer. Our glyph is
    // drawn here (outline; CSS fills it when .active).
    const likeButton = h("button", { class: "ym-sl-fs-player-like ym-sl-fs-player-like--edge", type: "button", title: "Like", "aria-label": "Like", "aria-pressed": "false" }, fsThumbSvg("like"));
    const dislikeButton = h("button", { class: "ym-sl-fs-player-dislike ym-sl-fs-player-dislike--edge", type: "button", title: "Dislike", "aria-label": "Dislike", "aria-pressed": "false" }, fsThumbSvg("dislike"));
    fsPlayerLikeButton = likeButton;
    fsPlayerDislikeButton = dislikeButton;
    // Seed our OWN rating state for this video (one-time seed from saved map / YTM,
    // then paint the buttons). Our visual state is authoritative — no YTM mirroring.
    refreshFsRatingState();
    playButton.dataset.playState = "pause";
    fsPlayerSeekRange = h("input", {
      class: "ym-sl-fs-player-seek",
      type: "range", min: "0", max: "1", step: "100", value: "0",
      title: "Song progress", "aria-label": "Song progress",
    });
    // Custom <div>-based volume slider. A native <input type=range> cannot animate
    // its width smoothly (width is never GPU-composited, so it snaps on software
    // compositors), and CSS transform:scaleX on a native range renders broken in
    // Chrome (shadow-DOM track/thumb desync). Plain divs composite transform
    // reliably, so the hover-expand glides on every machine and the layout never
    // reflows.
    fsPlayerVolumeRange = h("div", {
      class: "ym-sl-fs-player-volume",
      role: "slider",
      tabindex: "0",
      title: "Volume",
      "aria-label": "Volume",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(fsPlayerVolumeValue),
    });
    const fsVolumeFill = h("div", { class: "ym-sl-fs-volume-fill" });
    const fsVolumeKnob = h("div", { class: "ym-sl-fs-volume-knob" });
    fsPlayerVolumeRange.append(fsVolumeFill, fsVolumeKnob);
    // Only the slider remains (the mute button was removed); the wrapper keeps
    // the border-left divider and spacing beside the chip.
    const volumeGroup = h("div", { class: "ym-sl-fs-volume-group" }, fsPlayerVolumeRange);
    // Transport wrapped in its own group so the side layout can centre the
    // TRANSPORT on the title. The wrapper is a plain 14px flex row, so every other
    // layout is unchanged: the chip's own gap used to space these buttons, and now
    // this gap does.
    const transportGroup = h("div", { class: "ym-sl-fs-transport" }, shuffleButton, previousButton, playButton, nextButton, repeatButton);
    const playChip = h("div", { class: "ym-sl-fs-play-chip" }, transportGroup);
    fsTimeCurrent = h("span", { class: "ym-sl-fs-time", "data-time": "current", text: "0:00" });
    fsTimeTotal = h("span", { class: "ym-sl-fs-time", "data-time": "total", text: "0:00" });
    // The volume lives on the SCRUBBER row, not the transport row (AJ, 2026-10-01):
    // it sits after the total time, and the seek range is the flex child that gives
    // up the room. The row's box is still exactly the media pane, so bar + volume
    // together span the video — which is the point of putting it here.
    const scrubber = h("div", { class: "ym-sl-fs-scrubber" }, fsTimeCurrent, fsPlayerSeekRange, fsTimeTotal, volumeGroup);
    fsPlayerPlayButton = playButton;
    fsPlayerControls = h("div", { class: "ym-sl-fs-player-controls" }, playChip, scrubber);
    fsOverlay.append(fsControls, fsPlayerControls);
    // Like / Dislike live in the CONTROLS LAYER (z-index 21), NOT in the media.
    // The media is z-index 2 and the lyrics pane is z-index 3, so a button
    // parented to the media was painted UNDER the lyrics and the dislike
    // vanished behind them in side layout (AJ, 2026-10-18). The controls layer
    // is above both; positionFsEdgeButtons() then pins them to the media's
    // horizontal edges and the transport row's vertical centre.
    fsPlayerControls.querySelectorAll(".ym-sl-fs-player-like--edge, .ym-sl-fs-player-dislike--edge")
      .forEach((n) => n.remove());
    fsPlayerControls.appendChild(likeButton);
    fsPlayerControls.appendChild(dislikeButton);
    // Bootstrap transient (AJ 2026-10-08): the media/lyrics panes settle from a
    // stale side layout + stale art over ~1s while native fullscreen opens. Fade
    // them in over the existing .35s opacity transition instead of snapping them
    // on, so that flash is hidden behind the fade. The rating buttons live in the
    // controls layer now, so this fade does not affect their positioning.
    if (fsMediaHost) {
      // Route the entry through the same dissolve as a track change, but with the
      // "out" already considered finished so the fade-in starts immediately.
      fsMediaFadingOut = true;
      fsMediaFadeOutAt = 0;
      if (fsOverlay) fsOverlay.classList.add("ym-sl-fs-dissolving");
    }
    if (fsLyricsHost) fsLyricsHost.style.opacity = "0";
    // Double rAF: paint opacity:0 first, then (a) drop ym-sl-fs-no-anim so the
    // panes' transitions are live, (b) fade the media back in, and (c) home the
    // chrome once the final layout has actually been laid out.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (fsOverlay) fsOverlay.classList.remove("ym-sl-fs-no-anim");
      if (fsMediaHost) fsFadeInMedia();
      if (fsLyricsHost) fsLyricsHost.style.opacity = "";
      syncFsChromeStructure();
    }));
    syncFsChromeStructure();
    // The ResizeObserver that re-pinned the edge buttons whenever the media
    // resized is REMOVED (AJ, 2026-10-20). It fired repeatedly while the pane
    // animated its width, which slid the buttons along with it — one of the
    // clearest "controls move a lot" symptoms. Positions are static now.
    refreshFullscreenPlayerState();
    fsPlayerStateTimer = window.setInterval(refreshFullscreenPlayerState, 500);
    exit.addEventListener("click", exitFullscreenMode);
    previousButton.addEventListener("click", () => clickPlayerButton("previous"));
    playButton.addEventListener("click", () => clickPlayerButton("play"));
    nextButton.addEventListener("click", () => clickPlayerButton("next"));
    shuffleButton.addEventListener("click", () => clickPlayerButton("shuffle"));
    repeatButton.addEventListener("click", () => clickPlayerButton("repeat"));
    likeButton.addEventListener("click", () => clickFsRating("like"));
    dislikeButton.addEventListener("click", () => clickFsRating("dislike"));
    // Single source of truth for the custom slider: writes the fill (via
    // --vol-fill), the ARIA value, the icon, and the real YTM volume together.
    function applyFullscreenVolume(v) {
      v = clamp(Math.round(v), 0, 100);
      fsPlayerVolumeValue = v;
      fsPlayerVolumeRange.style.setProperty("--vol-fill", v + "%");
      fsPlayerVolumeRange.setAttribute("aria-valuenow", String(v));
      setPlayerVolume(v);
    }
    // ---- drag affordances (AJ's "for tmr" note, 2026-10-03) ----------------
    // While a slider is dragged: hide the cursor (an accident AJ liked), and
    // on the seek bar show a time bubble above the thumb. The counter lets the
    // two sliders nest without one drag's pointerup un-hiding the other's.
    let fsDragCount = 0;
    function setDragCursor(on) {
      fsDragCount = Math.max(0, fsDragCount + (on ? 1 : -1));
      if (fsOverlay) fsOverlay.classList.toggle("ym-sl-fs-dragging", fsDragCount > 0);
    }
    function ensureScrubTip() {
      if (fsScrubTip && fsScrubTip.isConnected) return fsScrubTip;
      fsScrubTip = h("div", { class: "ym-sl-fs-scrub-tip", "aria-hidden": "true" }, "0:00");
      fsPlayerControls.appendChild(fsScrubTip);
      return fsScrubTip;
    }
    // The bubble is positioned against fsPlayerControls (inset:0 over the
    // overlay), from the seek input's live viewport rect, so it is correct in
    // every layout without knowing which mode is active.
    function updateScrubTip() {
      if (!fsScrubTip || !fsPlayerSeekRange || !fsPlayerControls) return;
      const duration = Number(window.YTMod && window.YTMod.player && window.YTMod.player.getDurationMs());
      const position = Number(fsPlayerSeekRange.value);
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
      fsScrubTip.textContent = formatClock(position);
      const seekRect = fsPlayerSeekRange.getBoundingClientRect();
      const hostRect = fsPlayerControls.getBoundingClientRect();
      const ratio = clamp(position / duration, 0, 1);
      fsScrubTip.style.left = (seekRect.left - hostRect.left + ratio * seekRect.width) + "px";
      fsScrubTip.style.top = (seekRect.top - hostRect.top - 34) + "px";
    }
    function showScrubTip() {
      ensureScrubTip();
      updateScrubTip();
      if (fsScrubTip) fsScrubTip.classList.add("ym-sl-fs-scrub-tip-on");
    }
    function hideScrubTip() {
      if (fsScrubTip) fsScrubTip.classList.remove("ym-sl-fs-scrub-tip-on");
    }
    // Map a pointer X to 0-100 against the VISUAL (post-transform) rect so the
    // value tracks exactly where the user grabs the scaled bar.
    function volumeFromPointer(clientX) {
      const rect = fsPlayerVolumeRange.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return Math.round(ratio * 100);
    }
    fsPlayerVolumeRange.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      fsPlayerVolumeRange.focus();
      fsPlayerVolumeRange.setPointerCapture(e.pointerId);
      setDragCursor(true);
      applyFullscreenVolume(volumeFromPointer(e.clientX));
      const onMove = (ev) => applyFullscreenVolume(volumeFromPointer(ev.clientX));
      const onUp = (ev) => {
        try { fsPlayerVolumeRange.releasePointerCapture(ev.pointerId); } catch (_) {}
        fsPlayerVolumeRange.removeEventListener("pointermove", onMove);
        fsPlayerVolumeRange.removeEventListener("pointerup", onUp);
        fsPlayerVolumeRange.removeEventListener("pointercancel", onUp);
        setDragCursor(false);
      };
      fsPlayerVolumeRange.addEventListener("pointermove", onMove);
      fsPlayerVolumeRange.addEventListener("pointerup", onUp);
      fsPlayerVolumeRange.addEventListener("pointercancel", onUp);
    });
    fsPlayerVolumeRange.addEventListener("keydown", (e) => {
      let v = fsPlayerVolumeValue;
      const step = e.shiftKey ? 10 : 5;
      switch (e.key) {
        case "ArrowRight": case "ArrowUp": v += step; break;
        case "ArrowLeft": case "ArrowDown": v -= step; break;
        case "Home": v = 0; break;
        case "End": v = 100; break;
        case "PageUp": v += 10; break;
        case "PageDown": v -= 10; break;
        default: return;
      }
      e.preventDefault();
      applyFullscreenVolume(v);
    });
    // Initialise the fill from the stored value; YTM supplies the real volume on
    // the first refresh. Keep the mute/icon in sync.
    fsPlayerVolumeRange.style.setProperty("--vol-fill", clamp(fsPlayerVolumeValue, 0, 100) + "%");
    fsPlayerSeekRange.addEventListener("pointerdown", () => {
      fsSeekUserAt = performance.now();
      setDragCursor(true);
      showScrubTip();
    });
    const endSeekDrag = () => { setDragCursor(false); hideScrubTip(); };
    fsPlayerSeekRange.addEventListener("pointerup", endSeekDrag);
    fsPlayerSeekRange.addEventListener("pointercancel", endSeekDrag);
    // Belt for a pointerup the browser never delivers (release outside the
    // window mid-drag): losing capture ends the drag regardless.
    fsPlayerSeekRange.addEventListener("lostpointercapture", endSeekDrag);
    fsPlayerSeekRange.addEventListener("input", () => {
      // Marks the seek bar as user-driven so the 500ms sync leaves the thumb
      // alone until the grace window lapses (see FS_SEEK_USER_GRACE_MS).
      fsSeekUserAt = performance.now();
      const duration = Number(window.YTMod && window.YTMod.player && window.YTMod.player.getDurationMs());
      const position = Number(fsPlayerSeekRange.value);
      if (Number.isFinite(duration) && duration > 0 && Number.isFinite(position)) {
        fsPlayerSeekRange.style.setProperty("--slider-fill", clamp(position / duration * 100, 0, 100) + "%");
      }
      // The bubble tracks the thumb live through the whole drag (input also
      // fires for keyboard arrows, which is the desired behaviour there too).
      updateScrubTip();
    });
    fsPlayerSeekRange.addEventListener("change", () => {
      const position = Number(fsPlayerSeekRange.value);
      if (Number.isFinite(position) && window.YTMod && window.YTMod.player) {
        window.YTMod.player.seek(position);
      }
    });
    fsLayoutSelect.addEventListener("click", () => {
      applyFullscreenLayout(nextFsLayoutMode(fsLayoutMode));
    });
    fsLyricsToggle.addEventListener("click", () => {
      fsLyricsHidden = !fsLyricsHidden;
      if (fsOverlay) {
        fsOverlay.classList.toggle("ym-sl-fs-lyrics-hidden", fsLyricsHidden);
        if (fsLyricsHidden) {
      setFullscreenLyricsShadeTarget(0);
      fsOverlay.style.setProperty("--ym-sl-fs-lyrics-shade-opacity", "0");
    }
      }
      // Update the LABEL span only. Writing textContent straight onto the
      // button would wipe the icon SVG that now also lives inside it.
      const lyrLabel = fsLyricsToggle.querySelector(".ym-sl-fs-btn-label");
      if (lyrLabel) lyrLabel.textContent = fsLyricsHidden ? "Show lyrics" : "Hide lyrics";
      fsLyricsToggle.setAttribute("aria-label", fsLyricsHidden ? "Show lyrics" : "Hide lyrics");
    });
    fsOffsetRange.addEventListener("input", () => {
      setVideoOffsetMs(Number(fsOffsetRange.value) || 0, true);
    });
    let savedMode = "side";
    try { savedMode = localStorage.getItem("better_lyrics_fullscreen_layout_v1") || "side"; } catch (_) {}
    const hasVideo = !!findPlayerVideo();
    // The layout used to be a <select> with a Background option that had to be
    // hidden and disabled when the track had no video. It is a cycle button now,
    // so there is no `backgroundOption` to touch - and referencing the stale
    // name threw a ReferenceError at the very END of this function.
    // That is why it mattered far more than it looks: the throw aborted
    // enterFullscreenMode() before it could attach the keydown and
    // fullscreenchange listeners (so Escape left the overlay stranded on the
    // page), start the 2s refresh interval (media reconcile, band anchor,
    // Kawarp art sync) and start idle tracking (so the chrome never hid).
    // All three are fixed by deleting the two dead lines.
    if (!hasVideo && savedMode === "background") savedMode = "side";
    applyFullscreenLayout(savedMode);
    fsLyricsHidden = false;
    fsOverlay.classList.remove("ym-sl-fs-lyrics-hidden");
    fsLyricsToggle.textContent = "Hide lyrics";
    fsLyricsToggle.setAttribute("aria-label", "Hide lyrics");
    offsetWrap.classList.toggle("visible", true);
    offsetWrap.classList.toggle("force-visible", !hasVideo);
    recomputeActiveOffsetMode(true);
    refreshVideoOffsetControl();
  }

  /* ---- idle "fill ring" cursor indicator --------------------------------
     When the pointer stops moving in fullscreen, a hollow white ring appears
     at the cursor and DRAWS ITSELF (a stroke-dashoffset tween on an SVG
     circle — a ring filling up, NOT a solid disc) over the idle delay. As the
     chrome auto-hides, the ring fades out and shrinks. Purely an affordance
     that the cursor is about to vanish (AJ, 2026-09-28). Any input hides it
     and restarts the countdown. */
  // Movement must pause this long before the ring appears. Raised 260 -> 700
  // (AJ, 2026-09-28): at 260ms it fired constantly during ordinary mouse use,
  // which read as noise. 700ms only triggers on a genuine stop.
  const FS_IDLE_RING_DELAY_MS = 700;
  const FS_IDLE_RING_FILL_MS = Math.max(400, FS_IDLE_HIDE_MS - FS_IDLE_RING_DELAY_MS);
  const FS_IDLE_RING_R = 15; // SVG radius inside a 36x36 viewBox
  const FS_IDLE_RING_CIRC = (2 * Math.PI * FS_IDLE_RING_R).toFixed(2);
  let fsIdleRing = null;
  let fsIdleRingShowTimer = 0;
  let fsIdleRingLeaveTimer = 0;
  let fsHavePointer = false;
  let fsLastPointerX = 0;
  let fsLastPointerY = 0;

  function ensureFsIdleRing() {
    if (fsIdleRing || !fsOverlay) return fsIdleRing;
    const wrap = h("div", { class: "ym-sl-fs-idle-ring", "aria-hidden": "true" });
    wrap.style.setProperty("--ym-sl-fs-idle-ring-circ", FS_IDLE_RING_CIRC);
    wrap.style.setProperty("--ym-sl-fs-idle-ring-fill-ms", FS_IDLE_RING_FILL_MS + "ms");
    const svg = fsSvgIcon([
      { tag: "circle", attrs: { class: "ym-sl-fs-idle-ring-track", cx: "18", cy: "18", r: String(FS_IDLE_RING_R) } },
      { tag: "circle", attrs: { class: "ym-sl-fs-idle-ring-fill", cx: "18", cy: "18", r: String(FS_IDLE_RING_R) } },
    ], "0 0 36 36");
    // fsSvgIcon stamps the chrome's icon class, which is not what this is.
    svg.setAttribute("class", "ym-sl-fs-idle-ring-svg");
    wrap.appendChild(svg);
    fsIdleRing = wrap;
    fsOverlay.appendChild(wrap);
    return fsIdleRing;
  }

  function placeFsIdleRing() {
    if (!fsIdleRing) return;
    fsIdleRing.style.setProperty("--ym-sl-fs-idle-ring-x", fsLastPointerX + "px");
    fsIdleRing.style.setProperty("--ym-sl-fs-idle-ring-y", fsLastPointerY + "px");
  }

  function hideFsIdleRing() {
    if (fsIdleRingShowTimer) { window.clearTimeout(fsIdleRingShowTimer); fsIdleRingShowTimer = 0; }
    if (fsIdleRingLeaveTimer) { window.clearTimeout(fsIdleRingLeaveTimer); fsIdleRingLeaveTimer = 0; }
    if (fsIdleRing) fsIdleRing.classList.remove("visible", "leaving");
  }

  // Any activity: hide the ring while the pointer is moving, then re-arm it to
  // appear (and re-fill from empty) once movement pauses.
  function resetFsIdleRing() {
    if (!fsActive || !fsHavePointer) return;
    hideFsIdleRing();
    fsIdleRingShowTimer = window.setTimeout(() => {
      fsIdleRingShowTimer = 0;
      if (!fsActive) return;
      const el = ensureFsIdleRing();
      if (!el) return;
      placeFsIdleRing();
      el.classList.remove("visible", "leaving");
      // Reflow so the fill animation restarts from empty every time.
      void el.offsetWidth;
      el.classList.add("visible");
    }, FS_IDLE_RING_DELAY_MS);
  }

  // The chrome actually hid: the ring is full, so fade it out and shrink it.
  function leaveFsIdleRing() {
    if (fsIdleRingShowTimer) { window.clearTimeout(fsIdleRingShowTimer); fsIdleRingShowTimer = 0; }
    if (!fsIdleRing) return;
    fsIdleRing.classList.remove("visible");
    fsIdleRing.classList.add("leaving");
    if (fsIdleRingLeaveTimer) window.clearTimeout(fsIdleRingLeaveTimer);
    fsIdleRingLeaveTimer = window.setTimeout(() => {
      fsIdleRingLeaveTimer = 0;
      if (fsIdleRing) fsIdleRing.classList.remove("leaving");
    }, 320);
  }

  /* ---- idle pointer / control auto-hide ----------------------------------
     Native-player behavior: after FS_IDLE_HIDE_MS without input, drop the
     pointer and the hover controls. Any movement, click, wheel, or key press
     brings both straight back and restarts the countdown. */
  function hideFsChrome() {
    fsIdleTimer = 0;
    if (!fsActive || !fsOverlay) return;
    // Only block while a button is physically held (mid-drag on the offset
    // slider). Focus must NOT block this: changing the layout leaves the
    // <select> focused, and gating on focus meant the chrome never hid until
    // you clicked somewhere else first. Retry on a timer instead of giving up,
    // so a mouseup that lands outside the window can't strand it permanently.
    if (fsPointerDown) {
      fsIdleTimer = setTimeout(hideFsChrome, FS_IDLE_HIDE_MS);
      return;
    }
    fsOverlay.classList.add("ym-sl-fs-idle");
    fsIdleHidden = true;
    // Cursor is going away: the fill ring is complete, so fade + shrink it.
    leaveFsIdleRing();
  }

  function showFsChrome() {
    if (fsIdleTimer) {
      clearTimeout(fsIdleTimer);
      fsIdleTimer = 0;
    }
    if (fsIdleHidden) {
      if (fsOverlay) fsOverlay.classList.remove("ym-sl-fs-idle");
      fsIdleHidden = false;
    }
    fsIdleTimer = setTimeout(hideFsChrome, FS_IDLE_HIDE_MS);
    resetFsIdleRing();
  }

  function handleFsActivity() {
    if (!fsActive) return;
    showFsChrome();
  }

  function handleFsMouseMove(event) {
    // Recover from a mouseup that landed outside the window: if no button is
    // held, the pointer is definitively not dragging anything.
    if (fsPointerDown && event && event.buttons === 0) fsPointerDown = false;
    if (event && typeof event.clientX === "number" && typeof event.clientY === "number") {
      fsHavePointer = true;
      fsLastPointerX = event.clientX;
      fsLastPointerY = event.clientY;
    }
    handleFsActivity();
  }

  function handleFsPointerDown() {
    fsPointerDown = true;
    handleFsActivity();
  }

  function handleFsPointerUp() {
    fsPointerDown = false;
    handleFsActivity();
  }

  function handleFsPointerLeave() {
    // A drag that ends on another monitor never delivers its mouseup here, which
    // left fsPointerDown stuck true and made hideFsChrome reschedule itself
    // forever instead of hiding the chrome. The pointer has left the window, so
    // no button it is holding can matter to us any more — drop the flag and let
    // the idle countdown run.
    if (fsPointerDown) {
      fsPointerDown = false;
      handleFsActivity();
    }
  }

  function startFsIdleTracking() {
    stopFsIdleTracking();
    document.addEventListener("mousemove", handleFsMouseMove, { passive: true });
    document.addEventListener("mousedown", handleFsPointerDown, { passive: true });
    document.addEventListener("mouseup", handleFsPointerUp, { passive: true });
    document.addEventListener("mouseleave", handleFsPointerLeave, { passive: true });
    document.addEventListener("wheel", handleFsActivity, { passive: true });
    document.addEventListener("keydown", handleFsActivity, true);
    showFsChrome();
  }

  function stopFsIdleTracking() {
    if (fsIdleTimer) {
      clearTimeout(fsIdleTimer);
      fsIdleTimer = 0;
    }
    fsPointerDown = false;
    fsHavePointer = false;
    hideFsIdleRing();
    if (fsOverlay) fsOverlay.classList.remove("ym-sl-fs-idle");
    fsIdleHidden = false;
    document.removeEventListener("mousemove", handleFsMouseMove, { passive: true });
    document.removeEventListener("mousedown", handleFsPointerDown, { passive: true });
    document.removeEventListener("mouseup", handleFsPointerUp, { passive: true });
    document.removeEventListener("mouseleave", handleFsPointerLeave, { passive: true });
    document.removeEventListener("wheel", handleFsActivity, { passive: true });
    document.removeEventListener("keydown", handleFsActivity, true);
  }

  // ===== Kawarp backdrop for song fullscreen =====
  // Songs have no live video, so instead of a blurred still cover we can run the
  // same Kawarp WebGL fluid backdrop the Dynamic add-on uses page-wide. It is
  // gated on that add-on being active (its page-world handshake is present) and
  // it suspends the page Kawarp while open, so only one ever animates at a time.
  function getKawarpConstructor() {
    if (!KAWARP_CORE_URL) return Promise.reject(new Error("Kawarp module URL unavailable."));
    if (!fsKawarpModulePromise) {
      fsKawarpModulePromise = import(KAWARP_CORE_URL).then((module) => {
        const Kawarp = module.default || module.Kawarp;
        if (typeof Kawarp !== "function") throw new Error("Kawarp module did not export a constructor.");
        return Kawarp;
      });
    }
    return fsKawarpModulePromise;
  }

  function sizeFullscreenKawarp() {
    if (!fsKawarpCanvas || !fsOverlay) return;
    const rect = fsOverlay.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (fsKawarpCanvas.width === width && fsKawarpCanvas.height === height) return;
    fsKawarpCanvas.width = width;
    fsKawarpCanvas.height = height;
    if (fsKawarp) fsKawarp.resize();
  }

  function stopFullscreenKawarp() {
    fsKawarpActive = false;
    ++fsKawarpSeq;
    if (fsKawarpResizeObserver) { try { fsKawarpResizeObserver.disconnect(); } catch (_) {} }
    fsKawarpResizeObserver = null;
    if (fsKawarp) { try { fsKawarp.dispose(); } catch (_) {} }
    fsKawarp = null;
    if (fsKawarpCanvas && fsKawarpCanvas.parentElement) {
      fsKawarpCanvas.parentElement.removeChild(fsKawarpCanvas);
    }
    fsKawarpCanvas = null;
    fsKawarpArtUrl = "";
    fsKawarpVideoEl = null;
    if (fsOverlay) fsOverlay.classList.remove("ym-sl-fs-has-kawarp");
  }

  async function startFullscreenKawarp(artUrl, videoEl) {
    if (!fsOverlay) return false;
    // Gate on the Dynamic add-on: its handshake object is our signal that the
    // page-wide Kawarp exists, and we take the backdrop over from it.
    const dyn = window.__ymAuroraDynamic;
    if (!dyn || typeof dyn.suspend !== "function") return false;
    // Defensive: never stack a second canvas. Every canvas is inserted as
    // fsOverlay.firstChild, so a restart that left the old one in place put the
    // stale canvas LATER in document order - where it painted over the new art.
    if (fsKawarpCanvas || fsKawarp) stopFullscreenKawarp();
    fsKawarpActive = true;
    const seq = ++fsKawarpSeq;
    fsKawarpCanvas = h("canvas", { class: "ym-sl-fs-kawarp", "aria-hidden": "true" });
    fsOverlay.insertBefore(fsKawarpCanvas, fsOverlay.firstChild);
    fsOverlay.classList.add("ym-sl-fs-has-kawarp");
    if (typeof ResizeObserver === "function") {
      fsKawarpResizeObserver = new ResizeObserver(() => sizeFullscreenKawarp());
      fsKawarpResizeObserver.observe(fsOverlay);
    }
    try {
      const Kawarp = await getKawarpConstructor();
      if (seq !== fsKawarpSeq || !fsKawarpCanvas || !fsOverlay) return false;
      sizeFullscreenKawarp();
      fsKawarp = new Kawarp(fsKawarpCanvas, FS_KAWARP_OPTIONS);
      if (videoEl) {
        // Music videos: feed the LIVE <video> so the backdrop reacts to the
        // picture instead of a heavily blurred + dimmed copy of it (AJ,
        // 2026-10-19). Kawarp samples a small colour map, so this is far
        // cheaper than the old full-viewport canvas blur.
        await fsKawarp.loadVideo(videoEl, {
          sampleWidth: 72,
          sampleHeight: 128,
          smoothing: 120,
          frameRate: 30,
        });
        fsKawarpVideoEl = videoEl;
        fsKawarpArtUrl = "";
      } else if (artUrl) {
        await fsKawarp.loadImage(artUrl);
        fsKawarpArtUrl = artUrl;
        fsKawarpVideoEl = null;
      }
      if (seq !== fsKawarpSeq) return false;
      fsKawarp.setOptions({ animationSpeed: isPlaybackPaused() ? 0.1 : 1 });
      fsKawarp.start();
      fsKawarpCanvas.classList.add("ready");
      return true;
    } catch (error) {
      // Any failure (module load, WebGL context, image) falls back to the
      // static blurred cover by dropping the canvas and the hiding class.
      console.warn("[Aurora Lyrics] Kawarp backdrop failed:", error);
      if (fsOverlay) fsOverlay.classList.remove("ym-sl-fs-has-kawarp");
      if (fsKawarp) { try { fsKawarp.dispose(); } catch (_) {} }
      fsKawarp = null;
      if (fsKawarpCanvas && fsKawarpCanvas.parentElement) {
        fsKawarpCanvas.parentElement.removeChild(fsKawarpCanvas);
      }
      fsKawarpCanvas = null;
      fsKawarpActive = false;
      fsKawarpVideoEl = null;
      return false;
    }
  }

  // Swap the backdrop source of an ALREADY running Kawarp (no restart: a second
  // canvas would stack and the older one would paint over the new source).
  function syncFullscreenKawarpVideo(videoEl) {
    if (!fsKawarpActive || !fsKawarp || !videoEl || videoEl === fsKawarpVideoEl) return;
    fsKawarpVideoEl = videoEl;
    fsKawarpArtUrl = "";
    try {
      fsKawarp.loadVideo(videoEl, {
        sampleWidth: 72,
        sampleHeight: 128,
        smoothing: 120,
        frameRate: 30,
      });
    } catch (_) {}
  }

  function syncFullscreenKawarpArt(artUrl) {
    // Never replace a LIVE video feed with a still. The 2s artwork refresh used
    // to do exactly that, so a music video's backdrop froze on the first frame
    // it had sampled (AJ, 2026-10-19). The video path owns the instance until
    // stopFullscreenKawarp() clears fsKawarpVideoEl.
    if (fsKawarpVideoEl) return;
    if (!fsKawarpActive || !fsKawarp || !artUrl || artUrl === fsKawarpArtUrl) return;
    fsKawarpArtUrl = artUrl;
    try { fsKawarp.loadImage(artUrl); } catch (_) {}
  }

  /* ---- static-upload music videos -> Kawarp backdrop ---------------------
     A music video whose title says it is a still upload has nothing moving in
     the frame, so the blurred-video backdrop is just a frozen blur of the same
     picture. Those get Kawarp instead - the same animated cover-art backdrop
     that cover-art tracks already use. */
  const FS_STATIC_VIDEO_RE =
    /\(\s*(?:official\s+audio|lyric\s+video|audio|visuali[sz]er|static\s+video|audio\s+only)\s*\)/i;

  // YTM's parsed track title strips the "(Official Audio)" / "(Lyric Video)"
  // suffix, so the raw YouTube title is the only place it survives. The player
  // chrome's title link holds it; the page title is the second choice and the
  // parsed title the last, which degrades to "never static" rather than
  // guessing wrong.
  function getRawVideoTitle() {
    const selectors = ["#movie_player .ytp-title-link", "ytmusic-player-bar .title"];
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      const text = el && el.textContent ? el.textContent.trim() : "";
      if (text) return text;
    }
    const track = getCurrentTrack();
    if (track && track.title) return track.title;
    return document.title || "";
  }

  // Keyed on the raw title so this is idempotent (safe to call on every 2s
  // tick) and so a failed Kawarp attempt is not retried in a loop.
  let fsStaticVideoKey = "";

  function applyStaticVideoBackdrop() {
    if (!fsActive || !fsOverlay || !fsSavedVideo) return;
    const raw = getRawVideoTitle();
    // Music videos now ALWAYS use Kawarp fed by the live video: it replaces the
    // old full-viewport blurred/dimmed canvas copy, which was both heavier and
    // visually muddier (AJ, 2026-10-19).
    const liveVideo = fsSavedVideo.node
      ? fsSavedVideo.node.querySelector("video") || fsSavedVideo.node
      : null;
    const videoNode = liveVideo && liveVideo.tagName === "VIDEO" ? liveVideo : null;
    if (videoNode) {
      if (fsKawarpActive) syncFullscreenKawarpVideo(videoNode);
      else startFullscreenKawarp("", videoNode);
      return;
    }
    // No video element: fall back to the artwork-backed backdrop.
    const wantKawarp = !!currentSettings.preferKawarpAlways || FS_STATIC_VIDEO_RE.test(raw);
    const key = (wantKawarp ? "kawarp|" : "canvas|") + raw;
    if (key === fsStaticVideoKey) return;
    fsStaticVideoKey = key;
    if (wantKawarp) {
      const track = getCurrentTrack();
      const artUrl = (track && track.artworkUrl) || getDomArtworkUrl();
      if (fsKawarpActive) {
        // Already running: swap the IMAGE only. Restarting would build a second
        // canvas, and startFullscreenKawarp does not remove the old one - each
        // new canvas is inserted as firstChild, so the OLD one ends up LATER in
        // document order and paints straight over the new art (both are
        // z-index 0). That is why the Kawarp backdrop stopped changing on a
        // track change (AJ, 2026-09-28).
        if (artUrl) syncFullscreenKawarpArt(hiResArt(artUrl));
      } else {
        startFullscreenKawarp(artUrl ? hiResArt(artUrl) : "");
      }
    } else if (fsKawarpActive) {
      stopFullscreenKawarp();
    }
  }

  function suspendPageKawarp() {
    const dyn = window.__ymAuroraDynamic;
    if (dyn && typeof dyn.suspend === "function") {
      try { dyn.suspend(); } catch (_) {}
    }
  }

  function resumePageKawarp() {
    const dyn = window.__ymAuroraDynamic;
    if (dyn && typeof dyn.resume === "function") {
      try { dyn.resume(); } catch (_) {}
    }
  }

  // Swap the fullscreen backdrop between music-video mode and cover-art mode
  // when the track changes mid-fullscreen (no-MV -> MV or vice versa).
  // enterFullscreenMode() decides once at entry; this catches the transitions.
  // A guard timer prevents re-entry while a swap is already in flight.
  //
  // ===== INTENT vs READINESS (AJ, 2026-10-20) ==============================
  // This used to key off findPlayerVideo(), which requires videoWidth > 0 — a
  // READINESS test. On an MV -> audio skip YTM's recycled <video> keeps its old
  // dimensions for a beat, so the detach could not fire until the new (audio)
  // media reset them; on a cover -> MV skip it could not fire until the new
  // video decoded. Both directions therefore waited, and the 2s tick was the
  // only thing that re-checked. The player response's musicVideoType answers the
  // INTENT question the moment the new track's response lands, so the mode is
  // decided immediately and readiness is only used for the attach path.

  // Last decisive answer. During a skip the player response can be briefly
  // unavailable AND the recycled <video> reports videoWidth 0 at the same time —
  // that pair used to read as "this track is audio", so the video was detached
  // mid-reload. That is what made the CONTROLS restack into the cover-art
  // arrangement between two music videos and then snap back (AJ, 2026-10-21).
  // Holding the previous answer until a new one arrives makes the mode decision
  // stable across a reload. Reset on fullscreen exit.
  let fsLastKnownHasVideo = null;

  function trackHasVideoByType() {
    try {
      const p = document.querySelector("ytmusic-player");
      const resp = p && p.getPlayerResponse && p.getPlayerResponse();
      const vd = resp && resp.videoDetails;
      const type = vd && vd.musicVideoType;
      // MUSIC_VIDEO_TYPE_ATV = album track (audio only). OMV / UGC / anything
      // else that is present means there is a video to show.
      if (typeof type === "string" && type) {
        fsLastKnownHasVideo = type !== "MUSIC_VIDEO_TYPE_ATV";
        return fsLastKnownHasVideo;
      }
    } catch (_) {}
    // Unknown right now (mid-skip, older response shape, podcast): keep the last
    // decision instead of letting a transient state flip the layout.
    return fsLastKnownHasVideo;
  }

  function syncFsVideoMode() {
    if (!fsActive || !fsMediaHost) return;
    if (fsVideoModeSwapTimer) return; // a swap is already in flight
    const liveVideo = findPlayerVideo();
    const hasAttached = !!fsSavedVideo;
    const byType = trackHasVideoByType();
    const wantVideo = byType === null ? !!liveVideo : byType;
    // The recycled element reports videoWidth 0 for a beat on EVERY source
    // change, so a single zero read must not be taken as "this track is audio".
    if (liveVideo) fsVideoZeroSince = 0;
    if (wantVideo && hasAttached) {
      // MV -> MV: YTM reuses the SAME <video>, so there is no swap to perform —
      // only its source changed. The media still has to fade back in, and it may
      // only do so once the NEW stream is actually presenting frames.
      if (fsMediaFadingOut) awaitFsVideoReady(fsSavedVideo.node);
      return;
    }
    if (!wantVideo && !hasAttached) {
      // A previous skip may have flipped the layout optimistically (below) and
      // then been overtaken by an audio track. Drop the class or the pane would
      // stay in video geometry with nothing in it.
      if (fsOverlay && fsOverlay.classList.contains("ym-sl-fs-has-video")) {
        fsOverlay.classList.remove("ym-sl-fs-has-video");
        syncFsChromeStructure();
      }
      return;
    }
    // Attaching still needs a real, decoded element; detaching does not.
    if (wantVideo && !liveVideo) {
      // ⭐ INTENT FIRST (AJ, 2026-10-20). Flip the LAYOUT to video geometry the
      // moment the track is KNOWN to have a video — not when its element is
      // decodable. Without this the pane stayed in cover geometry (tall, ~960x862)
      // for the whole load window, so the new video first appeared in a tall
      // cover-art-shaped box and then snapped to its real aspect ratio: exactly
      // the "it shows in the cover art format, then as a regular video" AJ
      // reported. Readiness is handled separately (the video stays at opacity 0
      // until frames advance), so this cannot show a stale frame.
      if (fsOverlay && !fsOverlay.classList.contains("ym-sl-fs-has-video")) {
        fsOverlay.classList.add("ym-sl-fs-has-video");
        syncFsChromeStructure();
      }
      // The new MV's <video> is not decodable yet. Poll for it instead of leaving
      // the attach to the 2s refresh tick — THAT tick was the visible delay on a
      // cover -> MV skip. Bounded, and it stops the moment the intent changes.
      retryVideoModeUntilReady();
      return;
    }

    // Reaching this point means the mode is UNCERTAIN (the no-op cases above
    // already returned): a transient videoWidth 0 during a reload lands here just
    // as a real MV <-> cover change would. So the swap timer below RE-EVALUATES
    // and only COMMITS a swap once it has a decisive answer. The chrome dissolve
    // is applied INSIDE the commit branches (attach / detach), not up here — that
    // is what keeps an MV -> MV reload from fading the controls out at all (AJ,
    // 2026-10-21). The media is already dissolving from fsFadeOutMedia(), so the
    // wait here only delays the layout restructure, not the track-change effect.
    fsVideoModeSwapTimer = setTimeout(() => {
      fsVideoModeSwapTimer = 0;
      // Guard each separately: touching fsMediaHost.style when fsMediaHost is
      // null would throw (fullscreen can exit mid-swap).
      if (!fsMediaHost) return;
      // revealFsMediaPaneNow() (not a bare opacity reset) so the chrome class
      // comes off with the pane on these bail-out paths too.
      if (!fsActive) { revealFsMediaPaneNow(); return; }
      // Re-read state inside the timer (the interval could have ticked again).
      const lv = findPlayerVideo();
      const ha = !!fsSavedVideo;
      // ⚠️ `trackHasVideoByType()` is effectively always null on this YTM build —
      // a probe confirmed `getPlayerResponse()` returns nothing, so there is no
      // videoDetails and no musicVideoType. `want` therefore means "the <video>
      // has dimensions", which is why the debounce below exists.
      const byTypeNow = trackHasVideoByType();
      const want = byTypeNow === null ? !!lv : byTypeNow;
      if (want && ha) { revealFsMediaPaneNow(); return; }
      if (!want && !ha) { revealFsMediaPaneNow(); return; }
      if (want && !lv) {
        // The element lost its dimensions between the call and this timer. Do NOT
        // fade back in — the pane would show the backdrop with no video. Keep the
        // dissolve parked and poll instead.
        retryVideoModeUntilReady();
        return;
      }
      if (want && !ha) {
        // Committed cover -> MV swap: the whole control column restructures, so
        // dissolve the chrome before the swap runs (it fades back in with the
        // video via awaitFsVideoReady -> revealFsMediaPane -> fsFadeInMedia).
        fsChromeFadeOut();
        // Attach the live video (mirrors enterFullscreenMode).
        fsSavedVideo = {
          node: lv,
          parent: lv.parentElement,
          next: lv.nextSibling,
          cssText: lv.style.cssText,
        };
        fsOverlay.classList.add("ym-sl-fs-has-video");
        // The mode changed, so the volume group's home may have to change with it.
        syncFsChromeStructure();
        // Defensive: drop any stale canvas before creating a new one so a repeated
        // attach can never leave two ambient backdrops stacked.
        if (fsBgCanvas && fsBgCanvas.parentElement) {
          fsBgCanvas.parentElement.removeChild(fsBgCanvas);
        }
        fsBgCanvas = h("canvas", { class: "ym-sl-fs-bg-canvas" });
        fsBgCtx = fsBgCanvas.getContext("2d", { alpha: false });
        fsOverlay.insertBefore(fsBgCanvas, fsMediaHost);
        fsBgLastDrawAt = 0;
        requestAnimationFrame(() => {
          drawBgFrame();
          startBgDrawLoop();
        });
        fsMediaHost.appendChild(lv);
        lv.style.setProperty("position", "absolute", "important");
        lv.style.setProperty("top", "0", "important");
        lv.style.setProperty("left", "0", "important");
        lv.style.setProperty("right", "0", "important");
        lv.style.setProperty("bottom", "0", "important");
        lv.style.setProperty("width", "100%", "important");
        lv.style.setProperty("height", "100%", "important");
        lv.style.setProperty("max-width", "none", "important");
        lv.style.setProperty("max-height", "none", "important");
        lv.style.setProperty("object-fit", "cover", "important");
        lv.style.setProperty("background", "transparent", "important");
        try { lv.play().catch(() => {}); } catch (_) {}
        // The static card STAYS (AJ, 2026-10-20): removing it here left the pane
        // empty for the whole video-ready wait. It is now the outgoing image the
        // cut happens FROM — awaitFsVideoReady()'s finish() removes it at the same
        // moment the video is revealed, so the swap is one hard cut.
        // fsHoldCoverCard stops the 2s reconcile from tearing the card down while
        // that wait is still running (it would re-open the gap we just closed).
        fsHoldCoverCard = true;
        // An MV owns the pane now, so the animated HLS cover must go ENTIRELY.
        // It is a flex child of the same pane, and left in place it kept its
        // 583px of flow space beside the video — the pane's geometry (and the
        // band anchored to it) stayed on the cover-art layout. destroyAnimatedArt
        // was previously reached only from fullscreen teardown, so the animated
        // cover survived every MV for the whole track (AJ, 2026-10-03).
        destroyAnimatedArt();
        stopFullscreenKawarp();
        // Hide the whole PANE, not just the video. The pane still carries the
        // cover-art geometry and animates to the video's aspect ratio, so
        // revealing it here showed a SQUARE card with the old art's shape
        // (AJ, 2026-09-28). awaitFsVideoReady() reveals the pane and the video
        // together, once frames are actually advancing.
        // Hidden until frames advance (the ready gate below), but with NO
        // transition: the reveal is a cut, not a fade (AJ, 2026-10-20).
        lv.style.setProperty("opacity", "0", "important");
        awaitFsVideoReady(lv);
        return;
      } else if (!want && ha) {
        if (byTypeNow === null) {
          // No type signal on this build, so `want` is only !!lv. Debounce: a
          // zero videoWidth that has lasted less than FS_VIDEO_ZERO_DEBOUNCE_MS
          // is a RELOAD, not an audio track. Without this, MV -> MV detached the
          // video mid-skip, which dropped has-video and restacked the controls.
          if (!fsVideoZeroSince) fsVideoZeroSince = performance.now();
          if (performance.now() - fsVideoZeroSince < FS_VIDEO_ZERO_DEBOUNCE_MS) {
            retryVideoModeUntilReady();
            return;
          }
        }
        // Committed MV -> cover swap: restructure the control column, so dissolve
        // the chrome first. (The debounce above already ruled out a mere reload.)
        fsChromeFadeOut();
        // Detach the stale video and fall back to cover art.
        const saved = fsSavedVideo;
        // Stop the draw loop FIRST, while fsSavedVideo is still set:
        // stopBgDrawLoop() picks its cancel method from that video
        // (cancelVideoFrameCallback vs cancelAnimationFrame), and
        // cancelAnimationFrame CANNOT cancel a requestVideoFrameCallback
        // handle — clearing fsSavedVideo first left the video-frame loop
        // running forever on a detached video (AJ's 1 fps symptom).
        stopBgDrawLoop();
        // Restore the video to the slot it came from so YTM keeps ownership
        // and can reuse it for the next music video. Orphaning it here is
        // what broke MV loading after a skip (AJ-confirmed).
        if (saved && saved.node && saved.parent) {
          if (saved.next && saved.next.parentNode === saved.parent) {
            saved.parent.insertBefore(saved.node, saved.next);
          } else {
            saved.parent.appendChild(saved.node);
          }
          if (Object.prototype.hasOwnProperty.call(saved, "cssText")) {
            saved.node.style.cssText = saved.cssText;
          }
        } else if (saved && saved.node && saved.node.parentElement === fsMediaHost) {
          fsMediaHost.removeChild(saved.node);
        }
        fsSavedVideo = null;
        fsOverlay.classList.remove("ym-sl-fs-has-video");
        // The mode changed, so the volume group's home may have to change with it.
        syncFsChromeStructure();
        // Drop the video's aspect ratio too — it is stale the instant the video
        // goes, and leaving it behind kept the pane on the MV's shape (it still
        // read 1920/1080 at the cover reveal).
        fsOverlay.style.removeProperty("--ym-sl-fs-video-ar");
        // The video is gone, so any pending "waiting for it to be ready" is moot
        // — drop it, or its spinner could appear over the cover art that is
        // about to load (AJ, 2026-09-28).
        cancelFsVideoReady();
        // If we were in Video Background, it has nothing to blur now - drop
        // back to Video + Lyrics so a non-MV skip can't strand a broken
        // backdrop (AJ 2026-09-28). Guard with the call: applyFullscreenLayout
        // itself also refuses "background" without a video.
        if (fsLayoutMode === "background") applyFullscreenLayout("side");
        if (fsBgCanvas && fsBgCanvas.parentElement) {
          fsBgCanvas.parentElement.removeChild(fsBgCanvas);
        }
        fsBgCanvas = null;
        fsBgCtx = null;
        fsBgLastDrawAt = 0;
        const t = getCurrentTrack();
        // Fall back to the player bar's thumbnail: right after a skip the
        // parsed track can still be the old one.
        const artUrl = (t && t.artworkUrl) || getDomArtworkUrl();
        if (artUrl) {
          // Reuse the card the reconcile tick may already have made — creating a
          // second one here left the pane showing the cover twice, side by side
          // (AJ, 2026-09-28).
          const img = ensureFsArtImg();
          // instant = no decode fade: this is a mode swap, so the card must
          // appear in the same frame the video leaves (AJ, 2026-10-20).
          if (img) setFsArtSrc(img, hiResArt(artUrl));
        }
        startFullscreenKawarp(artUrl ? hiResArt(artUrl) : "");
        // No band re-publish (AJ, 2026-10-20): the chrome sits at fixed offsets,
        // so a pane geometry change no longer has to move it.
      }
      // Fade back in. The MV attach path returns above and reveals once frames
      // present. The COVER path waits for the new image to decode — its onload
      // calls fsFadeInMedia — with a fallback timer so a missing or broken
      // artwork URL can never leave the pane dark.
      if (fsMediaFadingOut) {
        window.setTimeout(() => { if (fsActive) fsFadeInMedia(); }, 420);
      }
    }, FS_MEDIA_SWAP_MS);
  }

  // ===== event-driven track detection (AJ, 2026-10-20) =====================
  // ⭐ The track watcher that calls refreshTrack() -> syncFsVideoMode() lives in
  // housekeeping(), which runs on a 500ms INTERVAL. That interval was the last
  // real source of the cover -> MV delay: the skip had to wait up to half a
  // second before the mode was even evaluated, by which time the new video was
  // already attached and the pane had been sitting in the previous layout.
  //
  // YTM's recycled <video> tells us sooner:
  //   emptied / loadstart  -> the source was torn down (skip has begun)
  //   loadedmetadata       -> the NEW stream is decodable (videoWidth is valid)
  // Media events do not bubble, so they are captured at the document level.
  // Both handlers are no-ops unless fullscreen is open.
  let fsMediaWatchersOn = false;

  function isFsPlayerVideo(node) {
    if (!node || node.tagName !== "VIDEO") return false;
    // Our own animated cover art is a <video> too — never treat it as the player.
    if (node.classList && node.classList.contains("ym-sl-fs-art-video")) return false;
    if (fsSavedVideo && node === fsSavedVideo.node) return true;
    // Once reparented the node leaves ytmusic-player, so the container test is
    // only the pre-attach case.
    return !!(node.closest && (node.closest("ytmusic-player") || node.closest("#movie_player")));
  }

  function handleFsMediaEvent(event) {
    if (!fsActive || !isFsPlayerVideo(event.target)) return;
    if (event.type === "loadedmetadata") {
      // Decodable now — evaluate immediately so the attach does not wait a tick.
      syncFsVideoMode();
      return;
    }
    // emptied / loadstart: a source was torn down and a new one is loading. This
    // is ONE of the two track-change signals (see fsMaybeFadeForTrackChange); it
    // is the fast one for cover -> *, and the LATE one for MV -> cover.
    // Pass the CURRENT id, not "": an id match is a stronger dedupe than the time
    // window, so a late loadstart from our own re-attach can never fade twice.
    fsMaybeFadeForTrackChange("");
    // The player response may still describe the OLD track, so give it a couple
    // of frames before asking which mode this track wants. reconcileFsMediaArt()
    // runs here too so a COVER -> COVER skip swaps the artwork on the same beat
    // instead of waiting for the 500ms housekeeping pass (AJ, 2026-10-20).
    window.setTimeout(() => {
      if (!fsActive) return;
      syncFsVideoMode();
      reconcileFsMediaArt();
    }, 80);
  }

  function startFsMediaWatchers() {
    if (fsMediaWatchersOn) return;
    fsMediaWatchersOn = true;
    document.addEventListener("emptied", handleFsMediaEvent, true);
    document.addEventListener("loadstart", handleFsMediaEvent, true);
    document.addEventListener("loadedmetadata", handleFsMediaEvent, true);
    // Seed so entering fullscreen mid-song never fades the media out.
    fsFadeAt = 0;
    // ⚠️ The videoId poll that used to live here is GONE. The probe proved
    // `getPlayerResponse()` returns null on this build (vdKeys=NONE), so the id
    // was always "" and the poll could never detect a change — it was 8Hz of
    // nothing. The media events (emptied / loadstart) are the real signal and
    // they DO fire at skip time, including on an MV -> cover skip.
  }

  function stopFsMediaWatchers() {
    if (!fsMediaWatchersOn) return;
    fsMediaWatchersOn = false;
    document.removeEventListener("emptied", handleFsMediaEvent, true);
    document.removeEventListener("loadstart", handleFsMediaEvent, true);
    document.removeEventListener("loadedmetadata", handleFsMediaEvent, true);
  }

  // Short poll for a pending MV attach. syncFsVideoMode() can only attach once
  // findPlayerVideo() reports real dimensions, and that happens when the NEW
  // stream's metadata lands — anywhere from ~80ms to over a second after the
  // skip. Leaving that to the 2s refresh tick is what made cover -> MV feel
  // slow (AJ, 2026-10-20). 60ms cadence, 5s ceiling, and it stops the instant
  // the intent stops being "video".
  let fsVideoWaitTimer = 0;
  function retryVideoModeUntilReady() {
    if (fsVideoWaitTimer) return;
    const deadline = performance.now() + 5000;
    const tick = () => {
      fsVideoWaitTimer = 0;
      if (!fsActive || !fsOverlay) return;
      syncFsVideoMode();
      if (fsSavedVideo) return;                    // attached — done
      if (performance.now() >= deadline) return;    // give the 2s tick the rest
      if (trackHasVideoByType() === false) return;  // track changed to audio
      fsVideoWaitTimer = window.setTimeout(tick, 60);
    };
    fsVideoWaitTimer = window.setTimeout(tick, 60);
  }

  // ---- music-video ready gate -------------------------------------------
  // A skip attaches YTM's ONE recycled <video>, which still reports readyState /
  // videoWidth / !paused from the PREVIOUS track — so those alone revealed a
  // stale or poster frame (the "thumbnail" AJ kept seeing, 2026-09-28). The gate
  // therefore ALSO requires the playback clock to move, the only reliable proof
  // that the NEW content is rendering.
  //
  // The caller leaves the media PANE hidden while it waits — the pane still has
  // the cover-art geometry, so showing it exposed a square card. This reveals the
  // pane AND the video together, and shows a DEDICATED spinner (not the shared
  // lyrics one, so the two lifecycles can never hide each other) once the wait
  // passes FS_SPINNER_DELAY_MS. FS_VIDEO_READY_MAX_MS is the hard cap so it can
  // never get stuck.
  //
  // 350 -> 60 -> 140. Originally the media fade duration; then a couple of frames
  // for the DOM to settle. Now it must also outlast the CHROME fade (.14s) so the
  // control column is invisible when it restructures (AJ, 2026-10-21). The media
  // dissolve is 220ms, so the swap still happens inside the dark window and costs
  // nothing perceptible.
  const FS_MEDIA_SWAP_MS = 140;
  // How long a zero videoWidth must persist before it is read as "audio track".
  // A source change zeroes it for a beat; an audio track keeps it at 0.
  const FS_VIDEO_ZERO_DEBOUNCE_MS = 450;
  // Minimum time the chrome must stay dissolved on a mode change before it is
  // allowed to fade back in. fsChromeFadeIn can be called the instant the media is
  // ready (which on a cover -> MV skip is the same tick the fade-out started), and
  // without this floor the class is removed before it paints — so the dissolve is
  // invisible. A touch above the .22s fade-out so the out always completes (AJ,
  // 2026-10-21).
  const FS_CHROME_FADE_MIN_MS = 280;
  const FS_VIDEO_READY_MAX_MS = 8000;
  const FS_VIDEO_READY_POLL_MS = 60;
  let fsVideoReadySeq = 0;
  let fsVideoSpinnerEl = null;

  // FS_MEDIA_SETTLE_MS / fsMediaSwapAt / fsPaneRevealSeq are GONE (AJ,
  // 2026-10-20): they existed to hold the pane hidden until its geometry had
  // animated, and the geometry is static now. The media is revealed by the
  // track-change dissolve instead.

  // ===== track-change media dissolve (AJ, 2026-10-20) ====================
  // "When the song ends fade the video out, then when the next song starts fade
  // it back in" — and the same for every combination of cover art / music video.
  //
  // The opacity lives on the media HOST, not on the <video>/<img>, so these two
  // functions cover all four cases. MV -> MV has no swap at all (YTM reuses the
  // element, only the source changes), so an element-level fade could not work.
  // The backdrop (Kawarp / bg canvas) is a SIBLING of the host, so the media
  // dissolves to the blurred backdrop rather than to black.
  //
  // Sequential by design (out, then in) rather than a crossfade: a crossfade
  // needs both media on screen at once, and on a mode swap they share one pane.
  const FS_MEDIA_FADE_OUT_MS = 220;

  // Silent diagnostic (no console noise): keeps the last few dissolves on the
  // overlay as a data attribute so the sequence can be read straight off the DOM
  // with a selector inspect. Costs one attribute write per fade.
  function fsNoteDissolve(kind) {
    try {
      if (!fsOverlay) return;
      const prev = fsOverlay.getAttribute("data-ym-dissolve") || "";
      const next = (prev + " " + kind + "@" + Math.round(performance.now())).slice(-160);
      fsOverlay.setAttribute("data-ym-dissolve", next);
    } catch (_) {}
  }

  // ===== chrome dissolve, MODE CHANGES ONLY (AJ, 2026-10-21) ==============
  // Between the cover and MV layouts the whole control column restructures: the
  // credit moves from under the artwork to under the video, the transport swaps
  // between a centred row and a spread row, and the volume changes rows. None of
  // that is interpolatable, so it fades out, the swap happens while it is
  // invisible, and it fades back in with the media.
  // MV -> MV does NOT go through here — nothing restructures, so the chrome must
  // stay perfectly still while only the media dissolves.
  // The chrome dissolve is ONLY for a committed cover <-> MV mode change. Callers
  // invoke this from the attach / detach branches of syncFsVideoMode() once the
  // mode has DECISIVELY flipped — never during the reload window where
  // findPlayerVideo() transiently reports videoWidth 0. Calling it up front used
  // to make an MV -> MV skip fade the controls out (the element reuses itself on a
  // track change, so only its source changes) and, through a race in the
  // detach/re-attach, sometimes strand them invisible until fullscreen was
  // reopened (AJ, 2026-10-21).
  // The heal timer is the backstop: a real swap restores the chrome through
  // fsFadeInMedia() -> fsChromeFadeIn(). If that path is ever missed, the timer
  // force-restores it after the longest legitimate swap (a cover -> MV wait is
  // capped by FS_VIDEO_READY_MAX_MS), so the controls can never stay hidden for
  // the rest of the session.
  function fsChromeFadeOut() {
    if (!fsOverlay || fsChromeFading) return;
    fsChromeFading = true;
    fsChromeFadeOutAt = performance.now();
    fsOverlay.classList.add("ym-sl-fs-chrome-out");
    if (fsChromeFadeHealTimer) clearTimeout(fsChromeFadeHealTimer);
    fsChromeFadeHealTimer = window.setTimeout(() => {
      fsChromeFadeHealTimer = 0;
      if (fsActive && fsChromeFading && fsOverlay) {
        fsChromeFading = false;
        fsOverlay.classList.remove("ym-sl-fs-chrome-out");
      }
    }, FS_VIDEO_READY_MAX_MS + 1000);
  }

  function fsChromeFadeIn() {
    if (fsChromeFadeHealTimer) { clearTimeout(fsChromeFadeHealTimer); fsChromeFadeHealTimer = 0; }
    if (fsChromeFadeHoldTimer) { clearTimeout(fsChromeFadeHoldTimer); fsChromeFadeHoldTimer = 0; }
    if (!fsOverlay || !fsChromeFading) return;
    // Minimum visible hold: if the media was ready the same tick the fade-out
    // started (the cover -> MV case, where awaitFsVideoReady resolves before a
    // frame paints), do not restore yet — defer so the dissolve actually reads.
    const wait = FS_CHROME_FADE_MIN_MS - (performance.now() - fsChromeFadeOutAt);
    if (wait > 0) {
      fsChromeFadeHoldTimer = window.setTimeout(() => {
        fsChromeFadeHoldTimer = 0;
        if (fsActive && fsChromeFading && fsOverlay) {
          fsChromeFading = false;
          fsOverlay.classList.remove("ym-sl-fs-chrome-out");
        }
      }, wait);
      return;
    }
    fsChromeFading = false;
    fsOverlay.classList.remove("ym-sl-fs-chrome-out");
  }

  function fsFadeOutMedia() {
    if (!fsOverlay) return;
    fsMediaFadingOut = true;
    fsMediaFadeOutAt = performance.now();
    if (fsMediaFadeTimer) { clearTimeout(fsMediaFadeTimer); fsMediaFadeTimer = 0; }
    // The class fades the media AND its ambient backdrop together — see the
    // .ym-sl-fs-dissolving rules in 05-styles. Fading the media alone was
    // invisible on music videos, because the backdrop is a blurred copy of the
    // same frame.
    fsOverlay.classList.add("ym-sl-fs-dissolving");
    fsNoteDissolve("out");
    // Safety net: never leave the pane dissolved. 1.5s is longer than a normal
    // image decode or video-metadata load, so it only fires on a real failure.
    if (fsMediaFadeSafetyTimer) clearTimeout(fsMediaFadeSafetyTimer);
    fsMediaFadeSafetyTimer = setTimeout(() => {
      fsMediaFadeSafetyTimer = 0;
      if (fsActive) fsFadeInMedia();
    }, 1500);
  }

  function fsFadeInMedia() {
    if (!fsOverlay || !fsMediaFadingOut) return;
    fsMediaFadingOut = false;
    if (fsMediaFadeSafetyTimer) { clearTimeout(fsMediaFadeSafetyTimer); fsMediaFadeSafetyTimer = 0; }
    // Never cut the fade-out short: if the incoming media is ready before the
    // 220ms out has elapsed, wait out the remainder so the dip always completes
    // instead of bouncing back from half opacity.
    const wait = Math.max(0, FS_MEDIA_FADE_OUT_MS - (performance.now() - fsMediaFadeOutAt));
    if (fsMediaFadeTimer) { clearTimeout(fsMediaFadeTimer); fsMediaFadeTimer = 0; }
    const run = () => {
      if (!fsOverlay || fsMediaFadingOut) return;
      // Removing the class lets each layer return to its own natural opacity via
      // its own transition (media .25s, Kawarp .6s) — no inline values to clean up.
      fsOverlay.classList.remove("ym-sl-fs-dissolving");
      fsNoteDissolve("in");
      // No-op unless a mode change faded the chrome out.
      fsChromeFadeIn();
    };
    if (wait > 0) fsMediaFadeTimer = setTimeout(run, wait);
    else run();
  }

  // ---- one fade-out per track change ------------------------------------
  // Two independent signals report a skip and they do NOT agree on timing:
  //  - a media event (emptied / loadstart) fires when YTM reloads the <video>.
  //    On a COVER -> * skip that is immediate. On an MV -> COVER skip the element
  //    is not reloaded until WE restore it, so the first event lands AFTER the new
  //    cover is already on screen — which is exactly the "cover shows first, then
  //    disappears, then fades in" AJ reported (2026-10-20).
  //  - the player response's videoId changes on every skip, immediately.
  // Both funnel through here, and only ONE fade-out is allowed per track change.
  const FS_MEDIA_FADE_DEDUPE_MS = 1200;

  function fsMaybeFadeForTrackChange(id) {
    if (id && id === fsFadeTrackId) return; // same track — nothing to do
    const now = performance.now();
    if (now - fsFadeAt < FS_MEDIA_FADE_DEDUPE_MS) {
      // Already dissolving for this change. Remember the id so the second signal
      // cannot start a second fade on top of the one in flight.
      if (id) fsFadeTrackId = id;
      return;
    }
    fsFadeAt = now;
    if (id) fsFadeTrackId = id;
    // Sync the control dissolve with the media dissolve.
    if (fsOverlay && !fsSavedVideo) {
      // LEAVING a cover-art track (cover -> MV or cover -> cover): the controls
      // fade out on the same beat the media does, not when the next video finishes
      // attaching.
      fsChromeFadeOut();
    } else if (fsOverlay && fsSavedVideo) {
      // LEAVING a music video: an MV -> MV reload and an MV -> cover look
      // identical at the skip instant (both still have a live player video). The
      // restructure is gated by the debounce below so a reload is never mistaken
      // for a cover, but the control fade should NOT wait that long. Probe a beat
      // later: if the player video is GONE by then it is a cover -> dissolve the
      // controls now, synced with the video leaving; if it survived it is MV -> MV
      // and the controls must stay perfectly still.
      window.setTimeout(() => {
        if (!fsActive || !fsSavedVideo) return;
        if (!findPlayerVideo()) fsChromeFadeOut();
      }, 170);
    }
    fsFadeOutMedia();
  }

  function revealFsMediaPaneNow() {
    // Every "the pane may come back" path funnels through the dissolve now; if
    // no fade-out is pending this is a no-op.
    fsFadeInMedia();
  }

  // Kept as the call-site name, but no longer gated on FS_MEDIA_SETTLE_MS: that
  // gate existed to let the pane's geometry transition finish before revealing,
  // and the geometry is static now. Holding the fade-in for it added up to 800ms
  // of black between the outgoing and incoming media (AJ, 2026-10-20).
  function revealFsMediaPane() {
    revealFsMediaPaneNow();
  }

  // Dedicated to the video-ready wait: same look as the loading spinner but a
  // separate node, driven by its own lifecycle.
  function ensureFsVideoSpinner() {
    if (fsVideoSpinnerEl) return fsVideoSpinnerEl;
    if (!fsOverlay) return null;
    fsVideoSpinnerEl = h("div", { class: "ym-sl-fs-spinner", "aria-hidden": "true" });
    const svg = fsSvgIcon(FS_ICON_SPINNER, "0 0 24 24");
    svg.setAttribute("class", "ym-sl-fs-spinner-icon");
    fsVideoSpinnerEl.appendChild(svg);
    return fsVideoSpinnerEl;
  }

  function hideFsVideoSpinner() {
    if (fsVideoSpinnerEl) fsVideoSpinnerEl.classList.remove("visible");
  }

  // Invalidate a pending wait (video detached, or fullscreen exited) so its
  // spinner can never linger over a later track.
  function cancelFsVideoReady() {
    fsVideoReadySeq++;
    // The held card is released with the wait — reconcile owns it again.
    fsHoldCoverCard = false;
    hideFsVideoSpinner();
  }

  function awaitFsVideoReady(video) {
    const seq = ++fsVideoReadySeq;
    hideFsVideoSpinner();
    if (!fsActive || !video) { fsHoldCoverCard = false; revealFsMediaPane(); return; }
    let spinnerTimer = 0;
    let pollTimer = 0;
    let giveUpTimer = 0;
    const startedAt = performance.now();
    let lastTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    let progressed = false;
    let done = false;
    let frameHandle = 0;
    function cleanup() {
      done = true;
      if (spinnerTimer) { window.clearTimeout(spinnerTimer); spinnerTimer = 0; }
      if (pollTimer) { window.clearTimeout(pollTimer); pollTimer = 0; }
      if (giveUpTimer) { window.clearTimeout(giveUpTimer); giveUpTimer = 0; }
      if (frameHandle && typeof video.cancelVideoFrameCallback === "function") {
        try { video.cancelVideoFrameCallback(frameHandle); } catch (_) {}
        frameHandle = 0;
      }
      video.removeEventListener("playing", check);
      video.removeEventListener("timeupdate", check);
      video.removeEventListener("seeked", check);
    }
    function finish() {
      if (done || seq !== fsVideoReadySeq) return;
      cleanup();
      hideFsVideoSpinner();
      // HARD CUT (AJ, 2026-10-20): the outgoing cover card is removed in the SAME
      // frame the video becomes visible, so there is no cross-dissolve and no
      // empty pane in between. Guarded on the video actually living in the pane,
      // because the give-up timer can fire after a teardown.
      if (video.parentElement === fsMediaHost) {
        if (fsArtImg && fsArtImg.parentElement === fsMediaHost) {
          fsMediaHost.removeChild(fsArtImg);
        }
        fsArtImg = null;
        fsHoldCoverCard = false;
      }
      video.style.setProperty("opacity", "1", "important");
      revealFsMediaPane();
    }
    function check() {
      if (done || seq !== fsVideoReadySeq) return;
      const t = video.currentTime;
      // A recycled element reports NaN until the NEW stream has metadata. Letting
      // that reach lastTime poisoned every later comparison, so the gate could
      // only be satisfied by the 8s give-up timer (AJ, 2026-10-20).
      if (!Number.isFinite(t)) return;
      // A NEW SOURCE resets the clock. MV -> MV keeps the same element, so
      // currentTime jumps back to ~0 — without this the gate kept comparing
      // against the OLD track's position and could never be satisfied.
      if (t < lastTime - 1) { lastTime = t; progressed = false; return; }
      if (t > lastTime + 0.02) progressed = true;
      lastTime = t;
      if (progressed && video.readyState >= 2 && video.videoWidth > 0 && !video.paused) { finish(); return; }
      // PAUSED SKIP (AJ, 2026-10-20): a paused video never advances, so the
      // progress test above can never pass and the pane would stay dissolved to
      // the backdrop until the 8s give-up. A paused element with metadata already
      // has its frame decoded, so show it after a short grace.
      if (video.paused && video.readyState >= 2 && video.videoWidth > 0 &&
          performance.now() - startedAt > 400) finish();
    }
    // ⭐ Frame-accurate detection (AJ, 2026-10-20). timeupdate is throttled to
    // ~4Hz and the poll is one timer tick, so both can sit on an already-ready
    // video for a whole interval — that interval is the "the video is hidden"
    // delay on cover -> MV. requestVideoFrameCallback fires on the next PRESENTED
    // frame (~16ms at 60fps), which is exactly the moment the new content is on
    // screen. Falls back silently where the API is missing (the poll still runs).
    function watchFrames() {
      if (done || seq !== fsVideoReadySeq) return;
      if (typeof video.requestVideoFrameCallback !== "function") return;
      frameHandle = video.requestVideoFrameCallback(() => {
        frameHandle = 0;
        if (done || seq !== fsVideoReadySeq) return;
        check();
        watchFrames();
      });
    }
    function poll() {
      if (done || seq !== fsVideoReadySeq) return;
      check();
      if (!done && seq === fsVideoReadySeq) {
        pollTimer = window.setTimeout(poll, FS_VIDEO_READY_POLL_MS);
      }
    }
    video.addEventListener("playing", check);
    video.addEventListener("timeupdate", check);
    video.addEventListener("seeked", check);
    watchFrames(); // frame-accurate; the poll below is only the backstop
    poll(); // timeupdate is throttled, so poll as the backstop
    spinnerTimer = window.setTimeout(() => {
      spinnerTimer = 0;
      if (done || seq !== fsVideoReadySeq || !fsActive) return;
      // Show the pane so the spinner is visible; by now the aspect-ratio
      // transition has settled, so this is no longer the old square card.
      revealFsMediaPane();
      const el = ensureFsVideoSpinner();
      if (!el || !fsMediaHost) return;
      if (el.parentElement !== fsMediaHost) fsMediaHost.appendChild(el);
      void el.offsetWidth;
      el.classList.add("visible");
    }, FS_SPINNER_DELAY_MS);
    giveUpTimer = window.setTimeout(() => {
      giveUpTimer = 0;
      if (done || seq !== fsVideoReadySeq) return;
      finish();
    }, FS_VIDEO_READY_MAX_MS);
  }

  // Artwork fallback straight off the player bar's own thumbnail. It is always
  // in step with what YTM is playing, whereas getCurrentTrack() can lag a skip
  // by a beat - and a lagging read is exactly what left the fullscreen pane
  // empty after a skip (AJ, 2026-09-28).
  function getDomArtworkUrl() {
    const img = document.querySelector("ytmusic-player-bar img.image") ||
      document.querySelector("ytmusic-player-bar .thumbnail img") ||
      document.querySelector("ytmusic-player-bar img");
    if (!img) return "";
    return img.getAttribute("src") || img.currentSrc || "";
  }

  // Set fsArtImg.src with a cover-card crossfade (2026-09-28). The sharp card
  // and the Kawarp canvas both load the new art independently, and the
  // browser keeps painting the OLD decoded bitmap during the decode window
  // — so for a beat the pane showed the old sharp card alongside the new
  // Kawarp output (AJ, 2026-09-28). Marking the card as loading drops it
  // to opacity 0; removing the mark on the img's load event lets it fade
  // back in, by which point Kawarp also has the new art and the two
  // reveal together. fsArtImgSeq invalidates stale onloads when src changes
  // mid-decode; the timeout is the belt that prevents a hung decode from
  // stranding the card at opacity:0.
  // ⭐ NO PER-CARD FADE AT ALL (AJ, 2026-10-21). This used to toggle
  // `.ym-sl-fs-art-loading` (card opacity 0 -> 1 over .28s) to hide the old
  // bitmap while the new one decoded. That was a SECOND opacity animation
  // competing with the host dissolve, and reconcile can re-set the src
  // (bar thumbnail -> real artwork) up to 2s after a skip — outside any
  // "recently faded" window — so the card blinked on its own. That blink is the
  // "cover art flashes for some ms" AJ kept seeing.
  // The dissolve owns every reveal now. The browser keeps painting the previous
  // bitmap until the new one decodes, and outside a track change that bitmap is
  // the SAME artwork (a resolution variant), so nothing wrong is ever shown.
  function setFsArtSrc(img, src) {
    if (!img || !src) return;
    if (img.getAttribute("src") === src) return;
    const seq = ++fsArtImgSeq;
    // The card is revealed by the host dissolve; this only drives its fade-in.
    const reveal = () => { if (seq === fsArtImgSeq) fsFadeInMedia(); };
    img.onload = reveal;
    img.onerror = reveal;
    img.setAttribute("src", src);
    // A cached image can already be complete here; onload still fires, but rAF
    // covers the same-frame gap so a cached cover does not wait a task.
    if (img.complete && img.naturalWidth > 0) requestAnimationFrame(reveal);
  }

  // The pane must hold at most ONE sharp cover card. Two code paths can create
  // it — the 2s reconcile tick and the MV -> cover swap in syncFsVideoMode — and
  // when both ran for the same skip the second overwrote fsArtImg while the
  // first stayed in the DOM, so the pane showed the cover TWICE, side by side
  // (AJ, 2026-09-28). This is now the single create-or-reuse entry point.
  // A YouTube video thumbnail is NOT cover art — it is the music video's own
  // hqdefault (letterboxed, low-res) and the real video is about to fill the
  // pane. Rendering it put that thumbnail in a square card for the ~1s before
  // the video attached (AJ, 2026-09-28: the reconcile resolved
  // i.ytimg.com/vi/<id>/hqdefault.jpg). Album art
  // lives on yt3/lh3.googleusercontent.com, so the /vi/ path is the tell.
  function isVideoThumbnailUrl(url) {
    return typeof url === "string" && /^https?:\/\/i\.ytimg\.com\/vi\//.test(url);
  }

  function ensureFsArtImg() {
    if (!fsMediaHost) return null;
    if (fsArtImg && !fsArtImg.isConnected) fsArtImg = null;
    const cards = fsMediaHost.querySelectorAll(".ym-sl-fs-art");
    for (let i = 0; i < cards.length; i++) {
      if (cards[i] !== fsArtImg) cards[i].remove();
    }
    if (!fsArtImg) {
      fsArtImg = h("img", { class: "ym-sl-fs-art", alt: "" });
      fsMediaHost.appendChild(fsArtImg);
    }
    return fsArtImg;
  }

  // ---- Animated Apple Music cover (artwork.m8tec.top) --------------------
  // Source: a public Apple Music animated-artwork (HLS .m3u8) lookup keyed by
  // artist / album / title. Chrome/Comet cannot play HLS natively, so the stream
  // is attached through the vendored hls.js (loaded into the page world by
  // content.js as window.Hls) onto a looping, muted <video> that shares the
  // static cover card's box. AJ chose the "cover card only" placement — the
  // sharp centre square animates; the blurred backdrop stays the static YTM
  // cover. The static <img> is ALWAYS the fallback: any lookup / fetch / decode
  // failure simply leaves the card as-is.
  const M8TEC_SEARCH = "https://artwork.m8tec.top/api/v1/artwork/search";
  // The m8tec search REQUIRES the album parameter — a query without it 400s
  // (verified live: artist/title-only -> 400, artist+album -> valid 200/404).
  // getTrack() only fills `album` when the player bar contains an /album/
  // link, and singles / radio tracks often ship without one, which is exactly
  // the 400s AJ saw in the console (2026-10-03). Parse the bar's byline
  // ("Artist • Album • Year") as a fallback: the album is the first segment
  // after the artist that is not a view/listen count and not a bare year.
  function deriveAlbumFromBar() {
    const bar = document.querySelector("ytmusic-player-bar");
    if (!bar) return "";
    const el = bar.querySelector(".subtitle") || bar.querySelector(".byline");
    const text = el && el.textContent ? el.textContent.trim() : "";
    if (!text) return "";
    const segments = text.split(/\s*[•·]\s*/).map((s) => s.trim()).filter(Boolean);
    // segments[0] is the artist (cleanArtist in public-api eats the same slot).
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      if (/^\d{4}$/.test(seg)) continue; // a bare year
      // Video-style counters: "1,234 views" / "2.3M views" / "10K plays".
      if (/^\d+(?:[.,]\d+)?\s*(?:[kmb]|million|thousand|billion)?\s*(?:views?|listens?|plays?)\b/i.test(seg)) continue;
      if (/^(?:\d+\s+)?years?\s+ago$/i.test(seg)) continue;
      return seg;
    }
    return "";
  }

  // Build the m8tec query for a track, album-derived-from-bar included, and a
  // stable key from it. The key MUST include the derived album: the race guard
  // compares keys built the same way, otherwise a bar-derived album would
  // never match and the fetched stream would silently never attach.
  function animatedArtQuery(track) {
    return {
      artist: (track && track.artist) || "",
      album: (track && track.album) || deriveAlbumFromBar(),
      title: (track && track.title) || "",
    };
  }

  function animatedArtKey(query) {
    return [query.artist, query.album, query.title]
      .map((s) => (s || "").trim().toLowerCase())
      .filter(Boolean)
      .join(" :: ");
  }

  // Off-screen but IN-VIEWPORT host. A video that is offscreen or display:none is
  // throttled by Chrome and would not actually buffer, so this sits at the
  // viewport origin at zero opacity with no pointer events (AJ, 2026-10-03).
  function ensureArtWarmHost() {
    if (fsArtWarmHost && fsArtWarmHost.isConnected) return fsArtWarmHost;
    fsArtWarmHost = h("div", { class: "ym-sl-art-warm", "aria-hidden": "true" });
    // Inline rather than in the CSS template: this host is single-purpose, and it
    // must never be caught by a fullscreen-scoped rule. In-viewport at opacity:0
    // (NOT display:none / offscreen) so Chrome still decodes and buffers.
    fsArtWarmHost.style.cssText =
      "position:fixed;left:0;top:0;width:583px;height:583px;" +
      "opacity:0;pointer-events:none;z-index:-1;overflow:hidden;";
    (document.body || document.documentElement).appendChild(fsArtWarmHost);
    return fsArtWarmHost;
  }

  // The player-view cover-art container (NOT fullscreen). Anchoring to the
  // container with inset:0 makes the layer track its box automatically, so an
  // expanded left panel (smaller art) needs no re-measure (AJ, 2026-10-03).
  function artInlineHost() {
    const host = document.getElementById("song-image");
    return (host && host.isConnected) ? host : null;
  }

  // visibility (NOT display) so the container keeps its size and the layout does
  // not jump when the cover is swapped.
  function setInlineCoverHidden(hidden) {
    const img = document.querySelector("#song-image img");
    if (img) img.style.visibility = hidden ? "hidden" : "";
  }

  // Park the art video in the right home and give it the matching geometry. ONE
  // element serves BOTH surfaces: the player's #song-image normally, and the
  // fullscreen media pane while fullscreen is open (AJ, 2026-10-03).
  function placeArtVideo() {
    if (!fsArtVideo) return;
    const inFs = !!(fsActive && fsMediaHost);
    const target = inFs ? fsMediaHost : (artInlineHost() || ensureArtWarmHost());
    if (!target) return;
    if (fsArtVideo.parentElement !== target) target.appendChild(fsArtVideo);
    // ⭐ Geometry follows where the element ACTUALLY lives, not the inFs flag
    // (AJ, 2026-10-20). The flag and the real parent can disagree for a frame or
    // more after leaving fullscreen: the fs branch below strips the inline sizing
    // and expects the .ym-sl-fs-media > video CSS to provide it, which does NOT
    // match inside #song-image. The element then fell back to a 16:9 box inside
    // the SQUARE player, so YTM's own #606060 background showed above and below it
    // — that is the grey box, and the same desync is why two cover arts appeared
    // in fullscreen. Keying off the real parent makes the branches impossible to
    // desync.
    const parentIsFsMedia = !!(
      fsArtVideo.parentElement &&
      fsArtVideo.parentElement.classList.contains("ym-sl-fs-media")
    );
    if (parentIsFsMedia) {
      // The fullscreen stylesheet owns the geometry.
      //
      // PRESERVE the inline `display`. Assigning cssText replaces the WHOLE
      // inline style, which used to erase the `display:none` that keeps a
      // not-yet-ready (or missed) video OUT of the pane's flex row. With it
      // gone, the video became a second 583px square beside the static card:
      // two squares in a 960px row shoved the cover art to x=-65, so the
      // title/seek/transport anchored to it were clipped on the left
      // (live-measured: img x=-65, video x=518, AJ 2026-10-18).
      // Visibility of the video is owned by attachAnimatedArt/hideAnimatedArt;
      // this function only owns its HOME and GEOMETRY.
      const keepDisplay = fsArtVideo.style.display;
      fsArtVideo.style.cssText = "background:transparent;";
      fsArtVideo.style.display = keepDisplay;
    } else {
      fsArtVideo.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" +
        "border-radius:inherit;z-index:1;pointer-events:none;background:transparent;";
    }
    // The static YTM cover is hidden ONLY while the animated one is actually up on
    // the page — never in fullscreen (the overlay covers it) and never before the
    // stream is ready.
    setInlineCoverHidden(!inFs && fsArtVideo.classList.contains("ym-sl-fs-art-video-ready"));
  }

  function ensureFsArtVideo() {
    // In fullscreen the media pane owns it; otherwise the player's cover-art
    // container does (the warm host is only a fallback if that is absent).
    const parent = fsMediaHost || artInlineHost() || ensureArtWarmHost();
    if (!parent) return null;
    // NOTE: a YTM re-render can DETACH the video. Do NOT drop it for that — a
    // detached element keeps playing, and dropping it forced a full re-attach
    // (engine torn down + video hidden until the new manifest parsed), which
    // flickered the cover back to YTM's own art (AJ, 2026-10-03). The
    // placeArtVideo() call below re-homes it instead.
    if (!fsArtVideo) {
      fsArtVideo = h("video", {
        class: "ym-sl-fs-art-video",
        muted: "muted",
        loop: "loop",
        playsinline: "true",
        "webkit-playsinline": "true",
        preload: "auto",
        "aria-hidden": "true",
      });
      // hls.js needs the element present in the DOM to attachMedia().
      parent.appendChild(fsArtVideo);
      // The muted ATTRIBUTE set by h() does not always reflect to the muted
      // PROPERTY before play() in Chrome, and a non-muted autoplay is blocked.
      // Force it directly so the loop can autoplay without a user gesture.
      fsArtVideo.muted = true;
      fsArtVideo.defaultMuted = true;
    }
    // Home + geometry (this also sets the transparent background, so a frameless
    // video can never flash black over the cover).
    placeArtVideo();
    return fsArtVideo;
  }

  // Pause + hide the animated video and reveal the static card underneath.
  // Used transiently (mid-lookup, on failure) — the element is kept for reuse.
  // display:none is ESSENTIAL, not cosmetic: the video is a flex child of the
  // media pane, and left merely at opacity:0 it still takes its 583px of flex
  // space beside the static card — the two-square row overflowed the 960px
  // pane and shoved the cover art half off-screen to the left
  // (live-measured img x=-65, AJ, 2026-10-03).
  function hideAnimatedArt() {
    if (fsArtVideo) {
      fsArtVideo.classList.remove("ym-sl-fs-art-video-ready");
      fsArtVideo.style.display = "none";
      try { fsArtVideo.pause(); } catch (_) {}
    }
    if (fsArtVideoHls) {
      try { fsArtVideoHls.destroy(); } catch (_) {}
      fsArtVideoHls = null;
    }
    if (fsArtImg) fsArtImg.style.display = "";
    // The ready class is gone, so this restores the player view's own cover too.
    placeArtVideo();
    // The static card is back in layout. No band re-publish needed — the chrome
    // no longer anchors to the art box (AJ, 2026-10-20).
  }

  // Full removal: drop the video element + its hls instance entirely. Used when
  // a music video owns the pane, where animated cover art must never show.
  function destroyAnimatedArt() {
    if (fsArtVideoHls) { try { fsArtVideoHls.destroy(); } catch (_) {} fsArtVideoHls = null; }
    if (fsArtVideo) {
      try { fsArtVideo.pause(); } catch (_) {}
      if (fsArtVideo.parentElement) fsArtVideo.parentElement.removeChild(fsArtVideo);
      fsArtVideo = null;
    }
    fsArtVideoKey = "";
    fsArtVideoLoadingKey = "";
    if (fsArtImg) fsArtImg.style.display = "";
    setInlineCoverHidden(false); // the player view gets its own cover back
    // Static card is laid out again. No band re-publish (AJ, 2026-10-20).
  }

  // A CACHED animated cover is about to load, so do NOT show the static YTM cover
  // first: hide the card and let the pane keep its blurred backdrop until the
  // video can actually paint. This is what makes a cached track read as instant
  // (AJ, 2026-10-03). Every failure path calls hideAnimatedArt(), which restores
  // the card, so a dead stream still degrades to the static cover.
  function suppressStaticCardForAnimated() {
    if (fsArtImg) fsArtImg.style.display = "none";
  }

  function attachAnimatedArt(m3u8Url) {
    const video = ensureFsArtVideo();
    if (!video) return;
    const Hls = window.Hls;
    if (!Hls) { hideAnimatedArt(); return; } // native HLS unsupported in Chrome
    const onReady = () => {
      // MANIFEST_PARSED fires BEFORE any frame is decoded, and a frameless <video>
      // paints black — so wait for the first decodable frame (readyState >= 2) and
      // only then bring it into layout + fade it in. The static card is already
      // hidden by suppressStaticCardForAnimated(), so the pane shows the blurred
      // backdrop in the meantime: no black flash and no wrong-cover flash
      // (AJ, 2026-10-03).
      const paint = () => {
        // Back into layout (hideAnimatedArt sets inline display:none) BEFORE the
        // fade-in, and only then hide the static card — never both at once.
        video.style.display = "";
        video.classList.add("ym-sl-fs-art-video-ready");
        if (fsArtImg) fsArtImg.style.display = "none";
        // Player view: hide YTM's own cover now that the animated one is up.
        placeArtVideo();
        // No band re-publish: the chrome is at fixed offsets (AJ, 2026-10-20).
        const p = video.play();
        if (p && p.catch) p.catch(() => {}); // autoplay may be deferred; ignore
      };
      let painted = false;
      const once = () => {
        if (painted) return;
        // Superseded by a newer track's attach (the element is REUSED) — painting
        // now would reveal the previous stream.
        if (fsArtVideo !== video || !video.isConnected) return;
        painted = true;
        paint();
      };
      if (video.readyState >= 2) { once(); return; }
      video.addEventListener("loadeddata", once, { once: true });
      // Never strand the pane on the backdrop if the frame never arrives. Safe
      // because the video's own background is transparent (ensureFsArtVideo), so a
      // still-frameless element reveals the backdrop rather than a black box.
      setTimeout(once, 1500);
    };
    // Tear down any previous stream before loading the new one.
    if (fsArtVideoHls) { try { fsArtVideoHls.destroy(); } catch (_) {} fsArtVideoHls = null; }
    // Out of the flex row while the engine loads: a second square beside the
    // static card overflows the pane and shifts the band (Round 90). onReady
    // brings it back into layout right before the fade-in.
    video.style.display = "none";
    if (Hls.isSupported()) {
      const engine = new Hls({
        // enableWorker:false — the worker boot is pure latency before the first
        // frame, and the manifest parse here is tiny (AJ, 2026-10-03).
        enableWorker: false,
        // Start on the LOWEST level so the first segment is the smallest one on
        // offer; ABR climbs once it is playing. Starting mid/high cost hundreds of
        // ms before anything appeared.
        startLevel: 0,
        maxBufferLength: 12,
        maxMaxBufferLength: 30,
        capLevelToPlayerSize: true,
      });
      engine.loadSource(m3u8Url);
      engine.attachMedia(video);
      engine.on(Hls.Events.MANIFEST_PARSED, onReady);
      engine.on(Hls.Events.ERROR, (_e, data) => {
        if (data && data.fatal) {
          try { engine.destroy(); } catch (_) {}
          if (fsArtVideoHls === engine) fsArtVideoHls = null;
          // The cached manifest URL failed (expired or moved), so drop it from
          // BOTH caches and pin the key for this session — otherwise the 2s tick
          // would retry the same dead URL for the rest of the 30-day window.
          artCacheDelete(fsArtVideoKey);
          fsArtVideoCache.delete(fsArtVideoKey);
          if (fsArtVideoKey) fsArtVideoFail.add(fsArtVideoKey);
          hideAnimatedArt();
        }
      });
      fsArtVideoHls = engine;
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari / native HLS path.
      video.src = m3u8Url;
      video.addEventListener("loadedmetadata", onReady, { once: true });
      video.addEventListener("error", () => hideAnimatedArt(), { once: true });
    } else {
      hideAnimatedArt();
    }
  }

  // ---- persisted animated-art cache helpers --------------------------------
  // Read once per page load, then served from the in-memory mirror, so a lookup
  // costs no storage round-trip. Writes coalesce into one storage write.
  async function loadArtCache() {
    if (artCache) return artCache;
    if (artCacheLoad) return artCacheLoad;
    if (!window.YTMod || typeof window.YTMod.getArtCache !== "function") {
      artCache = {}; // no bridge -> every lookup misses, but nothing breaks
      return artCache;
    }
    artCacheLoad = window.YTMod.getArtCache().then((stored) => {
      artCache = (stored && typeof stored === "object" && !Array.isArray(stored)) ? stored : {};
      const swept = sweepArtCache(Date.now());
      // Page-world log so it is visible in the console alongside the lyrics cache
      // lines (the isolated-world copy of this log is not surfaced).
      console.log(`[SpicyLyrics] art cache init: ${Object.keys(artCache).length} entries${swept ? " (expired swept)" : ""}.`);
      return artCache;
    }).catch(() => { artCache = {}; return artCache; });
    return artCacheLoad;
  }

  function flushArtCache() {
    if (!artCache || !artCacheDirty) return;
    artCacheDirty = false;
    if (!window.YTMod || typeof window.YTMod.setArtCache !== "function") return;
    const snapshot = artCache;
    Promise.resolve(window.YTMod.setArtCache(snapshot)).catch(() => {});
  }

  function markArtCacheDirty() {
    artCacheDirty = true;
    if (artCacheFlushTimer) return;
    artCacheFlushTimer = setTimeout(() => {
      artCacheFlushTimer = 0;
      flushArtCache();
    }, 1500);
  }

  // Expired or malformed entries can never be served, which is what makes the
  // 30-day window a real guarantee rather than a best-effort one.
  function sweepArtCache(now) {
    if (!artCache) return false;
    let removed = false;
    for (const [k, entry] of Object.entries(artCache)) {
      if (!entry || typeof entry !== "object" || entry.v !== ART_CACHE_VERSION ||
          typeof entry.url !== "string" || !entry.url ||
          !Number.isFinite(entry.exp) || entry.exp <= now) {
        delete artCache[k];
        removed = true;
      }
    }
    return removed;
  }

  // LRU-ish cap: entries carry `at` so the oldest go first.
  function trimArtCache() {
    if (!artCache) return false;
    const keys = Object.keys(artCache);
    if (keys.length <= ART_CACHE_LIMIT) return false;
    keys.sort((a, b) => (artCache[a].at || 0) - (artCache[b].at || 0))
      .slice(0, keys.length - ART_CACHE_LIMIT)
      .forEach((k) => { delete artCache[k]; });
    return true;
  }

  // Read-through: a live persisted URL for this key, else "".
  function artCacheGet(key) {
    if (!artCache || !key) return "";
    const entry = artCache[key];
    if (!entry || typeof entry !== "object") return "";
    if (entry.v !== ART_CACHE_VERSION || !Number.isFinite(entry.exp) || entry.exp <= Date.now()) return "";
    return typeof entry.url === "string" ? entry.url : "";
  }

  function artCacheSet(key, url) {
    if (!artCache || !key || !url) return;
    const now = Date.now();
    artCache[key] = { v: ART_CACHE_VERSION, url, at: now, exp: now + ART_CACHE_TTL_MS };
    trimArtCache();
    markArtCacheDirty();
  }

  // Drop one key. Used when an HLS stream fails, so a manifest URL that went
  // stale inside the 30-day window cannot be replayed forever.
  function artCacheDelete(key) {
    if (!artCache || !key || !artCache[key]) return;
    delete artCache[key];
    markArtCacheDirty();
  }

  // Pre-load the animated cover while NOT in fullscreen, so opening fullscreen
  // shows it with no HLS startup at all: the stream buffers in the warm host and
  // enterFullscreenMode() moves the video into the media pane (AJ, 2026-10-03).
  // CACHED urls only — this never adds an m8tec API call, it just starts the
  // stream early for tracks already known to have animated art.
  async function warmAnimatedArt() {
    if (fsActive) return; // the fullscreen reconcile already owns this track
    if (!window.YTMod || typeof window.YTMod.getArtCache !== "function") return;
    // FULL lookup (cache THEN API) so a track gets cached the first time it plays
    // ANYWHERE — not only while fullscreen happens to be open. That is one m8tec
    // call per unique track, and 30 days of instant replays after it
    // (AJ, 2026-10-03).
    const track = getCurrentTrack();
    if (!track) return;
    await refreshAnimatedArt(track);
  }

  // Reconcile the animated cover against the current track. Fire-and-forget: it
  // reads the same track object reconcileFsMediaArt() just resolved, so the
  // static card and the video never disagree about WHICH song is playing.
  async function refreshAnimatedArt(track) {
    // Fullscreen: the media pane owns the video. Outside: the warm host does — so
    // this may run in BOTH. Either way the element needs a home.
    if (fsActive) {
      if (!fsMediaHost) return;
    } else if (!ensureArtWarmHost()) {
      return;
    }
    // Feature switch (Aurora Lyrics settings, AJ 2026-10-03). Off -> tear the art
    // down and stop; the player view and fullscreen both fall back to the cover.
    if (currentSettings.animatedArt === false) {
      hideAnimatedArt();
      return;
    }
    // Outside fullscreen, YTM plays a music video in its OWN #song-media-window (a
    // plain song leaves that element at opacity ~0). Testing THAT rather than
    // findPlayerVideo() avoids false positives from YTM's recycled <video>, which
    // was hiding the animated cover on ordinary audio tracks (AJ, 2026-10-03).
    if (!fsActive) {
      const mediaWindow = document.getElementById("song-media-window");
      const mvVisible = mediaWindow &&
        parseFloat(window.getComputedStyle(mediaWindow).opacity) > 0.5;
      if (mvVisible) { hideAnimatedArt(); return; }
    }
    const query = animatedArtQuery(track);
    const key = animatedArtKey(query);
    // No album -> the API would 400. BUT the player-bar byline LAGS a skip, so an
    // empty album here usually just means "not settled yet" — and the old
    // hideAnimatedArt() call REVEALED the static card, which is exactly the
    // ~600ms static-cover flash before the animated one (AJ, 2026-10-03). Hold the
    // backdrop hidden and retry shortly instead; only give up (and show the cover)
    // after a few attempts. Still never cached as "no artwork".
    if (!query.album || !key) {
      const rough = (query.artist || "") + "::" + (query.title || "");
      if (fsArtNoAlbumKey !== rough) { fsArtNoAlbumKey = rough; fsArtNoAlbumTries = 0; }
      if (fsArtNoAlbumTries < 3) {
        fsArtNoAlbumTries++;
        console.log(`[SpicyLyrics] animated art: album not settled for "${rough}" (try ${fsArtNoAlbumTries}) — holding the backdrop.`);
        suppressStaticCardForAnimated();
        window.setTimeout(() => { try { refreshAnimatedArt(getCurrentTrack()); } catch (_) {} }, 300);
        return;
      }
      console.log(`[SpicyLyrics] animated art: no album for "${rough}" — showing the static cover.`);
      hideAnimatedArt();
      return;
    }
    // Already HAVE this track's stream — even if the element was momentarily
    // detached by a YTM re-render. Re-home it; NEVER re-attach. A re-attach tears
    // the hls engine down and hides the video until the new manifest parses, which
    // flickered the cover back to YTM's own art every few seconds
    // (AJ, 2026-10-03).
    //
    // Gate on the READY class, not isConnected: hideAnimatedArt() removes the
    // class and display:none's the element but leaves fsArtVideoKey set, so an
    // isConnected check kept taking this branch after a miss and re-hid the
    // static card, leaving the pane blank. A detached-but-ready element keeps
    // the class, so the re-home case is still covered (AJ, 2026-10-18).
    if (fsArtVideoKey === key && (fsArtVideoHls || (fsArtVideo && fsArtVideo.classList.contains("ym-sl-fs-art-video-ready")))) {
      placeArtVideo();
      // No band re-publish: the chrome is at fixed offsets (AJ, 2026-10-20).
      // Re-assert the static card's hide: the MV -> song transition can null
      // fsArtImg (the player-bar artwork briefly still reads as the MV's own
      // i.ytimg thumbnail, so reconcile's thumbnail branch drops the card),
      // and the next cover tick creates a FRESH card that would otherwise sit
      // beside the playing stream in the flex row, shoving everything left
      // (live-scanned: video x=-65 + img x=518, AJ, 2026-10-03).
      if (fsArtImg && fsArtImg.style.display !== "none") fsArtImg.style.display = "none";
      return;
    }
    // Persisted cache (30-day): a hit shows the cover with NO network call at all.
    await loadArtCache();
    const storedUrl = artCacheGet(key);
    if (storedUrl) {
      console.log(`[SpicyLyrics] animated art from CACHE (no API call): ${key}`);
      fsArtVideoCache.set(key, storedUrl);
      fsArtVideoKey = key;
      suppressStaticCardForAnimated();
      attachAnimatedArt(storedUrl);
      return;
    }
    // No artwork for this track, or one is mid-flight — keep the static card.
    if (fsArtVideoFail.has(key) || fsArtVideoLoadingKey === key) {
      if (fsArtVideoKey !== key) hideAnimatedArt();
      return;
    }
    if (fsArtVideoCache.has(key)) {
      const cached = fsArtVideoCache.get(key);
      if (cached) { fsArtVideoKey = key; suppressStaticCardForAnimated(); attachAnimatedArt(cached); }
      else { fsArtVideoFail.add(key); hideAnimatedArt(); }
      return;
    }
    // First sight of this track: look it up (CORS-open; the content script may
    // fetch directly). The static card stays visible until we have a stream.
    fsArtVideoLoadingKey = key;
    // Tear down any previous stream, then HIDE the static card for the duration of
    // the lookup: the pane keeps its blurred backdrop rather than flashing the YT
    // cover and then swapping to the animated one. A definitive miss calls
    // hideAnimatedArt() in the catch below, which brings the cover back
    // (AJ, 2026-10-03).
    hideAnimatedArt();
    suppressStaticCardForAnimated();
    try {
      const params = new URLSearchParams();
      if (query.artist) params.set("artist", query.artist);
      if (query.album) params.set("album", query.album);
      if (query.title) params.set("title", query.title);
      const res = await fetch(M8TEC_SEARCH + "?" + params.toString(), { credentials: "omit" });
      if (!res.ok) throw new Error("m8tec " + res.status);
      const data = await res.json();
      const url = (data && (data.url || data.url_tall)) || "";
      if (!url) throw new Error("no m8tec artwork");
      fsArtVideoCache.set(key, url);
      artCacheSet(key, url); // persisted: the next play needs no API call at all
      fsArtVideoLoadingKey = "";
      // A newer track may have arrived during the await — don't clobber it.
      // Compare against the same query shape (bar-derived album included).
      if (animatedArtKey(animatedArtQuery(getCurrentTrack())) === key) {
        fsArtVideoKey = key;
        attachAnimatedArt(url);
      }
    } catch (err) {
      // Logged so the console distinguishes "this track has no animated art" from
      // "the lookup never ran" — the two look identical from the pane.
      console.log(`[SpicyLyrics] no animated art for ${key} (${(err && err.message) || err}); static cover kept.`);
      fsArtVideoCache.set(key, false);
      fsArtVideoFail.add(key);
      fsArtVideoLoadingKey = "";
      hideAnimatedArt();
    }
  }

  // Reconcile the fullscreen media pane's content against the current track.
  // CREATE-OR-UPDATE, deliberately: the old code only ever updated an existing
  // <img>, and fsArtImg was created in exactly two places (entry, and the
  // MV -> cover detach). So a cover -> cover skip never touched it, and an
  // MV -> cover skip that landed before the new artwork URL existed left the
  // pane empty for good. Called from the 2s refresh tick.
  function reconcileFsMediaArt() {
    if (!fsActive || !fsMediaHost) return;
    // Ask the SAME question syncFsVideoMode asks, instead of trusting the
    // fsSavedVideo flag: YTM recycles the <video> element between tracks, so the
    // flag can say "a video owns the pane" while the element is already dead.
    // That mismatch is what left the pane on a stale video instead of loading
    // the new cover art after an MV -> song skip (AJ, 2026-09-28).
    // Bail when a video is attached AT ALL. findPlayerVideo() additionally
    // requires dimensions, so during a skip it reports null while the video is
    // still sitting in the pane — and creating the card then put a cover image
    // (clamped to the MV pane's short height, hence cropped and small) beside
    // the video until the detach (AJ, 2026-09-28; the trace caught
    // reconcile: cover with pane 960x365 + art 756x365 while has-video was set).
    // ⭐ Decide from the SAME intent signal syncFsVideoMode uses (AJ, 2026-10-21).
    // `findPlayerVideo()` alone is transient during a reload — the recycled
    // element reports videoWidth 0 for a beat — so this branch used to flip on
    // and off mid-skip, removing and re-creating the cover card (the art that
    // "shows, disappears, shows again"). A still-attached video keeps ownership
    // until the detach actually runs.
    const byType = trackHasVideoByType();
    const videoOwnsPane = byType === null
      ? !!(findPlayerVideo() || fsSavedVideo)
      : (byType || !!fsSavedVideo);
    if (videoOwnsPane) {
      // Symmetric teardown: never leave a cover card sitting on top of a video.
      // MV -> MV returns early inside syncFsVideoMode, so nothing else clears it.
      // EXCEPT while a cover -> MV swap is holding the card as its outgoing image
      // (AJ, 2026-10-20) — finish() clears it in the same frame the video shows.
      if (fsArtImg && !fsHoldCoverCard) {
        if (fsArtImg.parentElement) fsArtImg.parentElement.removeChild(fsArtImg);
        fsArtImg = null;
      }
      // ...and tear the animated HLS cover down with it. This guard is the only
      // teardown that runs every 2s while an MV plays (refreshAnimatedArt is
      // never reached on the video path), so it is the safety net for any route
      // that leaves the animated <video> in the pane (AJ, 2026-10-03).
      destroyAnimatedArt();
      return;
    }
    const track = getCurrentTrack();
    const artUrl = (track && track.artworkUrl) || getDomArtworkUrl();
    const hi = hiResArt(artUrl);
    if (!hi) return;
    if (isVideoThumbnailUrl(hi)) {
      // The MV's own thumbnail, not cover art: drop any card. The pane is NOT
      // hidden (AJ, 2026-10-20) — hiding it faded to black and then faded the
      // video back in. It now keeps its blurred backdrop until the video attaches
      // and the reveal is a cut.
      if (fsArtImg) {
        if (fsArtImg.parentElement) fsArtImg.parentElement.removeChild(fsArtImg);
        fsArtImg = null;
      }
      return;
    }
    const img = ensureFsArtImg();
    if (img) setFsArtSrc(img, hi);
    // Keep the backdrop in step with the track IMMEDIATELY. Only the 2s tick used
    // to update it, so a skip left the previous track's blurred art up for up to
    // two seconds — and with the card now hidden during the lookup that lag would
    // be on screen.
    if (fsBgImg && hi && fsBgImg.getAttribute("src") !== hi) fsBgImg.setAttribute("src", hi);
    // Keep the card HIDDEN while the animated lookup runs. AJ's report: skipping to
    // an animated track showed the YT cover and then swapped. The card is created
    // (so a miss has something to reveal) but stays hidden until the lookup
    // definitively misses — the miss paths call hideAnimatedArt(), which restores
    // it (AJ, 2026-10-03).
    suppressStaticCardForAnimated();
    // Kick the animated-cover lookup for this track (cover card only). It reads
    // the SAME track object, so the static card and the video never disagree
    // about which song is playing.
    refreshAnimatedArt(track);
    // The guard above is a ONE-WAY hide (cover-art mode has no other route back
    // to visible: syncFsVideoMode early-returns once the swap settles, and
    // awaitFsVideoReady needs a video). Clear it here now that real cover art is
    // actually in the pane, so a hide that outlived its video cannot strand the
    // pane blank. Harmless when the pane is already visible.
    if (fsMediaHost.style.opacity === "0") revealFsMediaPaneNow();
  }

  function enterFullscreenMode() {
    if (fsActive || !panelEl) return;
    fsActive = true;
    // Fullscreen owns the panel from here, so tab-driven setPanel() is ignored
    // (it early-returns on fsActive). But animate() gates on panelVisible, so
    // entering from a non-Lyrics tab (Comments, …) would leave panelVisible
    // false and the panel painted-but-frozen. Force it on and park the tab state
    // to restore on exit. Cannot call setPanel(true) — fsActive is already true.
    fsSavedPanelVisible = panelVisible;
    panelVisible = true;
    // QOL #1: entering fullscreen cancels the credits reveal (its scroll target
    // belongs to the main panel; fullscreen uses its own lyrics host).
    cancelCreditsReveal();
    // Fullscreen takes over the backdrop entirely, so stop the page-wide Kawarp
    // for every track (song or music video) — only one Kawarp ever runs.
    suspendPageKawarp();
    // The toolbar (and its Options button) is hidden in fullscreen, so close the
    // overlay rather than leaving it stranded behind the fullscreen surface.
    const openOptions = document.querySelector(".ym-sl-options-overlay");
    if (openOptions) openOptions.classList.add("hidden");

    fsSavedPanel = { parent: panelEl.parentElement, next: panelEl.nextSibling };

    // Self-contained blurred-artwork backdrop. We render our own rather than
    // reparenting dynamic.js's Kawarp host because dynamic.js's rootObserver
    // actively yanks pageBgHost back into pageBgRoot, stealing it out of the
    // overlay within a frame.
    const initialTrack = getCurrentTrack();
    const initialArt = initialTrack && initialTrack.artworkUrl;
    fsBgImg = h("img", {
      class: "ym-sl-fs-bg-img",
      src: hiResArt(initialArt) || "",
      alt: "",
    });
    const tint = h("div", { class: "ym-sl-fs-bg-tint" });

    fsMediaHost = h("div", { class: "ym-sl-fs-media" });
    fsLyricsHost = h("div", { class: "ym-sl-fs-lyrics" });
    fsLyricsShade = h("div", { class: "ym-sl-fs-lyrics-shade", "aria-hidden": "true" });
    // The has-video class is added below once we know whether YTM's <video> is
    // real. Video-background mode uses the live video directly plus the
    // readability gradient; there is no cloned or blurred video layer.
    fsOverlay = h("div", { class: "ym-sl-fs-overlay" }, fsBgImg, tint, fsMediaHost, fsLyricsShade, fsLyricsHost);
    document.body.appendChild(fsOverlay);
    // AJ 2026-10-09: the media/lyrics panes are transitioned on left/width, so
    // applying the entry layout to them animates them sliding in from the CSS
    // default (side) — a visible "side layout" flash on cover-art entry. Hold
    // transitions off until the first paint, then drop the class (the double-rAF
    // in buildFullscreenControls does the actual removal so the opacity fade is
    // live too). Layout cycling on the cycle button keeps animating normally.
    fsOverlay.classList.add("ym-sl-fs-no-anim");
    // Overlay title ("Artist Track"). Built here rather than inside
    // buildFullscreenControls() because it is not a control: it belongs to the
    // overlay surface and must exist independently of the chrome row.
    fsTitleEl = h("div", { class: "ym-sl-fs-title", "aria-hidden": "true" });
    // Apply the font family inline so nothing in the cascade can override it
    // (inline style beats every class selector). The CSS rule below declares
    // the same stack for the initial paint; the inline assignment is the
    // belt-and-suspenders that keeps it visible.
    fsTitleEl.style.fontFamily =
      "\"SpicyLyrics\", \"Noto Sans Georgian\", \"Vazirmatn\"," +
      " \"SF Pro Display\", \"SF Pro Text\", \"SF Pro\", -apple-system," +
      " BlinkMacSystemFont, \"Helvetica Neue\", \"Segoe UI\", Arial, sans-serif";
    // The renderer loads SpicyLyrics inside its own mount point, which can
    // leave light-DOM elements (like this title) without the family. Re-pin
    // the stylesheet at document level so the @font-face is visible here too.
    // Best-effort: spikerko.org may CORS-block music.youtube.com, in which case
    // the link silently fails and the inline fontFamily above still applies
    // (falling through to the next family in the stack).
    try {
      if (!document.querySelector("link[data-aurora-spicy-font]")) {
        const fontLink = document.createElement("link");
        fontLink.rel = "stylesheet";
        fontLink.href = "https://fonts.spikerko.org/spicy-lyrics/source.css";
        fontLink.setAttribute("data-aurora-spicy-font", "1");
        document.head.appendChild(fontLink);
      }
    } catch (_) {}
    fsOverlay.appendChild(fsTitleEl);
    // Fullscreen "Next up" list, bottom-left. Reuses the title's font stack so
    // it reads as part of the composition (AJ: "Apple font" = Spicy Lyrics).
    fsNextUp = h("div", { class: "ym-sl-fs-nextup", "aria-hidden": "true" });
    fsNextUp.style.fontFamily = fsTitleEl.style.fontFamily;
    fsOverlay.appendChild(fsNextUp);

    // (The "See all" full-queue panel was removed 2026-10-03: click-to-jump was
    // abandoned, so there is nothing left to open. The Next up list above is
    // now display-only.)
    // Adopt the art video into the pane. It has been playing in the player view
    // (its normal home) since the track started, so the animated cover is on screen
    // with no HLS startup at all — this is what makes entry instant (AJ, 2026-10-03).
    // placeArtVideo() also restores YTM's own player-view cover, which the overlay
    // is about to cover anyway.
    if (fsArtVideo && fsArtVideo.parentElement !== fsMediaHost) {
      placeArtVideo();
      const warmPlay = fsArtVideo.play();
      if (warmPlay && warmPlay.catch) warmPlay.catch(() => {});
    }
    refreshFsTitle();
    // Kick the media reconcile NOW instead of waiting up to 2s for the refresh
    // tick. Entry builds the static cover card immediately, but the animated
    // cover's lookup was only ever started by the tick — so entering fullscreen
    // on a track whose art was already CACHED still showed the YTM cover first for
    // up to two seconds before the animated one appeared (AJ, 2026-10-03).
    reconcileFsMediaArt();
    // Long-title marquee: re-measure whenever the title's box changes width
    // (viewport resize, pane resize, font swap). updateFsTitleMarquee() itself
    // is idempotent — when the text fits it removes the class and leaves the
    // injected <style> tag in place for the next overflow.
    fsTitleRO = new ResizeObserver(() => updateFsTitleMarquee());
    fsTitleRO.observe(fsTitleEl);
    // The font-size transitionend re-measure that used to live here is gone
    // (AJ, 2026-10-20): the chip and scrubber no longer stack off the title's
    // measured height, so there is nothing to re-sync after the zoom.
    // Request native browser fullscreen immediately while the user activation
    // from the click is still fresh. documentElement is always present, always
    // laid out, and always allowed; requesting on fsOverlay failed silently in
    // some Chrome versions when the element had just been appended. Done
    // before the rest of the setup so the activation token cannot be consumed
    // by anything else in this function first.
    try {
      const target = document.documentElement;
      if (target.requestFullscreen) {
        const p = target.requestFullscreen();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    } catch (_) {}
    fsLyricsShadeTimer = window.setInterval(() => sampleFullscreenLyricsBrightness(), FS_LYRICS_SHADE_SAMPLE_MS);

    // Left: YTM's real <video> when there is one, otherwise the cover art.
    const video = findPlayerVideo();
    if (video) {
      const wasPlaying = !video.paused;
      const resumeAt = video.currentTime;
      fsSavedVideo = {
        node: video,
        parent: video.parentElement,
        next: video.nextSibling,
        cssText: video.style.cssText,
      };
      fsOverlay.classList.add("ym-sl-fs-has-video");

      // Ambient backdrop: Kawarp fed by the LIVE video. This replaces the old
      // low-res blurred/dimmed copy of the video, which cost a full-viewport
      // canvas blur every frame and looked muddier (AJ, 2026-10-19). The 2D
      // canvas is created but left blank; it only starts drawing if Kawarp is
      // unavailable (no WebGL / Dynamic add-on off).
      fsBgCanvas = h("canvas", { class: "ym-sl-fs-bg-canvas" });
      fsBgCtx = fsBgCanvas.getContext("2d", { alpha: false });
      fsOverlay.insertBefore(fsBgCanvas, fsMediaHost);
      fsBgLastDrawAt = 0;
      // findPlayerVideo() returns the <video> itself, not a container — querying
      // a video inside a video returns null, which silently started Kawarp with
      // no source at all (AJ, 2026-10-19).
      const liveVideoEl = video.tagName === "VIDEO" ? video : video.querySelector("video");
      startFullscreenKawarp("", liveVideoEl).then((ok) => {
        if (ok || !fsActive) return;
        requestAnimationFrame(() => {
          drawBgFrame();
          startBgDrawLoop();
        });
      });

      fsMediaHost.appendChild(video);
      // YTM may keep player-bar inline styles on the node after reparenting.
      // Override them directly so the video reliably fills the media pane
      // regardless of what YTM left behind. (Media host positioning itself is
      // handled by the animated CSS rules, not inline.)
      video.style.setProperty("position", "absolute", "important");
      video.style.setProperty("top", "0", "important");
      video.style.setProperty("left", "0", "important");
      video.style.setProperty("right", "0", "important");
      video.style.setProperty("bottom", "0", "important");
      video.style.setProperty("width", "100%", "important");
      video.style.setProperty("height", "100%", "important");
      video.style.setProperty("max-width", "none", "important");
      video.style.setProperty("max-height", "none", "important");
      // Fill the media pane edge-to-edge so the 16:9 video never leaves the
      // two horizontal black bars AJ reported on 2026-09-27. The video is
      // cropped instead of letterboxed - matches what Ableton / Spicy do for
      // their fullscreen MV pane, and the host already has rounded corners
      // so the cropped edges look intentional rather than truncated.
      video.style.setProperty("object-fit", "cover", "important");
      video.style.setProperty("background", "transparent", "important");
      // Reparenting a media element can pause it in some engines; nudge it back.
      if (wasPlaying && video.paused) {
        try {
          video.currentTime = resumeAt;
          video.play().catch(() => {});
        } catch (_) {}
      }
      // Still uploads (Official Audio / Lyric Video) hand the ambient backdrop
      // to Kawarp. Must run after the canvas exists, since Kawarp only takes
      // over by adding a class that hides it.
      applyStaticVideoBackdrop();
    } else {
      const track = getCurrentTrack();
      const artUrl = (track && track.artworkUrl) || getDomArtworkUrl();
      if (artUrl) {
        fsArtImg = h("img", { class: "ym-sl-fs-art", alt: "" });
        fsMediaHost.appendChild(fsArtImg);
        setFsArtSrc(fsArtImg, hiResArt(artUrl));
      }
      // Song fullscreen: replace the blurred cover backdrop with Kawarp when the
      // Dynamic add-on is active (it suspends its page-wide instance for us).
      startFullscreenKawarp(artUrl ? hiResArt(artUrl) : "");
    }

    // Right: the live lyrics panel. Same node, so timing/scroll are preserved.
    fsLyricsHost.appendChild(panelEl);
    panelEl.classList.remove("hidden");
    buildFullscreenControls();
    // Detaching a scrollable element resets its scrollTop to 0, so without this
    // fullscreen always opened on the TOP of the song no matter where the
    // playhead was. The recentre window also rides out the overlay's entrance
    // layout, which is still moving for a few frames after this point.
    recentreActiveLine();

    // Keep the cover-art layers in sync if the track changes mid-fullscreen.
    // The sharp card art (fsArtImg) and the blurred backdrop (fsBgImg) are
    // separate nodes; refreshing only the backdrop left the square cover card
    // showing the previous song's artwork after a skip.
    fsBgRefresh = setInterval(() => {
      if (!fsActive) return;
      // Catch a track swap between MV and no-MV mid-fullscreen so the backdrop
      // switches from cover art to the live video (or back). Without this,
      // fullscreen opened on a no-MV track is stuck on cover art forever.
      syncFsVideoMode();
      // No band re-derive here any more (AJ, 2026-10-20). This tick used to be
      // the only thing that noticed a viewport resize and moved the chrome; the
      // chrome is anchored to the overlay's own bottom now, so it follows a
      // resize by itself.
      // Catch a track change between a live video and a still upload
      // (Official Audio / Lyric Video) while staying in MV mode. Idempotent.
      applyStaticVideoBackdrop();
      const t = getCurrentTrack();
      const u = t && t.artworkUrl;
      const hi = hiResArt(u);
      if (hi) {
        if (fsBgImg && fsBgImg.getAttribute("src") !== hi) fsBgImg.setAttribute("src", hi);
        if (fsKawarpActive) syncFullscreenKawarpArt(hi);
      }
      // Owns creating AND updating the sharp cover card, so a skip that lands
      // before the new artwork URL exists cannot leave the pane empty.
      reconcileFsMediaArt();
    }, 2000);

    // Native fullscreen is requested near the top of enterFullscreenMode(),
    // while the click's user activation is still fresh. The earlier call
    // targets document.documentElement so the activation token and a laid-out
    // element are guaranteed.

    document.addEventListener("keydown", handleFsKeydown, true);
    document.addEventListener("fullscreenchange", handleFsFullscreenChange);
    startFsIdleTracking();
    // Media-element watchers: they detect a skip the moment YTM tears the source
    // down, instead of waiting up to 500ms for the housekeeping pass.
    startFsMediaWatchers();
  }

  function exitFullscreenMode() {
    if (!fsActive) return;
    if (fsVideoModeSwapTimer) { clearTimeout(fsVideoModeSwapTimer); fsVideoModeSwapTimer = 0; }
    // Stop the pending-MV attach poll too, or it would keep calling
    // syncFsVideoMode() after the overlay is gone.
    if (fsVideoWaitTimer) { clearTimeout(fsVideoWaitTimer); fsVideoWaitTimer = 0; }
    // Drop the chrome-heal watchdog too, or it would fire against a removed overlay
    // on the next entry (the timer re-arms itself on the next fade-out anyway).
    if (fsChromeFadeHealTimer) { clearTimeout(fsChromeFadeHealTimer); fsChromeFadeHealTimer = 0; }
    // Same for the minimum-hold deferred restore (FS_CHROME_FADE_MIN_MS).
    if (fsChromeFadeHoldTimer) { clearTimeout(fsChromeFadeHoldTimer); fsChromeFadeHoldTimer = 0; }
    // The .ym-sl-fs-swapping chrome fade that used to need clearing here is gone
    // (AJ, 2026-10-20) — the mode swap no longer fades the controls at all.
    fsActive = false;
    stopFsIdleTracking();
    document.removeEventListener("keydown", handleFsKeydown, true);
    stopFsMediaWatchers();
    document.removeEventListener("fullscreenchange", handleFsFullscreenChange);

    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        const pending = document.exitFullscreen();
        if (pending && typeof pending.catch === "function") pending.catch(() => {});
      }
    } catch (_) {}

    // Restore the video to the exact slot it came from.
    if (fsSavedVideo && fsSavedVideo.node && fsSavedVideo.parent) {
      const { node, parent, next } = fsSavedVideo;
      if (next && next.parentNode === parent) parent.insertBefore(node, next);
      else parent.appendChild(node);
      if (Object.prototype.hasOwnProperty.call(fsSavedVideo, "cssText")) {
        node.style.cssText = fsSavedVideo.cssText;
      }
    }
    // Restore the lyrics panel to the exact slot it came from.
    if (fsSavedPanel && fsSavedPanel.parent && panelEl) {
      const { parent, next } = fsSavedPanel;
      if (next && next.parentNode === parent) parent.insertBefore(panelEl, next);
      else parent.appendChild(panelEl);
    }
    // Same reparenting reset as on the way in: leaving fullscreen would otherwise
    // drop the panel back to the top of the song.
    recentreActiveLine();

    // Put back the tab-driven visibility we overrode on entry. Without this,
    // exiting fullscreen while the active tab is NOT ours (Comments, …) leaves
    // the panel on screen, because `hidden` was removed on entry and never
    // restored. fsActive is already false here, so the DOM classes are the only
    // thing left to reconcile.
    if (fsSavedPanelVisible !== null) {
      const wasVisible = fsSavedPanelVisible;
      fsSavedPanelVisible = null;
      panelVisible = wasVisible;
      if (panelEl) panelEl.classList.toggle("hidden", !wasVisible);
      syncNativePanel(wasVisible);
    }

    if (fsBgRefresh) { clearInterval(fsBgRefresh); fsBgRefresh = null; }
    stopBgDrawLoop();
    if (fsBgCanvas && fsBgCanvas.parentElement) {
      fsBgCanvas.parentElement.removeChild(fsBgCanvas);
    }
    fsBgCanvas = null;
    fsBgCtx = null;
    fsBgLastDrawAt = 0;
    if (fsLyricsShadeTimer) { clearInterval(fsLyricsShadeTimer); fsLyricsShadeTimer = 0; }
    if (fsLyricsShadeReader) { try { fsLyricsShadeReader.cancel(); } catch (_) {} }
    if (fsLyricsShadeTrack) { try { fsLyricsShadeTrack.stop(); } catch (_) {} }
    if (fsLyricsShadeStream) { try { fsLyricsShadeStream.getTracks().forEach((track) => track.stop()); } catch (_) {} }
    fsLyricsShadeReader = null;
    fsLyricsShadeCapture = null;
    fsLyricsShadeTrack = null;
    fsLyricsShadeStream = null;
    fsLyricsShadeCanvas = null;
    fsLyricsShadeCtx = null;
    fsLyricsShadeCanvasTainted = false;
    fsLyricsShadeSampleInFlight = false;
    fsLyricsShade = null;
    fsLyricsShadeLevel = 0;
    fsLyricsShadeTarget = 0;
    fsLyricsShadeLastSampleAt = 0;
    // Hand the backdrop back: dispose our Kawarp, then let the Dynamic add-on
    // resume its page-wide one so exactly one is ever running.
    stopFullscreenKawarp();
    resumePageKawarp();
    fsBgImg = null;
    // Clear the cover-card crossfade handlers and invalidate any in-flight
    // load callback so a slow decode landing after teardown cannot reveal a
    // stale <img> (or attach to a new one created on next entry).
    if (fsArtImg) {
      fsArtImg.onload = null;
      fsArtImg.onerror = null;
    }
    fsArtImg = null;
    ++fsArtImgSeq;
    // Send the animated cover home to the player view instead of destroying it: the
    // engine and its buffer survive, so re-entering fullscreen on the same track is
    // instant too. fsActive is already false here, so placeArtVideo() re-parents it
    // into #song-image and re-hides YTM's own cover. It is VISIBLE there, so resume
    // it — the old off-screen warm host needed a pause, this home does not
    // (AJ, 2026-10-03). Only fall back to a full teardown when there is nothing to
    // keep alive.
    if (fsArtVideo && fsArtVideo.isConnected) {
      placeArtVideo();
      const backPlay = fsArtVideo.play();
      if (backPlay && backPlay.catch) backPlay.catch(() => {});
    } else {
      destroyAnimatedArt();
    }
    const fsOptionsOverlay = document.querySelector(".ym-sl-fs-options-overlay");
    if (fsOptionsOverlay) fsOptionsOverlay.remove();
    if (fsOverlay) fsOverlay.remove();
    fsOverlay = null;
    fsMediaHost = null;
    fsLyricsHost = null;
    fsControls = null;
    fsLayoutSelect = null;
    // Long-title marquee teardown (2026-09-28). Disconnect the resize observer
    // and clear any inline shift/marquee state on the inner so a second
    // fullscreen entry starts from a clean baseline. fsTitleInner is gone
    // with its parent.
    if (fsTitleRO) { fsTitleRO.disconnect(); fsTitleRO = null; }
    fsTitleInner = null;
    // The title node lives inside fsOverlay, which was just removed above.
    fsTitleEl = null;
    fsNextUp = null;
    // Same for the "no lyrics" notice: its node went with the overlay, so this
    // only has to drop the ref and any pending dismiss timer.
    clearFsNoLyricsNotice();
    // Drop any in-flight track-change crossfade so its swap cannot fire after
    // the overlay is gone (the callback also null-checks, this is belt+braces).
    if (fsTitleSwapTimer) { window.clearTimeout(fsTitleSwapTimer); fsTitleSwapTimer = 0; }
    // The loading spinner lives inside fsOverlay too. Drop its pending timer so
    // it cannot fire after the overlay is gone.
    fsSpinnerEl = null;
    if (fsSpinnerTimer) { window.clearTimeout(fsSpinnerTimer); fsSpinnerTimer = 0; }
    // Bright-video controls scrim: the flag drives a class on fsOverlay, which
    // was just removed, so just drop it for the next entry.
    fsBrightVideo = false;
    // Invalidate any pending video-ready reveal (and drop its spinner) so it
    // cannot restore a pane that no longer exists.
    cancelFsVideoReady();
    fsVideoSpinnerEl = null;
    // Drop any pending media dissolve: the pane is going away, so clear the
    // timer and the flag instead of letting a stale fade-in run against a
    // detached host.
    if (fsMediaFadeTimer) { window.clearTimeout(fsMediaFadeTimer); fsMediaFadeTimer = 0; }
    if (fsMediaFadeSafetyTimer) { window.clearTimeout(fsMediaFadeSafetyTimer); fsMediaFadeSafetyTimer = 0; }
    fsMediaFadingOut = false;
    // The sticky mode decision must not survive the session — the next entry has
    // to re-read the track that is playing then.
    fsLastKnownHasVideo = null;
    // Idle fill ring: the node lived in fsOverlay (removed), so drop the ref
    // and any pending show/leave timers.
    if (fsIdleRingShowTimer) { window.clearTimeout(fsIdleRingShowTimer); fsIdleRingShowTimer = 0; }
    if (fsIdleRingLeaveTimer) { window.clearTimeout(fsIdleRingLeaveTimer); fsIdleRingLeaveTimer = 0; }
    fsIdleRing = null;
    fsHavePointer = false;
    // Forget the last backdrop decision so the next entry re-evaluates it
    // instead of early-returning against a stale key.
    fsStaticVideoKey = "";
    fsOffsetRange = null;
    fsOffsetValue = null;
    fsLyricsToggle = null;
    fsLyricsHidden = false;
    fsLyricsGapDimmed = false;
    fsLyricsIntroDimmed = false;
    fsLyricsFinalDimmed = false;
    if (fsPlayerStateTimer) clearInterval(fsPlayerStateTimer);
    fsPlayerStateTimer = 0;
    fsPlayerControls = null;
    fsPlayerPlayButton = null;
    fsPlayerShuffleButton = null;
    fsPlayerRepeatButton = null;
    fsPlayerLikeButton = null;
    fsPlayerDislikeButton = null;
    fsPlayerVolumeRange = null;
    fsPlayerSeekRange = null;
    fsTimeCurrent = null;
    fsTimeTotal = null;
    fsScrubTip = null;
    fsSavedVideo = null;
    fsHoldCoverCard = false;
    fsSavedPanel = null;
  }

  // Escape: let the BROWSER drive it. The old handler called preventDefault()
  // and then exitFullscreenMode() itself, which suppressed Chrome's own
  // "Escape leaves fullscreen" path and did not reliably land either - so Esc
  // appeared to do nothing (AJ, 2026-09-28). With no preventDefault the browser
  // exits fullscreen and the fullscreenchange handler below unwinds our
  // overlay, which is the same path F11 and the browser chrome already use.
  // The explicit exit is kept ONLY for the case where native fullscreen never
  // engaged (requestFullscreen can be refused), where no fullscreenchange fires.
  function handleFsKeydown(event) {
    if (!fsActive || event.key !== "Escape") return;
    if (document.fullscreenElement) return;
    exitFullscreenMode();
  }

  // If the browser leaves native fullscreen by any other route (F11, browser
  // chrome), unwind our overlay too so nothing is left stranded on screen.
  function handleFsFullscreenChange() {
    if (fsActive && !document.fullscreenElement) exitFullscreenMode();
  }

  /* ---- redirect YTM's own video fullscreen button ------------------------
     YTM's video chrome has its own "Enter full screen" button. Clicking it used
     to switch YTM into its page-level fullscreen view (not the Fullscreen API -
     YTM just hides its own UI), which fought our overlay. Redirect that click
     into enterFullscreenMode() so the affordance feels native and there is only
     ever one fullscreen.
     Registered once, in the capture phase on WINDOW so it runs before anything
     YTM bound on the button or on document. `tap` is intercepted as well as
     `click` because YTM's button is a Polymer yt-icon-button, which can be
     driven by Polymer's gesture event rather than a plain click.
     Matched on aria-label rather than a class: the button's only stable hook is
     aria-label="Enter full screen" (its class is the generic
     "style-scope yt-icon-button"), so the test is a loose regex over that label.
     It deliberately does NOT match "Exit full screen" - that label only exists
     while YTM is in its own fullscreen, which this prevents, and hijacking it
     would leave no way out. */
  function installNativeFullscreenRedirect() {
    const redirect = (event) => {
      if (fsActive || !panelEl) return;
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const hit = target.closest("[aria-label]");
      if (!hit) return;
      const label = (hit.getAttribute("aria-label") || "").toLowerCase();
      if (!/enter\s*full\s*screen/.test(label)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      enterFullscreenMode();
    };
    window.addEventListener("click", redirect, true);
    window.addEventListener("tap", redirect, true);
  }

  function syncNativePanel(on) {
    // Only the tab CONTENT node (#tab-renderer) is hidden/shown — the native tab
    // bar is left alone so YTM keeps driving its own selection + underline.
    const host = document.querySelector("#tab-renderer") || panelHost;
    if (!host) return;
    // The class drives CSS that (a) hides EVERY native child — including ones YTM
    // adds LATER, like the "Lyrics not available" message — and (b) removes the
    // host's always-on scrollbar, redundant with the panel's own internal scroll.
    host.classList.toggle("ym-sl-panel-active", on);
    for (const child of Array.from(host.children)) {
      if (child === panelEl) continue;
      child.classList.toggle("ym-sl-native-hidden", on);
    }
  }

  function cleanupTabBar(bar) {
    if (!bar) return;
    if (bar.__ymSelectionObserver) {
      bar.__ymSelectionObserver.disconnect();
      delete bar.__ymSelectionObserver;
    }
    if (lyricsTabObserver) {
      lyricsTabObserver.disconnect();
      lyricsTabObserver = null;
    }
    // The Lyrics tab is YTM's OWN — leave it in the DOM; just drop our marker.
    if (tabEl) tabEl.classList.remove("ym-sl-lyrics-tab");
    tabEl = null;
    tabMountParent = null;
  }

  function scheduleMountTab() {
    if (mountTabTimer) return;
    mountTabTimer = window.setTimeout(() => {
      mountTabTimer = 0;
      mountTab();
    }, 400);
  }

  // YTM disables the native Lyrics tab (disabled + aria-disabled + tabindex -1 +
  // inline pointer-events:none) whenever the track has no lyrics on YTM. Aurora
  // enables it so its own lyrics can live in the REAL tab.
  // PATTERN (from the Better Lyrics extension): observe ONLY the tab, react ONLY to
  // the `disabled` attribute, and NEVER touch `class` from the observer. Observing
  // the whole bar and mutating on every mutation is an infinite feedback loop that
  // freezes the page (that is what broke take 1).
  function enableLyricsTab(tab) {
    if (!tab) return;
    if (lyricsTabObserver) lyricsTabObserver.disconnect();
    tab.classList.add("ym-sl-lyrics-tab");
    tab.removeAttribute("disabled");
    tab.setAttribute("aria-disabled", "false");
    tab.removeAttribute("tabindex");
    try { tab.disabled = false; } catch (_) {}
    if (tab.style && tab.style.pointerEvents) {
      tab.style.removeProperty("pointer-events");
    }
    lyricsTabObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === "disabled") {
          tab.removeAttribute("disabled");
          tab.setAttribute("aria-disabled", "false");
        }
      }
    });
    lyricsTabObserver.observe(tab, { attributes: true });
  }

  // YTM marks the selected tab with aria-selected="true" (Better Lyrics gates on
  // exactly this). This is a READ-ONLY observer: it never mutates, so it cannot loop.
  function lyricsTabSelected() {
    return !!tabEl && tabEl.getAttribute("aria-selected") === "true";
  }

  function mountTab() {
    const bar = findTabBar();
    if (!bar) {
      scheduleMountTab();
      return;
    }
    if (tabBar && tabBar !== bar) cleanupTabBar(tabBar);
    tabBar = bar;
    mountPanel(bar);

    // Use YTM's OWN Lyrics tab instead of a clone: un-disable it, then show
    // Aurora's panel whenever it is the selected tab.
    const tabs = Array.from(bar.querySelectorAll("tp-yt-paper-tab"));
    let lyricsTab = null;
    for (const tab of tabs) {
      if ((tab.textContent || "").trim().toLowerCase().includes("lyrics")) {
        lyricsTab = tab;
        break;
      }
    }
    if (!lyricsTab) {
      scheduleMountTab();
      return;
    }
    tabEl = lyricsTab;
    tabMountParent = tabEl.parentElement;
    enableLyricsTab(tabEl);

    if (!bar.__ymSelectionObserver) {
      bar.__ymSelectionObserver = new MutationObserver(() => {
        if (!tabEl) return;
        const selected = lyricsTabSelected();
        if (selected !== panelVisible) setPanel(selected);
      });
      bar.__ymSelectionObserver.observe(bar, {
        attributes: true,
        subtree: true,
        attributeFilter: ["aria-selected"],
      });
    }
    const selected = lyricsTabSelected();
    if (selected !== panelVisible) setPanel(selected);
  }

  function setPanel(on) {
    // While fullscreen is up, the lyrics panel is owned by the overlay. Ignore
    // tab-driven visibility changes so the lyrics can't be hidden underneath us.
    // Same while the NPV snippet owns the panel.
    if (fsActive || externalHostActive) return;
    panelVisible = on;
    // Hide YTM's own tab content and show Aurora's panel in its place. The native
    // tab bar (and its #selectionBar) are left entirely to YTM.
    syncNativePanel(on);
    if (!panelEl) return;
    panelEl.classList.toggle("hidden", !on);
    if (on) {
      refreshTrack();
      syncTrackLyrics();
    }
  }

  /* ---- external host (NPV dock) ----
     Lets the Now Playing snippet MOVE the already-rendered panel (the very same
     #ym-sl-panel node, same renderer, no second engine) into its own rail and
     back. While docked: the tab-driven visibility state is parked (like
     fullscreen does), the render loop is forced on so the lyrics keep syncing,
     and mountPanel() is blocked from reclaiming the node on YTM re-renders. */
  function setExternalHost(host, reveal) {
    if (!panelEl || fsActive) return false;
    if (host) {
      if (externalHostActive && panelEl.parentElement === host) return true;
      if (!externalHostActive) {
        externalHostSavedVisible = panelVisible;
        externalHostActive = true;
      }
      if (panelEl.parentElement !== host) host.appendChild(panelEl);
      panelEl.classList.remove("hidden");
      panelVisible = true;
      // The panel left #tab-renderer, so its native children can show again.
      syncNativePanel(false);
      refreshTrack();
      syncTrackLyrics();
      return true;
    }
    if (!externalHostActive) return false;
    externalHostActive = false;
    // `reveal` forces the panel visible on return. Needed when the host gives it
    // back BECAUSE the user opened the Lyrics tab: without it the panel restores
    // to its pre-dock state (usually hidden), so the tab falls back to YTM's own
    // lyrics instead of ours (AJ, 2026-10-19).
    panelVisible = reveal === true ? true : externalHostSavedVisible === true;
    externalHostSavedVisible = null;
    // Put the panel back where the tab system expects it (#tab-renderer, or
    // <body> if the watch page — and with it the tab — is gone right now;
    // mountTab() will re-mount it into the tab when the page returns).
    const tabRenderer = document.querySelector("#tab-renderer");
    if (tabRenderer) {
      if (panelEl.parentElement !== tabRenderer) tabRenderer.appendChild(panelEl);
    } else if (!panelEl.parentElement || !panelEl.parentElement.isConnected) {
      document.body.appendChild(panelEl);
    }
    panelEl.classList.toggle("hidden", !panelVisible);
    syncNativePanel(panelVisible);
    if (panelVisible) {
      refreshTrack();
      syncTrackLyrics();
    }
    return true;
  }

  // Expose the dock API for page-world snippets. YTMod is created by
  // public-api.js, which may load after this script — retry briefly.
  function exposeExternalHost() {
    if (!window.YTMod) {
      window.setTimeout(exposeExternalHost, 200);
      return;
    }
    window.YTMod.lyrics = window.YTMod.lyrics || {};
    window.YTMod.lyrics.setExternalHost = setExternalHost;
  }
  exposeExternalHost();

  /**
   * Paint the fullscreen overlay title.
   *
   * Rebuilt rather than patched so the artist/track split is right in every
   * combination: no name, one name, or both. A single textContent write cannot
   * hold the two halves at different weights, so the children are re-created
   * and the separating space is skipped when either half is missing.
   */
  // Track-change crossfade for the overlay title. The old credit fades out,
  // the text swaps, and removing the leaving class re-arms the entrance
  // animation so the new credit fades in. Must match the .24s transition in
  // the .ym-sl-fs-title-leaving rule.
  const FS_TITLE_SWAP_MS = 240;
  let fsTitleSwapTimer = 0;

  /* ---- fullscreen "Next up" list ----------------------------------------
     A native-looking list of the next few queue tracks, bottom-left of the
     overlay. The queue model comes from YTM's own ytmusic-player-queue.data
     (verified in the next-up add-on: an array of playlistPanelVideoRenderer
     entries; the playing row carries `selected`). Logic copied from that add-on. */
  const FS_NEXTUP_COUNT = 4;

  function fsQueueText(node) {
    if (!node) return "";
    if (typeof node.simpleText === "string") return node.simpleText.trim();
    if (Array.isArray(node.runs)) {
      return node.runs.map((r) => (r && r.text) || "").join("").trim();
    }
    return "";
  }

  function fsQueueThumb(renderer) {
    const list = renderer && renderer.thumbnail && renderer.thumbnail.thumbnails;
    if (!Array.isArray(list) || !list.length) return "";
    return list[list.length - 1].url || "";
  }

  function fsNextUpItems() {
    try {
      const host = document.querySelector("ytmusic-player-queue");
      const data = host && host.data;
      if (!Array.isArray(data) || !data.length) return [];
      const list = data.map((e) => e && e.playlistPanelVideoRenderer).filter(Boolean);
      let idx = -1;
      for (let i = 0; i < list.length; i++) {
        if (list[i].selected === true) { idx = i; break; }
      }
      if (idx < 0) return [];
      return list
        .slice(idx + 1, idx + 1 + FS_NEXTUP_COUNT)
        .map((r) => ({
          title: fsQueueText(r.title),
          artist: fsQueueText(r.shortBylineText || r.longBylineText),
          thumb: fsQueueThumb(r),
        }))
        .filter((it) => it.title);
    } catch (_) {
      return [];
    }
  }

  function renderFsNextUp() {
    if (!fsNextUp) return;
    const items = fsNextUpItems();
    if (!items.length) {
      fsNextUp.replaceChildren();
      fsNextUp.classList.remove("ym-sl-fs-nextup-in");
      return;
    }
    const key = items.map((it) => it.title + "|" + it.thumb).join("~");
    if (fsNextUp.__ymKey !== key) {
      fsNextUp.__ymKey = key;
      const rows = [h("div", { class: "ym-sl-fs-nextup-head", text: "Next up" })];
      for (const it of items) {
        const img = h("img", { class: "ym-sl-fs-nextup-thumb" });
        img.alt = "";
        if (it.thumb) img.src = it.thumb;
        const meta = h("div", { class: "ym-sl-fs-nextup-meta" },
          h("div", { class: "ym-sl-fs-nextup-title", text: it.title }));
        if (it.artist) {
          meta.appendChild(h("div", { class: "ym-sl-fs-nextup-artist", text: it.artist }));
        }
        // Display-only row (AJ, 2026-10-03): click-to-jump was abandoned, so
        // this is a plain div - no button affordance, no handler.
        const row = h("div", {
          class: "ym-sl-fs-nextup-row", title: it.title,
          "aria-label": it.artist ? it.title + " - " + it.artist : it.title,
        }, img, meta);
        rows.push(row);
      }
      fsNextUp.replaceChildren(...rows);
    }
    fsNextUp.classList.add("ym-sl-fs-nextup-in");
  }
  function refreshFsTitle() {
    renderFsNextUp();
    if (!fsTitleEl) return;
    const track = getCurrentTrack();
    const artist = (track && track.artist) || "";
    const title = (track && track.title) || "";
    const paint = () => {
      if (!fsTitleEl) return;
      // The text sits in a single nowrap inline-block inner so overflow can
      // be measured against the container and a translateX tween applied to
      // it without affecting the container's own entrance/leave animation.
      const inner = h("div", { class: "ym-sl-fs-title-inner" });
      if (artist) {
        inner.appendChild(h("span", { class: "ym-sl-fs-title-artist", text: artist }));
      }
      if (title) {
        if (artist) inner.appendChild(document.createTextNode(" "));
        inner.appendChild(h("span", { class: "ym-sl-fs-title-track", text: title }));
      }
      fsTitleEl.replaceChildren(inner);
      fsTitleInner = inner;
      // Apply (or remove) the marquee now that the text is in the DOM and
      // measurable. No band re-measure follows: the chip no longer stacks off the
      // title's height (AJ, 2026-10-20).
      updateFsTitleMarquee();
    };
    if (fsTitleSwapTimer) {
      window.clearTimeout(fsTitleSwapTimer);
      fsTitleSwapTimer = 0;
    }
    // Nothing on screen yet (first entry): there is no old credit to fade.
    if (!fsTitleEl.firstChild) {
      paint();
      return;
    }
    fsTitleEl.classList.add("ym-sl-fs-title-leaving");
    fsTitleSwapTimer = window.setTimeout(() => {
      fsTitleSwapTimer = 0;
      if (!fsTitleEl) return;
      paint();
      fsTitleEl.classList.remove("ym-sl-fs-title-leaving");
    }, FS_TITLE_SWAP_MS);
  }

  // Per-render title-marquee updater. Measures the inner's scrollWidth
  // against the container's clientWidth. If the text fits, no class is
  // applied (no animation, no fade). If it overflows, the container gets
  // the edge-fade mask, the inner gets the marquee class with the shift
  // stored in a CSS variable, and the class-toggle off → reflow → on
  // trick restarts the animation from 0 so a track change always begins
  // at the rest position. Shift = -(textWidth - containerWidth) puts
  // the END of the text right at the container's right edge so the
  // right fade takes it out smoothly.
  function updateFsTitleMarquee() {
    if (!fsTitleEl || !fsTitleInner) return;
    const cW = fsTitleEl.clientWidth;
    const tW = fsTitleInner.scrollWidth;
    const overflows = cW > 0 && tW > cW + 1;
    fsTitleEl.classList.toggle("ym-sl-fs-title-overflow", overflows);
    if (!overflows) {
      fsTitleInner.classList.remove("ym-sl-fs-title-marquee");
      fsTitleInner.style.removeProperty("--ym-sl-fs-title-shift");
      return;
    }
    const shift = -(tW - cW);
    fsTitleInner.style.setProperty("--ym-sl-fs-title-shift", shift + "px");
    fsTitleInner.classList.remove("ym-sl-fs-title-marquee");
    void fsTitleInner.offsetWidth;
    fsTitleInner.classList.add("ym-sl-fs-title-marquee");
  }

  // The MV pane is centred on the viewport's vertical middle and sized to the
  // video's aspect ratio, so its BOTTOM edge moves with the video. The title
  // and the playback chrome have to sit under that edge, which CSS cannot
  // derive on its own: the pane's height comes from its WIDTH, and a `top`
  // percentage resolves against the overlay HEIGHT. So publish the pane's
  // bottom edge in px, plus the title's measured height so the chip can stack
  // under it even when the title wraps to two lines.
  // Measured straight off the pane's own rect rather than derived from
  // `overlay.clientWidth * 0.5 / AR`: the arithmetic version silently produced
  // a 358px pane (band top 737) for a 540px pane, which parked the title
  // INSIDE the video (AJ, 2026-09-28). The rect cannot disagree with the
  // layout it is reading.
  // Called on track change, when the aspect ratio changes (deferred a frame so
  // the new aspect-ratio has been laid out), and on the 2s refresh tick -
  // never per frame, because reading a rect forces a layout flush and this
  // runs alongside a 60fps draw loop.
  // Cover-art fullscreen uses the Apple Music stack, which needs the volume on
  // its OWN row under the transport. The volume group ships inside the scrubber,
  // so it is re-parented to .ym-sl-fs-player-controls here (and put back for every
  // other mode / for MVs). Idempotent and cheap: only moves when it is misplaced.
  function stackFsChrome() {
    if (!fsOverlay) return;
    const scrubber = fsOverlay.querySelector(".ym-sl-fs-scrubber");
    const chip = fsOverlay.querySelector(".ym-sl-fs-play-chip");
    const vol = fsOverlay.querySelector(".ym-sl-fs-volume-group");
    if (!scrubber || !chip || !vol) return;
    const stack = !fsOverlay.classList.contains("ym-sl-fs-has-video") &&
      !fsOverlay.classList.contains("ym-sl-fs-mode-background") &&
      !fsOverlay.classList.contains("ym-sl-fs-mode-lyrics-only");
    const column = chip.parentElement;
    const side = !fsOverlay.classList.contains("ym-sl-fs-mode-background") &&
      !fsOverlay.classList.contains("ym-sl-fs-mode-lyrics-only");
    // ⭐ The CREDIT joins the column in BOTH side layouts (AJ, 2026-10-21). One
    // flow — media -> gap -> title -> gap -> transport -> gap -> scrubber — is the
    // only way the gaps stay equal: as a separate absolutely-positioned element
    // the gap under the title depended on the column's CONTENT height, which CSS
    // cannot subtract from a `bottom`.
    if (side) {
      if (fsTitleEl && fsTitleEl.parentElement !== column) {
        column.insertBefore(fsTitleEl, column.firstChild);
      }
    } else if (fsTitleEl && fsTitleEl.parentElement !== fsOverlay) {
      // Back to an overlay child for background / lyrics-only.
      fsOverlay.appendChild(fsTitleEl);
    }
    // The volume only leaves the scrubber for the cover-art column, which wants it
    // on its own row under the transport.
    const coverSide = side && !fsOverlay.classList.contains("ym-sl-fs-has-video");
    if (coverSide) {
      if (vol.parentElement !== column) column.appendChild(vol);
    } else if (vol.parentElement !== scrubber) {
      scrubber.appendChild(vol);
    }
  }

  // STATIC CHROME STRUCTURE (AJ, 2026-10-20).
  // The measured band publisher that used to live here is GONE: it wrote
  // --ym-sl-fs-band-top / -title-h / -art-left / -art-width / -pane-left /
  // -pane-width from the media's live rect, and every write moved the controls.
  // Positions are fixed lengths in 05-styles.jsfrag now. The only thing still
  // needed here is the volume group's HOME, which differs per composition:
  // the cover-art column wants it on its own row, every other layout keeps it
  // on the scrubber. Called on a mode change only - never on a timer, because
  // re-parenting a node is a real DOM move and must not happen mid-track.
  let fsChromeRepinTimers = [];
  function syncFsChromeStructure() {
    stackFsChrome();
    positionFsEdgeButtons();
    // The layout can settle a beat AFTER the classes flip — the pane's aspect
    // ratio only arrives with the video's metadata. The Like/Dislike buttons are
    // pinned from the transport chip's measured offset, so without these retries
    // they can stay where the chip USED to be, which put them on top of the video
    // (measured live: button at y 725-769, video spanning 270-810, AJ 2026-10-21).
    // Two bounded retries, cancelled on every call so they cannot pile up.
    fsChromeRepinTimers.forEach((t) => window.clearTimeout(t));
    fsChromeRepinTimers = [150, 600].map((ms) => window.setTimeout(() => {
      if (fsActive) positionFsEdgeButtons();
    }, ms));
  }

  function refreshTrack() {
    const track = getCurrentTrack();
    const label = track ? track.title + (track.artist ? " — " + track.artist : "") : "Synced Lyrics";
    const trackEl = document.getElementById("ym-sl-track");
    if (trackEl) trackEl.textContent = label;
    refreshFsTitle();
    // Decide the media MODE first, on the track change itself. It used to run
    // only from the 2s fullscreen tick, so a cover <-> music-video skip could
    // take up to two seconds to switch — the delay AJ reported (2026-10-20).
    // syncFsVideoMode() is cheap and self-guarding: it early-returns unless the
    // intent actually differs from what is attached.
    if (fsActive) syncFsVideoMode();
    // Reconcile the fullscreen media on the track change itself instead of
    // waiting up to 2s for the refresh tick. The tick still covers the case
    // where the new artwork URL is not published yet at this instant.
    reconcileFsMediaArt();
    // ...and start buffering the animated cover NOW, while the user is still on
    // the page, so opening fullscreen has no HLS startup left to pay for.
    warmAnimatedArt();
    const exportActions = document.querySelector(".ym-sl-options-overlay .ym-sl-export-actions");
    if (exportActions) exportActions.classList.toggle("hidden", currentTTMLSource !== "imported" || !importedTTMLXml);
  }

  function getCurrentTrack() {
    return window.YTMod && window.YTMod.player && window.YTMod.player.getTrack
      ? window.YTMod.player.getTrack()
      : null;
  }

  function getTrackKey(track) {
    if (!track || !track.title) return "";
    return [track.artist || "", track.title].join("::").toLowerCase();
  }

  const OFFSET_STORAGE_KEY = "better_lyrics_offsets_v2";
  const VIDEO_OFFSET_STORAGE_KEY = "better_lyrics_video_offsets_v1"; // legacy, migrated on load
  const VIDEO_OFFSET_LIMIT = 100;

  // An offset entry is { video: ms, song: ms, pauseSync: {line, offset}|null }.
  // Legacy v1 stored a bare number (the music-video offset); migrate those into the
  // video slot. Entries written before pause sync existed simply have no
  // pauseSync key, so it defaults to null here rather than dropping the entry.
  function normalizeOffsetEntry(value) {
    if (value && typeof value === "object") {
      const entry = {
        video: Number(value.video) || 0,
        song: Number(value.song) || 0,
        pauseSync: null,
      };
      const ps = value.pauseSync;
      if (ps && typeof ps === "object" &&
        Number.isFinite(Number(ps.line)) && Number.isFinite(Number(ps.offset))) {
        entry.pauseSync = { line: Number(ps.line), offset: Number(ps.offset) };
      }
      return entry;
    }
    if (typeof value === "number") return { video: value, song: 0, pauseSync: null };
    return { video: 0, song: 0, pauseSync: null };
  }

  function loadVideoOffsets() {
    try {
      const raw2 = window.localStorage && window.localStorage.getItem(OFFSET_STORAGE_KEY);
      if (raw2) {
        const parsed = JSON.parse(raw2);
        if (parsed && typeof parsed === "object") {
          const out = {};
          for (const k in parsed) out[k] = normalizeOffsetEntry(parsed[k]);
          return out;
        }
      }
      // Migrate legacy v1 flat-number map into the new two-slot shape.
      const raw1 = window.localStorage && window.localStorage.getItem(VIDEO_OFFSET_STORAGE_KEY);
      if (raw1) {
        const parsed = JSON.parse(raw1);
        if (parsed && typeof parsed === "object") {
          const out = {};
          for (const k in parsed) out[k] = normalizeOffsetEntry(parsed[k]);
          return out;
        }
      }
    } catch (_) {}
    return {};
  }

  const videoOffsets = loadVideoOffsets();

  function persistVideoOffsets() {
    try {
      if (window.localStorage) window.localStorage.setItem(OFFSET_STORAGE_KEY, JSON.stringify(videoOffsets));
    } catch (_) {}
  }

  function formatOffset(ms) {
    const sign = ms > 0 ? "+" : "";
    return sign + (ms / 1000).toFixed(1) + "s";
  }

  function hasMusicVideo() {
    return !!findPlayerVideo();
  }

  function getActiveOffsetMs() {
    return activeOffsetMode === "video" ? offsetVideoMs : offsetSongMs;
  }

  /* ---- MV pause re-sync lookups ---------------------------------------------
     getOffsetForLine  — which offset a line uses (click-to-seek).
     getOffsetForPosition — which offset applies right now (the clock, every frame).

     The lookup tests LYRIC time, not video time: if applying the sync offset lands
     us at or past the sync line, we are in the post-pause segment. That is
     equivalent to comparing positionMs against (pauseSync.line + pauseSync.offset)
     — the video moment the sync line actually starts — but it stays monotone even
     when the user dials in a negative offset. */
  function getOffsetForLine(startTimeMs) {
    if (pauseSync && Number.isFinite(startTimeMs) && startTimeMs >= pauseSync.line) {
      return pauseSync.offset;
    }
    return getActiveOffsetMs();
  }

  function getOffsetForPosition(positionMs) {
    if (!pauseSync) return getActiveOffsetMs();
    if (positionMs - pauseSync.offset >= pauseSync.line) return pauseSync.offset;
    return getActiveOffsetMs();
  }

  // Auto-select which slot is applied: a music video uses the video offset, an
  // audio-only track uses the song offset. Throttled so we don't query the DOM
  // every animation frame; force=true re-evaluates immediately (track change).
  function recomputeActiveOffsetMode(force) {
    const now = performance.now();
    if (!force && now - lastOffsetModeCheckAt < 1000) return;
    lastOffsetModeCheckAt = now;
    const desired = hasMusicVideo() ? "video" : "song";
    const changed = desired !== activeOffsetMode;
    activeOffsetMode = desired;
    if (changed) {
      editingOffsetMode = desired;
      refreshVideoOffsetControl();
      lastActiveLine = -1;
      publishSyncState();
    }
  }

  // Updates BOTH the panel offset control and the fullscreen offset control,
  // since either can be on screen. Each control carries the same child classes
  // so a single pass refreshes both. We skip rewriting a field the user is
  // actively typing in to avoid clobbering the caret.
  function refreshVideoOffsetControl() {
    const ms = editingOffsetMode === "video" ? offsetVideoMs : offsetSongMs;
    const seconds = ms / 1000;
    document.querySelectorAll(".ym-sl-video-offset, .ym-sl-fs-control-offset").forEach((root) => {
      const range = root.querySelector("input[type=range]");
      const number = root.querySelector("input.ym-sl-offset-number");
      const value = root.querySelector(".ym-sl-video-offset-value, .ym-sl-fs-control-offset-value");
      const scope = root.querySelector(".ym-sl-offset-scope");
      const applied = root.querySelector(".ym-sl-offset-applied");
      if (range && document.activeElement !== range) range.value = String(ms);
      if (number && document.activeElement !== number) number.value = seconds.toFixed(1);
      if (value) value.textContent = formatOffset(ms);
      if (scope) scope.value = editingOffsetMode;
      if (applied) applied.textContent = activeOffsetMode === "video" ? "video" : "song";
    });
  }

  function setVideoOffsetMs(value, save) {
    const numeric = Number(value);
    const ms = Number.isFinite(numeric)
      // +/- 60s. This clamp is what actually ENFORCES the offset limit — the
      // sliders in 06-panel-ui.jsfrag and 08-fullscreen-controls.jsfrag only
      // advertise it. Keep all three in step.
      ? clamp(Math.round(numeric / 100) * 100, -60000, 60000)
      : 0;
    if (editingOffsetMode === "video") offsetVideoMs = ms;
    else offsetSongMs = ms;
    const key = currentTrackKey || getTrackKey(getCurrentTrack());
    if (save && key) {
      // Preserve the pause sync point: this assignment replaces the whole entry.
      videoOffsets[key] = { video: offsetVideoMs, song: offsetSongMs, pauseSync };
      const keys = Object.keys(videoOffsets);
      while (keys.length > VIDEO_OFFSET_LIMIT) {
        delete videoOffsets[keys.shift()];
      }
      persistVideoOffsets();
    }
    refreshVideoOffsetControl();
    lastActiveLine = -1;
    publishSyncState();
  }

  function loadVideoOffsetForTrack(track) {
    const key = getTrackKey(track);
    const entry = key ? (videoOffsets[key] || {}) : {};
    offsetVideoMs = Number(entry.video) || 0;
    offsetSongMs = Number(entry.song) || 0;
    pauseSync = entry.pauseSync || null;
    recomputeActiveOffsetMode(true);
    editingOffsetMode = activeOffsetMode;
    refreshVideoOffsetControl();
    refreshPauseSyncControl();
    publishSyncState();
  }

  /* ===================== MV pause re-sync ===================== */

  const PAUSE_SYNC_MIN = -5000;
  const PAUSE_SYNC_MAX = 30000;
  const PAUSE_SYNC_STEP = 100;

  function savePauseSync() {
    const key = currentTrackKey || getTrackKey(getCurrentTrack());
    if (!key) return;
    const existing = videoOffsets[key] || { video: offsetVideoMs, song: offsetSongMs };
    existing.video = offsetVideoMs;
    existing.song = offsetSongMs;
    existing.pauseSync = pauseSync;
    videoOffsets[key] = existing;
    const keys = Object.keys(videoOffsets);
    while (keys.length > VIDEO_OFFSET_LIMIT) delete videoOffsets[keys.shift()];
    persistVideoOffsets();
  }

  // The line whose stored startTime matches the sync point, if it is still in the
  // current render tree.
  function findPauseSyncLine() {
    if (!pauseSync) return null;
    for (let index = 0; index < modelLines.length; index++) {
      if (modelLines[index].StartTime === pauseSync.line) return modelLines[index];
    }
    return null;
  }

  function describePauseSyncLine() {
    const line = findPauseSyncLine();
    if (!line) return "a line from a previous lyrics file";
    const words = line.Syllables && line.Syllables.Lead;
    if (!words || !words.length) return "the sync line";
    let text = "";
    for (let index = 0; index < words.length && index < 5; index++) {
      text += words[index].Text || "";
    }
    return '"' + (text.trim() || "the sync line") + '"';
  }

  function markPauseSyncLine() {
    for (let index = 0; index < modelLines.length; index++) {
      const line = modelLines[index];
      const on = !!pauseSync && line.StartTime === pauseSync.line;
      line.HTMLElement.classList.toggle("ym-sl-pause-mark", on);
    }
  }

  function setPauseSyncLine(lineModel) {
    if (!lineModel || !lineModel.isPrimary) return;
    // Start at the offset already in effect, so picking a line never changes
    // playback — the slider then moves from "no visible change" upwards. (Starting
    // at 0 would snap the post-pause lines back to zero offset, which looks like
    // the feature broke something.) Re-picking a line keeps what was dialled in.
    const keep = pauseSync ? pauseSync.offset : getActiveOffsetMs();
    pauseSync = { line: lineModel.StartTime, offset: keep };
    exitPausePickMode();
    savePauseSync();
    refreshPauseSyncControl();
    lastActiveLine = -1;
    publishSyncState();
  }

  function setPauseSyncOffset(ms, save) {
    if (!pauseSync) return;
    const numeric = Number(ms);
    pauseSync.offset = Number.isFinite(numeric)
      ? clamp(Math.round(numeric / PAUSE_SYNC_STEP) * PAUSE_SYNC_STEP, PAUSE_SYNC_MIN, PAUSE_SYNC_MAX)
      : 0;
    if (save) savePauseSync();
    refreshPauseSyncControl();
    // Force the active line to re-resolve against the new offset.
    lastActiveLine = -1;
    publishSyncState();
  }

  function clearPauseSync() {
    pauseSync = null;
    exitPausePickMode();
    savePauseSync();
    refreshPauseSyncControl();
    lastActiveLine = -1;
    publishSyncState();
  }

  function isPlaybackPaused() {
    return !!(window.YTMod && window.YTMod.player &&
      typeof window.YTMod.player.isPaused === "function" && window.YTMod.player.isPaused());
  }

  function enterPausePickMode() {
    if (!isPlaybackPaused()) return;
    pausePickMode = true;
    if (linesRoot && linesRoot.parentElement) {
      linesRoot.parentElement.classList.add("ym-sl-pause-mode");
    }
    if (pauseBanner && pauseBannerText) {
      const pos = window.YTMod && window.YTMod.player ? window.YTMod.player.getPositionMs() : null;
      pauseBannerText.textContent = Number.isFinite(pos)
        ? "Click the line that starts after the pause (paused at " + formatClock(pos) + ")"
        : "Click the line that starts after the pause";
      pauseBanner.classList.remove("hidden");
    }
  }

  function exitPausePickMode() {
    pausePickMode = false;
    if (linesRoot && linesRoot.parentElement) {
      linesRoot.parentElement.classList.remove("ym-sl-pause-mode");
    }
    if (pauseBanner) pauseBanner.classList.add("hidden");
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function refreshPauseSyncControl() {
    const ui = pauseUi;
    if (!ui || !ui.root) return;
    const has = !!pauseSync;
    if (ui.pick) {
      ui.pick.classList.toggle("hidden", has);
      const paused = isPlaybackPaused();
      ui.pick.disabled = !paused;
      ui.pick.title = paused
        ? "Pause the video, then pick the line that plays after the pause"
        : "Pause the video first";
    }
    if (ui.editor) ui.editor.classList.toggle("hidden", !has);
    if (!has) {
      markPauseSyncLine();
      return;
    }
    const ms = pauseSync.offset;
    if (ui.line) ui.line.textContent = "Sync from " + describePauseSyncLine();
    if (ui.range && document.activeElement !== ui.range) ui.range.value = String(ms);
    if (ui.number && document.activeElement !== ui.number) ui.number.value = (ms / 1000).toFixed(1);
    if (ui.value) ui.value.textContent = formatOffset(ms);
    markPauseSyncLine();
  }

  function getPermanentTTML(trackKey) {
    if (!window.YTMod || typeof window.YTMod.getPermanentLyrics !== "function") {
      return Promise.resolve(null);
    }
    return window.YTMod.getPermanentLyrics(trackKey);
  }

  function savePermanentTTML(trackKey, xml) {
    if (!window.YTMod || typeof window.YTMod.setPermanentLyrics !== "function") {
      return Promise.reject(new Error("Permanent lyrics storage is unavailable."));
    }
    return window.YTMod.setPermanentLyrics(trackKey, xml);
  }

  function removePermanentTTML(trackKey) {
    if (!window.YTMod || typeof window.YTMod.removePermanentLyrics !== "function") {
      return Promise.resolve();
    }
    return window.YTMod.removePermanentLyrics(trackKey);
  }

  // (G) Delete the permanently-saved TTML for the current track. Lets the user
  // undo an accidental "Permanent" import (AJ, 2026-09-17).
  async function deletePermanentTTMLForCurrentTrack() {
    const key = currentTrackKey || getTrackKey(getCurrentTrack());
    if (!key) {
      showLyricsMessage("No track loaded, so there is nothing to delete.");
      return;
    }
    try {
      await removePermanentTTML(key);
      manualLyricsIsPermanent = false;
      showLyricsMessage("Permanently-saved TTML removed for this track.");
    } catch (error) {
      console.warn("[SpicyLyrics] Could not delete permanent TTML:", error);
      showLyricsMessage("Could not delete the saved TTML for this track.");
    }
    refreshPermanentDeleteState();
  }

  // Shows the "Delete saved" button only when a permanent TTML actually exists
  // for the current track, so it is obvious there is something to remove.
  async function refreshPermanentDeleteState() {
    const btn = deletePermanentButton;
    if (!btn) return;
    const key = currentTrackKey || getTrackKey(getCurrentTrack());
    if (!key) {
      btn.classList.add("hidden");
      return;
    }
    let saved = null;
    try {
      saved = await getPermanentTTML(key);
    } catch (error) {
      saved = null;
    }
    btn.classList.toggle("hidden", !saved);
  }

  // Shared teardown for "the panel is no longer showing a lyric line". Called by
  // both the empty state and the loading skeleton, and it is the single place
  // that invalidates a skeleton paint still queued on rAF/`setTimeout`.
  function resetLyricsPanelState() {
    lyricsSkeletonToken++;
    lyricsSkeletonShown = false;
    stopScrollGlide();
    lastScrollTargetLine = -1;
    // NOTE: the `offline` class is NOT touched here. It is a layout switch
    // (centred empty-state box vs. the normal top-aligned scroller), so the
    // empty state and the skeleton need opposite values and each sets its own.
    modelLines = [];
    lineElements = [];
    scrollCandidateIndices = [];
    lastActiveLine = -1;
    manualScrollActive = false;
    if (manualScrollReturnTimer) {
      clearTimeout(manualScrollReturnTimer);
      manualScrollReturnTimer = 0;
    }
    setJumpButtonVisible(false);
    // Tell the bus the lyrics are gone so the PiP (and any other subscriber of
    // lyrics:lines) clears too. Without this the PiP retains the previous track's
    // lyrics forever — the panel itself replaced linesRoot with the empty state,
    // but the bus never publishes that fact, so the PiP's lines/videoId stay
    // pinned to the last loaded track. videoId/title/artist are best-effort via
    // getCurrentTrack() so the PiP can detect the track identity has changed.
    if (window.YTMod && window.YTMod.bus) {
      const t = (typeof getCurrentTrack === "function") ? getCurrentTrack() : null;
      window.YTMod.bus.emit("lyrics:lines", {
        trackKey: currentTrackKey || null,
        videoId: t && t.videoId ? t.videoId : null,
        title: t && t.title ? t.title : null,
        artist: t && t.artist ? t.artist : null,
        lines: [],
      });
      try {
        document.documentElement.dataset.ymLyricLines = "0";
      } catch (e) {}
    }
  }

  const NO_LYRICS_MESSAGE = "No lyrics found.";
  const LOAD_FAILED_MESSAGE = "Lyrics didn't load.";
  // Why the last lookup ended in an error, shown in the search panel footer.
  // "no lyrics" is self-explanatory; a failed fetch is almost always rate
  // limiting, so it gets an explicit ERR line instead.
  let lastLyricsError = "";

  function showLyricsMessage(message) {
    // A message means the lookup is OVER, so the fullscreen loading spinner has to
    // come down with it. It used to keep spinning over a "No lyrics found." panel
    // forever, because only the success paths ever called hideFsSpinner()
    // (AJ, 2026-10-01).
    hideFsSpinner();
    lastLyricsError = message === LOAD_FAILED_MESSAGE ? "rate" : "";
    if (searchPanelEl && searchPanelEl._foot) {
      searchPanelEl._foot.textContent = lastLyricsError
        ? "ERR: rate limited — try again in a couple of minutes."
        : "";
    }
    // Fullscreen Video Background keeps the lyrics panel hidden until the first
    // line actually plays (see the intro-dim rules), so a track with NO lyrics
    // produced no feedback at all there — no panel, no message, nothing
    // (AJ, 2026-10-01). BOTH failure messages raise the notice: from the user's
    // side "no lyrics" and "couldn't load them" are the same dead end.
    // Checked BEFORE the panel guard below, because the notice does not depend on
    // the panel existing.
    if (message === NO_LYRICS_MESSAGE || message === LOAD_FAILED_MESSAGE) {
      showFsNoLyricsNotice(message);
    }
    if (!lineScrollEl || !linesRoot) return;
    resetLyricsPanelState();
    // Centred box, the way an empty state should read.
    if (lineScrollEl) lineScrollEl.classList.add("offline");
    const empty = h("div", { class: "ym-sl-empty" });
    empty.appendChild(h("div", { class: "ym-sl-empty-msg", text: message }));
    // Spicy-style body line: tells the user the Search button looks on LRCLIB,
    // which is the actual escape hatch when auto-sync finds nothing.
    empty.appendChild(h("div", {
      class: "ym-sl-empty-body",
      text: "Search LRCLIB to pull in synced lyrics for this track.",
    }));
    // Surface a Search button under the empty-state message — that's the
    // manual-escape hatch when LRCLIB auto-sync couldn't find lyrics.
    const emptySearch = h("button", {
      class: "ym-sl-import ym-sl-empty-search",
      type: "button",
      "aria-label": "Search lyrics",
      text: "Search",
    });
    emptySearch.addEventListener("click", () => toggleSearchPanel());
    empty.appendChild(emptySearch);
    linesRoot.replaceChildren(empty);
  }

  /* ---- fullscreen "no lyrics" notice ----------------------------------------
     Video Background hides the lyrics panel until the first line plays, which is
     a nice touch on a normal track — but it means a track with NO lyrics gives
     no feedback whatsoever. This flashes a transient notice instead, so the user
     is told AND can carry on watching the video (AJ, 2026-10-01).
     Deliberately non-interactive: it must never block or capture the video. */
  const FS_NO_LYRICS_MS = 5000;
  let fsNoLyricsEl = null;
  let fsNoLyricsCountEl = null;
  let fsNoLyricsTimer = 0;

  function showFsNoLyricsNotice(message) {
    if (!fsActive || !fsOverlay) return;
    // The other fullscreen layouts show the panel's own empty state, so the
    // notice is Video Background only — elsewhere it would just be a second copy
    // of the same sentence.
    if (!fsOverlay.classList.contains("ym-sl-fs-mode-background")) return;
    if (!fsNoLyricsEl) {
      // The counter is aria-hidden: with aria-live on the pill, a value changing
      // every second would make a screen reader announce each tick.
      fsNoLyricsCountEl = h("span", {
        class: "ym-sl-fs-notice-count",
        "aria-hidden": "true",
      });
      fsNoLyricsEl = h(
        "div",
        { class: "ym-sl-fs-notice", role: "status", "aria-live": "polite" },
        h("span", { class: "ym-sl-fs-notice-msg" }),
        fsNoLyricsCountEl
      );
      fsOverlay.appendChild(fsNoLyricsEl);
    }
    // The text differs by cause ("No lyrics found." vs the load-failure line), so
    // set it per call rather than baking it in at creation.
    const msgEl = fsNoLyricsEl.firstElementChild;
    if (msgEl && msgEl.textContent !== message) msgEl.textContent = message;
    // Count the seconds down, so the dismissal is never a surprise.
    let remaining = Math.round(FS_NO_LYRICS_MS / 1000);
    if (fsNoLyricsCountEl) fsNoLyricsCountEl.textContent = String(remaining);
    // Restart cleanly on a second skip: a notice still on screen would otherwise
    // never re-animate, because the class never leaves.
    fsNoLyricsEl.classList.remove("show");
    void fsNoLyricsEl.offsetWidth;
    fsNoLyricsEl.classList.add("show");
    if (fsNoLyricsTimer) window.clearInterval(fsNoLyricsTimer);
    fsNoLyricsTimer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        window.clearInterval(fsNoLyricsTimer);
        fsNoLyricsTimer = 0;
        if (fsNoLyricsEl) fsNoLyricsEl.classList.remove("show");
        return;
      }
      if (fsNoLyricsCountEl) fsNoLyricsCountEl.textContent = String(remaining);
    }, 1000);
  }

  // The node lives inside fsOverlay, which is removed wholesale on exit, so this
  // only has to drop the refs and any pending tick.
  function clearFsNoLyricsNotice() {
    if (fsNoLyricsTimer) { window.clearInterval(fsNoLyricsTimer); fsNoLyricsTimer = 0; }
    fsNoLyricsEl = null;
    fsNoLyricsCountEl = null;
  }

  /* ---- loading skeleton -----------------------------------------------------
     A placeholder that looks like lyrics while we wait, instead of the words
     "Looking for lyrics…". Two reasons it is worth more than it looks:

     1. It holds the panel's layout. The empty state is a short centred block, so
        when the real lyrics arrive the panel snaps from "two lines in the middle"
        to "a full screen of lines"; with the skeleton the geometry barely moves.
     2. It covers the blocking DOM build, not just the network. `loadTTML` ->
        `buildRendererLines` creates every line, word and letter span in one
        synchronous task, so the last frame the browser can paint is the one
        BEFORE that task starts. Hence the deferred paint below.

     The widths are a fixed ragged list rather than random per load: with random
     widths the placeholder visibly reshuffles every time, which reads as a
     glitch. Sixteen rows is about one screenful at the default size. */
  const SKELETON_ROW_WIDTHS = [86, 62, 94, 71, 88, 55, 92, 66, 80, 97, 60, 84, 73, 90, 58, 76];

  function showLyricsSkeleton() {
    // Arm the fullscreen spinner first, before any early return, so a load that
    // takes longer than FS_SPINNER_DELAY_MS still gets an affordance. No-op
    // outside fullscreen.
    showFsSpinnerSoon();
    if (!linesRoot) return;
    resetLyricsPanelState();
    // Must be ONLINE: `offline` turns .LyricsContent into a centred flex box,
    // which shrink-wraps its child — and the placeholder rows are empty divs with
    // percentage widths, so they would collapse to zero. Online also means the
    // skeleton picks up the same vertical offset and edge mask as real lyrics.
    if (lineScrollEl) lineScrollEl.classList.remove("offline");
    // Capture AFTER the reset, which is what bumps the token.
    const token = lyricsSkeletonToken;
    const wrap = h("div", {
      class: "ym-sl-skeleton",
      role: "status",
      "aria-live": "polite",
      "aria-label": "Loading lyrics",
    });
    for (let index = 0; index < SKELETON_ROW_WIDTHS.length; index++) {
      const row = h("div", { class: "ym-sl-skeleton-row" });
      row.style.width = `${SKELETON_ROW_WIDTHS[index]}%`;
      wrap.appendChild(row);
    }
    const paint = () => {
      // Superseded by a newer request, or the lyrics already landed.
      if (token !== lyricsSkeletonToken) return;
      if (!linesRoot) return;
      linesRoot.replaceChildren(wrap);
      lyricsSkeletonShown = true;
    };
    if (document.hidden) {
      // requestAnimationFrame never fires in a hidden tab, so deferring here
      // would leave the panel on the previous track's lyrics indefinitely.
      paint();
      return;
    }
    // Double rAF: the first callback runs before the next paint, the second runs
    // after it. One frame is enough to get the element into the DOM, but we need
    // the placeholder actually PAINTED before we hand control back to a caller
    // that is about to block on the DOM build — and that is what the second
    // frame guarantees.
    requestAnimationFrame(() => requestAnimationFrame(paint));
    // Backstop for rAF being throttled (background tab, occluded window,
    // battery saver) rather than never firing. Cheap, and idempotent.
    setTimeout(paint, 100);
  }

  // Backstop only. Every path that replaces the panel's contents — the renderer
  // build, the empty state — already clears the skeleton, because they replace
  // `linesRoot`'s children outright. This exists so a caller that forgets cannot
  // leave a permanent placeholder on screen; it is the token bump that actually
  // cancels a queued paint.
  function hideLyricsSkeleton() {
    // Always clear the fullscreen spinner, including on the early return below:
    // the spinner's own 2s timer may still be pending, and leaving it armed
    // would pop it up after the lyrics have already landed.
    hideFsSpinner();
    if (!lyricsSkeletonShown) {
      lyricsSkeletonToken++;
      return;
    }
    lyricsSkeletonShown = false;
    lyricsSkeletonToken++;
    if (linesRoot && linesRoot.firstElementChild &&
        linesRoot.firstElementChild.classList &&
        linesRoot.firstElementChild.classList.contains("ym-sl-skeleton")) {
      linesRoot.replaceChildren();
    }
  }

  function setJumpButtonVisible(visible) {
    if (jumpButton) {
      if (visible) {
        // The same popup doubles as "Jump to current" (synced) and "Auto scroll"
        // (unsynced) — label it for whichever mode is active (AJ, 2026-09-18).
        if (staticLyricsActive) {
          jumpButton.textContent = "Auto scroll";
          jumpButton.title = "Resume automatic scrolling";
          jumpButton.setAttribute(
            "aria-label",
            "Resume automatic scrolling"
          );
        } else {
          jumpButton.textContent = "Jump to current";
          jumpButton.title = "Jump to the currently playing lyric";
          jumpButton.setAttribute(
            "aria-label",
            "Jump to the currently playing lyric"
          );
        }
      }
      jumpButton.classList.toggle("hidden", !visible);
    }
  }

  function onJumpButtonClick() {
    if (staticLyricsActive) {
      // Resume the smooth auto-scroll that the manual scroll interrupted.
      autoScrollUserPaused = false;
      manualScrollActive = false;
      setJumpButtonVisible(false);
      if (manualScrollReturnTimer) {
        clearTimeout(manualScrollReturnTimer);
        manualScrollReturnTimer = 0;
      }
    } else {
      jumpToCurrentLyric();
    }
  }

  function handleManualScrollIntent() {
    if (!lineScrollEl) return;
    // QOL #1: a manual scroll during the end-of-track reveal dismisses it so the
    // panel does not yank back down to the credits while the user is browsing.
    creditsRevealDismissed = true;
    creditsRevealActive = false;
    // The user has taken the scroll. Kill the spring outright rather than
    // retargeting: a spring still holding a target would keep pulling against
    // their wheel/touch input, which reads as the panel fighting them.
    stopScrollGlide();
    manualScrollActive = true;
    if (staticLyricsActive) {
      // A manual scroll pauses auto-scroll; the "Auto scroll" popup (shown by
      // setJumpButtonVisible below) resumes it when tapped (AJ, 2026-09-18).
      autoScrollUserPaused = true;
    }
    setJumpButtonVisible(true);
    scheduleManualScrollReturn();
  }

  // If the user stops scrolling for FS_JUMP_RETURN_MS, snap back to the line
  // that is currently playing. Re-armed on every scroll/key intent, so the
  // timer measures "idle time", not "time since first scroll".
  function scheduleManualScrollReturn() {
    if (manualScrollReturnTimer) {
      clearTimeout(manualScrollReturnTimer);
      manualScrollReturnTimer = 0;
    }
    manualScrollReturnTimer = window.setTimeout(() => {
      manualScrollReturnTimer = 0;
      if (manualScrollActive && lineScrollEl && lastActiveLine >= 0 && lineElements[lastActiveLine]) {
        jumpToCurrentLyric();
      }
    }, FS_JUMP_RETURN_MS);
  }

  // True when the currently playing line is anywhere on screen. Used to drop the
  // "Jump to current" button the moment the user scrolls back onto the active
  // line, instead of making them click it.
  function isActiveLineInView() {
    if (!lineScrollEl || lastActiveLine < 0 || !lineElements[lastActiveLine]) return false;
    const rect = lineElements[lastActiveLine].getBoundingClientRect();
    const view = lineScrollEl.getBoundingClientRect();
    return rect.bottom >= view.top && rect.top <= view.bottom;
  }

  function handleManualScrollKey(event) {
    if (event.defaultPrevented) return;
    if ([
      "ArrowUp",
      "ArrowDown",
      "PageUp",
      "PageDown",
      "Home",
      "End",
      " ",
    ].includes(event.key)) {
      handleManualScrollIntent();
    }
  }

  function jumpToCurrentLyric() {
    // Reinforce the line the panel is already gliding toward, not necessarily the
    // one being sung: with early scroll on those differ, and targeting the active
    // line here would fight the next frame's retarget back to the lead line.
    const index = lastScrollTargetLine >= 0 ? lastScrollTargetLine : lastActiveLine;
    if (!lineScrollEl || index < 0 || !lineElements[index]) return;
    manualScrollActive = false;
    setJumpButtonVisible(false);
    if (manualScrollReturnTimer) {
      clearTimeout(manualScrollReturnTimer);
      manualScrollReturnTimer = 0;
    }
    scrollActiveLineIntoView(lineElements[index], true);
  }

  /* ---- auto-scroll ---------------------------------------------------------
     One scroll position, THREE ways to reach it — and conflating the last two is
     what made "smooth scrolling off" hard-cut between lines.

       * spring glide (smoothScrolling ON) — a Fraktality `spr` spring, critically
         damped, RETARGETABLE, and it KEEPS ITS VELOCITY across retargets. This is
         upstream 6.3.153's model (see the glide block below).
       * native ease  (smoothScrolling OFF, ordinary line change) — handed to the
         element's own `scroll-behavior: smooth`. "Off" means the user did not ask
         for the glide, not that the panel should teleport. Upstream models it the
         same way: their scroll element carries `scroll-behavior: smooth`, with an
         explicit `behavior: "instant"` reserved for the writes that must not
         animate.
       * hard jump    (`immediate`) — a structural change moved the lyrics out from
         under the camera, so animating to catch up would be a lie about what just
         happened.

     Why a SPRING and not a fixed-duration tween (which is what this used to be): a
     tween restarts from zero velocity every time the target moves, so on a fast
     song — a new line every ~400ms — it never actually arrives and the panel reads
     as stop-start. A spring handed a new target mid-flight just bends the curve
     and carries on. Damping is critical (zeta 1.0), so there is no overshoot: a
     lyric panel that wobbles past its line looks broken, not bouncy. */

  /* The single scrollTop writer. `hard` picks the behaviour, and the difference
     is load-bearing rather than cosmetic:

       hard === true  -> behavior: "instant". This is the ONLY way to override the
         element's own `scroll-behavior: smooth`; passing "auto" does not cancel
         it, it DEFERS to it. Every per-frame writer (the spring, the static-lyrics
         lerp) must use it, or each frame would kick off its own eased animation
         and the two would fight — the spring would crawl and never satisfy its
         settle test.

       hard === false -> behavior: "auto" -> the CSS ease. One-shot only: issued
         when the target CHANGES (once per line), never per frame. */
  /* ---- line-follow glide: a SPRING (upstream 6.3.153's model, AJ 2026-10-07) ---
     Upstream drives its smooth scroll with a Fraktality `spr` spring
     (LyricsVirtualizer._smoothScrollToIndex): critically damped, ~0.8s to settle,
     and — the part that matters — a RETARGET MID-FLIGHT KEEPS THE VELOCITY, so
     back-to-back line changes read as ONE continuous glide instead of restarting.
     We already carry that exact Spring class (see 03-animation-primitives); the
     scroll simply never used it. This replaced a custom 1100ms ease-out-quartic
     tween, which restarted from zero velocity every line and so never settled on
     a fast song. */
  const SCROLL_GLIDE_FREQ = 1;          // Hz    — upstream SMOOTH_SCROLL_FREQUENCY
  const SCROLL_GLIDE_DAMPING = 1;       // ratio — 1 = critically damped, no overshoot
  const SCROLL_GLIDE_SETTLE_PX = 0.25;  // within this of the goal...
  const SCROLL_GLIDE_SETTLE_SPEED = 0.05; // ...and moving slower than this per frame
  const SCROLL_GLIDE_MAX_STEP = 0.05;   // s — longest single spring step
  const SCROLL_GLIDE_MAX_ELAPSED = 0.1; // s — most time one frame may account for
  const SCROLL_GLIDE_MAX_RECONCILES = 3;

  let scrollGlide = null;         // the Spring instance (reused across retargets)
  let scrollGlideGoal = 0;
  let scrollGlideActive = false;
  let scrollGlideLastTs = null;
  let scrollGlideLastPos = null;
  let scrollGlideLastWhole = null;
  let scrollGlideReconciles = 0;
  let scrollGlideFraction = 0;
  // Cached at RETARGET only. Reading scrollHeight per frame is a forced synchronous
  // layout right after a scroll write — the classic thrash that made the glide
  // stutter. The geometry only really changes on a line change (adaptive spacing),
  // and every line change is a retarget, so re-reading here is enough.
  let scrollGlideMaxScroll = 0;

  // The glide is a scroll animation like any other, so a reduced-motion request
  // bypasses it and takes the hard path (the CSS already drops the non-glide path
  // to `scroll-behavior: auto` for those users, so this keeps the two consistent).
  function scrollGlideReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /* The single scrollTop writer. `hard` picks the behaviour, and the difference
     is load-bearing rather than cosmetic:

       hard === true  -> behavior: "instant". This is the ONLY way to override the
         element's own `scroll-behavior: smooth`; passing "auto" does not cancel
         it, it DEFERS to it. Every per-frame writer (the glide, the static-lyrics
         lerp) must use it, or each frame would kick off its own eased animation
         and the two would fight — the glide would crawl and never satisfy its
         settle test.

       hard === false -> behavior: "auto" -> the container's CSS ease. One-shot
         only: issued when the target CHANGES (once per line), never per frame.
         This is the Smooth-Scrolling-OFF path. */
  function writeScrollTop(top, hard) {
    if (!lineScrollEl) return;
    if (typeof lineScrollEl.scrollTo === "function") {
      lineScrollEl.scrollTo({ top: top, behavior: hard ? "instant" : "auto" });
      return;
    }
    lineScrollEl.scrollTop = top;
  }

  // Sub-pixel carry. scrollTop only moves in whole pixels, which at the slow end
  // of the glide shows up as the list ticking one pixel at a time. Write the whole
  // part to scrollTop and carry the remainder as a compositor-only translate — on
  // the SAME transform the lyric offset already uses, so no extra wrapper element
  // is needed (upstream applies it to their virtual container instead).
  function setScrollFraction(fraction) {
    if (!lineScrollEl) return;
    if (Math.abs(fraction - scrollGlideFraction) < 0.01 && fraction !== 0) return;
    scrollGlideFraction = fraction;
    lineScrollEl.style.setProperty("--ym-sl-scroll-frac", fraction === 0 ? "0px" : (-fraction) + "px");
  }

  function stopScrollGlide() {
    scrollGlideActive = false;
    scrollGlide = null;
    scrollGlideLastTs = null;
    scrollGlideLastPos = null;
    scrollGlideLastWhole = null;
    scrollGlideReconciles = 0;
    setScrollFraction(0);
  }

  // Start or retarget the glide. The spring is REUSED so its velocity carries
  // into the new goal — that is the whole point. `replacePosition` restarts from
  // the current spot at rest (used by the reconcile below).
  function startScrollGlide(goal, replacePosition) {
    if (!lineScrollEl) return;
    // Geometry read happens HERE (once per retarget), never per frame.
    scrollGlideMaxScroll = Math.max(0, lineScrollEl.scrollHeight - lineScrollEl.clientHeight);
    const clampedGoal = clamp(goal, 0, scrollGlideMaxScroll);
    const current = scrollGlideActive
      ? lineScrollEl.scrollTop + scrollGlideFraction
      : lineScrollEl.scrollTop;
    if (!scrollGlide) scrollGlide = new Spring(current, SCROLL_GLIDE_FREQ, SCROLL_GLIDE_DAMPING);
    if (replacePosition) scrollGlide.SetGoal(current, true);
    scrollGlideGoal = clampedGoal;
    scrollGlide.SetGoal(clampedGoal);
    scrollGlideReconciles = 0;
    // NOTE: no will-change here on purpose. Promoting the SCROLLER puts every
    // glyph inside it onto a composited layer, and Chromium drops LCD sub-pixel
    // text antialiasing on composited layers — the words render a hair differently
    // and read as shifting left while the glide runs, snapping back the moment the
    // promotion is released (AJ, 2026-10-07). The sub-pixel carry still works
    // without it; the @property registration is what carries the perf.
    scrollGlideActive = true;
  }

  // One frame of the glide. Elapsed is sliced so a low frame rate keeps the
  // wall-clock timing while a real stall cannot jump the list forward.
  function stepScrollGlide() {
    if (!scrollGlideActive || !scrollGlide || !lineScrollEl) return;
    // A user taking over always beats the glide.
    if (manualScrollActive) { stopScrollGlide(); return; }
    const now = performance.now();
    let elapsed = scrollGlideLastTs === null
      ? 1 / 60
      : Math.min((now - scrollGlideLastTs) / 1000, SCROLL_GLIDE_MAX_ELAPSED);
    scrollGlideLastTs = now;
    let stepped = scrollGlide.Step(Math.min(elapsed, SCROLL_GLIDE_MAX_STEP));
    elapsed -= SCROLL_GLIDE_MAX_STEP;
    while (elapsed > 0) {
      stepped = scrollGlide.Step(Math.min(elapsed, SCROLL_GLIDE_MAX_STEP));
      elapsed -= SCROLL_GLIDE_MAX_STEP;
    }
    // Cached at retarget — NO layout read on an ordinary frame (see the state
    // block above; a per-frame scrollHeight read is a forced synchronous layout).
    const position = clamp(stepped, 0, scrollGlideMaxScroll);
    const moved = scrollGlideLastPos === null ? Infinity : Math.abs(position - scrollGlideLastPos);
    scrollGlideLastPos = position;
    const settled =
      Math.abs(position - scrollGlideGoal) < SCROLL_GLIDE_SETTLE_PX &&
      moved < SCROLL_GLIDE_SETTLE_SPEED;
    // Whole part to scrollTop, remainder as the compositor translate.
    const whole = settled ? Math.round(scrollGlideGoal) : Math.round(position);
    const fraction = settled ? 0 : position - whole;
    if (whole !== scrollGlideLastWhole) {
      writeScrollTop(whole, true);
      scrollGlideLastWhole = whole;
    }
    setScrollFraction(fraction);
    if (settled) {
      // Landed off target — layout changed under the glide. Re-aim from where the
      // list actually is, a bounded number of times, then accept it.
      const actual = lineScrollEl.scrollTop;
      if (Math.abs(actual - scrollGlideGoal) > 1 && scrollGlideReconciles < SCROLL_GLIDE_MAX_RECONCILES) {
        scrollGlideReconciles += 1;
        scrollGlideLastWhole = actual;
        scrollGlideLastPos = null;
        startScrollGlide(scrollGlideGoal, true);
        return;
      }
      stopScrollGlide();
    }
  }

  function setScrollTarget(target, immediate) {
    if (!lineScrollEl) return;
    const maxScrollTop = Math.max(0, lineScrollEl.scrollHeight - lineScrollEl.clientHeight);
    const clamped = clamp(target, 0, maxScrollTop);
    if (immediate) {
      // A structural change moved the lyrics out from under the camera: stop any
      // glide and snap, because animating to catch up would be a lie.
      stopScrollGlide();
      writeScrollTop(clamped, true);
      return;
    }
    if ((currentSettings.smoothScrolling || currentSettings.simpleLyrics) && !scrollGlideReducedMotion()) {
      // The SPRING GLIDE (upstream 6.3.153's model). The spring is REUSED, so a
      // line change arriving mid-flight bends the curve and keeps its velocity
      // instead of restarting — that is what makes fast songs read as one glide.
      startScrollGlide(clamped, false);
      return;
    }
    // Smooth Scrolling off: the container's own CSS ease, one-shot.
    stopScrollGlide();
    writeScrollTop(clamped, false);
  }

  /* The old naive-Euler scroll spring lived here (SCROLL_SPRING_STIFFNESS/DAMPING,
     stepScrollSpring, stopScrollSpring). It was DEAD — its target was never set
     from outside — and it is superseded by the glide above, which drives the exact
     `spr` Spring class (frame-rate independent, velocity-carrying) instead of
     hand-integrated Euler steps. Removed 2026-10-07; the four lifecycle sites now
     call stopScrollGlide(). */

  function scrollActiveLineIntoView(element, force) {
    // pausePickMode suspends auto-scroll the same way manual scrolling does, but it
    // must NOT set manualScrollActive: that flag is auto-cleared by animate() as soon
    // as the active line is back in view, which would drop the user out of pick mode
    // the moment they scrolled near the playhead.
    if (!lineScrollEl || !element || ((manualScrollActive || pausePickMode) && !force)) return;
    // The old implementation cancelled its rAF here. The spring has no timer to
    // cancel: retargeting IS the cancellation, and it keeps the velocity.
    const lineRect = element.getBoundingClientRect();
    const viewportRect = lineScrollEl.getBoundingClientRect();
    const lineCenter = lineRect.top + lineRect.height / 2;
    const viewportCenter = viewportRect.top + viewportRect.height / 2;
    // Centre the line. (Upstream's live path nudges the target by -30px for
    // centred lyrics and +85px when scrolling to the top; we always centre.)
    const target = lineScrollEl.scrollTop + lineCenter - viewportCenter;
    // `force` only means "ignore manualScrollActive" — it is NOT a request to skip
    // the animation, so it does not make this immediate.
    //
    // `pendingInstantScroll` is the only thing that does, and it is not about
    // preference: a structural change moved the lyrics out from under the camera
    // (rebuilt lines, reparented panel, resized column). The user did not move the
    // playhead, so animating to catch up is a lie about what just happened — and
    // on a new track it means gliding all the way up from the previous song's
    // final line.
    //
    // Note what is deliberately NOT here any more: `!currentSettings.smoothScrolling`.
    // Treating "smooth scrolling off" as "immediate" is exactly what made every
    // line change hard-cut; setScrollTarget now routes that case to the element's
    // own CSS ease instead.
    const immediate = pendingInstantScroll;
    pendingInstantScroll = false;
    setScrollTarget(target, immediate);
  }

  /* ---- re-centring after a structural change --------------------------------
     Four different events leave the panel showing the WRONG PART OF THE SONG, and
     they all failed the same way: the position was invalidated, and nothing
     re-placed it until the next line change happened to retarget the spring.

       1. New track. The `scrollTop = 0` reset in buildRendererLines is
          static-lyrics-only, so synced lyrics keep the PREVIOUS song's bottom
          position and the spring then glides the entire height of the song.
       2. Entering fullscreen. panelEl is reparented into fsLyricsHost, and
          detaching a scrollable element resets scrollTop to 0 — so the song
          starts at the top no matter where the playhead is.
       3. Switching the fullscreen layout. The lyrics column is CSS-transitioned,
          so the geometry moves around a stale scrollTop.
       4. Leaving fullscreen, for the same reason as (2).

     All four are the same complaint — "the camera doesn't stay on the active
     line" — so they share one mechanism. Instant, because in none of these cases
     did the user move the playhead: the layout moved around it. */
  function recentreActiveLineNow() {
    // Never fight a user who is browsing lyrics by hand. pausePickMode is exempt
    // for the same reason scrollActiveLineIntoView exempts it from force.
    if (manualScrollActive || pausePickMode) return;
    if (!lineScrollEl || staticLyricsActive) return;
    const index = lastActiveLine >= 0 ? lastActiveLine : lastScrollTargetLine;
    if (index < 0 || !lineElements[index]) return;
    pendingInstantScroll = true;
    scrollActiveLineIntoView(lineElements[index], true);
  }

  function recentreActiveLine() {
    recentreUntilMs = performance.now() + RECENTRE_WINDOW_MS;
    // Invalidate the gate so the next frame re-places even if the line index has
    // not changed, then place immediately for the frames where the panel is not
    // animating (hidden tab, no lines yet).
    lastScrollTargetLine = -1;
    recentreActiveLineNow();
  }

  // QOL #1 (2026-09-28): reveal the credits block when a SYNCHRONISED track hits
  // its tail. Returns true while the reveal owns the scroll target this frame, so
  // animate() can skip the normal line-follow retarget and let the credits glide
  // into view (spring if smoothScrolling is on, else the element's CSS ease).
  function updateCreditsReveal(positionMs, activeIndex, lyricPositionMs) {
    // Static lyrics already scroll to the bottom on their own via
    // driveStaticAutoScroll; pause-pick mode owns the scroll too; and we need a
    // credits footer and a live scroll container to do anything at all.
    if (staticLyricsActive || pausePickMode || !creditsFooterEl || !lineScrollEl) {
      if (!creditsFooterEl) creditsRevealActive = false;
      return false;
    }
    // Reveal when the FINAL line has just FINISHED (its EndTime has passed), not
    // when it starts being sung — so the credits glide in right as the last lyric
    // completes. nearEnd is a fallback for the rare case there are credits but no
    // lyric lines (provider-only), where EndTime compares are meaningless.
    const lastLine = modelLines.length ? modelLines[modelLines.length - 1] : null;
    const player = window.YTMod && window.YTMod.player;
    const durationMs = player && typeof player.getDurationMs === "function"
      ? Number(player.getDurationMs())
      : 0;
    // `finalLineEnded` alone is not safe: in the frames around a track change the
    // position can still be the PREVIOUS song's end while modelLines already
    // belongs to the new one, which makes 0 >= anything false but
    // stalePosition >= newLastLine.EndTime true -- and the reveal then drags the
    // freshly recentred panel to the bottom of the new song. Require the position
    // to also be inside the CURRENT song before trusting it (AJ, 2026-10-02).
    const positionWithinSong = durationMs <= 0 || positionMs <= durationMs + 2000;
    const finalLineEnded = !!lastLine && positionWithinSong && lyricPositionMs >= lastLine.EndTime;
    const nearEnd = durationMs > 0 && (durationMs - positionMs) <= CREDITS_REVEAL_MS;
    if (!finalLineEnded && !nearEnd) {
      // Left the end zone (new track, seek back, or ended-and-advanced): release
      // the latches so the reveal can fire again next time the track reaches its
      // tail. The normal line-follow retarget resumes on the next frame.
      creditsRevealEngaged = false;
      creditsRevealDismissed = false;
      creditsRevealActive = false;
      return false;
    }
    if (creditsRevealDismissed) return false; // user took over -> stay out
    creditsRevealEngaged = true;
    creditsRevealActive = true;
    const maxScrollTop = Math.max(0, lineScrollEl.scrollHeight - lineScrollEl.clientHeight);
    setScrollTarget(maxScrollTop, false);
    return true;
  }

  function cancelCreditsReveal() {
    creditsRevealEngaged = false;
    creditsRevealDismissed = false;
    creditsRevealActive = false;
  }

  // Smoothly follow playback with the native scroll position for static
  // (unsynced) lyrics: scrollTop = progress * maxScroll, eased each frame. At
  // song start progress is 0 (top), at the end it is 1 (bottom). A small lerp
  // factor keeps it slow and fluid; if playback is paused the target is fixed so
  // the panel simply settles and holds (AJ, 2026-09-18).
  function driveStaticAutoScroll(positionMs) {
    const player = window.YTMod && window.YTMod.player;
    const durationMs = player && typeof player.getDurationMs === "function"
      ? Number(player.getDurationMs())
      : 0;
    if (!durationMs || durationMs <= 0) return;
    const progress = clamp(positionMs / durationMs, 0, 1);
    const maxScrollTop = Math.max(0, lineScrollEl.scrollHeight - lineScrollEl.clientHeight);
    const target = progress * maxScrollTop;
    const current = lineScrollEl.scrollTop;
    // Per-frame, so it must not animate: an eased write here would restart on
    // every frame and the lerp would never make progress.
    writeScrollTop(current + (target - current) * 0.06, true);
  }

  function parseLrcTimestamp(minutes, seconds) {
    return parseInt(minutes, 10) * 60 + parseFloat(seconds);
  }

  function parseLRC(lrc, durationSeconds) {
    const entries = [];
    const timestampRe = /\[(\d+):(\d{1,2}(?:\.\d+)?)\]/g;

    for (const rawLine of String(lrc || "").replace(/\r/g, "").split("\n")) {
      const timestamps = [];
      let match;
      while ((match = timestampRe.exec(rawLine))) {
        timestamps.push(parseLrcTimestamp(match[1], match[2]));
      }
      timestampRe.lastIndex = 0;
      if (!timestamps.length) continue;

      const text = rawLine.replace(timestampRe, "").trim();
      if (!text) continue;
      for (const start of timestamps) entries.push({ start, text });
    }

    entries.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const entry of entries) {
      const previous = merged[merged.length - 1];
      if (previous && Math.abs(previous.start - entry.start) < 0.001) {
        if (previous.text !== entry.text) previous.text += " " + entry.text;
      } else {
        merged.push({ start: entry.start, text: entry.text });
      }
    }

    return merged.map((entry, index) => {
      const nextStart = merged[index + 1] ? merged[index + 1].start : 0;
      const end = nextStart > entry.start
        ? nextStart
        : (durationSeconds > entry.start ? durationSeconds : entry.start + 4);
      return {
        start: entry.start,
        end: Math.max(entry.start + 0.05, end),
        text: entry.text,
        lineTimed: true,
        words: [{
          text: entry.text,
          start: entry.start,
          end: Math.max(entry.start + 0.05, end),
          isPartOfWord: false,
          disableLetterAnimation: true,
        }],
        background: [],
      };
    });
  }

  // Build a parsed-line model from plain (unsynced) LRCLIB text. Each source
  // line becomes one word with no timing (start = end = 0). The renderer treats
  // these as NoKaraoke static blocks and, because their time window is empty,
  // they resolve to the "Sung" (fully-filled) state at every playback position
  // and the active-line search never matches them, so the panel shows them all
  // at once with no karaoke sweep and no auto-scroll (AJ, 2026-09-18).
  function parsePlain(text) {
    const lines = String(text || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return lines.map((text) => ({
      start: 0,
      end: 0,
      text,
      words: [{ text, start: 0, end: 0, timed: false }],
      background: [],
      lineTimed: false,
      timed: false,
      positioned: false,
    }));
  }

  function applyParsedLyrics(parsed) {
    if (!parsed || !parsed.length) {
      showLyricsMessage(NO_LYRICS_MESSAGE);
      return false;
    }
    const content = toSyllableContent(parsed);
    buildRendererLines(content);
    // Feed the parsed content to the AMLL engine when Simple lyrics (Apple-Music
    // style) mode is active. amllSyncLyrics is a no-op unless the engine is ready,
    // and it falls back to Aurora's own Simple renderer for untimed/plain lyrics.
    amllSyncLyrics(content);
    lastActiveLine = -1;
    cachedFirstRealLyricStartMs = modelLines.reduce((first, line) =>
      line && !line.DotLine ? Math.min(first, line.StartTime) : first,
      Infinity
    );
    cachedLastRealLyricEndMs = modelLines.reduce((last, line) =>
      line && !line.DotLine ? Math.max(last, line.EndTime) : last,
      0
    );
    return true;
  }

  function setTTMLExportVisibility() {
    const exportActions = document.querySelector(".ym-sl-options-overlay .ym-sl-export-actions");
    if (!exportActions) return;
    exportActions.classList.toggle("hidden", currentTTMLSource !== "imported" || !importedTTMLXml);
  }

  function loadTTML(xml, source, provider) {
    const rawXml = String(xml || "");
    let parsed = parseTTML(rawXml);
    // lrc.red ships syllable-level spans; join them into words unless the user
    // turned the toggle off. Word-level files have no syllables to join, so
    // skip them entirely (AJ, 2026-10-20).
    const lrcRedWordTiming = /lrc:timing\s*=\s*["']Word["']/i.test(rawXml);
    if (
      provider === "lrc.red" &&
      !lrcRedWordTiming &&
      currentSettings.joinLrcRedSyllables !== false
    ) {
      parsed = joinTTMLSyllables(parsed);
    }
    if (!parsed.length) {
      staticLyricsActive = false;
      currentLyricsIsTTML = false;
      currentTTMLSource = "none";
      importedTTMLXml = "";
      setTTMLExportVisibility();
      showLyricsMessage("Could not parse that TTML. Try an .ttml export with timed <p> lines.");
      return false;
    }
    currentLyricsIsTTML = true;
    staticLyricsActive = false;
    currentSongwriters = extractSongwriters(rawXml);
    // Consume any credits the caller staged for this load (Spicy Lyrics API
    // results only). Clearing here means imports, cached TTML and Unison never
    // inherit a stale uploader from a previous track.
    if (pendingSpicyCredits) {
      const attr = pendingSpicyCredits.attribution || null;
      currentProvider = (attr && attr.provider) || "";
      currentUploader = (attr && attr.uploader) || null;
      currentMaker = (attr && attr.maker) || null;
      if (!currentSongwriters.length && pendingSpicyCredits.songwriters.length) {
        currentSongwriters = pendingSpicyCredits.songwriters;
      }
      pendingSpicyCredits = null;
    } else if (source === "imported") {
      // A TTML loaded from a local file (not via the Spicy Lyrics API) has no
      // provider and no credited people — the attribution rule governs API
      // responses, not files the user brought. Surface it as a Local Database
      // credit instead of showing nothing — AJ, 2026-09-26. No url, so
      // buildPersonRow renders it as plain text (no dead link).
      currentProvider = "";
      currentMaker = null;
      currentUploader = { id: "local", username: "Local Database", url: "", avatar: "", local: true };
    } else {
      // Unison can return TTML too, but it has no Spicy UploadAttribution
      // object. The caller supplies its provider explicitly so the footer still
      // says where these lyrics came from.
      currentProvider = typeof provider === "string" ? provider : "";
      currentMaker = null;
      currentUploader = null;
    }
    currentTTMLSource = source === "imported" ? "imported" : "external";
    importedTTMLXml = currentTTMLSource === "imported" ? rawXml : "";
    const applied = applyParsedLyrics(parsed);
    setTTMLExportVisibility();
    return applied;
  }

  function loadLRCLyrics(data, durationMs, provider = "LRCLIB") {
    currentLyricsIsTTML = false;
    currentTTMLSource = "none";
    importedTTMLXml = "";
    currentSongwriters = [];
    currentUploader = null;
    currentMaker = null;
    currentProvider = typeof provider === "string" ? provider : "LRCLIB";
    autoScrollUserPaused = false;
    // An LRCLIB result may carry plain lyrics without synced timestamps. Load
    // those as a static, already-filled set instead of reporting "no lyrics".
    // Synced lyrics always win when both are present (AJ, 2026-09-18).
    if (data && data.syncedLyrics) {
      staticLyricsActive = false;
      const parsed = parseLRC(data.syncedLyrics, (durationMs || 0) / 1000);
      const applied = applyParsedLyrics(parsed);
      setTTMLExportVisibility();
      return applied;
    }
    if (data && data.plainLyrics) {
      staticLyricsActive = true;
      const parsed = parsePlain(data.plainLyrics);
      const applied = applyParsedLyrics(parsed);
      setTTMLExportVisibility();
      return applied;
    }
    staticLyricsActive = false;
    showLyricsMessage(NO_LYRICS_MESSAGE);
    setTTMLExportVisibility();
    return false;
  }

  function unwrapUnisonResult(data) {
    if (!data) return null;
    if (data.success && data.data) return data.data;
    return data.lyrics ? data : null;
  }

  function normalizeUnisonLyrics(data) {
    const result = unwrapUnisonResult(data);
    if (!result || typeof result.lyrics !== "string" || !result.lyrics.trim()) return null;
    const format = String(result.format || "").toLowerCase();
    if (format === "lrc") return { format: "lrc", lyrics: result.lyrics };
    if (format === "ttml") return { format: "ttml", lyrics: result.lyrics };
    // Plain lyrics are deliberately not considered a synced hit. The next
    // provider (LRCLIB) gets the chance to return timed lyrics instead.
    if (format === "plain") return null;
    // Be conservative with servers omitting format: accept only timestamped LRC.
    return /\[\d{1,3}:\d{2}(?:\.\d+)?\]/.test(result.lyrics)
      ? { format: "lrc", lyrics: result.lyrics }
      : null;
  }

  async function fetchUnisonLyrics(track, key, controller) {
    if (!window.YTMod || typeof window.YTMod.fetchUnison !== "function") return null;
    const params = new URLSearchParams();
    if (track.videoId) params.set("v", track.videoId);
    else {
      params.set("song", track.title);
      if (track.artist) params.set("artist", track.artist);
      if (track.album) params.set("album", track.album);
      if (Number.isFinite(track.durationMs) && track.durationMs > 0) {
        params.set("duration", String(Math.round(track.durationMs / 1000)));
      }
    }
    const response = await window.YTMod.fetchUnison(`${UNISON_API}?${params.toString()}`);
    if (controller.signal.aborted || key !== currentTrackKey) return null;
    if (!response.ok || !response.data) return null;
    return normalizeUnisonLyrics(response.data);
  }

  function normalizeLookupText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function selectLRCLIBResult(results, track) {
    const candidates = Array.isArray(results)
      ? results.filter((result) => result && result.syncedLyrics)
      : [];
    if (!candidates.length) return null;

    const wantedTitle = normalizeLookupText(track.title);
    const wantedArtist = normalizeLookupText(track.artist);
    const wantedDuration = Number(track.durationMs) / 1000;

    return candidates
      .map((result) => {
        const title = normalizeLookupText(result.trackName);
        const artist = normalizeLookupText(result.artistName);
        let score = 0;
        if (title === wantedTitle) score += 8;
        else if (title.includes(wantedTitle) || wantedTitle.includes(title)) score += 3;
        if (wantedArtist && artist === wantedArtist) score += 6;
        else if (wantedArtist && (artist.includes(wantedArtist) || wantedArtist.includes(artist))) score += 2;
        if (Number.isFinite(wantedDuration) && Number.isFinite(Number(result.duration))) {
          score += Math.max(0, 3 - Math.abs(Number(result.duration) - wantedDuration) / 3);
        }
        return { result, score };
      })
      .sort((a, b) => b.score - a.score)[0].result;
  }

  // Sibling of selectLRCLIBResult for plain (unsynced) entries. Only used as a
  // last-resort auto-fetch fallback when no synced result exists, so unsynced
  // LRCLIB lyrics render automatically instead of reporting "no lyrics"
  // (AJ, 2026-09-18).
  function selectLRCLIBPlainResult(results, track) {
    const candidates = Array.isArray(results)
      ? results.filter((result) => result && result.plainLyrics && !result.syncedLyrics)
      : [];
    if (!candidates.length) return null;

    const wantedTitle = normalizeLookupText(track.title);
    const wantedArtist = normalizeLookupText(track.artist);

    return candidates
      .map((result) => {
        const title = normalizeLookupText(result.trackName);
        const artist = normalizeLookupText(result.artistName);
        let score = 0;
        if (title === wantedTitle) score += 4;
        else if (title.includes(wantedTitle) || wantedTitle.includes(title)) score += 1;
        if (wantedArtist && artist === wantedArtist) score += 3;
        else if (wantedArtist && (artist.includes(wantedArtist) || wantedArtist.includes(artist))) score += 1;
        return { result, score };
      })
      .sort((a, b) => b.score - a.score)[0].result;
  }

  // ---- Spicy Lyrics API integration (publishable key, client-side) ----
  // ---- Spicy Lyrics API cache -----------------------------------------------
  // The /v1/lyrics endpoint is rate-limited, and every play of a song we've
  // already resolved would otherwise re-run the MusicBrainz search (up to ~16
  // sequential HTTP requests) plus the API round-trip.
  //
  // RETENTION — Terms of Service s7. Caching and storage are allowed, and they
  // ask that we do NOT hit the API for every view, on one hard condition:
  // "anything you store must be refetched or discarded within 30 days". That
  // cap is the entire mechanism by which a contributor's withdrawal takes
  // effect (a sync can be pulled at any time, with no removal notice), so it is
  // a CEILING, not a target. We sit at exactly the cap: long enough that a
  // replay almost never re-fetches, and never past the point where a withdrawn
  // sync stops propagating. (Was 3 days — upstream's window — until 2026-10-07.)
  //
  // Storage is chrome.storage.local (bridged through window.YTMod) rather than
  // localStorage: the localStorage lyrics cache is capped at 15 entries and is
  // shared with LRCLIB results, which would evict these far too eagerly.
  const SPICY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — ToS s7 cap.
  // Bump whenever the stored ENTRY SHAPE or the parsing that fills it changes.
  // `sweepSpicyCache` drops anything whose `v` differs, so a bump clears the
  // whole cache on the next page load. v2 added the Line-body parser and the
  // rule that only a 404 may write a negative entry.
  //
  // v3 — the cached value is the TTML STRING that `parseSpicyLyrics` SERIALIZES
  // from the API's JSON, so it is only ever as current as the serializer that
  // wrote it. `parseSpicyLyrics` is new (it does not exist in any backup older
  // than 2026-09-26), so every entry predating it was produced by a different
  // code path and carries a SHAPE WE NO LONGER EMIT — most visibly, one span
  // per LINE instead of one per syllable, which the renderer then fills as a
  // single unit. Symptom: "the lyrics are line by line, not word by word"
  // on a track whose API body is `Type: "Syllable"` with real per-word times.
  // Re-serializing on read would avoid this class entirely; until then, bump.
  //
  // v4 — the cached `attribution` SHAPE changed: it used to be the flattened
  // uploader ({ id, username, avatar, url, songwriters }) and is now
  // { source, provider, uploader, maker, songwriters }. ⚠️ Anything written
  // between the v3 bump and this one is tagged v3 but holds the OLD shape, so
  // it would never be swept AND would render no credit at all. Hence v4, not
  // "v3 is already new enough".
  const SPICY_CACHE_VERSION = 4;
  const SPICY_CACHE_LIMIT = 80;
  // Negative results expire far sooner than positive ones: "this song has no
  // synced lyrics" is far more likely to change (someone uploads it) than an
  // already-uploaded TTML is. Keeps us from re-hitting the resolver for every
  // unsynced track forever, without pinning a miss for the full 30-day window.
  const SPICY_CACHE_NEGATIVE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

  // ---- Spicy Lyrics API cache (in-memory mirror) ----------------------------
  // The persisted object is read once per page load and then served from this
  // map, so a cache hit costs no storage round-trip. Writes go through to
  // storage in the background so the next page load sees them.
  let spicyCache = null;
  let spicyCacheLoad = null;
  let spicyCacheDirty = false;
  let spicyCacheFlushTimer = 0;

  async function loadSpicyCache() {
    if (spicyCache) {
      console.log(`[SpicyLyrics] cache live: ${Object.keys(spicyCache).length} entries.`);
      return Promise.resolve(spicyCache);
    }
    if (spicyCacheLoad) return spicyCacheLoad;
    if (!window.YTMod || typeof window.YTMod.getSpicyCache !== "function") {
      // Without the bridge every lookup is a guaranteed miss and every result
      // is thrown away — a failure mode that looks exactly like a working
      // resolver feeding a broken API call.
      console.warn("[SpicyLyrics] cache bridge unavailable; nothing will be cached this session.");
      spicyCache = {};
      return Promise.resolve(spicyCache);
    }
    spicyCacheLoad = window.YTMod.getSpicyCache().then((stored) => {
      spicyCache = (stored && typeof stored === "object" && !Array.isArray(stored)) ? stored : {};
      console.log(`[SpicyLyrics] cache init: ${Object.keys(spicyCache).length} entries. [${Object.keys(spicyCache).slice(0, 8).join(", ")}]`);
      invalidateStaleSpicyEntries();
      return spicyCache;
    }).catch((error) => {
      console.warn("[SpicyLyrics] cache read failed; starting empty:", error && error.message);
      spicyCache = {};
      return spicyCache;
    });
    return spicyCacheLoad;
  }

  // Writes are coalesced: a burst of cache operations (e.g. the sweep below
  // pruning several entries) collapses into one storage write.
  function flushSpicyCache() {
    if (!spicyCache || !spicyCacheDirty) return;
    spicyCacheDirty = false;
    if (!window.YTMod || typeof window.YTMod.setSpicyCache !== "function") return;
    const snapshot = spicyCache;
    Promise.resolve(window.YTMod.setSpicyCache(snapshot)).catch((error) => {
      console.warn("[SpicyLyrics] could not persist lyrics cache:", error);
    });
  }

  function markSpicyCacheDirty() {
    spicyCacheDirty = true;
    if (spicyCacheFlushTimer) return;
    spicyCacheFlushTimer = setTimeout(() => {
      spicyCacheFlushTimer = 0;
      flushSpicyCache();
    }, 1500);
  }

  // Drops every entry whose `exp` has passed. Called on each read so expired
  // data can never be served, which is what makes the retention window a real
  // guarantee rather than a best-effort one.
  function sweepSpicyCache(now) {
    if (!spicyCache) return false;
    let removed = false;
    for (const [k, entry] of Object.entries(spicyCache)) {
      if (!entry || typeof entry !== "object" || entry.v !== SPICY_CACHE_VERSION || !Number.isFinite(entry.exp) || entry.exp <= now) {
        delete spicyCache[k];
        removed = true;
      }
    }
    return removed;
  }

  // LRU-ish cap: entries carry `at` (write time) so the oldest go first.
  function trimSpicyCache() {
    if (!spicyCache) return false;
    const keys = Object.keys(spicyCache);
    if (keys.length <= SPICY_CACHE_LIMIT) return false;
    keys
      .sort((a, b) => (spicyCache[a].at || 0) - (spicyCache[b].at || 0))
      .slice(0, keys.length - SPICY_CACHE_LIMIT)
      .forEach((k) => { delete spicyCache[k]; });
    return true;
  }

  // Drops every `sp:` entry that does NOT carry a TTML payload.
  //
  // Bumping SPICY_CACHE_VERSION is supposed to invalidate the whole cache when
  // this file's parsing changes — but the cache lives in chrome.storage.local
  // and SURVIVES a code edit, so the two got out of step: a version bump ships
  // the new parser, yet `sp:` entries the old parser wrote keep short-circuiting
  // the API call forever. That is what made a fixed Line-body parser still show
  // "no synced lyrics" for a track it could now render.
  //
  // Negative entries are pure disposable optimisation, so re-deriving them costs
  // one API call at worst. Resolver entries (`r:*`) are NOT touched — they
  // record a stable fact that spending a ListenBrainz round-trip would only
  // re-learn. Runs once per page load, and only when the stored version differs.
  function invalidateStaleSpicyEntries() {
    if (!spicyCache) return 0;
    const keys = Object.keys(spicyCache);
    if (!keys.length) return 0;
    const drops = keys.filter((k) => k.startsWith("sp:") && !(spicyCache[k] && spicyCache[k].ttml));
    if (!drops.length) return 0;
    drops.forEach((k) => { delete spicyCache[k]; });
    markSpicyCacheDirty();
    console.log(`[SpicyLyrics] cache version changed; dropped ${drops.length} re-derivable "sp:" entr${drops.length === 1 ? "y" : "ies"}.`);
    return drops.length;
  }

  // Cache key. A resolved Spotify id is the song's real identity, so prefer it
  // whenever we have one — it survives the title/artist drift that YTM's
  // metadata is prone to. Falls back to the track key for negative entries
  // (where no id was ever resolved).
  function spicyCacheKeyFor(track, spotifyId) {
    if (spotifyId) return `sp:${spotifyId}`;
    const title = track && track.title;
    const artist = track && track.artist;
    if (!title) return null;
    return `t:${String(title).toLowerCase()}|${String(artist || "").toLowerCase()}`;
  }

  async function getSpicyCacheEntry(key) {
    if (!key) return null;
    const cache = await loadSpicyCache();
    const now = Date.now();
    const swept = sweepSpicyCache(now);
    const entry = cache[key];
    if (entry) {
      // Refresh recency for the LRU trim.
      entry.at = now;
      markSpicyCacheDirty();
    }
    if (swept) markSpicyCacheDirty();
    return entry || null;
  }

  function setSpicyCacheEntry(key, value) {
    if (!key || !spicyCache) return;
    const now = Date.now();
    // A "positive" entry carries a usable payload: either TTML to render or a
    // resolved Spotify id to reuse. Anything else is a negative result.
    const negative = !value || (!value.ttml && !value.spotifyId);
    spicyCache[key] = Object.assign({}, value, {
      v: SPICY_CACHE_VERSION,
      at: now,
      exp: now + (negative ? SPICY_CACHE_NEGATIVE_TTL_MS : SPICY_CACHE_TTL_MS),
    });
    trimSpicyCache();
    markSpicyCacheDirty();
  }

  // Number of live (non-expired) entries — used only to report a useful result
  // back to the settings UI when the cache is cleared.
  async function spicyCacheEntryCount() {
    const cache = await loadSpicyCache();
    if (sweepSpicyCache(Date.now())) markSpicyCacheDirty();
    return Object.keys(cache).length;
  }

  // Clears the whole Spicy Lyrics cache (settings "Clear cache" and the
  // storage-permission/consent path both route through here).
  async function clearSpicyLyricsCache() {
    spicyCache = {};
    spicyCacheDirty = false;
    if (spicyCacheFlushTimer) {
      clearTimeout(spicyCacheFlushTimer);
      spicyCacheFlushTimer = 0;
    }
    if (!window.YTMod || typeof window.YTMod.clearSpicyCache !== "function") return;
    try {
      await window.YTMod.clearSpicyCache();
    } catch (error) {
      console.warn("[SpicyLyrics] could not clear lyrics cache:", error);
    }
  }

  // Resolves a Spotify track id from the track's title + artist via
  // ListenBrainz (free, no API key, CORS-enabled, no backend required).
  //
  // WHY LISTENBRAINZ INSTEAD OF MUSICBRAINZ
  // ---------------------------------------
  // MusicBrainz could answer the same question, but only by search-then-walk:
  // search recordings, then fetch each candidate's URL relations until one
  // carries a Spotify link. That was up to ~16 sequential requests per song
  // against a 400-request window, and most of them were spent discovering that
  // a particular pressing has no link. ListenBrainz — the same organisation,
  // MetaBrainz — publishes the recording→Spotify mapping directly, so the whole
  // walk collapses into a single request.
  //
  // Endpoint: /spotify-id-from-metadata
  //   artist_name + track_name + release_name → spotify_track_ids[]
  //
  // GOTCHAS that shaped this implementation (each cost a debugging cycle):
  //   * `release_name` is REQUIRED by the validator, but sending it EMPTY is
  //     treated loosely and returns every mapping it has for that title+artist.
  //     Empty beats guessing, because YTM's album string never matches
  //     MusicBrainz's character-for-character. (A wrong name also degrades to
  //     the loose behaviour rather than failing.)
  //   * ARTIST CREDIT DRIFT is the trap that makes this look broken. MusicBrainz
  //     and Spotify store featured artists in the ARTIST field, while YouTube
  //     Music keeps them in the title's parentheses. So "underscores" returns
  //     NOTHING for a song that "underscores feat. 8485" resolves instantly —
  //     the very song that motivated building this. Hence the variant ladder.
  //
  // We deliberately do NOT try /spotify-id-from-mbid: it needs a MusicBrainz
  // recording id, and obtaining one means going back through MusicBrainz search,
  // which is exactly the round trip we are removing.

  /** Loose normalisation — Unicode-aware, used only for de-duplicating variants. */
  const normLoose = (v) => String(v || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  /** Strip "(Official Video)", "(feat. X)", trailing "- Remastered 2011", etc. */
  const stripParensLoose = (v) => String(v || "")
    .replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*/g, " ")
    .replace(/\s+-\s+[A-Za-z][^-]*$/, "")
    .trim();

  /** Drop a featured credit from an artist string. */
  const dropFeatCredit = (v) => String(v || "")
    .replace(/\s*(?:feat|ft|featuring|with)\b\.?\s*.*$/i, "")
    .replace(/\s*[&,]\s*.*$/, "")
    .trim();

  /** Ordered, de-duplicated variant builder. */
  function variantList(...values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
      const s = String(value || "").trim();
      if (!s) continue;
      const k = normLoose(s);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out;
  }

  /**
   * Artist strings worth trying, most-likely first.
   *
   * The interesting case is a featured credit sitting in the TITLE: YTM gives us
   * "Song (feat. X)" / "Artist", while the mapping is keyed on "Artist feat. X".
   * So we lift the credit out of the parens and graft it onto the artist, in the
   * spellings MusicBrainz editors actually use.
   */
  function listenbrainzArtistVariants(artist, title) {
    const base = dropFeatCredit(artist);
    const feat = /[\(\[\{]\s*(?:feat|ft|featuring|with)\b\.?\s*([^\)\]\}]+)[\)\]\}]/i.exec(String(title || ""));
    const credit = feat && feat[1] ? feat[1].trim() : "";
    return variantList(
      artist,
      base,
      credit && base ? `${base} feat. ${credit}` : "",
      credit && base ? `${base} ft. ${credit}` : "",
      credit && base ? `${base} featuring ${credit}` : "",
      stripParensLoose(artist)
    );
  }

  /* Uploader-styled titles never match a catalogue. The live console showed
     queries like "more than life ft. glaive (Official Music Video) (feat.
     glaive)" and "fijimar & guardin - goodbye, forever [Lyrics / AMV] | biteki
     exclusive" — those miss MusicBrainz, ListenBrainz AND Deezer every time.
     Strip the noise before querying anything (AJ, 2026-10-19). */
  const TITLE_NOISE_RE =
    /\b(official\s*(?:music\s*)?video|official\s*audio|lyric\s*video|lyrics?|audio(?:\s*only)?|visuali[sz]er|music\s*video|hd|hq|mv|amv|explicit|clean)\b/gi;
  // Bracketed text that describes a DIFFERENT RECORDING must survive: dropping
  // "(Remix)" would query the original and fetch the wrong ISRC/timing.
  const TITLE_VERSION_RE =
    /\b(remix|re-?mix|live|acoustic|instrumental|sped\s*up|slowed|reverb|nightcore|demo|edit|version|cover|orchestral)\b/i;

  function cleanSearchTitle(title, artist) {
    let s = String(title || "");
    // "Song | Channel" — everything after the pipe is uploader branding.
    s = s.split("|")[0];
    // Bracketed qualifiers: drop (Official Video) / [Lyrics / AMV], keep
    // (Remix) / (Live) / (Acoustic) because those are different recordings.
    s = s.replace(/[\(\[]\s*([^\)\]]*)[\)\]]/g, (match, inner) =>
      TITLE_VERSION_RE.test(inner) ? match : " "
    );
    s = s.replace(/\{[^}]*\}/g, " ");
    // YTM sometimes truncates a title mid-bracket: "Song (Official ...".
    s = s.replace(/[\(\[]\s*[^\)\]]*$/, " ");
    // Inline feature credits: "Song ft. X" / "Song feat. X".
    s = s.replace(/\s+(?:ft|feat|featuring)\.?\s+.*$/i, " ");
    s = s.replace(TITLE_NOISE_RE, " ");
    s = s.replace(/\s*[-–—]\s*$/, " ");
    // "Artist - Song" -> "Song" when the prefix is the artist we already know.
    const dash = /^(.+?)\s*[-–—]\s*(.+)$/.exec(s);
    if (dash && artist) {
      const left = dash[1].toLowerCase().replace(/\s+/g, " ").trim();
      const known = String(artist).toLowerCase().replace(/\s+/g, " ").trim();
      if (known && (left === known || known.indexOf(left) !== -1 || left.indexOf(known) !== -1)) {
        s = dash[2];
      }
    }
    return s.replace(/\s{2,}/g, " ").trim();
  }

  /** Title strings worth trying: cleaned first, then stripped, then raw. */
  function listenbrainzTitleVariants(title, artist) {
    const cleaned = cleanSearchTitle(title, artist);
    return variantList(cleaned, stripParensLoose(title), title);
  }

  /* YTM's player bar renders a title with the uploader noise already removed —
     the raw videoDetails.title still carries "(Official Music Video)". That
     makes the bar text the best canonical string available without a catalogue
     lookup, and Spicy is the source we most want to hit (AJ, 2026-10-19). */
  function playerBarTitle() {
    const selectors = [
      "ytmusic-player-bar .title",
      "ytmusic-player-bar #song-title",
      "ytmusic-player-bar yt-formatted-string.title",
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = el && el.textContent ? el.textContent.trim() : "";
      if (text) return text;
    }
    return "";
  }

  /**
   * One request against /spotify-id-from-metadata.
   * Returns { ids, transient } — `transient` means the answer is unknowable
   * right now (timeout, 429, 5xx), as opposed to a definitive "no mapping".
   */
  async function listenbrainzLookupMetadata(artist, title, release, controller) {
    const params = new URLSearchParams();
    params.set("artist_name", artist || "");
    params.set("track_name", title || "");
    // Sent even when empty — the endpoint requires the parameter, and an empty
    // value is what triggers its loose matching.
    params.set("release_name", release || "");

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), LB_TIMEOUT_MS);
    const onAbort = () => timeout.abort();
    if (controller && controller.signal) {
      if (controller.signal.aborted) { clearTimeout(timer); return { ids: [], transient: false }; }
      controller.signal.addEventListener("abort", onAbort, { once: true });
    }

    let response;
    try {
      response = await fetch(`${LISTENBRAINZ_LABS_API}/spotify-id-from-metadata/json?${params.toString()}`, {
        credentials: "omit",
        signal: timeout.signal,
      });
    } catch (error) {
      const userAborted = !!(controller && controller.signal && controller.signal.aborted);
      if (!userAborted) console.warn("[SpicyLyrics] ListenBrainz lookup failed:", error && error.message);
      return { ids: [], transient: !userAborted };
    } finally {
      clearTimeout(timer);
      if (controller && controller.signal) controller.signal.removeEventListener("abort", onAbort);
    }

    // 400 = our parameters were rejected. That is our bug, not a flake, so it is
    // a definitive no rather than something worth retrying.
    if (response.status === 400) {
      console.warn("[SpicyLyrics] ListenBrainz rejected the query (HTTP 400).");
      return { ids: [], transient: false };
    }
    if (response.status === 429) {
      lbThrottledUntil = Date.now() + 30_000;
      console.warn("[SpicyLyrics] ListenBrainz rate-limited us; backing off for 30s.");
      return { ids: [], transient: true };
    }
    if (response.status >= 500) return { ids: [], transient: true };
    if (!response.ok) return { ids: [], transient: false };

    const json = await response.json().catch(() => null);
    const first = Array.isArray(json) ? json[0] : (json && json[0]) || null;
    const ids = (first && Array.isArray(first.spotify_track_ids)) ? first.spotify_track_ids : [];
    return { ids: ids.filter((id) => /^[A-Za-z0-9]{22}$/.test(String(id))), transient: false };
  }

  /**
   * Walk the variant ladder until a mapping turns up.
   *
   * Ordered most-likely-and-cheapest first: the stripped title with the raw
   * artist answers for the overwhelming majority of songs in one request, so the
   * feat-credit permutations only run when that fails.
   */
  function spotifyTrackIdFromMusicBrainzUrl(value) {
    const raw = String(value || "");
    const uri = /^spotify:track:([A-Za-z0-9]{22})$/i.exec(raw);
    if (uri) return uri[1];
    const web = /open\.spotify\.com\/(?:intl-[^/]+\/)?track\/([A-Za-z0-9]{22})/i.exec(raw);
    return web ? web[1] : "";
  }

  function musicBrainzSpotifyId(recording) {
    const relations = recording && Array.isArray(recording.relations) ? recording.relations : [];
    for (const relation of relations) {
      const resource = relation && relation.url && relation.url.resource;
      const id = spotifyTrackIdFromMusicBrainzUrl(resource);
      if (id) return id;
    }
    return "";
  }

  function scoreMusicBrainzRecording(recording, track) {
    if (!recording || !track) return -1;
    const wantedTitle = normLoose(track.title);
    const gotTitle = normLoose(recording.title);
    if (!wantedTitle || !gotTitle) return -1;
    let score = gotTitle === wantedTitle ? 8 : 0;
    if (!score && (gotTitle.includes(wantedTitle) || wantedTitle.includes(gotTitle))) score = 4;
    if (!score) return -1;
    const wantedArtist = normLoose(track.artist);
    const artistNames = Array.isArray(recording["artist-credit"])
      ? recording["artist-credit"].map((credit) => normLoose(credit && (credit.name || credit.artist && credit.artist.name)))
      : [];
    if (wantedArtist && artistNames.some((name) => name === wantedArtist)) score += 6;
    else if (wantedArtist && artistNames.some((name) => name && (name.includes(wantedArtist) || wantedArtist.includes(name)))) score += 3;
    const wantedDuration = Number(track.durationMs);
    const gotDuration = Number(recording.length);
    if (Number.isFinite(wantedDuration) && wantedDuration > 0 && Number.isFinite(gotDuration) && gotDuration > 0) {
      const delta = Math.abs(gotDuration - wantedDuration);
      if (delta <= 1500) score += 4;
      else if (delta <= 5000) score += 2;
    }
    return score;
  }

  async function resolveSpotifyIdViaMusicBrainz(track, controller, key) {
    if (!window.YTMod || typeof window.YTMod.fetchMusicBrainzRecordingSearch !== "function") {
      return { id: null, transient: false };
    }
    if (controller.signal.aborted || key !== currentTrackKey) return { id: null, transient: false };
    try {
      const response = await window.YTMod.fetchMusicBrainzRecordingSearch(
        cleanSearchTitle(track.title, track.artist),
        track.artist,
        track.album,
        track.durationMs
      );
      if (controller.signal.aborted || key !== currentTrackKey) return { id: null, transient: false };
      if (!response || response.status === 429 || response.status >= 500) {
        return { id: null, transient: true };
      }
      if (!response.ok || !response.data || !Array.isArray(response.data.recordings)) {
        return { id: null, transient: false };
      }
      const candidates = response.data.recordings
        .map((recording) => ({ recording, score: scoreMusicBrainzRecording(recording, track) }))
        .filter((candidate) => candidate.score > 0 && musicBrainzSpotifyId(candidate.recording))
        .sort((a, b) => b.score - a.score);
      const best = candidates[0];
      if (!best) {
        console.warn(`[SpicyLyrics] MusicBrainz found no Spotify-linked recording for "${track.title}".`);
        return { id: null, transient: false };
      }
      const id = musicBrainzSpotifyId(best.recording);
      console.log(`[SpicyLyrics] resolved Spotify id ${id} via MusicBrainz (${best.score} score).`);
      return { id, transient: false };
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn("[SpicyLyrics] MusicBrainz fallback failed:", error && error.message);
      }
      return { id: null, transient: !controller.signal.aborted };
    }
  }

  async function resolveSpotifyIdUncached(track, controller, key) {
    const title = track && track.title;
    if (!title) {
      console.warn("[SpicyLyrics] no track title; cannot resolve Spotify id.");
      return { id: null, transient: false };
    }

    const artist = (track && track.artist) || "";
    const album = (track && track.album) || "";
    const titles = listenbrainzTitleVariants(title, artist);
    // Prefer the player bar's already-cleaned title when it says something new.
    const barTitle = cleanSearchTitle(playerBarTitle(), artist);
    if (barTitle && !titles.some((variant) => normLoose(variant) === normLoose(barTitle))) {
      titles.unshift(barTitle);
    }
    const artists = listenbrainzArtistVariants(artist, title);
    // Try the album YTM gave us first, then the loose empty form. YTM's album
    // string is often close enough to tighten the match, and when it isn't the
    // endpoint degrades to the loose lookup rather than returning nothing.
    const releases = album ? [album, ""] : [""];

    let attempts = 0;
    let transientFailure = false;
    let sawAnyAnswer = false;

    lbLadder: for (const t of titles) {
      for (const a of artists) {
        for (const r of releases) {
          if (controller.signal.aborted || key !== currentTrackKey) return { id: null, transient: false };
          // A 429 elsewhere means the rest of this window is gone. Bail with
          // `transient` rather than spending the remaining budget on calls that
          // cannot succeed.
          if (lbThrottledUntil > Date.now()) {
            console.warn("[SpicyLyrics] ListenBrainz is in backoff; moving to MusicBrainz fallback.");
            break lbLadder;
          }
          if (attempts >= LB_MAX_ATTEMPTS) {
            // Budget exhausted without a definitive answer, so the caller must
            // not record this as a permanent miss.
            console.warn(`[SpicyLyrics] ListenBrainz attempt budget (${LB_MAX_ATTEMPTS}) exhausted; moving to MusicBrainz fallback.`);
            break lbLadder;
          }
          attempts++;

          const out = await listenbrainzLookupMetadata(a, t, r, controller);
          if (out.transient) transientFailure = true;
          else sawAnyAnswer = true;

          if (out.ids.length) {
            const id = out.ids[0];
            console.log(`[SpicyLyrics] resolved Spotify id ${id} via ListenBrainz "${t}" / "${a}"${r ? ` / "${r}"` : ""} (${attempts} request${attempts === 1 ? "" : "s"}).`);
            return { id, transient: false };
          }
        }
      }
    }

    console.warn(`[SpicyLyrics] ListenBrainz has no Spotify mapping for "${title}" / "${artist || "?"}" (${attempts} request${attempts === 1 ? "" : "s"}); trying MusicBrainz fallback.`);
    // Layer 2: MusicBrainz search + Spotify URL relations. This is deliberately
    // behind ListenBrainz: it is slower and rate-limited, but it covers some
    // recordings whose direct ListenBrainz -> Spotify mapping is missing.
    const musicBrainz = await resolveSpotifyIdViaMusicBrainz(track, controller, key);
    if (musicBrainz.id) return musicBrainz;
    // Every mapping layer failed at the transport level, so we have no evidence
    // that the song is genuinely unresolvable. Do not negative-cache that.
    if ((!sawAnyAnswer && transientFailure) || musicBrainz.transient) {
      console.warn(`[SpicyLyrics] free Spotify-ID mapping layers were unavailable for "${title}"; not caching a miss.`);
      return { id: null, transient: true };
    }
    return { id: null, transient: false };
  }

  /**
   * Cached wrapper around the raw lookup. The resolution result is a stable
   * property of the song, so a hit here skips the network entirely.
   */
  async function resolveSpotifyId(track, controller, key) {
    const cacheKey = spicyCacheKeyFor(track, "");
    let cachedMiss = false;
    if (cacheKey) {
      const cached = await getSpicyCacheEntry(`r:${cacheKey}`);
      if (cached) {
        if (cached.spotifyId) {
          console.log(`[SpicyLyrics] Spotify id ${cached.spotifyId} from cache (resolver).`);
          return cached.spotifyId;
        }
        // A recorded miss — don't re-run the whole search on every play of a
        // song we already know is unresolvable.
        cachedMiss = true;
      }
    }
    if (cachedMiss) {
      console.log("[SpicyLyrics] resolver miss from cache; skipping ListenBrainz lookup.");
      return null;
    }
    const outcome = await resolveSpotifyIdUncached(track, controller, key);
    const resolved = outcome && outcome.id ? outcome.id : null;
    // The lookup can outlive its reason for existing: a manual upload bumps
    // trackRequestSeq, switching tracks rewrites currentTrackKey, clearing the
    // cache swaps spicyCache out, and track changes / unload abort the
    // controller. Any of those means this answer describes a world we've left,
    // so return it to the caller but never persist it.
    const stale =
      controller.signal.aborted ||
      key !== currentTrackKey ||
      !spicyCache;
    if (cacheKey && !stale) {
      if (resolved) {
        // A resolved id is durable — give it the full TTL and mark the entry
        // positive (`hit`) so it isn't treated as a negative result.
        setSpicyCacheEntry(`r:${cacheKey}`, { spotifyId: resolved, hit: true });
      } else if (outcome && outcome.transient) {
        // ListenBrainz was unreachable / rate-limited. That is NOT evidence the
        // song is unresolvable, so don't poison the cache with a miss — the
        // next play gets a clean attempt.
        console.warn("[SpicyLyrics] resolver failed transiently; not caching this as a miss.");
      } else {
        setSpicyCacheEntry(`r:${cacheKey}`, { hit: false });
      }
    }
    return resolved;
  }

  function escapeSpicyText(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Attribution is a BINDING condition of using the API — section 6 of the Terms
  // makes developers.spicylyrics.org/md/attribution part of the terms you accept.
  // The rule is conditional on `source`, so it must never be hardcoded:
  //
  //   * ALWAYS display the provider.
  //   * When source is `spicy_lyrics`, ALSO display and link the UPLOADER and
  //     the MAKER — the people who actually made the sync.
  //   * For every OTHER source (apple_music, spotify, ...) those fields do not
  //     exist. Rendering them anyway is explicitly called out as wrong: it
  //     produces an empty or broken credit line.
  //
  // "Wherever the lyrics appear" — so this goes in the panel footer, not on an
  // about page or in a tooltip nobody opens.
  const SPICY_PROVIDER_LABELS = {
    spicy_lyrics: "Spicy Lyrics",
    apple_music: "Apple Music",
    spotify: "Spotify",
    musixmatch: "Musixmatch",
    lrclib: "LRCLIB",
    genius: "Genius",
    netease: "NetEase",
  };

  // Unknown sources still have to be credited, so fall back to a prettified
  // version of the raw string rather than showing nothing.
  function spicyProviderLabel(source) {
    if (!source) return "";
    if (SPICY_PROVIDER_LABELS[source]) return SPICY_PROVIDER_LABELS[source];
    return source
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // One credited person (an uploader or a maker). The API returns a Discord
  // identity; we only keep the display name, the avatar, and the profile URL.
  function attributionPerson(raw) {
    if (!raw || typeof raw !== "object") return null;
    const username = typeof raw.username === "string" ? raw.username.trim() : "";
    const id = raw.id != null ? String(raw.id) : "";
    if (!username && !id) return null;
    const url = typeof raw.url === "string" && /^https?:\/\//i.test(raw.url)
      ? raw.url
      : (id ? `https://spicylyrics.org/uid/${id}` : "");
    return {
      id,
      username: username || "Unknown",
      avatar: typeof raw.avatar === "string" ? raw.avatar : "",
      url,
    };
  }

  function parseUploadAttribution(body) {
    // No body means there is nothing to credit. Without this the provider
    // fallback below would invent a "Spicy Lyrics" credit for a result that
    // carries no attribution at all.
    if (!body || typeof body !== "object") return null;
    const source = typeof body.source === "string" ? body.source.trim().toLowerCase() : "";
    const attr = body && body.UploadAttribution;
    // Only community syncs carry people. Everything else has a provider and no
    // one else to credit. A response with no `source` at all is treated as a
    // community sync: this function only ever runs on a Spicy API response, so
    // an absent source means an older/partial payload, not an unknown provider.
    const community = !source || source === "spicy_lyrics";
    // Same reasoning: the provider is Spicy Lyrics whenever the source is
    // missing. "Always display the provider" is the binding half of the rule, so
    // it must never come back empty from an API result.
    const provider = spicyProviderLabel(source) || "Spicy Lyrics";
    const uploader = community ? attributionPerson(attr && attr.Uploader) : null;
    const maker = community ? attributionPerson(attr && attr.Maker) : null;
    if (!provider && !uploader && !maker) return null;
    return {
      source,
      provider,
      uploader,
      maker,
      songwriters: Array.isArray(body && body.SongWriters)
        ? body.SongWriters.filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim())
        : [],
    };
  }

  // Converts the Spicy Lyrics API `Body` (times in seconds) into the compact
  // TTML form parseTTML already understands: <p> lines, lead <span begin end>
  // syllables, background <span ttm:role="x-bg">. isPartOfWord is encoded as the
  // absence of whitespace between adjacent spans — parseTTML infers it that way.
  // Returns { ttml, attribution } so the caller can surface the uploader credit.
  //
  // TWO BODY SHAPES, AND BOTH ARE COMMON (verified live 2026-09-20)
  // ---------------------------------------------------------------
  // `Body.Type === "Syllable"` — each Content entry carries
  //   Lead: { StartTime, EndTime, Syllables: [{ Text, StartTime, EndTime,
  //   IsPartOfWord }] } and optional Background: [{ Syllables: [...] }].
  //   This is the word-by-word karaoke case we were built for.
  //
  // `Body.Type === "Line"` — each Content entry carries a PLAIN `Text` string
  //   and a line-level StartTime/EndTime, with **no Syllables array at all**.
  //   underscores' "Music" is served this way: 59 lines, zero syllables.
  //
  // Reading only the syllable shape silently discarded every Line-type body,
  // and because the caller then cached that emptiness as a 12h negative, those
  // songs looked permanently lyric-less. Both shapes are read here now.
  function parseSpicyLyrics(body) {
    if (!body || !Array.isArray(body.Content) || !body.Content.length) return null;
    const fst = (v) => (typeof v === "number" && isFinite(v)) ? v : null;
    const lines = [];
    for (const content of body.Content) {
      if (!content) continue;
      const lead = content.Lead;
      const leadSyls = (lead && Array.isArray(lead.Syllables)) ? lead.Syllables : [];
      const bg = Array.isArray(content.Background) ? content.Background : [];
      const plainText = (typeof content.Text === "string" && content.Text.trim())
        ? content.Text.trim()
        : "";

      // A Line-type entry: no syllable data anywhere, but a real text line with
      // a line-level window. Emit ONE untimed span for the whole line.
      //
      // Do NOT split this into per-word spans. A Line body carries no per-word
      // ground truth, so split words would be *invented* timing dressed up as
      // word sync — and worse, it fights the renderer: a line-synced lyric is
      // supposed to light up as a line. One span keeps the line on the
      // LineTimed path (whole-line fill, letter reveal), while a Syllable body
      // keeps its hand-timed word-by-word karaoke. Two bodies, two behaviours.
      if (!leadSyls.length && !bg.length) {
        if (!plainText) continue;
        const ls = fst(content.StartTime);
        const le = fst(content.EndTime);
        const lineTimed = ls != null && le != null && le > ls + 0.001;
        const agent = content.OppositeAligned ? ` ttm:agent="v2"` : ` ttm:agent="v1"`;
        const lineTiming = lineTimed ? ` begin="${ls}s" end="${le}s"` : "";
        lines.push(`<p${agent}${lineTiming}><span>${escapeSpicyText(plainText)}</span></p>`);
        continue;
      }

      let lineStart = fst(lead && lead.StartTime);
      if (lineStart == null && leadSyls.length) lineStart = fst(leadSyls[0].StartTime);
      let lineEnd = fst(lead && lead.EndTime);
      if (lineEnd == null && leadSyls.length) lineEnd = fst(leadSyls[leadSyls.length - 1].EndTime);
      const lineTimed = lineStart != null && lineEnd != null && lineEnd > lineStart + 0.001;

      const parts = [];
      let prevWord = false;
      for (let i = 0; i < leadSyls.length; i++) {
        const syl = leadSyls[i];
        const text = syl.Text;
        if (text == null || !String(text).length) continue;
        const s = fst(syl.StartTime);
        const e = fst(syl.EndTime);
        const timed = s != null && e != null && e > s + 0.001;
        if (i > 0 && !prevWord) parts.push(" ");
        const timing = timed ? ` begin="${s}s" end="${e}s"` : "";
        parts.push(`<span${timing}>${escapeSpicyText(text)}</span>`);
        prevWord = !!syl.IsPartOfWord;
      }
      let prevBgWord = false;
      const bgInner = [];
      for (const bgItem of bg) {
        if (!bgItem || !Array.isArray(bgItem.Syllables)) continue;
        const bgSyls = bgItem.Syllables;
        for (let i = 0; i < bgSyls.length; i++) {
          const syl = bgSyls[i];
          const text = syl.Text;
          if (text == null || !String(text).length) continue;
          const s = fst(syl.StartTime);
          const e = fst(syl.EndTime);
          const timed = s != null && e != null && e > s + 0.001;
          if (i > 0 && !prevBgWord) bgInner.push(" ");
          const timing = timed ? ` begin="${s}s" end="${e}s"` : "";
          bgInner.push(`<span${timing}>${escapeSpicyText(text)}</span>`);
          prevBgWord = !!syl.IsPartOfWord;
        }
      }
      if (bgInner.length) parts.push(`<span ttm:role="x-bg">${bgInner.join("")}</span>`);
      if (!parts.length) continue;
      const agent = content.OppositeAligned ? ` ttm:agent="v2"` : ` ttm:agent="v1"`;
      const lineTiming = lineTimed ? ` begin="${lineStart}s" end="${lineEnd}s"` : "";
      lines.push(`<p${agent}${lineTiming}>${parts.join("")}</p>`);
    }
    if (!lines.length) return null;
    const ttml = `<?xml version="1.0" encoding="UTF-8"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>${lines.join("")}</div></body></tt>`;
    return { ttml, attribution: parseUploadAttribution(body) };
  }

  async function fetchSpicyLyrics(track, key, controller) {
    if (!SPICY_LYRICS_PUBLISHABLE_KEY) return null;
    if (!track || !track.title) { console.warn("[SpicyLyrics] no track title; skipping."); return null; }
    console.log(`[SpicyLyrics] resolving for "${track.title}" / "${track.artist || "?"}"…`);
    const spotifyId = await resolveSpotifyId(track, controller, key);
    if (controller.signal.aborted || key !== currentTrackKey) return null;
    if (!spotifyId) {
      console.warn("[SpicyLyrics] no Spotify track id resolved; falling back.");
      return null;
    }

    // Cache lookup happens AFTER resolution because the Spotify id is the
    // canonical key — it survives the title/artist drift that would otherwise
    // strand a cached TTML under a key we no longer compute.
    const cacheKey = spicyCacheKeyFor(track, spotifyId);
    const cached = await getSpicyCacheEntry(cacheKey);
    if (cached) {
      if (cached.ttml) {
        console.log(`[SpicyLyrics] served TTML from cache (${spotifyId}).`);
        return { ttml: cached.ttml, attribution: cached.attribution || null, songwriters: cached.songwriters || [], fromCache: true };
      }
      if (cached.hit === false) {
        console.log(`[SpicyLyrics] cached "no sync available" for ${spotifyId}; skipping API.`);
        return null;
      }
      // An entry that is neither TTML nor a recorded miss is a half-written
      // record — exactly what a cache written while the page was being torn
      // down looks like. Log it, because otherwise this path is a silent
      // fall-through to the API and reads as "the cache did nothing".
      console.warn(`[SpicyLyrics] cache entry for ${spotifyId} is incomplete; re-querying the API.`);
    }
    console.log(`[SpicyLyrics] querying ${SPICY_LYRICS_API}/${spotifyId}`);

    // Every exit from here on logs. This function used to have several silent
    // `return null` paths, and because those are indistinguishable in the console
    // from "the request never happened", a resolved id followed by nothing at all
    // sent us chasing the resolver twice. A drop-in replacement for the guard
    // below, used everywhere so no branch can go quiet again.
    const bail = (why) => {
      console.warn(`[SpicyLyrics] giving up on ${spotifyId} — ${why}`);
      return null;
    };

    let response;
    try {
      response = await fetch(`${SPICY_LYRICS_API}/${spotifyId}`, {
        headers: { Authorization: "Bearer " + SPICY_LYRICS_PUBLISHABLE_KEY },
        credentials: "omit",
      });
    } catch (e) {
      console.warn("[SpicyLyrics] request failed:", e);
      return null;
    }
    // Report WHICH condition dropped the answer — aborted vs a changed track are
    // very different bugs and used to be one silent `return null`.
    if (controller.signal.aborted) {
      return bail("request was aborted (a newer track/request superseded it)");
    }
    if (key !== currentTrackKey) {
      return bail(`track key moved (\`${key}\` -> \`${currentTrackKey}\`)`);
    }
    console.log(`[SpicyLyrics] answered HTTP ${response.status} for ${spotifyId}`);
    if (response.status === 404) {
      // The API itself says it has no TTML for this id. That is a real answer
      // and safe to remember.
      setSpicyCacheEntry(cacheKey, { hit: false });
      return bail("API returned 404 (no TTML for this id) — cached as a 12h miss");
    }
    if (!response.ok) {
      return bail(`API returned HTTP ${response.status}`);
    }

    /* ---------------------------------------------------------------------
       Read the body BEFORE touching the cache.

       This ordering is load-bearing. These failure branches used to call
       setSpicyCacheEntry(cacheKey, { hit: false }) on the way out, which meant
       a TENTATIVE failure — an unreadable body, or a TTML string our own parser
       could not render — was banked as a durable 12h negative keyed by
       `sp:<spotifyId>`. The next play then short-circuited on
       `cached.hit === false` and the API was never asked again, so a hiccup or
       a parser gap became a permanent "this song has no synced lyrics" even
       though the API was serving real TTML the whole time.

       A negative entry may now only be written when the API tells us there is
       nothing to fetch (404). Everything else is a miss for THIS attempt and
       gets retried on the next play.
    --------------------------------------------------------------------- */
    const json = await response.json().catch(() => null);
    if (!json) {
      return bail("response body was not valid JSON");
    }
    if (!json.Body) {
      return bail(`answer had no Body (top-level keys: ${Object.keys(json).join(", ") || "none"})`);
    }
    const parsed = parseSpicyLyrics(json.Body);
    if (!parsed) {
      return bail(`Body parse produced nothing (Body.Type=${json.Body.Type}, Content=${Array.isArray(json.Body.Content) ? json.Body.Content.length : "n/a"} ` +
        `with ${Array.isArray(json.Body.Content) ? json.Body.Content.filter((c) => (c && ((c.Lead && Array.isArray(c.Lead.Syllables) && c.Lead.Syllables.length) || (Array.isArray(c.Background) && c.Background.length) || (typeof c.Text === "string" && c.Text.trim())))).length : 0} usable entr(ies))`);
    }
    if (!parsed.ttml) {
      return bail("parser produced no TTML string");
    }
    if (parsed.attribution && parsed.attribution.songwriters.length) {
      parsed.songwriters = parsed.attribution.songwriters;
    }
    // Only now — a Body that parsed into a non-empty TTML — is the result
    // trustworthy enough to persist.
    setSpicyCacheEntry(cacheKey, {
      hit: true,
      ttml: parsed.ttml,
      attribution: parsed.attribution || null,
      songwriters: parsed.songwriters || [],
      spotifyId,
    });
    console.log(`[SpicyLyrics] parsed ${parsed.ttml.length}-byte TTML for ${spotifyId}; handing to the renderer.`);
    return parsed;
  }

  /* ---- lrc.red (AJ, 2026-10-19) -----------------------------------------
     Static file host keyed by ISRC — no search endpoint, no auth, no key:
       https://lrc.red/s/{ISRC}.ttml   word-level Apple-style TTML
       https://lrc.red/s/{ISRC}.lrc    line-level fallback
       https://lrc.red/s/{ISRC}.json   metadata
     CORS is `access-control-allow-origin: *`, so the page can fetch it
     directly. The hard part is the ISRC: YTM exposes it only sometimes, so a
     MusicBrainz recording lookup is the fallback (MB search results already
     carry `isrcs`, no extra `inc` needed).
     Their docs ask for credit when the API is proxied — passing "lrc.red" as
     the provider label satisfies that through the normal credits footer. */
  const LRC_RED_BASE = "https://lrc.red/s/";
  const LRC_RED_ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/;
  const lrcRedCache = new Map(); // isrc -> { ttml?, lrc? }
  const lrcRedIsrcCache = new Map(); // track key -> isrc
  // A dead lrc.red origin (Cloudflare 522) hangs until the network gives up,
  // which made track changes feel frozen. Bound it, and after a failure skip
  // the source entirely for a while instead of paying the timeout per track.
  const LRC_RED_TIMEOUT_MS = 4000;
  const LRC_RED_COOLDOWN_MS = 5 * 60 * 1000;
  let lrcRedCooldownUntil = 0;

  function lrcRedSignal(trackSignal) {
    try {
      if (
        typeof AbortSignal !== "undefined" &&
        typeof AbortSignal.any === "function" &&
        typeof AbortSignal.timeout === "function"
      ) {
        return AbortSignal.any([trackSignal, AbortSignal.timeout(LRC_RED_TIMEOUT_MS)]);
      }
    } catch (_) {}
    return trackSignal;
  }

  function normalizeIsrc(value) {
    const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return LRC_RED_ISRC_RE.test(compact) ? compact : "";
  }

  // Score a Deezer search hit against the track. Title dominates; artist and
  // duration break ties (Deezer lists remixes/live versions separately, and
  // picking the wrong one would fetch the wrong ISRC).
  function deezerIsrcScore(candidate, track) {
    const norm = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const candidateTitle = norm(candidate && candidate.title);
    const trackTitle = norm(track && track.title);
    if (!candidateTitle || !trackTitle) return 0;
    let score = 0;
    if (candidateTitle === trackTitle) score += 60;
    else if (candidateTitle.indexOf(trackTitle) !== -1 || trackTitle.indexOf(candidateTitle) !== -1) score += 30;
    else return 0;
    const candidateArtist = norm(candidate.artist && candidate.artist.name);
    const trackArtist = norm(track && track.artist);
    if (candidateArtist && trackArtist) {
      if (candidateArtist === trackArtist) score += 30;
      else if (candidateArtist.indexOf(trackArtist) !== -1 || trackArtist.indexOf(candidateArtist) !== -1) score += 15;
    }
    const candidateDuration = Number(candidate.duration);
    const trackDuration = Number(track && track.durationMs) / 1000;
    if (candidateDuration > 0 && trackDuration > 0) {
      const delta = Math.abs(candidateDuration - trackDuration);
      if (delta <= 2) score += 25;
      else if (delta <= 5) score += 12;
      else if (delta > 15) score -= 20;
    }
    return score;
  }

  // ISRC for this track. YTM exposes none (verified against /player and /next),
  // so: Deezer first — it carries new releases on release day and returns
  // `isrc` on every hit — then MusicBrainz for older catalogue where Deezer
  // misses (AJ, 2026-10-19).
  async function resolveLrcRedIsrc(track, controller, key) {
    const direct = normalizeIsrc(track && track.isrc);
    if (direct) return direct;
    const memo = lrcRedIsrcCache.get(key);
    if (memo) return memo;
    if (controller.signal.aborted || key !== currentTrackKey) return "";

    if (window.YTMod && typeof window.YTMod.fetchDeezerTracks === "function") {
      try {
        // Cleaned title: Deezer's catalogue uses canonical names, not the
        // uploader's "X (Official Video) [Lyrics]" styling.
        const response = await window.YTMod.fetchDeezerTracks(
          cleanSearchTitle(track.title, track.artist),
          track.artist,
          track.album
        );
        if (controller.signal.aborted || key !== currentTrackKey) return "";
        if (response && response.ok && response.data && Array.isArray(response.data.data)) {
          const best = response.data.data
            .map((candidate) => ({ candidate, score: deezerIsrcScore(candidate, track) }))
            .filter((entry) => entry.score >= 60 && normalizeIsrc(entry.candidate.isrc))
            .sort((a, b) => b.score - a.score)[0];
          if (best) {
            const isrc = normalizeIsrc(best.candidate.isrc);
            lrcRedIsrcCache.set(key, isrc);
            console.log(`[SpicyLyrics] lrc.red: ISRC ${isrc} via Deezer (score ${best.score}).`);
            return isrc;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return "";
        console.warn("[SpicyLyrics] lrc.red: Deezer ISRC lookup failed:", error && error.message);
      }
    }

    if (!window.YTMod || typeof window.YTMod.fetchMusicBrainzRecordingSearch !== "function") return "";
    if (controller.signal.aborted || key !== currentTrackKey) return "";
    try {
      const response = await window.YTMod.fetchMusicBrainzRecordingSearch(
        cleanSearchTitle(track.title, track.artist),
        track.artist,
        track.album,
        track.durationMs
      );
      if (controller.signal.aborted || key !== currentTrackKey) return "";
      if (!response || !response.ok || !response.data || !Array.isArray(response.data.recordings)) return "";
      const best = response.data.recordings
        .map((recording) => ({ recording, score: scoreMusicBrainzRecording(recording, track) }))
        .filter((candidate) =>
          candidate.score > 0 &&
          Array.isArray(candidate.recording.isrcs) &&
          candidate.recording.isrcs.length
        )
        .sort((a, b) => b.score - a.score)[0];
      const isrc = best ? normalizeIsrc(best.recording.isrcs[0]) : "";
      if (!isrc) {
        console.warn(`[SpicyLyrics] lrc.red: no ISRC for "${track.title}" from Deezer or MusicBrainz.`);
        return "";
      }
      lrcRedIsrcCache.set(key, isrc);
      console.log(`[SpicyLyrics] lrc.red: ISRC ${isrc} via MusicBrainz (score ${best.score}).`);
      return isrc;
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn("[SpicyLyrics] lrc.red: MusicBrainz ISRC lookup failed:", error && error.message);
      }
      return "";
    }
  }

  async function fetchLrcRedLyrics(track, controller, key) {
    const isrc = await resolveLrcRedIsrc(track, controller, key);
    if (!isrc) return null;
    const cached = lrcRedCache.get(isrc);
    if (cached) return cached;
    if (controller.signal.aborted || key !== currentTrackKey) return null;
    // Origin known to be unreachable right now — skip without paying the
    // timeout again on this track (AJ, 2026-10-19).
    if (Date.now() < lrcRedCooldownUntil) return null;
    const result = {};
    let unreachable = false;
    // TTML first (word-level); LRC only if the TTML entry does not exist.
    for (const ext of ["ttml", "lrc"]) {
      try {
        const response = await fetch(`${LRC_RED_BASE}${isrc}.${ext}`, {
          headers: { Accept: ext === "ttml" ? "application/ttml+xml" : "text/plain" },
          credentials: "omit",
          signal: lrcRedSignal(controller.signal),
        });
        if (!response.ok) continue; // 404 -> try the next format
        const text = await response.text();
        if (!text || text.length < 40) continue;
        // A 200 with an HTML body is Cloudflare's interstitial, not lyrics.
        if (ext === "ttml" && text.indexOf("<tt") === -1) continue;
        result[ext] = text;
        break;
      } catch (error) {
        if (controller.signal.aborted) return null;
        // A THROW here is not an HTTP status: it is CORS / DNS / a Cloudflare
        // 522 page (which carries no Access-Control-Allow-Origin, so the
        // browser reports it as a CORS failure), or our own timeout. The second
        // extension would fail the same way, so stop instead of waiting twice.
        unreachable = true;
        break;
      }
    }
    if (unreachable) {
      lrcRedCooldownUntil = Date.now() + LRC_RED_COOLDOWN_MS;
      console.warn(
        `[SpicyLyrics] lrc.red is unreachable (CORS/522/timeout) — skipping it for ` +
        `${Math.round(LRC_RED_COOLDOWN_MS / 60000)} min so playback is not delayed.`
      );
      return null;
    }
    if (!result.ttml && !result.lrc) {
      console.log(`[SpicyLyrics] lrc.red: no lyrics for ISRC ${isrc}.`);
      return null;
    }
    lrcRedCache.set(isrc, result);
    console.log(`[SpicyLyrics] lrc.red: fetched ${result.ttml ? "TTML" : "LRC"} for ${isrc}.`);
    return result;
  }

  // Does this TTML carry real per-WORD timing (Apple/Spicy <span ttm:role="x-word">
  // structure, or lrc.red's Word mode)? Line-only TTML (lrc:timing="Line", plain <p>
  // text) has NO word timing — rendering it through the karaoke path makes every
  // line light at once, so it is shown as static auto-scroll instead (AJ, 2026-10-19).
  function ttmlHasWordTiming(xml) {
    const s = String(xml || "");
    if (/lrc:timing\s*=\s*["']Word["']/i.test(s)) return true;
    if (/<span\b[^>]*\bttm:role\s*=\s*["']x-word["']/i.test(s)) return true;
    return /<span\b/i.test(s) && /\bbegin\s*=/.test(s);
  }
  // Flattens a line-level TTML to plain text (one <p> -> one line) for the static path.
  function ttmlPlainText(xml) {
    const s = String(xml || "");
    const lines = [];
    const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = re.exec(s))) {
      const text = decodeEntities(m[1].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
    }
    return lines.join("\n");
  }
  // A synced LRC line is prefixed with a [mm:ss(.xx)] timestamp; plain lyrics are not.
  function isSyncedLRC(text) {
    return /\[\s*\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\s*\]/.test(String(text || ""));
  }

  async function fetchLRCLyrics(track, key) {
    const requestId = ++trackRequestSeq;
    if (activeTrackAbort) activeTrackAbort.abort();
    const controller = new AbortController();
    activeTrackAbort = controller;

    // Skeleton rather than a text message: this covers the network wait AND the
    // synchronous DOM build that follows it (see showLyricsSkeleton).
    showLyricsSkeleton();

    const stale = () =>
      controller.signal.aborted || requestId !== trackRequestSeq || key !== currentTrackKey;

    /* One LRCLIB fetch, shared by the lrclib runner and by the lrc.red STATIC
       fallback. The fallback needs the raw result (not a load) so it can decide
       whether LRCLIB actually has a SYNCED set; if it only has plain lyrics we
       keep lrc.red's static set instead of swapping one static for another. */
    const fetchLrclibData = async () => {
      const cached = lrclibCache.get(key);
      if (cached) {
        lrclibCache.delete(key);
        lrclibCache.set(key, cached);
        return cached;
      }
      const persisted = getLyricsPersistent(key);
      if (persisted) {
        lrclibCache.set(key, persisted);
        return persisted;
      }
      if (!window.YTMod || typeof window.YTMod.fetchLRCLIB !== "function") return null;
      const params = new URLSearchParams();
      params.set("track_name", track.title);
      if (track.artist) params.set("artist_name", track.artist);
      if (Number.isFinite(track.durationMs) && track.durationMs > 0) {
        params.set("duration", String(Math.round(track.durationMs / 1000)));
      }
      const response = await window.YTMod.fetchLRCLIB(`${LRCLIB_API}?${params.toString()}`);
      if (!response.ok && response.status !== 404) {
        throw new Error("LRCLIB returned HTTP " + response.status);
      }
      let data = response.ok ? response.data : null;
      if (!data || !data.syncedLyrics) {
        const searchParams = new URLSearchParams({
          q: [track.title, track.artist].filter(Boolean).join(" "),
        });
        if (stale()) return null;
        const searchResponse = await window.YTMod.fetchLRCLIB(
          `${LRCLIB_SEARCH_API}?${searchParams.toString()}`
        );
        if (!searchResponse.ok) {
          throw new Error("LRCLIB search returned HTTP " + searchResponse.status);
        }
        // Prefer a synced match; fall back to a plain (unsynced) match so the
        // panel shows lyrics automatically instead of "No lyrics found"
        // (AJ, 2026-09-18). Both are scored against the current track on the
        // same search response — no second request.
        data = selectLRCLIBResult(searchResponse.data, track)
          || selectLRCLIBPlainResult(searchResponse.data, track);
      }
      if (!data || (!data.syncedLyrics && !data.plainLyrics)) return null;
      cacheLRCLyrics(key, data);
      cacheLyricsPersistent(key, data);
      return data;
    };

    /* Each source is a runner that returns true when it produced lyrics (or
       when the request went stale). The resolver walks them in the order the
       user set in the add-on's settings — "Source order" — instead of a
       hard-coded sequence (AJ, 2026-10-19). Runners never show a terminal
       "no lyrics" message themselves; the tail of this function does, so a
       source that misses early cannot flash a message before the next one
       has had its turn. */
    const runners = {
      spicy: async () => {
        try {
          const spicyResult = await fetchSpicyLyrics(track, key, controller);
          if (stale()) {
            // Silence here was a real dead end: the TTML was fetched and parsed,
            // then dropped on the floor with no output, which reads as "the fetch
            // failed".
            console.warn(`[SpicyLyrics] discarding the Spicy result — ${
              controller.signal.aborted ? "request aborted" : "a newer lyrics request superseded this one"}.`);
            return true;
          }
          if (spicyResult && spicyResult.ttml) {
            // Attribution + songwriters ride along with the API result; stash them
            // before loadTTML so the credits footer can render them.
            pendingSpicyCredits = {
              attribution: spicyResult.attribution || null,
              songwriters: Array.isArray(spicyResult.songwriters) ? spicyResult.songwriters : [],
            };
            if (loadTTML(spicyResult.ttml, "external")) {
              console.log("[SpicyLyrics] TTML rendered from the Spicy Lyrics API.");
              return true;
            }
            pendingSpicyCredits = null;
            console.warn("[SpicyLyrics] API returned TTML we could not parse; trying the next source.");
          } else {
            console.warn("[SpicyLyrics] no Spicy TTML for this track; trying the next source.");
          }
        } catch (error) {
          if (error && error.name === "AbortError") return true;
          console.warn("[SpicyLyrics] lookup failed; trying the next source:", error);
        }
        return false;
      },

      "lrc.red": async () => {
        try {
          const lrcRed = await fetchLrcRedLyrics(track, controller, key);
          if (stale()) return true;
          if (!lrcRed || (!lrcRed.ttml && !lrcRed.lrc)) return false;

          const hasWordTiming = !!(lrcRed.ttml && ttmlHasWordTiming(lrcRed.ttml));
          const hasSyncedLRC = !!(lrcRed.lrc && isSyncedLRC(lrcRed.lrc));
          const isStatic = !hasWordTiming && !hasSyncedLRC;

          // lrc.red only had a STATIC set. Prefer a SYNCED LRCLIB result over
          // static lyrics; only settle for lrc.red's static set when LRCLIB has
          // nothing synced (AJ, 2026-10-20).
          if (isStatic) {
            let lrclibData = null;
            try {
              lrclibData = await fetchLrclibData();
            } catch (error) {
              if (error && error.name === "AbortError") return true;
              console.warn("[SpicyLyrics] LRCLIB fallback for static lrc.red failed:", error);
            }
            if (stale()) return true;
            if (lrclibData && lrclibData.syncedLyrics) {
              loadLRCLyrics(lrclibData, track.durationMs);
              return true;
            }
          }

          let ok = false;
          let loadedSynced = false;
          if (hasWordTiming) {
            // Word-level TTML -> normal word-by-word karaoke.
            ok = loadTTML(lrcRed.ttml, "external", "lrc.red");
            if (ok) {
              loadedSynced = true;
              console.log("[SpicyLyrics] TTML rendered from lrc.red.");
            }
          }
          if (!ok && hasSyncedLRC) {
            ok = loadLRCLyrics({ syncedLyrics: lrcRed.lrc }, track.durationMs, "lrc.red");
            if (ok) loadedSynced = true;
          }
          if (!ok && lrcRed.ttml) {
            // Line-level-only TTML: no per-word timing. Present it as STATIC
            // auto-scroll instead (AJ, 2026-10-19).
            ok = loadLRCLyrics({ plainLyrics: ttmlPlainText(lrcRed.ttml) }, track.durationMs, "lrc.red");
          }
          if (!ok && lrcRed.lrc) {
            // A plain (untimestamped) .lrc piling on one line is the "all fire at
            // once" bug — feed it through the STATIC path, not syncedLyrics.
            ok = loadLRCLyrics({ plainLyrics: lrcRed.lrc }, track.durationMs, "lrc.red");
          }
          if (ok) {
            // Only warn about accuracy when the set that ACTUALLY loaded is
            // synced; a static set has no timing to be out of sync
            // (AJ, 2026-10-20).
            if (loadedSynced) showSourceNotice("lrc.red lyrics may be slightly out of sync");
            return true;
          }
          console.warn("[SpicyLyrics] lrc.red TTML could not be parsed; trying the next source.");
        } catch (error) {
          if (error && error.name === "AbortError") return true;
          console.warn("[SpicyLyrics] lrc.red lookup failed; trying the next source:", error);
        }
        return false;
      },

      unison: async () => {
        try {
          const unisonData = await fetchUnisonLyrics(track, key, controller);
          if (stale()) return true;
          if (unisonData && unisonData.format === "ttml") {
            if (loadTTML(unisonData.lyrics, "external", "Unison")) return true;
            console.warn("[SpicyLyrics] Unison returned TTML that could not be parsed; trying the next source.");
          }
          if (unisonData && unisonData.format === "lrc") {
            if (loadLRCLyrics({ syncedLyrics: unisonData.lyrics }, track.durationMs, "Unison")) return true;
            console.warn("[SpicyLyrics] Unison returned LRC that could not be parsed; trying the next source.");
          }
        } catch (error) {
          if (error && error.name === "AbortError") return true;
          console.warn("[SpicyLyrics] Unison lookup failed; trying the next source:", error);
        }
        return false;
      },

      lrclib: async () => {
        try {
          const data = await fetchLrclibData();
          if (stale()) return true;
          if (!data) return false;
          loadLRCLyrics(data, track.durationMs);
          return true;
        } catch (error) {
          if (error && error.name === "AbortError") return true;
          if (stale()) return true;
          console.warn("[SpicyLyrics] LRCLIB lookup failed:", error);
          return false;
        }
      },
    };

    // Fixed source priority (AJ, 2026-10-19): the user-facing source reordering
    // was removed. Spicy Lyrics wins when both it and lrc.red carry the track;
    // lrc.red is next for new releases; Unison + LRCLIB are last-resort fallbacks.
    const order = ["spicy", "lrc.red", "unison", "lrclib"];
    for (const id of order) {
      const runner = runners[id];
      if (!runner) continue;
      if (await runner()) return;
      if (stale()) return;
    }
    showLyricsMessage(NO_LYRICS_MESSAGE);
  }

  /* ===================== next-track prefetch ===================== */
  // Warm the NEXT track's ARTWORK so an MV -> audio skip has a decoded image the
  // instant the pane switches (AJ, 2026-10-20). The browser keeps the decoded
  // bitmap for the URL, so the pane's <img> paints on its first frame instead of
  // showing an empty box while the CDN responds.
  // Best-effort: no DOM node is kept, no error surfaces, and the URL goes through
  // hiResArt() so the cache key matches what the pane actually requests (the raw
  // queue thumbnail is =w60-h60, the pane asks for =w1024-h1024).
  let prefetchArtUrl = "";
  function prefetchNextTrackArt() {
    try {
      const player = window.YTMod && window.YTMod.player;
      if (!player || typeof player.getNextTrack !== "function") return;
      const next = player.getNextTrack();
      const raw = next && next.artworkUrl;
      if (!raw) return;
      const url = hiResArt(raw);
      if (!url || url === prefetchArtUrl) return;
      prefetchArtUrl = url;
      const img = new Image();
      img.decoding = "async";
      img.src = url;
    } catch (_) { /* prefetch must never affect playback */ }
  }

  // Warm the lyric cache for the upcoming track so the song change has no
  // blank flash. Best-effort only: any failure is swallowed and never touches
  // the current track's UI. Uses its own prefetchSeq + AbortController so it
  // cannot abort or race the active track's request.
  async function prefetchNextTrackLyrics() {
    const player = window.YTMod && window.YTMod.player;
    if (!player || typeof player.getNextTrack !== "function") return;
    let next;
    try { next = player.getNextTrack(); } catch (e) { return; }
    if (!next || !next.title) return;
    const key = getTrackKey(next);
    if (!key || key === currentTrackKey) return;
    // Already cached (memory or persistent file)? Nothing to do.
    if (lrclibCache.has(key) || getLyricsPersistent(key)) return;

    const controller = new AbortController();
    const reqId = ++prefetchSeq;
    try {
      let data = null;
      // Mirror the LRCLIB path of fetchLRCLyrics, but cache instead of rendering.
      if (!window.YTMod || typeof window.YTMod.fetchLRCLIB !== "function") return;
      const params = new URLSearchParams();
      params.set("track_name", next.title);
      if (next.artist) params.set("artist_name", next.artist);
      if (Number.isFinite(Number(next.durationMs)) && Number(next.durationMs) > 0) {
        params.set("duration", String(Math.round(Number(next.durationMs) / 1000)));
      }
      const response = await window.YTMod.fetchLRCLIB(`${LRCLIB_API}?${params.toString()}`);
      if (reqId !== prefetchSeq) return;
      if (response && response.ok && response.data && response.data.syncedLyrics) {
        data = response.data;
      } else if (!response || !response.ok || response.status === 404) {
        const searchParams = new URLSearchParams({
          q: [next.title, next.artist].filter(Boolean).join(" "),
        });
        const searchResponse = await window.YTMod.fetchLRCLIB(
          `${LRCLIB_SEARCH_API}?${searchParams.toString()}`
        );
        if (reqId !== prefetchSeq) return;
        if (searchResponse && searchResponse.ok) {
          data = selectLRCLIBResult(searchResponse.data, next);
        }
      }
      if (reqId !== prefetchSeq) return;
      if (!data || !data.syncedLyrics) return;
      cacheLRCLyrics(key, data);
      cacheLyricsPersistent(key, data);
    } catch (error) {
      if (error && error.name === "AbortError") return;
      // Non-fatal: lyrics simply load normally when the track starts.
    }
  }

  /* ===================== manual lyric search ===================== */
  // In-place LRCLIB search. Opens a popover, queries the search endpoint, and
  // applies the chosen match through the same loader the auto-sync uses, so a
  // manual pick behaves identically to an auto-synced line set. All DOM is built
  // with h() — no innerHTML — to satisfy YouTube Music's Trusted-Types policy.
  // A chosen match can also be persisted for the current track (cached in the
  // same layer fetchLRCLyrics reads from), so it survives reloads.

  let searchPanelEl = null;
  let searchAbortController = null;
  let searchRequestSeq = 0;

  function ensureSearchPanel() {
    if (searchPanelEl) return searchPanelEl;
    const panel = h("div", {
      class: "ym-sl-search hidden",
      role: "dialog",
      "aria-label": "Search lyrics",
    });
    const head = h("div", { class: "ym-sl-search-head" });
    const title = h("span", { class: "ym-sl-search-title", text: "Search lyrics" });
    const closeBtn = h("button", {
      class: "ym-sl-search-close",
      type: "button",
      "aria-label": "Close search",
      text: "✕",
    });
    head.append(title, closeBtn);

    const form = h("form", { class: "ym-sl-search-form" });
    const input = h("input", {
      class: "ym-sl-search-input",
      type: "search",
      placeholder: "Song title — artist",
      "aria-label": "Lyric search query",
      autocomplete: "off",
    });
    const submit = h("button", { class: "ym-sl-import", type: "submit", text: "Search" });
    form.append(input, submit);

    const rememberRow = h("label", { class: "ym-sl-search-remember" });
    const remember = h("input", { type: "checkbox", class: "ym-sl-search-remember-box" });
    rememberRow.append(remember, h("span", { text: "Remember for this track" }));

    const status = h("div", { class: "ym-sl-search-status", role: "status" });
    const results = h("div", {
      class: "ym-sl-search-results",
      role: "listbox",
      "aria-label": "Search results",
    });

    const foot = h("div", { class: "ym-sl-search-foot", role: "note" });

    panel.append(head, form, rememberRow, status, results, foot);
    panel._input = input;
    panel._remember = remember;
    panel._status = status;
    panel._results = results;
    panel._foot = foot;

    // Click anywhere outside the sheet (or its Search trigger) to dismiss it.
    document.addEventListener("pointerdown", (event) => {
      if (panel.classList.contains("hidden") || panel.classList.contains("closing")) return;
      if (panel.contains(event.target)) return;
      if (event.target.closest && event.target.closest(".ym-sl-empty-search")) return;
      closeSearchPanelAnimated();
    }, true);

    closeBtn.addEventListener("click", () => toggleSearchPanel(false));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      runLyricSearch();
    });

    searchPanelEl = panel;
    panelEl.appendChild(panel);
    return panel;
  }

  function closeSearchPanelAnimated() {
    const panel = searchPanelEl;
    if (!panel || panel.classList.contains("hidden") || panel.classList.contains("closing")) return;
    if (searchAbortController) {
      searchAbortController.abort();
      searchAbortController = null;
    }
    panel.classList.add("closing");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      panel.classList.remove("closing");
      panel.classList.add("hidden");
    };
    panel.addEventListener("animationend", finish, { once: true });
    window.setTimeout(finish, 280);
  }

  function toggleSearchPanel(force) {
    const panel = ensureSearchPanel();
    const show = force == null ? panel.classList.contains("hidden") : !!force;
    if (show) {
      const track = getCurrentTrack();
      panel._input.value = track ? [track.title, track.artist].filter(Boolean).join(" — ") : "";
      panel._results.replaceChildren();
      panel._status.textContent = "";
      panel._foot.textContent = lastLyricsError
        ? "ERR: rate limited — try again in a couple of minutes."
        : "";
      panel.classList.remove("hidden", "closing");
      panel._input.focus();
      panel._input.select();
    } else {
      closeSearchPanelAnimated();
    }
  }

  async function runLyricSearch() {
    const panel = ensureSearchPanel();
    const query = (panel._input.value || "").trim();
    if (!query) {
      panel._status.textContent = "Type a song title or artist first.";
      return;
    }
    if (!window.YTMod || typeof window.YTMod.fetchLRCLIB !== "function") {
      panel._status.textContent = "Search unavailable. Reload Aurora Lyrics and try again.";
      return;
    }
    const requestId = ++searchRequestSeq;
    if (searchAbortController) searchAbortController.abort();
    const controller = new AbortController();
    searchAbortController = controller;
    panel._status.textContent = "Searching…";
    panel._results.replaceChildren();

    const params = new URLSearchParams({ q: query });
    try {
      const response = await window.YTMod.fetchLRCLIB(`${LRCLIB_SEARCH_API}?${params.toString()}`);
      if (controller.signal.aborted || requestId !== searchRequestSeq) return;
      searchAbortController = null;
      if (!response.ok) throw new Error("LRCLIB search returned HTTP " + response.status);
      const list = Array.isArray(response.data) ? response.data : [];
      if (!list.length) {
        panel._status.textContent = "No results found.";
        return;
      }
      panel._status.textContent = `${list.length} result${list.length === 1 ? "" : "s"} — pick one to load.`;
      list.slice(0, 25).forEach((item) => {
        panel._results.appendChild(makeSearchResultRow(item, panel._remember.checked, panel._status));
      });
    } catch (error) {
      if (error && error.name === "AbortError") return;
      if (requestId !== searchRequestSeq) return;
      searchAbortController = null;
      panel._status.textContent = "Search failed. Try again.";
      console.warn("[SpicyLyrics] manual lyric search failed:", error);
    }
  }

  function makeSearchResultRow(item, remember, status) {
    const row = h("button", { class: "ym-sl-search-result", type: "button", role: "option" });
    const name = h("span", { class: "ym-sl-search-name", text: item.trackName || "Unknown track" });
    const hasSync = !!item.syncedLyrics;
    const hasPlain = !!item.plainLyrics;
    const metaBits = [item.artistName, item.albumName].filter(Boolean);
    if (!hasSync && hasPlain) metaBits.push("unsynced");
    const meta = h("span", { class: "ym-sl-search-meta", text: metaBits.join(" · ") });
    row.append(name, meta);
    if (hasSync || hasPlain) {
      // Both synced and plain matches are now loadable. Plain ones render as a
      // static, already-filled set with no karaoke sweep (AJ, 2026-09-18).
      if (!hasSync) {
        row.classList.add("no-sync-available");
        row.title = "Load unsynced lyrics (no timestamps)";
      }
      row.addEventListener("click", () => applySearchResult(item, remember, status));
    } else {
      row.classList.add("no-sync");
      row.disabled = true;
      row.title = "No lyrics for this match";
    }
    return row;
  }

  function applySearchResult(item, remember, status) {
    const track = getCurrentTrack();
    const durationMs = track ? Number(track.durationMs) : 0;
    const key = track ? getTrackKey(track) : "";
    loadLRCLyrics(item, durationMs);
    cacheLRCLyrics(key, item);
    if (remember && key) cacheLyricsPersistent(key, item);
    const isUnsynced = !item.syncedLyrics && item.plainLyrics;
    status.textContent = `Applied ${isUnsynced ? "unsynced " : ""}lyrics: ${item.trackName || "lyrics"}${remember ? " (remembered for this track)" : ""}.`;
    toggleSearchPanel(false);
  }

  async function syncTrackLyrics(force) {
    const track = getCurrentTrack();
    const key = getTrackKey(track);
    if (!key) return;

    const positionMs = window.YTMod && window.YTMod.player
      ? window.YTMod.player.getPositionMs()
      : null;
    const durationMs = Number(track.durationMs);
    const restartedTemporaryTrack =
      manualLyricsTrackKey === key &&
      lastObservedTrackKey === key &&
      Number.isFinite(positionMs) &&
      Number.isFinite(lastObservedPositionMs) &&
      Number.isFinite(durationMs) &&
      durationMs > 0 &&
      lastObservedPositionMs >= durationMs * 0.9 &&
      positionMs < 5000;

    lastObservedTrackKey = key;
    lastObservedPositionMs = positionMs;

    // A *temporary* manual upload should fall back to the API-synced lyrics when
    // the same track is replayed. A *permanent* upload must survive the restart,
    // so we leave currentTrackKey alone and let the existing TTML DOM persist.
    if (restartedTemporaryTrack && !manualLyricsIsPermanent) {
      manualLyricsTrackKey = "";
      currentTrackKey = "";
    }
    if (key === currentTrackKey) return;

    currentTrackKey = key;
    prefetchNextTrackLyrics();
    // Also warm the next track's cover so an MV -> audio skip is instant.
    prefetchNextTrackArt();
    loadVideoOffsetForTrack(track);
    refreshTrack();
    if (manualLyricsTrackKey && manualLyricsTrackKey !== key) {
      manualLyricsTrackKey = "";
    }
    if (manualLyricsTrackKey === key) return;

    if (activeTrackAbort) {
      activeTrackAbort.abort();
      activeTrackAbort = null;
    }
    const requestId = ++trackRequestSeq;
    showLyricsSkeleton();

    let savedTTML = null;
    try {
      savedTTML = await getPermanentTTML(key);
    } catch (error) {
      console.warn("[SpicyLyrics] Could not read permanent TTML:", error);
    }
    if (requestId !== trackRequestSeq || key !== currentTrackKey) return;

    if (!force && savedTTML) {
      if (loadTTML(savedTTML, "external")) return;
      try {
        await removePermanentTTML(key);
      } catch (error) {
        console.warn("[SpicyLyrics] Could not remove invalid permanent TTML:", error);
      }
      if (requestId !== trackRequestSeq || key !== currentTrackKey) return;
    }

    manualLyricsIsPermanent = false;
    refreshPermanentDeleteState();
    fetchLRCLyrics(track, key);
  }

  /* ===================== lyric DOM construction ===================== */

  function makeLetterGroup(word) {
    const start = word.StartTime * 1000;
    const rawEnd = word.EndTime * 1000;
    const letterEnd = Math.max(start + 1, rawEnd - 250);
    const letterTotal = Math.max(1, letterEnd - start);
    const group = h("div", { class: "letterGroup" });
    const letters = [];
    const chars = Array.from(word.Text);
    const duration = letterTotal / Math.max(chars.length, 1);

    chars.forEach((char, index) => {
      const isSpace = char.trim().length === 0;
      const letter = h("span", { class: "letter Emphasis", text: char });
      const letterStart = start + index * duration;
      const letterEnd = letterStart + duration;
      letter.style.setProperty("--gradient-position", "-20%");
      letter.style.setProperty("--text-shadow-opacity", "0%");
      letter.style.setProperty("--text-shadow-blur-radius", "4px");
      letter.style.setProperty("--ym-sl-base-scale", "0.95");
      letter.style.transform = "translateY(calc(var(--DefaultLyricsSize) * 0.02))";
      if (index === chars.length - 1) letter.classList.add("LastLetterInWord");
      // Whitespace inside an inline-block collapses to a 0px box, which glues
      // multi-word syllables (e.g. "Watch this") together. Tag it so the
      // stylesheet can keep the space rendered. Mirrors upstream Emphasize.ts.
      if (isSpace) letter.classList.add("SpaceLetter");
      group.appendChild(letter);
      letters.push({
        HTMLElement: letter,
        StartTime: letterStart,
        EndTime: letterEnd,
        AnimatorStore: null,
      });
    });

    const model = {
      HTMLElement: group,
      Text: word.Text,
      StartTime: start,
      EndTime: rawEnd,
      TotalTime: Math.max(1, rawEnd - start),
      LetterGroup: true,
      Letters: letters,
      AnimatorStore: null,
    };
    return model;
  }

  /* ===================== Romanization (JP + KR) ===================== */
  // Rule-based kana -> romaji and Hangul -> romaja. Display-only, computed once
  // at lyric build time (see appendRomaji / buildRendererLines), so it adds no
  // per-frame or per-letter cost. No dictionary, no network, no bundle bloat.
  // Chinese pinyin is intentionally excluded (it needs a dictionary) — see notes.

  const HIRA_BASE = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわゐゑをん";
  const HIRA_ROMA = ["a","i","u","e","o","ka","ki","ku","ke","ko","sa","shi","su","se","so","ta","chi","tsu","te","to","na","ni","nu","ne","no","ha","hi","fu","he","ho","ma","mi","mu","me","mo","ya","yu","yo","ra","ri","ru","re","ro","wa","wi","we","wo","n"];
  const KATA_BASE = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヰヱヲン";

  const KANA_MAP = {};
  function dakutenize(roma) {
    if (roma === "shi") return "ji";
    if (roma === "chi") return "ji";
    if (roma === "tsu") return "zu";
    if (roma === "fu") return "bu";
    const dm = { k: "g", s: "z", t: "d", h: "b" };
    const c = roma[0];
    return dm[c] ? dm[c] + roma.slice(1) : roma;
  }
  function handakutenize(roma) {
    if (roma === "fu") return "pu";
    return roma[0] === "h" ? "p" + roma.slice(1) : roma;
  }
  function buildKanaMap() {
    for (let i = 0; i < HIRA_BASE.length; i++) {
      const k = HIRA_BASE[i];
      const r = HIRA_ROMA[i];
      KANA_MAP[k] = r;
      const cp = k.codePointAt(0);
      const c0 = r[0];
      if (c0 === "k" || c0 === "s" || c0 === "t" || c0 === "h" || c0 === "f") {
        KANA_MAP[String.fromCodePoint(cp + 1)] = dakutenize(r);
        if (c0 === "h" || c0 === "f") KANA_MAP[String.fromCodePoint(cp + 2)] = handakutenize(r);
      }
    }
    for (let i = 0; i < KATA_BASE.length; i++) {
      const k = KATA_BASE[i];
      const r = HIRA_ROMA[i];
      KANA_MAP[k] = r;
      const cp = k.codePointAt(0);
      const c0 = r[0];
      if (c0 === "k" || c0 === "s" || c0 === "t" || c0 === "h" || c0 === "f") {
        KANA_MAP[String.fromCodePoint(cp + 1)] = dakutenize(r);
        if (c0 === "h" || c0 === "f") KANA_MAP[String.fromCodePoint(cp + 2)] = handakutenize(r);
      }
    }
    Object.assign(KANA_MAP, {
      "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o",
      "ゃ": "ya", "ゅ": "yu", "ょ": "yo", "ゎ": "wa", "ゕ": "ka", "ゖ": "ka",
      "ァ": "a", "ィ": "i", "ゥ": "u", "ェ": "e", "ォ": "o",
      "ャ": "ya", "ュ": "yu", "ョ": "yo", "ヮ": "wa", "ヵ": "ka", "ヶ": "ka",
    });
  }
  buildKanaMap();

  const SMALL_Y = { "ゃ": "a", "ゅ": "u", "ょ": "o", "ャ": "a", "ュ": "u", "ョ": "o" };
  function isKanaCode(cp) {
    return (cp >= 0x3040 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff);
  }
  function isSmallYKana(ch) {
    return Object.prototype.hasOwnProperty.call(SMALL_Y, ch);
  }

  // Hangul -> Revised Romanization (initial + medial + final jamo).
  const CHOSEONG = ["g","kk","n","d","tt","r","m","b","pp","s","ss","","j","jj","ch","k","t","p","h"];
  const JUNGSEONG = ["a","ae","ya","yae","eo","e","yeo","ye","o","wa","wae","oe","yo","u","wo","we","wi","yu","eu","ui","i"];
  const JONGSEONG = ["","g","k","g","n","n","n","t","l","lk","lm","l","l","l","l","lp","m","b","p","s","ss","ng","j","ch","k","t","p","h"];
  function hangulToRomaja(cp) {
    const SBase = 0xac00, NCount = 588, TCount = 28;
    const idx = cp - SBase;
    const L = Math.floor(idx / NCount);
    const V = Math.floor((idx % NCount) / TCount);
    const T = idx % TCount;
    let s = CHOSEONG[L] + JUNGSEONG[V];
    if (T > 0) s += JONGSEONG[T];
    return s;
  }

  function romanize(text) {
    if (!text) return "";
    const out = [];
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const cp = ch.codePointAt(0);
      if (cp >= 0xac00 && cp <= 0xd7a3) {
        out.push(hangulToRomaja(cp));
        continue;
      }
      if (!isKanaCode(cp)) {
        out.push(ch);
        continue;
      }
      // Grammatical particles は/へ/を read as wa/e/o when they close a kana run
      // (followed by a non-kana or end of string). Still rule-based, no dictionary.
      if (ch === "は" || ch === "へ" || ch === "を") {
        const nextCh = chars[i + 1];
        const nextKana = nextCh && isKanaCode(nextCh.codePointAt(0));
        if (!nextKana) {
          out.push(ch === "は" ? "wa" : ch === "へ" ? "e" : "o");
          continue;
        }
      }
      // sokuon (small tsu) -> double the next syllable's first consonant
      if (ch === "っ" || ch === "ッ") {
        const nr = chars[i + 1] ? KANA_MAP[chars[i + 1]] : null;
        out.push(nr ? nr[0] : "tsu");
        continue;
      }
      // chōonpu (long vowel mark) -> repeat the previous vowel
      if (ch === "ー" || ch === "〜" || ch === "ｰ") {
        const prev = out[out.length - 1];
        if (prev && /[aiueo]$/.test(prev)) out[out.length - 1] = prev + prev[prev.length - 1];
        continue;
      }
      const rom = KANA_MAP[ch];
      if (!rom) { out.push(ch); continue; }
      // small y-kana merges with the previous syllable ending in 'i'
      if (isSmallYKana(ch) && out.length) {
        const prev = out[out.length - 1];
        if (prev.endsWith("i") && !prev.endsWith("ei")) {
          const consonant = prev.slice(0, -1);
          const yv = SMALL_Y[ch];
          out[out.length - 1] = /^(sh|ch|j)$/.test(consonant) ? consonant + yv : consonant + "y" + yv;
          continue;
        }
      }
      out.push(rom);
    }
    return out.join("");
  }

  function appendRomaji(lineElement, syllables) {
    if (!currentSettings.romanizationEnabled) return;
    if (!syllables || !syllables.length) return;
    const plain = syllables.map((w) => w.Text).join("");
    if (!plain.trim()) return;
    // Reading kanji needs a dictionary (out of scope), so strip Han characters
    // first and show only the pronunciation of the readable kana underneath the
    // original line. Pure-kana and Hangul lines still get full romanization.
    const kanaOnly = plain.replace(/[\u3400-\u9FFF]/g, "");
    if (!kanaOnly.trim()) return;
    const rom = romanize(kanaOnly);
    if (!rom || rom === kanaOnly) return;
    if (!/[A-Za-z]/.test(rom)) return;
    lineElement.appendChild(h("div", { class: "romaji", text: rom }));
  }

  // Does the whole-word join apply to this line? `joinSyllables` is the master
  // switch; `joinBgSyllables` lets the user keep per-syllable karaoke on the
  // background-vocal lines while the lead lines stay joined (AJ, 2026-10-20).
  // Defaults to ON, which is the historical behaviour — bg lines joined too.
  function joinApplies(background) {
    if (!currentSettings.joinSyllables) return false;
    if (background && currentSettings.joinBgSyllables === false) return false;
    return true;
  }

  function makeWord(word, isLast, lineTimed, noKaraoke, background) {
    // An unsynced line (no real per-word timing) must not spawn syllable/letter
    // karaoke springs — that is what tanks FPS on partially-synced TTML imports
    // (AJ, 2026-09-17). Force it to a plain word so animateWord shows it as a
    // static block.
    const suppressKaraoke = !!(noKaraoke && !lineTimed);
    const start = word.StartTime * 1000;
    const end = Math.max(start + 1, word.EndTime * 1000);
    const duration = end - start;
    // A LINE-TIMED word is a whole line wearing one word's clothes. It must never
    // become a letterGroup: makeLetterGroup() would spawn one karaoke spring per
    // CHARACTER, so a 40-character line turns into 40 animated spans each with a
    // ~90ms window, while the line-level fill runs over the full multi-second
    // window. The result is the "wavy and glowy" drift AJ sees — it reads as an
    // animation bug, not as line-synced lyrics.
    //
    // Keeping it a plain `.word` hands the whole thing to the line-level fill:
    // the gradient sweeps across the line as one unit, which is what line-synced
    // lyrics are supposed to look like. Word-by-word karaoke is the Syllable
    // body's job, and those words are short enough to stay plain words too.
    let letterCapable =
      !lineTimed &&
      !suppressKaraoke &&
      !word.DisableLetterAnimation &&
      !word.disableLetterAnimation &&
      isLetterCapable(word.Text, duration);
    // Join syllables (AJ, 2026-10-19): paint every word as ONE whole-word fill
    // instead of a per-letter karaoke group, so a word lights up whole with no
    // syllable stepping — the Spicy Lyrics toggle the user asked to mirror. The
    // plain-.word path keeps its own scale/glow/gradient springs, so it still
    // animates, just as a single unit.
    // Simple lyrics (Apple Music / AMLL style): a long word must NOT split into a
    // per-letter "wavy" karaoke group either — AMLL fills the whole word with one
    // clean gradient sweep. Force the plain-.word path so long words match AMLL.
    if (joinApplies(background) || currentSettings.simpleLyrics) letterCapable = false;
    const element = letterCapable
      ? makeLetterGroup(word)
      : h("span", { class: "word", text: word.Text });

    if (!letterCapable) {
      if (staticLyricsActive) {
        // Static (unsynced) lyrics: paint fully filled immediately so there is
        // no one-frame dim flash before animateWord confirms the Sung state.
        element.style.setProperty("--gradient-position", "100%");
        element.style.setProperty("--text-shadow-opacity", "0%");
        element.style.setProperty("--text-shadow-blur-radius", "4px");
        element.style.setProperty("--ym-sl-base-scale", "1");
        element.style.transform = "translateY(0)";
      } else {
        element.style.setProperty("--gradient-position", "-20%");
        element.style.setProperty("--text-shadow-opacity", "0%");
        element.style.setProperty("--text-shadow-blur-radius", "4px");
        element.style.setProperty("--ym-sl-base-scale", lineTimed ? "1" : "0.95");
        element.style.transform = lineTimed
          ? "translateY(0)"
          : "translateY(calc(var(--DefaultLyricsSize) * 0.01))";
      }
    }
    const elementNode = letterCapable ? element.HTMLElement : element;
    if (word.IsPartOfWord) elementNode.classList.add("PartOfWord");
    if (isLast) {
      elementNode.classList.add("LastWordInLine");
    }

    return letterCapable
      ? element
      : {
          HTMLElement: element,
          Text: word.Text,
          StartTime: start,
          EndTime: end,
          TotalTime: duration,
          IsPartOfWord: !!word.IsPartOfWord,
          LineTimed: !!lineTimed,
          NoKaraoke: suppressKaraoke,
          LetterGroup: false,
          AnimatorStore: null,
        };
  }

  function appendWords(lineElement, lineModel, words, background, noKaraoke) {
    // Join syllables (AJ, 2026-10-19): a logical word is a run of syllable tokens
    // glued by IsPartOfWord. Left alone each token fills in sequence, so a word
    // reads as separate syllables. When the setting is on, collapse every run into
    // ONE word spanning the whole run (merged text + merged time window) so it
    // fills as a single unit. OFF by default, so the per-syllable karaoke and the
    // .word-group wrapping are unchanged unless the user opts in.
    let renderWords = words;
    if (joinApplies(background) && Array.isArray(words) && words.length) {
      const joined = [];
      for (const word of words) {
        const open = joined[joined.length - 1];
        if (open && open.__joining) {
          // Extend the open word: append this token's text and let it run to the
          // token's end. Keep the run open only while this token still glues
          // forward (a joined word never carries a trailing PartOfWord class).
          open.Text = (open.Text || "") + (word.Text || "");
          open.EndTime = word.EndTime;
          open.__joining = !!word.IsPartOfWord;
        } else {
          joined.push({
            Text: word.Text,
            StartTime: word.StartTime,
            EndTime: word.EndTime,
            IsPartOfWord: false,
            DisableLetterAnimation: word.DisableLetterAnimation,
            disableLetterAnimation: word.disableLetterAnimation,
            __joining: !!word.IsPartOfWord,
          });
        }
      }
      joined.forEach((w) => { delete w.__joining; });
      renderWords = joined;
    }
    let currentWordGroup = null;
    renderWords.forEach((word, wordIndex) => {
      const wordModel = makeWord(word, wordIndex === renderWords.length - 1, lineModel.LineTimed, noKaraoke, background);
      if (background) {
        wordModel.BGWord = true;
        wordModel.HTMLElement.classList.add("bg-word");
      }
      const previous = renderWords[wordIndex - 1];
      const belongsToGroupedWord =
        word.IsPartOfWord || (previous && previous.IsPartOfWord && currentWordGroup);

      if (belongsToGroupedWord) {
        if (!currentWordGroup) {
          currentWordGroup = h("span", { class: "word-group" });
          lineElement.appendChild(currentWordGroup);
        }
        currentWordGroup.appendChild(wordModel.HTMLElement);
        if (!word.IsPartOfWord && previous && previous.IsPartOfWord) {
          currentWordGroup = null;
        }
      } else {
        currentWordGroup = null;
        lineElement.appendChild(wordModel.HTMLElement);
      }
      lineModel.Syllables.Lead.push(wordModel);
    });
  }

  function makeDotLine(startMs, endMs, oppositeAligned) {
    const lineElement = h("div", { class: "line musical-line" });
    if (oppositeAligned) lineElement.classList.add("OppositeAligned");
    const dotGroup = h("div", { class: "dotGroup" });
    const total = Math.max(1, endMs - startMs);
    const base = total / 3;
    const padding = -((PRE_HIDDEN_DOT_LINE_MS + 50) / 3);
    const dotEnds = [
      Math.max(startMs, startMs + base + padding),
      Math.max(startMs, startMs + base * 2 + padding * 2),
      Math.max(startMs, startMs + total - (PRE_HIDDEN_DOT_LINE_MS + 50)),
    ];
    const words = [];
    let dotStart = startMs;

    for (let i = 0; i < 3; i++) {
      const dot = h("span", { class: "word dot", text: "•" });
      dotGroup.appendChild(dot);
      words.push({
        HTMLElement: dot,
        Text: "•",
        StartTime: dotStart,
        EndTime: Math.max(dotStart + 1, dotEnds[i]),
        TotalTime: Math.max(1, dotEnds[i] - dotStart),
        Dot: true,
        AnimatorStore: null,
      });
      dotStart = dotEnds[i];
    }
    lineElement.appendChild(dotGroup);
    return {
      HTMLElement: lineElement,
      StartTime: startMs,
      EndTime: endMs,
      TotalTime: total,
      DotLine: true,
      Syllables: { Lead: words },
      AnimatorStore: null,
    };
  }

  function buildCreditsFooter(names) {
    const footer = h("div", { class: "ym-sl-credits" });
    if (names && names.length) {
      footer.appendChild(h("div", { class: "ym-sl-credits-label", text: "Written By" }));
      const namesEl = h("div", { class: "ym-sl-credits-names" });
      names.forEach((name, index) => {
        if (index) namesEl.appendChild(document.createTextNode(", "));
        namesEl.appendChild(h("span", { class: "ym-sl-credits-name", text: name }));
      });
      footer.appendChild(namesEl);
    }
    // Order matters: the provider is the credit every source owes, then the
    // people who made the sync (community syncs only).
    if (currentProvider) footer.appendChild(buildProviderRow(currentProvider, staticLyricsActive));
    if (currentUploader) footer.appendChild(buildPersonRow("Uploaded by", currentUploader));
    if (currentMaker) footer.appendChild(buildPersonRow("Made by", currentMaker));
    return footer;
  }

  // "Lyrics provided by <provider>" — every API source owes this one, so it is
  // plain text and never conditional on a person existing.
  // lrc.red's docs explicitly ask for credit; a link is the strongest form of it
  // and lets the user check the source (AJ, 2026-10-19).
  const PROVIDER_URLS = {
    "lrc.red": "https://lrc.red",
    "Unison": "https://unison.boidu.dev/",
    "LRCLIB": "https://lrclib.net/",
  };
  // Sources whose timing is machine-aligned rather than hand-synced get the
  // warning treatment: red pill + triangle. Persistent, unlike the transient
  // chip above the lyrics (AJ, 2026-10-19).
  const PROVIDER_WARN = { "lrc.red": true };

  // Red triangle, white exclamation. Drawn as SVG so it stays crisp at any size.
  function buildProviderWarnIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "ym-sl-provider-warn-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const tri = document.createElementNS(NS, "path");
    tri.setAttribute("d", "M12 2.6 22.6 21.2H1.4Z");
    tri.setAttribute("fill", "#e5484d");
    const bar = document.createElementNS(NS, "rect");
    bar.setAttribute("x", "11.05");
    bar.setAttribute("y", "8.3");
    bar.setAttribute("width", "1.9");
    bar.setAttribute("height", "6.5");
    bar.setAttribute("rx", "0.95");
    bar.setAttribute("fill", "#ffffff");
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", "12");
    dot.setAttribute("cy", "17.5");
    dot.setAttribute("r", "1.15");
    dot.setAttribute("fill", "#ffffff");
    svg.append(tri, bar, dot);
    return svg;
  }

  function buildProviderRow(provider, isStatic) {
    // The red pill/triangle means "these timings are machine-aligned". A static
    // (unsynced) set has no timings at all, so the warning is meaningless and
    // reads as a defect — show the normal credit instead (AJ, 2026-10-20).
    const warn = !!PROVIDER_WARN[provider] && !isStatic;
    const row = h("div", { class: "ym-sl-provider" + (warn ? " ym-sl-provider-warn" : "") });
    if (warn) row.appendChild(buildProviderWarnIcon());
    row.appendChild(h("span", { class: "ym-sl-provider-label", text: "Lyrics provided by" }));
    const url = PROVIDER_URLS[provider] || "";
    if (url) {
      row.appendChild(h("a", {
        class: "ym-sl-provider-name",
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
        text: provider,
      }));
    } else {
      row.appendChild(h("span", { class: "ym-sl-provider-name", text: provider }));
    }
    if (!warn) return row;
    // Explain WHY it is flagged, so the red pill is not just alarm without
    // context. Static — it lives as long as the lyrics do (AJ, 2026-10-19).
    return h("div", { class: "ym-sl-provider-block" },
      row,
      h("div", {
        class: "ym-sl-provider-note",
        text: "Timing may have felt off — this source aligns the lyrics automatically.",
      })
    );
  }

  // RGB <-> HSL, used only to push the two sampled colours apart when the avatar
  // is too flat for the spin to read (see sampleAvatarColor).
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h / 6, s: s, l: l };
  }

  function hslToRgb(h, s, l) {
    const hue = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue(p, q, h + 1 / 3) * 255),
      Math.round(hue(p, q, h) * 255),
      Math.round(hue(p, q, h - 1 / 3) * 255),
    ];
  }

  // Average one vertical slice of the 24x24 avatar sample, chroma-weighted and
  // skipping near-black / near-white pixels. Returns [r,g,b] or null.
  function averageAvatarSlice(data, x0, x1) {
    let r = 0, g = 0, b = 0, w = 0;
    for (let y = 0; y < 24; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * 24 + x) * 4;
        const pr = data[i], pg = data[i + 1], pb = data[i + 2];
        const max = Math.max(pr, pg, pb);
        const min = Math.min(pr, pg, pb);
        const light = (max + min) / 510;
        if (light < 0.12 || light > 0.92) continue;
        const weight = 0.3 + ((max - min) / 255) * 1.7;
        r += pr * weight; g += pg * weight; b += pb * weight; w += weight;
      }
    }
    if (!w) return null;
    return [Math.round(r / w), Math.round(g / w), Math.round(b / w)];
  }

  // Sample a credited person's avatar for the attribution glow (AJ, 2026-09-28) —
  // the same idea as the Ambient add-on's artwork accent, but per person and
  // returning TWO colours, because the pill's glow SPINS between them and one
  // flat colour would have no motion. The avatar is split down the middle and
  // each half averaged; if the two come out too alike (a flat avatar), the second
  // is pushed round the hue wheel so the spin still reads. cdn.discordapp.com
  // serves Access-Control-Allow-Origin: *, so the canvas is not tainted; ANY
  // failure (broken / blocked / no CORS) resolves null and the caller leaves the
  // neutral white fallback. Results are cached per URL.
  const avatarColorCache = new Map();
  function sampleAvatarColor(url) {
    if (!url) return Promise.resolve(null);
    if (avatarColorCache.has(url)) return Promise.resolve(avatarColorCache.get(url));
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.onload = () => {
        let pair = null;
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 24;
          canvas.height = 24;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(img, 0, 0, 24, 24);
            const data = ctx.getImageData(0, 0, 24, 24).data;
            const left = averageAvatarSlice(data, 0, 12);
            const right = averageAvatarSlice(data, 12, 24);
            const first = left || right;
            let second = right || left;
            if (first && second) {
              const dist = Math.abs(first[0] - second[0]) +
                Math.abs(first[1] - second[1]) +
                Math.abs(first[2] - second[2]);
              if (dist < 70) {
                // Too alike to read as motion: push the second colour round the
                // hue wheel (lifting its saturation a little) so the spin shows.
                const hsl = rgbToHsl(second[0], second[1], second[2]);
                second = hslToRgb(
                  (hsl.h + 0.11) % 1,
                  Math.min(1, Math.max(0.45, hsl.s * 1.1 + 0.15)),
                  Math.min(0.78, Math.max(0.42, hsl.l))
                );
              }
              pair = {
                a: "rgb(" + first[0] + ", " + first[1] + ", " + first[2] + ")",
                b: "rgb(" + second[0] + ", " + second[1] + ", " + second[2] + ")",
              };
            }
          }
        } catch (_) { pair = null; }
        if (avatarColorCache.size > 120) avatarColorCache.clear();
        avatarColorCache.set(url, pair);
        resolve(pair);
      };
      img.onerror = () => { avatarColorCache.set(url, null); resolve(null); };
      img.src = url;
    });
  }

  // Stable per-person two-tone glow when the avatar can't be sampled (AJ,
  // 2026-09-28). Hashes the username to a base hue, then takes its COMPLEMENT
  // (+180deg) for the second colour — so every pill gets a maximum-contrast
  // pair regardless of where the hash lands, and the rotating seam is always
  // unmistakably visible. Never white-on-white, which read as a static overlay
  // with no motion. sampleAvatarColor() may upgrade these to the pfp's own
  // colours when the canvas is readable.
  function defaultPairFor(name) {
    let h = 0;
    name = String(name || "");
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const base = h % 360;
    const complementary = (base + 180) % 360;
    return {
      a: "hsl(" + base + ", 92%, 62%)",
      b: "hsl(" + complementary + ", 92%, 62%)",
    };
  }

  // AJ, 2026-09-28 (v10): drive the gliding colour seam with a single rAF,
  // but SCOPED to each .ym-sl-uploader-link (NOT :root) — v8's root-level
  // setProperty cascade-invalidated the whole tree and tanked fps to ~20.
  // Scoping to the pill means only the pill + its 2 pseudos get invalidated
  // per frame. JS setProperty (not CSS @keyframes) because AJ's Chrome
  // reliably repaints the conic on JS writes but NOT on @keyframes animation
  // of the registered @property (v6/v9 freeze). `currentSpinDeg` is exposed
  // so buildPersonRow can stamp new pills with the live angle (no first-
  // frame flicker on track change). prefers-reduced-motion → never start the
  // rAF; startPfpGlowEngine() stamps 0deg on every pill.
  let pfpGlowRAF = 0;
  let currentSpinDeg = 0;
  // QOL #1 follow-on (2026-09-28): the profile-glow rAF must NOT repaint the
  // blurred conic while the credits block is scrolled off-screen (mid-song, panel
  // hidden, or fullscreen-reparented). pfpGlowCreditsInView is driven by an
  // IntersectionObserver on .ym-sl-credits; the frame only advances + stamps while
  // it is true, so off-screen pills cost nothing — yet the seam resumes exactly
  // where it left off when they scroll back into view.
  let pfpGlowCreditsInView = true;
  let pfpGlowObserver = null;
  function setSpinOnAllPills(deg) {
    const v = (+deg).toFixed(2) + "deg";
    const pills = document.querySelectorAll(".ym-sl-uploader-link");
    for (let i = 0; i < pills.length; i++) {
      pills[i].style.setProperty("--ym-sl-pfp-spin", v);
    }
  }
  function ensurePfpGlowObserver() {
    if (pfpGlowObserver || typeof IntersectionObserver === "undefined") return;
    pfpGlowObserver = new IntersectionObserver((entries) => {
      // One observed target at a time (the live credits block); use its latest state.
      for (const e of entries) {
        if (e.target === creditsFooterEl) pfpGlowCreditsInView = e.isIntersecting;
      }
    }, { root: null, threshold: 0 });
  }
  function startPfpGlowEngine() {
    if (pfpGlowRAF) return;
    const reduce = !!(window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (reduce) {
      setSpinOnAllPills(0);
      return;
    }
    ensurePfpGlowObserver();
    const PERIOD_MS = 4200;
    const GLOW_MIN_MS = 1000 / 40; // ~40fps updates: identical-looking for a slow
                                   // 4.2s glide, but halves conic+blur repaint cost
    let glowClock = 0;             // advances ONLY while the credits are visible,
                                   // so the seam resumes exactly where it left off
    let lastGlowFrame = 0;
    let lastGlowPaint = -1e9;
    (function frame(now) {
      const dt = lastGlowFrame ? now - lastGlowFrame : 0;
      lastGlowFrame = now;
      if (pfpGlowCreditsInView) {
        glowClock += dt;
        if (glowClock - lastGlowPaint >= GLOW_MIN_MS) {
          lastGlowPaint = glowClock;
          currentSpinDeg = (glowClock / PERIOD_MS * 360) % 360;
          setSpinOnAllPills(currentSpinDeg);
        }
      }
      pfpGlowRAF = requestAnimationFrame(frame);
    })(performance.now());
  }

  // "<label> <avatar> <username>" — links to that person's Spicy Lyrics
  // profile. Used for both the uploader and the maker; only community syncs
  // (source === "spicy_lyrics") have either.
  function buildPersonRow(label, uploader) {
    const row = h("div", { class: "ym-sl-uploader" });
    row.appendChild(h("span", { class: "ym-sl-uploader-label", text: label }));

    // Default two-tone glow colours (AJ, 2026-09-28): a stable per-person hue pair
    // set immediately, so the pill always has a visible gliding seam even before/
    // without a sampled avatar. sampleAvatarColor() upgrades these below when the
    // canvas is readable.
    const glow = defaultPairFor(uploader.username || label || "spicy");
    row.style.setProperty("--ym-sl-pfp-accent-a", glow.a);
    row.style.setProperty("--ym-sl-pfp-accent-b", glow.b);

    const link = h("a", {
      class: "ym-sl-uploader-link",
      // Open the uploader's profile in a NEW TAB so YT Music stays put. Without
      // target="_blank" the browser navigates THIS tab away from music.youtube.com,
      // which unloads the SPA and trips the host's "Leave site?" prompt — exactly
      // the reported bug. rel guards the referrer/opener; the URL is already
      // validated as http(s) at parse time (parseSpicyLyrics attribution).
      target: "_blank",
      rel: "noopener noreferrer",
      title: uploader.url || "",
    });
    if (uploader.url) link.href = uploader.url;

    if (uploader.avatar) {
      const img = h("img", { class: "ym-sl-uploader-avatar", alt: "" });
      img.src = uploader.avatar;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      // A dead/blocked avatar must not leave a broken-image glyph in the panel.
      img.addEventListener("error", () => { try { img.remove(); } catch (e) {} });
      // Upgrade the pill's two glow colours to the pfp's own colours (AJ,
      // 2026-09-28) when the canvas is readable; otherwise the username-hash
      // default already set above stands. Async + cached.
      sampleAvatarColor(uploader.avatar).then((pair) => {
        if (!pair || !img.isConnected) return;
        row.style.setProperty("--ym-sl-pfp-accent-a", pair.a);
        row.style.setProperty("--ym-sl-pfp-accent-b", pair.b);
      });
      link.appendChild(img);
    }
    link.appendChild(h("span", { class: "ym-sl-uploader-name", text: uploader.username }));

    // If there is nowhere to go, render as plain (non-interactive) content so
    // it does not look like a dead link.
    if (!uploader.url) {
      link.removeAttribute("href");
      link.classList.add("no-link");
    }
    row.appendChild(link);
    // Stamp the current glide angle on the new pill so it doesn't flicker at
    // 0deg for one frame before the rAF catches it (especially on track
    // change, when pills are recreated).
    link.style.setProperty("--ym-sl-pfp-spin", currentSpinDeg.toFixed(2) + "deg");
    startPfpGlowEngine();
    return row;
  }

  /* ---- bus publishing -------------------------------------------------------
     Other add-ons (PiP lyrics, and anything later) must not scrape this panel's
     DOM — that is what makes cross-add-on work fragile. So publish the parsed
     data and the active index on YTMod.bus instead. Guarded, so this is a no-op
     when the host does not expose a bus. Payloads are plain data, times in ms.
  */
  /* Publish the animation machinery itself, not just the data. A consumer that
     re-implements these would drift from the panel the moment a spring or spline
     is tuned here; handing over the actual objects means the PiP window runs
     literally the same spring integrator and the same curves. The blend helpers
     read currentSettings, so the user's animation-intensity settings come along
     for free. */
  let rendererKitPublished = false;
  // `force` exists because the kit holds the SPLINE OBJECTS, and
  // applySimpleLyricsSplines() REPLACES them — a consumer would otherwise keep the
  // normal-mode curves for the whole session (the one-shot guard below made the
  // re-publish a no-op, which is why the PiP's Apple Music mode kept bouncing:
  // normal Y-offset is 0 -> -1/60 -> 0, i.e. down and BACK, while Simple is a
  // monotonic 0 -> -0.033). AJ, 2026-10-07.
  function publishRendererKit(force) {
    if (rendererKitPublished && !force) return;
    if (!window.YTMod || !window.YTMod.bus) return;
    rendererKitPublished = true;
    window.YTMod.bus.emit("lyrics:renderer", {
      Spring: Spring,
      easeSinOut: easeSinOut,
      clamp: clamp,
      splines: {
        ScaleSpline: ScaleSpline,
        LetterScaleSpline: LetterScaleSpline,
        YOffsetSpline: YOffsetSpline,
        LetterYOffsetSpline: LetterYOffsetSpline,
        GlowSpline: GlowSpline,
      },
      createLetterSprings: createLetterSprings,
      createWordSprings: createWordSprings,
      // The analytic spr spring itself, so a consumer with its own camera (the
      // PiP) can run the SAME glide the panel uses instead of its own integrator.
      Spring: Spring,
      blendSyllableAnimation: blendSyllableAnimation,
      blendVerticalAnimation: blendVerticalAnimation,
      storeNeedsAnimation: storeNeedsAnimation,
      setStyleIfChanged: setStyleIfChanged,
      // The compositor hint matters as much as the springs: without it the
      // consumer animates unpromoted and reads as low frame rate even when it is
      // stepping at full rate.
      setAnimatingHint: setAnimatingHint,
      HINT_ON: HINT_ON,
      // Player toggles the PiP also needs. These drive YTM's OWN player-bar
      // buttons (shuffle/repeat have no YTMod API), and they read the LIVE state
      // rather than any local toggle, so a consumer's buttons can never lie about
      // the real mode. Exposed instead of duplicated: the shuffle read has a
      // colour fallback and the label anchoring is subtle.
      clickPlayerButton: clickPlayerButton,
      readPlayerToggle: readPlayerToggle,
    });
    // Observable diagnostic: a consumer that cannot see this is running without
    // the springs. Check <html data-ym-lyric-renderer="kit">.
    try {
      document.documentElement.dataset.ymLyricRenderer = "kit";
    } catch (e) {}
  }

  function publishLyricLines(content) {
    if (!window.YTMod || !window.YTMod.bus) return;
    publishRendererKit(); // before the lines, so a consumer has the springs ready
    let track = null;
    try { track = typeof getCurrentTrack === "function" ? getCurrentTrack() : null; } catch (e) {}

    // One syllable -> the same shape makeWord()/makeLetterGroup() consume, so a
    // consumer can reproduce the exact markup: .word vs .letterGroup > .letter,
    // .PartOfWord, .LastWordInLine, .SpaceLetter.
    const mapWords = (syllables, lineTimed = false) => {
      const list = syllables || [];
      return list.map((w, index) => {
        const startMs = w.StartTime * 1000;
        const endMs = Math.max(startMs + 1, w.EndTime * 1000);
        let letterCapable = false;
        try {
          letterCapable =
            !lineTimed &&
            !w.DisableLetterAnimation &&
            !w.disableLetterAnimation &&
            typeof isLetterCapable === "function" &&
            isLetterCapable(w.Text, endMs - startMs);
        } catch (e) {}
        return {
          text: w.Text || "",
          startMs,
          endMs,
          letterCapable: !!letterCapable,
          isPartOfWord: !!w.IsPartOfWord,
          isLast: index === list.length - 1,
        };
      });
    };

    const lines = [];
    const mapRomaji = (syllables) => {
      if (!currentSettings.romanizationEnabled || !syllables || !syllables.length) return "";
      const plain = syllables.map((word) => word.Text || "").join("");
      const kanaOnly = plain.replace(/[\u3400-\u9FFF]/g, "");
      if (!kanaOnly.trim()) return "";
      const rom = romanize(kanaOnly);
      return rom && rom !== kanaOnly && /[A-Za-z]/.test(rom) ? rom : "";
    };
    // A line's PLAIN TEXT, with spaces between words.
    // Joining the syllables with "" is wrong: `IsPartOfWord` means "glues to the
    // NEXT syllable" (parseTTML infers it from the absence of whitespace between
    // spans — see the word-scan above), so a space belongs before every syllable
    // whose PREDECESSOR is not part of a word. The empty join produced
    // "Breadonmelikeabaker" for syllable-level lyrics (AJ, 2026-09-28), which
    // then rendered as one giant word on the share card. The panel itself never
    // showed this because it renders from `words`, not from `text` — but `text`
    // is a published bus field, so every consumer was getting the broken form.
    const syllablesToText = (syllables) => {
      const list = syllables || [];
      let out = "";
      for (let i = 0; i < list.length; i++) {
        const prev = list[i - 1];
        const prevText = prev ? (prev.Text || "") : "";
        const curText = list[i].Text || "";
        // Guard against double spaces if a source ever ships the whitespace
        // inside the syllable text itself.
        if (i > 0 && prev && !prev.IsPartOfWord && !/\s$/.test(prevText) && !/^\s/.test(curText)) {
          out += " ";
        }
        out += curText;
      }
      return out;
    };
    (content || []).forEach((line) => {
      const lead = line && line.Lead;
      if (!lead || !lead.Syllables || !lead.Syllables.length) return;
      lines.push({
        text: syllablesToText(lead.Syllables),
        startMs: lead.StartTime * 1000,
        endMs: lead.EndTime * 1000,
        lineTimed: !!line.LineTimed,
        opposite: !!line.OppositeAligned,
        romaji: mapRomaji(lead.Syllables),
        words: mapWords(lead.Syllables, !!line.LineTimed),
        // Background vocals render as their own .line.bg-line elements right
        // after the main line, with .bg-word children.
        background: (line.Background || []).map((bg) => ({
          startMs: bg.StartTime * 1000,
          endMs: bg.EndTime * 1000,
          lineTimed: !!bg.LineTimed,
          romaji: mapRomaji(bg.Syllables),
          words: mapWords(bg.Syllables, !!bg.LineTimed),
        })),
      });
    });
    window.YTMod.bus.emit("lyrics:lines", {
      trackKey: currentTrackKey || null,
      videoId: track ? track.videoId : null,
      title: track ? track.title : null,
      artist: track ? track.artist : null,
      lines,
      staticLyrics: !!staticLyricsActive,
      romanizationEnabled: currentSettings.romanizationEnabled === true,
      songwriters: currentSongwriters.slice(),
      smoothScrolling: currentSettings.smoothScrolling !== false,
      simpleLyrics: currentSettings.simpleLyrics === true,
      scrollLeadEnabled: currentSettings.scrollLeadEnabled === true,
      scrollLeadMs: Number(currentSettings.scrollLeadMs) || 0,
      attribution: {
        provider: currentProvider || "",
        uploader: currentUploader ? {
          id: currentUploader.id || "",
          username: currentUploader.username || "",
          avatar: currentUploader.avatar || "",
          url: currentUploader.url || "",
        } : null,
        maker: currentMaker ? {
          id: currentMaker.id || "",
          username: currentMaker.username || "",
          avatar: currentMaker.avatar || "",
          url: currentMaker.url || "",
        } : null,
      },
    });
    // Cheap observable diagnostic: if the bus ever stops publishing, this stays
    // stale. Inspect <html data-ym-lyric-lines="..."> to check.
    try {
      document.documentElement.dataset.ymLyricLines = String(lines.length);
      let bgRuns = 0;
      lines.forEach((l) => { bgRuns += (l.background || []).length; });
      document.documentElement.dataset.ymLyricBg = String(bgRuns);
    } catch (e) {}
  }

  function publishActiveLine(index) {
    if (!window.YTMod || !window.YTMod.bus) return;
    window.YTMod.bus.emit("lyrics:active", { trackKey: currentTrackKey || null, index });
  }

  /* The resolved sync state a consumer needs to re-derive the lyric clock itself.
     The panel shifts the lyric position by getOffsetForPosition(positionMs) every
     frame (see animate()); a consumer that reads the raw player clock — the PiP
     window, which cannot see the panel's internal offset vars — must apply the
     SAME shift or every line and word lands that offset early/late. Published on
     every change and retained by the bus, so a PiP opened mid-track replays it. */
  function publishSyncState() {
    if (!window.YTMod || !window.YTMod.bus) return;
    window.YTMod.bus.emit("lyrics:sync", {
      offsetMs: getActiveOffsetMs(),
      pauseSync: pauseSync ? { line: pauseSync.line, offset: pauseSync.offset } : null,
    });
    // Observability: confirm the sync topic is firing and what it carries, without
    // dumping the console. Inspect <html data-ym-lyric-sync="...">.
    try {
      document.documentElement.dataset.ymLyricSync =
        (pauseSync ? "pause+" : "") + formatOffset(getActiveOffsetMs());
    } catch (e) {}
  }

  function buildRendererLines(content) {
    lastRendererContent = content;
    publishLyricLines(content);
    stopScrollGlide();
    // New song -> the old song's end-of-track credits reveal must not own the
    // scroll. Its latches survive a rebuild otherwise, and a stale end-of-song
    // position in the frames around the switch re-arms it, dragging the freshly
    // recentred panel to the BOTTOM of the new song (AJ, 2026-10-02).
    cancelCreditsReveal();
    lastScrollTargetLine = -1;
    modelLines = [];
    lineElements = [];
    cachedFirstRealLyricStartMs = Infinity;
    cachedLastRealLyricEndMs = 0;
    pendingAnimationLines.clear();
    scrollCandidateIndices = [];
    manualScrollActive = false;
    if (manualScrollReturnTimer) {
      clearTimeout(manualScrollReturnTimer);
      manualScrollReturnTimer = 0;
    }
    setJumpButtonVisible(false);
    // The skeleton goes away with everything else on the next line; the token
    // bump inside hideLyricsSkeleton is the part that matters, because a paint
    // queued on rAF would otherwise land on top of the lyrics we are about to
    // build — the skeleton showing up AFTER the thing it was standing in for.
    hideLyricsSkeleton();
    linesRoot.replaceChildren();
    const scrollContainer = linesRoot.parentElement;
    const hasDuetLines = content.some((line) => line.OppositeAligned);
    if (scrollContainer) {
      scrollContainer.classList.toggle("HasDuetLines", hasDuetLines);
    }

    const addLine = (lineModel) => {
      lineModel.RenderState = null;
      modelLines.push(lineModel);
      lineElements.push(lineModel.HTMLElement);
      if (lineModel.isPrimary || lineModel.DotLine) scrollCandidateIndices.push(modelLines.length - 1);
      linesRoot.appendChild(lineModel.HTMLElement);
    };

    const firstStart = content[0] && content[0].Lead ? content[0].Lead.StartTime * 1000 : 0;
    if (firstStart >= GAP_DOTS_AFTER_SECONDS * 1000) {
      addLine(makeDotLine(0, firstStart, !!content[0].OppositeAligned));
    }

    content.forEach((contentLine, index) => {
      const lead = contentLine.Lead;
      if (!lead || !lead.Syllables || !lead.Syllables.length) return;
      cachedFirstRealLyricStartMs = Math.min(cachedFirstRealLyricStartMs, lead.StartTime * 1000);
      cachedLastRealLyricEndMs = Math.max(cachedLastRealLyricEndMs, lead.EndTime * 1000);
      // Static (unsynced) lines get the .static class so CSS can paint them at
      // full opacity / alpha-1 regardless of the per-state Sung/NotSung dim
      // (AJ, 2026-09-18).
      const lineElement = h("div", {
        class: staticLyricsActive ? "line static" : "line",
      });
      const lineModel = {
        HTMLElement: lineElement,
        StartTime: lead.StartTime * 1000,
        EndTime: lead.EndTime * 1000,
        TotalTime: (lead.EndTime - lead.StartTime) * 1000,
        Syllables: { Lead: [] },
        isPrimary: true,
        LineTimed: !!contentLine.LineTimed,
        AnimatorStore: null,
      };
      if (lineModel.LineTimed) {
        lineElement.classList.add("line-timed");
      }
      if (contentLine.OppositeAligned) {
        lineElement.classList.add("OppositeAligned");
      }
      if (isRtl(lead.Syllables.map((word) => word.Text).join(" "))) {
        lineElement.classList.add("rtl");
      }

      // A line with neither line-level sync nor real span timing is unsynced:
      // render it as a static block (no syllable/letter karaoke).
      const noKaraoke = !!(contentLine.LineTimed || !contentLine.Timed);
      appendWords(lineElement, lineModel, lead.Syllables, false, noKaraoke);
      appendRomaji(lineElement, lead.Syllables);
      lineElement.addEventListener("click", () => {
        // While picking a pause sync point a click selects, it does not seek.
        if (pausePickMode) {
          setPauseSyncLine(lineModel);
          return;
        }
        if (window.YTMod && window.YTMod.player) {
          window.YTMod.player.seek(Math.max(0, lineModel.StartTime + getOffsetForLine(lineModel.StartTime)));
        }
      });
      addLine(lineModel);

      for (const background of contentLine.Background || []) {
        if (!background.Syllables || !background.Syllables.length) continue;
        const backgroundElement = h("div", { class: "line bg-line" });
        const backgroundModel = {
          HTMLElement: backgroundElement,
          StartTime: background.StartTime * 1000,
          EndTime: background.EndTime * 1000,
          TotalTime: (background.EndTime - background.StartTime) * 1000,
          Syllables: { Lead: [] },
          isPrimary: false,
          BGLine: true,
          AnimatorStore: null,
        };
        if (isRtl(background.Syllables.map((word) => word.Text).join(" "))) {
          backgroundElement.classList.add("rtl");
        }
        if (contentLine.OppositeAligned) {
          backgroundElement.classList.add("OppositeAligned");
        }
        appendWords(backgroundElement, backgroundModel, background.Syllables, true, noKaraoke);
        appendRomaji(backgroundElement, background.Syllables);
        backgroundElement.addEventListener("click", () => {
          // Background vocals are never valid sync points, so ignore clicks in
          // pick mode rather than silently picking the wrong line.
          if (pausePickMode) return;
          if (window.YTMod && window.YTMod.player) {
            window.YTMod.player.seek(backgroundModel.StartTime);
          }
        });
        addLine(backgroundModel);
      }

      const next = content[index + 1] && content[index + 1].Lead;
      if (next) {
        const gapStart = lead.EndTime * 1000;
        const gapEnd = next.StartTime * 1000;
        if (gapEnd - gapStart >= GAP_DOTS_AFTER_SECONDS * 1000) {
          addLine(makeDotLine(
            gapStart,
            gapEnd,
            !!content[index + 1].OppositeAligned
          ));
        }
      }
    });

    // The provider counts on its own: a non-community source (apple_music,
    // spotify) has no credited people, and the provider must still be shown.
    // Unobserve the previous track's credits block before it is replaced, then
    // observe the new one so the profile-glow rAF only paints while it's on-screen.
    if (pfpGlowObserver && creditsFooterEl) pfpGlowObserver.unobserve(creditsFooterEl);
    if (currentSongwriters.length || currentProvider || currentUploader || currentMaker) {
      creditsFooterEl = buildCreditsFooter(currentSongwriters);
      linesRoot.appendChild(creditsFooterEl);
      if (pfpGlowObserver) pfpGlowObserver.observe(creditsFooterEl);
    } else {
      creditsFooterEl = null;
    }
    // A new track invalidates any in-progress credits reveal: position is about to
    // reset to ~0, so updateCreditsReveal() would clear the latches anyway, but
    // doing it here avoids a one-frame flash of the previous song parked at bottom.
    creditsRevealEngaged = false;
    creditsRevealActive = false;
    creditsRevealDismissed = false;

    // Re-apply the pause sync marker: the line elements were just rebuilt, so any
    // class on the old nodes is gone.
    markPauseSyncLine();
    lineScrollEl.classList.remove("offline");
    // Static (unsynced) lyrics begin at the top; the auto-scroll driver eases
    // from here through the song (AJ, 2026-09-18).
    if (staticLyricsActive && lineScrollEl) {
      // Instant: a reset, not a scroll the user asked to watch.
      writeScrollTop(0, true);
    }
    // The scroll position is now meaningless: the PREVIOUS song's scrollTop is
    // still in effect (the reset above is static-only) against completely
    // different line geometry. Place the camera instantly. Letting the spring
    // handle it is what made a new song glide all the way up from the last
    // song's final line.
    recentreActiveLine();
  }

  function loadLyrics(xml) {
    // A freshly imported file invalidates any pause sync point: it was measured
    // against the previous TTML's line times, so keeping it would silently
    // mis-sync. Drop it (AJ's call, 2026-09-15).
    pauseSync = null;
    pausePickMode = false;
    return loadTTML(xml, "imported");
  }

  // Only touches the paused/disabled state of the pick button. Kept separate from
  // refreshPauseSyncControl() because this runs on the 500ms housekeeping tick and
  // must not re-walk every line.
  function refreshPausePickButtonState() {
    const ui = pauseUi;
    if (!ui || !ui.pick) return;
    const paused = isPlaybackPaused();
    if (ui.pick.disabled === !paused) return;
    ui.pick.disabled = !paused;
    ui.pick.title = paused
      ? "Pick the line that plays after the pause"
      : "Pause the video first";
  }

  function escapeDownloadName(value) {
    return String(value || "lyrics")
      .replace(/[<>:"/\\|?*\x00-\x1F]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "lyrics";
  }

  function parseExportTime(value) {
    const seconds = Number(value) / 1000;
    if (!Number.isFinite(seconds)) return "0:00.000";
    const safe = Math.max(0, seconds);
    const minutes = Math.floor(safe / 60);
    const remainder = (safe - minutes * 60).toFixed(3).padStart(6, "0");
    return `${minutes}:${remainder}`;
  }

  function shiftTTMLSync(xml, offsetMs) {
    if (!offsetMs) return xml;
    return String(xml).replace(/(\b(?:begin|end|itunes:begin|itunes:end)\s*=\s*["'])([^"']+)(["'])/gi,
      (match, prefix, time, suffix) => {
        const parts = String(time || "").split(":");
        if (parts.length < 2) return match;
        const seconds = Number(parts.pop());
        const minutes = Number(parts.pop());
        const hours = parts.length ? Number(parts.pop()) : 0;
        if (![seconds, minutes, hours].every(Number.isFinite)) return match;
        const shifted = Math.max(0, (hours * 3600 + minutes * 60 + seconds) * 1000 + offsetMs);
        return `${prefix}${parseExportTime(shifted)}${suffix}`;
      });
  }

  function exportImportedTTML(withSync) {
    if (currentTTMLSource !== "imported" || !importedTTMLXml) {
      showLyricsMessage("Export is available only for imported TTML files.");
      return;
    }
    const offset = withSync ? getActiveOffsetMs() : 0;
    const output = withSync ? shiftTTMLSync(importedTTMLXml, offset) : importedTTMLXml;
    const track = getCurrentTrack();
    const title = escapeDownloadName(track && track.title ? track.title : "lyrics");
    const suffix = withSync && offset ? "-synced" : "";
    const blob = new Blob([output], { type: "application/ttml+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title}${suffix}.ttml`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function readFile(file, importMode) {
    const reader = new FileReader();
    const mode = importMode === "permanent" ? "permanent" : "temporary";
    const trackKey = currentTrackKey || getTrackKey(getCurrentTrack());
    reader.onload = async () => {
      const xml = String(reader.result || "");
      if (!loadLyrics(xml)) return;
      importedTTMLXml = xml;
      currentTTMLSource = "imported";
      setTTMLExportVisibility();

      if (activeTrackAbort) {
        activeTrackAbort.abort();
        activeTrackAbort = null;
      }
      ++trackRequestSeq;

      if (mode === "permanent") {
        manualLyricsIsPermanent = true;
        manualLyricsTrackKey = "";
        try {
          await savePermanentTTML(trackKey, xml);
        } catch (error) {
          manualLyricsIsPermanent = false;
          manualLyricsTrackKey = trackKey;
          console.warn("[SpicyLyrics] Could not save permanent TTML:", error);
        }
      } else {
        manualLyricsIsPermanent = false;
        manualLyricsTrackKey = trackKey;
      }
      refreshPermanentDeleteState();
    };
    reader.readAsText(file);
  }

  /* ===================== animation ===================== */

  // Returns true when at least one letter actually moved this frame.
  //
  // TTML is where the frame budget goes. A long word becomes one span per
  // character, each with its own three springs and five animated custom
  // properties. A ten-word line with four letter-capable words is ~40 letter
  // spans, and the original loop stepped every one of them and rebuilt its
  // style strings on every frame even when the word was long since sung and
  // every letter was sound asleep. That is roughly 200 style writes and 200
  // throwaway strings per frame — over 12,000 a second — which is exactly why
  // imported TTML runs at 30-40 FPS while line-synced LRCLIB lyrics hold ~110:
  // LRCLIB lines produce a single LineTimed word with no letter spans at all.
  //
  // A letter only needs work when its own state changed or its springs are
  // still settling. Everything else is skipped outright — no stepping, no
  // template strings, no style writes. This is visually identical, because a
  // resting letter was already producing byte-identical values every frame.
  function animateLetters(word, wordState, lineState, positionMs, deltaTime) {
    if (!word.Letters) return false;
    let activeIndex = -1;
    let activeProgress = 0;
    if (wordState === "Active") {
      for (let i = 0; i < word.Letters.length; i++) {
        const letter = word.Letters[i];
        if (getState(positionMs, letter.StartTime, letter.EndTime) === "Active") {
          activeIndex = i;
          activeProgress = getProgress(positionMs, letter.StartTime, letter.EndTime);
          break;
        }
      }
    }

    let anyAwake = false;
    const letters = word.Letters;
    for (let index = 0; index < letters.length; index++) {
      const letter = letters[index];
      if (!letter.AnimatorStore) {
        letter.AnimatorStore = createLetterSprings();
        letter.AnimatorStore.Scale.SetGoal(LetterScaleSpline.at(0), true);
        letter.AnimatorStore.YOffset.SetGoal(LetterYOffsetSpline.at(0), true);
        letter.AnimatorStore.Glow.SetGoal(GlowSpline.at(0), true);
      }

      const letterState = getState(positionMs, letter.StartTime, letter.EndTime);
      const restingScale = LetterScaleSpline.at(0);
      const restingYOffset = LetterYOffsetSpline.at(0);
      const restingGlow = GlowSpline.at(0);
      let targetScale = restingScale;
      let targetYOffset = restingYOffset;
      let targetGlow = restingGlow;
      let targetGradient = letterState === "Sung" ? 100 : -20;

      // PROXIMITY PASS. Upstream runs this over EVERY letter of an active word
      // first (LyricsAnimator.ts:1043-1090), then overrides two cases below.
      // Neighbours ride the ACTIVE LETTER's phase rather than the word's broader
      // progress, so they stay locked to the glyph being sung.
      if (activeIndex >= 0) {
        const baseScale = LetterScaleSpline.at(activeProgress);
        const baseYOffset = LetterYOffsetSpline.at(activeProgress);
        const baseGlow = GlowSpline.at(activeProgress);
        const distance = Math.abs(index - activeIndex);
        const scaleFalloff = 1 / (1 + Math.pow(distance, 2.8));
        const glowFalloff = 1 / (1 + distance * 0.9);
        targetScale = restingScale + (baseScale - restingScale) * scaleFalloff;
        targetYOffset = restingYOffset + (baseYOffset - restingYOffset) * scaleFalloff;
        targetGlow = restingGlow + (baseGlow - restingGlow) * glowFalloff;
        if (letterState === "Active" && index === activeIndex) {
          targetGradient = -20 + 120 * easeSinOut(activeProgress);
        }
      }

      // OVERRIDE PASS — upstream LyricsAnimator.ts:1092-1102, applied AFTER the
      // proximity pass and in this exact order:
      //
      //   if (letterState === "NotSung" && !simpleLyricsMode) { all three -> at(0) }
      //   else if (letterState === "Sung" && activeLetterIndex === -1) { glow -> at(0.2) }
      //
      // The NotSung clause is the one that matters, and omitting it was a real
      // bug here: the proximity pass has no direction, so it lit up the letters
      // the playhead had NOT REACHED YET exactly as hard as the ones it had just
      // left. At distance 1 the glow falloff is 1/(1+0.9) = 0.526 and the natural
      // spline peaks at 1.433, so an unsung neighbour sat at 0.754 -> (x1.125)
      // 0.848 -> a FULL-opacity 14.2px halo, and distance 2 still reached 10.9px
      // at full opacity (the 185% multiplier saturates opacity above glow 0.54).
      // Upstream pins those letters to 4px / 0% instead, so its glow TRAILS the
      // karaoke point while ours bled ~2 letters ahead of it and the word read
      // as a broad smear rather than a travelling pulse. Same for scale: ours
      // pre-bulged unsung letters to 1.072 vs upstream's flat 0.95.
      //
      // `$simpleLyricsMode` is false by default upstream (stores.ts:57), so this
      // clause is live in the default configuration — it is not an edge case.
      if (letterState === "NotSung") {
        targetScale = restingScale;
        targetYOffset = restingYOffset;
        targetGlow = restingGlow;
      } else if (letterState === "Sung" && activeIndex === -1) {
        targetScale = LetterScaleSpline.at(1);
        targetYOffset = LetterYOffsetSpline.at(1);
        // DELIBERATE DIVERGENCE FROM UPSTREAM (AJ, 2026-09-20).
        //
        // Upstream uses targetGlow = GlowSpline.at(SungLetterGlow /* 0.2 */) for
        // a sung letter in an active word where no letter is currently active
        // (i.e. the playhead sits in a gap between letters). That LOOKS like a
        // small dim value, but the natural spline OVERSHOOTS on its 0 -> 1 rise,
        // so at(0.2) actually evaluates to 1.20988 — i.e. an 18.5px blur at 224%
        // opacity via the letter multipliers (12 / 185). That is essentially the
        // same 20px white halo previously fixed here, which fused with the .85
        // gradient glyph and made whole words read fuzzy and dim next to crisp
        // neighbours. Before the spline fix this read 1.07165 / 16.86px, so the
        // corrected curve makes the upstream behaviour MORE extreme, not less.
        //
        // We keep the fix (settle to GlowSpline.at(1) = 0) rather than copying
        // upstream, because matching a known-bad artifact is not parity worth
        // having. Swapping this line to `GlowSpline.at(SungLetterGlow)` restores
        // exact upstream behaviour if it is ever wanted for A/B comparison.
        //
        // NOTE this branch is normally UNREACHABLE, because a TTML word's letter
        // spans abut: exactly one letter is Active for the whole word, so
        // activeIndex is only -1 before the first letter starts (where every
        // letter is NotSung and the clause above wins) or after the last one ends
        // (where word.EndTime == last.EndTime, so the word is no longer Active).
        targetGlow = GlowSpline.at(1);
      }

      letter.AnimatorStore.Scale.SetGoal(blendSyllableAnimation(restingScale, targetScale));
      letter.AnimatorStore.YOffset.SetGoal(blendVerticalAnimation(restingYOffset, targetYOffset));
      letter.AnimatorStore.Glow.SetGoal(blendSyllableAnimation(restingGlow, targetGlow));

      // Goals are current. If this letter's state did not change and its springs
      // are already asleep, stepping it would reproduce exactly the values that
      // are already on the element — so skip the stepping and all five writes.
      const letterStateChanged = letter.LastState !== letterState;
      letter.LastState = letterState;
      if (!letterStateChanged && !storeNeedsAnimation(letter.AnimatorStore)) continue;
      anyAwake = true;

      const scale = letter.AnimatorStore.Scale.Step(deltaTime);
      const yOffset = letter.AnimatorStore.YOffset.Step(deltaTime);
      const glow = letter.AnimatorStore.Glow.Step(deltaTime);

      setStyleIfChanged(
        letter.HTMLElement,
        "transform",
        `translate3d(0, calc(var(--DefaultLyricsSize) * ${yOffset * 2}), 0)`,
        0.001,
        yOffset * 2
      );
      setStyleIfChanged(letter.HTMLElement, "--ym-sl-base-scale", String(scale), 0.001);
      setStyleIfChanged(letter.HTMLElement, "--gradient-position", `${targetGradient}%`, 0.1);
      // Fill, colour and background-image are intentionally NOT written here.
      // Letters follow the same stylesheet rules as regular words, so a
      // letter-group word always matches its neighbours. Upstream Spicy Lyrics
      // only animates --gradient-position, scale/transform and the glow
      // variables on a letter; everything else is CSS.
      setStyleIfChanged(letter.HTMLElement, "--text-shadow-blur-radius", `${4 + 12 * glow}px`, 0.5);
      setStyleIfChanged(letter.HTMLElement, "--text-shadow-opacity", `${glow * 185}%`, 1);
    }
    return anyAwake;
  }

  /* ---- compositor hint management ------------------------------------------
     `will-change` is a promise about what is ABOUT to change, not a decoration.
     Declared permanently in CSS it forced a promoted compositor layer per element
     -- 70 lines + 571 words + every letter on one 3:28 track -- and nothing ever
     demoted them, so layer count and GPU raster memory only grew as a session ran.
     Because these elements also repaint every frame anyway (text-shadow glow,
     background-image gradient stops), the promotion bought no repaint saving
     either: worst of both worlds.

     So the hint is applied here, per element, only while its springs are awake,
     and dropped the moment it settles. In steady state a handful of elements on
     the active line carry it instead of the entire song. */
  // The hint is declared PERMANENTLY in CSS now (see the .word/.letter rule).
  // Toggling will-change per word made the background-clip:text layer churn, and
  // the clip flickers dark every time that layer changes - so this is
  // deliberately empty and setAnimatingHint() is effectively a no-op. Upstream
  // does the same (spicy-lyrics Mixed.css:37).
  const HINT_ON = "";

  function setAnimatingHint(element, animating) {
    if (!element) return;
    const want = animating ? HINT_ON : "";
    // Cheap guard: this runs on the hot path for every animating word every
    // frame, and re-writing an identical value still dirties style.
    if (element.__ymWillChange === want) return;
    element.__ymWillChange = want;
    element.style.willChange = want;
  }

  // Called when a line leaves pendingAnimationLines, i.e. every spring on it has
  // slept. Without this the hint set during animation would never be released and
  // we would be back to a permanent promotion, just reached the slow way.
  function releaseLineAnimationHints(line) {
    // Drop the LINE-level compositor hint FIRST, and before the words guard: the
    // class is what actually promotes the layers now, so it has to come off even
    // when the line has no lead words.
    if (line && line.HTMLElement) line.HTMLElement.classList.remove("ym-sl-animating");
    const words = line && line.Syllables && line.Syllables.Lead;
    if (!words) return;
    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      setAnimatingHint(word.HTMLElement, false);
      const letters = word.Letters;
      if (!letters) continue;
      for (let letterIndex = 0; letterIndex < letters.length; letterIndex++) {
        setAnimatingHint(letters[letterIndex].HTMLElement, false);
      }
    }
  }

  /* ---- Simple lyrics (Apple Music style) ------------------------------------
     The gradient sweep is a CSS animation, so the JS only has to START it. This
     runs on WORD STATE CHANGE ONLY — never per frame. That is the entire point of
     the mode: the normal path rewrites --gradient-position for every word 60-170
     times a second, and this replaces all of it with one style write per word per
     state change.
     Ported from upstream's Simple Lyrics Mode (LyricsAnimator.ts). Upstream's
     Pre_ head-start animation on the FOLLOWING word is deliberately not ported —
     the sweep already starts from the keyframe's own -27.5%, which reads fine, and
     it would add a setTimeout per word for a detail nobody asked for. */
  function animateWord(word, lineState, positionMs, deltaTime) {
    const state = getState(positionMs, word.StartTime, word.EndTime);
    const progress = getProgress(positionMs, word.StartTime, word.EndTime);
    const stateChanged = word.LastState !== state;
    word.LastState = state;
    if (stateChanged) {
      word.HTMLElement.classList.toggle("WordNotSung", state === "NotSung");
      word.HTMLElement.classList.toggle("WordSung", state === "Sung");
    }

    // No real per-word sync: show the line as a static block that lights up when
    // active/sung instead of running syllable/letter karaoke springs — the
    // dominant per-frame cost on partially-synced TTML imports (AJ, 2026-09-17).
    if (word.NoKaraoke) {
      const lit = state !== "NotSung";
      setStyleIfChanged(word.HTMLElement, "--gradient-position", lit ? "100%" : "-20%", 0.1);
      setStyleIfChanged(word.HTMLElement, "--ym-sl-base-scale", "1", 0.001);
      setStyleIfChanged(word.HTMLElement, "transform", "translateY(0)", 0.001);
      setStyleIfChanged(word.HTMLElement, "--text-shadow-blur-radius", "4px", 0.5);
      setStyleIfChanged(word.HTMLElement, "--text-shadow-opacity", "0%", 1);
      setAnimatingHint(word.HTMLElement, false);
      return;
    }

    if (word.Dot) {
      if (!word.AnimatorStore) {
        word.AnimatorStore = createDotSprings();
        word.AnimatorStore.Scale.SetGoal(DotScaleSpline.at(0), true);
        word.AnimatorStore.YOffset.SetGoal(DotYOffsetSpline.at(0), true);
        word.AnimatorStore.Glow.SetGoal(DotGlowSpline.at(0), true);
        word.AnimatorStore.Opacity.SetGoal(DotOpacitySpline.at(0), true);
      }
      const targetScale = blendAnimation(
        DotScaleSpline.at(0),
        DotScaleSpline.at(state === "Active" ? progress : state === "Sung" ? 1 : 0)
      );
      const targetYOffset = blendAnimation(
        DotYOffsetSpline.at(0),
        DotYOffsetSpline.at(state === "Active" ? progress : state === "Sung" ? 1 : 0)
      );
      const targetGlow = blendAnimation(
        DotGlowSpline.at(0),
        DotGlowSpline.at(state === "Active" ? progress : state === "Sung" ? 1 : 0)
      );
      const targetOpacity = DotOpacitySpline.at(state === "Active" ? progress : state === "Sung" ? 1 : 0);
      word.AnimatorStore.Scale.SetGoal(targetScale);
      word.AnimatorStore.YOffset.SetGoal(targetYOffset);
      word.AnimatorStore.Glow.SetGoal(targetGlow);
      word.AnimatorStore.Opacity.SetGoal(targetOpacity);
      if (!stateChanged && !storeNeedsAnimation(word.AnimatorStore)) {
        setAnimatingHint(word.HTMLElement, false);
        return;
      }
      setAnimatingHint(word.HTMLElement, true);
      const scale = word.AnimatorStore.Scale.Step(deltaTime);
      const yOffset = word.AnimatorStore.YOffset.Step(deltaTime);
      const glow = word.AnimatorStore.Glow.Step(deltaTime);
      const opacity = word.AnimatorStore.Opacity.Step(deltaTime);
      setStyleIfChanged(word.HTMLElement, "transform", `translate3d(0, calc(var(--DefaultLyricsSize) * ${yOffset}), 0)`, 0.001, yOffset);
      setStyleIfChanged(word.HTMLElement, "--ym-sl-base-scale", String(scale), 0.001);
      setStyleIfChanged(word.HTMLElement, "opacity", String(opacity), 0.001);
      setStyleIfChanged(word.HTMLElement, "--text-shadow-blur-radius", `${4 + 6 * glow}px`, 0.5);
      setStyleIfChanged(word.HTMLElement, "--text-shadow-opacity", `${glow * 90}%`, 1);
      return;
    }

    if (!word.AnimatorStore) {
      word.AnimatorStore = createWordSprings(word);
      word.AnimatorStore.Scale.SetGoal(word.LineTimed ? 1 : ScaleSpline.at(0), true);
      word.AnimatorStore.YOffset.SetGoal(word.LineTimed ? 0 : YOffsetSpline.at(0), true);
      word.AnimatorStore.Glow.SetGoal(GlowSpline.at(0), true);
    }
    const target = state === "Active" ? progress : state === "Sung" ? 1 : 0;
    const targetScale = word.LineTimed
      ? 1
      : blendSyllableAnimation(ScaleSpline.at(0), ScaleSpline.at(target));
    const targetYOffset = word.LineTimed
      ? 0
      : blendVerticalAnimation(YOffsetSpline.at(0), YOffsetSpline.at(target));
    word.AnimatorStore.Scale.SetGoal(targetScale);
    word.AnimatorStore.YOffset.SetGoal(targetYOffset);
    word.AnimatorStore.Glow.SetGoal(blendSyllableAnimation(GlowSpline.at(0), GlowSpline.at(target)));

    // A letter can only be moving while its word is active (or has just changed
    // state), so a word that is already at rest can skip the letter pass
    // entirely instead of walking dozens of spans.
    // Simple lyrics stubs the Scale/Glow springs, so `storeNeedsAnimation` reports
    // false the moment they "settle" — but the word's gradient sweep still needs a
    // per-frame write while the word is being sung. Keep Active words awake in
    // this mode, or the gradient freezes at its state-flip value: that was the
    // "flash of fill at the line end, then dim" AJ saw (2026-10-02). In normal
    // mode the glow spring chases a progress-driven goal and never sleeps during
    // a line, which is what kept these writes flowing before the stubs existed.
    const selfAwake =
      stateChanged ||
      storeNeedsAnimation(word.AnimatorStore) ||
      (currentSettings.simpleLyrics && state === "Active");
    let lettersAwake = false;
    if (word.LetterGroup && (state === "Active" || selfAwake)) {
      lettersAwake = animateLetters(word, state, lineState, positionMs, deltaTime);
    }
    // Nothing on this word or any of its letters changed: skip the spring steps
    // and every style write. Rebuilding those strings for dozens of resting
    // letter spans every frame was the single largest TTML cost.
    if (!selfAwake && !lettersAwake) {
      setAnimatingHint(word.HTMLElement, false);
      return;
    }
    setAnimatingHint(word.HTMLElement, true);

    const scale = word.AnimatorStore.Scale.Step(deltaTime);
    const yOffset = word.AnimatorStore.YOffset.Step(deltaTime);
    const glow = word.AnimatorStore.Glow.Step(deltaTime);
    const gradient = state === "Sung" ? 100 : state === "Active" ? -20 + 120 * progress : -20;

    setStyleIfChanged(word.HTMLElement, "transform", `translate3d(0, calc(var(--DefaultLyricsSize) * ${yOffset}), 0)`, 0.001, yOffset);
    setStyleIfChanged(word.HTMLElement, "--ym-sl-base-scale", String(scale), 0.001);
    if (word.LetterGroup) {
      // The wrapper must stay inert: no gradient of its own (a wrapper gradient
      // double/ghosts the active letters). Two constraints that caused the
      // "long words are dim" bug:
      //  1. Never set the wrapper's -webkit-text-fill-color to "transparent" —
      //     with background-clip:text on the wrapper it clips the child letters
      //     to the empty wrapper box and long words vanish. "inherit" is safe.
      //  2. Never set `text-shadow: none` on the wrapper. text-shadow is
      //     INHERITED, and the line's NotSung/Sung glow is what actually paints
      //     the glyphs (the fill is transparent). Clearing it on the wrapper
      //     stops that glow reaching the letters, so letter-group words lose a
      //     whole paint layer that regular words keep and render dimmer.
      setStyleIfChanged(word.HTMLElement, "background-image", "none");
      setStyleIfChanged(word.HTMLElement, "-webkit-text-fill-color", "inherit");
      setStyleIfChanged(word.HTMLElement, "color", "inherit");
    } else {
      setStyleIfChanged(word.HTMLElement, "--gradient-position", `${gradient}%`, 0.1);
      // A LINE-TIMED word's glow IS the line-fill highlight, and at the shared 35x
      // multiplier it read too faint next to the letter glow's 185x. AJ asked for
      // a little more (2026-10-02): 50x peaks near 50% opacity at the glow's
      // natural peak of 1.0. Background-vocal words (word.BGWord) get 70x plus a
      // wider radius, because the bg line no longer dims its glow via a <1 line
      // opacity — so the glow now has to read as bright/white on its own (AJ,
      // 2026-10-02 late: "the glow isnt bright or white still"). The letter-group
      // bg path already peaks at 100% white at L12473.
      const glowMultiplier = word.BGWord ? 60 : (word.LineTimed ? 50 : 35);
      // Line-timed words get a slightly wider glow to match the boosted opacity
      // (AJ, 2026-10-02: "up the radius a little bit").
      setStyleIfChanged(
        word.HTMLElement,
        "--text-shadow-blur-radius",
        `${word.BGWord ? 4 + 4 * glow : (word.LineTimed ? 4 + 3 * glow : 4 + 2 * glow)}px`,
        0.5
      );
      setStyleIfChanged(word.HTMLElement, "--text-shadow-opacity", `${Math.min(glow * glowMultiplier, 100)}%`, 1);
    }
  }

  // Hot path: called for every candidate line on every animation frame, so it
  // must not allocate. The previous Object.values(store).some(...) built a fresh
  // array plus a closure per word (and per letter) per frame — thousands of
  // short-lived allocations every second. That is steady garbage, and it is the
  // mechanism behind "the longer the session runs, the lower the FPS": minor GCs
  // get more frequent as the heap fills, so frame pacing degrades over time even
  // though the per-song workload is identical. Direct property reads allocate
  // nothing. Spring stores have a fixed known shape (see create*Springs).
  function storeNeedsAnimation(store) {
    if (!store) return false;
    if (store.Scale && !store.Scale.CanSleep()) return true;
    if (store.YOffset && !store.YOffset.CanSleep()) return true;
    if (store.Glow && !store.Glow.CanSleep()) return true;
    if (store.Opacity && !store.Opacity.CanSleep()) return true;
    return false;
  }

  function wordNeedsAnimation(word) {
    if (storeNeedsAnimation(word.AnimatorStore)) return true;
    const letters = word.Letters;
    if (!letters) return false;
    for (let index = 0; index < letters.length; index++) {
      if (storeNeedsAnimation(letters[index].AnimatorStore)) return true;
    }
    return false;
  }

  const ADAPTIVE_MIN_GAP_PX = 1.5;

  function resetLineAdaptiveSpacing(line) {
    if (!line.Syllables || !line.Syllables.Lead) return;
    line.Syllables.Lead.forEach((word) => {
      if (!word.HTMLElement) return;
      setStyleIfChanged(word.HTMLElement, "--ym-sl-adaptive-scale", "1", 0.001);
      if (word.HTMLElement.parentElement &&
        word.HTMLElement.parentElement.classList.contains("word-group")) {
        setStyleIfChanged(
          word.HTMLElement.parentElement,
          "--ym-sl-adaptive-scale",
          "1",
          0.001
        );
      }
    });
    line.AdaptiveSpacingApplied = false;
  }

  function resetAdaptiveSpacing() {
    modelLines.forEach(resetLineAdaptiveSpacing);
  }

  function applyAdaptiveSpacing(activeIndex, force) {
    if (!currentSettings.adaptiveSpacing) return;
    // Apple Music style lyrics skips the shrink pass entirely: its words rest at
    // a static 0.95 scale, and this pass's inward pull read as "some rows are
    // shifted to the right" on wrapped word-by-word lines (AJ, 2026-10-02). The
    // reset is cheap per frame -- setStyleIfChanged's cache makes it a no-op
    // once everything is back at 1 -- and it guarantees nothing stays
    // half-squeezed from before the toggle was flipped.
    if (currentSettings.simpleLyrics) {
      resetAdaptiveSpacing();
      return;
    }
    // Only recompute on a meaningful layout change (active-line change). The
    // geometry reads below force a synchronous layout flush (getComputedStyle +
    // offset*). Running that on a timer every frame was a constant reflow and a
    // major source of per-frame jank — the measured word geometry only changes
    // when the active line moves, so gating on `force` removes the reflow
    // without changing the spacing result.
    if (!force) return;

    const measuredLines = [];
    modelLines.forEach((line, index) => {
      const relevant =
        !line.DotLine &&
        line.HTMLElement.isConnected &&
        (line.RenderState === "Active" ||
          (activeIndex >= 0 && Math.abs(index - activeIndex) <= 3) ||
          (activeIndex < 0 && line.AdaptiveSpacingApplied));
      if (!relevant) {
        if (line.AdaptiveSpacingApplied) resetLineAdaptiveSpacing(line);
        return;
      }

      const units = [];
      const seenGroups = new Set();
      for (const word of line.Syllables && line.Syllables.Lead || []) {
        const element = word.HTMLElement;
        if (!element || !element.isConnected) continue;
        const group = element.parentElement &&
          element.parentElement.classList.contains("word-group")
          ? element.parentElement
          : null;
        if (group) {
          if (seenGroups.has(group)) continue;
          seenGroups.add(group);
          units.push({ element: group });
        } else if (!word.IsPartOfWord && !word.Dot) {
          units.push({ element });
        }
      }
      units.forEach((unit) => {
        const element = unit.element;
        unit.rect = {
          left: element.offsetLeft,
          right: element.offsetLeft + element.offsetWidth,
          top: element.offsetTop,
          height: element.offsetHeight,
          width: element.offsetWidth,
        };
      });
      const measuredUnits = units
        .filter(({ rect }) => rect.width > 0 && rect.height > 0)
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

      const scaleTargets = new Map(measuredUnits.map(({ element }) => [element, 1]));
      const fontSize = parseFloat(getComputedStyle(line.HTMLElement).fontSize) || 20;
      const minimumGap = Math.max(ADAPTIVE_MIN_GAP_PX, Math.min(4, fontSize * 0.08));

      for (let i = 1; i < measuredUnits.length; i++) {
        const previous = measuredUnits[i - 1];
        const current = measuredUnits[i];
        const rowTolerance = Math.max(
          4,
          Math.min(previous.rect.height, current.rect.height) * 0.55
        );
        const sameRow =
          Math.abs(
            previous.rect.top + previous.rect.height / 2 -
            (current.rect.top + current.rect.height / 2)
          ) <= rowTolerance;
        if (!sameRow) continue;

        const gap = current.rect.left - previous.rect.right;
        const pressure = minimumGap - gap;
        if (pressure <= 0) continue;

        const width = Math.max(1, previous.rect.width + current.rect.width);
        const shrink = clamp(1 - (pressure / width) * 0.7, 0.95, 1);
        scaleTargets.set(
          previous.element,
          Math.min(scaleTargets.get(previous.element), shrink)
        );
        scaleTargets.set(
          current.element,
          Math.min(scaleTargets.get(current.element), shrink)
        );
      }

      measuredLines.push({ line, scaleTargets });
      line.AdaptiveSpacingApplied = true;
    });

    // Read all geometry before writing styles so the pass does not alternate
    // layout reads and writes for each neighboring lyric unit.
    measuredLines.forEach(({ scaleTargets }) => {
      scaleTargets.forEach((scale, element) => {
        setStyleIfChanged(element, "--ym-sl-adaptive-scale", String(scale), 0.001);
      });
    });
  }

  // Which line is playing at `positionMs`, over the scroll-candidate lines.
  // -1 during a gap between lines (an instrumental break), which callers must
  // treat as "no line", not as "line 0".
  //
  // ⭐⭐ THIS IS A LINEAR SCAN ON PURPOSE. It used to be a binary search, which
  // is only valid when the windows are SORTED **AND DISJOINT** — and they are
  // not disjoint. A lead line is widened to cover its background vocals (see the
  // x-bg block in parseTTML), and a background vocal routinely runs PAST the end
  // of its lead, so the widened lead reaches into the NEXT line's window
  // (measured: 494 ms of overlap on a real file). Under overlap the comparison
  // stops being monotonic across the array, so the search walks straight past a
  // line that genuinely covers `positionMs` and returns -1 — "no line is
  // playing", which drops every line to its NotSung/Sung opacity and dims the
  // whole panel. That is the reported "line blinks / flashes dark". It can also
  // return the PREVIOUS line, so the highlight lags by the overlap and then
  // jumps.
  //
  // The candidates were also only sorted by StartTime BY ACCIDENT: the renderer
  // pushes them in document order and never sorts. So the old search depended on
  // two properties it was never given — a latent bug that the lead widening
  // simply made reachable on ordinary files.
  //
  // Cost: one integer comparison per candidate, at most twice per frame,
  // allocating nothing. A few hundred comparisons a frame is not measurable
  // beside the per-word style writes this feeds.
  //
  // Last match wins, so when two windows overlap the line that started most
  // recently is the active one.
  //
  // Guard: .workbuddy-ai/scratch/test-line-lookup-overlap.mjs drives THIS
  // function, sliced out of this file, over the windows the shipped parser
  // produces — plus a synthetic overlap and a clamped-disjoint control.
  function findLineIndexAt(positionMs) {
    let found = -1;
    for (let index = 0; index < scrollCandidateIndices.length; index++) {
      const candidateIndex = scrollCandidateIndices[index];
      const candidate = modelLines[candidateIndex];
      if (positionMs >= candidate.StartTime && positionMs < candidate.EndTime) {
        found = candidateIndex;
      }
    }
    return found;
  }

  function lineNeedsAnimation(line) {
    if (!line.Syllables || !line.Syllables.Lead) return false;
    const words = line.Syllables.Lead;
    for (let index = 0; index < words.length; index++) {
      if (wordNeedsAnimation(words[index])) return true;
    }
    return false;
  }

  function animate(positionMs) {
    if (!panelVisible || !modelLines.length) return;
    // Defensive twin of the tick() guard: no non-finite playhead may reach the
    // animators, whatever the caller. Without this, NaN propagates into
    // --gradient-position as "NaN%" and blanks the clipped background for a
    // frame. See the long note in tick().
    if (!Number.isFinite(positionMs)) return;
    // NOTE: the AMLL engine is driven by its own loop (amllStartOwnLoop in
    // 22-amll-integration), not from here. animate() gates on
    // panelVisible/modelLines, and when that gate closes the engine stops being
    // fed entirely - which froze the karaoke fill and parked the word
    // animations. Do not add an amllDrive() call back here.
    const now = performance.now();
    const deltaTime = Math.min(0.05, Math.max(0.001, (now - lastFrameTime) / 1000));
    lastFrameTime = now;

    // Static (unsynced) lyrics: slowly and smoothly auto-scroll so the panel
    // tracks playback — top at song start, bottom at song end. Paused while the
    // user scrolls manually (AJ, 2026-09-18).
    if (staticLyricsActive && !autoScrollUserPaused && lineScrollEl) {
      driveStaticAutoScroll(positionMs);
      setJumpButtonVisible(false);
    }

    // Pick the active per-track offset slot (video vs. song) based on what is
    // actually playing, then shift the lyric clock without moving the player.
    recomputeActiveOffsetMode(false);
    // Math.max(0, NaN) is NaN, NOT 0 - so a non-finite sync offset would poison
    // the whole frame exactly like a non-finite playhead. Fall back to the
    // un-offset playhead rather than propagating NaN into --gradient-position.
    const offsetForPosition = getOffsetForPosition(positionMs);
    const lyricPositionMs = Number.isFinite(offsetForPosition)
      ? Math.max(0, positionMs - offsetForPosition)
      : positionMs;
    const activeIndex = findLineIndexAt(lyricPositionMs);

    updateFullscreenGapDimming(lyricPositionMs, activeIndex);

    const activeLineChanged = activeIndex !== lastActiveLine;
    if (activeLineChanged) {
      lastActiveLine = activeIndex;
      publishActiveLine(activeIndex);
    }

    // Scroll target, which is NOT the same question as "which line is active".
    //
    // Early scroll evaluates the line index at a position `scrollLeadMs` in the
    // FUTURE, so the panel is already gliding before the line starts and arrives
    // as it begins, instead of starting to move once it is already being sung.
    // This shifts ONLY the scroll target: `activeIndex` above — and therefore
    // every highlight, gradient fill and karaoke animation — still follows the
    // real playback position, so the words never light up early.
    // (Upstream Spicy Lyrics does the same with ProcessedPosition =
    // Position + PositionOffset, and is explicit that Status follows the real
    // position.)
    // While the panel is docked in the NPV's compact lyrics box, look-ahead
    // centering pushes the ACTIVE line into the top quarter (only ~4 lines fit,
    // so the box reads top-heavy with a dead band below). Center the active
    // line there instead; the tall Lyrics tab keeps its normal look-ahead.
    // Simple lyrics (Apple Music / AMLL style): drop the look-ahead so the active
    // line centres exactly as it starts playing, like AMLL, instead of gliding in
    // early. Normal mode keeps its lead.
    const scrollLeadMs = (!externalHostActive && currentSettings.scrollLeadEnabled && !currentSettings.simpleLyrics)
      ? currentSettings.scrollLeadMs
      : 0;
    const scrollIndex = scrollLeadMs > 0
      ? findLineIndexAt(lyricPositionMs + scrollLeadMs)
      : activeIndex;
    // Gated on the target changing rather than on the active line changing: with
    // a lead these differ, and this keeps scrollActiveLineIntoView — which reads
    // layout via getBoundingClientRect — off the per-frame path.
    //
    // The recentre window is the deliberate exception. It runs for a few hundred
    // ms after a structural change, because the layout is still moving under us
    // (the fullscreen lyrics column is CSS-transitioned) and a single placement
    // would be correct for one frame only. It also outranks the lead-line target:
    // while the panel is being re-placed we want the line the user is HEARING,
    // not the one early scroll is aiming at.
    // QOL #1: when a synced track reaches its final line, the credits reveal owns
    // the scroll target (gliding to the bottom). While it is active, skip the
    // normal line-follow retarget so the two do not fight.
    const creditsReveal = updateCreditsReveal(positionMs, activeIndex, lyricPositionMs);
    if (creditsReveal) {
      // credits reveal owns the scroll target this frame
    } else if (recentreUntilMs > now) {
      recentreActiveLineNow();
      lastScrollTargetLine = lastActiveLine;
    } else if (scrollIndex !== lastScrollTargetLine) {
      lastScrollTargetLine = scrollIndex;
      if (scrollIndex >= 0 && lineElements[scrollIndex]) {
        scrollActiveLineIntoView(lineElements[scrollIndex]);
      }
    }

    // If the user has scrolled away but the line that is now playing is already
    // on screen, treat that as "caught up" and drop the jump button without
    // requiring a click. The 8s idle return (manualScrollReturnTimer) covers the
    // case where they scrolled to a different line and stopped.
    if (manualScrollActive && isActiveLineInView()) {
      manualScrollActive = false;
      setJumpButtonVisible(false);
      if (manualScrollReturnTimer) {
        clearTimeout(manualScrollReturnTimer);
        manualScrollReturnTimer = 0;
      }
    }

    for (let index = 0; index < modelLines.length; index++) {
      const line = modelLines[index];
      const lineState = getState(lyricPositionMs, line.StartTime, line.EndTime);
      const stateChanged = line.RenderState !== lineState;
      if (stateChanged) {
        line.RenderState = lineState;
        // Static (unsynced) lines keep the .static CSS state so they stay bright
        // and never get the per-state opacity/alpha overrides (AJ, 2026-09-18).
        if (!staticLyricsActive) {
          line.HTMLElement.classList.toggle("Active", lineState === "Active");
          line.HTMLElement.classList.toggle("NotSung", lineState === "NotSung");
          line.HTMLElement.classList.toggle("Sung", lineState === "Sung");
        }
      }
      if (line.DotLine) {
        // MUST use lyricPositionMs, not the raw positionMs. Everything else in
        // this loop measures against the offset-adjusted clock
        // (lyricPositionMs = positionMs - offset), so using the raw position
        // here made the dots bounce out and vanish at a time that ignored the
        // sync offset - early or late by exactly the offset, while the pause
        // itself was still running (AJ, 2026-09-28).
        const nearEnd = lyricPositionMs > line.EndTime - PRE_HIDDEN_DOT_LINE_MS;
        const playing = lineState === "Active" && !nearEnd;
        line.HTMLElement.classList.toggle("playing", playing);
        if (playing) {
          line.HTMLElement.classList.remove("bounce-out");
        } else if (nearEnd && lineState === "Active") {
          line.HTMLElement.classList.add("bounce-out");
        }
      }

      // Keep an entering line's previous blur radius while its unsung halo fades
      // into the active word glow. Zeroing it on this frame caused a visible
      // dim-then-bright dip on both lead and background vocals. Other lines still
      // update when the active line changes; gaps preserve their last value.
      if (activeLineChanged && activeIndex >= 0) {
        const distance = Math.abs(index - activeIndex);
        if (currentSettings.simpleLyrics && !line.HTMLElement.classList.contains("bg-line")) {
          // AMLL depth: the active line is full and scaled up, neighbours fade and
          // recede with distance so the panel reads as a stack of lines flowing
          // past, not flat text scrolling. Injected inline so it overrides the
          // state-class alpha only while Simple Lyrics is on; cleared on toggle-off
          // (see clearSimpleLyricsDepth in 04-state-settings.jsfrag). Background
          // vocals keep their own dimming.
          const depthAlpha = distance === 0 ? 1 : Math.max(0.3, 1 - distance * 0.22);
          const depthScale = distance === 0 ? 1.04 : Math.max(0.94, 1 - distance * 0.015);
          setStyleIfChanged(line.HTMLElement, "--ym-sl-line-alpha", String(depthAlpha), 0.02);
          setStyleIfChanged(line.HTMLElement, "--amll-depth-scale", String(depthScale), 0.01);
        } else if (lineState !== "Active") {
          const blur = distance === 0
            ? 0
            : Math.min(distance * 1.25, 1.25 * 5 + 1.25 * 0.465);
          setStyleIfChanged(line.HTMLElement, "--BlurAmount", `${blur}px`, 0.25);
        }
      }

      // Scan only lines that can actually be moving: the active line, a line
      // whose state just changed, or a line already known to still be settling.
      // A resting neighbour is never woken by proximity — a line only starts
      // moving when its OWN state flips, at which point `stateChanged` is true
      // and it enters `pendingAnimationLines` until its springs sleep. The old
      // +/-6 window forced a full word/letter spring scan across 13 lines on
      // every frame for no benefit, and that scan (not the animation) was the
      // dominant per-frame cost.
      const shouldInspectAnimation =
        stateChanged ||
        lineState === "Active" ||
        pendingAnimationLines.has(line);
      const pendingAnimation = shouldInspectAnimation && lineNeedsAnimation(line);
      // Only run the per-word/letter animation for the actively-playing line,
      // lines whose state just changed, or lines whose springs are still
      // settling. Previously this also ran for every line within ±4 of the
      // active one on EVERY frame, which is the bulk of the per-frame cost and
      // the source of the "laggier the longer the song plays" jank. Resting
      // neighbours need no per-frame work — their classes were set when their
      // state changed and their springs have already slept.
      //
      // `pendingAnimation` must apply to EVERY line, including background-vocal
      // lines and the imported-TTML fullscreen path. Two earlier guards dropped
      // it: (1) the fsImportedPerformance branch animated only on
      // `stateChanged || Active`, and (2) background lines were capped at
      // `stateChanged || Active`. Both meant that the instant a line flipped
      // Active -> Sung its springs were never stepped again, so words froze
      // mid-motion with scale/glow stuck at their active values. This is cheap:
      // a resting line's springs are asleep, so `pendingAnimation` is false and
      // it costs nothing per frame — settling is a short, bounded window.
      const shouldAnimateLine =
        lineState === "Active" || stateChanged || pendingAnimation;
      if (line.Syllables && line.Syllables.Lead && shouldAnimateLine) {
        // Imported TTML can contain hundreds of timed words and letter spans.
        // In fullscreen, keep the active primary line and state transitions,
        // but do not repeatedly walk every background-vocal syllable/spring.
        const leadWords = line.Syllables.Lead;
        for (let wordIndex = 0; wordIndex < leadWords.length; wordIndex++) {
          animateWord(leadWords[wordIndex], lineState, lyricPositionMs, deltaTime);
        }
      }
      // Membership in `pendingAnimationLines` means "this line may be holding
      // compositor hints". It is keyed on `shouldAnimateLine`, NOT on
      // `pendingAnimation`, and it deliberately sits OUTSIDE the branch above:
      // a LineTimed line sets every spring goal instantly, so lineNeedsAnimation
      // is never true for it and `pendingAnimation` would never add it — which
      // left hints set by animateWord with no path to release them.
      if (shouldAnimateLine) {
        pendingAnimationLines.add(line);
        // Word transforms still use the short-lived hint; line brightness is
        // painted in the gradient and no longer needs an opacity layer.
        if (line.HTMLElement) line.HTMLElement.classList.add("ym-sl-animating");
      } else if (pendingAnimationLines.delete(line)) {
        // The line has settled: release the compositor hints set while it was
        // animating, so its words are not left permanently promoted.
        releaseLineAnimationHints(line);
      }
    }

    applyAdaptiveSpacing(activeIndex, activeLineChanged);
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    // Before any early return, so an in-flight glide always lands.
    stepScrollGlide();
    if (!window.YTMod || !window.YTMod.player) return;
    const position = window.YTMod.player.getPositionMs();
    // Number.isFinite, NOT "!= null". A media element's currentTime reports NaN
    // in transient states (seeking, metadata not loaded yet, track change), and
    // NaN != null is TRUE - so the old guard let NaN straight through. A single
    // NaN frame poisons the whole render:
    //   getState(NaN, ...)    -> every comparison against NaN is false, so it
    //                            answers "Active" for EVERY word, and
    //   getProgress(NaN, ...) -> falls through to clamp(NaN) = NaN, so
    //   gradient = -20 + 120 * NaN = NaN
    // and the word is written "--gradient-position: NaN%". A custom property
    // accepts ANY token, so that stores without complaint - but it makes
    // calc(NaN% + 20% + 0%) invalid, which invalidates the entire
    // background-image declaration. The glyph is painted ONLY by that clipped
    // background (-webkit-text-fill-color is transparent), so it goes fully
    // transparent for one frame: the black flicker. It lands hardest on the
    // active line and on bg words because those have their text-shadow faded to
    // 0, leaving nothing to cover the hole. Skipping the frame is the fix; the
    // springs simply advance on the next good frame. (AJ: "some lines just
    // flicker black for a very very short time".)
    if (Number.isFinite(position)) animate(position);
  }

  // Track + offset housekeeping used to run inside tick(), so two document-wide
  // querySelectorAll passes per second executed in the same rAF callback as the
  // animation and competed with it for the frame budget -- any slowdown surfaced
  // as panel stutter while the rest of the page stayed smooth. None of it needs
  // frame accuracy, so it runs on its own timer and leaves the frame loop alone.
  const HOUSEKEEPING_MS = 500;
  let housekeepingTimer = 0;
  /* ---- music-video off-sync notice -----------------------------------------
     Official lyric timings do not match a music video's edit (cold opens, cut
     verses, re-ordered choruses), so when a player video is live the lyrics are
     likely desynced through no fault of the sync data. A pill at the top of the
     panel says so (AJ, 2026-10-02): "Music video lyrics may be out of sync",
     with a DISPLAYED 5-second timer bar, then it fades out and is removed.
     Latched on the video ELEMENT so it shows once per video, not once per
     housekeeping pass. Absolutely positioned, pointer-events:none, so it never
     shifts the measured lyric layout or blocks a line. */
  const MV_SYNC_NOTICE_MS = 5000;
  const MV_SYNC_FADE_MS = 450;
  let mvSyncChip = null;
  let mvSyncChipVideo = null;
  let mvSyncChipFadeTimer = 0;
  let mvSyncChipRemoveTimer = 0;

  function removeMvSyncChip() {
    if (mvSyncChip) { mvSyncChip.remove(); mvSyncChip = null; }
  }

  /* Source warning chip — same component as the music-video one above, used
     when the lyrics came from a source whose timing is machine-aligned rather
     than hand-synced (lrc.red). Reusing .ym-sl-mv-sync-chip keeps one visual
     language and inherits the shrinking timer bar for free (AJ, 2026-10-19). */
  let sourceChip = null;
  let sourceChipFadeTimer = 0;
  let sourceChipRemoveTimer = 0;
  const SOURCE_NOTICE_MS = 6500;
  const SOURCE_FADE_MS = 450;

  function removeSourceChip() {
    if (sourceChip) { sourceChip.remove(); sourceChip = null; }
  }

  function showSourceNotice(text) {
    if (!panelEl || !text) return;
    if (sourceChipFadeTimer) { clearTimeout(sourceChipFadeTimer); sourceChipFadeTimer = 0; }
    if (sourceChipRemoveTimer) { clearTimeout(sourceChipRemoveTimer); sourceChipRemoveTimer = 0; }
    removeSourceChip();
    sourceChip = h("div", { class: "ym-sl-mv-sync-chip ym-sl-source-chip" },
      h("span", { text }),
      h("span", { class: "ym-sl-mv-sync-chip-timer" })
    );
    panelEl.appendChild(sourceChip);
    sourceChipFadeTimer = setTimeout(() => {
      sourceChipFadeTimer = 0;
      if (!sourceChip) return;
      sourceChip.classList.add("ym-sl-fading");
      sourceChipRemoveTimer = setTimeout(() => {
        sourceChipRemoveTimer = 0;
        removeSourceChip();
      }, SOURCE_FADE_MS);
    }, SOURCE_NOTICE_MS);
  }

  function syncMvSyncNotice() {
    if (!panelEl) return;
    const video = findPlayerVideo();
    if (!video) {
      // No video: nothing to warn about. Clear the latch so a LATER video
      // re-triggers the notice.
      mvSyncChipVideo = null;
      if (mvSyncChipFadeTimer) { clearTimeout(mvSyncChipFadeTimer); mvSyncChipFadeTimer = 0; }
      if (mvSyncChipRemoveTimer) { clearTimeout(mvSyncChipRemoveTimer); mvSyncChipRemoveTimer = 0; }
      removeMvSyncChip();
      return;
    }
    if (mvSyncChip || mvSyncChipVideo === video) return;
    mvSyncChipVideo = video;
    mvSyncChip = h("div", { class: "ym-sl-mv-sync-chip" },
      h("span", { text: "Music video lyrics may be out of sync" }),
      h("span", { class: "ym-sl-mv-sync-chip-timer" })
    );
    panelEl.appendChild(mvSyncChip);
    // The shrinking bar IS the displayed timer (CSS animation, 5s linear); this
    // timeout only triggers the fade at the end of it.
    mvSyncChipFadeTimer = setTimeout(() => {
      mvSyncChipFadeTimer = 0;
      if (!mvSyncChip) return;
      mvSyncChip.classList.add("ym-sl-fading");
      mvSyncChipRemoveTimer = setTimeout(() => {
        mvSyncChipRemoveTimer = 0;
        removeMvSyncChip();
      }, MV_SYNC_FADE_MS);
    }, MV_SYNC_NOTICE_MS);
  }

  function housekeeping() {
    if (!window.YTMod || !window.YTMod.player) return;
    // The media element is cached for the 60fps position read; re-resolve it here
    // so a track change can never leave a stale element in the cache for longer
    // than one housekeeping pass.
    if (typeof window.YTMod.player.refreshMedia === "function") {
      window.YTMod.player.refreshMedia();
    }
    refreshVideoOffsetControl();
    refreshPausePickButtonState();
    syncMvSyncNotice();
    syncTrackLyrics();
  }
  function startHousekeeping() {
    if (!housekeepingTimer) {
      housekeepingTimer = window.setInterval(housekeeping, HOUSEKEEPING_MS);
    }
  }
  function stopHousekeeping() {
    if (housekeepingTimer) {
      clearInterval(housekeepingTimer);
      housekeepingTimer = 0;
    }
  }

  function startTick() {
    if (!raf) {
      lastFrameTime = performance.now();
      tick();
    }
    startHousekeeping();
  }

  /* ===================== lifecycle ===================== */

  // Named so it can be detached. Every enable injects a NEW <script>, which runs
  // this whole IIFE again; without detaching, each disabled instance keeps a live
  // window listener forever, so repeated toggles stack up closures that all react
  // to every ytmod-ext message.
  let messageListenerAttached = false;

  // Re-run the resolver for whatever track is playing right now. syncTrackLyrics()
  // early-returns when the key is unchanged, so we clear currentTrackKey first to
  // force it past that guard. Used when the lyrics SOURCE ORDER changes: the cached
  // result came from the old priority, so we want a fresh resolve under the new one
  // (AJ, 2026-10-19).
  function reresolveCurrentTrackLyrics() {
    const track = getCurrentTrack();
    if (!track) return;
    const key = getTrackKey(track);
    if (!key) return;
    currentTrackKey = "";
    try { syncTrackLyrics(true); } catch (e) {
      console.warn("[Aurora Lyrics] re-resolve after source-order change failed:", e);
    }
  }

  function handleHostMessage(event) {
    const data = event.data;
    if (!data) return;
    // Aurora Bloom (ytmod-dynamic) owns a couple of settings that actually
    // drive things drawn HERE — the MV blurred-backdrop brightness slider and
    // the "prefer Kawarp for music videos" toggle. So accept Bloom's settings
    // payload too and pull out just those keys; everything else in it belongs
    // to the page-wide Kawarp, not to us. applySettings() re-clamps for free.
    if (data.type === "ytmod-settings" && data.id === "ytmod-dynamic") {
      const s = data.settings || {};
      const patch = {};
      if (s.backdropBrightness != null) patch.backdropBrightness = s.backdropBrightness;
      if (s.preferKawarpAlways != null) patch.preferKawarpAlways = s.preferKawarpAlways;
      if (Object.keys(patch).length) {
        applySettings(patch);
        // The Kawarp-vs-canvas choice can change live, so re-decide the
        // backdrop now instead of waiting for the 2s refresh tick.
        if (patch.preferKawarpAlways != null) applyStaticVideoBackdrop();
      }
      return;
    }
    if (data.id !== EXT_ID) return;
    if (data.type === "ytmod-settings") {
      // A source-order change means the cached lyrics came from the OLD priority,
      // so re-resolve the current track once under the new order. The panel only
      // posts settings on close (see content.js pendingOrderPost), so this fires
      // at most once per edit session, never on every drag nudge (AJ, 2026-10-19).
      const prevOrder = Array.isArray(currentSettings.sourceOrder)
        ? currentSettings.sourceOrder.join(",") : "";
      const nextOrder = data.settings && Array.isArray(data.settings.sourceOrder)
        ? data.settings.sourceOrder.join(",") : prevOrder;
      applySettings(data.settings);
      if (nextOrder !== prevOrder) reresolveCurrentTrackLyrics();
      return;
    }
    if (data.type !== "ytmod-ext") return;
    if (data.action === "disable") teardown();
  }

  function attachMessageListener() {
    if (messageListenerAttached) return;
    window.addEventListener("message", handleHostMessage);
    messageListenerAttached = true;
  }
  function detachMessageListener() {
    if (!messageListenerAttached) return;
    window.removeEventListener("message", handleHostMessage);
    messageListenerAttached = false;
  }
  attachMessageListener();

  function teardown() {
    exitFullscreenMode();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    stopHousekeeping();
    stopScrollGlide();
    if (mountTabTimer) clearTimeout(mountTabTimer);
    mountTabTimer = 0;
    if (wpObserver) wpObserver.disconnect();
    wpObserver = null;
    if (tabWatchRaf) cancelAnimationFrame(tabWatchRaf);
    tabWatchRaf = 0;
    if (activeTrackAbort) activeTrackAbort.abort();
    activeTrackAbort = null;
    cachedFirstRealLyricStartMs = Infinity;
    cachedLastRealLyricEndMs = 0;
    pendingAnimationLines.clear();
    syncNativePanel(false);
    cleanupTabBar(tabBar);
    if (panelEl) panelEl.remove();
    const optsOverlay = document.querySelector(".ym-sl-options-overlay");
    if (optsOverlay) optsOverlay.remove();
    const style = document.getElementById("ym-sl-style");
    if (style) style.remove();
    if (fontLinkEl) fontLinkEl.remove();
    fontLinkEl = null;
    modelLines = [];
    lineElements = [];
    scrollCandidateIndices = [];
    lrclibCache.clear();
    // The Spicy Lyrics cache lives in chrome.storage, so it outlives teardown.
    // Only the in-memory mirror and its pending writes are page-lifetime state:
    // flush anything queued, then drop the mirror so the next enable re-reads.
    flushSpicyCache();
    if (spicyCacheFlushTimer) {
      clearTimeout(spicyCacheFlushTimer);
      spicyCacheFlushTimer = 0;
    }
    spicyCache = null;
    spicyCacheLoad = null;
    spicyCacheDirty = false;
    // Track-identity state must be cleared as well. Re-enabling injects a fresh
    // <script>, so normally this starts clean anyway — but if any of it survived
    // into the next run, syncTrackLyrics would bail at the `key === currentTrackKey`
    // check and the panel would sit empty until the user changed songs. Clearing
    // here guarantees disable -> re-enable reloads lyrics for the current track.
    currentTrackKey = "";
    manualLyricsTrackKey = "";
    manualLyricsIsPermanent = false;
    currentLyricsIsTTML = false;
    lastObservedTrackKey = "";
    lastObservedPositionMs = null;
    lastActiveLine = -1;
    if (manualScrollReturnTimer) {
      clearTimeout(manualScrollReturnTimer);
      manualScrollReturnTimer = 0;
    }
    currentSongwriters = [];
    panelVisible = false;
    panelHost = null;
    tabBar = null;
    pauseSync = null;
    pausePickMode = false;
    pauseUi = null;
    pauseBanner = null;
    pauseBannerText = null;
    panelEl = null;
    tabEl = null;
    tabMountParent = null;
    jumpButton = null;
    detachMessageListener();
  }

  /* ===================== AMLL (Apple-Music-style) renderer =====================
   * Simple lyrics mode renders through the REAL @applemusic-like-lyrics engine
   * (DomLyricPlayer), bundled into src/extensions/amll-core.js. We do NOT
   * re-implement the look — we import the upstream player, adapt Aurora's parsed
   * lyrics into its LyricLine[] model (seconds -> ms), force the SpicyLyrics font
   * on the host, and drive it every frame. That makes the scroll physics, spring
   * motion, per-word emphasis (>1s words) and the karaoke mask byte-for-byte the
   * engine's own behaviour, exactly like the AMLL preview.
   *
   * Any failure (engine import error, bad lyrics, drive exception) flips a flag
   * and falls back to Aurora's built-in glow-free Simple renderer, so the mode
   * can never break. The fallback Simple CSS already carries `text-shadow:none`
   * so there is no whole-line glow either way.
   */

  let amllActive = false;             // user intent: Simple lyrics is ON
  let amllReady = false;              // engine imported + player built
  let amllFailed = false;             // engine failed once -> stay on Aurora
  let amllPlayer = null;              // LyricPlayer instance
  let amllHost = null;                // #ym-sl-amll-host container
  let amllEnginePromise = null;       // cached dynamic-import promise
  let amllLastContent = null;         // last parsed lyrics (to re-sync on activate)
  let amllLastPositionMs = 0;
  let amllPrevTime = 0;
  let amllWasPlaying = false;
  let amllCssInjected = false;
  let amllLastFrameTime = 0;
  let amllLastDumpTime = 0;
  let amllDriveCount = 0;
  let amllDumpCount = 0;
  let amllEnableError = null;
  let amllGen = 0;                     // invalidates in-flight activations on toggle
  let amllDriveErrors = 0;             // consecutive update() failures; 0 = healthy

  const AMLL_ENGINE_CSS = `.amll-lyric-player {
  width: 100%;
  max-width: 100%;
  height: 100%;
  color: var(--amll-lp-color, white);
  contain: strict;
  mix-blend-mode: plus-lighter;
  font-size: var(--amll-lp-font-size, max(max(5vh, 2.5vw), 12px));
  overflow: hidden;

  @media screen and (width <= 768px) {
    font-size: var(--amll-lp-font-size, max(8vw, 12px));
  }

  &.dom {
    --amll-lp-line-width-aspect: .8;
    --amll-lp-line-padding-x: 1em;
    --amll-lp-bg-line-scale: .7;
    user-select: none;
    box-sizing: content-box;
    z-index: 1;
    line-height: 1.2;
  }
}

@media screen and (width <= 768px) {
  .amll-lyric-player {
    --amll-lp-line-width-aspect: 1;
    --amll-lp-line-padding-x: 0;
  }
}
@property --bright-mask-alpha {
  syntax: "<number>";
  inherits: true;
  initial-value: 1;
}

@property --dark-mask-alpha {
  syntax: "<number>";
  inherits: true;
  initial-value: .2;
}

.FmKaba_lyricLineWrapper {
  box-sizing: border-box;
  width: 100%;
  padding: .4em var(--lyric-line-padding-x);
  will-change: transform;
  border-radius: .25em;
  flex-direction: column;
  align-items: flex-start;
  gap: .3em;
  transition: opacity .4s, filter .4s, background-color .25s;
  display: flex;
  position: absolute;
  top: 0;
  left: 0;

  &:not(.FmKaba_bottomLineWrapper):hover {
    background-color: var(--amll-lp-hover-bg-color, #fff1);
  }

  &:not(.FmKaba_bottomLineWrapper):active {
    background-color: var(--amll-lp-hover-bg-color, #ffffff05);
  }
}

.FmKaba_lyricLine {
  box-sizing: border-box;
  width: var(--amll-lp-width, 100%);
  min-width: var(--amll-lp-width, 100%);
  max-width: var(--amll-lp-width, 100%);
  contain: layout style paint;
  content-visibility: auto;
  contain-intrinsic-size: auto 40px;
  backface-visibility: hidden;
  transform-origin: 0;
  --mask-alpha-duration: .45s;
  --bright-mask-alpha: .2;
  --dark-mask-alpha: .2;
  height: fit-content;
  transition: box-shadow .25s,
		--bright-mask-alpha var(--mask-alpha-duration) ease-out,
		--dark-mask-alpha var(--mask-alpha-duration) ease-out;
  margin: -.2em;
  padding: .2em;
  position: relative;

  &.FmKaba_gradientMask {
    --mask-alpha-duration: .3s;
    --bright-mask-alpha: 1;
    --dark-mask-alpha: .4;
  }
}

.FmKaba_lyricDuetLine {
  text-align: right;
  transform-origin: 100%;
}

.FmKaba_lyricMainLine {
  contain: layout style;
  margin: -1em;
  padding: 1em;
  transition: opacity .3s .1s;

  & span {
    text-align: start;
    vertical-align: bottom;
    display: inline-block;
  }

  & .FmKaba_romanWord {
    padding-inline-end: .3em;
    font-size: .5em;
    line-height: 1em;
    display: flex;
  }

  & .FmKaba_rubyWord {
    justify-content: center;
    min-height: 1em;
    font-size: .5em;
    line-height: 1em;
    display: flex;
  }

  & .FmKaba_wordWithRuby {
    vertical-align: bottom;
    flex-direction: column;
    align-items: center;
    display: inline-flex;
  }

  & .FmKaba_wordBody {
    flex-direction: column;
    display: flex;
  }

  & .FmKaba_rubyBaseWord {
    white-space: nowrap;
    flex-wrap: nowrap;
    justify-content: center;
    display: inline-flex;
  }

  & > span, & span.FmKaba_emphasizeWrapper {
    white-space: pre-wrap;
    vertical-align: bottom;
    contain: layout style;
    margin: -1em;
    padding: 1em;
    display: inline-block;

    & > span {
      margin: -1em;
      padding: 1em;
    }

    &.FmKaba_emphasize, & span.FmKaba_emphasize {
      backface-visibility: hidden;

      & > span {
        backface-visibility: hidden;
        margin: -1em;
        padding: 1em;
      }
    }
  }
}

.FmKaba_lyricBgLine {
  opacity: .4;
  font-size: max(calc(1em * var(--amll-lp-bg-line-scale, .7)), 10px);
  transition: background-color .25s,
		box-shadow .25s,
		--bright-mask-alpha var(--mask-alpha-duration) ease-out,
		--dark-mask-alpha var(--mask-alpha-duration) ease-out;

  & .FmKaba_lyricMainLine {
    padding: 1.2em 1em;
  }

  &.FmKaba_active {
    opacity: .4;
    transition: background-color .25s,
			box-shadow .25s,
			--bright-mask-alpha var(--mask-alpha-duration) ease-out,
			--dark-mask-alpha var(--mask-alpha-duration) ease-out;
  }
}

.FmKaba_lyricSubLine {
  opacity: .3;
  font-size: max(.5em, 10px);
  line-height: 1.5em;
  transition: opacity .2s .25s;

  @supports (mix-blend-mode: plus-lighter) {
    opacity: .3;
  }
}

.FmKaba_bottomLine {
  font-size: var(--amll-lp-bottom-line-font-size, max(.7em, 10px));
  cursor: default;
  opacity: .2;
  padding-top: 0;
  padding-bottom: 0;
  line-height: 1.8em;
  transition: opacity .4s;

  &.FmKaba_gradientMask {
    opacity: .85;
  }

  &:empty {
    height: 0;
    margin: 0;
    padding: 0;
    display: none;
  }
}

.FmKaba_bgWrapper {
  top: 100%;
  left: var(--lyric-line-padding-x);
  z-index: -1;
  align-items: inherit;
  width: calc(100% - var(--lyric-line-padding-x) * 2);
  visibility: visible;
  pointer-events: auto;
  opacity: 0;
  transform-origin: 0 0;
  flex-direction: column;
  transition: opacity .3s;
  display: flex;
  position: absolute;
}

.FmKaba_bgWrapperTop {
  transform-origin: 0 100%;
  width: 100%;
  position: relative;
  top: auto;
  bottom: auto;
  left: 0;
}

.FmKaba_bgWrapperActive {
  opacity: 1;
  width: 100%;
  position: relative;
  top: auto;
  bottom: auto;
  left: 0;
}

.FmKaba_bgWrapperHidden {
  visibility: hidden;
  pointer-events: none;
}

.FmKaba_interludeDots {
  width: fit-content;
  height: clamp(.5em, 1vh, 3em);
  padding: .4em var(--lyric-line-padding-x);
  transform-origin: center;
  align-items: center;
  gap: .18em;
  display: flex;
  position: absolute;
  left: 0;

  & > * {
    background-color: var(--amll-lp-color, white);
    aspect-ratio: 1;
    border-radius: 50%;
    width: .3em;
    height: .3em;
    display: inline-block;
  }
}

.FmKaba_disableSpring > *, .FmKaba_disableSpring .FmKaba_lyricLine {
  transition: filter .25s, transform .5s, background-color .25s, box-shadow .25s;
}

.FmKaba_tmpDisableTransition {
  transition: none !important;
}

.amll-lyric-player {
  --lyric-line-padding-x: 1em;
  touch-action: pan-x;

  @media screen and (width <= 500px) {
    --lyric-line-padding-x: 20px;
  }

  &:hover .FmKaba_lyricLine, &:hover .FmKaba_lyricLineWrapper {
    filter: unset !important;
  }

  &:not(.FmKaba_playing) .FmKaba_bgWrapper {
    opacity: 1;
    width: 100%;
    position: relative;
    top: auto;
    bottom: auto;
    left: 0;
  }

  &.FmKaba_hasDuetLine {
    & .FmKaba_lyricLine:not(.FmKaba_lyricDuetLine) {
      padding-right: 15%;
    }

    & .FmKaba_lyricDuetLine {
      padding-left: 15%;
    }

    & .FmKaba_isDuetWrapper {
      align-items: flex-end;

      & .FmKaba_bgWrapper {
        transform-origin: 100% 0;
      }

      & .FmKaba_bgWrapperTop {
        transform-origin: 100% 100%;
      }
    }
  }
}
`;

  // Host + fallback rules layered on top of the engine stylesheet. The engine's
  // own CSS has NO text-shadow glow; the only "bloom" is the intended Apple
  // Music karaoke bright layer (mix-blend-mode: plus-lighter), which we keep.
  const AMLL_HOST_CSS = `
#ym-sl-amll-host {
  position: absolute;
  inset: 0;
  z-index: 4;
  overflow: hidden;
  pointer-events: auto;
  font-family: "SpicyLyrics", "Noto Sans Georgian", "Vazirmatn", "Roboto", system-ui, sans-serif;
  /* 700 = LyricsBold.woff2 — the same weight the built-in renderer uses for
     lyric lines, so Simple lyrics doesn't look lighter than the other modes. */
  font-weight: 700;
  /* The bundled face stops at 700 (LyricsBold), which is as heavy as the real
     font goes. To get a chunkier karaoke look without a faux-bold fudge, stroke
     the glyphs by a fraction of a pixel. -webkit-text-stroke is inherited, so
     every word element gets it, and the engine's mask clips the stroke exactly
     like the fill. */
  -webkit-text-stroke: var(--amll-bold-stroke, 0.6px) currentColor;
  color: var(--amll-lp-color, #fff);
  line-height: 1.2;
  /* Written every frame by the engine on the CalcMaskAnimator path. Seed it so
     the clamp() in each word's mask-position always evaluates - an unset var
     would make the whole declaration invalid and the word would render at full
     brightness before the first frame. */
  --amll-player-time: 0;
}
#ym-sl-amll-host .amll-lyric-player { pointer-events: auto; height: 100%; }
/* Make the lyrics area the positioning context so the host fills it. */
.LyricsContainer { position: relative; }
/* When AMLL owns the panel, hide Aurora's own (glow-free) Simple lines. */
body.amll-active #ym-sl-panel.SpicyRenderer .VirtualLyricsContainer { display: none !important; }
#ym-sl-amll-host { visibility: hidden; pointer-events: none; }
body.amll-active #ym-sl-amll-host { visibility: visible; pointer-events: auto; }
`;

  function amllInjectCss() {
    if (amllCssInjected) return;
    const style = document.createElement("style");
    style.id = "ym-sl-amll-css";
    style.textContent = AMLL_ENGINE_CSS + "\n" + AMLL_HOST_CSS;
    (document.head || document.documentElement).appendChild(style);
    amllCssInjected = true;
  }

  function amllLyricsContainer() {
    if (!panelEl) return null;
    return panelEl.querySelector(".LyricsContainer") || panelEl;
  }

  function amllShow() {
    if (!amllPlayer || !amllHost) return;
    const c = amllLyricsContainer();
    if (c && amllHost.parentNode !== c) c.appendChild(amllHost);
    document.body.classList.add("amll-active");
  }

  function amllHide() {
    document.body.classList.remove("amll-active");
  }

  function amllEnsureEngine() {
    if (amllEnginePromise) return amllEnginePromise;
    amllEnginePromise = (async () => {
      // NOTE: never write `typeof import` here — `import` is an always-reserved
      // keyword, so the parser treats it as the start of an import declaration /
      // dynamic-import call and throws "Cannot use import statement outside a
      // module", killing the WHOLE classic-script bundle (panel included).
      //
      // Use AMLL_CORE_URL (resolved from document.currentScript.src), NOT
      // chrome.runtime.getURL: this bundle runs in the page's MAIN world where
      // chrome.runtime is undefined, so getURL() throws "extension URL
      // unavailable" and the engine silently falls back to the built-in
      // renderer — which looks like "same as before, just without the glow".
      if (!AMLL_CORE_URL) throw new Error("AMLL: module URL unavailable");
      const mod = await import(/* @vite-ignore */ AMLL_CORE_URL);
      if (!mod || typeof mod.LyricPlayer !== "function") {
        throw new Error("AMLL: LyricPlayer export missing");
      }
      return mod;
    })();
    return amllEnginePromise;
  }

  async function amllActivate() {
    if (amllActive) { amllShow(); return; }
    amllActive = true;
    if (amllFailed) { amllActive = false; return; }
    const myGen = ++amllGen;
    try {
      amllInjectCss();
      const mod = await amllEnsureEngine();
      if (myGen !== amllGen) return;          // toggled off during import
      // The panel may not be mounted yet on the very first settings apply; wait
      // briefly (bounded) for the lyrics container to appear.
      let container = amllLyricsContainer();
      let tries = 0;
      while (!container && tries < 25) {
        await new Promise((r) => setTimeout(r, 200));
        if (myGen !== amllGen) return;
        container = amllLyricsContainer();
        tries++;
      }
      if (!container) { amllActive = false; return; }
      if (myGen !== amllGen) return;          // toggled off while waiting

      amllHost = document.createElement("div");
      amllHost.id = "ym-sl-amll-host";
      container.appendChild(amllHost);

      const player = new mod.LyricPlayer();
      // Force the engine's CalcMaskAnimator path (a CSS clamp() that reads
      // --amll-player-time, which update() rewrites EVERY frame) instead of
      // WebMaskAnimator (per-word Web Animations keyframes).
      //
      // The WAAPI path only re-plays a line's animation at the moment that line
      // becomes active, and it decides whether to play from the engine's own
      // isPlaying flag. When that flag is ever stale the animation stays paused
      // at a fixed mask-position and the word never fills - the mask sits far
      // enough left that the whole word renders at the 0.4 "dim" alpha, which
      // looks exactly like "no left-to-right fill" even though the mask is
      // correct. The calc path has no such dependency: mask-position is
      // recomputed from the current time on every frame, so the sweep tracks
      // playback no matter what the play-state plumbing does.
      player.supportMaskImage = false;
      player.setEnableSpring(true);
      player.setWordFadeWidth(0.5);          // Apple Music for iPad karaoke width
      player.setAlignPosition(0.35);          // focal line sits 35% down (matches AMLL)
      player.getElement().style.height = "100%";
      amllHost.appendChild(player.getElement());
      // amllPlayer must be assigned BEFORE the size seed: amllSeedEngineSize()
      // bails on a missing player, so seeding first was a silent no-op.
      amllPlayer = player;
      amllGuardEngineSize();
      amllSeedEngineSize();

      amllReady = true;
      // Take over driving the engine from Aurora's render loop, which gates on
      // panelVisible/modelLines and stops feeding us when that gate closes.
      amllStartOwnLoop();
      // Show BEFORE handing it lyrics: the engine measures every word with
      // clientWidth when setLyricLines() runs, and a display:none host (or one
      // still hidden) measures 0 for all of them. A zero width degenerates the
      // karaoke mask gradient, so the text renders fully lit with no
      // left-to-right sweep — the "no fill" bug.
      amllShow();
      player.resume();

      if (amllLastContent) amllSyncLyrics(amllLastContent);
    } catch (e) {
      console.warn("[AuroraLyrics] AMLL engine failed to load; using built-in Simple renderer.", e);
      amllFailed = true;
      // Leave the built-in renderer visible: amllActive drives the body class
      // that HIDES .VirtualLyricsContainer, so it must be cleared on failure or
      // the fallback would render into a hidden node.
      amllActive = false;
      amllReady = false;
      amllHide();
      if (amllHost && amllHost.parentNode) amllHost.parentNode.removeChild(amllHost);
      amllHost = null;
      amllPlayer = null;
    }
  }

  function amllDeactivate() {
    // Always clear the failure latch and the cached import promise, so switching
    // the mode back on retries. This must happen BEFORE the early return below:
    // after a failed activation amllActive/amllReady are both false, and the
    // early return would otherwise leave the latch stuck for the whole session.
    amllFailed = false;
    amllEnginePromise = null;
    amllDriveErrors = 0;
    if (!amllActive && !amllReady) return;
    amllGen++;                               // invalidate any in-flight activation
    amllActive = false;
    amllHide();
    try { if (amllPlayer) amllPlayer.dispose(); } catch (e) {}
    amllPlayer = null;
    amllReady = false;
    amllWasPlaying = false;
    amllPrevTime = 0;
    amllStopOwnLoop();
    if (amllSizeObserver) { try { amllSizeObserver.disconnect(); } catch (e) {} amllSizeObserver = null; }
    amllSizeSeeded = false;
    if (amllHost && amllHost.parentNode) amllHost.parentNode.removeChild(amllHost);
    amllHost = null;
  }

  // AMLL treats whitespace as its own word atom. chunkAndSplitLyricWords()
  // groups every run of consecutive non-space atoms into ONE word element, so a
  // words array with no spaces collapses the entire line into a single element
  // whose text is the syllables concatenated ("everywordlookslikethis") — and
  // the karaoke mask then sweeps the line as a whole instead of word by word.
  // Aurora's TTML syllables carry no whitespace (it lives between the <span>s),
  // so rebuild the space atoms here.
  const AMLL_CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;
  function amllWordAtoms(syllables) {
    const atoms = [];
    const list = Array.isArray(syllables) ? syllables : [];
    // Prefer HasSpaceBefore (measured from the actual markup between the two
    // <span>s). Fall back to IsPartOfWord only when the source never recorded
    // spacing at all (line-synced LRC), where it is the best signal available.
    const spacingKnown = list.some((s) => s && s.HasSpaceBefore === true);
    for (let i = 0; i < list.length; i++) {
      const syl = list[i];
      const text = syl && syl.Text != null ? String(syl.Text) : "";
      if (!text) continue;
      const start = (syl.StartTime || 0) * 1000;
      const end = (syl.EndTime || 0) * 1000;
      atoms.push({ word: text, startTime: start, endTime: end });
      // Decide whether a space belongs AFTER this syllable.
      let spaceAfter;
      if (spacingKnown) {
        // The next syllable tells us: if it had whitespace before it, there is
        // a gap here. "digni"+"fied" has no space before "fied" -> one word.
        const nextSyl = list[i + 1];
        spaceAfter = !!(nextSyl && nextSyl.HasSpaceBefore === true);
      } else {
        // No spacing metadata: a space goes after a word that isn't continued.
        const nextSyl = list[i + 1];
        spaceAfter = !!nextSyl && !nextSyl.IsPartOfWord;
      }
      if (!spaceAfter) continue;
      const nextText = list[i + 1] && list[i + 1].Text != null ? String(list[i + 1].Text) : "";
      if (!nextText) continue;
      if (/\s$/.test(text) || /^\s/.test(nextText)) continue;
      if (AMLL_CJK_RE.test(text) || AMLL_CJK_RE.test(nextText)) continue;
      atoms.push({ word: " ", startTime: end, endTime: end });
    }
    return atoms;
  }

  // Aurora's parsed line model -> AMLL LyricLine[]. Times are in SECONDS in
  // Aurora's model; AMLL wants MILLISECONDS.
  function amllLinesFromContent(content) {
    const out = [];
    if (!Array.isArray(content)) return out;
    for (const line of content) {
      const lead = line && line.Lead;
      if (!lead) continue;
      const words = amllWordAtoms(lead.Syllables);
      out.push({
        words,
        translatedLyric: "",
        romanLyric: "",
        startTime: (lead.StartTime || 0) * 1000,
        endTime: (lead.EndTime || 0) * 1000,
        isBG: false,
        isDuet: !!line.OppositeAligned,
      });
      const bgs = line.Background || [];
      for (const bg of bgs) {
        const bgWords = amllWordAtoms(bg.Syllables);
        out.push({
          words: bgWords,
          translatedLyric: "",
          romanLyric: "",
          startTime: (bg.StartTime || 0) * 1000,
          endTime: (bg.EndTime || 0) * 1000,
          isBG: true,
          isDuet: false,
        });
      }
    }
    return out;
  }

  function amllContentIsTimed(content) {
    if (!Array.isArray(content)) return false;
    for (const line of content) {
      const lead = line && line.Lead;
      if (lead && (lead.EndTime > 0 || (lead.Syllables || []).some((s) => s && s.EndTime > 0))) {
        return true;
      }
    }
    return false;
  }

  // TEMPORARY diagnostic. Mirrors the converted LyricLine[] onto the host as
  // data-debug so the live word timings can be read from the page without a
  // JS console. Remove once the animation issue is pinned down.
  function amllDumpDebug(lines) {
    amllDumpCount++;
    try {
      const active = lines.findIndex((l) => !l.isBG && (l.endTime - l.startTime) > 0);
      const slice = (lines || []).slice(0, 4).map((l) => ({
        s: Math.round(l.startTime),
        e: Math.round(l.endTime),
        bg: !!l.isBG,
        w: l.words.map((x) => [x.word, Math.round(x.startTime), Math.round(x.endTime)]),
      }));
      // What the ENGINE currently holds: for every lyric group,
      // [isActive, lineStart, lineEnd, builtWordCount, floatAnimationCount],
      // plus the engine's own current time. This is the only way to tell "the
      // words were never built" from "the animations were built but parked".
      let eng = null;
      try {
        const groups = amllPlayer.currentLyricGroups || [];
        eng = {
          n: groups.length,
          t: Math.round(amllPlayer.getCurrentTime()),
          g: groups.slice(0, 14).map((x) => {
            let act = false, s = null, e = null, nw = 0, na = 0;
            try { act = !!x.isActive; } catch (e2) {}
            try { const l = x.mainLine.getLine(); s = Math.round(l.startTime); e = Math.round(l.endTime); } catch (e2) {}
            try { nw = (x.mainLine.splittedWords || []).length; } catch (e2) {}
            try { na = (x.mainLine.splittedWords || []).reduce((n, w) => n + ((w.elementAnimations || []).length), 0); } catch (e2) {}
            return [act, s, e, nw, na];
          }),
        };
      } catch (e) { eng = { error: String(e) }; }
      if (amllHost) {
        amllHost.dataset.debug = JSON.stringify({
          active,
          drives: amllDriveCount,
          dumps: amllDumpCount,
          playing: amllPlayer ? amllPlayer.getIsPlaying() : null,
          spring: amllPlayer ? amllPlayer.getEnableSpring() : null,
          seeded: amllSizeSeeded,
          measured: amllMeasured,
          size: amllPlayer && amllPlayer.size ? [amllPlayer.size[0], amllPlayer.size[1]] : null,
          hostConnected: !!(amllHost && amllHost.isConnected),
          hostRect: amllHost ? (() => { const r = amllHost.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })() : null,
          playerTimeCss: (amllPlayer && amllPlayer.element && amllPlayer.element.style)
            ? amllPlayer.element.style.getPropertyValue("--amll-player-time") : null,
          eng,
          enableError: amllEnableError,
          lines: slice,
        });
      }
    } catch (e) {}
  }

  function amllSyncLyrics(content) {
    amllLastContent = content;
    if (!amllActive || !amllReady || !amllPlayer) return;
    try {
      const lines = amllLinesFromContent(content);
      // Untimed / plain lyrics: the engine can't place them on a timeline, so
      // fall back to Aurora's own (glow-free) Simple render for this content.
      if (!lines.length || !amllContentIsTimed(content)) {
        amllHide();
        return;
      }
      amllPlayer.setLyricLines(lines, amllLastPositionMs || 0);
      amllShow();
      amllDumpDebug(lines);
    } catch (e) {
      console.warn("[AuroraLyrics] AMLL setLyricLines failed; falling back.", e);
      amllFailed = true;
      amllHide();
    }
  }

  // The engine derives its virtual viewport from a ResizeObserver it attaches to
  // its own element inside the constructor - i.e. while that element is still
  // detached - so the first callback reports 0x0 and, as observed live, nothing
  // ever corrects it. A zero viewport is worse than it sounds:
  //   defaultLineHeight = size[1] / 5        -> 0
  //   isInRenderRange() bails on viewportHeight <= 0
  //   => commitChanges() returns early for EVERY line
  //   => no transform, no scale, no opacity is ever written
  // The panel still draws and the karaoke fill still sweeps (both are written
  // from show()/update(), not commitChanges), which is exactly why it looks
  // "rendered but lifeless". Seed the size from the host we actually control and
  // keep it in sync ourselves instead of trusting that observer.
  let amllSizeObserver = null;
  let amllSizeSeeded = false;
  let amllMeasured = [0, 0];
  // The host is inset:0 inside .LyricsContainer, so the container's box IS the
  // host's box. Walking up also covers the moment of activation, when the panel
  // has not been laid out yet and the host itself still measures 0x0.
  function amllMeasureHost() {
    let el = amllHost;
    while (el && el !== document.body) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { amllMeasured = [r.width, r.height]; return r; }
      el = el.parentElement;
    }
    return null;
  }
  // Wrap player.size so a write of 0 is ignored. The engine's own ResizeObserver
  // reports 0x0 the first time (it observes its still-detached root element), and
  // once the viewport is zero the engine never recovers on its own. With this
  // guard a real viewport, once known, can never be lost again.
  function amllGuardEngineSize() {
    try {
      const guarded = [0, 0];
      let w = 0;
      let h = 0;
      Object.defineProperty(guarded, "0", {
        get() { return w; },
        set(v) { if (v > 0) w = v; },
        enumerable: true,
        configurable: true,
      });
      Object.defineProperty(guarded, "1", {
        get() { return h; },
        set(v) { if (v > 0) h = v; },
        enumerable: true,
        configurable: true,
      });
      amllPlayer.size = guarded;
    } catch (e) {}
  }
  function amllSeedEngineSize() {
    if (!amllPlayer || !amllHost) return false;
    const rect = amllMeasureHost();
    if (rect) {
      amllPlayer.size[0] = rect.width;
      amllPlayer.size[1] = rect.height;
      amllSizeSeeded = true;
    }
    if (amllSizeObserver) { try { amllSizeObserver.disconnect(); } catch (e) {} }
    amllSizeObserver = new ResizeObserver((entries) => {
      if (!amllPlayer) return;
      const last = entries[entries.length - 1];
      if (!last) return;
      const w = last.contentRect.width;
      const h = last.contentRect.height;
      if (w <= 0 || h <= 0) return;
      if (amllPlayer.size[0] === w && amllPlayer.size[1] === h) return;
      amllPlayer.size[0] = w;
      amllPlayer.size[1] = h;
      amllSizeSeeded = true;
      // Lines that were never measured still carry the old default height, and
      // the engine's own layout pass has to run again with the real viewport.
      try { amllPlayer.layoutCalculator.updateUnmeasuredHeights(amllPlayer.defaultLineHeight); } catch (e) {}
      try { if (typeof amllPlayer.calcLayout === "function") amllPlayer.calcLayout("resize"); } catch (e) {}
    });
    try { amllSizeObserver.observe(amllHost); } catch (e) {}
    return amllSizeSeeded;
  }

  function amllStopOwnLoop() {
    if (amllRaf) cancelAnimationFrame(amllRaf);
    amllRaf = 0;
  }

  function amllMediaIsPlaying() {
    // YTMusic knows whether it is playing; time deltas lie during buffering and
    // right after a seek, which used to leave the engine's own isPlaying flag
    // stale and freeze the karaoke sweep mid-word.
    try {
      if (typeof window !== "undefined" && window.YTMod && window.YTMod.player) {
        if (typeof window.YTMod.player.isPaused === "function") {
          return !window.YTMod.player.isPaused();
        }
      }
    } catch (e) {}
    return null;
  }

  // The engine positions a line's word animations (the per-word float, and the
  // per-character glow/float on long words) exactly ONCE, inside enable(), at
  // the instant the line becomes active - and it gates play() on its own
  // isPlaying flag. After that they run on wall-clock and are never re-synced,
  // so if that flag was ever stale the animations stay parked at whatever
  // currentTime they were given: the first word (whose delay is 0) happens to
  // show its float while every later word sits frozen at its start value.
  //
  // Re-run enable() for the active line every frame. It rewrites every word
  // animation's currentTime from the media time we already feed the engine, so
  // the floats track the song instead of the clock. Idempotent and cheap - it
  // only touches the handful of words on the active line.
  function amllKickActiveLine() {
    try {
      const groups = amllPlayer.currentLyricGroups || [];
      const t = amllPlayer.getCurrentTime();
      const playing = amllPlayer.getIsPlaying();
      for (const group of groups) {
        if (!group || !group.mainLine) continue;
        // Select by time, not by the group's isActive flag: that flag is only
        // written when the engine lays a line out, and it can be stale, which
        // left the word animations untouched by this loop entirely.
        let s = -1;
        let e = -1;
        try {
          const ln = group.mainLine.getLine();
          s = ln.startTime;
          e = ln.endTime;
        } catch (err) { continue; }
        if (t < s - 1500 || t > e + 1500) continue;
        try {
          const p = group.mainLine.enable(t, playing);
          if (p && typeof p.catch === "function") {
            p.catch((err) => { amllEnableError = String(err); });
          }
        } catch (err) { amllEnableError = String(err); }
        try { group.mainLine.resume(); } catch (err) {}
        if (group.bgLine) {
          try { group.bgLine.enable(t, playing); } catch (err) {}
          try { group.bgLine.resume(); } catch (err) {}
        }
      }
    } catch (e) {}
  }

  function amllDrive(positionMs) {
    amllDriveCount++;
    if (!amllActive || !amllReady || !amllPlayer) return;
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const delta = amllLastFrameTime ? Math.min(64, Math.max(0, now - amllLastFrameTime)) : 16;
    amllLastFrameTime = now;
    let off = 0;
    try { off = (typeof getOffsetForPosition === "function") ? getOffsetForPosition(positionMs) : 0; } catch (e) {}
    const t = Number.isFinite(off) ? Math.max(0, positionMs - off) : positionMs;
    amllLastPositionMs = t;
    try {
      const mediaPlaying = amllMediaIsPlaying();
      const advanced = mediaPlaying == null ? t > (amllPrevTime || 0) : mediaPlaying;
      amllPrevTime = t;
      // Compare against the ENGINE's own state, not a cached copy. The cached
      // copy starts as false, so when the media was already playing on the very
      // first frame the two values matched and resume() was never called - the
      // engine stayed "paused" forever. That silently killed the scale spring,
      // the per-word float and the background-vocal slide (all of them are
      // gated on getIsPlaying()), while the time-driven fill kept working
      // because update() writes --amll-player-time before any of that.
      if (advanced !== amllPlayer.getIsPlaying()) {
        if (advanced) { try { amllPlayer.resume(); } catch (e) {} }
        else { try { amllPlayer.pause(); } catch (e) {} }
      }
      amllWasPlaying = advanced;
      // Self-heal. The engine's own ResizeObserver can report 0x0 and never
      // recover, which zeroes defaultLineHeight and makes its in-render-range
      // check bail for every line - silently disabling every committed style
      // while the fill keeps working. Re-seed until the viewport sticks.
      if (amllPlayer.size[1] <= 0) amllSeedEngineSize();
      amllPlayer.setCurrentTime(t, false);
      amllPlayer.update(delta);
      // Every frame, not only while playing: enable() also parks the word
      // animations at the right positions when the media is paused.
      amllKickActiveLine();
      // Refresh the diagnostic a few times a second so it reflects the line that
      // is active right now, not just the one loaded at the last track change.
      if (amllLastContent && now - amllLastDumpTime > 400) {
        amllLastDumpTime = now;
        amllDumpDebug(amllLastContent);
      }
      amllDriveErrors = 0;
    } catch (e) {
      // A drive failure is per-frame, so do NOT tear the engine down on the
      // first one: a single hiccup (a half-built line, a mid-track line swap)
      // would otherwise drop Simple lyrics into the fallback for the rest of
      // the session. Retry, and only give up after ~1s of solid failures.
      amllDriveErrors++;
      if (amllDriveErrors === 1) {
        console.warn("[AuroraLyrics] AMLL drive failed; retrying.", e);
      }
      if (amllDriveErrors > 60) {
        console.warn("[AuroraLyrics] AMLL drive failed repeatedly; falling back.", e);
        amllFailed = true;
        amllHide();
      }
    }
  }
  /* ===================== boot =====================
     The first-run onboarding tour used to live above this line: a modal card, a
     pulsing highlight on the waffle icon, a localStorage completion flag and a
     second kickoff IIFE that re-ran it on DOMContentLoaded. Removed entirely
     (AJ, 2026-10-21) — a brand-new install opens straight into the app, which
     also retires the four #1ed760 green rules that were the last non-crimson
     colours in the project. */
  whenYTMod(() => {
    // Kick off the persisted Spicy Lyrics cache read immediately so it is warm
    // by the time the first track resolves — otherwise the very first lookup
    // pays a storage round-trip on the critical path.
    loadSpicyCache().then(() => sweepSpicyCache(Date.now())).catch(() => {});
    // Pre-warm the animated-art cache too, so the FIRST fullscreen entry already
    // holds it in memory and the cached-art check costs no storage round-trip. A
    // round-trip there meant the static cover could paint for a frame before
    // suppressStaticCardForAnimated() hid it (AJ, 2026-10-03).
    loadArtCache().catch(() => {});
    buildUI();
    // YTM's own video fullscreen button now opens OUR fullscreen instead, so
    // the control feels native. Registered after buildUI() because the redirect
    // needs panelEl, which buildUI() creates.
    installNativeFullscreenRedirect();
    window.postMessage({ type: "ytmod-settings-request", id: EXT_ID }, "*");
    // Also pull Aurora Bloom's settings so the MV blurred-backdrop brightness
    // (whose slider lives in that add-on) is right even if its panel is never
    // opened this session. handleHostMessage() picks out just that key.
    window.postMessage({ type: "ytmod-settings-request", id: "ytmod-dynamic" }, "*");
  });

})();
