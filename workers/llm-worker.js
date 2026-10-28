// llm-worker.js — ALL inference lives here: the LiquidAI vision-language model
// (scene captions + chat messages) and Moonshine ASR (mic transcripts).
//
// Weights stream from the HF hub on first load and cache in the browser
// (Cache API) — this site hosts no models and runs no backend.
//
// Loading config mirrors LiquidAI's official WebGPU demo
// (huggingface.co/spaces/LiquidAI/LFM2.5-VL-450M-WebGPU):
// webgpu + { vision_encoder: fp16, embed_tokens: fp16, decoder_model_merged: q4 }.

import {
  AutoProcessor,
  AutoModelForImageTextToText,
  RawImage,
  pipeline,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

env.allowLocalModels = false;

const VLM = {
  fast: {
    id: 'LiquidAI/LFM2.5-VL-450M-ONNX',
    dtype: { vision_encoder: 'fp16', embed_tokens: 'fp16', decoder_model_merged: 'q4' },
  },
  quality: {
    id: 'onnx-community/LFM3-VL-2B-ONNX',
    dtype: { vision_encoder: 'fp16', embed_tokens: 'fp16', decoder_model_merged: 'q4f16' },
  },
};

const ASR_ID = 'onnx-community/moonshine-tiny-ONNX';

const HAS_GPU = !!self.navigator?.gpu;
const DEVICE = HAS_GPU ? 'webgpu' : 'wasm';

const post = (m) => self.postMessage(m);

let processor = null;
let model = null;
let currentKey = null;
let textOnlyOk = false;
let asr = null;
let asrPromise = null;

const filePct = new Map();
function onProg(e) {
  if (e && e.status === 'progress' && e.total > 0 && e.file) {
    filePct.set(e.file, Math.min(1, e.loaded / e.total));
    const vals = [...filePct.values()];
    post({ type: 'progress', progress: vals.reduce((a, b) => a + b, 0) / vals.length });
  }
}

/* ---------------- message protocol ---------------- */

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'load') await load(m);
    else if (m.type === 'caption') await safeReply(m, onCaption, { text: '' });
    else if (m.type === 'chat') await safeReply(m, onChat, { messages: [] });
    else if (m.type === 'transcribe') await safeReply(m, onTranscribe, { text: '' });
  } catch (err) {
    post({ type: 'error', message: humanizeError(err) });
  }
};

async function safeReply(m, fn, empty) {
  try {
    await fn(m);
  } catch (err) {
    console.error('[llm-worker] job failed:', err);
    post({ type: m.type, id: m.id, ...empty });
  }
}

function humanizeError(err) {
  const s = String(err?.message || err);
  if (/shader-f16|f16/i.test(s)) return 'this GPU lacks shader-f16 support, which the model needs.';
  if (/fetch|network|Failed to load/i.test(s)) return 'model download failed — check the connection and retry.';
  return s;
}

/* ---------------- load / warmup ---------------- */

async function load(m) {
  if (model && currentKey === m.model) { post({ type: 'ready' }); return; }
  const cfg = VLM[m.model] || VLM.fast;
  filePct.clear();
  post({ type: 'progress', progress: 0 });

  [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(cfg.id, { progress_callback: onProg }),
    AutoModelForImageTextToText.from_pretrained(cfg.id, {
      device: DEVICE,
      dtype: cfg.dtype,
      progress_callback: onProg,
    }),
  ]);
  currentKey = m.model;

  // compile GPU pipelines before the user sees the first "live" moment
  const blank = new RawImage(new Uint8ClampedArray(64 * 64 * 4).fill(110), 64, 64, 4);
  await generate({ prompt: 'hi', image: blank, maxNewTokens: 2 });

  // text-only prompts are the cheap path for chat lines; detect support once
  try {
    await generate({ prompt: 'hi', image: null, maxNewTokens: 2 });
    textOnlyOk = true;
  } catch {
    textOnlyOk = false;
  }

  if (m.asr) ensureAsr(); // loads in the background; first utterance awaits it
  post({ type: 'ready' });
}

function ensureAsr() {
  if (!asrPromise) {
    asrPromise = pipeline('automatic-speech-recognition', ASR_ID, {
      device: DEVICE,
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      progress_callback: onProg,
    }).then(async (p) => {
      await p(new Float32Array(16000)); // warmup
      asr = p;
      post({ type: 'asr-ready' });
      return p;
    });
  }
  return asrPromise;
}

/* ---------------- generation core ---------------- */

async function generate({ prompt, image, maxNewTokens, sample = false }) {
  const content = image
    ? [{ type: 'image' }, { type: 'text', text: prompt }]
    : [{ type: 'text', text: prompt }];
  const messages = [{ role: 'user', content }];
  const chatPrompt = processor.apply_chat_template(messages, {
    add_generation_prompt: true,
    enable_thinking: false,
  });
  const inputs = await processor(image, chatPrompt, { add_special_tokens: false });

  const genOpts = {
    ...inputs,
    max_new_tokens: maxNewTokens,
    repetition_penalty: 1.05,
    do_sample: sample,
  };
  if (sample) { genOpts.temperature = 0.85; genOpts.top_p = 0.95; }

  const outputs = await model.generate(genOpts);
  const gen = outputs.slice(null, [inputs.input_ids.dims.at(-1), null]);
  return processor.batch_decode(gen, { skip_special_tokens: true })[0]
    .replace(/\s+/g, ' ')
    .trim();
}

function toRawImage(img) {
  if (!img) return null;
  return new RawImage(new Uint8ClampedArray(img.data.buffer), img.width, img.height, 4);
}

/* ---------------- jobs ---------------- */

async function onCaption(m) {
  const text = await generate({
    prompt: 'Describe the scene in one short sentence.',
    image: toRawImage(m.image),
    maxNewTokens: 64,
  });
  post({ type: 'caption', id: m.id, text });
}

const CHAT_PROMPT_PARTS = (ctx) => {
  const parts = [
    'You are a viewer writing ONE Twitch chat message (max 12 words, lowercase, no quotes, no hashtags).',
    `The stream right now: ${ctx.scene}`,
  ];
  if (ctx.speech) parts.push(`The streamer just said: "${ctx.speech}"`);
  if (ctx.sceneChange) parts.push('Something just changed on screen — react to it.');
  if (ctx.userMsg) parts.push(`The streamer typed in chat: "${ctx.userMsg}"`);
  if (ctx.emotes) parts.push(`You may use one emote from: ${ctx.emotes}`);
  parts.push(`Your vibe: ${ctx.persona}`);
  parts.push('Write only the message itself — never restate the style hint, never use hashtags.');
  return parts.join('\n');
};

// NOTE: recent chat lines are deliberately NOT pasted into the prompt — echoing
// them back anchors a degeneration loop on small models ("A. hair? cringe me!"
// ×20). Dedupe happens post-generation instead, against this worker-side ring
// unioned with the recent lines the client saw.
let workerRecent = [];

const normTokens = (s) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

function tooSimilar(line, priors, thresh = 0.75) {
  const a = new Set(normTokens(line));
  if (!a.size) return true;
  for (const prior of priors) {
    const b = new Set(normTokens(prior));
    if (!b.size) continue;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    if (inter / new Set([...a, ...b]).size >= thresh) return true;
  }
  return false;
}

function loopDetected(priors) {
  const tail = priors.slice(-4);
  if (tail.length < 3) return false;
  let dupes = 0;
  for (let i = 1; i < tail.length; i++)
    if (tooSimilar(tail[i], [tail[0]], 0.7)) dupes += 1;
  return dupes >= 2;
}

let blankImg = null;
function blankImage() {
  if (!blankImg) blankImg = new RawImage(new Uint8ClampedArray(64 * 64 * 4).fill(110), 64, 64, 4);
  return blankImg;
}

async function onChat(m) {
  const ctx = m.context || {};
  // scene-change bursts see the actual frame; regular lines run text-only for speed
  let image = null;
  if (ctx.sceneChange && m.image) image = toRawImage(m.image);
  else if (!textOnlyOk) image = blankImage();

  const priors = [...(ctx.recent || []), ...workerRecent];
  const looped = loopDetected(priors);
  let raw = await generate({
    prompt: CHAT_PROMPT_PARTS(ctx),
    image,
    maxNewTokens: 30,
    sample: true,
    temperature: looped ? 1.2 : 0.85,
    repetitionPenalty: looped ? 1.25 : 1.15,
  });
  let lines = toChatLines(raw)
    .filter((s) => !tooSimilar(s, priors))
    .filter((s) => !(ctx.persona && tooSimilar(s, [ctx.persona], 0.6)));
  if (!lines.length) {
    // everything collided — one hotter retry for fresh material
    raw = await generate({
      prompt: CHAT_PROMPT_PARTS(ctx),
      image: null,
      maxNewTokens: 30,
      sample: true,
      temperature: 1.25,
      repetitionPenalty: 1.3,
    });
    lines = toChatLines(raw).filter((s) => !tooSimilar(s, priors));
  }
  workerRecent = [...workerRecent, ...lines].slice(-8);
  post({ type: 'chat', id: m.id, messages: lines });
}

function toChatLines(raw) {
  let t = raw.replace(/^["'`\s]+|["'`\s]+$/g, '');
  // roleplay leakage: "username:", "@name:", "twitch chat:", "Viewer 2:" prefixes
  t = t.replace(/^@?[\w .-]{2,24}\s*:\s+/, '');
  t = t.replace(/^(?:twitch\s+)?(?:chat message|viewer ?\d*|user ?\d*|message|chat)\s*[:\-]\s*/i, '');
  // hashtag debris the 450M picks up from its Twitch priors
  t = t.replace(/#[\w-]+/g, '').replace(/\s{2,}/g, ' ').trim();
  const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return lines.slice(0, 2).map((s) => (s.length > 120 ? s.slice(0, 117) + '…' : s));
}

async function onTranscribe(m) {
  await ensureAsr();
  const { text } = await asr(m.pcm);
  post({ type: 'transcribe', id: m.id, text: text || '' });
}
