// probe.mjs — run a tools/<page>.html probe headless and print window.__result
// as it fills in. The probe pages are the browser-only half of the harness
// (they import workers/omni.js etc.); this is the node half.
//   node tools/probe.mjs noise-probe
//   node tools/probe.mjs caption-probe
// Needs ./serve.sh on :8619 and, for fixtures, node tools/noise-fixture.mjs.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const page = process.argv[2] || 'noise-probe';
const PORT = +(process.argv[3] || 9351);
const BASE = `http://127.0.0.1:8619/tools/${page}.html?v=` + Date.now();
const profile = process.env.HOME + '/.cache/spasmtv/cdp-profile';
mkdirSync(profile, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-webgpu', '--no-first-run', '--no-default-browser-check', BASE,
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
if (!ws) { chrome.kill('SIGKILL'); console.error('no CDP target'); process.exit(1); }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
// python http.server sends no Cache-Control, so the CDP profile can hand back a
// stale js/*.js module and the run silently tests old code. The page already
// loaded by the time CDP attaches, so reload it once the cache is off.
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url: BASE });
const deadline = Date.now() + 20 * 60_000;
let last = '';
while (Date.now() < deadline) {
  const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__result||null)', returnByValue: true });
  const v = r?.result?.value;
  if (v && v !== 'null' && v !== last) {
    last = v;
    const o = JSON.parse(v);
    console.log(o.stage, o.error || '');
    for (const [k, x] of Object.entries(o.out || {}))
      console.log(typeof x === 'object' ? `   ${String(k).padEnd(18)} ${JSON.stringify(x)}` : `   ${String(k).padEnd(18)} ${x}`);
    if (Array.isArray(o.out)) for (const x of o.out) console.log('  ', JSON.stringify(x));
  }
  const o = v && JSON.parse(v);
  if (o && (o.stage === 'done' || o.stage === 'error')) break;
  await sleep(3000);
}
chrome.kill('SIGKILL');
