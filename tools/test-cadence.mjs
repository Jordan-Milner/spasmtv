// test-cadence.mjs — simulate the §C scheduler in node and assert the rate
// budget. Today's shipped cadence (docs/sample-chatlog-2026-10-27.json) is
// 95 lines / 4.76 min = 19.9 lines/min, one generate call per line; the bursty
// scheduler must not exceed that on either axis.
//   node tools/test-cadence.mjs

import assert from 'node:assert/strict';
import {
  KIND_WEIGHTS, pickKind, gateKind, nextGapMs, planBurst, templateLine,
  maybeBit, liveBits, ASKERS,
} from '../js/cadence.js';

const MINUTES = 30;
// seeded rng so the budget assertion is reproducible, not a coin flip
const mulberry = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let x = Math.imul(a ^ (a >>> 15), 1 | a);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
const rnd = mulberry(20261028);
let t = 0, lines = 0, genCalls = 0;
let droughts = 0, flurries = 0, chants = 0, chantLines = 0, picked = 0, maxGap = 0, flurrySpread = 0;
const kindCount = {};

while (t < MINUTES * 60_000) {
  const gap = nextGapMs(rnd);
  maxGap = Math.max(maxGap, gap);
  if (gap >= 4000) droughts += 1;
  t += gap;

  const burst = planBurst(rnd);
  if (burst.n >= 3) { flurries += 1; flurrySpread = Math.max(flurrySpread, burst.offsets.at(-1)); }
  if (burst.chant) chants += 1;

  for (let i = 0; i < burst.n; i++) {
    lines += 1;
    if (burst.chant) {                 // a chant is the same emote from 3 viewers
      chantLines += 1;
      continue;                        // template-only, no kind picked, no GPU
    }
    const kind = pickKind(rnd);
    kindCount[kind] = (kindCount[kind] || 0) + 1;
    picked += 1;
    if (kind !== 'emote') genCalls += 1;   // emote lines are templates too
  }
}

const perMin = (n) => n / MINUTES;
console.log(`sim ${MINUTES} min: ${lines} lines (${perMin(lines).toFixed(1)}/min), ` +
  `${genCalls} generate calls (${perMin(genCalls).toFixed(1)}/min), ` +
  `${droughts} droughts, ${flurries} flurries (${flurries / MINUTES | 0}/min), ${chants} chants, ` +
  `max gap ${(maxGap / 1000).toFixed(1)}s, flurry spread ${flurrySpread.toFixed(0)}ms`);
console.log('kind mix:', Object.entries(kindCount)
  .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / lines * 100).toFixed(0)}%`).join(' '));

assert.ok(perMin(lines) <= 20, `lines/min ${perMin(lines).toFixed(1)} exceeds today's 20`);
assert.ok(perMin(genCalls) <= 20, `gen calls/min ${perMin(genCalls).toFixed(1)} exceeds today's 20`);
assert.ok(perMin(genCalls) < perMin(lines) * 0.95, 'template lines should cut GPU load below line rate');
assert.ok(droughts / MINUTES > 0.5, 'chat needs droughts (4–8 s of silence)');
assert.ok(maxGap >= 6000, 'a drought should reach 6 s somewhere in 30 min');
assert.ok(flurries / MINUTES > 0.3, 'chat needs flurries');
assert.ok(flurrySpread <= 1500 && flurrySpread > 700, 'a flurry must be 3 lines inside 1.5 s');
assert.ok(chants > 0, 'chants (one emote, many viewers) should happen');

// kind mix roughly follows the §C weights (chant lines are template-only and
// sit outside the pick, so they're excluded here)
for (const [k, w] of Object.entries(KIND_WEIGHTS)) {
  const share = (kindCount[k] || 0) / picked;
  assert.ok(Math.abs(share - w / 100) < 0.07, `${k} share ${(share * 100).toFixed(0)}% vs weight ${w}%`);
}
assert.ok(chantLines > 0 && (kindCount.emote || 0) > 0, 'template lines exist');
assert.equal(lines - genCalls, chantLines + (kindCount.emote || 0), 'every non-model line is a template');

// gateKind degradation — no interrogating doomers, no callbacks with no bits
assert.equal(gateKind('question', { archetypeKey: 'hype-man' }), 'reaction');
assert.equal(gateKind('question', { archetypeKey: 'earnest' }), 'question');
assert.ok(ASKERS.has('newcomer') && ASKERS.has('parasocial') && !ASKERS.has('hype-man'));
assert.match(templateLine('question'), /\?$/);   // the question fallback always asks
assert.equal(gateKind('callback', { archetypeKey: 'regular' }, { bits: [] }), 'reaction');
assert.equal(gateKind('callback', { archetypeKey: 'regular' }, { bits: [{ text: 'x', until: 1 }] }), 'callback');
assert.equal(gateKind('reply', {}, { recent: [] }), 'banter');
assert.equal(gateKind('reply', {}, { recent: ['a line'] }), 'reply');
assert.equal(gateKind('greeting', {}, { hype: false }), 'meta');
assert.equal(gateKind('greeting', {}, { hype: true }), 'greeting');
assert.equal(gateKind('banreact', {}, {}), 'banreact', 'ban reactions pass through');

// template lines never come back empty for the emote kind, and never for others
for (let i = 0; i < 200; i++) {
  assert.equal(templateLine('reaction'), null, 'non-emote kinds are model-written');
  assert.ok(templateLine('emote').length > 0);
  assert.equal(templateLine('emote', { chant: 'PPog' }), 'PPog');
}
assert.ok(templateLine('emote', { hype: true }, undefined) !== undefined);

// bits: one at a time, deduped, expiring, only during hype
let bits = [];
bits = maybeBit(bits, 'green mode activated', { hype: false });
assert.equal(bits.length, 0, 'no bit without hype');
for (let i = 0; i < 400 && !bits.length; i++)
  bits = maybeBit(bits, 'green mode activated', { hype: true });
assert.equal(bits.length, 1);
assert.equal(maybeBit(bits, 'green mode activated', { hype: true }).length, 1, 'deduped');
assert.equal(liveBits(bits, Date.now() + 601e3).length, 0, 'bits expire');
assert.equal(liveBits(bits, Date.now()).length, 1);
assert.equal(maybeBit(bits, 'x'.repeat(60), { hype: true }).length, 1, 'too long to be a bit');

console.log('ok — cadence budget, kind mix, gating, templates and bits all hold');
