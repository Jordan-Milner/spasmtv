// test-compare.mjs — §B self-test for score-chat.mjs --compare. Synthesises a
// fake real-chat jsonl + a fake sim jsonl engineered to MATCH and to MISS two
// metrics, and asserts the verdicts + exit codes. No network, no video.
//
//   node tools/test-compare.mjs
//
// The compare logic lives in score-chat.mjs; this test imports the pure
// metrics() + compare() surface it exposes for testing, so it can assert on
// individual verdicts (not just the process exit code).

import assert from 'node:assert/strict';
import { metrics, compare, EMOTE_HINT_SET, burstRatio } from '../tools/score-chat.mjs';

// --- helpers to build jsonl ------------------------------------------------
const chatLine = (t, user, text, extra = {}) =>
  JSON.stringify({ t, kind: 'chat', text, ctx: { viewer: user, ...extra } });

const simLine = (t, user, text, opts = {}) =>
  chatLine(t, user, text, {
    kind: 'chat', archetype: 'regular',
    codes: opts.codes || [], model: true, ...(opts.ctx || {}),
  });
const realLine = (t, user, text) => chatLine(t, user, text, {});

const writeJsonl = (lines) => lines.join('\n') + '\n';

// --- MATCH case: engineered so every metric lands inside tolerance ----------
// shape: ~3-word lines, ~40% emotes, ~20% questions, ~8% caps, mild bursts.
const matchReal = [];
const matchSim = [];
{
  const emotes = new Set(['KEKW', 'LUL', 'PogU', 'W', 'F']);
  let t = 0;
  for (let i = 0; i < 60; i++) {
    t += 2 + Math.random() * 3;
    const q = i % 5 === 0;
    const caps = i % 12 === 0;
    const emote = i % 3 === 0;
    const words = q ? 'what are you playing now' : 'nice play go go';
    const wordList = words.split(' ');
    let text = wordList.join(' ');
    if (emote) text += ' KEKW';
    if (caps) text = text.toUpperCase();
    if (q) text += '?';
    const code = emote ? ['KEKW'] : [];
    matchReal.push(realLine(t, `user${i % 8}`, text));
    matchSim.push(simLine(t, `user${i % 8}`, text, { codes: code }));
  }
}

// --- MISS case: deliberately push two metrics OFF ---------------------------
// (1) median words/line too high (real ~6 vs sim ~3 → sim too short)
// (2) real question rate far above sim question rate
const missReal = [];
const missSim = [];
{
  let t = 0;
  // sim: short 3-word lines, almost no questions
  for (let i = 0; i < 40; i++) {
    t += 3;
    missSim.push(simLine(t, `s${i % 5}`, 'short line here', { codes: [] }));
  }
  // real: long descriptive lines, many questions
  t = 0;
  for (let i = 0; i < 40; i++) {
    t += 3;
    missReal.push(realLine(t, `r${i % 5}`, 'what is happening over here today' + (i % 2 ? '??' : '')));
  }
}

// --- metrics() sanity: counts what the spec says ----------------------------
{
  const real = JSON.parse(`[${matchReal.join(',')}]`);
  const sim = JSON.parse(`[${matchSim.join(',')}]`);
  const rm = metrics(real);
  const sm = metrics(sim);
  assert.ok(typeof rm.medianWords === 'number', 'real median words');
  assert.ok(typeof sm.p90Words === 'number', 'sim p90 words');
  assert.ok(rm.pctQuestion >= 0 && rm.pctQuestion <= 100, 'real % question');
  assert.ok(sm.burstiness >= 0, 'sim burstiness CV');
  assert.ok(sm.msgsViewerMin > 0, 'sim msgs/viewer/min');
}

// --- compare() MATCH: all verdicts MATCH, exit 0 ----------------------------
{
  const real = JSON.parse(`[${matchReal.join(',')}]`);
  const sim = JSON.parse(`[${matchSim.join(',')}]`);
  const res = compare(real, sim, 'match');
  assert.equal(res.exit, 0, `MATCH run should exit 0, got ${res.exit}`);
  for (const r of res.rows) {
    if (r.info) continue; // informational (top-10 overlap) is never a failure
    assert.equal(r.verdict, 'MATCH', `${r.metric} should MATCH`);
  }
}

// --- compare() MISS: the two engineered metrics are OFF, exit 1 ------------
{
  const real = JSON.parse(`[${missReal.join(',')}]`);
  const sim = JSON.parse(`[${missSim.join(',')}]`);
  const res = compare(real, sim, 'miss');
  assert.equal(res.exit, 1, `MISS run should exit 1, got ${res.exit}`);
  const off = res.rows.filter((r) => !r.info && r.verdict === 'OFF');
  assert.ok(off.length >= 2, `expected >=2 OFF, got ${off.length}`);
  // the two we engineered: median words/line and % question lines
  const offMetrics = new Set(off.map((r) => r.metric));
  assert.ok(offMetrics.has('median words/line'), 'median words should be OFF');
  assert.ok(offMetrics.has('% question lines'), 'question rate should be OFF');
}

// --- compare() honours the exact tolerances in the spec table --------------
{
  // a single-metric probe: push median words just OUTSIDE ±2 → OFF
  const real = [];
  const sim = [];
  let t = 0;
  for (let i = 0; i < 30; i++) { t += 3; sim.push(simLine(t, `s${i}`, 'one two', { codes: [] })); }
  for (let i = 0; i < 30; i++) { t += 3; real.push(realLine(t, `r${i}`, 'one two three four five six')); }
  const res = compare(JSON.parse(`[${real.join(',')}]`), JSON.parse(`[${sim.join(',')}]`), 'tol');
  const row = res.rows.find((r) => r.metric === 'median words/line');
  assert.equal(row.verdict, 'OFF', 'median words 2 apart should be OFF (tol ±2)');
  assert.equal(row.sim, 2, 'sim median words = 2');
  assert.equal(row.real, 6, 'real median words = 6');
}

// --- EMOTE_HINT_SET is a real, non-empty set (the emote approximation) -----
assert.ok(EMOTE_HINT_SET.size > 0, 'emote-hint set populated');
assert.ok(EMOTE_HINT_SET.has('kekw'), 'known emote in hint set (lower-cased keys)');

// --- metrics() rejects a malformed / empty log -----------------------------
assert.throws(() => metrics([]), /need at least/);

// --- burstRatio: clustered changes are one window, not many ---------------
{
  const ev = (s) => ({ t: new Date(1000000 + s * 1000).toISOString() });
  // 30 baseline lines over 300 s (6/min), then 6 changes 2 s apart each pulling
  // 3 lines in the next 3 s. Counting 6×10 s of window would read ~1.1×.
  const chat = [];
  for (let s = 0; s < 300; s += 10) chat.push(ev(s));
  const changes = [100, 102, 104, 106, 108, 110];
  for (const c of changes) for (const d of [0, 1, 2]) chat.push(ev(c + d));
  chat.sort((a, b) => new Date(a.t) - new Date(b.t));
  const { ratio, blanketed } = burstRatio(chat, changes.map((s) => new Date(1000000 + s * 1000).getTime()));
  assert.ok(ratio > 2, `clustered pile-on should read >2×, got ${ratio}`);
  assert.equal(blanketed, false, '6 windows out of 300 s is not a blanket');
  // a change every 5 s covers the whole timeline — the ratio is meaningless
  const flat = [];
  for (let s = 0; s < 100; s += 5) { flat.push(ev(s)); flat.push(ev(s + 1)); }
  const b2 = burstRatio(flat, Array.from({ length: 20 }, (_, i) => new Date(1000000 + i * 5000).getTime()));
  assert.equal(b2.blanketed, true, 'changes every 5 s blanket the span');
  assert.equal(burstRatio([], []).ratio, null, 'no changes → n/a');
}

console.log('ok — compare: MATCH exits 0, MISS exits 1, tolerances honoured');
