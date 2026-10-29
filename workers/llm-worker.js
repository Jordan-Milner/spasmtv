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
  AutoTokenizer,
  AutoModelForImageTextToText,
  RawImage,
  pipeline,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

// same yardstick the scorer uses (tools/score-chat.mjs imports this file too)
import {
  normTokens, tooSimilar, echoesScene, reactionSeed, factCandidate,
  unsafeLine, personaLeak, junkLine, echoesSpeech, tagEcho,
} from '../js/text.js';

// workers/omni.js pulls onnxruntime-web and its own tokenizer — fetched only
// when the experimental ?brain=omni is picked, never for everyone else
let omni = null;
const omniModule = async () => (omni ??= await import('./omni.js'));

env.allowLocalModels = false;

const VLM = {
  fast: {
    id: 'LiquidAI/LFM2.5-VL-450M-ONNX',
    dtype: { vision_encoder: 'fp16', embed_tokens: 'fp16', decoder_model_merged: 'q4' },
    multiFrame: false, // 450M ONNX graph is single-image (multi-frame throws shape errors)
  },
  quality: {
    id: 'onnx-community/LFM3-VL-2B-ONNX',
    dtype: { vision_encoder: 'fp16', embed_tokens: 'fp16', decoder_model_merged: 'q4f16' },
    multiFrame: true, // LFM3-VL is video-native (2fps)
  },
  // LFM3-Omni-2B on raw onnxruntime-web (workers/omni.js): its own engine, not transformers.js
  omni: { omni: true },
  // A/B candidates (select via the brain dropdown or ?brain=lfm3b|qwen)
  lfm3b: {
    id: 'LiquidAI/LFM2.5-VL-3B-ONNX',
    dtype: { vision_encoder: 'fp16', embed_tokens: 'fp16', decoder_model_merged: 'q4' },
    multiFrame: false,
  },
  qwen: {
    id: 'onnx-community/Qwen3-VL-2B-Instruct-ONNX',
    dtype: { vision_encoder: 'fp16', embed_tokens: 'fp16', decoder_model_merged: 'q4f16' },
    multiFrame: false,
    textFirst: true, // Qwen-VL processors take (text, images)
  },
  // phone brain: even the 450M's lightest config (q4 encoder, ~675 MB) jetsams
  // iOS Safari at load — its 481 MB q4 decoder alone is held twice in RAM during
  // the GPU upload. SmolVLM-256M q4/q8 is ~180 MB of weights (peak ~400 MB) and
  // generates visibly dumber chat, but it fits under the ~1 GB per-tab limit.
  phone: {
    id: 'HuggingFaceTB/SmolVLM-256M-Instruct',
    dtype: { vision_encoder: 'q4', embed_tokens: 'q8', decoder_model_merged: 'q4' },
    multiFrame: false,
    // Idefics3-family processors take (text, images); the LFM family takes
    // (images, text). Swapped args route the prompt string into the image
    // pipeline ("undefined is not iterable" on String.size).
    textFirst: true,
  },
};

const ASR_MODELS = {
  tiny: 'onnx-community/moonshine-tiny-ONNX',
  base: 'onnx-community/moonshine-base-ONNX', // noticeably better hearing, still fast
};
let asrModelKey = 'base';

const HAS_GPU = !!self.navigator?.gpu;
const DEVICE = HAS_GPU ? 'webgpu' : 'wasm';

const post = (m) => self.postMessage(m);

let processor = null;
let model = null;
let currentKey = null;
let inflight = 0; // generate() calls still running — a brain switch waits for them
// §H/U8 grammar guard — chat generation constrained to a chat-safe charset by
// regex, so emoji faces / hashtags / template debris never get sampled (they
// used to die in toChatLines + keep(), each death costing a retry GPU call).
// Caption and ASR fact prompts stay unconstrained. docs/RESEARCH-CHAT-WEBGPU.md §4.
let tokenizer = null;
let grammarOn = false;
let grammarBroken = false; // one throw = guard off for the session: a broken guard must never kill chat
let GrammarCtor = null;
const CHAT_REGEX = "[A-Za-z0-9 ,.!?']{1,90}"; // caps allowed (emote codes are uppercase text), no newline: one line per call

const SO_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers-structured-output@4.3.2/+esm';
const TF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2'; // must match the static import above

async function grammarModule() {
  if (!GrammarCtor) {
    // the bare package URL ships CJS (no ESM named export) and jsdelivr's +esm
    // bundle imports transformers.js by a *different* URL — patched to the one
    // this worker already loaded, so the guard shares our transformers.js copy.
    const src = await (await fetch(SO_URL)).text();
    const patched = src.replace('/npm/@huggingface/transformers@4.3.2/+esm', TF_URL);
    const mod = await import(URL.createObjectURL(new Blob([patched], { type: 'text/javascript' })));
    if (!mod.StructuredOutputProcessor) throw new Error('no StructuredOutputProcessor export');
    GrammarCtor = mod.StructuredOutputProcessor;
  }
  return GrammarCtor;
}
let textFirst = false; // processor arg order for the loaded family (VLM.phone)
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
  else if (m.type === 'asr-model') {
    if (ASR_MODELS[m.model] && m.model !== asrModelKey) {
      asrModelKey = m.model;
      asr = null;
      asrPromise = null; // next utterance builds the new pipeline
      if (m.preload && currentKey !== 'omni') ensureAsr();
    }
  } else if (m.type === 'caption') await safeReply(m, onCaption, { text: '' });
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
    post({
      type: m.type, id: m.id, ...empty,
      jerr: String(err?.stack || err?.message || err).slice(0, 500),
    });
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
  // phone mode pins the SmolVLM-256M brain (see VLM.phone) — the 450M jetsammed
  // real iPhones even with the q4 encoder, so it is desktop-only now.
  const key = m.phone ? 'phone' : (VLM[m.model] ? m.model : 'fast');
  const cfg = VLM[key];
  const loadKey = key;
  // main.js decides whether the guard is on (on by default, off with ?grammar=0)
  const wanted = !!m.grammar && !grammarBroken;
  if ((model || omni?.omniLoaded()) && currentKey === loadKey) {
    grammarOn = wanted && !!tokenizer && !cfg.omni;
    post({ type: 'ready' });
    return;
  }
  await unloadBrain();
  filePct.clear();
  post({ type: 'progress', progress: 0 });

  if (cfg.omni) {
    grammarOn = false; // the regex guard is a transformers.js logits processor; omni has its own sampler
    await (await omniModule()).loadOmni((p) => post({ type: 'progress', progress: p }));
    currentKey = loadKey;
    await generate({ prompt: 'hi', maxNewTokens: 2 });
    // hearing is the same model: its audio encoder loads in the background, Moonshine never does
    if (m.asr) omni.loadOmniAudio().then(() => post({ type: 'asr-ready' })).catch((e) => console.error('[omni audio]', e));
    post({ type: 'ready', asr: 'omni' });
    return;
  }

  [processor, model, tokenizer] = await Promise.all([
    AutoProcessor.from_pretrained(cfg.id, { progress_callback: onProg }),
    AutoModelForImageTextToText.from_pretrained(cfg.id, {
      device: DEVICE,
      dtype: cfg.dtype,
      progress_callback: onProg,
    }),
    wanted ? AutoTokenizer.from_pretrained(cfg.id, { progress_callback: onProg }) : null,
  ]);
  grammarOn = wanted && !!tokenizer;
  if (grammarOn) {
    // a CDN or API failure here downgrades to unguarded chat, never to no chat
    try { await grammarModule(); }
    catch (err) {
      grammarOn = false; grammarBroken = true;
      console.warn('grammar guard off:', err?.message || err);
      post({ type: 'grammar-off', error: String(err?.message || err) });
    }
  }
  currentKey = loadKey;
  textFirst = !!cfg.textFirst;

  // compile GPU pipelines before the user sees the first "live" moment
  const blank = new RawImage(new Uint8ClampedArray(64 * 64 * 4).fill(110), 64, 64, 4);
  await generate({ prompt: 'hi', image: blank, maxNewTokens: 2 });

  if (m.asr) ensureAsr(); // loads in the background; first utterance awaits it
  post({ type: 'ready', asr: asrModelKey, grammar: grammarOn });
}

// a brain switch hands the old brain's GPU memory back before the next one
// loads — without this the old weights stay resident beside the new ones until
// the tab closes. In-flight calls (a late caption or chat line from the stream
// that just stopped) finish first; disposing under a running session is unsafe.
async function unloadBrain() {
  if (omni?.omniLoaded()) await omni.unloadOmni();
  while (inflight > 0) await new Promise((r) => setTimeout(r, 25));
  const old = model;
  model = null; processor = null; tokenizer = null; currentKey = null;
  if (old) {
    try { await old.dispose(); } catch (err) { console.warn('[llm-worker] dispose failed:', err); }
  }
}

function ensureAsr() {
  if (!asrPromise) {
    asrPromise = pipeline('automatic-speech-recognition', ASR_MODELS[asrModelKey], {
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

async function generate(opts) {
  inflight += 1;
  try { return await generateOnce(opts); } finally { inflight -= 1; }
}

async function generateOnce({
  prompt, frames, image, maxNewTokens, sample = false, priority = 0, grammar = false,
  temperature = 0.85, repetitionPenalty = 1.05, topP = 0.95, topK = 0,
}) {
  if (currentKey === 'omni') {
    // omni takes real text-only calls — no blank-image stand-in needed
    const f = frames?.length ? frames[frames.length - 1] : image;
    return omni.omniGenerate({
      priority, prompt, image: f ? { data: f.data, width: f.width, height: f.height } : null,
      maxNewTokens, temperature: sample ? temperature : 0, topP, topK, repetitionPenalty,
    });
  }
  // ONE image per call — this processor family treats arrays as batch, not
  // multi-image content, and it has no null-image mode: every call gets a real
  // frame or a blank stand-in (with its matching <image> template slot).
  const img = frames?.length
    ? toRawImage(frames[frames.length - 1])
    : (toRawImage(image) ?? blankImage());
  const content = [{ type: 'image' }, { type: 'text', text: prompt }];
  const messages = [{ role: 'user', content }];
  const chatPrompt = processor.apply_chat_template(messages, {
    add_generation_prompt: true,
    enable_thinking: false,
  });
  // arg order is family-specific (see VLM.phone.textFirst); do_image_splitting
  // is SmolVLM's 5-way quadrant split — off (the LFM processors ignore it)
  const inputs = textFirst
    ? await processor(chatPrompt, img, { do_image_splitting: false })
    : await processor(img, chatPrompt, { add_special_tokens: false, do_image_splitting: false });

  const genOpts = {
    ...inputs,
    max_new_tokens: maxNewTokens,
    repetition_penalty: repetitionPenalty,
    do_sample: sample,
  };
  if (sample) {
    genOpts.temperature = temperature; genOpts.top_p = topP;
    if (topK > 0) genOpts.top_k = topK;
  }
  if (grammar && grammarOn && !grammarBroken) {
    try {
      // one processor per call: the engine carries mutable state per generation,
      // and chat generates exactly one sequence per call
      genOpts.logits_processor = new (await grammarModule())(tokenizer, { type: 'regex', regex: CHAT_REGEX });
    } catch (err) {
      grammarBroken = true;
      delete genOpts.logits_processor;
      console.warn('grammar guard off:', err?.message || err);
      post({ type: 'grammar-off', error: String(err?.message || err) });
    }
  }

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
    maxNewTokens: currentKey === 'omni' ? 40 : 64, // omni calls queue behind each other — shorter captions free the GPU for chat
  });
  post({ type: 'caption', id: m.id, text });
}

/* ---- prompt v3: reaction-first, anti-echo --------------------------------
 * v2 anchored the prompt on the whole caption ("The stream right now: <scene>")
 * and the 450M answered it with its describe-the-image prior: >60% of the lines
 * in the v1.1 sample log (2026-10-27) are near-copies of the caption. v3
 * hands the scene as a 3-word seed, says react-never-describe, and rejects
 * echoes after generation (echoesScene). Kinds come from main.js's scheduler;
 * a kind we don't know is treated as a plain reaction.
 */
const KIND_PROMPT = {
  reaction: 'Say what you think about what is happening right now.',
  reply:    'Answer what that other chatter just said, not the stream.',
  banter:   'Talk to the other people in chat, not to the stream.',
  question: 'Ask one short question, ending with a question mark.',
  backseat: 'Tell the streamer what to do next, unprompted.',
  meta:     'Chatter about the stream itself — the lag, the title, the viewer count, how it is going.',
  greeting: 'You just arrived in the stream. Say hi in a few words.',
  callback: 'Call back to the running joke quoted below, the way a regular would, with no explanation.',
  banreact: 'A viewer was just moderated by the mods. React to that.',
  spot:     'The mods have YOUR profile card open on stream — you are the one being looked at. React to that.',
};

// kinds the viewer is looking at; the rest (meta, greeting, banter, banreact)
// get no scene at all — and no image, so the worker uses the blank stand-in
// (this processor family has no null-image mode)
const VISUAL_KINDS = new Set(['reaction', 'question', 'backseat', 'reply', 'callback']);

const clip = (s, n) => String(s).slice(0, n);

const CHAT_PROMPT_PARTS = (kind, ctx, T = {}) => {
  /* v4, measured: the fast run made 122 generate() calls to keep 48 lines — 44
   * first passes died in keep() below, and what died was almost always the
   * prompt's own vocabulary coming back ("on screen just changed", "max 12 words
   * hey", "No emotes allowed", "HYPEMAN", "Reaction like a troll says nothing.").
   * An instruction-tuned model copies the words nearest the output and does not
   * hear negations — "never mention colors" hands it the word colors. So the data
   * lines are bracketed tags (an echo of one is unmissable: "[" is never chat),
   * the rules are positive, the length is a range the real corpus actually has
   * (median 3 words, p90 6), and the last line is a completion cue instead of a
   * warning. keep() still catches an echo — it is the net, not the fix. */
  const parts = [
    'You are one viewer in a Twitch chat. Write one chat line of 2 to 6 words, lowercase, plain words.',
  ];
  if (VISUAL_KINDS.has(kind) && ctx.scene) parts.push(`[see ${reactionSeed(ctx.scene, T.seedWords || 3)}]`);
  if (ctx.sceneChange && VISUAL_KINDS.has(kind)) parts.push('[new]');
  parts.push('You have been here for hours. React.');
  parts.push(KIND_PROMPT[kind]);
  // exactly ONE quoted line, never the recent window — pasting the window back
  // is the v1.1 echo loop that killed the last build
  if (ctx.replyTo?.text) parts.push(`[reply to ${clip(ctx.replyTo.name || 'someone', 24)}: "${clip(ctx.replyTo.text, 90)}"]`);
  if (ctx.ban?.name) parts.push(`${clip(ctx.ban.name, 24)} was just moderated${ctx.ban.last ? ` — their last message was "${clip(ctx.ban.last, 90)}"` : ''}.`);
  if (ctx.bit) parts.push(`Chat has been repeating: "${clip(ctx.bit, 60)}"`);
  if (ctx.culture) parts.push(`Chat rule lately (mods ban for it): ${clip(ctx.culture, 90)} — most viewers avoid it.`);
  if (ctx.speech) parts.push(`The streamer just said: "${ctx.speech}"`);
  if (ctx.userMsg) parts.push(`The streamer typed in chat: "${ctx.userMsg}"`);
  if (ctx.facts) parts.push(`Things chat knows about the streamer: ${ctx.facts} — use naturally, never list.`);
  if (ctx.emotes) parts.push(`[emote ok: ${ctx.emotes}]`);
  if (ctx.persona) parts.push(`[vibe ${ctx.persona}]`);
  if (T.extraDirection) parts.push(`Also: ${clip(T.extraDirection, 160)}`);
  if (ctx.styleExamples?.length) parts.push(`Real chat lines look like this (style only — never copy): ${ctx.styleExamples.map((x) => `"${x}"`).join(' / ')}`);
  parts.push('Chat line:');
  return parts.join('\n');
};

// NOTE: recent chat lines are deliberately NOT pasted into the prompt — echoing
// them back anchors a degeneration loop on small models ("A. hair? cringe me!"
// ×20). Dedupe happens post-generation instead, against this worker-side ring
// unioned with the recent lines the client saw.
// soft steer, no identity assumptions: small models over-commit to gendered
// labels about whoever is on camera — damp strong gendered references either
// way so the chat leans on what's actually happening instead
const GENDERED_RE = /\b(she|her|hers|woman|lady|gal|girl|he|him|his|man|dude|guy|bro|king)\b/i;

function softGenderDamp(line, p = 0.5) {
  return GENDERED_RE.test(line) && Math.random() < p;
}

let workerRecent = [];
let chatCalls = 0; // generate() calls made for chat this session (U8 metric)
let chatDrops = 0; // first passes that keep() killed (retry cost)

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
  const kind = KIND_PROMPT[ctx.kind] ? ctx.kind : 'reaction';
  const T = m.tune || {};
  const prompt = CHAT_PROMPT_PARTS(kind, ctx, T);
  const priors = [...(ctx.recent || []), ...workerRecent];
  const looped = loopDetected(priors);
  // quoted source lines must not come back as the reply — that is an echo loop
  const quoted = [ctx.replyTo?.text, ctx.ban?.last, ctx.bit].filter(Boolean);
  // a viewer talking about the mods or about chat itself is not looking at the
  // frame — no image in the call at all (blank stand-in inside generate())
  const seeing = VISUAL_KINDS.has(kind) && ctx.sceneChange;
  const gen = (hot) => generate({
    priority: 1,
    prompt,
    frames: seeing && !hot ? m.frames : null,
    image: seeing && !hot ? m.image : null,
    maxNewTokens: T.maxNewTokens ?? 20,
    sample: true,
    grammar: true,
    temperature: hot ? (T.temperature ?? 0.85) + 0.4 : looped ? (T.temperature ?? 0.85) + 0.35 : (T.temperature ?? 0.85),
    topP: T.topP ?? 0.95,
    topK: T.topK ?? 0,
    repetitionPenalty: hot ? (T.repPenalty ?? 1.15) + 0.15 : looped ? (T.repPenalty ?? 1.15) + 0.1 : (T.repPenalty ?? 1.15),
  });
  const keep = (lines) => lines
    .filter((s) => !tooSimilar(s, priors, T.priorSim ?? 0.75))
    .filter((s) => !(ctx.styleExamples?.length && tooSimilar(s, ctx.styleExamples, 0.8)))
    .filter((s) => !(ctx.scene && echoesScene(s, ctx.scene, T.echoScene ?? 0.5)))
    .filter((s) => !(ctx.persona && tooSimilar(s, [ctx.persona], 0.6)))
    .filter((s) => !(quoted.length && tooSimilar(s, quoted, 0.6)))
    .filter((s) => !(T.keysmash !== false && keysmash(s)))
    .filter((s) => !META_NEG.test(s))
    // js/text.js: a real person is on camera and the page is public — slurs,
    // sexual or body talk, self-harm; the archetype brief coming back as chat;
    // invented @handles and digit/symbol junk; the streamer's words repeated back
    .filter((s) => !unsafeLine(s))
    .filter((s) => !personaLeak(s))
    .filter((s) => !tagEcho(s))
    .filter((s) => !junkLine(s, [ctx.replyTo?.name, ctx.ban?.name]))
    .filter((s) => ![ctx.speech, ctx.userMsg].some((said) => said && echoesSpeech(s, said)))
    .filter((s) => !softGenderDamp(s, (T.genderDamp ?? 50) / 100));

  let lines = keep(toChatLines(await gen(false), T.maxWords || 14, true));
  chatCalls += 1;
  if (!lines.length) { chatCalls += 1; chatDrops += 1; lines = keep(toChatLines(await gen(true), T.maxWords || 14, true)); }
  workerRecent = [...workerRecent, ...lines].slice(-8);
  // cumulative GPU calls / first-pass deaths — the U8 guard is measured by
  // driving calls-per-kept-line toward 1
  post({ type: 'chat', id: m.id, messages: lines, kind, calls: chatCalls, drops: chatDrops });
}

// the 450M sometimes degrades into keysmash ("EZERLAFUNKEBOHMTHAZAKABOBT…").
// Shape check, no dictionary: two 4+ letter tokens with no vowel at all, or one
// token no human word reaches — real chat is short vowel-rich words.
function keysmash(s) {
  const tokens = s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
  return tokens.filter((w) => !/[aeiouy]/.test(w)).length >= 2
    || tokens.some((w) => w.length > 18);
}

// the 450M answers "react to that" with meta about reacting: "no reaction",
// "no response", "no viewership humming by screensucking". Real chat says
// "no shot" / "no way" — those survive.
const META_NEG = /^\s*no\s+(response|reaction|answer|reply|replay|description|real|words?|emotes?|questions?|viewership|chat)\b|\b(screenshot|screenshots|the image|this image|the picture|this picture|pixelated|reacting|reaction to)\b|…/i;

// strict: a line over maxWords is DROPPED (real chat is short; a rambling line
// trimmed to "…" reads as a broken sentence). The retry pass trims instead.
function toChatLines(raw, maxWords = 14, strict = false) {
  let t = raw.replace(/^["'`\s]+|["'`\s]+$/g, '');
  // roleplay leakage: "username:", "@name:", "twitch chat:", "Viewer 2:" prefixes
  t = t.replace(/^@?[\w .-]{2,24}\s*:\s+/, '');
  t = t.replace(/^(?:twitch\s+)?(?:chat message|chat line|viewer ?\d*|user ?\d*|message|chat)\s*[:\-]\s*/i, '');
  // hashtag debris the 450M picks up from its Twitch priors
  t = t.replace(/#[\w-]+/g, '');
  // template debris: "<th_script>", "[stream_name]"
  t = t.replace(/[<\[][^>\]\n]{0,24}[>\]]/g, '');
  // emoji faces: the prompt says no emoji faces and the model ignores it
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/gu, '');
  t = t.replace(/\s{2,}/g, ' ').trim();
  const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return lines.slice(0, 2).filter((s) => !(strict && s.split(/\s+/).length > maxWords + 2)).map((s) => {
    const w = s.split(/\s+/);
    // the 450M rambles past a chat line; a trimmed line beats an essay
    if (w.length > maxWords) s = w.slice(0, maxWords).join(' ').replace(/[,;:.-]+$/, '') + '…';
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  });
}

async function onTranscribe(m) {
  let text;
  if (currentKey === 'omni') text = await omni.omniTranscribe(m.pcm);
  else { await ensureAsr(); ({ text } = await asr(m.pcm)); }
  let fact = null;
  const clean = (text || '').trim();
  // "not everything the streamer says is a memory": the pure gate in text.js
  // rejects filler/commands/stream-talk BEFORE any model call (the 450M almost
  // never answers NO on its own), and the shape check after rejects anything
  // not cleanly third-person. A junk fact poisons every chat prompt, so the
  // whole path is biased to reject.
  if (clean.length > 10 && factCandidate(clean)) {
    try {
      const raw = await generate({
        prompt:
          `The streamer said: "${clean}"\n` +
          'A durable fact about them means: their name, home town, job, age, family, ' +
          'pets, likes, dislikes, possessions, or a long-term habit. Reply ONLY with ' +
          'that fact in third person, max 12 words. Everything else — a mood, a plan ' +
          'for today, a command, a joke, anything about the stream or chat — reply ' +
          'exactly NO.',
        image: null,
        maxNewTokens: 36,
      });
      const t = raw.trim();
      const thirdPerson = !/\b(i|me|my|we|us|our|you|your)\b/i.test(t);
      if (t && thirdPerson && !/^no\b/i.test(t) && !t.includes('?')
          && t.split(/\s+/).length <= 16 && !unsafeLine(t)) fact = t;
    } catch { /* classifier is best-effort; transcript still goes through */ }
  }
  post({ type: 'transcribe', id: m.id, text: text || '', fact });
}
