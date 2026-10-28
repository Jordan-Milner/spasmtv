// Flatten a collected corpus into plain text one file per room, for reading
// (by a human, or by a local model doing qualitative analysis). Emote spans get
// wrapped in [] so a reader can see them without knowing the id table.
//   node tools/swarm-inputs.mjs data/real/2026-10-28-round1.jsonl notes/swarm 220
import fs from 'node:fs';
import path from 'node:path';

const [src, outDir, perS] = process.argv.slice(2);
const PER = +perS || 200;
fs.mkdirSync(outDir, { recursive: true });
const byChan = new Map();
for (const line of fs.readFileSync(src, 'utf8').trim().split('\n')) {
  const e = JSON.parse(line);
  if (e.cmd !== 'PRIVMSG' && !e.notice) continue;
  if (!byChan.has(e.chan)) byChan.set(e.chan, []);
  byChan.get(e.chan).push(e);
}
for (const [chan, evs] of byChan) {
  if (evs.length < 20) continue;
  // even sample across the whole window, not just the first N minutes
  const step = Math.max(1, Math.floor(evs.length / PER));
  const pick = evs.filter((_, i) => i % step === 0).slice(0, PER);
  const lines = pick.map((e) => {
    if (e.cmd !== 'PRIVMSG') return `!! ${e.systemMsg || e.msgId || e.cmd}`;
    let t = [...e.text];
    for (const grp of (e.emotes || '').split('/')) {
      if (!grp) continue;
      const [, pos] = grp.split(':');
      for (const r of pos.split(',')) { const [a, b] = r.split('-').map(Number); t[a] = '[' + t[a]; t[b] = t[b] + ']'; }
    }
    const tags = [e.replyTo && `↩${e.replyTo}`, e.firstMsg && 'NEW', e.mod && 'MOD', e.vip && 'VIP', /subscriber\/\d+/.test(e.badges || '') && 'SUB'].filter(Boolean).join(',');
    return `${e.name}${tags ? ` (${tags})` : ''}: ${t.join('')}`;
  });
  const f = path.join(outDir, `real-${chan}.txt`);
  fs.writeFileSync(f, `${chan} — ${evs.length} lines collected, ${pick.length} sampled every ${step}th\n\n` + lines.join('\n') + '\n');
  console.log(`${f}  ${pick.length} lines of ${evs.length}`);
}
