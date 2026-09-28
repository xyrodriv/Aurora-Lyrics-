/*
 * Synced Lyrics — YTMod extension.
 *
 * This renderer is a focused adaptation of the original Spicy Lyrics
 * Syllable renderer by Spikerko. The original project is AGPL-3.0 licensed;
 * preserve that license and attribution when distributing adapted builds.
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
      } else if (next) {
        const between = markup.slice(word.node.closeEnd, next.node.openStart);
        word.isPartOfWord = !/\s/.test(between);
      } else {
        word.isPartOfWord = false;
      }
    }
    for (const word of words) {
      delete word.node;
      delete word.explicitPartOfWord;
    }

    return words;
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

      const plainText = words
        .map((word) => (word.hasSpaceBefore ? " " : "") + word.text)
        .join("")
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
  const LetterScaleSpline = getSpline([
    { Time: 0, Value: 0.95 }, { Time: 0.7, Value: 1.175 }, { Time: 1, Value: 1 },
  ]);
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
  const YOffsetSpline = getSpline([
    { Time: 0, Value: 0 }, { Time: 0.9, Value: -(1 / 60) }, { Time: 1, Value: 0 },
  ]);
  const LetterYOffsetSpline = getSpline([
    { Time: 0, Value: 0 }, { Time: 0.9, Value: -(1 / 56) }, { Time: 1, Value: 0 },
  ]);
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
  const DotOpacitySpline = getSpline([
    { Time: 0, Value: 0.35 }, { Time: 0.6, Value: 1 }, { Time: 1, Value: 1 },
  ]);

  // Upstream's residual-glow point for a sung letter in a word with no active
  // letter. NOTE it evaluates to ~1.21 (the natural spline overshoots its own
  // 0 -> 1 rise), NOT a small dim value — see the letter branch in
  // animateLetters() for why we deliberately do NOT apply it. Kept here as the
  // documented upstream value so an A/B can flip the behaviour in one line.
  // (Was documented as ~1.07 before the 2026-09-20 spline fix; the corrected
  // curve moves it to 1.21, which is 18.5px blur / 224% opacity, not less.)
  const SungLetterGlow = 0.2;

  function createWordSprings() {
    return {
      Scale: new Spring(ScaleSpline.at(0), 0.88, 0.64),
      YOffset: new Spring(YOffsetSpline.at(0), 1.45, 0.4),
      Glow: new Spring(GlowSpline.at(0), 1.18, 0.56),
    };
  }

  function createLetterSprings() {
    return {
      Scale: new Spring(LetterScaleSpline.at(0), 0.88, 0.64),
      YOffset: new Spring(LetterYOffsetSpline.at(0), 1.45, 0.4),
      Glow: new Spring(GlowSpline.at(0), 1.18, 0.56),
    };
  }

  function createDotSprings() {
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
  let fsSavedPanel = null; // { parent, next }
  let fsLayoutMode = "side";
  let fsControls = null;
  let fsLayoutSelect = null;
  let fsOffsetRange = null;
  let fsOffsetValue = null;
  let fsLyricsToggle = null;
  let fsLyricsHidden = false;
  let fsLyricsGapDimmed = false;
  let fsLyricsIntroDimmed = false;
  let fsLyricsFinalDimmed = false;
  let fsPlayerControls = null;
  let fsPlayerPlayButton = null;
  let fsPlayerVolumeRange = null; // the custom <div> track (replaces native range input)
  let fsPlayerVolumeValue = 100;   // numeric 0-100 volume, source of truth for the custom slider
  let fsPlayerSeekRange = null;
  let fsTimeCurrent = null;
  let fsTimeTotal = null;
  let fsVolumeIcon = null;
  let fsMuted = false;
  let fsLastVolume = 100;
  let fsPlayerStateTimer = 0;
  let fsBgImg = null; // cover-art layer used when fullscreen has no live video
  let fsArtImg = null; // sharp cover-art card in fsMediaHost (no-video tracks)
  let fsBgRefresh = null; // interval id for tracking track changes during fs
  // Kawarp WebGL backdrop for song fullscreen (handed off from the Dynamic add-on).
  let fsKawarpCanvas = null;
  let fsKawarp = null;
  let fsKawarpModulePromise = null;
  let fsKawarpArtUrl = ""; // artwork currently loaded into the Kawarp instance
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
  // Gap between the bottom of the centred MV pane and the top of the title.
  // Used by publishFsBandVars() to compute --ym-sl-fs-band-top.
  const FS_BAND_GAP = 18;
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
  // Auto-scroll state. `scrollSpringTarget === null` means the scroll is at rest.
  // `lastScrollTargetLine` is the line we are currently gliding toward, which is
  // NOT always `lastActiveLine` — see the early-scroll block in animate().
  let scrollSpringTarget = null;
  let scrollSpringVelocity = 0;
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
    // 1.45 (AJ, 2026-09-28). The 1.30 default sat AT the user's drag target on
    // a normal-size pane but was too small on his main monitor — he bumped it
    // to 145% in the same pass that raised the slider ceiling to 600%.
    size: 1.45,
    offset: -80,
    // Background-vocal opacity RELATIVE to a normal line: 1.0 = exactly the same
    // resting opacity as lead lines (upstream parity), lower = dimmer. It must
    // never exceed 1.0 — the value is written straight into an `opacity`, and
    // CSS clamps opacity at 1, so a >100% setting silently pinned EVERY
    // background vocal (Sung, NotSung and Active alike) to full brightness and
    // made it ignore its state entirely. That was the bug AJ reported: bright at
    // rest, and it never dimmed. See the .line.bg-line block for the model.
    bgOpacity: 1.0,
    animation: 1.0,
    syllableAnimation: 1.0,
    verticalAnimation: 1.25,
    adaptiveSpacing: true,
    romanizationEnabled: true,
    legibilityBackdrop: false,
    // Scroll behaviour. AJ flipped smoothScrolling to OFF (2026-09-28) to
    // match his "default settings" screenshot: he prefers the raw instant
    // jump-to-active-line by default. The smooth tween stays available as an
    // opt-in toggle in the panel.
    smoothScrolling: false,
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
  };
  let currentSettings = Object.assign({}, DEFAULT_SETTINGS);

  function applySettings(next) {
    const prevRomanization = currentSettings.romanizationEnabled;
    const prevSize = currentSettings.size;
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
    // "Vertical position" is no longer a user setting (AJ, 2026-09-26): its slider
    // is gone and the panel simply sits at the default -80px. PINNED rather than
    // merely defaulted, because a value stored back when the slider existed would
    // otherwise keep shifting the lyrics with no UI left to move it back.
    currentSettings.offset = DEFAULT_SETTINGS.offset;
    // Ceiling is 1.0 on purpose: this value becomes an `opacity` and CSS clamps
    // opacity at 1, so permitting >1 would silently re-create the "background
    // vocals never dim" bug. A stored 2.0 from an older build lands on 1.0 here,
    // which is the correct parity value.
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
    // Reflect the MV-shade option on the overlay (no-op before fullscreen).
    syncFsMvShadeClass();
    document.body.classList.toggle("ym-sl-legibility-backdrop", !!currentSettings.legibilityBackdrop);
    // Turning smooth scrolling off mid-glide must not strand the spring with a
    // target it will never reach (nothing steps it in the instant path).
    if (!currentSettings.smoothScrolling) {
      scrollSpringTarget = null;
      scrollSpringVelocity = 0;
    }
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
      z-index: 2147483000;
      width: 340px;
      max-width: calc(100vw - 32px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,.14);
      background: rgba(18,18,20,.92);
      -webkit-backdrop-filter: blur(20px) saturate(1.4);
      backdrop-filter: blur(20px) saturate(1.4);
      box-shadow: 0 18px 50px rgba(0,0,0,.55);
      color: #fff;
      font-family: inherit;
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
      padding: 10px 12px;
      cursor: grab;
      user-select: none;
      touch-action: none;
      background: rgba(255,255,255,.06);
      border-bottom: 1px solid rgba(255,255,255,.1);
    }
    .ym-sl-options-header:active,
    .ym-sl-fs-options-header:active { cursor: grabbing; }
    .ym-sl-options-title,
    .ym-sl-fs-options-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: rgba(255,255,255,.8);
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
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: rgba(255,255,255,.55);
      padding: 4px 2px 0;
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
    /* Registered so the band anchor can ANIMATE. publishFsBandVars() measures
       the media pane and writes --ym-sl-fs-band-top / --ym-sl-fs-title-h; the
       title, chip and scrubber are positioned with calc() off them. When a new
       music video changes the pane's aspect ratio, the whole stack has to glide
       to the new anchor — but an UNREGISTERED custom property flips instantly.
       That is why the first reposition looked smooth (the pane's own width
       transition carried it) and every later one snapped (AJ, 2026-09-28).
       Registering them as <length> makes the transition below work; if a browser
       lacks @property the values simply flip as before. */
    @property --ym-sl-fs-band-top {
      syntax: "<length>";
      inherits: true;
      initial-value: 828px;
    }
    @property --ym-sl-fs-title-h {
      syntax: "<length>";
      inherits: true;
      initial-value: 26px;
    }
    .ym-sl-fs-overlay {
      transition:
        --ym-sl-fs-band-top .35s cubic-bezier(.22,.61,.36,1),
        --ym-sl-fs-title-h .35s cubic-bezier(.22,.61,.36,1);
    }
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
      left: 4%;
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
    .ym-sl-fs-overlay.ym-sl-fs-mode-background .ym-sl-fs-media > video {
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
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-intro-dim .ym-sl-fs-lyrics,
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-intro-dim .ym-sl-fs-lyrics:hover,
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-final-dim .ym-sl-fs-lyrics,
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-final-dim .ym-sl-fs-lyrics:hover {
      opacity: 0;
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
    }
    .ym-sl-fs-overlay.ym-sl-fs-idle .ym-sl-fs-player-controls {
      opacity: 1;
      pointer-events: none;
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
        transform .35s cubic-bezier(.22,.61,.36,1),
        top .35s cubic-bezier(.22,.61,.36,1),
        bottom .35s cubic-bezier(.22,.61,.36,1);
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
    .ym-sl-fs-options-button {
      white-space: nowrap;
    }
    /* Volume: a mute toggle + a thin bar beside the chip */
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
    .ym-sl-fs-volume-icon {
      width: 30px;
      height: 30px;
      min-width: 30px;
      min-height: 30px;
      padding: 0;
      border: 0;
      background: transparent;
      color: rgba(255,255,255,.9);
      font: inherit;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      transition: transform .2s ease, color .2s ease;
    }
    .ym-sl-fs-volume-icon:hover { color: #fff; transform: scale(1.06); }
    /* Spicy Volume SVG: only the speaker is always visible. The two waves
       and the mute cross are hidden by default and toggled by the three
       state classes (muted / low / high) - mirrors Spicy's .VolumeControl
       .Muted / .Low / .High logic exactly. */
    .ym-sl-fs-volume-icon svg { width: 18px; height: 18px; display: block; }
    .ym-sl-fs-volume-icon svg #ym-sl-fs-volume-wave-low,
    .ym-sl-fs-volume-icon svg #ym-sl-fs-volume-wave-high,
    .ym-sl-fs-volume-icon svg #ym-sl-fs-volume-mute {
      display: none;
    }
    .ym-sl-fs-volume-icon.ym-sl-fs-volume-muted svg #ym-sl-fs-volume-mute {
      display: inline;
    }
    .ym-sl-fs-volume-icon.ym-sl-fs-volume-low svg #ym-sl-fs-volume-wave-low {
      display: inline;
    }
    .ym-sl-fs-volume-icon.ym-sl-fs-volume-high svg #ym-sl-fs-volume-wave-low,
    .ym-sl-fs-volume-icon.ym-sl-fs-volume-high svg #ym-sl-fs-volume-wave-high {
      display: inline;
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
      transition: opacity .25s ease, background-color .3s ease,
        top .35s cubic-bezier(.22,.61,.36,1), bottom .35s cubic-bezier(.22,.61,.36,1);
    }
    .ym-sl-fs-overlay:hover .ym-sl-fs-scrubber,
    .ym-sl-fs-overlay:focus-within .ym-sl-fs-scrubber {
      opacity: 1;
    }
    .ym-sl-fs-time {
      flex: 0 0 auto;
      min-width: 38px;
      color: rgba(255,255,255,.82);
      font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-variant-numeric: tabular-nums;
      letter-spacing: .02em;
      user-select: none;
      text-shadow: 0 1px 3px rgba(0,0,0,.55);
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
    /* Custom <div> volume slider. The track is the hit area; the unplayed line is
       drawn with ::before, the white fill with .ym-sl-fs-volume-fill, the knob with
       .ym-sl-fs-volume-knob. On hover the track scales on the X axis (origin left,
       growing into the 32px group padding) so it stays inside the pill. scaleX is
       GPU-composited, so it animates smoothly even on software compositors. The knob
       counter-scales by 1/ratio to stay perfectly round through the whole transition. */
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
    }
    .ym-sl-fs-volume-knob {
      position: absolute;
      top: 50%; left: var(--vol-fill, 100%);
      width: 10px; height: 10px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,.5);
      transform: translate(-50%, -50%) scaleX(1);
      transform-origin: center;
      opacity: 0;
      transition: opacity .2s ease, transform .28s cubic-bezier(.22,.61,.36,1);
      pointer-events: none;
    }
    .ym-sl-fs-volume-group:hover .ym-sl-fs-player-volume { transform: scaleX(1.06); }
    .ym-sl-fs-volume-group:hover .ym-sl-fs-volume-knob {
      transform: translate(-50%, -50%) scaleX(0.943);
    }
    .ym-sl-fs-volume-group:hover .ym-sl-fs-volume-knob,
    .ym-sl-fs-player-volume:focus-visible .ym-sl-fs-volume-knob,
    .ym-sl-fs-player-volume:focus .ym-sl-fs-volume-knob { opacity: 1; }
    .ym-sl-fs-player-volume:focus-visible { outline: none; }
    .ym-sl-fs-player-volume:focus-visible::after {
      content: "";
      position: absolute;
      left: 0; right: 0; top: 50%; transform: translateY(-50%);
      height: 14px; border-radius: 999px;
      box-shadow: 0 0 0 2px rgba(255,255,255,.55);
    }
    .ym-sl-fs-player-controls button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      min-width: 34px;
      min-height: 34px;
      padding: 0;
      /* Borderless (AJ 2026-09-27) - the translucent ring was the "translucent
         border on the controls" he asked to remove. */
      border: 0;
      border-radius: 50%;
      background: rgba(255,255,255,.12);
      color: rgba(255,255,255,.94);
      font: inherit;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      /* Drop shadow only. The two inset shadows that used to live here
         (a 1px white ring plus a top highlight) read as a BORDER - that is
         what AJ kept seeing after the border:0 change and asked to remove
         (2026-09-28). The translucent fill alone carries the button. */
      box-shadow: 0 10px 24px -8px rgba(8, 10, 18, .46);
      transition: transform .22s cubic-bezier(.34,1.56,.64,1),
        background .22s ease, box-shadow .22s ease, color .22s ease;
    }
    .ym-sl-fs-player-controls button:hover {
      transform: scale(1.06);
      background: rgba(255,255,255,.2);
      color: #fff;
      box-shadow:
        0 14px 30px -8px rgba(8, 10, 18, .55),
        0 0 20px -5px rgba(255,255,255,.2);
    }
    .ym-sl-fs-player-controls button:active { transform: scale(.92); }
    .ym-sl-fs-player-controls .ym-sl-fs-player-play {
      width: 50px;
      height: 50px;
      min-width: 50px;
      min-height: 50px;
      font-size: 20px;
      background: rgba(255,255,255,.18);
    }
    /* Spicy transport glyphs. Prev / Next use a 35x20 viewBox (a wide double
       triangle) and Play / Pause a narrow one, so each is sized on its own
       instead of inheriting a single font-size. pointer-events:none keeps the
       button itself the only hit target. */
    .ym-sl-fs-player-controls button svg {
      width: 18px;
      height: 18px;
      display: block;
      pointer-events: none;
    }
    .ym-sl-fs-player-controls .ym-sl-fs-player-play svg {
      width: 20px;
      height: 20px;
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
        transform .35s cubic-bezier(.22,.61,.36,1),
        left .35s cubic-bezier(.22,.61,.36,1), right .35s cubic-bezier(.22,.61,.36,1),
        top .35s cubic-bezier(.22,.61,.36,1), bottom .35s cubic-bezier(.22,.61,.36,1);
    }
    .ym-sl-fs-overlay:hover .ym-sl-fs-controls,
    .ym-sl-fs-overlay:focus-within .ym-sl-fs-controls {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }
    /* Idle state: after a couple of seconds without input, hide the pointer in
       EVERY layout, and hide the hover controls ONLY in Video Background (AJ,
       2026-09-28) — in Side / Lyrics Only the transport stays put (see the
       not(.ym-sl-fs-mode-background) block at the end of the sheet). Placed
       AFTER the :hover rule above so it wins on equal specificity. Any input
       clears it. */
    .ym-sl-fs-overlay.ym-sl-fs-idle,
    .ym-sl-fs-overlay.ym-sl-fs-idle * {
      cursor: none !important;
    }
    .ym-sl-fs-overlay.ym-sl-fs-mode-background.ym-sl-fs-idle .ym-sl-fs-controls {
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
      /* Tight shadow only. The 18px-blurred layer that used to sit in front of
         this read as a dark BACKDROP behind the text on bright backdrops (cover
         art), which is what AJ's friend spotted (2026-09-28). A 3px shadow is
         enough to keep white text legible over a bright video without drawing
         a halo around it. */
      text-shadow: 0 1px 3px rgba(0,0,0,.5);
      opacity: 0;
      transform: translateX(-50%) translateY(6px);
      animation: ym-sl-fs-title-in .34s cubic-bezier(.22,.61,.36,1) .08s forwards;
      /* Crossfade on a track change - see .ym-sl-fs-title-leaving below.
         bottom/top are transitioned so the title glides when the media band
         moves (a different MV aspect ratio changes --ym-sl-fs-band-top) instead
         of snapping (AJ, 2026-09-28). */
      transition: opacity .24s ease, transform .24s ease,
        font-size .35s cubic-bezier(.22,.61,.36,1),
        bottom .35s cubic-bezier(.22,.61,.36,1), top .35s cubic-bezier(.22,.61,.36,1);
    }
    .ym-sl-fs-title-artist { font-weight: 800; }
    .ym-sl-fs-title-track { font-weight: 400; opacity: .82; }
    /* Rendered empty when there is no track yet: take up no space at all. */
    .ym-sl-fs-title:empty { display: none; }
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
       title, and BOTH align horizontally to the left media pane (4%..54%,
       midpoint 29%) instead of the overlay centre. AJ reported the group
       sitting in the middle of the screen while the cover art was off to the
       left (2026-09-27) - the earlier pass only applied the pane alignment to
       the music-video branch, which is why the no-video case stayed centred.
       Video Background is excluded: there the media is the full-bleed
       backdrop and a centred title is correct. The title and chip keep their
       translateX(-50%) centring, so only the left value changes. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-title,
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-play-chip {
      left: 29%;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-title {
      max-width: 50%;
    }
    /* No-video: hero title, cover art sits directly above it. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-title {
      bottom: 160px;
      font-size: 42px;
      line-height: 1.1;
      letter-spacing: -.015em;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-play-chip {
      bottom: 74px;
    }
    /* Music video: smaller caption under the video pane. */
    .ym-sl-fs-overlay.ym-sl-fs-has-video .ym-sl-fs-title {
      bottom: 150px;
      font-size: 22px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    .ym-sl-fs-overlay.ym-sl-fs-has-video .ym-sl-fs-play-chip {
      bottom: 72px;
    }
    @media (max-height: 700px) {
      .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-title {
        bottom: 136px;
        font-size: 32px;
      }
      .ym-sl-fs-overlay:not(.ym-sl-fs-has-video) .ym-sl-fs-play-chip {
        bottom: 64px;
      }
      .ym-sl-fs-overlay.ym-sl-fs-has-video .ym-sl-fs-title {
        bottom: 128px;
        font-size: 18px;
      }
      .ym-sl-fs-overlay.ym-sl-fs-has-video .ym-sl-fs-play-chip {
        bottom: 62px;
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
    .ym-sl-fs-media > video {
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
    /* Cover art: a centered square card filling the column width. The blurred
       backdrop fills the vertical space around it, so there are no black bars. */
    .ym-sl-fs-media > img {
      display: block;
      width: min(100%, 70vh);
      height: auto;
      max-width: 100%;
      max-height: 70vh;
      aspect-ratio: 1 / 1;
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
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-media > img {
      width: min(100%, 70vh);
      max-height: 70vh;
      flex: 0 1 auto;
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
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-media > img {
      max-height: 100%;
    }
    /* Bottom-align the cover inside the shortened pane so its lower edge lands
       right on top of the title band instead of floating in the middle of a
       tall pane (AJ wants the title DIRECTLY under the artwork). On a short
       window the pane is already cover-height, so this is a no-op there. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-media {
      align-items: flex-end;
    }
    /* Both variants: the scrubber spans the left media pane (4%..54%) rather
       than the overlay centre, so it sits under the cover art / video.
       transform must be reset because the no-video pill base centres itself
       with translateX(-50%), which would drag a 4%-anchored bar off the pane. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-scrubber {
      left: 4%;
      right: auto;
      width: 50%;
      transform: none;
      bottom: 24px;
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
    /* Cover-card crossfade (2026-09-28). Without the loading class the sharp
       cover card painted the OLD decoded image during the window between the
       fullscreen track-refresh tick setting a new src and the browser
       finishing the new decode — meanwhile Kawarp had already loaded the
       new art and was rendering it, so the pane briefly showed two different
       covers at once. Adding the .ym-sl-fs-art-loading class on every src
       swap (set by setFsArtSrc) drops the card to opacity 0 for the decode,
       and removing it on the img's load event fades it back to opacity 1 —
       by which point Kawarp also has the new art, so the two reveal
       together. */
    .ym-sl-fs-art {
      opacity: 1;
      transition: opacity .28s ease;
    }
    .ym-sl-fs-art.ym-sl-fs-art-loading {
      opacity: 0;
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
    .ym-sl-import.active {
      background: rgba(96,165,250,.28);
      border-color: rgba(96,165,250,.6);
      color: #eaf2ff;
    }
    .ym-sl-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      padding: 28px 12px;
      text-align: center;
    }
    .ym-sl-empty-msg { color: rgba(255,255,255,.72); }
    .ym-sl-empty-search { min-height: 34px; padding: 0 16px; font-size: 12px; }
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
      gap: 8px;
      padding: 12px;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 12px;
      background: rgba(16,18,24,.96);
      box-shadow: 0 12px 30px rgba(0,0,0,.5);
      pointer-events: auto;
    }
    .ym-sl-search.hidden { display: none !important; }
    .ym-sl-search-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .ym-sl-search-title {
      font-size: 13px;
      font-weight: 700;
      color: rgba(255,255,255,.92);
    }
    .ym-sl-search-close {
      flex: 0 0 auto;
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 6px;
      background: rgba(255,255,255,.1);
      color: rgba(255,255,255,.85);
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
    }
    .ym-sl-search-close:hover { background: rgba(255,255,255,.18); }
    .ym-sl-search-form { display: flex; gap: 6px; }
    .ym-sl-search-input {
      flex: 1 1 auto;
      min-height: 30px;
      padding: 0 10px;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 7px;
      background: rgba(255,255,255,.06);
      color: rgba(255,255,255,.92);
      font: inherit;
      font-size: 12px;
    }
    .ym-sl-search-input::placeholder { color: rgba(255,255,255,.45); }
    .ym-sl-search-remember {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: rgba(255,255,255,.7);
      cursor: pointer;
      user-select: none;
    }
    .ym-sl-search-status {
      min-height: 14px;
      font-size: 11px;
      color: rgba(255,255,255,.6);
    }
    .ym-sl-search-results {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 240px;
      overflow-y: auto;
      margin: 0;
      padding: 0;
    }
    .ym-sl-search-result {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 1px;
      text-align: left;
      padding: 7px 9px;
      border: 1px solid rgba(255,255,255,.1);
      border-radius: 8px;
      background: rgba(255,255,255,.05);
      color: rgba(255,255,255,.9);
      font: inherit;
      cursor: pointer;
      transition: background .12s ease;
    }
    .ym-sl-search-result:hover { background: rgba(96,165,250,.2); }
    .ym-sl-search-result.no-sync {
      opacity: .42;
      cursor: not-allowed;
      background: rgba(255,255,255,.03);
    }
    .ym-sl-search-result.no-sync:hover { background: rgba(255,255,255,.03); }
    .ym-sl-search-result.no-sync-available {
      opacity: .62;
      cursor: pointer;
      background: rgba(255,255,255,.04);
    }
    .ym-sl-search-result.no-sync-available:hover { background: rgba(96,165,250,.2); }
    .ym-sl-search-name { font-size: 12px; font-weight: 600; }
    .ym-sl-search-meta { font-size: 11px; color: rgba(255,255,255,.6); }
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
    .ym-sl-options-overlay select,
    .ym-sl-fs-options-overlay select,
    .ym-sl-fs-controls select {
      color-scheme: light;
      background-color: #fff;
      color: #000;
      transition: background-color .2s ease, color .2s ease, border-color .2s ease;
    }
    .ym-sl-options-overlay select option,
    .ym-sl-fs-options-overlay select option,
    .ym-sl-fs-controls select option {
      background: #fff;
      color: #000;
    }
    .ym-sl-options-overlay select:hover,
    .ym-sl-options-overlay select:focus,
    .ym-sl-fs-options-overlay select:hover,
    .ym-sl-fs-options-overlay select:focus,
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
      font-family: "SpicyLyrics", "Noto Sans Georgian", "Vazirmatn",
        "SF Pro Display", "SF Pro Text", "SF Pro", -apple-system,
        BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Arial, sans-serif !important;
      font-kerning: normal;
      scrollbar-width: thin;
      scrollbar-color: transparent transparent;
      container-type: size;
      opacity: 1;
      transform: translateY(var(--ym-sl-lyrics-offset));
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
      transition: opacity .2s cubic-bezier(.61,1,.88,1);
      font-size: var(--font-size) !important;
      /* SF Pro's descenders need a little more line-box room than the
         original SpicyLyrics font, especially while the glyphs are lifted. */
      line-height: 1.4 !important;
      letter-spacing: 0;
      direction: ltr;
      /* No will-change here. Declaring it permanently on every line/word/letter
         promoted 600+ compositor layers (70 lines + 571 words on a single 3:28
         track) that were never demoted, so GPU memory and layer bookkeeping grew
         for the whole session -- the "panel gets laggier the longer I listen" bug.
         It also bought nothing: will-change: transform promises only transform /
         opacity will change, but these elements also repaint every frame via
         text-shadow (glow) and background-image gradient stops. The hint is now
         applied in JS only while an element is actually mid-animation; see
         setAnimatingHint(). */
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
      transition: opacity .2s ease;
      pointer-events: none;
    }
    #ym-sl-panel.SpicyRenderer .line.Active .romaji { opacity: .85; }
    #ym-sl-panel.SpicyRenderer .line:hover {
      z-index: 2;
    }
    #ym-sl-panel.SpicyRenderer .line:hover::before {
      opacity: 1;
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
        opacity .2s cubic-bezier(.61,1,.88,1),
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
    /* Only the leaf text elements (.word/.letter) carry the gradient clip.
       Putting background-clip:text on the .letterGroup wrapper clips its child
       letters to the (empty) wrapper box and makes them vanish once the active
       gradient is removed — the "long words turn dark after being sung" bug. */
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
        rgba(255,255,255,var(--gradient-alpha)) var(--gradient-position),
        rgba(255,255,255,var(--gradient-alpha-end))
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
      /* Gradient is now supplied by the base .word/.letter rule; only the
         per-word glow (during active singing) lives here. */
      text-shadow: 0 0 var(--text-shadow-blur-radius) rgba(255,255,255,var(--text-shadow-opacity));
    }
    #ym-sl-panel.SpicyRenderer .line.NotSung {
      opacity: var(--Vocal-NotSung-opacity);
      --gradient-position: -20% !important;
      /* Dim gradient (same clip technique as Active) instead of a solid fill,
         so the stroke weight never changes between states. */
      --gradient-alpha: .4;
      --gradient-alpha-end: .4;
      text-shadow: 0 0 var(--BlurAmount) rgba(255,255,255,var(--gradient-alpha-end));
    }
    #ym-sl-panel.SpicyRenderer .line.NotSung .word,
    #ym-sl-panel.SpicyRenderer .line.NotSung .letter {
      --gradient-position: -20% !important;
      --text-shadow-opacity: 0% !important;
      --text-shadow-blur-radius: 4px !important;
    }
    #ym-sl-panel.SpicyRenderer .line.Sung {
      opacity: var(--Vocal-Sung-opacity);
      --gradient-position: 100% !important;
      /* Dim gradient (same clip technique as Active) instead of a solid fill,
         so a finished line keeps the exact stroke weight it had while playing.
         (Earlier theory blamed the line-level text-shadow halo; that rests at 0
         on Sung and was not the cause — the solid-fill swap was.) */
      --gradient-alpha: .32;
      --gradient-alpha-end: .32;
      --BlurAmount: 0px !important;
      text-shadow: 0 0 var(--BlurAmount) rgba(255,255,255,var(--gradient-alpha));
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
      opacity: 1;
      --BlurAmount: 0px !important;
    }
    #ym-sl-panel.SpicyRenderer .line.Active .word,
    #ym-sl-panel.SpicyRenderer .line.Active .letter,
    #ym-sl-panel.SpicyRenderer .line.Active .letterGroup { opacity: 1; }
    #ym-sl-panel.SpicyRenderer .line.bg-line.Active .bg-word.WordNotSung:not(.letterGroup),
    #ym-sl-panel.SpicyRenderer .line.bg-line.Active .bg-word.WordNotSung .letter {
      /* Always gradient-clip (thin), like the sung/active bg words, so unsung
         bg words never read bold. The old solid fill here caused the per-word
         "blink" (thick until sung). Keep them dim + glow-less until sung; the
         sweep is supplied by the base gradient rule and rests at -20%. */
      -webkit-text-fill-color: transparent;
      background-image: linear-gradient(
        var(--gradient-degrees),
        rgba(255,255,255,var(--gradient-alpha)) var(--gradient-position),
        rgba(255,255,255,var(--gradient-alpha-end))
          calc(var(--gradient-position) + 20% + var(--gradient-offset))
      );
      --gradient-position: -20%;
      --text-shadow-opacity: 0% !important;
    }
    /* Active background-vocal words must use the same animated gradient as
       primary words. The resting WordNotSung override above is intentionally
       limited to the inactive background words.

       Both this rule and the WordNotSung one above MUST exclude .letterGroup via
       :not(.letterGroup). The base gradient-clip rule deliberately omits
       .letterGroup (see the note on .word/.letter further up), so a wrapper that
       receives background-image WITHOUT background-clip:text paints the gradient
       as a filled rectangle behind its letters instead of clipping it to the
       glyphs -- the pale box that appeared around long bg-vocal words such as
       "Keep". The .letter children still get the gradient and they do carry
       background-clip:text. The wrapper is meant to stay inert, which is also
       what animateWord() enforces with an inline background-image:none -- but
       that inline style is powerless against the !important below, so the
       exclusion has to happen here. */
    #ym-sl-panel.SpicyRenderer .line.bg-line.Active .bg-word.Active:not(.letterGroup),
    #ym-sl-panel.SpicyRenderer .line.bg-line.Active .bg-word.Active .letter,
    #ym-sl-panel.SpicyRenderer .line.bg-line.Active .bg-word.WordSung:not(.letterGroup),
    #ym-sl-panel.SpicyRenderer .line.bg-line.Active .bg-word.WordSung .letter {
      background-image: linear-gradient(
        var(--gradient-degrees),
        rgba(255,255,255,var(--gradient-alpha)) var(--gradient-position),
        rgba(255,255,255,var(--gradient-alpha-end))
          calc(var(--gradient-position) + 20% + var(--gradient-offset))
      ) !important;
      -webkit-text-fill-color: transparent !important;
      color: transparent !important;
    }
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
      --font-size: calc(var(--DefaultLyricsSize) * .72);
      /* Background vocals are NOT a special case in upstream's model: Mixed.css
         declares one fixed per-state opacity for every line (NotSung .51 /
         Sung .497 / Active 1) and has no background-vocal override at all. We
         only scale that model by the "Background vocals" slider, where 1.0 =
         identical to a normal line and lower = dimmer.
         The scale must be applied to the STATE CONSTANTS, never to the opacity
         property itself. CSS clamps opacity to 1, so the old code — which fed
         the slider (then defaulting to 2.0) straight into it — pinned every
         background vocal to full brightness and erased the Sung/NotSung
         distinction: bright at rest, never dimming. The min(1, ...) wrapper
         keeps the result a legal opacity without depending on that silent
         clamp.
         NO BACKTICKS IN THIS COMMENT BLOCK (it is inside a JS template). */
      --Vocal-NotSung-opacity: min(1, calc(.51 * var(--ym-sl-bg-vocal-scale)));
      --Vocal-Sung-opacity: min(1, calc(.497 * var(--ym-sl-bg-vocal-scale)));
      --Vocal-Active-opacity: min(1, var(--ym-sl-bg-vocal-scale));
      margin: -.25cqw 0 1.05cqw;
      font-weight: 600 !important;
    }
    #ym-sl-panel.SpicyRenderer .line.bg-line.Active {
      opacity: var(--Vocal-Active-opacity);
    }
    #ym-sl-panel.SpicyRenderer .line.bg-line.NotSung {
      opacity: var(--Vocal-NotSung-opacity);
    }
    #ym-sl-panel.SpicyRenderer .line.bg-line.Sung {
      opacity: var(--Vocal-Sung-opacity);
    }
    #ym-sl-panel.SpicyRenderer .line.bg-line .word,
    #ym-sl-panel.SpicyRenderer .line.bg-line .letter,
    #ym-sl-panel.SpicyRenderer .line.bg-line .letterGroup {
      /* Background vocals must never read as a white highlight. Keep the
         gradient sweep visible but dim — the active word picks up the same
         --gradient-alpha/--gradient-alpha-end below, so capping them here
         applies to every state including the active background-image paint. */
      --gradient-alpha: .62;
      --gradient-alpha-end: .36;
      font-weight: 600 !important;
    }
    /* NOTE: never override --text-shadow-opacity / --text-shadow-blur-radius
       here with !important. animateLetters() writes those per letter inline
       (glow * 185%) and a CSS !important outranks an inline style, which
       freezes every letter at one constant value and makes the whole word glow
       at once instead of lighting up letter by letter (background vocals are
       TTML-only, so it showed up only on imported TTML). Dimming background
       vocals is handled by the gradient alphas above plus the line's own
       --ym-sl-bg-vocal-scale, both of which preserve the animation. */
    /* BG vocals resting state: dim them so they sit "behind" the lead instead
       of showing the same brightness as the active sweep. The bg-line block
       above sets --gradient-alpha .62 / --gradient-alpha-end .36 for ALL
       states, so the active wipe stays dim too. These rules additionally pin
       the NotSung/Sung glow, which is what actually paints resting glyphs.
       Selector specificity (.line.bg-line.NotSung .word = 3 classes + 1 type)
       beats the base .line.NotSung .word rule. */
    /* NOTE: this glow pinning is a SECOND, independent dimming layer on top of
       the line opacity above — the two multiply. Both are deliberate, but if
       background vocals ever read as too dim, this block (not the opacity
       model) is the one to relax: the opacity slider is already at its 1.0
       parity ceiling and has no headroom left. */
    #ym-sl-panel.SpicyRenderer .line.bg-line.NotSung .word,
    #ym-sl-panel.SpicyRenderer .line.bg-line.NotSung .letter {
      text-shadow: 0 0 var(--BlurAmount) rgba(255, 255, 255, .22);
    }
    #ym-sl-panel.SpicyRenderer .line.bg-line.Sung .word,
    #ym-sl-panel.SpicyRenderer .line.bg-line.Sung .letter {
      text-shadow: 0 0 var(--BlurAmount) rgba(255, 255, 255, .18);
    }
    #ym-sl-panel.SpicyRenderer .line.musical-line {
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
    @keyframes ymSlDotBounceOut {
      0%   { transform: scale(1);    opacity: 1; }
      30%  { transform: scale(1.22); opacity: 1; }
      100% { transform: scale(0.12); opacity: 0; }
    }
    #ym-sl-panel.SpicyRenderer .line.musical-line.bounce-out .dotGroup {
      animation: ymSlDotBounceOut 360ms cubic-bezier(.34, 1.4, .64, 1) forwards;
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
      width: min(90%, 300px);
      margin: auto;
      color: rgba(255,255,255,.55);
      font-size: 13px;
      line-height: 1.5;
      text-align: center;
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-credits {
      margin: 48px 4px 22px;
      padding-top: 18px;
      border-top: 1px solid rgba(255,255,255,.12);
      opacity: .85;
      pointer-events: none;
      user-select: none;
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
    }
    #ym-sl-panel.SpicyRenderer .ym-sl-provider-name {
      color: rgba(255,255,255,.85);
      font-weight: 600;
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
       (see .ym-sl-fs-player-controls above). In the side layouts they are
       anchored to the media pane's bottom edge instead of the overlay's, via
       --ym-sl-fs-band-top (see the MV side layout block at the end).
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

    /* ===== MV side layout: hang the band off the video, not the screen =====
       The pane is centred and sized to the video's aspect ratio, so its bottom
       edge moves with the video. Anchoring the title + chrome to the overlay
       bottom left a 94px hole under a 16:9 video (AJ: "it has too much space"),
       and made the spacing depend on the video's shape. --ym-sl-fs-band-top is
       published in px by publishFsBandVars(); these rules stack the title, the
       transport chip and the scrubber directly beneath it, 18px under the
       video and 12px apart. Fallbacks are the 16:9 / 1080p values so the first
       paint before the video reports its size is still sensible.
       The chip is a fixed 70px tall (50px play button + 2 x 10px padding).
       These selectors carry the full :not() chain (specificity 0,5,0) so they
       beat the per-variant bottom rules and the short-viewport media queries,
       which is why bottom is reset to auto here. */
    /* Cover-art side layout: the SAME top-anchored stack as the music-video case
       below, so the title / chip / scrubber change ONE property (top) between
       the two modes and can therefore TRANSITION. The old rules anchored them
       with bottom: 160 / 74 / 24px, and bottom(auto) <-> top(length) is not
       animatable — that is why the whole stack snapped on every MV <-> cover
       swap (AJ, 2026-09-28). The values land within a few px of the old ones,
       because the cover pane's bottom (100% - 218px) is what feeds
       --ym-sl-fs-band-top. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-title {
      top: var(--ym-sl-fs-band-top, 828px);
      bottom: auto;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-play-chip {
      top: calc(var(--ym-sl-fs-band-top, 828px) + var(--ym-sl-fs-title-h, 26px) + 12px);
      bottom: auto;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-has-video):not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-scrubber {
      top: calc(var(--ym-sl-fs-band-top, 828px) + var(--ym-sl-fs-title-h, 26px) + 12px + 70px + 12px);
      bottom: auto;
    }
    .ym-sl-fs-overlay.ym-sl-fs-has-video:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-title {
      top: var(--ym-sl-fs-band-top, 828px);
      bottom: auto;
    }
    .ym-sl-fs-overlay.ym-sl-fs-has-video:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-play-chip {
      top: calc(var(--ym-sl-fs-band-top, 828px) + var(--ym-sl-fs-title-h, 26px) + 12px);
      bottom: auto;
    }
    .ym-sl-fs-overlay.ym-sl-fs-has-video:not(.ym-sl-fs-mode-background):not(.ym-sl-fs-mode-lyrics-only) .ym-sl-fs-scrubber {
      top: calc(var(--ym-sl-fs-band-top, 828px) + var(--ym-sl-fs-title-h, 26px) + 12px + 70px + 12px);
      bottom: auto;
    }

    /* ===== side + lyrics-only: playback chrome never hides =================
       AJ wants the transport chip and the scrubber permanently visible in the
       video-left / lyrics-right (side) layout instead of fading in on hover
       (2026-09-28), and extended that to Lyrics Only (2026-09-28): the
       transport only auto-hides in Video Background now, where it sits over
       the full-bleed video. The MOUSE still hides on idle in EVERY layout
       (see the .ym-sl-fs-idle cursor rule above). Placed last in the block so
       it also wins over the .ym-sl-fs-idle rules, which carry the same
       specificity for the scrubber. */
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background) .ym-sl-fs-play-chip,
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background) .ym-sl-fs-scrubber {
      opacity: 1;
    }
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background).ym-sl-fs-idle .ym-sl-fs-play-chip,
    .ym-sl-fs-overlay:not(.ym-sl-fs-mode-background).ym-sl-fs-idle .ym-sl-fs-scrubber {
      opacity: 1;
      pointer-events: auto;
    }
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
    if (tabEl && tabMountParent &&
      tabEl.parentElement === tabMountParent && tabMountParent.isConnected) {
      return false;
    }
    const bar = findTabBar();
    return !bar || !bar.querySelector(".ym-sl-tab");
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
    panelEl = h("div", { id: "ym-sl-panel", class: "ym-sl-panel hidden SpicyRenderer" });
    const trackEl = h("div", { id: "ym-sl-track", class: "ym-sl-track", text: "Synced Lyrics" });
    const importButton = h("button", {
      class: "ym-sl-import",
      type: "button",
      title: "Import TTML lyrics",
      "aria-label": "Import TTML lyrics",
      text: "Upload",
    });
    const importMode = h("select", {
      class: "ym-sl-import-mode",
      title: "Choose how long this TTML should be used",
      "aria-label": "TTML import duration",
    });
    importMode.append(
      h("option", { value: "temporary", text: "Temporary" }),
      h("option", { value: "permanent", text: "Permanent", selected: true })
    );
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
    const offsetScope = h("select", { class: "ym-sl-offset-scope", title: "Apply offset to", "aria-label": "Offset applies to" });
    offsetScope.append(
      h("option", { value: "video", text: "Video" }),
      h("option", { value: "song", text: "Song" })
    );
    offsetScope.value = editingOffsetMode;
    const videoOffsetRange = h("input", {
      type: "range",
      min: "-30000",
      max: "30000",
      step: "100",
      value: "0",
      "aria-label": "Lyric offset",
    });
    const videoOffsetNumber = h("input", {
      type: "number",
      class: "ym-sl-offset-number",
      step: "0.1",
      min: "-30",
      max: "30",
      value: "0",
      title: "Offset in seconds (typed)",
      "aria-label": "Lyric offset in seconds",
    });
    const videoOffsetValue = h("span", { class: "ym-sl-video-offset-value", text: "0.0s" });
    const offsetApplied = h("span", { class: "ym-sl-offset-applied", text: "video" });
    videoOffsetWrap.append(videoOffsetLabel, offsetScope, videoOffsetRange, videoOffsetNumber, videoOffsetValue, offsetApplied);
    videoOffsetRange.addEventListener("input", () => {
      setVideoOffsetMs(Number(videoOffsetRange.value) || 0, true);
    });
    videoOffsetNumber.addEventListener("input", () => {
      const seconds = parseFloat(videoOffsetNumber.value);
      if (Number.isFinite(seconds)) setVideoOffsetMs(seconds * 1000, true);
    });
    offsetScope.addEventListener("change", () => {
      editingOffsetMode = offsetScope.value;
      refreshVideoOffsetControl();
    });

    const fullscreenButton = h("button", {
      class: "ym-sl-import",
      type: "button",
      title: "Fullscreen — video on the left, lyrics on the right",
      "aria-label": "Open fullscreen lyrics",
      text: "Fullscreen",
      onclick: enterFullscreenMode,
    });
    const optionsButton = h("button", {
      class: "ym-sl-import ym-sl-options-button",
      type: "button",
      title: "Lyrics options — offset, import, and more",
      "aria-label": "Open lyrics options",
      text: "Options",
    });
    const toolsScroll = h("div", { class: "ym-sl-tools-scroll" }, optionsButton, fullscreenButton);
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
    /* ---- MV pause re-sync section -------------------------------------------
       Sits between the Offset controls and the TTML controls: it is a timing
       control, so it belongs next to the other one rather than under file tools. */
    const pauseDivider = h("hr", { class: "ym-sl-options-divider" });
    const pauseTitle = h("div", { class: "ym-sl-options-section-title", text: "Pause sync" });
    const pauseSection = h("div", { class: "ym-sl-options-section ym-sl-pause-section" });
    const pausePick = h("button", {
      class: "ym-sl-import ym-sl-pause-pick",
      type: "button",
      "aria-label": "Set pause sync point",
      text: "Set pause point",
    });
    pausePick.addEventListener("click", () => enterPausePickMode());
    const pauseEditor = h("div", { class: "ym-sl-pause-editor hidden" });
    const pauseLineLabel = h("div", { class: "ym-sl-pause-line" });
    const pauseRange = h("input", {
      type: "range",
      class: "ym-sl-pause-range",
      min: String(PAUSE_SYNC_MIN),
      max: String(PAUSE_SYNC_MAX),
      step: String(PAUSE_SYNC_STEP),
      value: "0",
      "aria-label": "Pause sync offset",
    });
    const pauseNumber = h("input", {
      type: "number",
      class: "ym-sl-pause-number",
      step: "0.1",
      value: "0",
      "aria-label": "Pause sync offset in seconds",
    });
    const pauseValue = h("span", { class: "ym-sl-pause-value", text: "+0.0s" });
    const pauseClear = h("button", {
      class: "ym-sl-import ym-sl-pause-clear",
      type: "button",
      "aria-label": "Clear pause sync point",
      text: "Clear",
    });
    pauseClear.addEventListener("click", () => clearPauseSync());
    pauseRange.addEventListener("input", () => setPauseSyncOffset(pauseRange.value, false));
    pauseRange.addEventListener("change", () => setPauseSyncOffset(pauseRange.value, true));
    pauseNumber.addEventListener("input", () => setPauseSyncOffset(Number(pauseNumber.value) * 1000, false));
    pauseNumber.addEventListener("change", () => setPauseSyncOffset(Number(pauseNumber.value) * 1000, true));
    const pauseRow1 = h("div", { class: "ym-sl-pause-row" }, pauseRange);
    const pauseRow2 = h("div", { class: "ym-sl-pause-row" }, pauseNumber, pauseValue, pauseClear);
    pauseEditor.append(pauseLineLabel, pauseRow1, pauseRow2);
    pauseSection.append(pausePick, pauseEditor);
    pauseUi = {
      root: pauseSection,
      pick: pausePick,
      editor: pauseEditor,
      line: pauseLineLabel,
      range: pauseRange,
      number: pauseNumber,
      value: pauseValue,
    };

    // Banner shown on the lyrics panel while a line is being picked.
    pauseBanner = h("div", { class: "ym-sl-pause-banner hidden" });
    pauseBannerText = h("span", { class: "ym-sl-pause-banner-text" });
    const pauseBannerCancel = h("button", {
      class: "ym-sl-pause-cancel",
      type: "button",
      text: "Cancel",
      "aria-label": "Cancel pause sync selection",
    });
    pauseBannerCancel.addEventListener("click", () => exitPausePickMode());
    pauseBanner.append(pauseBannerText, pauseBannerCancel);

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
    cacheClear.addEventListener("click", async () => {
      if (cacheClear.disabled) return;
      cacheClear.disabled = true;
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
      cacheClear.disabled = false;
    });
    cacheSection.append(cacheStatus, cacheClear);

    const optionsBody = h("div", { class: "ym-sl-options-body" });
    optionsBody.append(
      optionsTop,
      pauseDivider, pauseTitle, pauseSection,
      optionsDivider, optionsTtmlTitle, optionsBottom,
      cacheDivider, cacheTitle, cacheSection
    );
    optionsOverlay.append(optionsHeader, optionsBody);
    optionsButton.addEventListener("click", () => {
      const opening = optionsOverlay.classList.contains("hidden");
      optionsOverlay.classList.toggle("hidden");
      if (opening) refreshPermanentDeleteState();
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
    panelEl.append(tools, fileInput, lyricsContainer, jumpButton, pauseBanner);
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
    const host = bar && bar.parentElement;
    // Never yank the panel back into the YTM tab while fullscreen is active —
    // it currently lives inside the fullscreen overlay.
    if (!host || !panelEl || fsActive) return;
    panelHost = host;
    if (panelEl.parentElement !== host) host.appendChild(panelEl);
  }

  function findPlayerVideo() {
    const video =
      document.querySelector("ytmusic-player video") ||
      document.querySelector("#movie_player video") ||
      document.querySelector("video");
    // A song with no music video still leaves an empty <video> in the DOM, so
    // only treat it as real media once it actually has frame dimensions.
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
        // The pane's height (and therefore the band anchor) just changed, but
        // the new aspect-ratio has not been laid out yet, so measure on the
        // next frame instead of reading a stale rect.
        requestAnimationFrame(publishFsBandVars);
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
    const labels = kind === "previous"
      ? ["previous", "back", "prev"]
      : kind === "next"
        ? ["next", "skip"]
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

  function updateVolumeIcon() {
    if (!fsVolumeIcon) return;
    const v = fsPlayerVolumeValue;
    // Three-state machine: muted / low / high. CSS hides whichever sub-paths
    // do not belong to the active state, so the markup never has to be
    // swapped. Matches Spicy's .VolumeControl.Muted/.Low/.High exactly.
    fsVolumeIcon.classList.toggle("ym-sl-fs-volume-muted", !!fsMuted || v <= 0);
    fsVolumeIcon.classList.toggle("ym-sl-fs-volume-low", !fsMuted && v > 0 && v < 50);
    fsVolumeIcon.classList.toggle("ym-sl-fs-volume-high", !fsMuted && v >= 50);
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
      updateVolumeIcon();
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
  // Spicy Lyrics' Volume SVG, namespaced so it does not collide with the
  // upstream extension if both happen to load. All four sub-paths ship at once
  // and CSS toggles their visibility based on .ym-sl-fs-volume-{muted,low,high}
  // on the button - the level decides the glyph exactly the way Spicy's
  // .VolumeControl does (one markup, three states, no re-render on volume
  // change).
  const FS_ICON_VOLUME = [
    { tag: "path", attrs: { id: "ym-sl-fs-volume-speaker", d: "M11 4.5 6.5 8.5H3.5c-.83 0-1.5.67-1.5 1.5v4c0 .83.67 1.5 1.5 1.5h3l4.5 4c.65.58 1.5.1 1.5-.68V5.18c0-.78-.85-1.26-1.5-.68z", fill: "currentColor" } },
    { tag: "path", attrs: { id: "ym-sl-fs-volume-wave-low", d: "M15.2 9.6a1 1 0 0 1 1.4 0 3.4 3.4 0 0 1 0 4.8 1 1 0 1 1-1.4-1.4 1.4 1.4 0 0 0 0-2 1 1 0 0 1 0-1.4z", fill: "currentColor" } },
    { tag: "path", attrs: { id: "ym-sl-fs-volume-wave-high", d: "M17.9 6.9a1 1 0 0 1 1.4 0 7.2 7.2 0 0 1 0 10.2 1 1 0 1 1-1.4-1.4 5.2 5.2 0 0 0 0-7.4 1 1 0 0 1 0-1.4z", fill: "currentColor" } },
    { tag: "path", attrs: { id: "ym-sl-fs-volume-mute", d: "M15.3 8.8a1 1 0 0 1 1.4 0l1.8 1.8 1.8-1.8a1 1 0 1 1 1.4 1.4L19.9 12l1.8 1.8a1 1 0 0 1-1.4 1.4l-1.8-1.8-1.8 1.8a1 1 0 0 1-1.4-1.4l1.8-1.8-1.8-1.8a1 1 0 0 1 0-1.4z", fill: "currentColor" } },
  ];

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
    fsOffsetRange = h("input", {
      type: "range", min: "-30000", max: "30000", step: "100",
      value: "0", "aria-label": "Lyric offset",
    });
    const fsOffsetNumber = h("input", {
      type: "number", class: "ym-sl-offset-number", step: "0.1", min: "-30", max: "30",
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
    // Options gear removed (AJ 2026-09-27). The offset rail stays reachable
    // from the normal panel; fullscreen chrome is now just Exit / Layout cycle
    // / Hide lyrics. offsetWrap (built above) is now a local unused variable -
    // left in place to keep this diff focused.
    fsControls = h("div", { class: "ym-sl-fs-controls" }, exit, fsLayoutSelect, fsLyricsToggle);
    // Transport buttons use Spicy Lyrics' own solid icons. Prev is the same
    // TrackSkip path as Next, rotated 180deg - exactly how upstream does it
    // (.PlaybackControl.TrackSkip.PrevTrack { rotate: 180deg }).
    const prevIcon = fsSvgIcon(FS_ICON_PREV, "0 0 35 20");
    prevIcon.style.transform = "rotate(180deg)";
    const previousButton = h("button", { class: "ym-sl-fs-player-prev", type: "button", title: "Previous song", "aria-label": "Previous song" }, prevIcon);
    const playButton = h("button", { class: "ym-sl-fs-player-play", type: "button", title: "Play or pause", "aria-label": "Play or pause" }, fsSvgIcon(FS_ICON_PAUSE, "0 0 15 20"));
    const nextButton = h("button", { class: "ym-sl-fs-player-next", type: "button", title: "Next song", "aria-label": "Next song" }, fsSvgIcon(FS_ICON_NEXT, "0 0 35 20"));
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
    fsVolumeIcon = h("button", {
      class: "ym-sl-fs-volume-icon",
      type: "button",
      title: "Mute or unmute",
      "aria-label": "Mute or unmute",
    });
    // All four Spicy volume paths ship at once and CSS hides whichever
    // wave/mute sub-paths the current level does not call for. This avoids the
    // 500ms refresh loop having to swap the SVG content the way the play
    // button does.
    fsVolumeIcon.appendChild(fsSvgIcon(FS_ICON_VOLUME));
    const volumeGroup = h("div", { class: "ym-sl-fs-volume-group" }, fsVolumeIcon, fsPlayerVolumeRange);
    const playChip = h("div", { class: "ym-sl-fs-play-chip" }, previousButton, playButton, nextButton, volumeGroup);
    fsTimeCurrent = h("span", { class: "ym-sl-fs-time", "data-time": "current", text: "0:00" });
    fsTimeTotal = h("span", { class: "ym-sl-fs-time", "data-time": "total", text: "0:00" });
    const scrubber = h("div", { class: "ym-sl-fs-scrubber" }, fsTimeCurrent, fsPlayerSeekRange, fsTimeTotal);
    fsPlayerPlayButton = playButton;
    fsPlayerControls = h("div", { class: "ym-sl-fs-player-controls" }, playChip, scrubber);
    fsOverlay.append(fsControls, fsPlayerControls);
    refreshFullscreenPlayerState();
    fsPlayerStateTimer = window.setInterval(refreshFullscreenPlayerState, 500);
    exit.addEventListener("click", exitFullscreenMode);
    previousButton.addEventListener("click", () => clickPlayerButton("previous"));
    playButton.addEventListener("click", () => clickPlayerButton("play"));
    nextButton.addEventListener("click", () => clickPlayerButton("next"));
    // Single source of truth for the custom slider: writes the fill (via
    // --vol-fill), the ARIA value, the icon, and the real YTM volume together.
    function applyFullscreenVolume(v) {
      v = clamp(Math.round(v), 0, 100);
      fsPlayerVolumeValue = v;
      fsPlayerVolumeRange.style.setProperty("--vol-fill", v + "%");
      fsPlayerVolumeRange.setAttribute("aria-valuenow", String(v));
      if (v > 0) fsMuted = false;
      updateVolumeIcon();
      setPlayerVolume(v);
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
      applyFullscreenVolume(volumeFromPointer(e.clientX));
      const onMove = (ev) => applyFullscreenVolume(volumeFromPointer(ev.clientX));
      const onUp = (ev) => {
        try { fsPlayerVolumeRange.releasePointerCapture(ev.pointerId); } catch (_) {}
        fsPlayerVolumeRange.removeEventListener("pointermove", onMove);
        fsPlayerVolumeRange.removeEventListener("pointerup", onUp);
        fsPlayerVolumeRange.removeEventListener("pointercancel", onUp);
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
    updateVolumeIcon();
    fsVolumeIcon.addEventListener("click", () => {
      const current = fsPlayerVolumeValue;
      if (fsMuted || current <= 0) {
        fsMuted = false;
        applyFullscreenVolume(fsLastVolume > 0 ? fsLastVolume : 100);
      } else {
        fsLastVolume = current;
        fsMuted = true;
        applyFullscreenVolume(0);
      }
    });
    fsPlayerSeekRange.addEventListener("pointerdown", () => { fsSeekUserAt = performance.now(); });
    fsPlayerSeekRange.addEventListener("input", () => {
      // Marks the seek bar as user-driven so the 500ms sync leaves the thumb
      // alone until the grace window lapses (see FS_SEEK_USER_GRACE_MS).
      fsSeekUserAt = performance.now();
      const duration = Number(window.YTMod && window.YTMod.player && window.YTMod.player.getDurationMs());
      const position = Number(fsPlayerSeekRange.value);
      if (Number.isFinite(duration) && duration > 0 && Number.isFinite(position)) {
        fsPlayerSeekRange.style.setProperty("--slider-fill", clamp(position / duration * 100, 0, 100) + "%");
      }
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

  function startFsIdleTracking() {
    stopFsIdleTracking();
    document.addEventListener("mousemove", handleFsMouseMove, { passive: true });
    document.addEventListener("mousedown", handleFsPointerDown, { passive: true });
    document.addEventListener("mouseup", handleFsPointerUp, { passive: true });
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
    if (fsOverlay) fsOverlay.classList.remove("ym-sl-fs-has-kawarp");
  }

  async function startFullscreenKawarp(artUrl) {
    if (!fsOverlay) return;
    // Gate on the Dynamic add-on: its handshake object is our signal that the
    // page-wide Kawarp exists, and we take the backdrop over from it.
    const dyn = window.__ymAuroraDynamic;
    if (!dyn || typeof dyn.suspend !== "function") return;
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
      if (seq !== fsKawarpSeq || !fsKawarpCanvas || !fsOverlay) return;
      sizeFullscreenKawarp();
      fsKawarp = new Kawarp(fsKawarpCanvas, FS_KAWARP_OPTIONS);
      if (artUrl) {
        await fsKawarp.loadImage(artUrl);
        fsKawarpArtUrl = artUrl;
      }
      if (seq !== fsKawarpSeq) return;
      fsKawarp.setOptions({ animationSpeed: isPlaybackPaused() ? 0.1 : 1 });
      fsKawarp.start();
      fsKawarpCanvas.classList.add("ready");
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
    }
  }

  function syncFullscreenKawarpArt(artUrl) {
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
    // "Prefer Kawarp for music videos" (Aurora Bloom, cross-add-on) forces
    // Kawarp for EVERY MV; otherwise only still uploads (Official Audio /
    // Lyric Video) hand the backdrop over to Kawarp. The choice is part of the
    // key, so flipping the setting re-runs the swap on the next call.
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
  // The swap is wrapped in a fade: fsMediaHost opacity goes to 0 (the .25s
  // CSS transition on .ym-sl-fs-media handles the animation), the DOM swap
  // runs, then opacity clears so it transitions back to 1 — replaces the
  // snap AJ reported (2026-09-16). A guard timer prevents re-entry while a
  // swap is already in flight.
  function syncFsVideoMode() {
    if (!fsActive || !fsMediaHost) return;
    if (fsVideoModeSwapTimer) return; // a swap is already in flight
    const liveVideo = findPlayerVideo();
    const hasAttached = !!fsSavedVideo;
    if (liveVideo && hasAttached) return;
    if (!liveVideo && !hasAttached) return;

    fsMediaHost.style.opacity = "0";
    // Timestamp for the settle gate that decides when the pane may come back.
    fsMediaSwapAt = performance.now();
    fsVideoModeSwapTimer = setTimeout(() => {
      fsVideoModeSwapTimer = 0;
      // Guard each separately: touching fsMediaHost.style when fsMediaHost is
      // null would throw (fullscreen can exit mid-swap).
      if (!fsMediaHost) return;
      if (!fsActive) { fsMediaHost.style.opacity = ""; return; }
      // Re-read state inside the timer (the interval could have ticked again).
      const lv = findPlayerVideo();
      const ha = !!fsSavedVideo;
      if (lv && ha) { fsMediaHost.style.opacity = ""; return; }
      if (lv && !ha) {
        // Attach the live video (mirrors enterFullscreenMode).
        fsSavedVideo = {
          node: lv,
          parent: lv.parentElement,
          next: lv.nextSibling,
          cssText: lv.style.cssText,
        };
        fsOverlay.classList.add("ym-sl-fs-has-video");
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
        if (fsArtImg && fsArtImg.parentElement) fsArtImg.parentElement.removeChild(fsArtImg);
        fsArtImg = null;
        stopFullscreenKawarp();
        // Hide the whole PANE, not just the video. The pane still carries the
        // cover-art geometry and animates to the video's aspect ratio, so
        // revealing it here showed a SQUARE card with the old art's shape
        // (AJ, 2026-09-28). awaitFsVideoReady() reveals the pane and the video
        // together, once frames are actually advancing.
        lv.style.setProperty("opacity", "0", "important");
        lv.style.setProperty("transition", "opacity .35s ease", "important");
        awaitFsVideoReady(lv);
        return;
      } else if (!lv && ha) {
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
          if (img) setFsArtSrc(img, hiResArt(artUrl));
        }
        startFullscreenKawarp(artUrl ? hiResArt(artUrl) : "");
        // Re-publish the band NOW. The pane's geometry just changed, and waiting
        // for the 2s tick left the title on the OLD (video) anchor, so it
        // overlapped the cover art until the tick moved it down (AJ, 2026-09-28).
        // Deferred a frame so the new layout is measurable, and the band's own
        // transition then carries the stack to the right place before the pane
        // reveal finishes.
        requestAnimationFrame(publishFsBandVars);
      }
      // Fade back in, once the new geometry has settled. (The MV attach path
      // returns above and reveals the pane itself, once the video is actually
      // producing frames.)
      revealFsMediaPane();
    }, FS_MEDIA_SWAP_MS);
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
  // FS_MEDIA_SWAP_MS matches the .ym-sl-fs-media opacity transition (.35s), so
  // the outgoing card finishes fading before the DOM swap removes it.
  const FS_MEDIA_SWAP_MS = 350;
  const FS_VIDEO_READY_MAX_MS = 8000;
  const FS_VIDEO_READY_POLL_MS = 150;
  let fsVideoReadySeq = 0;
  let fsVideoSpinnerEl = null;

  // The pane's geometry — its width, plus the aspect ratio the JS publishes via
  // --ym-sl-fs-video-ar — and the backdrop layers all take a beat to settle after
  // a media-mode swap, so revealing the pane immediately showed a
  // half-transitioned box: the cover cropped into the video's 16:9 frame with the
  // old blurred backdrop still behind it, and the pane still square on the way
  // into an MV (AJ, 2026-09-28). Every swap now holds the pane hidden for at
  // least this long.
  const FS_MEDIA_SETTLE_MS = 800;
  let fsMediaSwapAt = 0;
  let fsPaneRevealSeq = 0;

  function revealFsMediaPaneNow() {
    if (!fsMediaHost) return;
    fsMediaHost.style.opacity = "";
  }

  // Reveal the pane, but never sooner than FS_MEDIA_SETTLE_MS after the swap
  // began, so the new geometry and backdrop have landed.
  function revealFsMediaPane() {
    const wait = Math.max(0, FS_MEDIA_SETTLE_MS - (performance.now() - fsMediaSwapAt));
    const seq = ++fsPaneRevealSeq;
    if (wait <= 0) { revealFsMediaPaneNow(); return; }
    window.setTimeout(() => {
      if (seq !== fsPaneRevealSeq) return;
      revealFsMediaPaneNow();
    }, wait);
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
    hideFsVideoSpinner();
  }

  function awaitFsVideoReady(video) {
    const seq = ++fsVideoReadySeq;
    hideFsVideoSpinner();
    if (!fsActive || !video) { revealFsMediaPane(); return; }
    let spinnerTimer = 0;
    let pollTimer = 0;
    let giveUpTimer = 0;
    let lastTime = video.currentTime;
    let progressed = false;
    let done = false;
    function cleanup() {
      done = true;
      if (spinnerTimer) { window.clearTimeout(spinnerTimer); spinnerTimer = 0; }
      if (pollTimer) { window.clearTimeout(pollTimer); pollTimer = 0; }
      if (giveUpTimer) { window.clearTimeout(giveUpTimer); giveUpTimer = 0; }
      video.removeEventListener("playing", check);
      video.removeEventListener("timeupdate", check);
      video.removeEventListener("seeked", check);
    }
    function finish() {
      if (done || seq !== fsVideoReadySeq) return;
      cleanup();
      hideFsVideoSpinner();
      video.style.setProperty("opacity", "1", "important");
      revealFsMediaPane();
    }
    function check() {
      if (done || seq !== fsVideoReadySeq) return;
      const t = video.currentTime;
      if (t > lastTime + 0.02) progressed = true;
      lastTime = t;
      if (progressed && video.readyState >= 2 && video.videoWidth > 0 && !video.paused) finish();
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
  function setFsArtSrc(img, src) {
    if (!img || !src) return;
    if (img.getAttribute("src") === src && !img.classList.contains("ym-sl-fs-art-loading")) return;
    const seq = ++fsArtImgSeq;
    img.classList.add("ym-sl-fs-art-loading");
    const reveal = () => {
      if (seq !== fsArtImgSeq) return;
      img.classList.remove("ym-sl-fs-art-loading");
    };
    img.onload = () => reveal();
    img.onerror = () => reveal();
    img.setAttribute("src", src);
    // A cached image may already be complete at the moment we set src, in
    // which case onload fires later but rAF covers the same-frame gap.
    if (img.complete && img.naturalWidth > 0) {
      requestAnimationFrame(reveal);
    }
    setTimeout(() => {
      if (seq !== fsArtImgSeq) return;
      if (img.complete) img.classList.remove("ym-sl-fs-art-loading");
    }, 1500);
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
    if (findPlayerVideo() || fsSavedVideo) {
      // Symmetric teardown: never leave a cover card sitting on top of a video.
      // MV -> MV returns early inside syncFsVideoMode, so nothing else clears it.
      if (fsArtImg) {
        if (fsArtImg.parentElement) fsArtImg.parentElement.removeChild(fsArtImg);
        fsArtImg = null;
      }
      return;
    }
    const track = getCurrentTrack();
    const artUrl = (track && track.artworkUrl) || getDomArtworkUrl();
    const hi = hiResArt(artUrl);
    if (!hi) return;
    if (isVideoThumbnailUrl(hi)) {
      // The MV's own thumbnail, not cover art: drop any card and keep the pane
      // hidden until the video attaches and reveals it.
      if (fsArtImg) {
        if (fsArtImg.parentElement) fsArtImg.parentElement.removeChild(fsArtImg);
        fsArtImg = null;
      }
      if (fsMediaHost) fsMediaHost.style.opacity = "0";
      return;
    }
    const img = ensureFsArtImg();
    if (img) setFsArtSrc(img, hi);
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
    refreshFsTitle();
    // Long-title marquee: re-measure whenever the title's box changes width
    // (viewport resize, pane resize, font swap). updateFsTitleMarquee() itself
    // is idempotent — when the text fits it removes the class and leaves the
    // injected <style> tag in place for the next overflow.
    fsTitleRO = new ResizeObserver(() => updateFsTitleMarquee());
    fsTitleRO.observe(fsTitleEl);
    // The band anchor is measured from THIS title's height, and its font-size is
    // TRANSITIONED (.35s) — so a measurement taken right after a mode swap reads
    // the mid-zoom height, and the chip / scrubber (which stack off title-h)
    // stayed on the stale value until the 2s tick corrected them, which read as a
    // 2s animation delay on the controls only (AJ, 2026-09-28). Re-publish once
    // the size transition has actually finished.
    fsTitleEl.addEventListener("transitionend", (event) => {
      if (event.propertyName === "font-size") publishFsBandVars();
    });
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

      // Ambient blurred backdrop: a low-res duplicate of the live video that
      // the CSS blurs + dims to fill the entire overlay. The sharp video sits
      // on top in fsMediaHost, so the empty letterbox space and the area
      // behind the lyrics both get the blurred ambient fill.
      fsBgCanvas = h("canvas", { class: "ym-sl-fs-bg-canvas" });
      fsBgCtx = fsBgCanvas.getContext("2d", { alpha: false });
      fsOverlay.insertBefore(fsBgCanvas, fsMediaHost);
      fsBgLastDrawAt = 0;
      // Defer the first draw + loop start until the canvas is laid out so
      // clientWidth/clientHeight are valid for sizing.
      requestAnimationFrame(() => {
        drawBgFrame();
        startBgDrawLoop();
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
      // Also re-derive the band anchor: this is the only place that notices a
      // viewport resize while fullscreen is open (the pane is centred and
      // sized from the viewport, so both its width and height move).
      publishFsBandVars();
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
  }

  function exitFullscreenMode() {
    if (!fsActive) return;
    if (fsVideoModeSwapTimer) { clearTimeout(fsVideoModeSwapTimer); fsVideoModeSwapTimer = 0; }
    fsActive = false;
    stopFsIdleTracking();
    document.removeEventListener("keydown", handleFsKeydown, true);
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
      if (tabBar) tabBar.classList.toggle("ym-sl-custom-active", wasVisible);
      if (tabEl) tabEl.classList.toggle("ym-sl-active", wasVisible);
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
    // Drop any pending settle-gated pane reveal too.
    fsPaneRevealSeq++;
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
    fsPlayerVolumeRange = null;
    fsPlayerSeekRange = null;
    fsTimeCurrent = null;
    fsTimeTotal = null;
    fsVolumeIcon = null;
    fsMuted = false;
    fsLastVolume = 100;
    fsSavedVideo = null;
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
    const host = panelHost || (tabBar && tabBar.parentElement);
    if (!host) return;
    for (const child of Array.from(host.children)) {
      if (child === tabBar || child === panelEl) continue;
      child.classList.toggle("ym-sl-native-hidden", on);
    }
  }

  function cleanupTabBar(bar) {
    if (!bar) return;
    if (tabEl && tabEl.parentElement === bar) {
      tabEl.remove();
      tabEl = null;
      tabMountParent = null;
    }
    if (bar.__ymCloseObserver) {
      bar.__ymCloseObserver.disconnect();
      delete bar.__ymCloseObserver;
    }
    if (bar.__ymNativeClickHandler) {
      bar.removeEventListener("click", bar.__ymNativeClickHandler, true);
      bar.removeEventListener("tap", bar.__ymNativeClickHandler, true);
      delete bar.__ymNativeClickHandler;
    }
    bar.classList.remove("ym-sl-custom-active");
    // Drop any pending underline settle so it cannot fire against a torn-down bar.
    if (selectionBarTimer) { window.clearTimeout(selectionBarTimer); selectionBarTimer = 0; }
  }

  function scheduleMountTab() {
    if (mountTabTimer) return;
    mountTabTimer = window.setTimeout(() => {
      mountTabTimer = 0;
      mountTab();
    }, 400);
  }

  function mountTab() {
    const bar = findTabBar();
    if (!bar) {
      scheduleMountTab();
      return;
    }
    if (tabBar && tabBar !== bar) cleanupTabBar(tabBar);
    tabBar = bar;
    tabBar.classList.toggle("ym-sl-custom-active", panelVisible);
    mountPanel(bar);

    if (!tabBar.__ymCloseObserver) {
      tabBar.__ymCloseObserver = new MutationObserver(() => {
        if (!panelVisible) return;
        const selected = tabBar.querySelector(
          "tp-yt-paper-tab.iron-selected:not(.ym-sl-tab)"
        );
        if (selected && selected !== nativeTabAtOpen) setPanel(false);
      });
      tabBar.__ymCloseObserver.observe(tabBar, {
        attributes: true,
        subtree: true,
        attributeFilter: ["class", "aria-selected"],
      });
    }
    if (!tabBar.__ymNativeClickHandler) {
      tabBar.__ymNativeClickHandler = (event) => {
        if (!panelVisible) return;
        const nativeTab = event.target && event.target.closest
          ? event.target.closest("tp-yt-paper-tab")
          : null;
        if (!nativeTab || nativeTab.classList.contains("ym-sl-tab")) return;
        // YTM animates its indicator from ITS OWN last selection, which is stale
        // while our tab is the highlighted one — so its stretch would span the
        // wrong pair of tabs (AJ, 2026-09-28). Anchor the stretch to OUR tab
        // first, then let it settle onto the native tab.
        const fromTab = tabEl;
        setPanel(false);
        handOffSelectionBar(fromTab, nativeTab);
      };
      tabBar.addEventListener("click", tabBar.__ymNativeClickHandler, true);
      tabBar.addEventListener("tap", tabBar.__ymNativeClickHandler, true);
    }
    if (bar.querySelector(".ym-sl-tab")) return;

    const tabs = Array.from(bar.querySelectorAll("tp-yt-paper-tab"));
    if (!tabs.length) {
      scheduleMountTab();
      return;
    }
    let anchor = null;
    for (const tab of tabs) {
      if ((tab.textContent || "").trim().toLowerCase().includes("lyrics")) {
        anchor = tab;
        break;
      }
    }
    const ref = anchor || tabs[tabs.length - 1];
    const tab = ref.cloneNode(true);
    tab.classList.add("ym-sl-tab");
    tab.classList.remove("iron-selected", "selected", "active", "iron-disabled", "disabled");
    tab.removeAttribute("aria-selected");
    tab.removeAttribute("active");
    tab.removeAttribute("name");
    tab.removeAttribute("disabled");
    tab.removeAttribute("aria-disabled");
    tab.setAttribute("tabindex", "0");

    const label = tab.querySelector(".tab-content") || tab;
    label.textContent = "SYNCED";

    const blockNativeTap = (event) => {
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    };
    const activate = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      if (!panelVisible) {
        setPanel(true);
        return;
      }
      // Toggling OFF. YTM never sees this click (stopped above), so it does not
      // move its own underline — and setPanel(false) cannot either, because
      // syncSelectionBar() bails while the panel is closed. Without this the line
      // stays parked under SYNCED while the native tab's text lights back up
      // (AJ, 2026-09-28). Hand it to whichever native tab is still selected.
      const nativeTab = tabBar
        ? tabBar.querySelector("tp-yt-paper-tab.iron-selected:not(.ym-sl-tab)")
        : null;
      const fromTab = tabEl;
      // setPanel(false) clears nativeTabAtOpen, so read the fallback BEFORE it.
      const fallbackTab = nativeTabAtOpen;
      setPanel(false);
      handOffSelectionBar(fromTab, nativeTab || fallbackTab);
    };
    tab.addEventListener("tap", blockNativeTap, true);
    tab.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    }, true);
    tab.addEventListener("click", activate, true);

    (anchor || ref).after(tab);
    try {
      tab.disabled = false;
      delete tab.disabled;
    } catch (_) {}
    tabEl = tab;
    tabMountParent = tab.parentElement;
    // A re-render destroys the old tab and resets both the active class and the
    // native underline, so restore them if the panel is currently open. Park the
    // bar (no stretch) — YTM already reset it during the re-render.
    if (panelVisible) {
      tab.classList.add("ym-sl-active");
      placeSelectionBar(tab, tab);
    }
  }

  // Park YTM's OWN #selectionBar under whichever tab owns the panel. The bar is
  // a full-width element whose 1px white border-bottom is positioned with
  // transform: translateX(%) scaleX(fraction) — its layout width is the tab
  // strip width and its transform-origin is the left edge (both verified live
  // with the browser bridge). Driving it, instead of hiding it and drawing our
  // own underline, means the SYNCED underline moves with exactly the native
  // transition (AJ, 2026-09-28).
  // How long the underline sits stretched across both tabs before contracting
  // onto the new one (YTM waits for the tab's content; this approximates it).
  const SELECTION_BAR_SETTLE_MS = 300;
  let selectionBarTimer = 0;

  // Position the underline bar over the pixel span from leftEl's left edge to
  // rightEl's right edge (pass the SAME element twice to park it on one tab).
  // The bar is a full-width element whose border-bottom is the underline, moved
  // with transform: translateX(%) scaleX(fraction), transform-origin left —
  // verified live with the browser bridge.
  function placeSelectionBar(leftEl, rightEl) {
    if (!tabBar || !leftEl || !rightEl) return;
    const bar = tabBar.querySelector("#selectionBar");
    if (!bar) return;
    const container = bar.parentElement;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const lRect = leftEl.getBoundingClientRect();
    const rRect = rightEl.getBoundingClientRect();
    const base = bar.offsetWidth || cRect.width;
    if (!base || !cRect.width) return;
    const left = Math.min(lRect.left, rRect.left) - cRect.left;
    const right = Math.max(lRect.right, rRect.right) - cRect.left;
    const pct = (left / base) * 100;
    const scale = Math.max(0.001, (right - left) / base);
    bar.style.transform = "translateX(" + pct + "%) scaleX(" + scale + ")";
  }

  // Hand YTM's underline from OUR tab back to a native one. YTM animates its
  // indicator from ITS OWN last selection, which is stale while our tab is the
  // highlighted one — so its stretch would span the wrong pair of tabs. Drive the
  // span ourselves: STRETCH across both, then CONTRACT onto the native tab, which
  // is what YTM does natively. Shared by both exits — a native tab clicked while
  // the panel is open, and clicking SYNCED again to close it (AJ, 2026-09-28).
  function handOffSelectionBar(fromEl, toEl) {
    if (!fromEl || !toEl) return;
    placeSelectionBar(fromEl, toEl);
    // YTM re-writes the bar later in this same task; re-assert on the next frame
    // so OUR span is the one that shows, then settle.
    requestAnimationFrame(() => {
      placeSelectionBar(fromEl, toEl);
      if (selectionBarTimer) window.clearTimeout(selectionBarTimer);
      selectionBarTimer = window.setTimeout(() => {
        selectionBarTimer = 0;
        placeSelectionBar(toEl, toEl);
      }, SELECTION_BAR_SETTLE_MS);
    });
  }

  // Copy YTM's own tab-indicator move (AJ, 2026-09-28): on click the line
  // STRETCHES to span the previously highlighted tab AND ours (so it sits under
  // both), then CONTRACTS onto ours once the panel has settled. Native switches
  // are left entirely to YTM — this only runs while OUR tab is active.
  function syncSelectionBar() {
    if (!panelVisible || !tabEl || !tabBar) return;
    const nativeTab = tabBar.querySelector("tp-yt-paper-tab.iron-selected:not(.ym-sl-tab)");
    // Phase 1: stretch across the previous tab and ours.
    placeSelectionBar(nativeTab || tabEl, tabEl);
    // Phase 2: settle onto ours.
    if (selectionBarTimer) window.clearTimeout(selectionBarTimer);
    selectionBarTimer = window.setTimeout(() => {
      selectionBarTimer = 0;
      if (panelVisible && tabEl) placeSelectionBar(tabEl, tabEl);
    }, SELECTION_BAR_SETTLE_MS);
  }

  function setPanel(on) {
    // While fullscreen is up, the lyrics panel is owned by the overlay. Ignore
    // tab-driven visibility changes so the lyrics can't be hidden underneath us.
    if (fsActive) return;
    panelVisible = on;
    nativeTabAtOpen = on && tabBar
      ? tabBar.querySelector("tp-yt-paper-tab.iron-selected:not(.ym-sl-tab)")
      : null;
    syncNativePanel(on);
    // Move the native underline first, even if the panel element is somehow
    // missing, so the highlight can never point at the wrong tab.
    syncSelectionBar();
    if (!panelEl) return;
    panelEl.classList.toggle("hidden", !on);
    if (tabBar) tabBar.classList.toggle("ym-sl-custom-active", on);
    if (tabEl) tabEl.classList.toggle("ym-sl-active", on);
    if (on) {
      refreshTrack();
      syncTrackLyrics();
    }
  }

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

  function refreshFsTitle() {
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
      // measurable. Done BEFORE publishFsBandVars() so the band's measured
      // title-h reflects the (now stable) one-line height.
      updateFsTitleMarquee();
      // The title's height decides where the chip starts, so re-measure after
      // the text swap (this forces a sync layout, which is fine once per track).
      // Done while the title is faded out, but it is still laid out, so the
      // measurement is valid.
      publishFsBandVars();
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
  function publishFsBandVars() {
    if (!fsOverlay || !fsMediaHost) return;
    // No video guard any more: the cover-art side layout anchors its title /
    // chip / scrubber off the SAME band (see the top-anchored no-video rules), so
    // the band has to be published for cover art too — otherwise the stack has
    // no shared property to transition and snaps (AJ, 2026-09-28).
    const paneRect = fsMediaHost.getBoundingClientRect();
    // A pre-layout read returns 0; skip rather than publish a bogus anchor.
    if (!paneRect.height) return;
    fsOverlay.style.setProperty("--ym-sl-fs-band-top", Math.round(paneRect.bottom + FS_BAND_GAP) + "px");
    if (fsTitleEl) {
      const titleH = fsTitleEl.getBoundingClientRect().height;
      if (titleH > 0) {
        fsOverlay.style.setProperty("--ym-sl-fs-title-h", Math.round(titleH) + "px");
      }
    }
  }

  function refreshTrack() {
    const track = getCurrentTrack();
    const label = track ? track.title + (track.artist ? " — " + track.artist : "") : "Synced Lyrics";
    const trackEl = document.getElementById("ym-sl-track");
    if (trackEl) trackEl.textContent = label;
    refreshFsTitle();
    // Reconcile the fullscreen media on the track change itself instead of
    // waiting up to 2s for the refresh tick. The tick still covers the case
    // where the new artwork URL is not published yet at this instant.
    reconcileFsMediaArt();
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
      ? clamp(Math.round(numeric / 100) * 100, -30000, 30000)
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
    stopScrollSpring();
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

  function showLyricsMessage(message) {
    if (!lineScrollEl || !linesRoot) return;
    resetLyricsPanelState();
    // Centred box, the way an empty state should read.
    if (lineScrollEl) lineScrollEl.classList.add("offline");
    const empty = h("div", { class: "ym-sl-empty" });
    empty.appendChild(h("div", { class: "ym-sl-empty-msg", text: message }));
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
    stopScrollSpring();
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

       * spring      (smoothScrolling ON) — retargetable, keeps its velocity.
       * native ease (smoothScrolling OFF, ordinary line change) — handed to the
         element's own `scroll-behavior: smooth`. "Off" means the user did not ask
         for OUR spring, not that the panel should teleport. Upstream models it the
         same way: their $smoothScrolling also defaults to false, and their scroll
         element carries `scroll-behavior: smooth !important` with an explicit
         `behavior: "instant"` reserved for the writes that must not animate.
       * hard jump   (`immediate`) — a structural change moved the lyrics out from
         under the camera, so animating to catch up would be a lie about what just
         happened.

     `smoothScrolling` ON runs a spring that is RETARGETABLE and keeps its
     velocity. That is the entire point of using a spring here rather than a
     fixed-duration tween (which is what this used to be): a tween restarts from
     zero velocity every time the target moves, so on a fast song — a new line
     every ~400ms, and our old duration was 180-420ms — it never actually
     arrives, and the panel reads as stop-start. A spring handed a new target
     mid-flight just bends the curve and carries on.

     A spring also takes a constant ~0.4s regardless of distance, which is why
     the velocity clamp below matters: without it a 3000px "Jump to current"
     would reach ~11,000px/s and the lyrics would smear. The clamp turns a long
     jump into a constant-speed glide with a soft landing.

     Damping is just over critical (zeta ~1.0), so there is no overshoot and no
     bounce — a lyric panel that wobbles past its line looks broken, not bouncy. */
  const SCROLL_SPRING_STIFFNESS = 110;
  const SCROLL_SPRING_DAMPING = 21;
  const SCROLL_MAX_VELOCITY = 4000; // px/s

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
  function writeScrollTop(top, hard) {
    if (!lineScrollEl) return;
    if (typeof lineScrollEl.scrollTo === "function") {
      lineScrollEl.scrollTo({ top: top, behavior: hard ? "instant" : "auto" });
      return;
    }
    lineScrollEl.scrollTop = top;
  }

  function setScrollTarget(target, immediate) {
    if (!lineScrollEl) return;
    const maxScrollTop = Math.max(0, lineScrollEl.scrollHeight - lineScrollEl.clientHeight);
    const clamped = clamp(target, 0, maxScrollTop);
    if (immediate) {
      scrollSpringTarget = null;
      scrollSpringVelocity = 0;
      writeScrollTop(clamped, true);
      return;
    }
    if (!currentSettings.smoothScrolling) {
      // NOT the same thing as `immediate` — see the auto-scroll header. Drop the
      // spring, then let the element ease there under its own scroll-behavior.
      scrollSpringTarget = null;
      scrollSpringVelocity = 0;
      writeScrollTop(clamped, false);
      return;
    }
    // Compare against where we are HEADED, not where we are: while gliding, a
    // "new" target equal to the current one is not a change and re-arming it
    // every frame would keep the spring awake forever.
    const reference = scrollSpringTarget === null ? lineScrollEl.scrollTop : scrollSpringTarget;
    if (Math.abs(clamped - reference) < 1) return;
    scrollSpringTarget = clamped;
  }

  // Stepped once per frame from animate(). Kept out of its own rAF loop so the
  // scroll stops when the panel does, and so it shares animate()'s deltaTime
  // rather than sampling the clock a second time per frame.
  function stepScrollSpring(deltaTime) {
    if (scrollSpringTarget === null || !lineScrollEl) return;
    // Re-clamp every step. The target was clamped when it was SET, but scrollHeight
    // can shrink afterwards — adaptive spacing rewrites line geometry on every line
    // change — which leaves the spring chasing a position the container can no
    // longer reach. It would never satisfy the settle test, so it would wind the
    // velocity up against the stop and then release all of it as a jump the moment
    // the target moved back inward.
    const maxScrollTop = Math.max(0, lineScrollEl.scrollHeight - lineScrollEl.clientHeight);
    if (scrollSpringTarget > maxScrollTop) {
      scrollSpringTarget = maxScrollTop;
      // Pinned at the bottom stop: carrying velocity into it only winds the spring up.
      if (scrollSpringVelocity > 0) scrollSpringVelocity = 0;
    }
    const current = lineScrollEl.scrollTop;
    const displacement = scrollSpringTarget - current;
    // Settled: sub-pixel AND slow. The velocity half of the test matters because
    // scrollTop reads back quantised in some browsers, so `displacement` alone
    // can sit at ~0 while the spring is still travelling.
    if (Math.abs(displacement) < 1 && Math.abs(scrollSpringVelocity) < 8) {
      writeScrollTop(scrollSpringTarget, true);
      scrollSpringTarget = null;
      scrollSpringVelocity = 0;
      return;
    }
    scrollSpringVelocity +=
      (displacement * SCROLL_SPRING_STIFFNESS - scrollSpringVelocity * SCROLL_SPRING_DAMPING) * deltaTime;
    if (scrollSpringVelocity > SCROLL_MAX_VELOCITY) scrollSpringVelocity = SCROLL_MAX_VELOCITY;
    else if (scrollSpringVelocity < -SCROLL_MAX_VELOCITY) scrollSpringVelocity = -SCROLL_MAX_VELOCITY;
    writeScrollTop(current + scrollSpringVelocity * deltaTime, true);
  }

  function stopScrollSpring() {
    scrollSpringTarget = null;
    scrollSpringVelocity = 0;
  }

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
    const finalLineEnded = lastLine && lyricPositionMs >= lastLine.EndTime;
    const player = window.YTMod && window.YTMod.player;
    const durationMs = player && typeof player.getDurationMs === "function"
      ? Number(player.getDurationMs())
      : 0;
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
      showLyricsMessage("No lyrics found.");
      return false;
    }
    buildRendererLines(toSyllableContent(parsed));
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
    const parsed = parseTTML(rawXml);
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
    showLyricsMessage("No lyrics found.");
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
  // sequential HTTP requests) plus the API round-trip. Upstream Spicy Lyrics
  // ships a 3-day TTL for exactly this data, so we use the same window — it
  // sits comfortably inside any retention limit the API imposes, and a shorter
  // window is always the safe direction to be wrong in.
  //
  // Storage is chrome.storage.local (bridged through window.YTMod) rather than
  // localStorage: the localStorage lyrics cache is capped at 15 entries and is
  // shared with LRCLIB results, which would evict these far too eagerly.
  const SPICY_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days — see above.
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
  // unsynced track forever, without pinning a miss for three days.
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

  /** Title strings worth trying: stripped first, then as YTM reported it. */
  function listenbrainzTitleVariants(title) {
    return variantList(stripParensLoose(title), title);
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
        track.title,
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
    const titles = listenbrainzTitleVariants(title);
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

  async function fetchLRCLyrics(track, key) {
    const requestId = ++trackRequestSeq;
    if (activeTrackAbort) activeTrackAbort.abort();
    const controller = new AbortController();
    activeTrackAbort = controller;

    // Skeleton rather than a text message: this covers the network wait AND the
    // synchronous DOM build that follows it (see showLyricsSkeleton).
    showLyricsSkeleton();
    try {
      const spicyResult = await fetchSpicyLyrics(track, key, controller);
      if (controller.signal.aborted || requestId !== trackRequestSeq || key !== currentTrackKey) {
        // Silence here was a real dead end: the TTML was fetched and parsed, then
        // dropped on the floor with no output, which reads as "the fetch failed".
        console.warn(`[SpicyLyrics] discarding the Spicy result — ${
          controller.signal.aborted ? "request aborted" : "a newer lyrics request superseded this one"}.`);
        return;
      }
      if (spicyResult && spicyResult.ttml) {
        // Attribution + songwriters ride along with the API result; stash them
        // before loadTTML so the credits footer can render them.
        pendingSpicyCredits = {
          // The whole attribution object, not just the uploader: the footer
          // needs the provider (every source) and the maker (community syncs).
          attribution: spicyResult.attribution || null,
          songwriters: Array.isArray(spicyResult.songwriters) ? spicyResult.songwriters : [],
        };
        if (loadTTML(spicyResult.ttml, "external")) {
          console.log("[SpicyLyrics] TTML rendered from the Spicy Lyrics API.");
          return;
        }
        pendingSpicyCredits = null;
        console.warn("[SpicyLyrics] API returned TTML we could not parse; falling back to Unison/LRCLIB.");
      } else {
        console.warn("[SpicyLyrics] no Spicy TTML for this track; falling back to Unison/LRCLIB.");
      }
    } catch (error) {
      if (error && error.name === "AbortError") return;
      console.warn("[SpicyLyrics] lookup failed; falling back to Unison/LRCLIB:", error);
    }
    try {
      const unisonData = await fetchUnisonLyrics(track, key, controller);
      if (controller.signal.aborted || requestId !== trackRequestSeq || key !== currentTrackKey) return;
      if (unisonData && unisonData.format === "ttml") {
        if (loadTTML(unisonData.lyrics, "external", "Unison")) return;
        console.warn("[SpicyLyrics] Unison returned TTML that could not be parsed; falling back to LRCLIB.");
      }
      if (unisonData && unisonData.format === "lrc") {
        if (loadLRCLyrics({ syncedLyrics: unisonData.lyrics }, track.durationMs, "Unison")) return;
        console.warn("[SpicyLyrics] Unison returned LRC that could not be parsed; falling back to LRCLIB.");
      }
    } catch (error) {
      if (error && error.name === "AbortError") return;
      console.warn("[SpicyLyrics] Unison lookup failed; falling back to LRCLIB:", error);
    }

    const cached = lrclibCache.get(key);
    if (cached) {
      lrclibCache.delete(key);
      lrclibCache.set(key, cached);
      loadLRCLyrics(cached, track.durationMs);
      return;
    }
    const persisted = getLyricsPersistent(key);
    if (persisted) {
      lrclibCache.set(key, persisted);
      loadLRCLyrics(persisted, track.durationMs);
      return;
    }

    if (!window.YTMod || typeof window.YTMod.fetchLRCLIB !== "function") {
      showLyricsMessage("Could not load lyrics. Reload Aurora Lyrics and try again.");
      return;
    }
    const params = new URLSearchParams();
    params.set("track_name", track.title);
    if (track.artist) params.set("artist_name", track.artist);
    if (Number.isFinite(track.durationMs) && track.durationMs > 0) {
      params.set("duration", String(Math.round(track.durationMs / 1000)));
    }

    try {
      const response = await window.YTMod.fetchLRCLIB(
        `${LRCLIB_API}?${params.toString()}`
      );
      if (!response.ok && response.status !== 404) {
        throw new Error("LRCLIB returned HTTP " + response.status);
      }
      let data = response.ok ? response.data : null;

      if (!data || !data.syncedLyrics) {
        const searchParams = new URLSearchParams({
          q: [track.title, track.artist].filter(Boolean).join(" "),
        });
        if (controller.signal.aborted ||
            requestId !== trackRequestSeq ||
            key !== currentTrackKey) return;
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

      if (controller.signal.aborted ||
          requestId !== trackRequestSeq ||
          key !== currentTrackKey) return;
      // Accept either a synced or a plain match. Only give up when there is no
      // usable lyrics object at all.
      if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
        showLyricsMessage("No lyrics found.");
        return;
      }
      cacheLRCLyrics(key, data);
      cacheLyricsPersistent(key, data);
      loadLRCLyrics(data, track.durationMs);
    } catch (error) {
      if (error && error.name === "AbortError") return;
      if (requestId !== trackRequestSeq || key !== currentTrackKey) return;
      console.warn("[SpicyLyrics] LRCLIB lookup failed:", error);
      showLyricsMessage("Could not load lyrics. Try again later or import a TTML file.");
    }
  }

  /* ===================== next-track prefetch ===================== */
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

    panel.append(head, form, rememberRow, status, results);
    panel._input = input;
    panel._remember = remember;
    panel._status = status;
    panel._results = results;

    closeBtn.addEventListener("click", () => toggleSearchPanel(false));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      runLyricSearch();
    });

    searchPanelEl = panel;
    panelEl.appendChild(panel);
    return panel;
  }

  function toggleSearchPanel(force) {
    const panel = ensureSearchPanel();
    const show = force == null ? panel.classList.contains("hidden") : !!force;
    if (show) {
      const track = getCurrentTrack();
      panel._input.value = track ? [track.title, track.artist].filter(Boolean).join(" — ") : "";
      panel._results.replaceChildren();
      panel._status.textContent = "";
      panel.classList.remove("hidden");
      panel._input.focus();
      panel._input.select();
    } else {
      panel.classList.add("hidden");
      if (searchAbortController) {
        searchAbortController.abort();
        searchAbortController = null;
      }
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

  async function syncTrackLyrics() {
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

    if (savedTTML) {
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

  function makeWord(word, isLast, lineTimed, noKaraoke) {
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
    const letterCapable =
      !lineTimed &&
      !suppressKaraoke &&
      !word.DisableLetterAnimation &&
      !word.disableLetterAnimation &&
      isLetterCapable(word.Text, duration);
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
    let currentWordGroup = null;
    words.forEach((word, wordIndex) => {
      const wordModel = makeWord(word, wordIndex === words.length - 1, lineModel.LineTimed, noKaraoke);
      if (background) wordModel.BGWord = true;
      if (background) {
        wordModel.BGWord = true;
        wordModel.HTMLElement.classList.add("bg-word");
      }
      const previous = words[wordIndex - 1];
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
    if (currentProvider) footer.appendChild(buildProviderRow(currentProvider));
    if (currentUploader) footer.appendChild(buildPersonRow("Uploaded by", currentUploader));
    if (currentMaker) footer.appendChild(buildPersonRow("Made by", currentMaker));
    return footer;
  }

  // "Lyrics provided by <provider>" — every API source owes this one, so it is
  // plain text and never conditional on a person existing.
  function buildProviderRow(provider) {
    const row = h("div", { class: "ym-sl-provider" });
    row.appendChild(h("span", { class: "ym-sl-provider-label", text: "Lyrics provided by" }));
    row.appendChild(h("span", { class: "ym-sl-provider-name", text: provider }));
    return row;
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
  function publishRendererKit() {
    if (rendererKitPublished) return;
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
      blendSyllableAnimation: blendSyllableAnimation,
      blendVerticalAnimation: blendVerticalAnimation,
      storeNeedsAnimation: storeNeedsAnimation,
      setStyleIfChanged: setStyleIfChanged,
      // The compositor hint matters as much as the springs: without it the
      // consumer animates unpromoted and reads as low frame rate even when it is
      // stepping at full rate.
      setAnimatingHint: setAnimatingHint,
      HINT_ON: HINT_ON,
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
    (content || []).forEach((line) => {
      const lead = line && line.Lead;
      if (!lead || !lead.Syllables || !lead.Syllables.length) return;
      lines.push({
        text: lead.Syllables.map((w) => w.Text || "").join(""),
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
    stopScrollSpring();
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
  const HINT_ON = "transform, opacity";

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
      word.AnimatorStore = createWordSprings();
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
    const selfAwake = stateChanged || storeNeedsAnimation(word.AnimatorStore);
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
      setStyleIfChanged(word.HTMLElement, "--text-shadow-blur-radius", `${4 + 2 * glow}px`, 0.5);
      setStyleIfChanged(word.HTMLElement, "--text-shadow-opacity", `${Math.min(glow * 35, 100)}%`, 1);
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
    const now = performance.now();
    const deltaTime = Math.min(0.05, Math.max(0.001, (now - lastFrameTime) / 1000));
    lastFrameTime = now;

    // Static (unsynced) lyrics: slowly and smoothly auto-scroll so the panel
    // tracks playback — top at song start, bottom at song end. Paused while the
    // user scrolls manually (AJ, 2026-09-18).
    if (staticLyricsActive && !autoScrollUserPaused && lineScrollEl) {
      driveStaticAutoScroll(positionMs);
      setJumpButtonVisible(false);
    } else {
      // Static lyrics have their own continuous follow (driveStaticAutoScroll),
      // which is not target-based, so the spring must not also be pulling.
      stepScrollSpring(deltaTime);
    }

    // Pick the active per-track offset slot (video vs. song) based on what is
    // actually playing, then shift the lyric clock without moving the player.
    recomputeActiveOffsetMode(false);
    const lyricPositionMs = Math.max(0, positionMs - getOffsetForPosition(positionMs));
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
    const scrollLeadMs = currentSettings.scrollLeadEnabled ? currentSettings.scrollLeadMs : 0;
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

      // Recompute the glow (--BlurAmount) only when the active line changes.
      // NOTE: during the silent gap between two lines activeIndex is -1, so this
      // block is intentionally skipped in that window — we must NOT zero the
      // glow there, or every line loses its blur for the whole gap and it
      // snaps back when the next line starts (the "blur flicker" bug). The glow
      // simply stays frozen at its last value through the gap, which is smooth.
      if (activeLineChanged && activeIndex >= 0) {
        const distance = Math.abs(index - activeIndex);
        const blur = lineState === "Active" || distance === 0
          ? 0
          : Math.min(distance * 1.25, 1.25 * 5 + 1.25 * 0.465);
        setStyleIfChanged(line.HTMLElement, "--BlurAmount", `${blur}px`, 0.25);
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
    if (!window.YTMod || !window.YTMod.player) return;
    const position = window.YTMod.player.getPositionMs();
    if (position != null) animate(position);
  }

  // Track + offset housekeeping used to run inside tick(), so two document-wide
  // querySelectorAll passes per second executed in the same rAF callback as the
  // animation and competed with it for the frame budget -- any slowdown surfaced
  // as panel stutter while the rest of the page stayed smooth. None of it needs
  // frame accuracy, so it runs on its own timer and leaves the frame loop alone.
  const HOUSEKEEPING_MS = 500;
  let housekeepingTimer = 0;
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
      applySettings(data.settings);
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
    stopScrollSpring();
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
    teardownOnboarding();
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

  /* ===================== first-run onboarding ===================== */
  // Persist completion on the YouTube Music origin so the welcome card appears only once,
  // rather than returning after every extension or tab reload.
  const ONBOARDING_KEY = "better_lyrics_onboarding_done_v1";
  let onbHasRun = false;

  function hasCompletedOnboarding() {
    try { return localStorage.getItem(ONBOARDING_KEY) === "1"; } catch (_) { return false; }
  }

  function markOnboardingComplete() {
    try { localStorage.setItem(ONBOARDING_KEY, "1"); } catch (_) {}
  }

  function closePanelsNow() {
    // Force-close any open lyrics panel without depending on internal state:
    // hide our panel directly (incl. orphans from a previous injection) and
    // collapse the native YTM lyrics panel.
    try {
      const p = document.getElementById("ym-sl-panel");
      if (p) p.classList.add("hidden");
    } catch (_) {}
    try { setPanel(false); } catch (_) {}
    try { syncNativePanel(false); } catch (_) {}
  }

  function waitForSelector(selector, timeout) {
    return new Promise(function (resolve) {
      const start = Date.now();
      (function check() {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(check, 150);
      })();
    });
  }

  function showOnbError(err) {
    try { console.error("[Aurora Lyrics onboarding]", err); } catch (_) {}
    finishOnboarding();
  }

  let onbStyleEl = null;
  let onbRoot = null;
  let onbHighlighted = null;

  function ensureOnbStyle() {
    if (onbStyleEl && onbStyleEl.isConnected) return;
    const css = `
.ym-onb-root { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
.ym-onb-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.74); pointer-events: auto; }
.ym-onb-card { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: 440px; width: calc(100% - 48px); padding: 26px 28px 22px; border-radius: 16px; background: #181818; color: #fff; box-shadow: 0 20px 60px rgba(0,0,0,0.55); font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; pointer-events: auto; text-align: center; }
.ym-onb-card h2 { font-size: 19px; font-weight: 700; margin: 0 0 8px; }
.ym-onb-card p { margin: 0 0 18px; color: rgba(255,255,255,0.78); font-size: 14px; }
.ym-onb-btn { appearance: none; cursor: pointer; font: inherit; font-weight: 600; font-size: 14px; padding: 10px 28px; border-radius: 999px; border: 2px solid #1ed760; color: #1ed760; background: rgba(30,215,96,0.12); transition: background .15s ease, color .15s ease, transform .1s ease; }
.ym-onb-btn:hover { background: #1ed760; color: #0a0a0a; }
.ym-onb-btn:active { transform: scale(0.97); }
.ym-onb-highlight { position: relative !important; z-index: 2147483647 !important; outline: 3px solid #1ed760 !important; outline-offset: 5px !important; border-radius: 8px !important; animation: ymOnbPulse 1.5s ease-in-out infinite; background: rgba(30,215,96,.14) !important; }
@keyframes ymOnbPulse { 0%,100% { outline-color: #1ed760; } 50% { outline-color: rgba(30,215,96,0.45); } }`;
    onbStyleEl = document.createElement("style");
    onbStyleEl.id = "ym-onb-style";
    onbStyleEl.textContent = css;
    document.head.appendChild(onbStyleEl);
  }

  function removeOnbOverlay() {
    if (onbRoot && onbRoot.parentElement) onbRoot.parentElement.removeChild(onbRoot);
    onbRoot = null;
    if (onbHighlighted) {
      try { onbHighlighted.classList.remove("ym-onb-highlight"); } catch (_) {}
      onbHighlighted = null;
    }
  }

  function teardownOnboarding() {
    removeOnbOverlay();
    if (onbStyleEl && onbStyleEl.parentElement) onbStyleEl.parentElement.removeChild(onbStyleEl);
    onbStyleEl = null;
  }

  function buildOnbCard(title, body, btnLabel, onClick) {
    const card = document.createElement("div");
    card.className = "ym-onb-card";
    const h = document.createElement("h2"); h.textContent = title;
    const p = document.createElement("p"); p.textContent = body;
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "ym-onb-btn"; btn.textContent = btnLabel;
    btn.addEventListener("click", onClick);
    card.appendChild(h); card.appendChild(p); card.appendChild(btn);
    return card;
  }

  function showOnbOverlay(card, withBackdrop) {
    removeOnbOverlay();
    ensureOnbStyle();
    onbRoot = document.createElement("div");
    onbRoot.className = "ym-onb-root";
    if (withBackdrop) {
      const bd = document.createElement("div");
      bd.className = "ym-onb-backdrop";
      onbRoot.appendChild(bd);
    }
    onbRoot.appendChild(card);
    document.body.appendChild(onbRoot);
  }

  function finishOnboarding() {
    markOnboardingComplete();
    teardownOnboarding();
  }

  function startMarketplaceStep() {
    waitForSelector("#ym-nav-btn", 10000).then(function (btn) {
      if (!btn) {
        finishOnboarding();
        return;
      }
      onbHighlighted = btn;
      btn.classList.add("ym-onb-highlight");
      const card = buildOnbCard(
        "More than lyrics",
        "Aurora Lyrics also includes themes and artwork tools. Open the waffle icon in the top-right anytime to explore the rest.",
        "Got it",
        finishOnboarding
      );
      showOnbOverlay(card, false);
    }).catch(function (e) { showOnbError(e); });
  }

  function maybeStartOnboarding() {
    if (onbHasRun || hasCompletedOnboarding()) return;
    onbHasRun = true;
    // Make sure no lyrics panel is left open behind the onboarding overlay.
    closePanelsNow();
    try {
      // The first-run lesson starts with the waffle icon so people know Aurora Lyrics
      // is a small YT Music toolkit, not only a lyrics panel. The lyrics walkthrough
      // remains available from the marketplace and the SYNCED tab itself.
      startMarketplaceStep();
    } catch (e) {
      showOnbError(e);
    }
  }

  whenYTMod(() => {
    // Kick off the persisted Spicy Lyrics cache read immediately so it is warm
    // by the time the first track resolves — otherwise the very first lookup
    // pays a storage round-trip on the critical path.
    loadSpicyCache().then(() => sweepSpicyCache(Date.now())).catch(() => {});
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
    maybeStartOnboarding();
  });

  // Independent kickoff so onboarding + panel-close also run even if the YTMod bridge
  // is slow or unavailable. Guarded by onbHasRun, so it never double-runs.
  (function kickoffOnboarding() {
    const run = function () {
      try { maybeStartOnboarding(); } catch (e) { showOnbError(e); }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
  })();
})();
