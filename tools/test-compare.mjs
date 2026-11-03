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
import { metrics, compare, sceneLinkage, EMOTE_HINT_SET, burstRatio } from '../tools/score-chat.mjs';

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

// --- law metrics (2,3,5,6): the social/voice numbers the honest bands use ---
// A room where half the speakers are one-timers, some lines name/reply, and
// words/punctuation land in band. Asserts metrics() computes them from BOTH the
// sim (ctx.viewer/ctx.replyTo) and real (name/replyTo) shapes.
{
  let t = 0;
  const sim = [];
  // 20 one-time speakers + 4 regulars (→ ~20/24 one-line users ≈ 83%)
  for (let i = 0; i < 20; i++) { t += 3; sim.push(simLine(t, `one_timer_${i}`, 'nice play')); }
  for (let i = 0; i < 8; i++) { t += 3; sim.push(simLine(t, 'regular', 'gg', { ctx: { replyTo: i % 2 ? { text: 'x' } : null } })); }
  // a couple that name another chatter by @handle and by bare nickname
  sim.push(simLine(t += 3, 'regular', 'what do you think @one_timer_3'));
  const m = metrics(JSON.parse(`[${sim.join(',')}]`));
  assert.ok(m.pctOneLineUser > 60, `one-line users should be high, got ${m.pctOneLineUser}`);
  assert.ok(m.pctReply > 0, 'reply rate should be > 0 (ctx.replyTo)');
  assert.ok(m.pctNamesChatter > 0, 'names-a-chatter should detect @handle');
  assert.ok(m.pctOneWord > 0, 'one-word rate counted');
  // real shape: replyTo is a login-name string, name is the speaker
  const real = [];
  real.push(realLine(1000, 'alice', 'hello there'));
  real.push(realLine(2000, 'bob', 'hi alice'));
  for (let i = 0; i < 9; i++) real.push(realLine(3000 + i * 1000, `u${i}`, 'lol'));
  const rm = metrics(JSON.parse(`[${real.join(',')}]`));
  assert.ok(rm.pctNamesChatter > 0, 'real shape: bare nickname names a present chatter');
}

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

// --- IRC ground truth beats the hint-set guess -----------------------------
// Twitch sends exact emote byte-ranges and USERNOTICE/CLEARCHAT rows. Reading
// them is what made both sides of '% with emote' the same measurement; treating
// notices as chat lines previously polluted every length metric on the real side.
{
  const rows = [];
  for (let i = 0; i < 11; i++)
    rows.push({ t: i * 60000, name: `u${i}`, text: 'nice play go', cmd: 'PRIVMSG' });
  rows.push({ t: 61000, name: 'u1', text: 'KEKW hello', cmd: 'PRIVMSG', emotes: '25:0-3' });
  rows.push({ t: 62000, name: 'u2', text: 'KEKW', cmd: 'PRIVMSG', emotes: '25:0-3' });
  rows.push({ t: 300000, name: 'sub4', text: 'sub4 has subscribed!', cmd: 'USERNOTICE' });
  const m = metrics(rows);
  assert.equal(m.n, 13, 'USERNOTICE is a notice, not a chat line');
  assert.equal(m.pctEmoteOnly > 0, true, 'emote-only counted from IRC ranges, no hint set');
  assert.ok(m.pctEmote > m.pctEmoteOnly, 'one ranged line has words left, so it is not emote-only');
  // a single-emote line must count too — the id-before-colon format silently
  // dropped every one of these the first time this parser was written
  assert.ok(Math.abs(m.pctEmote - 100 * 2 / 13) < 0.01, `both ranged lines counted, got ${m.pctEmote}`);
  // 1 notice over a 10-minute span = 0.1/min. The old formula returned per
  // SECOND (60x off) and a ±0.8 tolerance hid it.
  assert.ok(Math.abs(m.noticesPerMin - 0.1) < 0.01, `notices/min should be ~0.1, got ${m.noticesPerMin}`);
}

// --- sceneLinkage: the only metric that tests invariant #1 -----------------
// Lines are bucketed by whether they were handed a frame, and lines written
// while the streamer had just spoken are excluded (reacting to the mic is a
// different core job, not a failure to watch).
{
  const line = (text, scene, sawFrame, extra = {}) =>
    ({ kind: 'chat', text, ctx: { model: true, scene, sawFrame, ...extra } });
  const chat = [
    line('the boss fight took forever', 'a hard boss fight fills the screen', true),
    line('lol', 'a hard boss fight fills the screen', true),
    line('based', 'a hard boss fight fills the screen', true, { speech: 'i died again' }),
    line('just got here', 'a cat sits on a keyboard', false),
    line('nice', 'a cat sits on a keyboard', false),
    { kind: 'chat', text: 'boss', ctx: { model: false, scene: 'a hard boss fight', sawFrame: true } },
    { kind: 'chat', text: 'no caption logged', ctx: { model: true, sawFrame: true } },
  ];
  const l = sceneLinkage(chat);
  assert.equal(l.frame.n, 2, 'only frame lines with a caption, no speech, model-written');
  assert.equal(l.frame.rate, 0.5, 'one of two frame lines echoes its caption');
  assert.equal(l.blind.n, 2, 'no-frame bucket counted separately');
  assert.equal(l.blind.rate, 0, 'a chat that never saw the frame cannot link to it');
  assert.equal(sceneLinkage([]).frame.rate, null, 'nothing to judge -> n/a, not 0');
}

console.log('ok — compare: MATCH exits 0, MISS exits 1, tolerances honoured');
