// Real Twitch chat corpus collector — dev tooling, not part of the app.
//
// Anonymous IRC (NICK justinfan*, no token, no key) reads public chat exactly
// the way the Twitch client does, with the tags the browser gets: emotes,
// badges, reply target, first-msg, user-id. Port 443 because :6697 edges
// sometimes serve a cert whose SAN is the edge name, not irc.chat.twitch.tv.
//
//   node tools/collect-chat.mjs --channels kai_cenat,lofi_girl --minutes 12 \
//        --out data/real/2026-10-28.jsonl [--cap 15000]
//
// --cap is per channel: a big channel does hundreds of lines a second and 20
// minutes of it is a gigabyte of "KKKK". Capping keeps the corpus a *sample*.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const CHANNELS = arg('channels', '').split(',').map((c) => c.trim().replace(/^#/, '')).filter(Boolean);
const MINUTES = +arg('minutes', 10);
const CAP = +arg('cap', 20000);
const OUT = arg('out', `data/real/${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}.jsonl`);
const PORT = +arg('port', 443);
const TLS_ON = !flag('plain');
if (!CHANNELS.length) { console.error('usage: collect-chat.mjs --channels a,b,c [--minutes 10] [--out f] [--cap 20000]'); process.exit(2); }

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const sink = fs.createWriteStream(OUT);
const started = Date.now();
const counts = new Map(CHANNELS.map((c) => [c, 0]));
let lines = 0, dropped = 0;

// `raw` is the whole IRC line — tags are the point, so keep them and parse.
const TAGS = /^@(?<tags>\S+) (?<rest>.*)$/;
const parse = (raw) => {
  const m = TAGS.exec(raw);
  const tags = {};
  let rest = raw;
  if (m) {
    rest = m.groups.rest;
    for (const kv of m.groups.tags.split(';')) {
      const i = kv.indexOf('=');
      if (i > 0) tags[kv.slice(0, i)] = kv.slice(i + 1);
    }
  }
  const msg = /^(?::(?<user>\S+) )?(?<cmd>[A-Z]+) #?(?<chan>\S*)(?: :(?<text>.*))?$/.exec(rest);
  if (!msg || !['PRIVMSG', 'CLEARCHAT', 'NOTICE', 'USERNOTICE'].includes(msg.groups.cmd)) return null;
  const chan = (msg.groups.chan || '').replace(/^#/, '');
  return {
    t: new Date().toISOString(),
    ms: Date.now(),
    chan,
    cmd: msg.groups.cmd,
    user: msg.groups.user || tags['login'] || '',
    name: tags['display-name'] || msg.groups.user || '',
    text: msg.groups.text || '',
    emotes: tags.emotes || '',
    badges: tags.badges || '',
    color: tags.color || '',
    replyTo: tags['reply-parent-display-name'] || '',
    replyMsg: tags['reply-parent-msg-body'] || '',
    firstMsg: tags['first-msg'] === '1',
    systemMsg: tags['system-msg'] || '',
    msgId: tags['msg-id'] || '',
    flags: tags.flags || '',
    // mod/.sub/vip/founder tells us who is staff — real chat's power users set
    // the tone and the sim has no notion of it
    mod: tags.mod === '1',
    sub: /subscriber\/\d+|founder/.test(tags.badges || ''),
    vip: /vip/.test(tags.badges || ''),
  };
};

const sock = TLS_ON
  ? tls.connect({ port: PORT, host: 'irc.chat.twitch.tv', servername: 'irc.chat.twitch.tv' })
  : net.connect({ port: PORT, host: 'irc.chat.twitch.tv' });
sock.setEncoding('utf8');
let stopped = false;
let joined = 0;
// Handshake first, then JOINs on a drip: blasting every channel at once on a
// fresh anonymous connection gets the socket closed, and a closed socket used
// to end the whole collection (round 1 collected 0 lines doing exactly that).
const hello = () => {
  sock.write('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
  sock.write(`NICK justinfan${1000 + (process.pid % 8000)}\r\n`);
  joined = 0;
  const drip = setInterval(() => {
    if (stopped || sock.destroyed) return clearInterval(drip);
    for (let i = 0; i < 4 && joined < CHANNELS.length; i++, joined++) sock.write(`JOIN #${CHANNELS[joined]}\r\n`);
    if (joined >= CHANNELS.length) clearInterval(drip);
  }, 700);
};
if (TLS_ON) sock.on('secureConnect', hello); else sock.on('connect', hello);
const reopen = () => { if (!stopped) process.kill(process.pid, 'SIGUSR1'); };
sock.on('close', () => { if (stopped) return; console.error('irc closed, reopening'); setTimeout(reopen, 3000); });
process.on('SIGUSR1', () => { // reconnect in place; the sink and counts survive
  const s = TLS_ON
    ? tls.connect({ port: PORT, host: 'irc.chat.twitch.tv', servername: 'irc.chat.twitch.tv' })
    : net.connect({ port: PORT, host: 'irc.chat.twitch.tv' });
  s.setEncoding('utf8');
  s.on('data', onData);
  s.on('error', (e) => console.error('irc:', e.message));
  s.on('close', () => { if (!stopped) { console.error('irc closed, reopening'); setTimeout(reopen, 3000); } });
  if (TLS_ON) s.on('secureConnect', hello); else s.on('connect', hello);
});

let buf = '';
const onData = (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\r\n')) >= 0) {
    const raw = buf.slice(0, i); buf = buf.slice(i + 2);
    if (raw.startsWith('PING')) { sock.write('PONG :tmi.twitch.tv\r\n'); continue; }
    const e = parse(raw);
    if (!e) continue;
    if (e.cmd !== 'PRIVMSG') { // keeps moderation + sub events; they are part of the feel
      if (e.cmd === 'USERNOTICE' || e.cmd === 'CLEARCHAT') sink.write(JSON.stringify(e) + '\n');
      continue;
    }
    const n = counts.get(e.chan) || 0;
    if (n >= CAP) { dropped++; continue; }
    counts.set(e.chan, n + 1);
    sink.write(JSON.stringify(e) + '\n');
    lines++;
  }
};
sock.on('data', onData);
sock.on('error', (e) => console.error('irc:', e.message));
console.log(`collecting ${CHANNELS.length} channels → ${OUT} for ${MINUTES} min (cap ${CAP}/channel)`);

const report = () => {
  const per = [...counts.entries()].filter(([, n]) => n > 0).map(([c, n]) => `${c}=${n}`).join(' ');
  console.log(`  ${((Date.now() - started) / 1000 / 60).toFixed(1)} min · ${lines} lines · ${per || 'nothing live yet'}${dropped ? ` · ${dropped} past cap` : ''}`);
};
const tick = setInterval(report, 60000);
sock.on('connect', () => console.log(TLS_ON ? 'TLS ok' : 'plain ok'));

process.on('SIGINT', stop); process.on('SIGTERM', stop);
function stop() {
  stopped = true;
  clearInterval(tick);
  report();
  console.log(`total ${lines} lines → ${OUT}`);
  sink.end(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
setTimeout(stop, MINUTES * 60000 + 2000);
