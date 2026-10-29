// main.js — orchestration: camera/demo feed, frame capture + scene diff, chat
// scheduling, mic gate → transcription, captions, worker client.
//
// All model inference happens in workers/llm-worker.js (transformers.js, WebGPU).
// This file never touches model APIs directly — only the message protocol.

import { ChatSim, ROSTER_KEY } from './chat-sim.js';
import { tune, loadTune, resetTune, kindWeights, workerTune, renderTunePanel } from './tuning.js';
import { STYLE_EXAMPLES } from './style-examples.js';
import { CANNED_POOL } from './real-lines.js';
import { loadEmotes, emoteHintFrom } from './emotes.js';
import {
  pickKind, gateKind, nextGapMs, planBurst, templateLine, maybeBit, liveBits, maybePasta,
  PILE_ON_MS, pileOnBurst, pileOnGap, breatherGap, pileOnKind, threadSeed, threadDelayMs,
  seedContagion, contagionEcho, subGapMs, subNotice, subCheer,
} from './cadence.js';
import {
  factionFor, cultureLine, patternOf, trollWeight, defies, moodOf, MOOD_GAP,
  onlookerLine, reliefLine, deadChatLine, spotLine,
} from './culture.js';

const $ = (id) => document.getElementById(id);

const els = {
  startBtn: $('start-btn'), stopBtn: $('stop-btn'),
  modelSelect: $('model-select'), micToggle: $('mic-toggle'), demoToggle: $('demo-toggle'),
  shareToggle: $('share-toggle'), fileBtn: $('file-btn'), fileInput: $('file-input'),
  cam: $('cam'), demoCanvas: $('demo-canvas'), fileVideo: $('file-video'), capture: $('frame-capture'),
  captionCapture: $('caption-capture'),
  offlineCover: $('offline-cover'), overlay: $('overlay'), titleCard: $('title-card'),
  streamTitle: $('stream-title'), captions: $('captions'),
  statusDot: $('status-dot'), statusText: $('status-text'), latChip: $('lat-chip'),
  loadProgress: $('load-progress'), loadBar: $('load-bar'), loadPct: $('load-pct'),
  chatForm: $('chat-form'), chatInput: $('chat-input'), chatPanel: $('chat-panel'),
  chatMessages: $('chat-messages'),
  settingsBtn: $('settings-btn'), settings: $('settings'),
  feed: $('feed'), feedLog: $('feed-log'), feedCount: $('feed-count'),
  setDetail: $('set-detail'), setFocus: $('set-focus'), setVaried: $('set-varied'),
  setAsr: $('set-asr'), setLatency: $('set-latency'),
  factInput: $('fact-input'), factAdd: $('fact-add'),
  factList: $('fact-list'), factClear: $('fact-clear'),
};

const CAPTURE_DEFAULT = 512;      // vision detail (settings panel: 512/640/768 —
                                  // above 512 the model tiles the frame)
const DIFF_W = 32, DIFF_H = 18;   // motion grid used for scene diff + focus crop
const FULL_W = 960;               // working resolution frames are grabbed at
// tunable now (js/tuning.js): SCENE_CHANGE = 0.055;       // mean abs luma delta that counts as a "clip it!" moment

// tunable now (js/tuning.js): TICK_FRAME_MS = 1500;       // frame grab cadence
// tunable now (js/tuning.js): TICK_CAPTION_MS = 8000;     // scene re-caption cadence
// tunable now (js/tuning.js): MAX_PENDING_CHAT = 2;

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
  shareStream: null,        // MediaStream (getDisplayMedia: tab/screen)
  audioCtx: null,
  fileVideoUrl: null,       // object URL (picker/drop) or served path (?video=) for the file source
  fileVideoIsBlob: false,
  source: 'cam',            // cam | demo | share | file
  demoRaf: 0,
  phoneMode: false,        // iPhone/iPad/Android phone (or ?phone): SmolVLM-256M brain, no ASR
  grammar: true,           // §H/U8 regex guard on the chat path (off with ?grammar=0)
  // settings (settings panel, persisted)
  settings: { detail: CAPTURE_DEFAULT, focus: true, varied: true, asr: 'base' },
  // vision
  prevThumb: null, diffScore: 0,
  fullCanvas: null,         // working-res frame for crops + diff
  prevCapture: null,        // last tick's capture buffer — the "before" in before/after bursts
  diffMax: 0, hotMax: 0,    // peak motion since the last caption (logged with it)
  motionHist: [],           // the last ~30 s of motion scores: the baseline a change must spike over
  sceneChangeAt: 0,         // when the frame last changed (latched — consumers check against it)
  sceneCapHandled: 0, sceneChatHandled: 0,   // the change each consumer already acted on
  chatTimer: 0,             // the pending chatLoop tick, so a scene change can pull it forward
  waveOn: false,            // the last chat tick was part of a pile-on (the next gap is a breather)
  scene: '', sceneAt: 0, sceneHistory: [],
  // audio gate
  pcm: [], pcmSamples: 0, speaking: false, silenceMs: 0,
  // chat context
  speech: '', speechAt: 0, speechChatHandled: 0, userMsg: '', userMsgTicks: 0, contagion: null,
  lastChatLines: [],        // ring of {name, text} — the window replies quote from
  bits: [],                 // running jokes (§C), each {text, until}
  templateRecent: [],       // freshness ring: template lines the crowd just heard
  culture: null,            // §D moderation culture state, see cultureState()
  hypeAt: 0,
  emoteHint: '',
  titleIdx: 0,
  // per-kind round-trip latency (ms, last 10)
  latency: { chat: [], cap: [], asr: [] },
  // chat memory: things the streamer stated as fact (settings panel, localStorage)
  facts: [],
};

const sim = new ChatSim();
// §D: the crowd reacts to moderation, the model does not have to guess it
sim.onModAction = (a) => onModAction(a);
sim.onCenter = (v) => onCenter(v);
sim.onUncenter = (v) => onUncenter(v);

// pipeline counters; the ?autolive self-test mirrors these into document.title
window.__spasmtv = { chat: 0, cap: 0, asr: 0, err: '', lastMsg: '', lastCap: '', lastAsr: '' };

/* ---------------- chat log (local only) ----------------
 * Every generated message is stored with the context that produced it, so chat
 * quality can be reviewed/tuned after a session. The log carries what the
 * streamer said (transcripts) and typed, so it lives in memory and dies with
 * the tab; ?log=1 opts into a localStorage mirror that survives reloads.
 * Dump from the console:
 *   __spasmDump()               → JSON string
 *   __spasmDownload()           → saves spasmtv-chatlog-<date>.jsonl */

const LOG_KEY = 'spasmtv-log';
const LOG_PERSIST = new URLSearchParams(location.search).get('log') === '1';
const chatLog = [];
try {
  // builds before 2026-10-28 mirrored every transcript here without asking
  localStorage.removeItem('lurker-log');
  if (LOG_PERSIST) {
    const prev = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    if (Array.isArray(prev)) chatLog.push(...prev);
  } else {
    localStorage.removeItem(LOG_KEY);
  }
} catch {}

const pendingMeta = new Map(); // reqId → {kind, sentAt, context, viewer} for latency + attribution

function logEvent(kind, text, ctx) {
  chatLog.push({ t: new Date().toISOString(), kind, text, ...(ctx ? { ctx } : {}) });
  if (chatLog.length > 2000) chatLog.splice(0, chatLog.length - 2000);
  if (LOG_PERSIST) try { localStorage.setItem(LOG_KEY, JSON.stringify(chatLog.slice(-400))); } catch {}
}

function forgetLog() {
  chatLog.length = 0;
  try { localStorage.removeItem(LOG_KEY); localStorage.removeItem('lurker-log'); } catch {}
}

window.__spasmDump = () => JSON.stringify(chatLog, null, 1);
window.__spasmDownload = () => {
  const blob = new Blob([chatLog.map((e) => JSON.stringify(e)).join('\n')], { type: 'application/jsonl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spasmtv-chatlog-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

/* ---------------- worker client ---------------- */

function ensureWorker() {
  if (state.worker) return state.worker;
  const w = new Worker(new URL('../workers/llm-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = onWorkerMessage;
  w.onerror = (e) => {
    window.__spasmtv.err = e.message || 'worker error';
    setStatus('err', `worker error: ${e.message || 'unknown'}`);
  };
  state.worker = w;
  window.__spasmtv.worker = w; // test/debug hook — the ablation tools drive the worker directly through it
  return w;
}

function post(msg, transfer = []) { ensureWorker().postMessage(msg, transfer); }

function onWorkerMessage(ev) {
  const m = ev.data;
  if (m.jerr) window.__spasmtv.err = 'job: ' + m.jerr; // surfaces in the autolive title
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
  } else if (m.type === 'grammar-off') {
    // the guard is optional; the rubric run needs to know it went away
    logEvent('guard', 'off', { error: m.error });
  } else if (m.type === 'ready') {
    if (m.grammar !== undefined) logEvent('guard', m.grammar ? 'on' : 'off');
    els.loadProgress.hidden = true; els.loadPct.textContent = '';
    goLiveAfterLoad();
  } else if (m.type === 'error') {
    window.__spasmtv.err = m.message || 'unknown';
    setStatus('err', m.message);
    els.loadProgress.hidden = true;
    resetToIdle();
  } else if (m.type === 'asr-ready') {
    if (state.phase === 'live') setStatus('ok', 'live — the chat can see you and hear you');
  } else if (m.type === 'dbg') {
    window.__spasmtv.dbg = m.shapes;
  } else if (m.type === 'caption') {
    noteLatency(m.id, 'cap');
    window.__spasmtv.cap += 1;
    window.__spasmtv.lastCap = m.text || '';
    // the motion peak since the previous caption rides along, so a log shows
    // how close real footage came to the scene-change threshold
    logEvent('caption', m.text || '', {
      diffMax: +state.diffMax.toFixed(4), hotMax: +state.hotMax.toFixed(3),
      ...(m.prompt ? { prompt: m.prompt } : {}),
    });
    pushFeed({ kind: 'caption', out: m.text || '', prompt: m.prompt, brain: m.brain });
    state.diffMax = 0; state.hotMax = 0;
    state.scene = m.text; state.sceneAt = Date.now();
    // rolling scene memory = StreamingVLM's "long text window": a short history
    // of what the screen showed, so a reaction can reference a change over time
    // instead of only the current frame. Deduped so a static scene doesn't pad
    // it with the same caption.
    if (m.text) {
      const last = state.sceneHistory[state.sceneHistory.length - 1];
      if (!last || last.toLowerCase() !== m.text.toLowerCase())
        state.sceneHistory = [...state.sceneHistory, m.text].slice(-4);
    }
  } else if (m.type === 'chat') {
    noteLatency(m.id, 'chat');
    state.pendingChat = Math.max(0, state.pendingChat - 1);
    window.__spasmtv.chat += (m.messages || []).length;
    if (m.messages?.length) window.__spasmtv.lastMsg = m.messages[m.messages.length - 1];
    const entry = pendingMeta.get(m.id);
    pendingMeta.delete(m.id);
    if (state.phase !== 'live') return;   // a reply that lands after "End stream"
    (m.messages || []).forEach((text) => {
      let viewer = entry?.viewer;
      if (!viewer || (viewer.bannedUntil && viewer.bannedUntil > Date.now()))
        viewer = sim.pickViewer(viewerWeights());
      // the kind promised a question; a 450M that forgot the mark gets the free
      // template rather than a statement wearing a question badge (§F rate)
      const templated = entry?.kind === 'question' && !text.includes('?');
      let finalText = templated ? templateLine('question', { recent: state.templateRecent }) : text;
      // A reply names who it answers. On real Twitch the reply button inserts
      // the @mention, so a reply with no name reads as fake — measured 0% of
      // our lines named another chatter against 4-11% in the small rooms.
      const rt = entry?.context?.replyTo;
      if (rt?.name && !finalText.toLowerCase().includes(rt.name.toLowerCase()))
        finalText = `@${rt.name} ${finalText}`;
      const shown = sim.chat(finalText, viewer || undefined);
      if (!shown) return;
      // the log carries what the §F scorer measures: message kind, archetype,
      // the rendered line (emotes and all) and, implicitly, that a model wrote it
      logEvent('chat', finalText, {
        ...(entry?.context || {}),
        ...(m.prompt ? { prompt: m.prompt, sawFrame: m.sawFrame } : {}),
        ...(templated ? { model: false } : {}),   // swapped for a template
        kind: m.kind || entry?.kind || 'reaction',
        calls: m.calls, drops: m.drops,
        viewer: shown.name,
        archetype: shown.archetypeKey,
        shown: sim.lastRendered,
        codes: sim.lastEmotes,
      });
      trackRecent(shown.name, finalText);
      state.bits = maybeBit(state.bits, finalText, { hype: entry?.hype });
      pushFeed({ kind: 'chat', out: finalText, prompt: m.prompt, sawFrame: m.sawFrame, brain: m.brain });
    });
  } else if (m.type === 'transcribe') {
    noteLatency(m.id, 'asr');
    window.__spasmtv.asr += 1;
    window.__spasmtv.lastAsr = (m.text || '').slice(0, 80);
    logEvent('asr', m.text || '');
    if (m.fact) addFact(m.fact);
    onTranscript(m.text);
  }
}

/* ---------------- chat memory (facts) ---------------- */

const FACTS_KEY = 'spasmtv-facts';

function loadFacts() {
  try {
    const arr = JSON.parse(localStorage.getItem(FACTS_KEY) || '[]');
    if (Array.isArray(arr)) state.facts = arr.filter((f) => f && typeof f.text === 'string');
  } catch { state.facts = []; }
}

function saveFacts() {
  try { localStorage.setItem(FACTS_KEY, JSON.stringify(state.facts.slice(-50))); } catch {}
}

function addFact(text) {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) return;
  const norm = clean.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  if (state.facts.some((f) => f.text.toLowerCase().replace(/[^a-z0-9 ]/g, '') === norm)) return;
  state.facts.push({ t: new Date().toISOString(), text: clean });
  if (state.facts.length > 50) state.facts.shift();
  saveFacts();
  renderFacts();
}

function factsForContext() {
  const tail = state.facts.slice(-8).map((f) => f.text).join('; ');
  return tail.length > 300 ? tail.slice(-300) : tail;
}

function renderFacts() {
  if (!state.facts.length) {
    els.factList.innerHTML = '<div class="set-note">chat hasn\'t learned anything yet — say a fact out loud, or add one.</div>';
    return;
  }
  els.factList.innerHTML = state.facts
    .map((f, i) =>
      `<div class="fact-row"><span class="fact-text"></span>` +
      `<button class="fact-del" data-i="${i}">✕</button></div>`)
    .join('');
  els.factList.querySelectorAll('.fact-text').forEach((el, i) => {
    el.textContent = state.facts[i].text;
  });
  els.factList.querySelectorAll('.fact-del').forEach((b) => {
    b.onclick = () => {
      state.facts.splice(+b.dataset.i, 1);
      saveFacts();
      renderFacts();
    };
  });
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

/* ---------------- §D: moderation-tuned culture ----------------
 * Who the mods ban changes what chat becomes. Every mod action is recorded with
 * what the victim was saying, that pattern becomes a ~5 min standing rule, the
 * crowd splits into factions about the ban, trolls get louder the longer the
 * mods go quiet, and a purge leaves chat quieter and resentful. */

function cultureState() {
  if (!state.culture)
    state.culture = { actions: [], note: '', noteUntil: 0, lastActionAt: Date.now(), centered: null, mood: 'calm' };
  const c = state.culture;
  const now = Date.now();
  if (c.noteUntil && now > c.noteUntil) { c.note = ''; c.noteUntil = 0; }
  c.mood = moodOf(c.actions, now);
  return c;
}

// trolls gain ground while nobody is moderated — the community needs its mod.
// Centering someone without acting counts as quiet: it never touches
// lastActionAt, so the entropy feed keeps rising.
function viewerWeights() {
  const c = cultureState();
  const now = Date.now();
  return (v) => (tune['freq_' + v.archetypeKey] ?? 1)
    * (v.archetypeKey === 'troll' ? trollWeight(now, c.lastActionAt, tune.trollBase) : 1);
}

function logTemplate(text, viewer, kind, ctx = {}) {
  const shown = sim.chat(text, viewer);
  if (!shown) return null;
  logEvent('chat', text, {
    kind, model: false, viewer: shown.name, archetype: shown.archetypeKey,
    shown: sim.lastRendered, codes: sim.lastEmotes, ...ctx,
  });
  trackRecent(shown.name, text);
  // the freshness ring: pickers check this before choosing, so the crowd never
  // hears the same culture line twice in short succession (chants/pastas exempt)
  state.templateRecent.push(
    (text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim());
  if (state.templateRecent.length > 16) state.templateRecent.shift();
  return shown;
}

function onModAction({ action, viewer }) {
  const c = cultureState();
  const now = Date.now();
  c.actions.push({ t: now, action, name: viewer.name });
  if (c.actions.length > 40) c.actions.shift();
  c.lastActionAt = now;
  // only real bans teach a rule; a yell is noise. Victims get 2–4 lines of
  // chat about them, so the crowd is never just a system message.
  if (action === 'timeout' || action === 'ban') {
    const pattern = patternOf(viewer.msgs.slice(-3));
    if (pattern) { c.note = pattern; c.noteUntil = now + 300e3; }
  }
  // the rubric measures ban-reaction latency against this event
  logEvent('mod', action, {
    viewer: viewer.name, archetype: viewer.archetypeKey, pattern: c.note, mood: c.mood,
  });
  banReactionBurst(viewer, action);
}

function banReactionBurst(victim, action) {
  const last = victim.msgs.slice(-1)[0]?.text || '';
  const n = 2 + ((Math.random() * 3) | 0);          // 2–4 lines
  const used = new Set([victim.name]);
  let modelUsed = false;
  for (let i = 0; i < n; i++) {
    // the rubric wants the first reaction inside 6 s, so line 0 fires fast
    const delay = i === 0 ? 250 + Math.random() * 1200 : 400 + Math.random() * 4200;
    setTimeout(() => {
      if (state.phase !== 'live') return;
      const v = sim.pickViewer(viewerWeights());
      if (!v || used.has(v.name)) return;
      used.add(v.name);
      if (!modelUsed && state.pendingChat < tune.maxPending && Math.random() < tune.banModelChance / 100) {
        modelUsed = true;   // exactly one model line per burst, the rest are free
        sendChatMessage({
          viewer: v, kind: 'banreact', sceneChange: false,
          ban: { name: victim.name, last, action },
        });
        return;
      }
      cultureLog(cultureLine(factionFor(v.archetypeKey), victim.name, Math.random, state.templateRecent), v, victim, action);
    }, delay);
  }
}

function cultureLog(text, viewer, victim, action) {
  logTemplate(text, viewer, 'banreact', { ban: { name: victim.name, action } });
}

/* centering: opening someone's card is a public event */
function onCenter(viewer) {
  const c = cultureState();
  c.centered = viewer;
  const used = new Set([viewer.name]);
  const onlookers = 2 + ((Math.random() * 2) | 0);   // 2–3 onlooker lines
  for (let i = 0; i < onlookers; i++) {
    setTimeout(() => {
      if (state.phase !== 'live' || cultureState().centered !== viewer) return;
      const v = sim.pickViewer(viewerWeights());
      if (!v || used.has(v.name)) return;
      used.add(v.name);
      const text = onlookerLine(viewer.name, Math.random, state.templateRecent);
      logTemplate(text, v, 'spot', { spot: viewer.name });
    }, 300 + Math.random() * 2600);
  }
  // the viewer on the spot gets one guaranteed line, persona-aware
  setTimeout(() => {
    if (state.phase !== 'live' || cultureState().centered !== viewer) return;
    if (state.pendingChat >= tune.maxPending) {
      logTemplate(spotLine(viewer.archetypeKey, Math.random, state.templateRecent), viewer, 'spot', { spot: viewer.name });
      return;
    }
    sendChatMessage({ viewer, kind: 'spot', sceneChange: false, spot: true });
  }, 900 + Math.random() * 1600);
}

function onUncenter(viewer) {
  const c = cultureState();
  if (!viewer || c.centered !== viewer) return;
  c.centered = null;
  // card closed with no action → relief beat, and the tension keeps building
  const used = new Set([viewer?.name]);
  for (let i = 0; i < 2; i++) {
    setTimeout(() => {
      if (state.phase !== 'live') return;
      const v = sim.pickViewer(viewerWeights());
      if (!v || used.has(v.name)) return;
      used.add(v.name);
      logTemplate(reliefLine(Math.random, state.templateRecent, viewer.name), v, 'relief', { spot: viewer.name });
    }, 400 + i * 700 + Math.random() * 900);
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
  post({
    type: 'load',
    model: els.modelSelect.value,
    phone: state.phoneMode,
    grammar: state.grammar,
    asr: els.micToggle.checked,
    asrModel: state.settings.asr,
  });
}

async function goLiveAfterLoad() {
  try {
    // precedence: file (?video= / picker / drop) > share > demo > camera
    state.source = state.fileVideoUrl ? 'file'
      : els.shareToggle.checked ? 'share'
      : (els.demoToggle.checked ? 'demo' : 'cam');
    if (state.source === 'share') {
      await startShareFeed();
    } else if (state.source === 'file') {
      await startFileFeed();
    } else if (state.source === 'demo') {
      startDemoFeed();
    } else {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
      els.cam.srcObject = state.stream;
      els.cam.hidden = false;
      els.demoCanvas.hidden = true;
    }
    // share/file feeds carry their own audio (wired in their start function);
    // the mic is only for the camera / demo sources.
    if (els.micToggle.checked && !state.audioCtx) await startMic();
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

  state.scene = ''; state.sceneAt = 0; state.sceneHistory = []; state.speech = ''; state.speechChatHandled = 0; state.lastChatLines = [];
  // replies still in flight from a previous stream must not hold GPU slots
  state.pendingChat = 0; pendingMeta.clear(); state.diffMax = 0; state.hotMax = 0;
  state.motionHist = []; state.prevThumb = null;
  state.sceneChangeAt = 0; state.sceneCapHandled = 0; state.sceneChatHandled = 0; state.waveOn = false;
  state.bits = []; state.culture = null; state.hypeAt = 0; state.templateRecent = [];
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
  stopVideoSources();
  els.captions.classList.remove('on');
  els.offlineCover.hidden = false;
  els.overlay.hidden = true;
  els.titleCard.hidden = true;
}

/* ---------------- loops ---------------- */

function startLoops() {
  cancelLoops();
  state.loops.push(setTimeout(tickFrame, tune.tickFrame));
  state.loops.push(setTimeout(tickCaption, 400));
  state.chatTimer = setTimeout(chatLoop, 1800);
  state.loops.push(state.chatTimer);
  state.loops.push(setTimeout(subLoop, 12000));
  state.loops.push(setTimeout(rotateTitle, 45000));
}

function cancelLoops() {
  state.chatTimer = 0;
  state.loops.forEach(id => { clearTimeout(id); clearInterval(id); cancelAnimationFrame(id); });
  state.loops = [];
  if (state.demoRaf) { cancelAnimationFrame(state.demoRaf); state.demoRaf = 0; }
}

function scheduleNext(fn, ms) {
  const id = setTimeout(fn, ms);
  state.loops.push(id);
  return id;
}

/* the room has an economy (Layer 5, law 8/9): subs, resubs, gifts land as
 * notices and the room reacts within seconds. A small room sits at the low end
 * of the measured 0.1-7.6 notices/min — roughly one every 1-2 min. */
function subLoop() {
  if (state.phase !== 'live') return;
  const sub = subNotice();
  const viewer = sim.pickViewer(() => 1);
  if (viewer) {
    const text = sim.subNoticeLine(viewer, sub);
    logEvent('notice', text, { sub, viewer: viewer.name });
    subCheerBurst(viewer, sub);
  }
  scheduleNext(subLoop, subGapMs());
}

// 2-4 viewers congratulate the sub within a few seconds — free templates, the
// room acknowledging its own economy (mirrors banReactionBurst).
function subCheerBurst(subscriber, sub) {
  const n = 2 + ((Math.random() * 3) | 0);
  const used = new Set([subscriber.name]);
  for (let i = 0; i < n; i++) {
    const delay = i === 0 ? 300 + Math.random() * 1200 : 500 + Math.random() * 3500;
    setTimeout(() => {
      if (state.phase !== 'live') return;
      const v = sim.pickViewer(viewerWeights());
      if (!v || used.has(v.name)) return;
      used.add(v.name);
      logTemplate(subCheer(), v, 'subcheer', { sub: { name: subscriber.name, months: sub.months } });
    }, delay);
  }
}

function activeSource() {
  if (!els.fileVideo.hidden) return els.fileVideo;
  return els.demoCanvas.hidden ? els.cam : els.demoCanvas;
}

/* frame grab: full working canvas → motion grid → capture (maybe focus-cropped) */
function tickFrame() {
  if (state.phase !== 'live') return;
  const src = activeSource();
  // a throw here (e.g. a source that taints the canvas) must not end the loop
  try {
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
      state.diffMax = Math.max(state.diffMax, motion.score);
      state.hotMax = Math.max(state.hotMax, motion.hotFrac);
      drawCapture(f, motion);
      noteMotion(motion.score);
    }
  } catch (err) {
    window.__spasmtv.err = 'frame: ' + (err?.message || err);
    setStatus('err', `can't read frames from this source: ${err?.message || err}`);
  }
  scheduleNext(tickFrame, tune.tickFrame);
}

// A scene change is a SPIKE over the last ~30 s of motion, not a fixed level.
// Measured on 10 min of each test video: a drawing-stream VOD peaked at 0.054
// and never crossed the old fixed 0.055, while an edited video sat above it on
// every tick (median 0.09). Floor 0.02 × 3 over the median fires ~1.2/min on both.
function noteMotion(score) {
  const hist = state.motionHist;
  const sorted = [...hist].sort((a, b) => a - b);
  const base = hist.length >= 4 ? sorted[sorted.length >> 1] : 0;
  hist.push(score);
  if (hist.length > 20) hist.shift();
  if (score <= tune.sceneFloor || score <= tune.sceneSpike * base) return;
  if (Date.now() - state.sceneChangeAt < 4000) return;
  state.sceneChangeAt = Date.now();
  logEvent('scene', '', { score: +score.toFixed(4), base: +base.toFixed(4) });
  // chat reacts now, not whenever the next tick happens to land: pull the
  // pending chatLoop forward (one chain — it reschedules itself)
  if (state.chatTimer) { clearTimeout(state.chatTimer); state.chatTimer = 0; chatLoop(); }
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
    motion.hotFrac > 0.02 && motion.hotFrac < 0.45 && motion.score > tune.sceneFloor * 0.4;
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
      // zoomed window that KEEPS the source aspect — square crops (512×512)
      // land exactly on the model's tiling boundary and break token expansion
      const size = Math.round(Math.min(full.width, full.height) * 0.6);
      sw = size;
      sh = Math.round(size * full.height / full.width);
      sx = Math.max(0, Math.min(full.width - sw, Math.round(cx - sw / 2)));
      sy = Math.max(0, Math.min(full.height - sh, Math.round(cy - sh / 2)));
    }
  }

  // 448 box: below the 512 tiling boundary even for square-ish crops
  const box = S.detail - 64;
  const scale = Math.min(box / sw, box / sh);
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
  const stale = Date.now() - state.sceneAt > tune.tickCaption;
  const sceneChange = state.sceneChangeAt > state.sceneCapHandled && Date.now() - state.sceneAt > 4000;
  if ((stale || sceneChange) && els.capture.width > 0) {
    if (sceneChange) { state.sceneCapHandled = state.sceneChangeAt; hype(); }
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

/* chat generation — §C: a kind scheduler on top of a bursty clock.
 * The old loop was one line every 2.3 s like a metronome; real chat is droughts
 * and pile-ons. js/cadence.js holds the pure parts (weights, gaps, bursts) so
 * tools/test-cadence.mjs can prove the rate budget without a browser — it must
 * stay at or under the shipped 20 lines/min and 20 generate calls/min. */
function chatLoop() {
  if (state.phase !== 'live') return;
  state.chatTimer = 0;
  // the first burst after the frame changed looks at it — consumed once, so one
  // cut is one reaction burst rather than every tick for the next few seconds
  const sceneChange = state.sceneChangeAt > state.sceneChatHandled && Date.now() - state.sceneChangeAt < 8000;
  if (sceneChange) state.sceneChatHandled = state.sceneChangeAt;
  // …and the ticks after it are the pile-on (js/cadence.js): one quick line each
  const piling = !sceneChange && state.sceneChangeAt > 0 && Date.now() - state.sceneChangeAt < PILE_ON_MS;
  // a transcript the room hasn't reacted to yet (set by onTranscript, consumed
  // once here so one spoken sentence is one reaction, not a burst every tick)
  const speechTrigger = state.speechAt > state.speechChatHandled && Date.now() - state.speechAt < 6000;
  if (speechTrigger) state.speechChatHandled = state.speechAt;
  const burst = sceneChange ? pileOnBurst() : piling ? { n: 1, offsets: [0], chant: false } : planBurst(Math.random, tune);
  // a spoken sentence always earns at least one line — a drought burst (n=0)
  // must not swallow the reaction the north star promises within seconds.
  if (speechTrigger && burst.n < 1) { burst.n = 1; burst.offsets = [0]; }
  // (piling alone isn't hype: hype turns a third of emote lines into keysmash)
  const hype = sceneChange || Date.now() - state.hypeAt < 2500;
  // a chant = the whole burst is one emote, from three different viewers
  const chant = burst.chant ? sim.randomEmote() : null;
  for (let i = 0; i < burst.n; i++) {
    fireLine({ offsetMs: burst.offsets[i], burstIndex: i, hype, chant, sceneChange, piling, speechTrigger });
  }
  if (state.userMsgTicks > 0) state.userMsgTicks -= 1;
  const c = cultureState();
  // a purge leaves chat quieter and resentful: wider gaps, occasional dead-chat
  // line from a template (free — the GPU stays on the real reactions)
  if (c.mood !== 'calm' && Math.random() < (c.mood === 'purge' ? 0.09 : 0.03)) {
    const v = sim.pickViewer(viewerWeights());
    if (v) logTemplate(deadChatLine(Math.random, state.templateRecent), v, 'mood');
  }
  const waveOn = sceneChange || piling;
  const gap = waveOn ? pileOnGap() : state.waveOn ? breatherGap() : nextGapMs(Math.random, tune) * MOOD_GAP[c.mood];
  state.waveOn = waveOn;
  state.chatTimer = scheduleNext(chatLoop, gap);
}

const CANNABLE = new Set(['reaction', 'banter', 'backseat', 'meta', 'greeting']);

function fireLine({ offsetMs = 0, burstIndex = 0, hype = false, chant = null, sceneChange = false, piling = false, speechTrigger = false }) {
  setTimeout(() => {
    if (state.phase !== 'live') return;
    const viewer = sim.pickViewer(viewerWeights());
    if (!viewer) return;
    const bits = liveBits(state.bits);
    let kind = gateKind(chant ? 'emote' : piling ? pileOnKind() : pickKind(Math.random, kindWeights()), viewer, {
      bits,
      recent: state.lastChatLines,
      userMsg: state.userMsgTicks > 0 ? state.userMsg : '',
      hype,
    });
    // the streamer addressed chat → the next line answers them, dice be damned
    if (state.userMsgTicks > 0 && kind !== 'emote') kind = 'reply';
    // the streamer just said something out loud → the first line of this burst
    // reacts to it. 'reaction' is the visual kind that carries the speech line
    // into the prompt; forcing it (over emote/canned/pasta shortcuts) is what
    // makes the room actually answer what was said instead of ignoring it.
    const answerSpeech = speechTrigger && burstIndex === 0 && !!state.speech;
    if (answerSpeech) kind = 'reaction';
    if (kind === 'emote') {
      const text = templateLine('emote', { emote: () => sim.randomEmote(), hype, chant, recent: state.templateRecent });
      logTemplate(text, viewer, kind);
      return;
    }
    // law 4: echo, not rotation — while a token is in the air, a decaying
    // fraction of lines reuse it (free, no GPU), spiking then dying.
    if (state.contagion && contagionEcho(state.contagion.age)) {
      logTemplate(state.contagion.token, viewer, 'echo');
      return;
    }
    // a copypasta viewer pastes a classic instead of reacting — no GPU call
    const pasta = answerSpeech ? null : maybePasta(kind, viewer.archetypeKey);
    if (pasta) { logTemplate(pasta, viewer, 'copypasta'); return; }
    // canned real chat: a slice of ordinary lines is a genuine human line instead
    // of model output (no GPU). Skips anything seen lately so the pool doesn't loop.
    // a speech answer must reach the model — a canned generic line would ignore
    // what the streamer just said, which is the exact thing this path exists for.
    if (!answerSpeech && CANNABLE.has(kind) && Math.random() < tune.cannedPct / 100) {
      const fresh = CANNED_POOL.filter((l) => !state.templateRecent.includes(
        l.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()));
      if (fresh.length) { logTemplate(fresh[(Math.random() * fresh.length) | 0], viewer, 'canned'); return; }
    }
    // GPU busy: drop the line rather than queue it — a queued line is stale chat
    if (state.pendingChat >= tune.maxPending) return;
    sendChatMessage({ viewer, kind, sceneChange, burstIndex, hype, bit: bits[0]?.text || '', speechFresh: answerSpeech });
  }, offsetMs);
}

// persona overrides on top of the viewer's archetype hint (chat-sim.js): called
// out viewers get defensive, returning prisoners split by how long they sat out,
// and trolls break the standing rule on purpose (§D)
const SPOT_PERSONA = {
  troll: 'the mod has your profile card open on stream and you double down on what you said',
  earnest: 'the mod has your profile card open on stream — panic about it, insist you did nothing',
  parasocial: 'the mod has your profile card open on you — plead your case to the streamer like a friend',
  'hype-man': 'the mod has your profile card open on you — treat it as the biggest moment of the stream',
  doomer: 'the mod has your profile card open on you — you expected this all along',
  default: 'the mod has your profile card open on you — react to being called out',
};

function personaFor(viewer, kind = '') {
  if (kind === 'spot')
    return SPOT_PERSONA[viewer.archetypeKey] || SPOT_PERSONA.default;
  if (viewer.justReturned) {
    viewer.justReturned = false;
    return viewer.lastBanMs >= 60e3
      ? 'back from a long timeout — hold a grudge about it, you are not sorry'
      : 'back from a short timeout — announce your return, dramatically unrepentant';
  }
  if (viewer.warned) return 'a mod just yelled at you — act innocent but keep chatting anyway';
  const note = state.culture?.note || '';
  if (note && Math.random() < tune.defiance && defies(viewer.archetypeKey, note))
    return `the chat rule lately is "no ${note}" and you break it anyway, proudly`;
  return viewer.personaHint || 'a viewer — one short reaction';
}

// exactly one prior line for a reply to quote — never the window (§B).
// Prefer a line whose author is a name the reply can address: law 2 says a
// reply names the person, and a bare reaction to an unnamed line reads as fake.
function pickRecent(excludeName) {
  const pool = state.lastChatLines.filter((l) => l.name !== excludeName);
  if (!pool.length) return null;
  const nameable = pool.filter((l) => l.name && l.name.length >= 3);
  const from = nameable.length && Math.random() < 0.8 ? nameable : pool;
  return from[(Math.random() * from.length) | 0];
}

function pickStyleExamples(n) {
  const pool = STYLE_EXAMPLES.slice();
  const out = [];
  for (let i = 0; i < n && pool.length; i++) out.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
  return out;
}

function trackRecent(name, text) {
  state.lastChatLines.push({ name, text });
  if (state.lastChatLines.length > 6) state.lastChatLines.shift();
  // law 4: a catchy token enters the air and a decaying few lines echo it.
  const seed = seedContagion(text);
  if (seed) state.contagion = { token: seed, age: 0 };
  else if (state.contagion && ++state.contagion.age > 6) state.contagion = null;
  // law 2: the room talks to itself. Most lines seed a reply to *this* person
  // within a short window, so conversation threads instead of a crowd shouting.
  if (threadSeed() && state.pendingChat < tune.maxPending) {
    scheduleNext(() => fireThreadReply(name), threadDelayMs());
  }
}

// a chatter answers the person who just spoke. If the streamer is mid-question
// the scheduler's own reply takes precedence — don't double up.
function fireThreadReply(targetName) {
  if (state.phase !== 'live' || state.userMsgTicks > 0) return;
  const viewer = sim.pickViewer(viewerWeights());
  if (!viewer || viewer.name === targetName) return;
  sendChatMessage({ viewer, kind: 'reply' });
}

/* burst frames: which single view of the stream this viewer reacts to */
function burstFrames(varied, index) {
  const cur = grabFrameBuffer(els.capture);
  if (!cur) return {};
  // varied views: even viewers get the motion crop, odd ones the wide shot
  if (varied && index % 2 === 1) {
    const w = grabFrameBuffer(els.captionCapture);
    if (w) return { image: w };
  }
  return { image: cur };
}

function sendChatMessage({ viewer, kind, sceneChange, burstIndex = 0, hype = false, bit = '', ban = null, spot = false, speechFresh = false }) {
  if (state.phase !== 'live') return;
  const replySrc = kind === 'reply' && !state.userMsgTicks ? pickRecent(viewer.name) : null;
  const context = {
    kind,
    scene: state.scene || 'the stream just started; nobody has described it yet',
    sceneHistory: state.sceneHistory,
    speech: state.speech || '',
    speechFresh,
    sceneChange,
    userMsg: state.userMsgTicks > 0 ? state.userMsg : '',
    recent: state.lastChatLines.map((l) => l.text),
    persona: personaFor(viewer, kind),
    // only an emote line is offered emotes: offering them on every line is how
    // the model ended up putting one in 48% of chat (real rooms: 3-9%)
    emotes: kind === 'emote' ? state.emoteHint : '',
    facts: factsForContext(),
    replyTo: replySrc ? { name: replySrc.name, text: replySrc.text } : null,
    bit: kind === 'callback' ? bit : '',
    ban,                              // §D: 'X was just moderated — react to that'
    culture: state.culture?.note || '',
    styleExamples: pickStyleExamples(tune.styleExamples),
  };
  const id = ++state.reqId;
  state.pendingChat += 1;
  pendingMeta.set(id, { kind, sentAt: performance.now(), context, viewer, hype, ban, spot });
  const msg = { type: 'chat', id, context, tune: workerTune() };
  // every visual line sees the current frame, not just the instant after a
  // detected change — gating on sceneChange meant most "reactions" ran text-only
  // and the chat stopped reacting to what was on screen (2026-10-28). The
  // scene-change burst still gets the varied before/after crop; the rest get the
  // live capture.
  if (kind !== 'emote') {
    Object.assign(msg, burstFrames(state.settings.varied, burstIndex));
    const transfer = [];
    if (msg.frames) msg.frames.forEach((fr) => transfer.push(fr.data.buffer));
    if (msg.image) transfer.push(msg.image.data.buffer);
    post(msg, transfer);
    return;
  }
  post(msg);
}

function hype() {
  state.hypeAt = Date.now();
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

  await wireAudioTap(mic.getAudioTracks()[0]);
}

/* wire an audio track into the RMS gate. Shared by the mic (getUserMedia) and
 * the share feed (getDisplayMedia with preferCurrentTab audio) — same worklet,
 * same PCM tap, same onPcm gate. Kept here (not in startMic) so the share path
 * reuses the exact same wiring instead of duplicating the AudioWorklet setup. */
async function wireAudioTap(audioTrack, mediaEl) {
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
  const src = mediaEl
    ? state.audioCtx.createMediaElementSource(mediaEl)
    : state.audioCtx.createMediaStreamSource(new MediaStream([audioTrack]));
  const tap = new AudioWorkletNode(state.audioCtx, 'pcm-tap');
  tap.port.onmessage = (e) => onPcm(e.data);
  src.connect(tap);
  // mic / shared-tab audio: never connected to destination (no echo — the tab
  // already plays itself). A file element is rerouted INTO the graph by
  // createMediaElementSource, so it must go to the speakers or it is silent.
  if (mediaEl) src.connect(state.audioCtx.destination);
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume().catch(() => {});
}

/* ---------------- video sources: tab/screen share + video file ---------------- */

function showVideoSource() {
  els.cam.hidden = true;
  els.demoCanvas.hidden = true;
  els.fileVideo.hidden = false;
}

function stopVideoSources() {
  if (state.shareStream) { state.shareStream.getTracks().forEach(t => t.stop()); state.shareStream = null; }
  els.fileVideo.pause();
  els.fileVideo.srcObject = null;
  els.fileVideo.removeAttribute('src');
  els.fileVideo.load();
  els.fileVideo.hidden = true;
  if (state.fileVideoUrl && state.fileVideoIsBlob) URL.revokeObjectURL(state.fileVideoUrl);
  if (state.fileVideoIsBlob) { state.fileVideoUrl = null; state.fileVideoIsBlob = false; }
}

/* getDisplayMedia: the magic path — play YouTube in a shared tab, the chat sees
 * the frames and (tab audio) hears it through the same RMS gate → ASR. */
async function startShareFeed() {
  const ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  state.shareStream = ds;
  ds.getVideoTracks()[0].addEventListener('ended', () => { if (state.phase === 'live') stop(); });
  els.fileVideo.muted = true; // the shared tab already plays its own sound
  els.fileVideo.srcObject = ds;
  showVideoSource();
  await els.fileVideo.play().catch(() => {});
  // tab audio feeds the gate when the share carries it; no audio track (screen
  // share, or the user left "share audio" off) falls back to the mic via
  // goLiveAfterLoad. Phone mode never has the mic toggle on, so it is video-only.
  const at = ds.getAudioTracks()[0];
  if (at && els.micToggle.checked) await wireAudioTap(at);
}

/* <video> file (picker / drop / ?video=): frames via the same capture path,
 * element audio tapped into the same gate (and kept audible). */
async function startFileFeed() {
  // createMediaElementSource() may bind an element only once, ever — a fresh
  // element per go-live keeps the second run from throwing InvalidStateError.
  const fresh = els.fileVideo.cloneNode(false);
  els.fileVideo.replaceWith(fresh);
  els.fileVideo = fresh;
  const v = fresh;
  v.srcObject = null;
  v.src = state.fileVideoUrl;
  v.loop = true;
  v.muted = false; // a muted element feeds silence into the audio graph
  showVideoSource();
  if (els.micToggle.checked) await wireAudioTap(null, v);
  await v.play().catch(async () => {
    // autoplay policy refused sound (no user gesture, e.g. ?autolive): the
    // frames still matter more than the audio, so fall back to muted playback.
    v.muted = true;
    await v.play().catch(() => {});
  });
}

function setFileVideo(file) {
  if (!file || !/^video\//.test(file.type || 'video/')) return;
  if (state.fileVideoUrl && state.fileVideoIsBlob) URL.revokeObjectURL(state.fileVideoUrl);
  state.fileVideoUrl = URL.createObjectURL(file);
  state.fileVideoIsBlob = true;
  els.shareToggle.checked = false;
  if (state.phase === 'live') { swapToFile(); return; }
  setStatus('', `video ready: ${file.name} — go live to play it as the stream`);
}

/* mid-stream source swap: drop the previous display source + audio tap, keep
 * the rest of the stream (loops, roster, chat) running. */
async function swapToFile() {
  if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
  if (state.demoRaf) { cancelAnimationFrame(state.demoRaf); state.demoRaf = 0; }
  if (state.audioCtx) { await state.audioCtx.close().catch(() => {}); state.audioCtx = null; }
  els.cam.srcObject = null;
  if (state.shareStream) { state.shareStream.getTracks().forEach(t => t.stop()); state.shareStream = null; }
  state.source = 'file';
  try { await startFileFeed(); setStatus('ok', 'live — playing your video'); }
  catch (err) { setStatus('err', humanizeMediaError(err)); }
}
els.fileBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => { setFileVideo(els.fileInput.files[0]); els.fileInput.value = ''; });
const dropZone = $('video-wrap');
['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => {
  e.preventDefault(); dropZone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => {
  e.preventDefault(); dropZone.classList.remove('dragging');
}));
dropZone.addEventListener('drop', (e) => setFileVideo(e.dataTransfer && e.dataTransfer.files[0]));
els.shareToggle.addEventListener('change', () => {
  if (els.shareToggle.checked) { els.demoToggle.checked = false; state.fileVideoUrl = null; }
});
els.demoToggle.addEventListener('change', () => { if (els.demoToggle.checked) els.shareToggle.checked = false; });

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
  // a spoken sentence is a reaction trigger, not just passive context — the
  // north star promises replies to spoken words within seconds, but until now a
  // transcript only sat in state.speech until some random later tick happened to
  // glance at it. Mirror the scene-change path (noteMotion): pull the pending
  // chatLoop forward so the room turns to what was just said *now*.
  if (state.chatTimer) { clearTimeout(state.chatTimer); state.chatTimer = 0; chatLoop(); }
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
// field by field, so a stale or hand-edited blob can't put a bad value in state
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
    if ([512, 640, 768].includes(s.detail)) state.settings.detail = s.detail;
    if (typeof s.focus === 'boolean') state.settings.focus = s.focus;
    if (typeof s.varied === 'boolean') state.settings.varied = s.varied;
    if (s.asr === 'tiny' || s.asr === 'base') state.settings.asr = s.asr;
  } catch { /* storage blocked — defaults */ }
}
loadSettings();

els.settingsBtn.addEventListener('click', () => {
  if (DEBUG) {
    els.feed.hidden = !els.feed.hidden;
    els.settings.hidden = true;
    if (!els.feed.hidden) renderFeed();
    return;
  }
  els.settings.hidden = !els.settings.hidden;
  if (!els.settings.hidden) renderLatency();
});
document.addEventListener('click', (e) => {
  if (e.target.closest('#settings-btn')) return;
  if (!els.settings.hidden && !els.settings.contains(e.target)) els.settings.hidden = true;
  if (!els.feed.hidden && !els.feed.contains(e.target)) els.feed.hidden = true;
});

/* ---------------- ?debug=1 — what the brains are fed ----------------
 * The complaint this answers is "is it actually looking at the video, or just
 * lights and colors?" — so the panel shows the literal prompt string the worker
 * built for each line (echoed back from the builder, never reconstructed here)
 * plus whether a real frame rode along. Local/dev only: gated on ?debug=1 AND a
 * localhost host, so a shared ?debug link on the public site stays dark. */
const DEBUG = new URLSearchParams(location.search).has('debug')
  && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const feedItems = [];
function pushFeed({ kind, out, prompt, sawFrame, brain }) {
  if (!DEBUG || !prompt) return;
  feedItems.push({ kind, out, prompt, sawFrame, brain, t: new Date().toISOString() });
  if (feedItems.length > 12) feedItems.shift();
  if (!els.feed.hidden) renderFeed();
}
function renderFeed() {
  els.feedCount.textContent = feedItems.length ? `· ${feedItems.length}` : '';
  els.feedLog.innerHTML = feedItems.map((it) => {
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const frame = it.kind === 'chat'
      ? (it.sawFrame ? '<span class="frame-yes">frame ✓</span>' : '<span class="frame-no">no frame</span>')
      : '<span class="frame-yes">whole frame</span>';
    const out = it.kind === 'chat' ? esc(it.out) : esc(it.out.slice(0, 120));
    return `<div class="feed-item"><div class="feed-tag"><span>${it.kind} · ${it.brain || '?'}</span>${frame}</div>`
      + `<div class="feed-out">${out}</div><pre class="feed-prompt">${esc(it.prompt)}</pre></div>`;
  }).join('');
}

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
loadTune();
renderTunePanel($('tune-root'));

els.setAsr.value = state.settings.asr;
els.setAsr.addEventListener('change', () => {
  state.settings.asr = els.setAsr.value;
  saveSettings();
  if (state.worker) post({ type: 'asr-model', model: state.settings.asr, preload: state.phase === 'live' });
});

/* chat memory wiring */
loadFacts();
renderFacts();
els.factAdd.addEventListener('click', (e) => {
  e.preventDefault();
  addFact(els.factInput.value);
  els.factInput.value = '';
});
els.factInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addFact(els.factInput.value); els.factInput.value = ''; }
});
// everything the app kept from this person's sessions: facts, the chat log (it
// holds transcripts of what they said), the stored viewer roster (a new crowd
// next visit — this stream keeps its viewers) and the tuning panel
els.factClear.addEventListener('click', () => {
  state.facts = [];
  saveFacts();
  renderFacts();
  forgetLog();
  try { localStorage.removeItem(ROSTER_KEY); } catch {}
  resetTune();
  renderTunePanel($('tune-root'));
});

/* ---------------- self-test hook (?autolive) ----------------
 * Dev only: auto-start on load and mirror pipeline stats into document.title
 * so an externally driven browser (fake media flags) can be polled from a shell. */

{
  // ?video=<served-path>: play a file through the whole pipeline (pair with &autolive).
  // Same-origin only: a cross-origin video taints the capture canvas, and a
  // shared link must not make this page fetch somebody else's URL.
  const vp = new URLSearchParams(location.search).get('video');
  let url = null;
  try { url = vp ? new URL(vp, location.href) : null; } catch {}
  if (url && url.origin === location.origin) {
    state.fileVideoUrl = url.pathname + url.search; state.fileVideoIsBlob = false; els.shareToggle.checked = false;
  }
}

if (new URLSearchParams(location.search).has('autolive')) {
  // the status title is for the harness; on the public site a shared
  // ?autolive link just goes live and keeps the real title
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (local) setInterval(() => {
    const L = window.__spasmtv;
    document.title =
      `SPASMTV phase=${state.phase} chat=${L.chat} cap=${L.cap} asr=${L.asr} ` +
      `lat=${fmtLatency('chat') || '-'} err=${L.err.slice(0, 40)} ` +
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
  // iPhone/iPad: even the 450M's lightest config (q4 encoder, ~675 MB) jetsams
  // iOS Safari's WebContent process at model load — uncatchable reload, and a
  // retry can wedge the tab (confirmed on a real iPhone 2026-10-28). Phones get
  // the SmolVLM-256M brain instead: ~180 MB, dumber chat, fits the ~1 GB limit.
  // Android phones get the same mode: Chrome ships WebGPU there, but a phone's
  // per-tab memory is the same story (tablets — "Android" without "Mobile" —
  // keep the computer brains). ?phone previews the mode on a desktop.
  const params = new URLSearchParams(location.search);
  const appleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const androidPhone = navigator.userAgentData?.mobile === true || /Android.+Mobile/i.test(navigator.userAgent);
  {
    // experimental brains stay out of the public picker; ?brain= adds them
    const EXPERIMENTAL = { lfm3b: 'Liquid 3B (experimental)' };
    const b = params.get('brain');
    if (b && EXPERIMENTAL[b] && ![...els.modelSelect.options].some((o) => o.value === b))
      els.modelSelect.add(new Option(EXPERIMENTAL[b], b));
    if (b && [...els.modelSelect.options].some((o) => o.value === b)) els.modelSelect.value = b;
  }
  state.phoneMode = appleMobile || androidPhone || params.has('phone');
  // §H/U8: the guard runs on phones too — the 256M brain is the one that most
  // needs `@handles`, `*`-roleplay and digit spam made unsampleable
  state.grammar = params.get('grammar') !== '0';
  if (state.phoneMode) {
    // name the brain that actually loads (the worker pins VLM.phone whenever
    // phone:true) instead of leaving "Fast chat (~800 MB)" on a dead picker
    const opt = new Option('Phone chat (256M, ~180 MB)', 'phone', true, true);
    els.modelSelect.prepend(opt);
    els.modelSelect.value = 'phone';
    els.modelSelect.disabled = true;
    els.modelSelect.title = 'phones run the 256M SmolVLM brain — the 450M/2B need a computer';
    els.micToggle.checked = false;
    els.micToggle.disabled = true;
    els.micToggle.parentElement.title = 'speech recognition doesn\u2019t fit in phone memory yet';
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no adapter');
    if (!adapter.features || !adapter.features.has('shader-f16'))
      throw new Error('shader-f16');
    setStatus('', state.phoneMode
      ? 'phone mode — small 256M brain, mic off'
      : 'ready — pick a brain and go live');
  } catch (err) {
    setStatus('err', err.message === 'shader-f16'
      ? 'this GPU lacks shader-f16 support, which the model requires.'
      : 'WebGPU present but no adapter — hardware acceleration may be off.');
    els.startBtn.disabled = true;
  }
})();
