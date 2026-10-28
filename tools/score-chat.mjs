// score-chat.mjs — §F, the rubric. Score a chat log the way the tuning loop
// needs it scored: six numbers, pass/fail, non-zero exit when any available
// metric fails. Stdlib only.
//
//   node tools/score-chat.mjs /tmp/run.jsonl
//   cat log.jsonl | node tools/score-chat.mjs -
//
// Input is a `__lurkerDump()`/`__lurkerDownload()` jsonl: one event per line,
// {t, kind:'chat'|'caption'|'mod'|'asr'|'fact', text, ctx}. Chat ctx carries
// what v2 logs: kind, archetype, shown (rendered, emote codes visible),
// codes (emote codes actually rendered), scene, sceneChange, model:false for
// template lines. Older logs lack some fields — the metrics that need them are
// reported as unavailable instead of failing.

import { readFileSync } from 'node:fs';
import { jaccard, normTokens, echoesScene } from '../js/text.js';

// emote hint set — used both to recognise an emote in a sim line
// (a rendered code that is one of these) and, as the spec's "approximation",
// to flag a real OCR line that names a known emote. Lower-cased keys so the
// regex below can match case-insensitively.
export const EMOTE_HINT_SET = new Set([
  'ek', 'ekw', 'ekko', 'kekw', 'pogu', 'pog', 'poggers', 'lul', 'lol',
  'w', 'f', 'gig', 'ez', 'rip', 'pepe', 'monka', 'monkaka', 'oho',
  'kappa', 'jebem', 'triya', 'heyguys', 'raz', 'sadge', 'pepega',
  'wkekw', 'ezgif', 'lmao',
]);

const RUBRIC = {
  captionEcho: { max: 0.10, label: 'caption-echo rate (Jaccard > 0.5 vs the caption)' },
  question: { min: 0.10, max: 0.25, label: 'question rate' },
  emote: { min: 0.25, max: 0.50, label: 'emote rate (line renders a real code)' },
  bigram: { min: 0.60, label: 'unique bigram ratio' },
  burst: { min: 2.0, label: 'burst correlation (lines/min in the 10 s after a scene change ÷ baseline)' },
  banLatency: { max: 6000, label: 'ban-reaction latency (ms to the first chat line after a mod action)' },
  templateRepeat: { max: 0.15, label: 'template repeat rate (culture/spot/relief/mood lines already heard)' },
};


/* ---- §G compare surface: exported so tools/test-compare.mjs can assert on
 * verdicts without shelling out. metrics() takes chat events in EITHER shape:
 * sim log events ({t, kind:'chat', text, ctx:{viewer, codes}}) or real OCR
 * rows ({t, user, text}). compare() diffs the two shapes per the §G table. */

const lineText = (e) => String(e.ctx?.shown || e.text || '').trim();
const lineViewer = (e) => e.ctx?.viewer || e.user || null;
const lineCodes = (e) => (Array.isArray(e.ctx?.codes) ? e.ctx.codes : null);
const tokens = (e) => lineText(e).split(/\s+/).filter(Boolean);
const normTok = (w) => w.toLowerCase().replace(/[^a-z0-9!#]/g, '');
const isEmoteTok = (w) => EMOTE_HINT_SET.has(normTok(w));
const isCaps = (t) => {
  const letters = t.replace(/[^a-zA-Z]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
};

export function metrics(events) {
  const chat = (events || []).filter((e) => (e.kind ? e.kind === 'chat' : true));
  if (chat.length < 10) throw new Error(`need at least 10 chat lines, got ${chat.length}`);
  const words = chat.map((e) => tokens(e).length).sort((a, b) => a - b);
  const med = (a) => a[Math.floor(a.length / 2)];
  const emoteLine = (e) => {
    const codes = lineCodes(e);
    if (codes) return codes.length > 0;
    return tokens(e).some(isEmoteTok);
  };
  const emoteOnly = (e) => {
    const ts = tokens(e);
    return ts.length > 0 && ts.every(isEmoteTok);
  };
  const ts = chat.map((e) => typeof e.t === 'number' ? e.t : new Date(e.t).getTime());
  const spanMin = Math.max(0.1, (ts.at(-1) - ts[0]) / 60000);
  const buckets = new Map();
  for (const t of ts) {
    const b = Math.floor((t - ts[0]) / 5000);
    buckets.set(b, (buckets.get(b) || 0) + 1);
  }
  const counts = [...buckets.values()];
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const cv = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length) / (mean || 1);
  const viewers = new Set(chat.map(lineViewer).filter(Boolean));
  const topEmotes = new Map();
  for (const e of chat) {
    const toks = lineCodes(e) || tokens(e).filter((w) => w.length <= 12);
    for (const w of toks) {
      if (!isEmoteTok(w)) continue;
      const k = normTok(w);
      topEmotes.set(k, (topEmotes.get(k) || 0) + 1);
    }
  }
  return {
    n: chat.length,
    medianWords: med(words),
    p90Words: words[Math.min(words.length - 1, Math.floor(words.length * 0.9))],
    pct12: 100 * words.filter((w) => w <= 2).length / words.length,
    pctEmote: 100 * chat.filter(emoteLine).length / chat.length,
    pctEmoteOnly: 100 * chat.filter(emoteOnly).length / chat.length,
    pctQuestion: 100 * chat.filter((e) => lineText(e).includes('?')).length / chat.length,
    pctCaps: 100 * chat.filter((e) => isCaps(lineText(e))).length / chat.length,
    burstiness: cv,
    msgsViewerMin: chat.length / Math.max(1, viewers.size) / spanMin,
    topEmotes: [...topEmotes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k),
    uniqueViewers: viewers.size,
    spanMin,
  };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ratioIn = (a, b, lo, hi) => { const r = b > 0 ? a / b : (a > 0 ? Infinity : 1); return r >= lo && r <= hi; };

export function compare(realEvents, simEvents, label = '') {
  const R = metrics(realEvents), S = metrics(simEvents);
  const rows = [
    { metric: 'median words/line', sim: S.medianWords, real: R.medianWords, verdict: near(S.medianWords, R.medianWords, 2) ? 'MATCH' : 'OFF' },
    { metric: 'p90 words/line', sim: S.p90Words, real: R.p90Words, verdict: near(S.p90Words, R.p90Words, 5) ? 'MATCH' : 'OFF' },
    { metric: '% 1-2 word lines', sim: S.pct12, real: R.pct12, verdict: near(S.pct12, R.pct12, 10) ? 'MATCH' : 'OFF' },
    { metric: '% with emote', sim: S.pctEmote, real: R.pctEmote, verdict: near(S.pctEmote, R.pctEmote, 10) ? 'MATCH' : 'OFF',
      note: 'real side is the OCR approximation (hint-set tokens)' },
    { metric: '% emote-only', sim: S.pctEmoteOnly, real: R.pctEmoteOnly, verdict: near(S.pctEmoteOnly, R.pctEmoteOnly, 8) ? 'MATCH' : 'OFF' },
    { metric: '% question lines', sim: S.pctQuestion, real: R.pctQuestion, verdict: near(S.pctQuestion, R.pctQuestion, 10) ? 'MATCH' : 'OFF' },
    { metric: '% ALL-CAPS lines', sim: S.pctCaps, real: R.pctCaps, verdict: near(S.pctCaps, R.pctCaps, 10) ? 'MATCH' : 'OFF' },
    { metric: 'burstiness (CV 5s)', sim: S.burstiness, real: R.burstiness,
      verdict: ratioIn(S.burstiness, R.burstiness, 0.5, 2) ? 'MATCH' : 'OFF' },
    { metric: 'msgs/viewer/min', sim: S.msgsViewerMin, real: R.msgsViewerMin,
      verdict: ratioIn(S.msgsViewerMin, R.msgsViewerMin, 0.25, 4) ? 'MATCH' : 'OFF',
      note: 'absolute rate is viewer-count-scaled by design; shape is the target' },
    { metric: 'top-10 emote overlap', sim: S.topEmotes.filter((e) => R.topEmotes.includes(e)).length,
      real: R.topEmotes.length, verdict: 'MATCH', info: true },
  ];
  const failed = rows.filter((r) => !r.info && r.verdict === 'OFF').length;
  return { rows, exit: failed ? 1 : 0, failed, label };
}

const isMain = process.argv[1] && process.argv[1].endsWith('score-chat.mjs');
if (isMain) {
  if (process.argv[2] === '--compare') {
    const [realPath, simPath] = [process.argv[3], process.argv[4]];
    if (!realPath || !simPath) {
      console.error('usage: score-chat.mjs --compare real.jsonl sim.jsonl');
      process.exit(2);
    }
    const read = (f) => f === '-' ? readFileSync(0, 'utf8') : readFileSync(f, 'utf8');
    const parse = (txt) => txt.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const res = compare(parse(read(realPath)), parse(read(simPath)), realPath);
    console.log(`compare ${res.label} — ${res.rows.length} metrics, ${res.failed} OFF\n`);
    for (const r of res.rows) {
      const sim = typeof r.sim === 'number' ? (r.sim >= 100 ? r.sim.toFixed(1) : String(Math.round(r.sim * 10) / 10)) : r.sim;
      const real = typeof r.real === 'number' ? (r.real >= 100 ? r.real.toFixed(1) : String(Math.round(r.real * 10) / 10)) : r.real;
      console.log(`  ${r.info ? 'INFO' : r.verdict}  ${r.metric.padEnd(24)} sim ${String(sim).padStart(7)}  real ${String(real).padStart(7)}${r.note ? '  · ' + r.note : ''}`);
    }
    process.exit(res.exit);
  }
  const src = process.argv[2] === '-' || !process.argv[2]
    ? readFileSync(0, 'utf8')
    : readFileSync(process.argv[2], 'utf8');
  const events = src.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const chat = events.filter((e) => e.kind === 'chat');
  const caps = events.filter((e) => e.kind === 'caption');
  const mods = events.filter((e) => e.kind === 'mod');

  if (chat.length < 10) {
    console.error(`only ${chat.length} chat lines in the log — too short to score`);
    process.exit(2);
  }
  const line = (e) => (e.ctx?.shown || e.text || '').trim();
  const isModel = (e) => e.ctx?.model !== false;
  const ts = (e) => new Date(e.t).getTime();

  // 1. caption echo — measured against the caption that was on screen when the
  // line was generated (ctx.scene), falling back to the nearest caption before it
  const captionAt = (e, i) => {
    if (e.ctx?.scene) return e.ctx.scene;
    for (let j = i; j >= 0; j--) if (events[j].kind === 'caption') return events[j].text;
    return '';
  };
  let echoN = 0, echoSampled = 0;
  chat.forEach((e) => {
    if (!isModel(e)) return;
    const scene = captionAt(e, events.indexOf(e));
    if (!scene) return;
    echoSampled++;
    if (echoesScene(line(e), scene) || jaccard(normTokens(line(e)), normTokens(scene)) > 0.5) echoN++;
  });

  // 2. questions — same definition the product uses for its ❓ badge (a line
  // asking something, question mark anywhere: "what are you playing? gg")
  const questions = chat.filter((e) => line(e).includes('?')).length;

  // 3. emote rate — needs the codes the renderer turned into images (ctx.codes),
  // or at least a code list to match against
  const hasCodes = chat.some((e) => Array.isArray(e.ctx?.codes));
  const codeSet = new Set();
  chat.forEach((e) => {
    (e.ctx?.codes || []).forEach((c) => codeSet.add(c));
    (e.ctx?.emotes || '').split(',').forEach((c) => { const t = c.trim(); if (t) codeSet.add(t); });
  });
  const hasEmote = (e) => {
    if (Array.isArray(e.ctx?.codes)) return e.ctx.codes.length > 0;
    return codeSet.size ? line(e).split(/[^A-Za-z0-9!#]/).some((w) => codeSet.has(w)) : false;
  };
  const emotes = chat.filter(hasEmote).length;

  // 4. unique bigrams — the anti-echo-loop number; chants cost a little here
  const bigrams = [];
  for (const e of chat) {
    const w = normTokens(line(e));
    for (let i = 0; i + 1 < w.length; i++) bigrams.push(w[i] + ' ' + w[i + 1]);
  }
  const bigramRatio = bigrams.length ? new Set(bigrams).size / bigrams.length : 0;

  // 5. burst correlation — chat must visibly speed up when the frame changes.
  // If scene changes blanket the timeline the ratio is meaningless, so say so.
  const changeAt = chat.filter((e) => e.ctx?.sceneChange).map(ts);
  let burst = null, blanketed = false;
  if (changeAt.length) {
    const span = ts(chat.at(-1)) - ts(chat[0]);
    const covered = changeAt.reduce((acc, t) => acc + Math.min(10000, Math.max(0, ts(chat.at(-1)) - t)), 0);
    blanketed = covered > 0.7 * span;
    const inWindow = chat.filter((e) => changeAt.some((c) => ts(e) >= c && ts(e) - c <= 10000)).length;
    const windowSecs = Math.min(span, changeAt.length * 10000) / 1000;
    const baseRate = chat.length / (span / 1000);
    burst = (inWindow / Math.max(1, windowSecs)) / baseRate;
  }

  // 6b. template repeats — the freshness-ring metric. Culture beats (banreact,
  // spot, relief, mood) pull from pools; hearing the same one twice is the
  // fastest way to break the spell. Emote fills and copypastas repeat by design
  // and are excluded; model lines are covered by the bigram ratio.
  const REPEAT_KINDS = new Set(['banreact', 'spot', 'relief', 'mood']);
  const seenTemplates = new Set();
  let tmplN = 0, tmplRepeat = 0;
  for (const e of chat) {
    if (isModel(e) || !REPEAT_KINDS.has(e.ctx?.kind || '')) continue;
    tmplN++;
    const key = normTokens(line(e)).join(' ');
    if (seenTemplates.has(key)) tmplRepeat++;
    else seenTemplates.add(key);
  }

  // 6. ban latency — first chat line after each mod action
  const latencies = mods.map((m) => {
    const after = chat.find((e) => ts(e) > ts(m));
    return after ? ts(after) - ts(m) : null;
  }).filter((v) => v !== null);
  const banMs = latencies.length ? Math.min(...latencies) : null;

  const pct = (v) => (v * 100).toFixed(1) + '%';
  const rows = [
    { key: 'captionEcho', value: echoSampled ? echoN / echoSampled : null,
      detail: `${echoN}/${echoSampled} model lines`, kind: 'max' },
    { key: 'question', value: chat.length ? questions / chat.length : null,
      detail: `${questions}/${chat.length} lines`, kind: 'range' },
    { key: 'emote', value: (hasCodes || codeSet.size) && chat.length ? emotes / chat.length : null,
      detail: `${emotes}/${chat.length} lines`, kind: 'range',
      unavailable: !hasCodes && !codeSet.size ? 'log has no emote codes' : '' },
    { key: 'bigram', value: bigrams.length ? bigramRatio : null,
      detail: `${new Set(bigrams).size}/${bigrams.length} bigrams`, kind: 'min' },
    { key: 'burst', value: burst, detail: burst === null ? 'no sceneChange flags in the log'
      : `${burst.toFixed(2)}× baseline`, kind: 'min',
      unavailable: burst !== null && blanketed ? 'captions change continuously — not measurable here' : '' },
    { key: 'banLatency', value: banMs, detail: banMs === null ? `${mods.length} mod actions logged` : `${banMs}ms`,
      kind: 'max', unavailable: banMs === null ? 'no mod actions in the log' : '' },
    { key: 'templateRepeat', value: tmplN >= 6 ? tmplRepeat / tmplN : null,
      detail: `${tmplRepeat}/${tmplN} template lines`, kind: 'max',
      unavailable: tmplN < 6 ? `only ${tmplN} culture/spot/relief/mood lines — not enough to judge` : '' },
  ];

  console.log(`chat ${chat.length} · captions ${caps.length} · mod actions ${mods.length} · `
    + `span ${((ts(chat.at(-1)) - ts(chat[0])) / 60000).toFixed(1)} min\n`);
  let failed = 0, skipped = 0;
  for (const r of rows) {
    const spec = RUBRIC[r.key];
    if (r.value === null || r.unavailable) {
      skipped++;
      console.log(`  n/a  ${spec.label.padEnd(70)} ${r.unavailable || r.detail}`);
      continue;
    }
    const ok = r.kind === 'max' ? r.value <= spec.max
      : r.kind === 'min' ? r.value >= spec.min
      : r.value >= spec.min && r.value <= spec.max;
    if (!ok) failed++;
    const shown = r.key === 'banLatency' ? `${Math.round(r.value)}ms` : pct(r.value);
    const bound = r.kind === 'max' ? `< ${spec.max}` : r.kind === 'min' ? `> ${spec.min}` : `${spec.min}–${spec.max}`;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${spec.label.padEnd(70)} ${shown} (want ${bound}) ${r.detail}`);
  }
  console.log(`\n${failed === 0 ? 'rubric green' : `${failed} metric(s) failing`} · ${skipped} unavailable`);
  process.exit(failed ? 1 : 0);

  // --------------------------------------------------------------------------

}
