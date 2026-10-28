# U7 — §H third quality brain: Qwen3-VL-2B A/B (workers/llm-worker.js + js/main.js)

Goal: add `onnx-community/Qwen3-VL-2B-Instruct-ONNX` as a selectable third
brain next to fast (LFM2.5-VL-450M) and quality (LFM3-VL-2B), then A/B
Qwen3-VL-2B vs LFM3-VL-2B through the same video + scorer and report the
table. Research context: docs/RESEARCH-CHAT-WEBGPU.md §2.

Read first: PLAN-CHAT-V2.md §H, docs/RESEARCH-CHAT-WEBGPU.md,
workers/llm-worker.js (the `VLM` map, `load(m)` incl. the phone override,
`generate()`), js/main.js (find where the settings popover picks the brain
and sends the `load` message with its model key), tools/browser-run.mjs
(how headless dumps are produced), tools/score-chat.mjs if present.

Constraints (invariants): zero backend, nothing leaves the browser, weights
from HF CDN only. The fast brain, phone mode, and ASR path must be
untouched. No new deps beyond the existing CDN-import pattern.

## Work items

1. **Third VLM entry** (llm-worker.js `VLM` map), key `qwen`:
   `{ id: 'onnx-community/Qwen3-VL-2B-Instruct-ONNX',
      dtype: { vision_encoder: 'fp16', embed_tokens: 'fp16', decoder_model_merged: 'q4f16' },
      multiFrame: true }`
   (q4f16 total ≈ 1.38 GB. Our path is single-image either way — same as the
   LFM3 entry. If fp16 vision_encoder fetch/shader issues appear on some
   GPU, note it in the report; do NOT silently change dtype.)
2. **Selection**: wherever the settings UI chooses fast vs quality today,
   add the third option (label it "Qwen 2B"). Phone mode still forces the
   fast brain (existing logic — confirm it wins over the new key). Optional,
   only if ≤ ~5 lines: `?brain=fast|quality|qwen` URL override for the A/B
   harness convenience.
3. **A/B run**: identical content through both brains.
   - If `videos/` has a corpus file: two headless runs
     (`tools/browser-run.mjs`, `?video=<same-path>&autolive&brain=…` or the
     settings equivalent), each producing a `__lurkerDownload()` jsonl dump.
   - If no videos yet: use the demo scene for both runs and say so in the
     report (weaker evidence, still comparable).
   - Score both dumps with `tools/score-chat.mjs` if it exists; otherwise
     compute by hand in a throwaway node script (not committed): caption-echo
     rate (Jaccard > 0.5 vs caption), question rate, emote rate, unique
     bigram ratio, and rough gen latency (msgs/min × maxNewTokens is fine).
4. **Failure is a result**: the Qwen repo lacks the transformers.js tag. If
   `AutoProcessor`/`AutoModelForImageTextToText` throws on it, capture the
   exact error verbatim in the report, revert nothing (the entry stays
   behind the selector), and stop — do not try dtype surgery to force it.

## Verification

- `node --check workers/llm-worker.js` and `node --check js/main.js` clean.
- Both brains reach `ready` in a headless run (or the Qwen failure is
  captured verbatim).
- Report contains: the score table (metric × brain), load times, and any
  console warnings seen only on the Qwen brain.
- `git diff` touches only llm-worker.js, js/main.js, and (if needed)
  index.html for the option label.
