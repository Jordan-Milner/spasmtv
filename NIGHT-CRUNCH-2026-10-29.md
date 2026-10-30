# NIGHT-CRUNCH 2026-10-29 → 30 — audio responsiveness follow-up

Parent: PLAN-TEMPORAL (scene understanding over time) + the audio-reaction fix
(commit 2455c7d, unpushed). Jordan said "crunch on this through the night" —
work the open audio/temporal problems autonomously, verify, leave committed but
UNPUSHED (push to master redeploys spasm.milner.zone — Jordan's call).

## Done today (before this ledger)
- 9f31bb1 phone crash fix (pushed, live).
- 2455c7d speech-as-reaction-trigger (unpushed): onTranscript pulls chatLoop
  forward; first burst line forced to react; skips canned/pasta so it reaches
  the model; worker cue + relaxed echo for the answer. npm test green.

## Tonight's open problems (from PLAN-TEMPORAL "what we still don't know")
1. Does the 450M actually USE the streamer's words, or ignore/parrot them?
   → speech-abl3.mjs: clean A/B, grammar:true (sampling on), interleaved arms.
   EARLY SIGNAL: abl2 (greedy, no grammar) gave byte-identical arms — a harness
   artifact (do_sample off), NOT a real "speech does nothing" result. pp4 proved
   the prompts ARE isolated (WITHOUT has no speech line). abl3 fixes sampling.
2. Multi-frame (vision window) per brain — which brains support multi-image in
   transformers.js? VLM config says fast.multiFrame=false (single-image ONNX).
   Check quality/qwen/omni before wiring.
3. Gate responsiveness constants (MIN_SPEECH_MS/SILENCE_HANGOVER/MAX_CHUNK) —
   retune only with measurement, not blind.

## Harness gotchas (so nobody re-learns them)
- Worker is a CLASSIC worker: post with `W.postMessage`, read via `W.onmessage`
  (NOT W.port.* — port is undefined, silently no-ops).
- Direct chat posts MUST pass `grammar:true` or do_sample stays off → greedy →
  identical lines that look like "the arms didn't differ".
- `?demo=1` is NOT a param; use `?video=videos/real-stream.mp4&autolive=1` for a
  headless live run. Readiness = poll document.title for `phase=live` (phase is
  NOT mirrored to window.__spasmtv).
- real-stream.mp4 = real shroud stream speech (tools/fetch-stream-clip.mjs).
  videos/ is gitignored — local fixture, never committed.

## Status log
- [DONE] abl3 clean A/B (grammar:true, interleaved, real-stream.mp4, fast/450M):
  **the 450M USES the streamer's words, it does not parrot them.**
  - WITH speech "grinding hard modes before work": "grinding that hard mode",
    "you're grinding so much", "grinding tough difficulty", "worked 6hrs at this
    location", "not getting enough sleep" — pulls grind/hard-mode/work/tired and
    REPHRASES them.
  - WITHOUT speech: "staring at my chair", "moving the fan left and right",
    "weird chair setup" — falls back to the scene (chair/fan), zero grind/work.
  - 0 PARROT in either arm → the relaxed echo filter does NOT leak caption-copy.
  - distinct lines WITH 9/14, WITHOUT 10/14 → sampling confirmed live (arms differ).
  - Earlier "identical arms" (abl2) = greedy decoding: harness omitted grammar:true
    → do_sample off. NOT a real result. pp4 proved the prompts are isolated.
- [DONE] multi-frame (vision window): NOT wired. burstFrames sends one image;
  generate() collapses frames→last. The multiFrame flag is declared-unused. The
  processor comment says this family treats image arrays as BATCH not multi-image,
  so wiring it needs per-family multi-image support that may not exist in
  transformers.js. DEFERRED — research rabbit hole, not a lazy overnight win.
  Only `quality` (LFM3-VL-2B) is video-native; fast/qwen/phone are single-image.
- [DONE] debug hook folded into window.__spasmtv.worker (one debug global).

## Bottom line for Jordan
The speech-trigger fix (2455c7d) is correct AND the model genuinely uses the
words — measured, not assumed. Nothing else shipped tonight: multi-frame is
deferred (needs a processor investigation), gate constants left alone (no
measurement said to change them). All committed, UNPUSHED.
