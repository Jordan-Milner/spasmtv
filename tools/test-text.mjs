// test-text.mjs — asserts over the shared text plumbing (js/text.js). Run:
//   node tools/test-text.mjs
// The browser path can't be exercised headlessly here; this covers the pure
// functions the runtime and the scorer both depend on.

import assert from 'node:assert/strict';
import { normTokens, jaccard, tooSimilar, echoesScene, reactionSeed } from '../js/text.js';

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

console.log(`ok — ${6 + 4 + 10 + 5} assertions over js/text.js`);
