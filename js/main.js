// main.js — orchestration: camera/demo feed, frame capture + scene diff, chat
// scheduling, mic gate → transcription, captions, worker client.
//
// All model inference happens in workers/llm-worker.js (transformers.js, WebGPU).
// This file never touches model APIs directly — only the message protocol.

import { ChatSim } from './chat-sim.js';
import { loadEmotes, emoteHintFrom } from './emotes.js';

const $ = (id) => document.getElementById(id);

const els = {
  startBtn: $('start-btn'), stopBtn: $('stop-btn'),
  modelSelect: $('model-select'), micToggle: $('mic-toggle'), demoToggle: $('demo-toggle'),
  cam: $('cam'), demoCanvas: $('demo-canvas'), capture: $('frame-capture'),
  captionCapture: $('caption-capture'),
  offlineCover: $('offline-cover'), overlay: $('overlay'), titleCard: $('title-card'),
  streamTitle: $('stream-title'), captions: $('captions'),
  statusDot: $('status-dot'), statusText: $('status-text'), latChip: $('lat-chip'),
  loadProgress: $('load-progress'), loadBar: $('load-bar'), loadPct: $('load-pct'),
  chatForm: $('chat-form'), chatInput: $('chat-input'), chatPanel: $('chat-panel'),
  chatMessages: $('chat-messages'),
  settingsBtn: $('settings-btn'), settings: $('settings'),
  setDetail: $('set-detail'), setFocus: $('set-focus'), setVaried: $('set-varied'),
  setAsr: $('set-asr'), setLatency: $('set-latency'),
};

const CAPTURE_DEFAULT = 512;      // vision detail (settings panel: 512/640/768 —
                                  // above 512 the model tiles the frame)
const DIFF_W = 32, DIFF_H = 18;   // motion grid used for scene diff + focus crop
const FULL_W = 960;               // working resolution frames are grabbed at
const SCENE_CHANGE = 0.055;       // mean abs luma delta that counts as a "clip it!" moment

const TICK_CHAT_MS = 2300;        // chat cadence
const TICK_FRAME_MS = 1500;       // frame grab cadence
const TICK_CAPTION_MS = 8000;     // scene re-caption cadence
const MAX_PENDING_CHAT = 2;

const TITLES = [
  '24/7 irl — chat decides what happens',
  'just chatting (the chat is the star)',
  'solo queue — chat backseats encouraged',
  'no cam challenge (day 0, already failed)',
  'ranked grinding, chat backseats welcome',
  'fishing for comps, lurkers welcome',
];

const state = {
  phase: 'idle',            // idle | loading | live
  worker: null,
  reqId: 0,
  pendingChat: 0,
  loops: [],                // timer ids / raf ids
  stream: null,             // MediaStream (camera + mic)
  audioCtx: null,
  demoRaf: 0,
  // settings (settings panel, persisted)
  settings: { detail: CAPTURE_DEFAULT, focus: true, varied: true, asr: 'base' },
  // vision
  prevThumb: null, diffScore: 0,
  fullCanvas: null,         // working-res frame for crops + diff
  prevCapture: null,        // last tick's capture buffer — the "before" in before/after bursts
  multiFrame: false,        // worker reported multi-image support
  scene: '', sceneAt: 0,
  // audio gate
  pcm: [], pcmSamples: 0, speaking: false, silenceMs: 0,
  // chat context
  speech: '', speechAt: 0, userMsg: '', userMsgTicks: 0,
  lastChatLines: [],
  emoteHint: '',
  titleIdx: 0,
  // per-kind round-trip latency (ms, last 10)
  latency: { chat: [], cap: [], asr: [] },
};

const sim = new ChatSim();

// pipeline counters; the ?autolive self-test mirrors these into document.title
window.__lurker = { chat: 0, cap: 0, asr: 0, err: '', lastMsg: '', lastCap: '', lastAsr: '' };

/* ---------------- chat log (local only) ----------------
 * Every generated message is stored with the context that produced it, so chat
 * quality can be reviewed/tuned after a session. In-memory ring (2000) with a
 * best-effort localStorage mirror. Dump from the console:
 *   __lurkerDump()               → JSON string
 *   __lurkerDownload()           → saves lurker-chatlog-<date>.jsonl */

const chatLog = [];
try { // restore the tail of the previous session's log so reloads keep history
  const prev = JSON.parse(localStorage.getItem('lurker-log') || '[]');
  if (Array.isArray(prev)) chatLog.push(...prev);
} catch {}

const pendingMeta = new Map(); // reqId → {kind, sentAt, context, viewer} for latency + attribution

function logEvent(kind, text, ctx) {
  chatLog.push({ t: new Date().toISOString(), kind, text, ...(ctx ? { ctx } : {}) });
  if (chatLog.length > 2000) chatLog.splice(0, chatLog.length - 2000);
  try { localStorage.setItem('lurker-log', JSON.stringify(chatLog.slice(-400))); } catch {}
}

window.__lurkerDump = () => JSON.stringify(chatLog, null, 1);
window.__lurkerDownload = () => {
  const blob = new Blob([chatLog.map((e) => JSON.stringify(e)).join('\n')], { type: 'application/jsonl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lurker-chatlog-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

/* ---------------- worker client ---------------- */

function ensureWorker() {
  if (state.worker) return state.worker;
  const w = new Worker(new URL('../workers/llm-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = onWorkerMessage;
  w.onerror = (e) => {
    window.__lurker.err = e.message || 'worker error';
    setStatus('err', `worker error: ${e.message || 'unknown'}`);
  };
  state.worker = w;
  return w;
}

function post(msg, transfer = []) { ensureWorker().postMessage(msg, transfer); }

function onWorkerMessage(ev) {
  const m = ev.data;
  if (m.type === 'progress') {
    const pct = Math.round((m.progress || 0) * 100);
    if (state.phase === 'live') {
      // background ASR download after going live — don't resurrect the load bar
      setStatus('busy', `loading speech model… ${pct}%`);
      return;
    }
    els.loadProgress.hidden = false;
    els.loadBar.style.width = pct + '%';
    els.loadPct.textContent = pct + '%';
  } else if (m.type === 'ready') {
    state.multiFrame = !!m.multiFrame;
    els.loadProgress.hidden = true; els.loadPct.textContent = '';
    goLiveAfterLoad();
  } else if (m.type === 'error') {
    window.__lurker.err = m.message || 'unknown';
    setStatus('err', m.message);
    els.loadProgress.hidden = true;
    resetToIdle();
  } else if (m.type === 'asr-ready') {
    if (state.phase === 'live') setStatus('ok', 'live — the chat can see you and hear you');
  } else if (m.type === 'caption') {
    noteLatency(m.id, 'cap');
    window.__lurker.cap += 1;
    window.__lurker.lastCap = m.text || '';
    logEvent('caption', m.text || '');
    state.scene = m.text; state.sceneAt = Date.now();
  } else if (m.type === 'chat') {
    noteLatency(m.id, 'chat');
    state.pendingChat = Math.max(0, state.pendingChat - 1);
    window.__lurker.chat += (m.messages || []).length;
    if (m.messages?.length) window.__lurker.lastMsg = m.messages[m.messages.length - 1];
    const entry = pendingMeta.get(m.id);
    pendingMeta.delete(m.id);
    (m.messages || []).forEach((text) => {
      let viewer = entry?.viewer;
      if (!viewer || (viewer.bannedUntil && viewer.bannedUntil > Date.now()))
        viewer = sim.pickViewer();
      const shown = sim.chat(text, viewer || undefined);
      if (shown) logEvent('chat', text, { ...(entry?.context || {}), viewer: shown.name });
    });
    state.lastChatLines = [...state.lastChatLines, ...(m.messages || [])].slice(-6);
  } else if (m.type === 'transcribe') {
    noteLatency(m.id, 'asr');
    window.__lurker.asr += 1;
    window.__lurker.lastAsr = (m.text || '').slice(0, 80);
    logEvent('asr', m.text || '');
    onTranscript(m.text);
  }
}

function noteLatency(id, kind) {
  const meta = pendingMeta.get(id);
  if (meta?.sentAt) {
    const arr = state.latency[kind];
    arr.push(performance.now() - meta.sentAt);
    if (arr.length > 10) arr.shift();
    renderLatency();
  }
}

function fmtLatency(kind) {
  const a = state.latency[kind];
  if (!a.length) return null;
  return (a.reduce((x, y) => x + y, 0) / a.length / 1000).toFixed(2);
}

function renderLatency() {
  const chat = fmtLatency('chat'), cap = fmtLatency('cap'), asr = fmtLatency('asr');
  const any = chat || cap || asr;
  els.latChip.hidden = !any;
  if (any) els.latChip.textContent = `· chat ${chat ?? '—'}s · cap ${cap ?? '—'}s · asr ${asr ?? '—'}s`;
  els.setLatency.innerHTML =
    `chat reply: avg <b>${chat ?? '—'}s</b>` +
    ` (last ${state.latency.chat.length})<br>` +
    `scene caption: ${cap ?? '—'}s · speech-to-text: ${asr ?? '—'}s<br>` +
    `<span class="set-note">that's your GPU's prefill+decode. higher vision detail ` +
    `or the 2B brain = slower chat.</span>`;
}

/* ---------------- status / phase UI ---------------- */

function setStatus(kind, text) {
  els.statusDot.className = 'dot' + (kind ? ' ' + kind : '');
  els.statusText.textContent = text;
}

function resetToIdle() {
  state.phase = 'idle';
  els.startBtn.disabled = false;
  els.startBtn.hidden = false;
  els.stopBtn.hidden = true;
  els.chatPanel.classList.add('disabled');
}

/* ---------------- start / stop ---------------- */

async function start() {
  if (state.phase !== 'idle') return;
  state.phase = 'loading';
  els.startBtn.disabled = true;

  if (!navigator.gpu) {
    setStatus('err', 'WebGPU not available — use a recent Chrome/Edge and try again.');
    resetToIdle();
    return;
  }

  setStatus('busy', 'downloading model (first run only)…');
  post({
    type: 'load',
    model: els.modelSelect.value,
    asr: els.micToggle.checked,
    asrModel: state.settings.asr,
  });
}

async function goLiveAfterLoad() {
  try {
    if (els.demoToggle.checked) {
      startDemoFeed();
    } else {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
      els.cam.srcObject = state.stream;
      els.cam.hidden = false;
      els.demoCanvas.hidden = true;
    }
    if (els.micToggle.checked) await startMic();
  } catch (err) {
    setStatus('err', humanizeMediaError(err));
    stopEverything();
    resetToIdle();
    return;
  }

  state.phase = 'live';
  els.offlineCover.hidden = true;
  els.overlay.hidden = false;
  els.titleCard.hidden = false;
  els.startBtn.hidden = true;
  els.stopBtn.hidden = false;
  els.chatPanel.classList.remove('disabled');

  sim.buildRoster();
  sim.system('Welcome to the chat room!');
  sim.chat('yo we live?? ' + sim.randomEmote());
  sim.startViewerDrift(20 + ((Math.random() * 18) | 0));
  rotateTitle();

  state.scene = ''; state.sceneAt = 0; state.speech = ''; state.lastChatLines = [];
  startLoops();
  els.loadProgress.hidden = true;
  els.loadPct.textContent = '';
  setStatus('ok', 'live — the chat can see you' + (state.audioCtx ? ' and hear you' : ''));
}

function humanizeMediaError(err) {
  if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError'))
    return 'camera/mic permission denied — allow access and go live again (or use demo mode).';
  if (err && err.name === 'NotFoundError')
    return 'no camera found — try demo mode.';
  return 'media error: ' + (err && err.message ? err.message : String(err));
}

function stop() { stopEverything(); resetToIdle(); setStatus('', 'offline'); }

function stopEverything() {
  cancelLoops();
  sim.stopViewerDrift();
  if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
  if (state.audioCtx) { state.audioCtx.close().catch(() => {}); state.audioCtx = null; }
  if (state.demoRaf) cancelAnimationFrame(state.demoRaf), (state.demoRaf = 0);
  els.cam.srcObject = null;
  els.cam.hidden = true;
  els.demoCanvas.hidden = true;
  els.captions.classList.remove('on');
  els.offlineCover.hidden = false;
  els.overlay.hidden = true;
  els.titleCard.hidden = true;
}

/* ---------------- loops ---------------- */

function startLoops() {
  cancelLoops();
  state.loops.push(setTimeout(tickFrame, TICK_FRAME_MS));
  state.loops.push(setTimeout(tickCaption, 400));
  state.loops.push(setTimeout(tickChat, TICK_CHAT_MS));
  state.loops.push(setTimeout(rotateTitle, 45000));
}

function cancelLoops() {
  state.loops.forEach(id => { clearTimeout(id); clearInterval(id); cancelAnimationFrame(id); });
  state.loops = [];
  if (state.demoRaf) { cancelAnimationFrame(state.demoRaf); state.demoRaf = 0; }
}

function scheduleNext(fn, ms) {
  state.loops.push(setTimeout(fn, ms));
}

function activeSource() {
  return els.demoCanvas.hidden ? els.cam : els.demoCanvas;
}

/* frame grab: full working canvas → motion grid → capture (maybe focus-cropped) */
function tickFrame() {
  if (state.phase !== 'live') return;
  const src = activeSource();
  if (src && (src.readyState === undefined || src.readyState >= 2)) {
    const sw = src.videoWidth || src.width || 1280;
    const sh = src.videoHeight || src.height || 720;
    if (!state.fullCanvas) state.fullCanvas = document.createElement('canvas');
    const f = state.fullCanvas;
    const fw = FULL_W, fh = Math.round(FULL_W * sh / sw);
    if (f.width !== fw || f.height !== fh) { f.width = fw; f.height = fh; }
    f.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, fw, fh);
    const motion = motionScore(f);
    state.diffScore = motion.score;
    drawCapture(f, motion);
  }
  scheduleNext(tickFrame, TICK_FRAME_MS);
}

function motionScore(fullCanvas) {
  const t = document.createElement('canvas');
  t.width = DIFF_W; t.height = DIFF_H;
  const ctx = t.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(fullCanvas, 0, 0, DIFF_W, DIFF_H);
  const px = ctx.getImageData(0, 0, DIFF_W, DIFF_H).data;
  const luma = new Float32Array(DIFF_W * DIFF_H);
  for (let i = 0, j = 0; i < px.length; i += 4, j++)
    luma[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  const cells = new Float32Array(DIFF_W * DIFF_H);
  let acc = 0, hot = 0;
  if (state.prevThumb) {
    for (let k = 0; k < luma.length; k++) {
      const d = Math.abs(luma[k] - state.prevThumb[k]) / 255;
      cells[k] = d;
      acc += d;
      if (d > 0.08) hot += 1;
    }
  }
  state.prevThumb = luma;
  return { cells, score: acc / luma.length, hotFrac: hot / luma.length };
}

function drawCapture(full, motion) {
  // stash the previous capture first — it's the "before" of before/after bursts
  if (els.capture.width > 0) state.prevCapture = grabFrameBuffer(els.capture);

  const S = state.settings;
  let sx = 0, sy = 0, sw = full.width, sh = full.height;
  const concentrated =
    motion.hotFrac > 0.02 && motion.hotFrac < 0.45 && motion.score > SCENE_CHANGE * 0.4;
  if (S.focus && concentrated) {
    let cx = 0, cy = 0, wsum = 0;
    for (let y = 0; y < DIFF_H; y++) {
      for (let x = 0; x < DIFF_W; x++) {
        const d = motion.cells[y * DIFF_W + x];
        if (d > 0.08) {
          cx += (x + 0.5) * d;
          cy += (y + 0.5) * d;
          wsum += d;
        }
      }
    }
    if (wsum > 0) {
      cx = (cx / wsum / DIFF_W) * full.width;
      cy = (cy / wsum / DIFF_H) * full.height;
      const size = Math.round(Math.min(full.width, full.height) * 0.6);
      sx = Math.max(0, Math.min(full.width - size, Math.round(cx - size / 2)));
      sy = Math.max(0, Math.min(full.height - size, Math.round(cy - size / 2)));
      sw = size; sh = size;
    }
  }

  const scale = Math.min(S.detail / sw, S.detail / sh);
  const c = els.capture;
  c.width = Math.max(64, Math.round(sw * scale));
  c.height = Math.max(64, Math.round(sh * scale));
  c.getContext('2d', { willReadFrequently: true })
    .drawImage(full, sx, sy, sw, sh, 0, 0, c.width, c.height);

  // captions always describe the whole scene, never the crop
  const cc = els.captionCapture;
  const cscale = Math.min(512 / full.width, 512 / full.height);
  cc.width = Math.round(full.width * cscale);
  cc.height = Math.round(full.height * cscale);
  cc.getContext('2d', { willReadFrequently: true }).drawImage(full, 0, 0, cc.width, cc.height);
}

/* scene caption */
function tickCaption() {
  if (state.phase !== 'live') return;
  const stale = Date.now() - state.sceneAt > TICK_CAPTION_MS;
  const sceneChange = state.diffScore > SCENE_CHANGE && Date.now() - state.sceneAt > 4000;
  if ((stale || sceneChange) && els.capture.width > 0) {
    if (sceneChange) hype();
    sendCaption();
  }
  scheduleNext(tickCaption, 1000);
}

function sendCaption() {
  const img = grabFrameBuffer(els.captionCapture);
  if (!img) return;
  const id = ++state.reqId;
  pendingMeta.set(id, { kind: 'cap', sentAt: performance.now() });
  post({ type: 'caption', id, image: img }, [img.data.buffer]);
}

/* chat generation */
function tickChat() {
  if (state.phase === 'live') {
    if (state.pendingChat < MAX_PENDING_CHAT) {
      const sceneChange = state.diffScore > SCENE_CHANGE;
      let count = 1;
      if (sceneChange) count += 1;
      if (Date.now() - state.speechAt < 9000) count += 1;
      if (state.userMsgTicks > 0) count = Math.max(count, 2);
      count = Math.min(count, 3);

      for (let i = 0; i < count; i++) {
        sendChatMessage({ sceneChange, offsetMs: i * 450, burstIndex: i });
      }
      if (state.userMsgTicks > 0) state.userMsgTicks -= 1;
    }
    scheduleNext(tickChat, TICK_CHAT_MS + (Math.random() * 900 - 300));
  }
}

const PERSONAS = [
  'curious — ask the streamer one short question about what you see',
  'totally hyped — short excited burst, caps allowed',
  'confused — ask one short question about something on screen',
  'a regular — treat something on screen like a running joke',
  'backseat gaming — tell the streamer what to do next, unprompted',
  'groan-worthy pun about the scene',
  'over-invested — narrate what is happening like it is a huge deal',
  'suspicious — claim the whole thing looks staged',
  'curious again — ask a follow-up question about the streamer or the room',
];
let personaIdx = (Math.random() * PERSONAS.length) | 0;

/* burst frames: which view of the stream this particular viewer reacts to */
function burstFrames(varied, index) {
  const cur = grabFrameBuffer(els.capture);
  if (!cur) return {};
  const pair = state.prevCapture ? [state.prevCapture, cur] : [cur];
  if (varied && index % 2 === 1) {
    // this viewer gets the wide shot instead of the motion crop
    const wide = grabFrameBuffer(els.captionCapture) || cur;
    return wide === cur ? { frames: pair } : { frames: null, image: wide };
  }
  return { frames: pair };
}

function sendChatMessage({ sceneChange, offsetMs = 0, burstIndex = 0 }) {
  setTimeout(() => {
    if (state.phase !== 'live') return;
    const viewer = sim.pickViewer();
    if (!viewer) return;
    state.pendingChat += 1;
    // persona overrides: called-out viewers get defensive, returning prisoners announce it
    let persona = PERSONAS[personaIdx++ % PERSONAS.length];
    if (viewer.justReturned) {
      persona = 'just back from a timeout — announce your return, dramatically unrepentant';
      viewer.justReturned = false;
    } else if (viewer.warned) {
      persona = 'a mod just yelled at you — act innocent but keep chatting anyway';
    }
    const context = {
      scene: state.scene || 'the stream just started; nobody has described it yet',
      speech: state.speech || '',
      sceneChange,
      userMsg: state.userMsgTicks > 0 ? state.userMsg : '',
      recent: state.lastChatLines,
      persona,
      emotes: state.emoteHint,
    };
    const id = ++state.reqId;
    pendingMeta.set(id, { kind: 'chat', sentAt: performance.now(), context, viewer });
    const msg = { type: 'chat', id, context };
    // scene-change bursts see actual frames; other lines run text-only for speed
    if (sceneChange) {
      Object.assign(msg, burstFrames(state.settings.varied, burstIndex));
      const transfer = [];
      if (msg.frames) msg.frames.forEach((fr) => transfer.push(fr.data.buffer));
      if (msg.image) transfer.push(msg.image.data.buffer);
      post(msg, transfer);
      return;
    }
    post(msg);
  }, offsetMs);
}

function hype() {
  sim.setViewerCount(sim.viewerCount + 3 + ((Math.random() * 5) | 0));
}

function rotateTitle() {
  if (state.phase !== 'live') return;
  state.titleIdx = (state.titleIdx + 1) % TITLES.length;
  els.streamTitle.textContent = TITLES[state.titleIdx];
  scheduleNext(rotateTitle, 45000);
}

/* ---------------- demo feed (no camera) ---------------- */

function startDemoFeed() {
  els.cam.hidden = true;
  els.demoCanvas.hidden = false;
  const c = els.demoCanvas;
  c.width = 1280; c.height = 720;
  const ctx = c.getContext('2d');
  const shapes = Array.from({ length: 7 }, () => ({
    x: Math.random() * 1280, y: Math.random() * 720,
    vx: (Math.random() - 0.5) * 260, vy: (Math.random() - 0.5) * 260,
    r: 26 + Math.random() * 70,
    hue: (Math.random() * 360) | 0,
  }));
  let last = performance.now();
  const frame = (now) => {
    if (state.phase !== 'live' || els.demoCanvas.hidden) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const g = ctx.createLinearGradient(0, 0, 1280, 720);
    g.addColorStop(0, '#1b1033'); g.addColorStop(1, '#31125c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 1280, 720);
    for (const s of shapes) {
      s.x += s.vx * dt; s.y += s.vy * dt;
      if (s.x < s.r || s.x > 1280 - s.r) s.vx *= -1;
      if (s.y < s.r || s.y > 720 - s.r) s.vy *= -1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${s.hue}, 80%, 62%, .8)`;
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.font = '700 64px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('DEMO STREAM', 640, 340);
    ctx.font = '500 30px monospace';
    ctx.fillText(new Date().toLocaleTimeString(), 640, 400);
    state.demoRaf = requestAnimationFrame(frame);
  };
  state.demoRaf = requestAnimationFrame(frame);
}

/* ---------------- mic → transcript ---------------- */

async function startMic() {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.stream = state.stream
    ? new MediaStream([...state.stream.getVideoTracks(), ...mic.getAudioTracks()])
    : mic;

  // Ask for 16 kHz directly (Chrome 74+ resamples in the HAL); if the context
  // comes back at another rate, resampleTo16k handles it before inference.
  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    if (ctx.sampleRate !== 16000) { await ctx.close(); ctx = null; }
  } catch { ctx = null; }
  if (!ctx) ctx = new AudioContext();
  state.audioCtx = ctx;

  await state.audioCtx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
  const src = state.audioCtx.createMediaStreamSource(mic);
  const tap = new AudioWorkletNode(state.audioCtx, 'pcm-tap');
  tap.port.onmessage = (e) => onPcm(e.data);
  src.connect(tap); // never connected to destination → no echo
}

// RMS hysteresis gate (constants per the moonshine-web demo's VAD tuning)
const RMS_ON = 0.010, RMS_OFF = 0.005;
const MIN_SPEECH_MS = 500;
const MAX_CHUNK_MS = 9000;
const SILENCE_HANGOVER_MS = 450;
const TARGET_SR = 16000;

function onPcm(chunk) {
  if (state.phase !== 'live') return;
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  const rms = Math.sqrt(sum / chunk.length);
  const dtMs = (chunk.length / state.audioCtx.sampleRate) * 1000;

  if (rms > RMS_ON) {
    state.speaking = true;
    state.silenceMs = 0;
    state.pcm.push(chunk);
    state.pcmSamples += chunk.length;
  } else if (state.speaking && rms > RMS_OFF) {
    state.silenceMs = 0;
    state.pcm.push(chunk);
    state.pcmSamples += chunk.length;
  } else if (state.speaking) {
    state.silenceMs += dtMs;
    state.pcm.push(chunk);
    state.pcmSamples += chunk.length;
    const spokenMs = (state.pcmSamples / state.audioCtx.sampleRate) * 1000;
    if ((state.silenceMs > SILENCE_HANGOVER_MS && spokenMs > MIN_SPEECH_MS)
        || spokenMs > MAX_CHUNK_MS) {
      flushSpeechChunk();
    }
  }
}

function flushSpeechChunk() {
  const sr = state.audioCtx.sampleRate;
  const total = state.pcm.reduce((a, c) => a + c.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of state.pcm) { merged.set(c, off); off += c.length; }
  state.pcm = []; state.pcmSamples = 0; state.speaking = false; state.silenceMs = 0;
  if (total < sr * 0.6) return; // too short to be speech
  const resampled = resampleTo16k(merged, sr);
  post({ type: 'transcribe', id: ++state.reqId, pcm: resampled }, [resampled.buffer]);
}

function resampleTo16k(input, fromSr) {
  if (fromSr === TARGET_SR) return input;
  const ratio = fromSr / TARGET_SR;
  const outLen = Math.round(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = x | 0;
    const frac = x - i0;
    out[i] = (input[i0] || 0) * (1 - frac) + (input[i0 + 1] || 0) * frac;
  }
  return out;
}

function onTranscript(text) {
  const clean = (text || '').trim();
  if (!clean || /^(thank you|you|\[|\.|\s)*$/i.test(clean)) return;
  state.speech = clean.slice(-300);
  state.speechAt = Date.now();
  showCaption(clean);
}

let captionTimer = 0;
function showCaption(text) {
  els.captions.hidden = false;
  els.captions.textContent = text;
  els.captions.classList.add('on');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => els.captions.classList.remove('on'), 4500);
}

/* ---------------- frame → transferable RGBA ---------------- */

function grabFrameBuffer(c = els.capture) {
  if (!c || !c.width) return null;
  const data = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  const buf = new Uint8Array(data.data.buffer.slice(0));
  return { data: buf, width: c.width, height: c.height };
}

/* ---------------- chat form + wiring ---------------- */

els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text) return;
  els.chatInput.value = '';
  sim.streamer(text);
  state.userMsg = text;
  state.userMsgTicks = 2;
});

els.startBtn.addEventListener('click', start);
els.stopBtn.addEventListener('click', stop);
els.demoToggle.addEventListener('change', () => {
  if (els.demoToggle.checked) els.micToggle.checked = false;
});
els.micToggle.addEventListener('change', () => {
  if (els.micToggle.checked) els.demoToggle.checked = false;
});

// click a username → mod view for that viewer
els.chatMessages.addEventListener('click', (e) => {
  const u = e.target.closest('.user');
  if (!u) return;
  const viewer = sim.byName(u.textContent);
  if (viewer) sim.openModCard(viewer, e.clientX, e.clientY);
});

/* ---------------- settings panel ---------------- */

const SETTINGS_KEY = 'spasmtv-settings';
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch {}
}

els.settingsBtn.addEventListener('click', () => {
  els.settings.hidden = !els.settings.hidden;
  if (!els.settings.hidden) renderLatency();
});
document.addEventListener('click', (e) => {
  if (!els.settings.hidden && !els.settings.contains(e.target) && !e.target.closest('#settings-btn'))
    els.settings.hidden = true;
});

els.setDetail.value = String(state.settings.detail);
els.setDetail.addEventListener('change', () => {
  state.settings.detail = +els.setDetail.value;
  saveSettings();
});
els.setFocus.checked = state.settings.focus;
els.setFocus.addEventListener('change', () => {
  state.settings.focus = els.setFocus.checked;
  saveSettings();
});
els.setVaried.checked = state.settings.varied;
els.setVaried.addEventListener('change', () => {
  state.settings.varied = els.setVaried.checked;
  saveSettings();
});
els.setAsr.value = state.settings.asr;
els.setAsr.addEventListener('change', () => {
  state.settings.asr = els.setAsr.value;
  saveSettings();
  if (state.worker) post({ type: 'asr-model', model: state.settings.asr, preload: state.phase === 'live' });
});

/* ---------------- self-test hook (?autolive) ----------------
 * Dev only: auto-start on load and mirror pipeline stats into document.title
 * so an externally driven browser (fake media flags) can be polled from a shell. */

if (new URLSearchParams(location.search).has('autolive')) {
  setInterval(() => {
    const L = window.__lurker;
    document.title =
      `LURKER phase=${state.phase} chat=${L.chat} cap=${L.cap} asr=${L.asr} err=${L.err.slice(0, 40)} ` +
      `| cap:"${L.lastCap.slice(0, 50)}" | msg:"${L.lastMsg.slice(0, 50)}" | asr:"${L.lastAsr.slice(0, 30)}"`;
  }, 1500);
  setTimeout(() => els.startBtn.click(), 800);
}

/* boot */
(async () => {
  // emote sets are independent of the model — load in the background
  loadEmotes().then((map) => {
    sim.setEmotes(map);
    state.emoteHint = emoteHintFrom(map).join(', ');
  });

  if (!navigator.gpu) {
    setStatus('err', 'WebGPU not available in this browser — Chrome/Edge 113+ (or enable gpu flags).');
    els.startBtn.disabled = true;
    return;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no adapter');
    if (!adapter.features || !adapter.features.has('shader-f16'))
      throw new Error('shader-f16');
    setStatus('', 'ready — pick a brain and go live');
  } catch (err) {
    setStatus('err', err.message === 'shader-f16'
      ? 'this GPU lacks shader-f16 support, which the model requires.'
      : 'WebGPU present but no adapter — hardware acceleration may be off.');
    els.startBtn.disabled = true;
  }
})();
