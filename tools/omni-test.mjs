// Headless check of workers/omni.js outside the app: load, text gen, transcribe.
//   node tools/omni-test.mjs   (needs serve.sh on :8619 and videos/speech-test.f32)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const PORT = 9350, BASE = 'http://127.0.0.1:8619/tools/omni-test.html';
const profile = '/tmp/spasmtv-chrome-profile';
mkdirSync(profile, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--enable-unsafe-webgpu',
  '--no-first-run', '--no-default-browser-check', BASE,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 1; const pend = new Map();
for (let i = 0; i < 40 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r)); }
  } catch {}
  if (!ws) await sleep(500);
}
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
const deadline = Date.now() + 15 * 60_000;
let last = '';
while (Date.now() < deadline) {
  const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__result||null)', returnByValue: true });
  const v = r?.result?.value;
  if (v && v !== last) { last = v; console.log(v); }
  const o = v && JSON.parse(v);
  if (o && (o.stage === 'done' || o.stage === 'error')) break;
  await sleep(3000);
}
chrome.kill('SIGKILL');
