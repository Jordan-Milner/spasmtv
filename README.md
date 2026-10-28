# twitch-sim (SpasmTV)

**An AI Twitch stream that watches you.** Your webcam feed becomes the "stream";
a vision-language model runs entirely in your browser (WebGPU) and plays the
role of Twitch chat — reacting to what it sees, and (if you allow the mic) to
what you *say*. Nothing is uploaded, ever: the only network traffic is a
one-time model download from Hugging Face's CDN, and every frame/audio sample
is processed on your own GPU.

## Run it

WebGPU requires a secure context, so serve it over localhost:

```sh
./serve.sh            # http://localhost:8619  (ps name: twitch-sim-server)
```

Open http://localhost:8619 in Chrome/Edge 113+, pick a brain, **Go live**.

Tailnet: **https://jordans-maxbook.tail38dbd0.ts.net/** (via `tailscale serve`,
valid HTTPS cert → WebGPU works on other devices signed into the tailnet,
including phones; the layout stacks for phone screens). To share beyond the
tailnet, `tailscale funnel 8619` makes it public-HTTPS — deliberate choice.

- First load downloads the model(s) (~800 MB fast / ~1.8 GB sharp — encoder
  fp16 189 + decoder q4 481 + embeds 134) into the browser cache; reloads
  after that are instant.
- **iPhone/iPad:** automatic *phone mode* — the 450M brain with a **q4**
  vision encoder (~675 MB total) because Safari kills a tab whose memory
  passes roughly 1–1.5 GB (with the stock config the page just reloads
  mid-download). Mic hearing and the 2B brain stay computer-only. This is
  the lightest this model can get; if the tab still reloads during load,
  that phone can't hold the 450M brain at all — open it on a computer.
  `?phone` previews phone mode on a desktop.
- No camera? Check **demo** — the chat reacts to a generated fake stream.
- **share** — feed the chat a tab or your whole screen (`getDisplayMedia`),
  audio included, so it reacts to what you're actually watching.
- **+** (or drag a file onto the stage) — play a **video file** as the stream: it
  goes through the same frame-diff/scene-change path, and its audio track into
  the same speech gate, so the chat watches and hears a VOD the way it watches
  your camera. Nothing uploads or copies — it is a `<video>` element and a canvas.
- URL params: `?video=PATH&autolive` (autoplay a file through the whole pipeline
  — what the headless harness uses), `?brain=qwen|lfm3b|quality`, `?grammar=0`,
  `?phone`, `?autolive=1`.
- Talk into your mic — the chat hears you (transcribed locally) and answers
  within a couple of seconds.
- You can also type into the chat box: you're the streamer, talk to your chat.

## The chat sim

- **Click any username → mod view**: their recent messages in one box, a
  **Yell** button (they turn defensive and keep talking), and timeouts of
  1 sec / 1 hour / 1 day / 1 week / custom minutes, plus unban. Returning
  prisoners announce themselves.
- Viewers who ask questions get a **❓** chip; the top question-asker is crowned
  **chat MVP** (golden badge) until someone out-questions them.
- Real emote images (global BTTV/FFZ/7TV sets, hotlinked from their CDNs);
  the model is steered toward real codes so its emotes render as images.
- Motion is noticed: a frame-diff detector runs every 1.5 s; a hard scene
  change bumps the viewer count and sends the chat the *actual frame* with
  "something just changed — react to it". The model itself sees still frames
  (no temporal memory) — the burst + fresh frame is how "bounce" becomes chat.

## Chat logs (tuning corpus)

Every generated message is logged **with the context that produced it** (scene
caption at generation time, transcribed speech, persona, recent-chat window,
viewer name). Local only — in-memory ring + localStorage mirror. In the console:

```js
__lurkerDump()      // JSON of the whole session log
__lurkerDownload()  // saves lurker-chatlog-<date>.jsonl
```

A sample log from a fake-camera session is in `docs/sample-chatlog-2026-10-27.json`.

### Scoring the corpus

The log *is* the tuning corpus: every change is measured, not vibed.

    node tools/browser-run.mjs --out /tmp/run.jsonl --minutes 4 \
      --url-params "video=videos/vod-fnf-work.mp4&autolive=1"   # headless Chrome over CDP
    node tools/score-chat.mjs /tmp/run.jsonl                    # the rubric; exits non-zero on a FAIL

`score-chat.mjs` is model-independent — it reads the log only — and gates
caption-echo rate (<10%), question rate (10–25%), emote rate (25–50%), unique
bigram ratio (>0.60), burst correlation after a scene change (≥2×), ban-reaction
latency (<6 s) and template-repeat rate. `browser-run.mjs` runs **one Chrome at a
time**: two headless WebGPU Chromes deadlock the second at "checking WebGPU".
The current pass is green except burst correlation, which needs real motion — the
demo canvas never crosses the scene-change threshold, so measure it against a
video file.

**Guarding the charset** (§H/U8): chat generation is constrained by a regex
(`[A-Za-z0-9 ,.!?']{1,90}`) through `StructuredOutputProcessor` as a
`logits_processor`, so emoji faces, curly quotes, hashtags and template debris
become unsampleable instead of post-filtered — measured 1.19 vs 1.29 GPU calls
per kept line, 0/48 model lines outside the charset, no score regression.
Caption and ASR prompts stay unconstrained; `?grammar=0` turns it off and phones
never load it. Gotcha: the package's bare jsDelivr URL is CJS, see
`tasks/U8-REPORT.md`.

### Real chat, for comparison (§G)

`videos/` (gitignored) holds VODs whose burned-in chat can be OCR'd back out:

    node tools/extract-real-chat.mjs videos/vod-fnf-work.mp4 --region 300:500:980:220

That writes `videos/vod-fnf-work.realchat.jsonl` — the target distribution the
sim's log is read against (`--compare`; `tasks/D1-REPORT.md` has the region that
works per clip). Those lines also seed the sim's canned pool and few-shot style
examples.

Tuning findings so far (encoded in the worker): the 450M echoes persona hints
verbatim unless they're phrased as instructions; pasting recent chat into the
prompt anchors degeneration loops ("A. hair? cringe me!" ×20), so dedupe now
happens post-generation with a hotter retry instead.

## How it works

```
webcam frame ──► canvas (448px) ──► vision-language model (WebGPU) ─┐
mic audio ────► silence gate ──► speech-to-text (WebGPU) ───────────┤
recent chat lines + your typed messages ────────────────────────────┴─►
        "write ONE twitch chat message reacting to this" → chat panel
```

- **Vision:** LiquidAI's LFM2-VL family via transformers.js, quantized, on your
  GPU. One call captions the scene (~every 8 s or on hard scene cuts), the rest
  write single chat messages at Twitch cadence.
- **Audio:** an AudioWorklet taps raw PCM, a simple RMS gate segments speech,
  and a Whisper-class model transcribes each utterance locally.
- **Chat sim:** viewer names/colors are client-side cosmetics; the model only
  writes message text. Viewer count drifts, hype bursts on scene changes.

See `NORTH-STAR.md` for the invariants (zero backend, nothing leaves the
browser, Twitch energy not chatbot energy) and `PLAN.md` for the ledger.

## Model notes

- **Vision/chat** — four brains in the dropdown, one loader (each is a `VLM`
  entry in `workers/llm-worker.js`):

  | brain | model | size | measured |
  |---|---|---|---|
  | Fast chat | `LiquidAI/LFM2.5-VL-450M-ONNX` fp16+q4 | ~800 MB | default; same load config as LiquidAI's own [WebGPU demo](https://huggingface.co/spaces/LiquidAI/LFM2.5-VL-450M-WebGPU) |
  | Sharper chat | `onnx-community/LFM3-VL-2B-ONNX` q4f16 | ~1.8 GB | 0.28 s/line — fastest of the big three |
  | Liquid 3B (experimental) | LFM2.5-VL-3B class | ~2 GB | 1.45 s/line for Qwen-ish quality — not worth it |
  | Qwen 2B (best grounded) | `onnx-community/Qwen3-VL-2B-Instruct-ONNX` q4f16, Apache-2.0 | ~1.4 GB | 0.48 s/line, least hallucinating |

  A/B was 2026-10-28 on `videos/vod-fnf-work.mp4`, 1.5 min per brain; pick one
  with the dropdown or `?brain=qwen|lfm3b|quality`. Phones are pinned to
  `HuggingFaceTB/SmolVLM-256M-Instruct` (see the iPhone note above).
- **Speech-to-text:** `onnx-community/moonshine-tiny-ONNX` (~75 MB, MIT) —
  built for short streaming utterances; encoder fp32 / merged decoder q4 on
  WebGPU. Whisper-tiny.en would be the drop-in fallback.
- **Runtime:** transformers.js 4.3.2 from jsDelivr, ESM, inside a module
  worker. Requires WebGPU + the `shader-f16` feature (any recent Apple Silicon
  / discrete GPU in Chrome/Edge).
- **License:** LFM Open License v1.0 — free to use including commercially under
  a $10M revenue threshold; fine for a free public web app. Moonshine is MIT.

LiquidAI also ships native audio models (`LFM2.5-Audio-1.5B`, `LFM3-Omni-2B`),
and the Omni even documents in-browser use — but through raw ONNX Runtime
graphs, not transformers.js. Until that's turnkey, a local ASR model feeding
text to the VLM is the sane way to make chat "hear" you, so that's what this does.

## Known limits

- Desktop Chrome/Edge with WebGPU required (Safari/Firefox: no WebGPU or
  flaky). iPhone/iPad Safari is the one mobile exception — phone mode (q8
  fast brain, no ASR), everything else needs a computer.
- First message after model load can lag a few seconds while the GPU warms up.
- The 350–450M "fast" brain writes dumb chat. That's the point. Qwen 2B is there
  when you want cleverness over speed.
- The grammar guard forbids `-`, `~`, `*` and curly quotes in sampled text, so
  `straight-eye-open` comes out `straight eye open`. Widen `CHAT_REGEX` in
  `workers/llm-worker.js` if you disagree; `?grammar=0` if you really disagree.
