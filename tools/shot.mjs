// Screenshot the live app after it has chatted for a while + dump #captions state.
//   node tools/shot.mjs "autolive=1&video=/videos/speech-demo.mp4" /tmp/shot.png [seconds]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [params, out, secs = '75'] = process.argv.slice(2);
const PORT = 9360;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/spasmtv-chrome-profile', '--enable-unsafe-webgpu',
  '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--window-size=1400,900', '--no-first-run', `http://127.0.0.1:8619/?${params}`,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 1; const pend = new Map();
for (let i = 0; i < 40 && !ws; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page');
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r)); } } catch {}
  if (!ws) await sleep(500);
}
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable'); await send('Page.enable');
await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.reload');
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true }))?.result?.value;
const end = Date.now() + (+secs) * 1000;
let seen = '';
while (Date.now() < end) {
  const s = await ev(`(()=>{const c=document.getElementById('captions');const r=c.getBoundingClientRect();return JSON.stringify({hidden:c.hidden,cls:c.className,text:c.textContent.slice(0,60),op:getComputedStyle(c).opacity,disp:getComputedStyle(c).display,rect:[r.x|0,r.y|0,r.width|0,r.height|0],title:document.title.slice(0,60)})})()`);
  if (s !== seen && /"cls":"on"/.test(s)) { seen = s; console.log(s); writeFileSync(out, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); }
  await sleep(1500);
}
console.log('last', await ev(`document.getElementById('captions').outerHTML.slice(0,200)`));
chrome.kill('SIGKILL');
