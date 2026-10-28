// test-text.mjs — asserts over the shared text plumbing (js/text.js). Run:
//   node tools/test-text.mjs
// The browser path can't be exercised headlessly here; this covers the pure
// functions the runtime and the scorer both depend on.

import assert from 'node:assert/strict';
import { normTokens, jaccard, tooSimilar, echoesScene, reactionSeed, factCandidate } from '../js/text.js';

// reactionSeed: a topic, never a description
assert.equal(reactionSeed('A green background with a large white letter D.'), 'd');
assert.equal(reactionSeed('A green background with a large white letter D.').includes('green'), false);
assert.equal(reactionSeed('The scene is described with only stop words.'), 'scene described only');
assert.equal(reactionSeed(''), 'the stream');
assert.equal(reactionSeed('a the with'), 'the stream');

// echoesScene: the exact lines from docs/sample-chatlog-2026-10-27.json
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
  'my name is jordan',
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

console.log(`ok — ${6 + 4 + 10 + 5 + 20} assertions over js/text.js`);
