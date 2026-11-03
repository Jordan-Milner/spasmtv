import fs from 'node:fs';
import { sceneLinkage } from '/Users/jordan/Projects/twitch-sim/tools/score-chat.mjs';

const dir = process.argv[2] || decodeURIComponent(new URL('.', import.meta.url).pathname);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
const rows = [];
for (const f of files) {
  let l;
  try { l = fs.readFileSync(dir + '/' + f, 'utf8').trim().split('\n').map(JSON.parse); } catch { continue; }
  const chat = l.filter((e) => e.kind === 'chat');
  if (chat.length < 10) continue;
  const model = chat.filter((e) => e.ctx?.model !== false);
  if (!model.length) continue;
  // era, proven by the fields the run itself emitted (a cached old module
  // cannot emit a field it does not know about)
  const hasHist = model.some((e) => Array.isArray(e.ctx.sceneHistory) && e.ctx.sceneHistory.length);
  const hasFrame = model.some((e) => typeof e.ctx.sawFrame === 'boolean');
  const hasPrompt = model.some((e) => typeof e.ctx.prompt === 'string');
  const l2 = sceneLinkage(chat);
  rows.push({ f, mt: l[0]?.t || '', chat: chat.length, model: model.length,
    hist: hasHist, frame: hasFrame, prompt: hasPrompt,
    n: l2.all.n, rate: l2.all.rate, fn: l2.frame.n, fr: l2.frame.rate });
}
const pct = (v) => (v === null ? '  n/a' : (v * 100).toFixed(0).padStart(4) + '%');
rows.sort((a, b) => a.mt.localeCompare(b.mt));
console.log('run                    when              chat mod hist prm  all:n  all:rate  frame:n frame:rate');
for (const r of rows) console.log(
  r.f.replace('.jsonl', '').padEnd(22), r.mt.slice(5, 16).padEnd(16),
  String(r.chat).padStart(4), String(r.model).padStart(3),
  (r.hist ? 'yes' : 'no ').padStart(5), (r.frame ? 'F' : ' ').padStart(2), (r.prompt ? 'P' : ' ').padStart(2),
  String(r.n).padStart(6), pct(r.rate).padStart(9), String(r.fn).padStart(7), pct(r.fr).padStart(10));

const grp = (label, pred) => {
  const g = rows.filter(pred && pred);
  const judged = g.filter((r) => r.rate !== null);
  if (!judged.length) return console.log(`  ${label.padEnd(34)} no runs with a judgeable line`);
  const tot = judged.reduce((s, r) => s + r.n, 0);
  const hit = judged.reduce((s, r) => s + r.rate * r.n, 0);
  console.log(`  ${label.padEnd(34)} ${judged.length} runs, ${tot} lines, pooled ${(100 * hit / tot).toFixed(1)}%` +
    `  (per-run ${Math.min(...judged.map((r) => r.rate)) * 100 | 0}-${Math.max(...judged.map((r) => r.rate)) * 100 | 0}%)`);
};
console.log('\npooled by what the run proves it ran:');
grp('no sceneHistory field (pre-temporal)', (r) => !r.hist);
grp('sceneHistory present (temporal code)', (r) => r.hist);
grp('  ...and logged sawFrame (current)', (r) => r.hist && r.frame);
