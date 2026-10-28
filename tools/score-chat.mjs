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

const RUBRIC = {
  captionEcho: { max: 0.10, label: 'caption-echo rate (Jaccard > 0.5 vs the caption)' },
  question: { min: 0.10, max: 0.25, label: 'question rate' },
  emote: { min: 0.25, max: 0.50, label: 'emote rate (line renders a real code)' },
  bigram: { min: 0.60, label: 'unique bigram ratio' },
  burst: { min: 2.0, label: 'burst correlation (lines/min in the 10 s after a scene change ÷ baseline)' },
  banLatency: { max: 6000, label: 'ban-reaction latency (ms to the first chat line after a mod action)' },
};

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
