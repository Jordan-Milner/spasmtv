# RESEARCH — better chat without abandoning WebGPU (2026-10-28)

Question: how do we raise simulated-chat quality while staying fully
in-browser on WebGPU, inside the NORTH-STAR invariants (zero backend, nothing
leaves the browser, weights from HF's CDN, all compute on the user's GPU).

Current stack this is measured against: transformers.js **4.3.2** (pinned),
`LFM2.5-VL-450M` (fast brain) / `LFM3-VL-2B` (quality brain), one generate
call per message, prompt v3 + post-gen filters.

Facts are labeled **[verified]** (I ran it / read the official page today) or
**[reported]** (credible source, not independently re-measured).

## 1. Runtime verdict: stay on transformers.js

- **[verified]** transformers.js 4.3.2 (28 Oct 2026) is the latest release —
  the repo already pins it. The v4 line is the actively-developed one: C++
  WebGPU runtime rewrite (4.0.0), Safari 26+ WebGPU (4.3.0), structured
  output (4.3.0), LFM3/LFM3-VL support (4.3.2). Releases:
  https://github.com/huggingface/transformers.js/releases
- **[reported]** WebLLM (MLC) has **no vision-language model support** — its
  prebuilt registry is text-only and multimodal conversion is broken/
  unofficial (https://github.com/mlc-ai/web-llm, conversion issue
  https://github.com/mlc-ai/web-llm/issues/698). There is no runtime escape
  hatch that keeps vision, so the lever is *models + decoding + data*, not
  engines.
- **[verified]** WebGPU browser reach ~85% and the official fallback guidance:
  https://huggingface.co/docs/transformers.js/main/en/guides/webgpu

## 2. Model options (same runtime, drop-in candidates)

Small VLM ONNX builds available from onnx-community **[verified via HF API]**:

| model | size class | notes |
|---|---|---|
| LFM2.5-VL-450M-ONNX | 450M | current fast brain |
| LFM3-VL-2B-ONNX | 2B | current quality brain (created 2026-10-27) |
| **Qwen3-VL-2B-Instruct-ONNX** | 2B | q4f16 total ≈ **1.38 GB** (decoder 1.00 + embed 180 MB + vision 197 MB); **Apache-2.0**; repo created 2026-03, updated 2026-10 |
| Qwen2.5-VL-3B-Instruct-ONNX | 3B | middle option, heavier |
| Qwen3-VL-4B / 8B-ONNX | 4B+ | desktop-only experiments |
| LFM2-VL-450M/1.6B/3B, Qwen2-VL-2B, SmolVLM2-2.2B | — | dated generation |

- **[reported]** Qwen3-VL-2B is generally regarded as the strongest ~2B open
  VLM (vs SmolVLM2-2.2B and LFM2-VL same-size) on instruction following,
  OCR/documents, RealWorldQA-class tasks; direct head-to-heads with LFM3-VL
  are scarce — our own scorer is the honest arbiter (that's unit U7).
- **[verified]** transformers.js 4.0.0 release notes list Qwen3-VL among
  supported architectures; the onnx-community build ships the full trio of
  components (vision_encoder / embed_tokens / decoder_model_merged) so the
  existing `dtype` map shape carries over. The repo lacks the `transformers.js`
  tag, so a load failure is a possible outcome — U7 treats "fails to load,
  error captured verbatim" as a valid result.
- **License matters for the next lever** **[verified]**: Qwen3-VL-2B is
  Apache-2.0; every LFM build is "license: other". If we ever fine-tune and
  re-host weights, Apache-2.0 is the clean target.
- Phone tier later **[verified]**: 4.1.0 added `q1/q1f16/q2/q2f16` dtypes —
  lighter vision-encoder options than today's phone q4 if iOS jetsam needs
  more headroom (quality re-check required).

## 3. Split-brain option: VLM captions + text-only chat writer

The chat path already treats the frame as a 3-word reaction seed, and
non-visual kinds already send a blank stand-in image. That means a
text-only model could write chat lines from caption + context, with the
VLM kept just for captioning.

- **[verified]** `onnx-community/Qwen3-1.7B-ONNX` exists, transformers.js
  -tagged, text-generation. The small *text* model zoo is far bigger than
  the small VLM zoo, and text-only models are the easy fine-tune targets.
- Cost: two resident models (~450M VLM + 1.7B text ≈ +1 GB VRAM) — a
  desktop-only quality tier; phone stays single-brain.
- This is parked as a §H "bigger lever" — bigger change, uncertain payoff
  over U7's simple swap.

## 4. Decoding levers — what the pinned runtime actually supports

Measured against the exact bundle we ship
(`@huggingface/transformers@4.3.2/dist/transformers.min.js`, grepped today):

- **[verified] min_p is NOT implemented.** The only `min_p` strings in the
  bundle are `min_pixels` (vision processor config); there is no
  `MinPLogitsProcessor`. (Min-p is the paper-backed better sampler —
  https://arxiv.org/html/2407.01082 — but it's a Python-transformers
  feature.) Levers available: `temperature`, `top_p`, `top_k`,
  `repetition_penalty`, `typical_p`, `no_repeat_ngram` keys, seedable RNG.
  `no_repeat_ngram_size` is worth an A/B against the current
  repetition_penalty-only setup — it directly targets the repeated-phrase
  loops the echo filters fight.
- **[reported]** `num_return_sequences` is unreliable in transformers.js
  (https://github.com/huggingface/transformers.js/issues/1007) — no batch
  best-of-N; the sequential retry we already do is the right shape.
- **[verified] Grammar-constrained generation IS available now:**
  `@huggingface/transformers-structured-output@4.3.2` — dependency-free,
  Apache-2.0, `StructuredOutputProcessor` passed as a `logits_processor` to
  `model.generate()`; constrains to a JSON schema or a **regex**. Limits:
  single generated sequence at a time (we generate one line per call),
  full-string regex only, no lookarounds/backreferences/lazy quantifiers/
  Unicode classes; model and tokenizer must share `eos_token_id`.
  This turns the *source* of several failure classes off: emoji faces,
  hashtags, uppercase/prompt-leak debris become unsampleable, so fewer
  lines die in post-gen filters → fewer retry GPU calls per kept line.
  The keysmash filter stays (consonant runs are charset-legal).
  That's unit U8.

## 5. The biggest lever, parked: fine-tune on real chat

A small model tuned on the target distribution beats a bigger general model
on this narrow task. The path is established end-to-end **[reported]**:
LoRA/QLoRA (PEFT or Unsloth) → merge adapter → export ONNX q4 (Optimum) →
host on HF → load in transformers.js exactly like today's models.
References: https://ashishware.com/2025/11/16/slm_in_browser (end-to-end
walkthrough), https://onnxruntime.ai/docs/genai/tutorials/finetune.html.

Corpora that exist today:
- **TwitchChat (Ringer et al., AIIDE 2020)** — 60M+ tokens of livestream
  chat across 20 games:
  https://ojs.aaai.org/index.php/AIIDE/article/view/7439
- **TTS-AGI/twitch** on HF datasets: https://huggingface.co/datasets/TTS-AGI/twitch
- Our own §G pipeline (OCR'd VOD chat against the *same content* the sim
  watches) — the highest-signal corpus because it's aligned with our inputs.
- Synthetic distillation: generate persona-conditioned reactions to frames
  with a big model offline, SFT the small brain on them. The zero-backend
  invariant governs the *deployed site* only — training happens offline,
  weights ship via HF CDN like today's.

Gate: license-clean base model (Qwen3-VL-2B, Apache-2.0 — another reason
for U7), plus Jordan's go on training time. Decision parked in
PLAN-CHAT-V2 §H Needs Jordan.

## 6. Ranked plan (what got queued)

1. **U7 — A/B Qwen3-VL-2B as the quality brain** (cheap, likely the
   biggest instant lift, unlocks the fine-tune path). → tasks/U7.
2. **U8 — regex grammar guard on chat generation** (kills failure classes
   at the logits level, cuts retry GPU calls). → tasks/U8.
3. **Exemplar bank**: few-shot style exemplars mined from real chat corpora
   (fixed bank, NOT the recent window — the v1.1 echo-loop lesson), gated on
   §G corpus arriving.
4. **Split-brain** (§3) and **SFT/LoRA** (§5) — parked for Jordan.
5. Phone-tier q1/q2 encoders — only if iOS load needs it.

## Sources

- transformers.js releases & WebGPU guide —
  https://github.com/huggingface/transformers.js/releases ,
  https://huggingface.co/docs/transformers.js/main/en/guides/webgpu
- Model repos (verified via HF API, 2026-10-28) —
  https://huggingface.co/onnx-community/Qwen3-VL-2B-Instruct-ONNX ,
  https://huggingface.co/onnx-community/Qwen3-1.7B-ONNX ,
  https://huggingface.co/onnx-community/LFM3-VL-2B-ONNX
- Structured output package —
  https://www.npmjs.com/package/@huggingface/transformers-structured-output
  (registry read 2026-10-28), feature request history
  https://github.com/huggingface/transformers.js/issues/1328
- num_return_sequences limitation —
  https://github.com/huggingface/transformers.js/issues/1007
- min-p sampling (background, not available here) —
  https://arxiv.org/html/2407.01082 ,
  https://github.com/huggingface/transformers/issues/27670
- WebLLM VLM status — https://github.com/mlc-ai/web-llm ,
  https://github.com/mlc-ai/web-llm/issues/698
- Small-VLM quality context —
  https://huggingface.co/HuggingFaceTB/SmolVLM2-2.2B-Instruct ,
  https://www.liquid.ai/blog/lfm2-vl-efficient-vision-language-models ,
  https://huggingface.co/LiquidAI/LFM2-VL-1.6B
- Twitch chat corpora —
  https://ojs.aaai.org/index.php/AIIDE/article/view/7439 ,
  https://huggingface.co/datasets/TTS-AGI/twitch
- Fine-tune → browser workflow —
  https://ashishware.com/2025/11/16/slm_in_browser ,
  https://onnxruntime.ai/docs/genai/tutorials/finetune.html
