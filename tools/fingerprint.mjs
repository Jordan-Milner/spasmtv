// Chat fingerprint — measures what Twitch chat actually looks like, and the same
// numbers for our simulation, side by side. This is the instrument behind
// docs/twitch-chat-fingerprint.md: the argument for every cadence/culture/prompt
// change is a row in this table.
//
//   node tools/fingerprint.mjs --real 'data/real/*.jsonl' --sim '/tmp/post4-*.jsonl'
//
// Real logs come from tools/collect-chat.mjs (IRC tags). Sim logs come from
// tools/browser-run.mjs (kind: 'chat' events). Anything the sim cannot express
// (usernames, replies, badges) is reported as n/a for the sim — that absence is
// itself a finding, not a bug in the tool.
import fs from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const files = (pat) => {
  if (!pat) return [];
  const dir = pat.includes('*') ? pat.slice(0, pat.lastIndexOf('/') + 1) : null;
  const base = dir ? pat.slice(pat.lastIndexOf('/') + 1) : pat;
  if (!dir) return fs.existsSync(pat) ? [pat] : [];
  const re = new RegExp('^' + base.replace(/[.+]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => dir + f);
};

const EMOJI = /\p{Extended_Pictographic}/u;
const CAPS = (s) => /[A-Z]{4,}/.test(s);
const KEYSMASH = /[asdfghjkl]{5,}|[qwertyuiop]{5,}|[zxcvbnm]{4,}/;
const NUMBERS = /\d{3,}/;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const pct = (a, b) => (b ? (100 * a) / b : NaN);
const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const p = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.round(q * (a.length - 1))] : NaN);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// A Twitch emote code inside text: either from the IRC `emotes` tag (authoritative)
// or, for the sim, a token that matches a code the run rendered.
function loadFiles(paths, kind) {
  const out = [];
  for (const f of paths) {
    for (const line of fs.readFileSync(f, 'utf8').trim().split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (kind === 'real') {
        if (e.cmd === 'PRIVMSG') {
          // `emotes` is `id:start-end,start/endId:...` in UTF-32 code points.
          // The ids are what make an emote countable; the ranges are what make
          // "is this line nothing but emotes" answerable.
          const inst = [];
          for (const grp of (e.emotes || '').split('/')) if (grp) { const [id, pos] = grp.split(':'); for (const r of pos.split(',')) inst.push({ id, r }); }
          const chars = [...e.text];
          for (const { r } of inst) { const [a, b] = r.split('-').map(Number); for (let i = a; i <= b; i++) chars[i] = '\u0000'; }
          out.push({ ms: e.ms, chan: e.chan, text: e.text, bare: chars.join('').replace(/\u0000/g, '').trim(),
            user: (e.user || '').split('!')[0], name: e.name,
            emoteCodes: inst.map((x) => x.id), emoteRaw: inst.map((x) => x.id).join(','), replyTo: e.replyTo, firstMsg: e.firstMsg,
            mod: e.mod, sub: e.sub, vip: e.vip, notice: '' });
        }
        else if (e.cmd === 'USERNOTICE') out.push({ notice: e.msgId || e.systemMsg || 'notice', ms: e.ms, chan: e.chan });
        else if (e.cmd === 'CLEARCHAT') out.push({ notice: 'moderation', ms: e.ms, chan: e.chan });
      } else if (e.kind === 'chat') {
        out.push({ ms: Date.parse(e.t), text: e.text, bare: e.text.split(/\s+/).filter((t) => !(e.ctx?.codes || []).includes(t.replace(/[.,!?…]+$/, ''))).join(' ').trim(), chan: 'sim',
          user: e.ctx?.viewer || '', name: e.ctx?.viewer || '',
          emoteCodes: (e.ctx?.codes || []).slice(), emoteRaw: (e.ctx?.codes || []).join(','), replyTo: e.ctx?.replyTo || '',
          firstMsg: false, kind: e.ctx?.kind, model: e.ctx?.model !== false, notice: '' });
      } else if (e.kind === 'mod') {
        out.push({ notice: 'moderation', ms: Date.parse(e.t), chan: 'sim' });
      }
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

function fingerprint(ev) {
  const msgs = ev.filter((e) => e.text !== undefined);
  const notices = ev.filter((e) => e.notice);
  const n = msgs.length || 1;
  const spanMin = Math.max(0.1, (msgs.at(-1)?.ms - msgs[0]?.ms) / 60000);
  const F = {};
  F['lines/min'] = n / spanMin;

  // ---- timing -------------------------------------------------------------
  const gaps = [];
  for (let i = 1; i < msgs.length; i++) gaps.push(msgs[i].ms - msgs[i - 1].ms);
  F['gap median (ms)'] = med(gaps);
  F['gap p95 (ms)'] = p(gaps, 0.95);
  F['back-to-back ≤2 s'] = pct(gaps.filter((g) => g <= 2000).length, gaps.length);
  // burstiness: variance/mean of 10 s bucket counts. Poisson ≈ 1; real chat is
  // far above that (waves), a metronome is near 0.
  const buckets = new Map();
  for (const m of msgs) { const k = Math.floor(m.ms / 10000); buckets.set(k, (buckets.get(k) || 0) + 1); }
  const bc = [...buckets.values()];
  const bm = mean(bc);
  F['burst index (10 s)'] = bm ? mean(bc.map((x) => (x - bm) ** 2)) / bm : NaN;
  F['dead 30 s stretches'] = gaps.filter((g) => g > 30000).length;

  // ---- form ---------------------------------------------------------------
  const words = msgs.map((m) => m.text.trim().split(/\s+/).filter(Boolean));
  const chars = msgs.map((m) => m.text.trim().length);
  F['chars median'] = med(chars);
  F['chars p90'] = p(chars, 0.9);
  F['words mean'] = mean(words.map((w) => w.length));
  F['one-word lines'] = pct(words.filter((w) => w.length === 1).length, n);
  F['emote-only lines'] = pct(msgs.filter((m) => m.emoteCodes.length && m.bare === '').length, n);
  F['ALL CAPS lines'] = pct(msgs.filter((m) => CAPS(m.text)).length, n);
  F['lowercase start'] = pct(msgs.filter((m) => /^[a-z]/.test(m.text.trim())).length, n);
  F['ends ?'] = pct(msgs.filter((m) => /\?\s*$/.test(m.text)).length, n);
  F['has !'] = pct(msgs.filter((m) => /!/.test(m.text)).length, n);
  F['ellipsis'] = pct(msgs.filter((m) => /\.\.|…/.test(m.text)).length, n);
  F['keysmash'] = pct(msgs.filter((m) => KEYSMASH.test(m.text)).length, n);
  F['emoji lines'] = pct(msgs.filter((m) => EMOJI.test(m.text)).length, n);
  F['digit-run lines'] = pct(msgs.filter((m) => NUMBERS.test(m.text)).length, n);

  // ---- emotes -------------------------------------------------------------
  F['lines with emote'] = pct(msgs.filter((m) => m.emoteCodes.length).length, n);
  F['emotes per emote line'] = mean(msgs.filter((m) => m.emoteCodes.length).map((m) => m.emoteCodes.length));
  const codes = new Map();
  for (const m of msgs) for (const c of (m.emoteRaw || '').split(/[,\s]/).filter(Boolean)) codes.set(c, (codes.get(c) || 0) + 1);
  F['distinct emotes'] = codes.size;
  F['top-10 emote share'] = pct([...codes.values()].sort((a, b) => b - a).slice(0, 10).reduce((a, b) => a + b, 0), [...codes.values()].reduce((a, b) => a + b, 0));

  // ---- social -------------------------------------------------------------
  const byUser = new Map();
  for (const m of msgs) byUser.set(m.user, (byUser.get(m.user) || 0) + 1);
  const shares = [...byUser.values()].sort((a, b) => b - a);
  F['distinct users'] = byUser.size;
  F['lines per user'] = n / (byUser.size || 1);
  F['top 1 % share'] = pct(shares.slice(0, Math.max(1, Math.round(shares.length * 0.01))).reduce((a, b) => a + b, 0), n);
  F['one-line users'] = pct(shares.filter((s) => s === 1).length, shares.length);
  F['reply lines'] = pct(msgs.filter((m) => m.replyTo).length, n);
  F['first-msg lines'] = pct(msgs.filter((m) => m.firstMsg).length, n);
  F['mod/vip lines'] = pct(msgs.filter((m) => m.mod || m.vip).length, n);
  // does anyone talk TO anyone: text contains another chatter's name
  const nameSet = new Set([...byUser.keys()].filter((u) => u && u.length > 3).map((u) => u.toLowerCase()));
  let addressed = 0;
  for (const m of msgs) { const toks = new Set(norm(m.text).split(' ')); for (const nm of nameSet) if (nm !== m.user && toks.has(nm)) { addressed++; break; } }
  F['names another chatter'] = pct(addressed, n);

  // ---- repetition / culture ----------------------------------------------
  const seen = new Map();
  for (const m of msgs) { const k = norm(m.text); if (k) seen.set(k, (seen.get(k) || 0) + 1); }
  F['exact repeats'] = pct(msgs.filter((m) => (seen.get(norm(m.text)) || 0) > 1).length, n);
  F['copypasta (≥5×)'] = pct([...seen.entries()].filter(([, c]) => c >= 5).reduce((a, [, c]) => a + c, 0), n);
  const tri = new Map();
  for (const m of msgs) { const w = norm(m.text).split(' '); for (let i = 0; i + 3 <= w.length; i++) { const g = w.slice(i, i + 3).join(' '); tri.set(g, (tri.get(g) || 0) + 1); } }
  const triTotal = [...tri.values()].reduce((a, b) => a + b, 0);
  F['repeated 3-grams'] = pct([...tri.values()].filter((c) => c > 1).reduce((a, b) => a + b, 0), triTotal);
  const uniq = new Set(msgs.map((m) => norm(m.text)));
  F['unique lines'] = pct(uniq.size, n);

  // ---- events -------------------------------------------------------------
  F['notices/min'] = notices.length / spanMin;
  F['moderation/min'] = notices.filter((x) => x.notice === 'moderation').length / spanMin;
  F._msgs = msgs; F._n = n;
  F._topEmotes = [...codes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  F._topLines = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  F._byChan = (() => { const m = new Map(); for (const x of msgs) m.set(x.chan, (m.get(x.chan) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12); })();
  return F;
}

const real = fingerprint(loadFiles(files(arg('real', 'data/real/*.jsonl')), 'real'));
const sim = fingerprint(loadFiles(files(arg('sim', '/tmp/post4-*.jsonl')), 'sim'));
const keys = Object.keys(real).filter((k) => !k.startsWith('_'));
const w = Math.max(...keys.map((k) => k.length)) + 2;
console.log(`${'metric'.padEnd(w)} ${'REAL'.padStart(11)} ${'SIM'.padStart(11)}  note`);
const NOTES = {
  'lines/min': 'volume of the room',
  'gap median (ms)': 'time between lines',
  'back-to-back ≤2 s': 'chat arrives in waves',
  'burst index (10 s)': '1 = poisson, 0 = metronome, real ≫ 1',
  'chars median': 'how long a line is',
  'one-word lines': 'the one-word drive-by',
  'emote-only lines': 'a line that is just an emote',
  'ALL CAPS lines': 'shouting',
  'lowercase start': 'nobody capitalises',
  'ends ?': 'questions',
  'keysmash': 'asdfghjkl',
  'lines with emote': 'emote density',
  'distinct emotes': 'vocabulary of the room',
  'top 1 % share': 'how much a few people dominate',
  'one-line users': 'the silent majority',
  'reply lines': 'actual conversation',
  'names another chatter': 'people talk to each other',
  'exact repeats': 'people say the same thing',
  'copypasta (≥5×)': 'pasted lines',
  'repeated 3-grams': 'shared phrasing',
  'unique lines': 'type-token, novelty',
  'notices/min': 'subs/raids as texture',
};
for (const k of keys) {
  const fmt = (v) => (typeof v === 'number' && isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : 'n/a');
  const r = fmt(real[k]), s = fmt(sim[k]);
  const flag = r === 'n/a' || s === 'n/a' ? '·' : (Math.abs(parseFloat(r) - parseFloat(s)) / (Math.abs(parseFloat(r)) || 1) > 0.5 ? '✗' : '~');
  console.log(`${k.padEnd(w)} ${r.padStart(11)} ${s.padStart(11)}  ${flag} ${NOTES[k] || ''}`);
}
const show = (label, F) => {
  console.log(`\n${label} — top emotes: ${(F._topEmotes || []).map(([c, n]) => `${c}×${n}`).slice(0, 10).join(' ') || 'n/a'}`);
  console.log(`${label} — most repeated lines:`);
  for (const [l, c] of (F._topLines || []).slice(0, 10)) if (c > 1) console.log(`   ×${String(c).padStart(4)}  ${l.slice(0, 90)}`);
  if (F._byChan?.length) console.log(`${label} — per channel: ${F._byChan.map(([c, n]) => `${c}=${n}`).join(' ')}`);
};
show('REAL', real); show('SIM', sim);

// One room is not a distribution. A 20 000-viewer channel and a 60-viewer
// channel are different species, and our stream is small — the per-channel cut
// is what says which end of the real range we should be tuning to.
if (process.argv.includes('--by-channel')) {
  const all = loadFiles(files(arg('real', 'data/real/*.jsonl')), 'real');
  const chans = [...new Set(all.filter((e) => e.text !== undefined).map((e) => e.chan))];
  const rows = chans.map((c) => [c, fingerprint(all.filter((e) => e.chan === c))]).filter(([, F]) => F._n >= 30);
  rows.sort((a, b) => b[1]['lines/min'] - a[1]['lines/min']);
  const cols = ['lines/min', 'gap median (ms)', 'burst index (10 s)', 'chars median', 'one-word lines', 'lines with emote', 'emote-only lines', 'ALL CAPS lines', 'ends ?', 'distinct users', 'top 1 % share', 'one-line users', 'reply lines', 'names another chatter', 'exact repeats', 'copypasta (≥5×)', 'repeated 3-grams', 'notices/min', 'moderation/min'];
  console.log(`\nper channel (${rows.length} rooms with ≥30 lines)`);
  console.log('channel'.padEnd(16) + cols.map((c) => c.slice(0, 9).padStart(10)).join(''));
  for (const [c, F] of rows) console.log(c.slice(0, 15).padEnd(16) + cols.map((k) => (isFinite(F[k]) ? (Math.abs(F[k]) >= 100 ? F[k].toFixed(0) : F[k].toFixed(1)) : 'n/a').padStart(10)).join(''));
}
