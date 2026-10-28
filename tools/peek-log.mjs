// peek-log.mjs — quick human read of a browser-run log: kind mix, archetype
// spread, caption-echo rate, emote rate, lines/min. The graded version of this
// is tools/score-chat.mjs (§F); this one just prints the lines.
//   node tools/peek-log.mjs /tmp/svt-run3.jsonl

import { readFileSync } from 'node:fs';
import { echoesScene } from '../js/text.js';

const file = process.argv[2];
const ev = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const chat = ev.filter((e) => e.kind === 'chat');
const capTexts = ev.filter((e) => e.kind === 'caption').map((e) => e.text);

const kinds = {}, arch = {};
let model = 0, tmpl = 0, echo = 0, emote = 0, dup = 0, smash = 0, emoji = 0, long = 0, shouty = 0;
const codes = new Set();
for (const c of chat)
  (c.ctx?.emotes || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((x) => codes.add(x));

// same shape check the worker rejects with (workers/llm-worker.js keysmash)
const keysmash = (s) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4)
  .filter((w) => !/[aeiouy]/.test(w)).length >= 2;

const seen = new Set();
for (const c of chat) {
  const x = c.ctx || {};
  kinds[x.kind] = (kinds[x.kind] || 0) + 1;
  arch[x.archetype] = (arch[x.archetype] || 0) + 1;
  x.model === false ? tmpl++ : model++;
  const shown = x.shown || c.text;
  if (x.scene && echoesScene(shown, x.scene)) echo++;
  if ((shown.match(/[A-Za-z]{2,}/g) || []).some((w) => codes.has(w))) emote++;
  if (keysmash(shown)) smash++;
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(shown)) emoji++;
  if (shown.split(/\s+/).length > 12) long++;
  const letters = shown.replace(/[^A-Za-z]/g, '');
  if (letters.length > 4 && letters === letters.toUpperCase()) shouty++;
  const key = shown.toLowerCase();
  if (seen.has(key)) dup++; else seen.add(key);
}
const spanMs = new Date(chat.at(-1)?.t) - new Date(chat[0]?.t);
console.log(`chat ${chat.length} (model ${model}, template ${tmpl}) over ${(spanMs / 60000).toFixed(1)} min`
  + ` = ${(chat.length / (spanMs / 60000)).toFixed(1)} lines/min`);
console.log(`captions ${capTexts.length} · caption echoes ${echo} · exact dupes ${dup}`);
console.log(`emote-bearing ${emote} · keysmash ${smash} · emoji ${emoji} · >12 words ${long} · all-caps ${shouty}`);
console.log('kinds     ', JSON.stringify(kinds));
console.log('archetypes', JSON.stringify(arch));
console.log('\n--- lines ---');
for (const c of chat)
  console.log(`${(c.ctx?.archetype || '-').padEnd(10)} ${(c.ctx?.kind || '-').padEnd(9)} ${(c.ctx?.shown || c.text)}`);
console.log('\n--- last captions ---\n' + capTexts.slice(-3).join('\n'));
