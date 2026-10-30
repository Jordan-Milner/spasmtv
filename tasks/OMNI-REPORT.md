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

## Audio-in (done) — Omni hears the video, Moonshine is not loaded for this brain
- `workers/omni-audio.js`: JS port of the Lfm3OmniFeatureExtractor log-mel (Hann 400/hop 160, slaney 128 mel,
  log10 floor -12, (x+4)/4). `tools/test-omni-audio.mjs`: max |diff| 3.4e-5 vs the Python reference.
- `omni.js`: `loadOmniAudio()` (lazy, the 510 MB float32 `audio_encoder`, loaded in the background after the brain
  is ready) and `omniTranscribe(pcm)`. Prompt matters: "Transcribe the audio." stopped after 5 words;
  "What does the speaker say? Write the full transcript. If there is no speech, reply exactly NONE." gives the
  full sentence, and silence returns "" (verified in-browser: 7 s of speech → 0.8 s).
- `llm-worker.js`: `onTranscribe` routes to Omni when the brain is omni; the existing RMS gate / worklet / file
  audio tap are unchanged. End-to-end: a mp4 with speech → `asr=4` transcripts in the log, text exact.
- Tools: `tools/omni-test.html` + `tools/omni-test.mjs` (load/text/transcribe/silence), `browser-run.mjs --mic`.
- Total download with hearing ≈ 2.1 GB (1.6 GB brain + 0.5 GB audio encoder), vs Qwen 1.4 GB + Moonshine 0.2 GB.

## Not done
- Latency: each call re-prefills ~250 tokens; prefix-caching the static instruction and the image would cut it.
- Phone: too big **for the browser**, fine on a phone natively — checked the same day against
  https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF (`Q4_0` 1.05 GB + `mmproj-Q8_0` 0.54 GB ≈ 1.6 GB,
  same as the ONNX q4f16 bundle). Native llama.cpp survives that because `use_mmap` makes the weights
  file-backed pages, which jetsam/LMK treats leniently (https://docs.liquid.ai/deployment/on-device/llama-cpp/mobile);
  ORT-web has no equivalent — WebGPU buffers are plain tab RSS, and `main.js` already jetsams at ~675 MB.
  q1/q2 encoders close a third of that gap at best, so no browser variant of this brain is reachable.
  The route that works is the phone streaming frames/audio to a box running
  `llama-server -hf LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M` (omni is upstream in llama.cpp, incl. streaming
  audio in: ggml-org/llama.cpp#31269). Phone mode still ships the 256M brain.
- `audio_encoder_fp16` (255 MB vs the 510 MB `audio_encoder` we load) would halve the hearing cost, but the
  ONNX card says the opposite for this backend: "On WebGPU, pair `decoder_q4f16` with the float32 side graphs
  of the q4 bundle". Worth one measured try against `/tmp/omni/ref.py` before trusting it.
- License: `lfm1.0` ("other") — read before shipping anything publicly.
