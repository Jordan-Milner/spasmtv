// test-culture.mjs — asserts over the §D culture loop (js/culture.js).
//   node tools/test-culture.mjs

import assert from 'node:assert/strict';
import {
  FACTIONS, factionFor, cultureLine, patternOf, trollWeight, defies, moodOf,
  MOOD_GAP, ONLOOKER_LINES, RELIEF_LINES, spotLine, DEAD_CHAT_LINES,
} from '../js/culture.js';

const mulberry = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let x = Math.imul(a ^ (a >>> 15), 1 | a);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

// pattern extraction: what the victim kept saying is what chat learns to avoid
assert.equal(
  patternOf([{ text: 'cringe cringe cringe stream' }, { text: 'so cringe' }, { text: 'cringe lol' }]),
  'cringe');
assert.equal(patternOf([{ text: 'anyone know a good pdf editor' }]), 'editor');
assert.equal(patternOf([]), '');
assert.ok(patternOf([{ text: 'skill issue' }, { text: 'skill issue fr' }]).includes('skill'));

// factions: trolls defend trolls, parasocials side with the mod
{
  const rnd = mulberry(7);
  const counts = {};
  for (let i = 0; i < 4000; i++) {
    const f = factionFor('troll', rnd);
    counts[f] = (counts[f] || 0) + 1;
  }
  assert.ok(counts.critic / 4000 > 0.6, 'trolls mostly attack the mods');
  const para = {};
  for (let i = 0; i < 4000; i++) { const f = factionFor('parasocial', rnd); para[f] = (para[f] || 0) + 1; }
  assert.ok(para.bootlicker / 4000 > 0.6, 'parasocials defend the mod');
  assert.equal(factionFor('lurker', rnd), 'mourner');
  for (const k of Object.keys(FACTIONS))
    assert.ok(Object.keys(FACTIONS).includes(factionFor(k, rnd)), `${k} maps to a real faction`);
}

// faction lines substitute the victim and never leak the placeholder
{
  const rnd = mulberry(11);
  for (let i = 0; i < 300; i++) {
    for (const f of Object.keys(FACTIONS)) {
      const line = cultureLine(f, 'lilmoth99', rnd);
      assert.ok(line && !line.includes('{name}'), `unsubstituted: ${line}`);
    }
  }
  assert.ok(cultureLine('critic', 'x').length > 0);
}

// entropy without moderation: troll share climbs the longer the mods stay quiet
assert.equal(trollWeight(0, 0), 1);
assert.ok(trollWeight(5 * 60e3, 0) > 1.9 && trollWeight(5 * 60e3, 0) <= 2.01);
assert.ok(trollWeight(30 * 60e3, 0) <= 3.01, 'capped at 3x');
assert.ok(trollWeight(Date.now(), Date.now()) === 1, 'a fresh ban suppresses trolls');
assert.ok(trollWeight(60e3, 0) > trollWeight(10e3, 0), 'monotonic in silence');

// defiance: trolls break the standing rule, everyone else mostly obeys
{
  const rnd = mulberry(3);
  let t = 0, l = 0;
  for (let i = 0; i < 6000; i++) { if (defies('troll', 'cringe', rnd)) t++; if (defies('lurker', 'cringe', rnd)) l++; }
  assert.ok(t / 6000 > 0.32 && t / 6000 < 0.48, `troll defiance ${(t / 6000).toFixed(2)}`);
  assert.ok(l / 6000 < 0.08, `lurker defiance ${(l / 6000).toFixed(2)}`);
  assert.equal(defies('troll', '', rnd), false, 'no rule, no rebellion');
}

// mood drift + its effect on cadence
const now = Date.now();
assert.equal(moodOf([], now), 'calm');
assert.equal(moodOf([{ t: now - 1000 }], now), 'calm');
assert.equal(moodOf([{ t: now - 1000 }, { t: now - 2000 }], now), 'tense');
assert.equal(moodOf([{ t: now }, { t: now }, { t: now }, { t: now }], now), 'purge');
assert.equal(moodOf([{ t: now - 400e3 }, { t: now - 400e3 }, { t: now - 400e3 }, { t: now - 400e3 }], now), 'calm',
  'a purge from 7 minutes ago is over');
assert.ok(MOOD_GAP.purge > MOOD_GAP.tense && MOOD_GAP.tense > MOOD_GAP.calm);

// centering beats exist for every archetype and substitute nothing
for (const k of ['troll', 'earnest', 'parasocial', 'hype-man', 'doomer', 'regular', 'lurker'])
  assert.ok(spotLine(k, mulberry(5)).length > 3, `spot line for ${k}`);
assert.ok(ONLOOKER_LINES.every((l) => typeof l === 'string' && l.length > 2));
assert.ok(ONLOOKER_LINES.filter((l) => l.includes('{name}')).length >= 3, 'onlookers name the victim');
assert.ok(RELIEF_LINES.length >= 4 && DEAD_CHAT_LINES.length >= 4);

console.log('ok — culture: pattern, factions, troll entropy, defiance, mood, centering');
