# Noise gate + mod-view input — 2026-11-02

Jordan's report: on `brain=omni` the sim "puts a lot of hums and whatnot type
descriptions and that's all chat talks about". He asked for a noise filter
before the model, and for the mod view to show a message's input.

## What was measured (not guessed)

`tools/probe.mjs noise-probe` — Omni LFM3-Omni-2B's own ASR over fixtures from
`tools/noise-fixture.mjs`:

| fixture | transcript |
|---|---|
| mains hum 100/200/300 Hz | NONE |
| fan / AC bed | NONE |
| keyboard clatter | NONE |
| music bed (chord + kick) | NONE |
| silence | NONE |
| **a hummed tune** | **`The speaker says, "Oh."`** |
| speech over a hum or fan bed | transcribed correctly |

So machine noise was never the leak — the model already refuses it. The two real
leaks are (a) speech-shaped non-speech (humming), which it answers with a
*description*, and (b) any such line then pulling a chat burst forward
(`onTranscript` clears the chat timer), so one description owns the room.

`tools/probe.mjs caption-probe` (12 real frames, current prompt vs a
sight-only prompt): no sound words in either — the vision path is not where the
hums come from.

Feature that separates the classes, over 20 ms frames, loud frames only,
cv = sd(zcr)/mean(zcr):

- real stream chunks cut by the app's own RMS gate: 0.60 0.86 1.03 1.26
- speech fixture 1.73, speech over a bed 1.65 / 1.68
- hummed tune 0.19 · music 0.28 · mains hum 0.14 · silence 0.00
- fan 0.60 · keyboard 1.96 — pass the gate on purpose, the model already says NONE

Threshold 0.4 → `js/audio-gate.js`. Live proof both ways: `--mic` runs show
asr=9 / noise=0 on real speech (nothing eaten), the unit test asserts the beds
are dropped.

## Shipped

- `js/audio-gate.js` — `looksLikeSpeech()` in front of ASR (both brains),
  `isSoundDescription()` as the net after ASR.
- mod view: `?debug=1` attaches the prompt to each model line and the card
  renders an `input ▸` fold (kind · saw frame · brain · calls).
- harness fix: `browser-run.mjs`/`probe.mjs` disable the CDP cache and reload —
  `python3 -m http.server` sends no `Cache-Control`, so **earlier headless runs
  may have tested stale `js/*.js`**. Any past run result is suspect until re-run.

## Still open

- Which brain ships (fast / quality / qwen / omni) — undecided.
- Cold-start caption "The screen is black, and nothing is on it right now."
  still seeds chat before the first real frame.
- `?debug=1` is localhost-gated; on spasm.milner.zone Jordan cannot open it.
- Real *singing with words* looks like speech to the gate and will still be
  transcribed. Upgrade = a real VAD if it bites.
- Nothing pushed: `branch.notes.pushRemote no-push-to-github`, and a `master`
  push redeploys spasm.milner.zone — ask first.
