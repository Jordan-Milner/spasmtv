// omni.js — LiquidAI/LFM3-Omni-2B on raw onnxruntime-web (WebGPU). Not a
// transformers.js model class (custom_code), so this file is the whole engine:
// image preprocessing, prompt layout, the KV-cache decode loop and sampling.
// Validated against a Python onnxruntime reference first (see tasks/OMNI-REPORT.md).
//
// Text + vision in, text out. The audio encoder/codec/depth graphs are not
// loaded (speech OUT is not wanted; speech IN is the next step).
//
// Per the model card, on WebGPU the decoder is q4f16 and the side graphs are
// the float32 ones of the q4 bundle (vision_encoder_q8), prefill ≤ 1024 tokens.

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.webgpu.min.mjs';
import { logMel } from './omni-audio.js';
import { AutoTokenizer } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

const REPO = 'LiquidAI/LFM3-Omni-2B-ONNX';
const BASE = `https://huggingface.co/${REPO}/resolve/main`;
const CACHE = 'omni-v1';
const EOS = new Set([124900, 125014]);
const IMAGE_TOKEN = '<|image|>';
const N_LAYERS = 24;
const CONV_LAYERS = new Set([0, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]); // conv; the rest hold KV
const CONV_LEN = 7;
const PATCH = 16, MERGE = 2, FACTOR = PATCH * MERGE;
// frames arrive at 512 px wide (CAPTURE_DEFAULT) → 512x288 → 144 image tokens
const MAX_PIXELS = 512 * 288;
const MIN_PIXELS = 65536;

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
ort.env.wasm.numThreads = 1;

let tokenizer = null;
let dec = null;
let vis = null;
let aud = null;          // audio encoder, loaded lazily on the first transcribe
let audLoading = null;
export const stats = { visMs: 0, prefillMs: 0, decodeMs: 0, steps: 0, promptTokens: 0 };

/* ---------------- download with Cache API + progress ---------------- */

async function fetchCached(path, onBytes) {
  const url = `${BASE}/${path}`;
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* private window: no cache */ }
  const hit = cache && await cache.match(url);
  const res = hit || await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${path}: HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  const reader = res.clone().body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes?.(path, got, total || got);
  }
  if (cache && !hit) { try { await cache.put(url, res); } catch { /* quota */ } }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function omniLoaded() { return !!(dec && vis && tokenizer); }
export function omniAudioLoaded() { return !!aud; }

// the float32 audio encoder (510 MB) — kept out of the first load so a session
// that never speaks never pays for it
export function loadOmniAudio(onProgress) {
  if (aud) return Promise.resolve();
  if (!audLoading) {
    audLoading = (async () => {
      const [g, d] = await Promise.all([
        fetchCached('onnx/audio_encoder.onnx', (p, got, total) => onProgress?.(got / total)),
        fetchCached('onnx/audio_encoder.onnx_data', (p, got, total) => onProgress?.(got / total)),
      ]);
      aud = await ort.InferenceSession.create(g, {
        executionProviders: ['webgpu'],
        externalData: [{ path: 'audio_encoder.onnx_data', data: d }],
        graphOptimizationLevel: 'all',
      });
    })().catch((e) => { audLoading = null; throw e; });
  }
  return audLoading;
}

export async function loadOmni(onProgress) {
  if (omniLoaded()) return;
  const sizes = {};
  const seen = {};
  const report = (p, got, total) => {
    sizes[p] = total; seen[p] = got;
    const T = Object.values(sizes).reduce((a, b) => a + b, 0);
    const G = Object.values(seen).reduce((a, b) => a + b, 0);
    onProgress?.(T ? G / T : 0);
  };
  tokenizer = await AutoTokenizer.from_pretrained(REPO);

  const [decGraph, decData, visGraph, visData] = await Promise.all([
    fetchCached('onnx/decoder_q4f16.onnx', report),
    fetchCached('onnx/decoder_q4f16.onnx_data', report),
    fetchCached('onnx/vision_encoder_q8.onnx', report),
    fetchCached('onnx/vision_encoder_q8.onnx_data', report),
  ]);

  const gpuOut = {};
  for (let i = 0; i < N_LAYERS; i++) {
    if (CONV_LAYERS.has(i)) gpuOut[`present_conv.${i}`] = 'gpu-buffer';
    else { gpuOut[`present.${i}.key`] = 'gpu-buffer'; gpuOut[`present.${i}.value`] = 'gpu-buffer'; }
  }
  dec = await ort.InferenceSession.create(decGraph, {
    executionProviders: ['webgpu'],
    externalData: [{ path: 'decoder_q4f16.onnx_data', data: decData }],
    preferredOutputLocation: gpuOut,
    graphOptimizationLevel: 'all',
  });
  vis = await ort.InferenceSession.create(visGraph, {
    executionProviders: ['webgpu'],
    externalData: [{ path: 'vision_encoder_q8.onnx_data', data: visData }],
    graphOptimizationLevel: 'all',
  });
}

/* ---------------- image preprocessing (mirrors Lfm3VlImageProcessor) ---------------- */

function smartResize(h, w) {
  let hb = Math.round(h / FACTOR) * FACTOR;
  let wb = Math.round(w / FACTOR) * FACTOR;
  if (hb * wb > MAX_PIXELS) {
    const beta = Math.sqrt((h * w) / MAX_PIXELS);
    hb = Math.max(FACTOR, Math.floor(h / beta / FACTOR) * FACTOR);
    wb = Math.max(FACTOR, Math.floor(w / beta / FACTOR) * FACTOR);
  } else if (hb * wb < MIN_PIXELS) {
    const beta = Math.sqrt(MIN_PIXELS / (h * w));
    hb = Math.ceil(h * beta / FACTOR) * FACTOR;
    wb = Math.ceil(w * beta / FACTOR) * FACTOR;
  }
  return [hb, wb];
}

// img: { data: Uint8ClampedArray RGBA, width, height }
function patchify(img) {
  const [H, W] = smartResize(img.height, img.width);
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const dst = new OffscreenCanvas(W, H);
  const dctx = dst.getContext('2d', { willReadFrequently: true });
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(src, 0, 0, W, H);
  const px = dctx.getImageData(0, 0, W, H).data;
  const gh = H / PATCH, gw = W / PATCH;
  const bh = gh / MERGE, bw = gw / MERGE;
  const out = new Float32Array(bh * bw * 4 * 1536);
  // layout [bh, bw, mh, mw, C, T(=2, duplicated), ph, pw] — see patchify() in image_processing_lfm3_vl.py
  let o = 0;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++)
    for (let my = 0; my < MERGE; my++) for (let mx = 0; mx < MERGE; mx++)
      for (let c = 0; c < 3; c++) for (let t = 0; t < 2; t++)
        for (let py = 0; py < PATCH; py++) {
          const y = (by * MERGE + my) * PATCH + py;
          for (let pxl = 0; pxl < PATCH; pxl++) {
            const x = (bx * MERGE + mx) * PATCH + pxl;
            out[o++] = (px[(y * W + x) * 4 + c] / 255 - 0.5) / 0.5;
          }
        }
  return { data: out, bh, bw, tokens: bh * bw };
}

/* ---------------- sampling ---------------- */

function sample(logits, { temperature, topP, topK, repetitionPenalty }, history) {
  const n = logits.length;
  if (repetitionPenalty && repetitionPenalty !== 1) {
    for (const id of new Set(history)) logits[id] = logits[id] > 0 ? logits[id] / repetitionPenalty : logits[id] * repetitionPenalty;
  }
  if (!temperature || temperature <= 0) {
    let best = 0;
    for (let i = 1; i < n; i++) if (logits[i] > logits[best]) best = i;
    return best;
  }
  // top-k via a size-k min-heap: one O(n) pass, no 128k-element sort per token
  const k = topK > 0 ? Math.min(topK, n) : Math.min(100, n);
  const hv = new Float32Array(k), hi = new Int32Array(k);
  let hn = 0;
  const swap = (x, y) => { const v = hv[x]; hv[x] = hv[y]; hv[y] = v; const j = hi[x]; hi[x] = hi[y]; hi[y] = j; };
  const down = (i) => { for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < hn && hv[l] < hv[m]) m = l; if (r < hn && hv[r] < hv[m]) m = r; if (m === i) break; swap(i, m); i = m; } };
  for (let i = 0; i < n; i++) {
    const v = logits[i];
    if (hn < k) { hv[hn] = v; hi[hn] = i; let c = hn++; while (c > 0) { const pnt = (c - 1) >> 1; if (hv[pnt] <= hv[c]) break; swap(pnt, c); c = pnt; } }
    else if (v > hv[0]) { hv[0] = v; hi[0] = i; down(0); }
  }
  const top = Array.from(hi.subarray(0, hn)).sort((x, y) => logits[y] - logits[x]);
  const m = logits[top[0]];
  const ps = top.map((i) => Math.exp((logits[i] - m) / temperature));
  const z = ps.reduce((a, b) => a + b, 0);
  let acc = 0, keep = 0;
  for (; keep < top.length; keep++) { acc += ps[keep] / z; if (acc >= (topP || 1)) { keep++; break; } }
  keep = Math.max(1, Math.min(keep, top.length));
  const zz = ps.slice(0, keep).reduce((a, b) => a + b, 0);
  let r = Math.random() * zz;
  for (let i = 0; i < keep; i++) { r -= ps[i]; if (r <= 0) return top[i]; }
  return top[0];
}

/* ---------------- decode ---------------- */

const f16zeros = (dims) => new ort.Tensor('float16', new Uint16Array(dims.reduce((a, b) => a * b, 1)), dims);

function initCache() {
  const c = {};
  for (let i = 0; i < N_LAYERS; i++) {
    if (CONV_LAYERS.has(i)) c[`past_conv.${i}`] = f16zeros([1, 2048, CONV_LEN]);
    else {
      c[`past_key_values.${i}.key`] = f16zeros([1, 4, 0, 128]);
      c[`past_key_values.${i}.value`] = f16zeros([1, 4, 0, 128]);
    }
  }
  return c;
}

const i64 = (arr, dims) => new ort.Tensor('int64', BigInt64Array.from(arr, BigInt), dims);

async function run({ prompt, image, audio, maxNewTokens = 24, temperature = 0, topP = 1, topK = 0, repetitionPenalty = 1 }) {
  const T0 = performance.now();
  let feats = null;
  let nTok = 0;
  let content = '';
  if (image) {
    const p = patchify(image);
    const out = await vis.run({ pixel_values: new ort.Tensor('float32', p.data, [p.bh, p.bw, 2, 2, 1536]) });
    feats = out.image_features;
    nTok = p.tokens;
    content += `<|vision_start|>${IMAGE_TOKEN.repeat(nTok)}<|vision_end|>`;
  }
  let afeats = null;
  if (audio) {
    const mel = logMel(audio);
    const out = await aud.run({ input_features: new ort.Tensor('float32', mel.data, [1, 128, mel.frames]) });
    afeats = out.audio_features;
    content += `<|vision_start|>${'<|audio|>'.repeat(mel.tokens)}<|vision_end|>`;
  }
  const text = `<|startoftext|><|im_start|>user\n${content}${prompt}<|im_end|>\n<|im_start|>assistant\n<think></think>`;
  const ids = Array.from(tokenizer.encode(text, { add_special_tokens: false }));

  stats.visMs = Math.round(performance.now() - T0); stats.promptTokens = ids.length;
  let tPre = 0;
  let cache = initCache();
  const empty = {
    video_features: new ort.Tensor('float32', new Float32Array(0), [0, 2048]),
    audio_out_codes: new ort.Tensor('int64', new BigInt64Array(0), [0, 12]),
    logits_to_keep: i64([1], [1]),
  };
  const noImg = new ort.Tensor('float32', new Float32Array(0), [0, 2048]);
  const generated = [];
  let cur = ids;
  let pos = 0;
  const CHUNK = 1024;

  for (let step = 0; step < maxNewTokens + 1; step++) {
    // prefill in ≤1024-token chunks; image features go with the chunk holding the <|image|> run
    const chunks = step === 0 ? Math.ceil(cur.length / CHUNK) : 1;
    let logits = null;
    for (let ci = 0; ci < chunks; ci++) {
      const part = step === 0 ? cur.slice(ci * CHUNK, (ci + 1) * CHUNK) : cur;
      const n = part.length;
      const first = step === 0 && ci === 0 && chunks === 1;
      const hasImg = feats && first;
      if ((feats || afeats) && step === 0 && chunks > 1) throw new Error('prompt too long for single-chunk image prefill');
      const feed = {
        input_ids: i64(part, [1, n]),
        attention_mask: i64(new Array(pos + n).fill(1), [1, pos + n]),
        position_ids: i64(Array.from({ length: n }, (_, i) => pos + i), [1, n]),
        image_features: hasImg ? feats : noImg,
        audio_features: afeats && first ? afeats : noImg,
        ...empty,
        ...cache,
      };
      const res = await dec.run(feed);
      // new cache (GPU-resident) replaces the old; dispose what we are done with
      const next = {};
      for (const k of Object.keys(res)) {
        if (k.startsWith('present_conv.')) next[`past_conv.${k.split('.')[1]}`] = res[k];
        else if (k.startsWith('present.')) { const [, i, kv] = k.split('.'); next[`past_key_values.${i}.${kv}`] = res[k]; }
      }
      for (const t of Object.values(cache)) { try { t.dispose?.(); } catch { /* cpu tensor */ } }
      cache = next;
      pos += n;
      if (ci === chunks - 1) logits = res.logits;
    }
    const data = await logits.getData();
    const row = Float32Array.from(data.subarray ? data.subarray(data.length - 128000) : data.slice(-128000));
    logits.dispose?.();
    if (step === 0) { tPre = performance.now(); stats.prefillMs = Math.round(tPre - T0 - stats.visMs); }
    const nxt = sample(row, { temperature, topP, topK, repetitionPenalty }, generated);
    if (EOS.has(nxt) || step === maxNewTokens) break;
    generated.push(nxt);
    cur = [nxt];
  }
  stats.decodeMs = Math.round(performance.now() - tPre); stats.steps = generated.length;
  for (const t of Object.values(cache)) { try { t.dispose?.(); } catch { /* cpu */ } }
  feats?.dispose?.();
  afeats?.dispose?.();
  return tokenizer.decode(generated, { skip_special_tokens: true }).replace(/\s+/g, ' ').trim();
}

// serialized entry point — mirrors llm-worker.js generate()'s contract.
// One decode at a time; when several wait, higher `priority` goes first so a
// chat line or transcript never queues behind a scene caption.
const waiting = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (waiting.length) {
    waiting.sort((a, b) => (b.opts.priority || 0) - (a.opts.priority || 0) || a.seq - b.seq);
    const job = waiting.shift();
    try { job.resolve(await run(job.opts)); } catch (e) { job.reject(e); }
  }
  busy = false;
}
let seqN = 0;
export function omniGenerate(opts) {
  return new Promise((resolve, reject) => { waiting.push({ opts, resolve, reject, seq: seqN++ }); pump(); });
}

// speech → text with the same model (no Moonshine). pcm: Float32Array, 16 kHz mono.
export async function omniTranscribe(pcm) {
  await loadOmniAudio();
  const out = await omniGenerate({
    prompt: 'What does the speaker say? Write the full transcript. If there is no speech, reply exactly NONE.',
    audio: pcm, maxNewTokens: 80, temperature: 0, priority: 1,
  });
  return /^none\b/i.test(out) ? '' : out;
}
