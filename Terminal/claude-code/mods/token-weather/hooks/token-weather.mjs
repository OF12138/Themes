// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Token Weather: a live gauge of the context window, under the prompt.
//
// turn.complete: after each main-loop turn, read the context window's fill
// from $.session.usage() (the same figures the status line shows) and keep
// the last HISTORY readings.
// session.start: take a first reading, so the band shows before any turn.
// ui.render (PromptHint): one line under the engine's hint: percent, tokens
// used of the compaction window, 5h / 7d limits, and a block-character chart
// of the recent turns.
//
// The host reads on(...) and $.noun.method(...) from source, so they are
// spelled literally, and helpers that take $ are top-level functions.

const HISTORY = 12;
const BARS = "▁▂▃▄▅▆▇█";

// [local] Blue -> orange -> red by percent used: the theme's blue (as `last turns`), its orange
// (`warning`, the `auto mode on` color in the claude-cream theme), and the macOS window-button red.
const LEVELS = [
  { upTo: 50, color: "permission" },
  { upTo: 80, color: "warning" },
  { upTo: Infinity, color: "#FF5F57" },
];

// Readings: { tokens, window, percent }, oldest first.
let readings = [];
// [local] Auto-compact threshold for the current window size, and the 5h / 7d limits' percent used.
let compactAt = { window: 0, tokens: undefined };
let fiveHour;
let sevenDay;
// [local] A compaction in flight: { startedAt, now, tokensBefore, tick }, or undefined.
let compacting;

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    // [local] A hot reload restarts the module and fires session.start again: keep the session's history.
    readings = [];
    try {
      const saved = await $.store.get("readings");
      if (saved && saved.sessionId === (await $.session.id())) readings = saved.list;
    } catch {}
    await takeReading($);
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId) {
      return result;
    }
    await takeReading($);
    return result;
  });

  // [local] Compaction progress: elapsed time, redrawn each second (the summarizer's request is no turn,
  // so turn.step never sees it). Afterwards the band shows the engine's count of what is left.
  on("session.compact", async ($, e, next) => {
    if (e.trigger === "precompute" || e.agentId) {
      return next(e);
    }
    try {
      const startedAt = await $.clock.now();
      const tick = $.clock.every(1000, async () => {
        if (compacting) compacting.now = await $.clock.now();
        $.ui.invalidate("ui.render");
      });
      compacting = { startedAt, now: startedAt, tokensBefore: readings[readings.length - 1]?.tokens, tick };
      $.ui.invalidate("ui.render");
    } catch {
      // No progress band; the compaction itself goes on.
    }
    const done = () => {
      compacting?.tick?.cancel?.();
      compacting = undefined;
      $.ui.invalidate("ui.render");
    };
    return next(e).then(
      async (r) => {
        done();
        // $.session.usage() has no tokens until the next response; take the engine's count of what is left.
        if (r && !r.skip && r.tokensAfter !== undefined) {
          try {
            await addReading($, r.tokensAfter, true);
          } catch {}
        }
        return r;
      },
      (err) => { done(); throw err; },
    );
  });

  // [local] Drawn under the prompt, stacked on the engine's own hint line (`auto mode on ...`).
  on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
    const engine = await next(e);
    if (!compacting && readings.length === 0) {
      return engine;
    }
    const { Box, Text } = $.ui.resolve(e);
    const row = compacting ? compactingBand(Box, Text) : band(Box, Text, e.viewport?.columns ?? 80);
    return Box({ flexDirection: "column", children: [engine, row] });
  });
}

async function takeReading($) {
  try {
    const { context, rateLimits } = await $.session.usage();
    if (!context || !context.window) {
      return;
    }
    // [local] Measure against the auto-compact threshold, looked up once per window size.
    if (compactAt.window !== context.window) {
      const usage = await $.session.usage({ breakdown: "summary" });
      compactAt = { window: context.window, tokens: usage.context.breakdown?.autoCompactThreshold ?? context.window };
    }
    fiveHour = rateLimits?.find((r) => r.kind === "five_hour")?.percentUsed;
    sevenDay = rateLimits?.find((r) => r.kind === "seven_day")?.percentUsed;
    // [local] Right after a compaction there are no tokens until the next response: keep the compacted reading.
    if (context.tokens === undefined && readings.length > 0) {
      return;
    }
    await addReading($, context.tokens ?? 0, false);
  } catch {
    // No reading this turn; the band keeps the last one.
  }
}

async function addReading($, tokens, compacted) {
  const cap = compactAt.tokens ?? readings[readings.length - 1]?.window;
  if (!cap) {
    return;
  }
  const percent = Math.round((tokens / cap) * 100);
  // The session.start reading is 0 before any response; drop it once real readings arrive.
  readings = readings.filter((r) => r.tokens > 0);
  readings.push({ tokens, window: cap, percent, compacted });
  if (readings.length > HISTORY) {
    readings = readings.slice(-HISTORY);
  }
  $.ui.invalidate("ui.render");
  await $.store.set("readings", { sessionId: await $.session.id(), list: readings });
}

function band(Box, Text, columns) {
  const now = readings[readings.length - 1];
  const f = levelFor(now.percent);
  const trend = trendWord();
  // [local] No weather: the context percent itself carries the green/yellow/red.
  const parts = [
    Text({ color: f.color, bold: true, children: `${now.percent}%` }),
    Text({ children: " of context" }),
    Text({ dimColor: true, children: `  ${short(now.tokens)} / ${short(now.window)}` }),
  ];
  // [local] The 5h window colored by the same levels; 7d plain.
  if (fiveHour !== undefined) {
    parts.push(Text({ dimColor: true, children: "   5h " }));
    parts.push(Text({ color: levelFor(fiveHour).color, bold: true, children: `${Math.round(fiveHour)}%` }));
  }
  if (sevenDay !== undefined) {
    parts.push(Text({ dimColor: true, children: `   7d ${Math.round(sevenDay)}%` }));
  }
  if (columns >= 60) {
    parts.push(Text({ dimColor: true, children: "   last turns " }));
    parts.push(Text({ color: "permission", children: chart() }));
    if (trend) {
      parts.push(Text({ dimColor: true, children: `  ${trend}` }));
    }
  }
  return Box({ flexDirection: "row", paddingLeft: 0, children: parts });
}

function compactingBand(Box, Text) {
  const seconds = Math.round((compacting.now - compacting.startedAt) / 1000);
  const parts = [Text({ color: "claude", bold: true, children: "Compacting" })];
  if (compacting.tokensBefore) {
    parts.push(Text({ dimColor: true, children: ` ${short(compacting.tokensBefore)} of context` }));
  }
  parts.push(Text({ children: `   ${seconds}s` }));
  return Box({ flexDirection: "row", paddingLeft: 0, children: parts });
}

function levelFor(percent) {
  return LEVELS.find((l) => percent < l.upTo) ?? LEVELS[LEVELS.length - 1];
}

// Bars scale to the busiest reading shown, so growth shows at any fill level.
function chart() {
  const top = Math.max(...readings.map((r) => r.tokens), 1);
  const bars = readings.map((r) => BARS[Math.min(BARS.length - 1, Math.floor((r.tokens / top) * (BARS.length - 1)))]);
  return bars.join("");
}

function trendWord() {
  if (readings.length < 2) {
    return "";
  }
  const now = readings[readings.length - 1];
  const delta = now.tokens - readings[readings.length - 2].tokens;
  const what = now.compacted ? "compacted" : "last turn";
  if (delta > 0) return `▲ +${short(delta)} ${what}`;
  if (delta < 0) return `▼ ${short(-delta)} ${what}`;
  return "";
}

function short(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}
