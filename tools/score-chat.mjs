// score-chat.mjs — §F, the rubric. Score a chat log the way the tuning loop
// needs it scored: a dozen numbers, pass/fail, non-zero exit when any available
// metric fails. Stdlib only.
//
//   node tools/score-chat.mjs /tmp/run.jsonl
//   cat log.jsonl | node tools/score-chat.mjs -
//
// Input is a `__spasmDownload()` jsonl (or the `__spasmDump()` array): one event,
// {t, kind:'chat'|'caption'|'scene'|'mod'|'asr'|'fact', text, ctx}. Chat ctx carries
// what v2 logs: kind, archetype, shown (rendered, emote codes visible),
// codes (emote codes actually rendered), scene, sceneChange, model:false for
// template lines. Older logs lack some fields — the metrics that need them are
// reported as unavailable instead of failing.

import { readFileSync } from 'node:fs';
import {
  jaccard, normTokens, echoesScene, unsafeLine, personaLeak, junkLine, echoesSpeech,
} from '../js/text.js';
import { SMASH, TEXT_FILLS } from '../js/cadence.js';

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

// Bands are the measured laws in docs/twitch-chat-fingerprint.md (6 real rooms,
// 2026-10-28), NOT the old guesses. The 25-50% emote band below was a fabrication
// that steered us away from real chat for weeks — real rooms put an emote in
// ≤9.4% of lines. See the fingerprint doc §"The laws, as rules".
const RUBRIC = {
  captionEcho: { max: 0.10, label: 'caption-echo rate (Jaccard > 0.5 vs the caption)' },
  // the real-chat corpus: 4.4 % (vod-fnf-work) and 3.0 % (vod-phantom)
  question: { min: 0.02, max: 0.10, label: 'question rate' },
  // law 1: emotes are seasoning, not sentences. No real room exceeds 9.4%.
  emote: { max: 0.10, label: 'emote rate (line renders a real code)' },
  emoteOnly: { max: 0.04, label: 'emote-only rate (line is nothing but an emote)' },
  // law 4/7: echo is the texture; a high unique-bigram ratio is what real chat
  // does NOT do. Informational — do not optimise toward it.
  bigram: { min: 0.0, label: 'unique bigram ratio (informational — real chat echoes, do not optimise)' },
  burst: { min: 2.0, label: 'burst correlation (lines/min in the 10 s after a scene change ÷ baseline)' },
  banLatency: { max: 6000, label: 'ban-reaction latency (ms to the first chat line after a mod action)' },
  templateRepeat: { max: 0.15, label: 'template repeat rate (culture/spot/relief/mood lines already heard)' },
  // laws 2,3,5,6 — the social/voice texture that made us a crowd, not a room
  oneLineUser: { min: 0.37, max: 0.66, label: 'one-line-user rate (speakers who say exactly one line)' },
  namesChatter: { min: 0.04, max: 0.11, label: 'names-another-chatter rate (@handle or addresses someone present)' },
  reply: { min: 0.06, max: 0.08, label: 'reply rate (line replies to a specific earlier line)' },
  oneWord: { min: 0.16, max: 0.36, label: 'one-word line rate' },
  // law 4: echo is the texture — a share of lines belong to a ≥5×-repeated
  // line. Real small rooms 2-9%; burst-shaped, not uniform.
  repeat: { min: 0.02, max: 0.09, label: 'copypasta/repeat rate (lines part of a ≥5×-repeated line)' },
  caps: { min: 0.10, max: 0.25, label: 'ALL-CAPS line rate' },
  exclam: { max: 0.03, label: 'exclamation rate (lines with !)' },
  ellipsis: { max: 0.01, label: 'ellipsis rate (lines with …)' },
  // what reading the transcripts caught and the numbers above missed:
  // slurs, the archetype brief as chat, @handle junk, mangled emotes, echo
  unsafe: { max: 0, label: 'unsafe lines (slurs, sexual or body talk, self-harm)' },
  personaLeak: { max: 0.03, label: 'persona-leak rate (model lines narrating the archetype or brief)' },
  junk: { max: 0.05, label: 'junk rate (model lines with made-up @handles, digit runs, symbols)' },
  emoteRender: { max: 0.05, label: 'emote-render failure (lines whose emote code shows as plain text)' },
  speechEcho: { max: 0.10, label: 'speech-echo rate (speech-context model lines repeating the streamer)' },
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
  // law 3: the silent majority — what share of the people who ever speak say
  // exactly one line. Real small rooms: 37-66%.
  const perViewer = new Map();
  for (const e of chat) {
    const v = lineViewer(e);
    if (v) perViewer.set(v, (perViewer.get(v) || 0) + 1);
  }
  const oneLineUsers = [...perViewer.values()].filter((n) => n === 1).length;
  // law 2: lines that name another chatter — an @handle or a bare nickname of
  // someone actually present. Real small rooms: 4-11%.
  const nameSet = new Set([...perViewer.keys()]);
  const namesSomeone = (e) => {
    const t = lineText(e);
    if (/@\w{2,}/.test(t)) return true;
    for (const nm of nameSet) {
      if (nm.length >= 3 && new RegExp('(^|[^\\w])' + nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^\\w]|$)', 'i').test(t)) return true;
    }
    return false;
  };
  // law 2: replies to a specific earlier line. Sim logs ctx.replyTo; real rows
  // carry replyTo (the target's login name).
  const isReply = (e) => !!(e.ctx?.replyTo || e.replyTo);
  const oneWord = chat.filter((e) => tokens(e).length === 1).length;
  const exclam = chat.filter((e) => lineText(e).includes('!')).length;
  const ellipsis = chat.filter((e) => lineText(e).includes('…')).length;
  const topEmotes = new Map();
  // law 4: copypasta/repeat share — what fraction of lines are part of a line
  // said ≥5 times. Real small rooms: 2-9% (jynxzi's mega-room: 46%). Burst-
  // shaped, not uniform. Normalise case/punct so "GG" and "gg!" count together.
  const normKey = (e) => lineText(e).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const lineFreq = new Map();
  for (const e of chat) { const k = normKey(e); if (k) lineFreq.set(k, (lineFreq.get(k) || 0) + 1); }
  const repeatedLines = chat.filter((e) => (lineFreq.get(normKey(e)) || 0) >= 5).length;
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
    pctOneLineUser: 100 * oneLineUsers / Math.max(1, perViewer.size),
    pctNamesChatter: 100 * chat.filter(namesSomeone).length / chat.length,
    pctReply: 100 * chat.filter(isReply).length / chat.length,
    pctOneWord: 100 * oneWord / chat.length,
    pctRepeat: 100 * repeatedLines / chat.length,
    pctExclam: 100 * exclam / chat.length,
    pctEllipsis: 100 * ellipsis / chat.length,
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
    { metric: '% one-line users', sim: S.pctOneLineUser, real: R.pctOneLineUser, verdict: near(S.pctOneLineUser, R.pctOneLineUser, 12) ? 'MATCH' : 'OFF' },
    { metric: '% names a chatter', sim: S.pctNamesChatter, real: R.pctNamesChatter, verdict: near(S.pctNamesChatter, R.pctNamesChatter, 5) ? 'MATCH' : 'OFF' },
    { metric: '% reply lines', sim: S.pctReply, real: R.pctReply, verdict: near(S.pctReply, R.pctReply, 5) ? 'MATCH' : 'OFF' },
    { metric: '% one-word lines', sim: S.pctOneWord, real: R.pctOneWord, verdict: near(S.pctOneWord, R.pctOneWord, 10) ? 'MATCH' : 'OFF' },
    { metric: '% repeated (≥5×) lines', sim: S.pctRepeat, real: R.pctRepeat, verdict: near(S.pctRepeat, R.pctRepeat, 8) ? 'MATCH' : 'OFF' },
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

// a log arrives as JSONL (__spasmDownload(), the harness) or as the JSON array
// __spasmDump() returns — both shapes are the same events
/* burst correlation: lines/min in the 10 s after a scene change ÷ the overall
 * rate. The window is the UNION of the 10 s spans — changes come in clusters,
 * and counting n×10 s read a real pile-up as 1.81× when those lines ran at
 * 2.46× baseline. `blanketed` says the changes cover the whole timeline, so the
 * ratio cannot mean anything. */
export function burstRatio(chat, changeAt, ts = (e) => new Date(e.t).getTime()) {
  if (!chat.length || !changeAt.length) return { ratio: null, blanketed: false };
  const first = ts(chat[0]), last = ts(chat.at(-1)), span = last - first;
  if (span <= 0) return { ratio: null, blanketed: false };
  const inWindow = chat.filter((e) => changeAt.some((c) => ts(e) >= c && ts(e) - c <= 10000)).length;
  const ivs = changeAt
    .map((c) => [Math.max(c, first), Math.min(c + 10000, last)])
    .filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  let covered = 0, cur = null;
  for (const [a, b] of ivs) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else { if (cur) covered += cur[1] - cur[0]; cur = [a, b]; }
  }
  if (cur) covered += cur[1] - cur[0];
  if (!covered) return { ratio: null, blanketed: false };
  const baseRate = chat.length / (span / 1000);
  return { ratio: (inWindow / (covered / 1000)) / baseRate, blanketed: covered > 0.7 * span };
}

export function parseLog(txt) {
  const t = String(txt || '').trim();
  if (t.startsWith('[')) return JSON.parse(t);
  return t.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
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
    const res = compare(parseLog(read(realPath)), parseLog(read(simPath)), realPath);
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
  const events = parseLog(src);
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
  // Change times come from the 'scene' events main.js logs at detection; older
  // logs only have the sceneChange flag on the chat lines that reacted.
  const sceneEv = events.filter((e) => e.kind === 'scene').map(ts);
  const changeAt = sceneEv.length ? sceneEv : chat.filter((e) => e.ctx?.sceneChange).map(ts);
  const { ratio: burst, blanketed } = burstRatio(chat, changeAt, ts);

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

  // 7. output safety, persona leak, junk — the reject list the worker applies,
  // measured so a regression (or a brain with no worker filter) shows up here.
  // An @mention is fine when it names someone who is actually in the room.
  const model = chat.filter(isModel);
  const raw = (e) => String(e.text || '').trim();
  const room = [...new Set(chat.map((e) => e.ctx?.viewer).filter(Boolean))];
  const unsafeN = chat.filter((e) => unsafeLine(raw(e)) || unsafeLine(line(e))).length;
  const leakN = model.filter((e) => personaLeak(raw(e))).length;
  const junkN = model.filter((e) => junkLine(raw(e), room)).length;

  // 8. emote-render failure — a code the line carries that did not become an
  // image (cosmetics mangled it: "TwaT…", "POLEDOGE"), or an emote-kind line
  // that rendered nothing. Keysmash and the text fills ("F", "o7") are text by design.
  const known = new Set(chat.flatMap((e) => e.ctx?.codes || []));
  const TEXT_ONLY = new Set([...TEXT_FILLS, ...SMASH]);
  const bare = (w) => w.replace(/[.,!?…]+$/, '');
  const emoteLines = !hasCodes ? [] : chat.filter((e) => {
    const toks = raw(e).split(/\s+/).map(bare).filter(Boolean);
    if (toks.some((w) => known.has(w))) return true;
    return e.ctx?.kind === 'emote' && toks.length === 1 && !TEXT_ONLY.has(raw(e));
  });
  const renderFail = emoteLines.filter((e) => {
    const toks = raw(e).split(/\s+/).map(bare).filter(Boolean);
    const shown = new Set(e.ctx?.codes || []);
    if (toks.length === 1 && e.ctx?.kind === 'emote') return !shown.has(toks[0]);
    return toks.some((w) => known.has(w) && !shown.has(w));
  }).length;

  // 9. speech echo — only lines generated while the streamer had just spoken
  const heard = model.filter((e) => e.ctx?.speech);
  const speechEchoN = heard.filter((e) => echoesSpeech(raw(e), e.ctx.speech)).length;

  // 6. ban latency — first chat line after each mod action
  const latencies = mods.map((m) => {
    const after = chat.find((e) => ts(e) > ts(m));
    return after ? ts(after) - ts(m) : null;
  }).filter((v) => v !== null);
  const banMs = latencies.length ? Math.min(...latencies) : null;

  const pct = (v) => (v * 100).toFixed(1) + '%';
  const m = metrics(events); // laws 2,3,5,6 reuse metrics() — same shape both sides
  const rows = [
    { key: 'captionEcho', value: echoSampled ? echoN / echoSampled : null,
      detail: `${echoN}/${echoSampled} model lines`, kind: 'max' },
    { key: 'question', value: chat.length ? questions / chat.length : null,
      detail: `${questions}/${chat.length} lines`, kind: 'range' },
    { key: 'emote', value: (hasCodes || codeSet.size) && chat.length ? emotes / chat.length : null,
      detail: `${emotes}/${chat.length} lines`, kind: 'max',
      unavailable: !hasCodes && !codeSet.size ? 'log has no emote codes' : '' },
    { key: 'bigram', value: bigrams.length ? bigramRatio : null,
      detail: `${new Set(bigrams).size}/${bigrams.length} bigrams`, kind: 'min', informational: true },
    { key: 'burst', value: burst, detail: burst === null ? 'no scene changes in the log'
      : `${burst.toFixed(2)}× baseline`, kind: 'min',
      unavailable: burst !== null && blanketed ? 'captions change continuously — not measurable here' : '' },
    { key: 'banLatency', value: banMs, detail: banMs === null ? `${mods.length} mod actions logged` : `${banMs}ms`,
      kind: 'max', unavailable: banMs === null ? 'no mod actions in the log' : '' },
    { key: 'templateRepeat', value: tmplN >= 6 ? tmplRepeat / tmplN : null,
      detail: `${tmplRepeat}/${tmplN} template lines`, kind: 'max',
      unavailable: tmplN < 6 ? `only ${tmplN} culture/spot/relief/mood lines — not enough to judge` : '' },
    { key: 'unsafe', value: unsafeN / chat.length, detail: `${unsafeN}/${chat.length} lines`, kind: 'max' },
    { key: 'personaLeak', value: model.length ? leakN / model.length : null,
      detail: `${leakN}/${model.length} model lines`, kind: 'max' },
    { key: 'junk', value: model.length ? junkN / model.length : null,
      detail: `${junkN}/${model.length} model lines`, kind: 'max' },
    { key: 'emoteRender', value: emoteLines.length ? renderFail / emoteLines.length : null,
      detail: `${renderFail}/${emoteLines.length} emote lines`, kind: 'max',
      unavailable: !hasCodes ? 'log has no rendered emote codes' : emoteLines.length ? '' : 'no emote lines' },
    { key: 'emoteOnly', value: chat.length ? m.pctEmoteOnly / 100 : null,
      detail: `${Math.round(m.pctEmoteOnly * chat.length / 100)}/${chat.length} lines`, kind: 'max' },
    { key: 'oneLineUser', value: chat.length ? m.pctOneLineUser / 100 : null,
      detail: `${m.uniqueViewers} distinct speakers`, kind: 'range' },
    { key: 'namesChatter', value: chat.length ? m.pctNamesChatter / 100 : null,
      detail: `${Math.round(m.pctNamesChatter * chat.length / 100)}/${chat.length} lines`, kind: 'range' },
    { key: 'reply', value: chat.length ? m.pctReply / 100 : null,
      detail: `${Math.round(m.pctReply * chat.length / 100)}/${chat.length} lines`, kind: 'range' },
    { key: 'oneWord', value: chat.length ? m.pctOneWord / 100 : null,
      detail: `${Math.round(m.pctOneWord * chat.length / 100)}/${chat.length} lines`, kind: 'range' },
    { key: 'repeat', value: chat.length ? m.pctRepeat / 100 : null,
      detail: `${Math.round(m.pctRepeat * chat.length / 100)}/${chat.length} lines`, kind: 'range' },
    { key: 'caps', value: chat.length ? m.pctCaps / 100 : null,
      detail: `${Math.round(m.pctCaps * chat.length / 100)}/${chat.length} lines`, kind: 'range' },
    { key: 'exclam', value: chat.length ? m.pctExclam / 100 : null,
      detail: `${Math.round(m.pctExclam * chat.length / 100)}/${chat.length} lines`, kind: 'max' },
    { key: 'ellipsis', value: chat.length ? m.pctEllipsis / 100 : null,
      detail: `${Math.round(m.pctEllipsis * chat.length / 100)}/${chat.length} lines`, kind: 'max' },
    { key: 'speechEcho', value: heard.length >= 5 ? speechEchoN / heard.length : null,
      detail: `${speechEchoN}/${heard.length} speech-context lines`, kind: 'max',
      unavailable: heard.length < 5 ? `only ${heard.length} lines written after the streamer spoke` : '' },
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
    const ok = r.informational ? true
      : r.kind === 'max' ? r.value <= spec.max
      : r.kind === 'min' ? r.value >= spec.min
      : r.value >= spec.min && r.value <= spec.max;
    if (!ok) failed++;
    const shown = r.key === 'banLatency' ? `${Math.round(r.value)}ms` : pct(r.value);
    const bound = r.kind === 'max' ? `≤ ${spec.max}` : r.kind === 'min' ? (spec.max === undefined ? `> ${spec.min}` : `${spec.min}–${spec.max}`) : `${spec.min}–${spec.max}`;
    console.log(`  ${r.informational ? 'INFO' : ok ? 'PASS' : 'FAIL'}  ${spec.label.padEnd(70)} ${shown} (want ${bound}) ${r.detail}`);
  }
  console.log(`\n${failed === 0 ? 'rubric green' : `${failed} metric(s) failing`} · ${skipped} unavailable`);
  process.exit(failed ? 1 : 0);

  // --------------------------------------------------------------------------

}
