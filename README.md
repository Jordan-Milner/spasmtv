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

- **Vision/chat:** `LiquidAI/LFM2.5-VL-450M-ONNX` — the same weights and load
  config (WebGPU, fp16 vision+embed, q4 decoder; ~800 MB as currently
  exported) as LiquidAI's own
  [WebGPU demo](https://huggingface.co/spaces/LiquidAI/LFM2.5-VL-450M-WebGPU).
  "Sharper" option: `onnx-community/LFM3-VL-2B-ONNX` q4f16 (~1.8 GB).
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
- The 350–450M "fast" brain writes dumb chat. That's the point. The 1.6B
  "sharp" option is there when you want cleverness over speed.
