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
  if (sample) { genOpts.temperature = 0.9; genOpts.top_p = 0.95; }

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
    'You are a viewer writing ONE Twitch chat message (max 12 words, lowercase, no quotes).',
    `The stream right now: ${ctx.scene}`,
  ];
  if (ctx.speech) parts.push(`The streamer just said: "${ctx.speech}"`);
  if (ctx.sceneChange) parts.push('Something just changed on screen — react to it.');
  if (ctx.userMsg) parts.push(`The streamer typed in chat: "${ctx.userMsg}"`);
  if (ctx.recent?.length) parts.push(`Do not repeat anything similar to: ${ctx.recent.join(' | ')}`);
  parts.push(`Your vibe: ${ctx.persona}`);
  parts.push('Reply with the chat message only.');
  return parts.join('\n');
};

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
  const raw = await generate({
    prompt: CHAT_PROMPT_PARTS(ctx),
    image,
    maxNewTokens: 30,
    sample: true,
  });
  post({ type: 'chat', id: m.id, messages: toChatLines(raw) });
}

function toChatLines(raw) {
  let t = raw.replace(/^["'`\s]+|["'`\s]+$/g, '');
  // the 450M sometimes roleplays with a "username:" prefix — strip it
  t = t.replace(/^\w[\w.-]{1,15}\s*:\s+/, '');
  t = t.replace(/^(chat message|viewer ?\d*|user ?\d*|message|chat)\s*[:\-]\s*/i, '');
  const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return lines.slice(0, 2).map((s) => (s.length > 120 ? s.slice(0, 117) + '…' : s));
}

async function onTranscribe(m) {
  await ensureAsr();
  const { text } = await asr(m.pcm);
  post({ type: 'transcribe', id: m.id, text: text || '' });
}
