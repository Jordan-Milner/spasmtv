// browser-run.mjs — drive the real page in headless Chrome over CDP and dump
// the chat log, so prompt/cadence/culture changes get checked against a real
// generated log instead of a vibe. Stdlib only (node ≥22 has global WebSocket).
//
//   node tools/browser-run.mjs --out /tmp/run.jsonl --minutes 3 [--url-params autolive=1]
//
// Chrome flags: fake camera + fake mic UI (no permissions dialogs), WebGPU
// enabled in headless. Always exits: the browser is killed on timeout.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const PORT = +arg('port', 9333);
const MINUTES = +arg('minutes', 3);
const OUT = arg('out', '/tmp/spasmtv-run.jsonl');
const PARAMS = arg('url-params', 'autolive=1');
const BASE = arg('base', 'http://127.0.0.1:8619/');
const CHROME = arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const DEADLINE = Date.now() + (MINUTES * 60 + 240) * 1000; // run + 4 min of slack

// persistent profile on purpose: the model weights (~800 MB) cache in the
// browser Cache API, so a second run starts warm. --fresh wipes it.
const profile = arg('profile', '/tmp/spasmtv-chrome-profile');
if (flag('fresh')) rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--enable-unsafe-webgpu',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run', '--no-default-browser-check', '--disable-translate',
  '--window-size=1400,900',
  `${BASE}?${PARAMS}`,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeLog = '';
chrome.stdout.on('data', (d) => { chromeLog += d; });
chrome.stderr.on('data', (d) => { chromeLog += d; });

const die = (code, msg) => {
  try { chrome.kill('SIGKILL'); } catch {}
  if (flag('fresh')) { try { rmSync(profile, { recursive: true, force: true }); } catch {} }
  if (msg) console.error(msg);
  process.exit(code);
};
process.on('SIGTERM', () => die(1, 'killed'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  return null;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

let nextId = 1;
const pending = new Map();
function send(ws, method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }
    }, 60_000);
  });
}

async function evaluate(ws, expression) {
  const r = await send(ws, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
}

const t = await target();
if (!t) die(1, `no CDP target on :${PORT}\n--- chrome output ---\n${chromeLog.slice(-1500)}`);

const ws = await connect(t.webSocketDebuggerUrl);
ws.onmessage = (ev) => {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  }
};

await send(ws, 'Runtime.enable');
await send(ws, 'Page.enable');
// the persistent profile would happily serve the previous run's js/main.js out
// of the http cache — every measurement would then be of the old code
await send(ws, 'Network.enable');
await send(ws, 'Network.setCacheDisabled', { cacheDisabled: true });

// headless has no camera and its fake mic hangs getUserMedia, so the harness
// runs the built-in demo feed with the mic off (before main.js reads the
// checkboxes). --camera opts out and uses real getUserMedia.
if (!flag('camera')) {
  await send(ws, 'Page.addScriptToEvaluateOnNewDocument', {
    source: "localStorage.removeItem('lurker-log');\n" +
      "addEventListener('DOMContentLoaded', () => {\n" +
      "  document.getElementById('demo-toggle').checked = true;\n" +
      (flag('mic') ? '' : "  document.getElementById('mic-toggle').checked = false;\n") +
      "});",
  });
  await send(ws, 'Page.reload', { ignoreCache: false });
}

// wait for the pipeline to produce lines (model download can take minutes)
let title = '';
// --ban: mid-run, click the loudest chatter's name (centering → onCenter) then
// hit "ban forever" — the §D verify clause is reactions inside 6 s
let banAt = 0;
const BAN_SNIPPET = `(() => {
  const counts = {};
  document.querySelectorAll('#chat-messages .user').forEach((u) => {
    counts[u.textContent] = (counts[u.textContent] || 0) + 1;
  });
  const name = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!name) return 0;
  const el = [...document.querySelectorAll('#chat-messages .user')].reverse()
    .find((u) => u.textContent === name);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 320, clientY: 320 }));
  const card = [...document.body.children].find((n) => n.querySelector?.('.mc-banforever'));
  if (!card || card.hidden) return 0;
  card.querySelector('.mc-banforever').click();
  window.__banned = name;
  return Date.now();
})()`;

while (Date.now() < DEADLINE) {
  await sleep(5000);
  try { title = (await evaluate(ws, 'document.title')) || ''; } catch (e) { console.error('poll failed:', e.message); continue; }
  const status = await evaluate(ws, "document.getElementById('status-text').textContent").catch(() => '?');
  console.log(`… ${title.slice(0, 110)} :: ${status}`);
  const chat = +(title.match(/chat=(\d+)/) || [])[1] || 0;
  if (flag('ban') && !banAt && chat >= 8) {
    banAt = await evaluate(ws, BAN_SNIPPET);
    if (banAt) console.log(`banned a loud viewer at ${new Date(banAt).toISOString()}`);
  }
  if (chat >= MINUTES * 12 && (!banAt || Date.now() - banAt > 15000)) break;
}

const dump = await evaluate(ws, 'window.__lurkerDump ? __lurkerDump() : "[]"');
const events = JSON.parse(dump);
writeFileSync(OUT, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
console.log(`wrote ${OUT}: ${events.length} events · ${title.slice(0, 160)}`);

if (banAt) {
  const after = events.filter((e) => e.kind === 'chat' && new Date(e.t) > banAt);
  const within = after.filter((e) => new Date(e.t) - banAt < 6000);
  console.log(`ban → first chat reaction: ${after[0] ? new Date(after[0].t) - banAt : 'none'}ms`
    + ` · ${within.length} lines inside 6 s`
    + ` · ${within.filter((e) => e.ctx?.kind === 'banreact').length} of kind banreact`);
  for (const e of within.slice(0, 6)) console.log(`   +${new Date(e.t) - banAt}ms ${e.ctx?.kind} ${e.text}`);
}

ws.close();
die(0);
