# PLAN-TEMPORAL — from "reads a frame" to "watching a stream"

New axis, orthogonal to PLAN-CHAT-V3 (which made the *room* talk to itself —
social texture). This plan is about **scene understanding over time**: the chat
currently reacts to one frozen frame every ~8 s with zero memory, so it can only
produce atmospheric filler ("creepy", "intense"), never "the animatronic just
moved" or "he's been staring at that monitor for 20 s".

## Diagnosis (measured 2026-10-29, do not re-litigate)

- **Vision path is alive.** Ablation (real frame vs blank frame, same prompt,
  same 450M): real → content-specific ("creepy-looking room", "disturbing
  screenshot"); blank → generic filler. The frame reaches the model. Not the
  old black-frame bug.
- **But reactions are vague, not concrete.** 0/32 logged chat lines shared any
  content word with the scene; 13% generic filler. The model sees, it just sees
  a postcard and reviews the movie.
- **Root cause = the harness, not the weights** (this is the headline finding):
  1. Caption prompt is bare "Describe the scene in one short sentence." →
     "two rocks" for FNAF animatronics.
  2. Chat sees only `reactionSeed(scene, 3)` — 3 content words, subject stripped.
  3. **No temporal context at all**: one frame, no last-N frames, no memory of
     the previous captions. This is the one the 2025/26 literature agrees on.

## Caption-prompt + brain ablation (measured, FNAF clip)

| brain | P0 "describe the scene" | P1 "what game/show + what's happening" |
|---|---|---|
| fast (450M) | "dimly lit room, checkered floor, papers" | "Half-Life" (wrong game, but commits + concrete) |
| quality (2B LFM3) | "dark room, table, checkered floor" | "The Last of Us" (wrong) |
| qwen (2B Qwen3-VL) | "dimly lit cluttered office at night, game-like, 'we're not sure' message" | **"Five Nights at Freddy's"** (correct) |

Jordan's call: **intelligence over game identification.** Qwen is the most
grounded (reads on-screen text, only one that names FNAF). Default stays `fast`
for load speed; Qwen stays the "best grounded" picker option.

## Research grounding (2025–2026, verified)

- **StreamingVLM** (MIT/NVIDIA, arXiv 2510.09608, ICLR 2026): a small VLM fed
  one-frame-at-a-time is useless on a stream; give it a compact streaming KV
  cache = **attention sinks + short vision window (~16 s) + long text window**
  and it gets coherent real-time understanding (66% win vs GPT-4o mini, stable
  8 FPS). Its training corpus (Inf-Streams) is *exactly* Jordan's idea: 6000 h
  stream footage → ASR → LLM-cleaned per-second (video↔text) pairs.
  **We steal the inference trick (the windows), not the training.**
- **Apple FastVLM-0.5B** runs real-time video captioning in-browser on WebGPU
  (Q4 ONNX, transformers.js) — same stack as ours. The browser tier is not the
  ceiling; the single-frame harness is.
- **Qwen3-Omni** (Sep 2025): native text+image+audio+video, real-time streaming,
  ASR ≈ Gemini 2.5 Pro. Server-side only (30B MoE) — violates zero-backend, so
  it is a *fleet-GPU* option, not a browser default.
- **Pruning/quantization**: make a model smaller/faster at ~same intelligence;
  they do NOT add capability. We already have Q4/Q8. Pruning a 450M won't give
  it temporal reasoning it never had. Right tool for distilling a smarter model
  to phone size, wrong tool for "feel real".

## The change (in-browser only — keeps the zero-backend invariant)

StreamingVLM's windows, expressed as prompt context (we can't touch the KV cache
in transformers.js, but we can hand the model the same three signals as text +
frames):

1. **Rolling scene memory (the long text window).** Keep the last N captions in
   `state.sceneHistory`. Feed chat a compact "what just happened on screen" line
   built from the recent captions, so a reaction can reference a *change*
   ("the room changed", "still at the desk") instead of only the current frame.
2. **Multi-frame (the short vision window).** `burstFrames` already grabs a few
   frames — send the last few to the model for visual kinds so it perceives
   motion, not a still.
3. **Caption prompt upgrade** (generic, no game baked in): "What is on this
   screen and what is happening right now?" — measured strictly better on every
   brain. NO game-specific words anywhere (Jordan's explicit veto).
4. **Wider seed / fuller caption to chat** — guarded by the existing
   `echoesScene` anti-echo filter so it can't regress into caption-copying.

## Hard constraints (non-negotiable)

- **Zero backend / nothing leaves the browser** (NORTH-STAR). All of the above
  is client-side prompt/frame assembly. No server inference.
- **No game-specific prompts or style examples.** The model reads whatever is on
  screen; we never bake in FNAF/animatronics/freddy or any title.
- **Twitch-chat energy** (short, lowercase, reaction-shaped) — temporal context
  must not turn lines into sentences. The anti-echo + keep() nets stay.
- Every change measured: headless `browser-run` + `score-chat` + **read the
  transcript**. New leak shape → a `test-text.mjs` case.

## Sequencing

1. Rolling scene memory (text window) — biggest, cheapest, lowest risk.
2. Caption prompt upgrade — one line, measure caption concreteness.
3. Multi-frame for visual kinds — needs the omni/multi-image path; check which
   brains support it before wiring.
4. Fuller caption to chat — only if 1–3 don't already close the vagueness gap.

## STATUS 2026-10-29 — step 1 + 2 shipped (uncommitted, `npm test` green 892)

Implemented the two lowest-risk levers and measured them:
- **Rolling scene memory** (`state.sceneHistory`, last 4 deduped captions) →
  worker adds `[earlier: <seeds of past captions>]` for visual kinds.
- **Caption prompt** → "What is on this screen and what is happening right now?"

**Decisive ablation (fast/450M, same frame, prompt differs only by `[earlier:]`):**
- WITHOUT: generic boredom — "stared at this fan for ten minutes", "too long, need a break".
- WITH: **"My music box prize is waiting"**, "heads turning around the desk fan" —
  the 450M pulls concrete nouns out of the history. **The harness fix works on the
  smallest brain.** This is the answer to "it only reacts to lights and colors":
  give it the last few seconds and it reacts to *what happened*.
- End-to-end 2-min run: temporal lines present ("stuck at 4 AM ... again", "not the
  music again", "how it evolves"), **0 bracket leaks**, 1/57 soft prompt-echo
  (pre-existing `real chat lines` style-echo, unrelated to this change).
- scene-linkage metric (shares a content word w/ a caption) 9%→14% — noisy proxy,
  emote-heavy lines have no linkable words; the ablation is the real evidence.

Regression test added: `tools/test-text.mjs` extracts the `[earlier:]` expression
and asserts bracketed, current-caption-excluded, length-capped, silent on 1 caption.

## What we still don't know

- Does the 450M actually *use* a scene-history line, or ignore it the way it
  ignored negations? Measure before trusting.
- Multi-frame support per brain (transformers.js single-image vs multi-image).
- Whether temporal context raises the scene-linkage metric without tripping the
  echo filter — the two are in tension by construction.
