// main.js — orchestration: camera/demo feed, frame capture + scene diff, chat
// scheduling, mic gate → transcription, captions, worker client.
//
// All model inference happens in workers/llm-worker.js (transformers.js, WebGPU).
// This file never touches model APIs directly — only the message protocol.

import { ChatSim } from './chat-sim.js';

const $ = (id) => document.getElementById(id);

const els = {
  startBtn: $('start-btn'), stopBtn: $('stop-btn'),
  modelSelect: $('model-select'), micToggle: $('mic-toggle'), demoToggle: $('demo-toggle'),
  cam: $('cam'), demoCanvas: $('demo-canvas'), capture: $('frame-capture'),
  offlineCover: $('offline-cover'), overlay: $('overlay'), titleCard: $('title-card'),
  streamTitle: $('stream-title'), captions: $('captions'),
  statusDot: $('status-dot'), statusText: $('status-text'),
  loadProgress: $('load-progress'), loadBar: $('load-bar'), loadPct: $('load-pct'),
  chatForm: $('chat-form'), chatInput: $('chat-input'), chatPanel: $('chat-panel'),
};

const CAPTURE_SIZE = 512;         // longest side handed to the vision model — LFM2.5-VL
                                  // tiles beyond 512×512, so stay under it (~144 img tokens @16:9)
const DIFF_W = 64, DIFF_H = 36;   // luma thumbnail used for scene-change detection
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
  // vision
  prevThumb: null, diffScore: 0,
  scene: '', sceneAt: 0,
  // audio gate
  pcm: [], pcmSamples: 0, speaking: false, silenceMs: 0,
  // chat context
  speech: '', speechAt: 0, userMsg: '', userMsgTicks: 0,
  lastChatLines: [],
  titleIdx: 0,
};

const sim = new ChatSim();

/* ---------------- worker client ---------------- */

function ensureWorker() {
  if (state.worker) return state.worker;
  const w = new Worker(new URL('../workers/llm-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = onWorkerMessage;
  w.onerror = (e) => setStatus('err', `worker error: ${e.message || 'unknown'}`);
  state.worker = w;
  return w;
}

function post(msg, transfer = []) { ensureWorker().postMessage(msg, transfer); }

function onWorkerMessage(ev) {
  const m = ev.data;
  if (m.type === 'progress') {
    els.loadProgress.hidden = false;
    const pct = Math.round((m.progress || 0) * 100);
    els.loadBar.style.width = pct + '%';
    els.loadPct.textContent = pct + '%';
  } else if (m.type === 'ready') {
    els.loadProgress.hidden = true; els.loadPct.textContent = '';
    goLiveAfterLoad();
  } else if (m.type === 'error') {
    setStatus('err', m.message);
    els.loadProgress.hidden = true;
    resetToIdle();
  } else if (m.type === 'caption') {
    state.scene = m.text; state.sceneAt = Date.now();
  } else if (m.type === 'chat') {
    state.pendingChat = Math.max(0, state.pendingChat - 1);
    for (const text of m.messages || []) sim.chat(text);
    state.lastChatLines = [...state.lastChatLines, ...(m.messages || [])].slice(-4);
  } else if (m.type === 'transcribe') {
    onTranscript(m.text);
  }
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
  post({ type: 'load', model: els.modelSelect.value, asr: els.micToggle.checked });
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

/* frame grab + scene diff */
function tickFrame() {
  if (state.phase === 'live') {
    const src = activeSource();
    if (src && (src.readyState === undefined || src.readyState >= 2)) {
      const c = els.capture;
      const aspect = (src.videoWidth || src.width || 16) / (src.videoHeight || src.height || 9);
      const w = aspect >= 1 ? CAPTURE_SIZE : Math.round(CAPTURE_SIZE * aspect);
      const h = aspect >= 1 ? Math.round(CAPTURE_SIZE / aspect) : CAPTURE_SIZE;
      c.width = w; c.height = h;
      c.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, w, h);
      state.diffScore = sceneDiff(c);
    }
    scheduleNext(tickFrame, TICK_FRAME_MS);
  }
}

function sceneDiff(captureCanvas) {
  const t = document.createElement('canvas');
  t.width = DIFF_W; t.height = DIFF_H;
  const ctx = t.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(captureCanvas, 0, 0, DIFF_W, DIFF_H);
  const px = ctx.getImageData(0, 0, DIFF_W, DIFF_H).data;
  const luma = new Float32Array(DIFF_W * DIFF_H);
  for (let i = 0, j = 0; i < px.length; i += 4, j++)
    luma[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  let score = 0;
  if (state.prevThumb) {
    let acc = 0;
    for (let k = 0; k < luma.length; k++) acc += Math.abs(luma[k] - state.prevThumb[k]);
    score = acc / luma.length / 255;
  }
  state.prevThumb = luma;
  return score;
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
  const img = grabFrameBuffer();
  if (!img) return;
  post({ type: 'caption', id: ++state.reqId, image: img }, [img.data.buffer]);
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

      for (let i = 0; i < count; i++) sendChatMessage({ sceneChange, offsetMs: i * 450 });
      if (state.userMsgTicks > 0) state.userMsgTicks -= 1;
    }
    scheduleNext(tickChat, TICK_CHAT_MS + (Math.random() * 900 - 300));
  }
}

const PERSONAS = [
  'hype viewer, sometimes all caps',
  'confused lurker asking a short question',
  'regular viewer making an inside joke',
  'backseat gamer giving unsolicited advice',
  'cringe jokester',
  'over-invested viewer narrating everything',
  'skeptical viewer who suspects it is staged',
];
let personaIdx = (Math.random() * PERSONAS.length) | 0;

function sendChatMessage({ sceneChange, offsetMs = 0 }) {
  setTimeout(() => {
    if (state.phase !== 'live') return;
    state.pendingChat += 1;
    const msg = {
      type: 'chat',
      id: ++state.reqId,
      context: {
        scene: state.scene || 'the stream just started; nobody has described it yet',
        speech: state.speech || '',
        sceneChange,
        userMsg: state.userMsgTicks > 0 ? state.userMsg : '',
        recent: state.lastChatLines,
        persona: PERSONAS[personaIdx++ % PERSONAS.length],
      },
    };
    // scene-change bursts react to the actual frame; other lines run text-only
    if (sceneChange) {
      const img = grabFrameBuffer();
      if (img) { msg.image = img; post(msg, [img.data.buffer]); return; }
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
  els.captions.textContent = text;
  els.captions.classList.add('on');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => els.captions.classList.remove('on'), 4500);
}

/* ---------------- frame → transferable RGBA ---------------- */

function grabFrameBuffer() {
  const c = els.capture;
  if (!c.width) return null;
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

/* boot */
(async () => {
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
