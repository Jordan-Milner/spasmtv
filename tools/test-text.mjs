// test-text.mjs — asserts over the shared text plumbing (js/text.js). Run:
//   node tools/test-text.mjs
// The browser path can't be exercised headlessly here; this covers the pure
// functions the runtime and the scorer both depend on.

import assert from 'node:assert/strict';
import {
  normTokens, jaccard, tooSimilar, echoesScene, reactionSeed, factCandidate,
  unsafeLine, safeEmote, personaLeak, junkLine, echoesSpeech,
} from '../js/text.js';
import { CANNED_POOL } from '../js/real-lines.js';
import { FACTIONS, DEAD_CHAT_LINES, ONLOOKER_LINES, RELIEF_LINES, spotLine } from '../js/culture.js';
import { PASTAS, TEXT_FILLS, templateLine } from '../js/cadence.js';
import { ARCHETYPE_KEYS } from '../js/chat-sim.js';

// reactionSeed: a topic, never a description
assert.equal(reactionSeed('A green background with a large white letter D.'), 'd');
assert.equal(reactionSeed('A green background with a large white letter D.').includes('green'), false);
assert.equal(reactionSeed('The scene is described with only stop words.'), 'scene described only');
assert.equal(reactionSeed(''), 'the stream');
assert.equal(reactionSeed('a the with'), 'the stream');

// echoesScene: the exact lines from the v1.1 sample log (2026-10-27)
const CAP = 'A green background with a large white letter D and some numbers at the top left corner.';
for (const bad of [
  'A green background with a large white letter D',
  'green background white letter d',
  'green letter d',
  'numbers top left',
]) assert.equal(echoesScene(bad, CAP), true, `should catch echo: ${bad}`);

for (const good of [
  'F', 'KEKW', 'mods are awake', 'he was funny tho', 'what did he even do',
  'this is who i am now…', 'no no go LEFT', 'first time here what is going on',
  'streamer is back??', 'i have been here every stream',
]) assert.equal(echoesScene(good, CAP), false, `should pass: ${good}`);

// jaccard + dedupe threshold behaviour
assert.equal(jaccard('a b c', 'a b c'), 1);
assert.equal(jaccard('a b', 'c d'), 0);
assert.equal(tooSimilar('', ['anything']), true);            // empty line is always a reject
assert.equal(tooSimilar('green background white square', ['green background white square'], 0.75), true);
assert.equal(tooSimilar('F', ['green background white square'], 0.75), false);
assert.equal(normTokens('Hello, WORLD!! 42').join('|'), 'hello|world|42');

// factCandidate: "not everything the streamer says is a memory." Real talk from
// a stream (the reject column) vs durable biography (the keep column) — the
// gate is deliberately biased to reject.
for (const keep of [
  'my name is sam',
  'i live in glasgow',
  'i have two dogs and a cat',
  'i used to work in a kitchen',
  'i like fishing more than golf',
  "i'm from new zealand originally",
  'i was born in september',
  'we have a studio in the garage',
]) assert.equal(factCandidate(keep), true, `should keep: ${keep}`);

for (const reject of [
  'hold on one second',              // filler
  'look at this thing i have',       // command opener
  'wait wait wait',                  // too short + filler
  'what is that',                    // question, no signal
  'yeah that was so funny',          // reaction, no signal
  'chat stop spamming please',       // addressed at chat
  "im tired today",                  // transient mood + today
  "i'm going to the shop",           // motion, not biography
  'ok so my name is actually graham',// filler opener (acceptable loss)
  'you know i have two dogs',        // second person (acceptable loss)
  'the stream is dying today',       // stream talk, no first person
  'brb getting coffee',              // filler
]) assert.equal(factCandidate(reject), false, `should reject: ${reject}`);

// output safety: the lines that actually came out of the 2026-10-28 runs, plus
// the innocent words that share letters with a blocked one
let n2 = 0;
const check = (fn, s, want, msg) => { assert.equal(fn(s), want, `${msg}: ${s}`); n2++; };
for (const bad of ['breathe crunch smashfuckr', 'TwaT', 'Gayge lol', 'kys', 'just kill yourself',
  'ugly cam', 'so fat lol', 'he is naked',
  "You appear to be having an affair with the woman you're posing for", 'is that your girlfriend'])
  check(unsafeLine, bad, true, 'should be unsafe');
// (roots match inside words, so "Scunthorpe" is a known, accepted false positive)
for (const ok of ['grape juice', 'skyscraper', 'shelf', 'the drape', 'cocktail time',
  'what are you playing?', 'KEKW', 'retake that', 'fatal error lol', 'dickens fan',
  'hes cheating lol', 'your aim is cursed'])
  check(unsafeLine, ok, false, 'should be safe');
for (const code of ['c!', 'w!', 'TwaT', 'Gayge', 'gachiGASM']) check(safeEmote, code, false, 'emote blocked');
for (const code of ['KEKW', 'LuL', 'Clap', 'D:', 'FeelsGoodMan']) check(safeEmote, code, true, 'emote allowed');

// persona leakage: the brief coming back as chat (fast run 2026-10-28)
for (const bad of ['HYPEMAN', 'Reaction like a troll says nothing.', 'reacts like a regular…',
  'troll replay in cartoon cap draw', 'reaction by chatterline', 'I\'M NOT SURE HOW TO REACT',
  'on screen just changed…', 'on screen, random drawn thing i see… DuckerZ', 'onscreen hugs',
  'On screen, too much hate', 'No emotes allowed, keep your voice', 'max 12 words hey'])
  check(personaLeak, bad, true, 'should leak');
for (const ok of ['no way', 'back to lurking', 'that was clean', 'viewers going up', 'hype hype hype',
  'whats that on screen', 'put it on screen again', 'the screen is so dark'])
  check(personaLeak, ok, false, 'should not leak');

// junk: the phone brain's failure shape; @ only for someone in the room
for (const bad of ['@@/234506579', '@bryan@fergie@gabe_', '@mikebunney So i hope all i', '%%%% ##', 'call 5551234567'])
  check(junkLine, bad, true, 'should be junk');
for (const ok of ['F', 'no shot', 'ok that was clean', 'GG 2024', ':tf:'])
  check(junkLine, ok, false, 'should not be junk');
assert.equal(junkLine('@xrat99 true', ['xrat99']), false); n2++;
assert.equal(junkLine('@xrat99 true', ['moth']), true); n2++;

// speech echo: repeating the streamer back is not a reaction
const SAID = 'Hey everyone, welcome back to the stream, today we are drawing Mario with a big red cap, and I forgot my coffee again.';
for (const bad of ['Welcome back to the stream!', 'welcomeback', 'Hey everyone!', 'welcome back today', 'drawing mario'])
  assert.equal(echoesSpeech(bad, SAID), true, `should echo: ${bad}`), n2++;
for (const ok of ['welcome!', 'Forgot coffee? Stay up!', 'Mario\'s got a big red cap, wobbling', 'no cup', 'KEKW'])
  assert.equal(echoesSpeech(ok, SAID), false, `should pass: ${ok}`), n2++;
assert.equal(echoesSpeech('anything', ''), false); n2++;

// every line the app writes WITHOUT a model passes the same reject list the
// worker applies to model lines — a canned line must never be the unsafe one
const canned = [...CANNED_POOL, ...DEAD_CHAT_LINES, ...ONLOOKER_LINES, ...RELIEF_LINES, ...PASTAS,
  ...TEXT_FILLS, ...Object.values(FACTIONS).flat()];
for (const k of ARCHETYPE_KEYS) for (let i = 0; i < 20; i++) canned.push(spotLine(k));
for (let i = 0; i < 40; i++) canned.push(templateLine('question'));
for (const l of canned) {
  const t = String(l).replace(/\{name\}/g, 'moth');
  assert.equal(unsafeLine(t), false, `canned line is unsafe: ${t}`);
  assert.equal(personaLeak(t), false, `canned line leaks the brief: ${t}`);
  n2 += 2;
}

console.log(`ok — ${6 + 4 + 10 + 5 + 20 + n2} assertions over js/text.js + every canned line`);
