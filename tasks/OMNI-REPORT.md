# Omni spike — LFM3-Omni-2B on raw onnxruntime-web (2026-10-28)

**Result: works.** `?brain=omni` (or the "Liquid Omni 2B (experimental)" dropdown entry) runs the official
`LiquidAI/LFM3-Omni-2B-ONNX` in the browser: decoder_q4f16 + vision_encoder_q8, ~1.6 GB, WebGPU, no backend.

## What was built
- `workers/omni.js` — the whole engine: Cache-API download with progress, ORT-web sessions (external data),
  image preprocessing ported from `image_processing_lfm3_vl.py` (smart-resize to 32 multiples, 0.5/0.5 norm,
  [bh,bw,2,2,1536] block layout with the duplicated temporal patch), hand-built prompt
  (`<|vision_start|><|image|>×N<|vision_end|>` + `<think></think>`), a 24-layer conv/KV cache kept GPU-resident,
  prefill chunking ≤1024, and temperature/top-k/top-p/repetition-penalty sampling in JS.
- `workers/llm-worker.js`: `omni` brain entry; `generate()` routes to `omniGenerate` (text-only calls need no
  blank-image stand-in).
- Validated first against a Python onnxruntime reference (/tmp/omni/ref.py, not committed): correct frame
  description on the first run, which pinned down preprocessing + prompt before touching WebGPU.

## A/B (same VOD, 1.5 min, tuned defaults)
| brain | s/line | grounded in the video? | notes |
|---|---|---|---|
| fast 450M | ~0.3 | rarely | vacuous lines |
| quality LFM3-VL-2B | 0.28 | some | generic |
| Liquid 3B | 1.45 | some | slow, no better |
| Qwen3-VL-2B | 0.48 | yes | "keep drawing that hat" |
| **Omni 2B** | **1.07** | **yes** | most Twitch-like: "THAT IS INSANE!", "lol mario on screen", "PEAK! MARIO IS LIVE" |

## Not done
- Audio-in (replace Moonshine): needs the 255 MB audio encoder + 128-bin log-mel JS front end + a transcribe prompt.
- Latency: each call re-prefills ~250 tokens; prefix-caching the static instruction and the image would cut it.
- Phone: far too big; phone mode still forces the 256M brain.
- License: `lfm1.0` ("other") — read before shipping anything publicly.
