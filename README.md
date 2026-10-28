# SpasmTV

**An AI Twitch stream that watches you.** Your webcam (or a shared tab, or a
video file) becomes the stream, and a vision-language model running in your
browser on WebGPU plays the chat. It reacts to what it sees, to what you say
into the mic, and to the moderation you hand out.

**Live:** https://spasm.milner.zone. It needs desktop Chrome or Edge with WebGPU,
or a recent iPhone, iPad or Android phone (see [phone mode](#phone-mode)).

A parody. Not affiliated with Twitch, BetterTTV, FrankerFaceZ, 7TV, Liquid AI,
Qwen or Hugging Face.

## Privacy: what leaves your browser

- **Nothing you produce.** Camera frames, mic audio, a shared screen and any
  video file you drop in are processed by models running in the page and are
  never sent anywhere. There is no backend, account or analytics.
- **What the page downloads:**
  - the inference libraries from `cdn.jsdelivr.net` (transformers.js 4.3.2 and
    its structured-output add-on; onnxruntime-web only for the experimental Omni
    brain);
  - model weights from `huggingface.co`, which the browser caches after the
    first load;
  - the global emote lists and images from BetterTTV, FrankerFaceZ and 7TV.

  These are ordinary requests, so those hosts see your IP and user agent like
  any page load. They carry nothing about your stream.
- **What stays on the device:**
  - The session's chat log lives in memory, including what the mic transcribed.
    It is gone when the tab closes.
  - Facts the chat remembers about you, your settings, the tuning panel and the
    viewer roster are kept in `localStorage`.
  - ⚙ → **forget everything** clears the facts, the log, the stored roster and
    the tuning panel.
  - `?log=1` opts into mirroring the log to `localStorage` while you tune.

## Use it

Pick a brain, then hit **Go live**. The first load downloads the model (see the
table below); later loads are instant.

| control | what it does |
|---|---|
| **mic** | chat hears you. Speech is transcribed locally (Moonshine) and answered within seconds |
| **demo** | no camera? the chat watches a generated fake stream |
| **share** | feed the chat a tab or your whole screen, audio included |
| **+** / drag a file | play a video file as the stream; its picture and audio go through the same path as the camera |
| chat box | you are the streamer: type to your chat and the next lines answer you |
| click a username | mod view: recent messages, Yell, Warn, timeouts from 1 s to 1 week, ban, unban |
| **⚙** | capture detail, motion focus crop, speech model, remembered facts, the full tuning panel, measured latency |

URL parameters:

| parameter | effect |
|---|---|
| `?brain=fast\|quality\|qwen` | preselect a brain |
| `?brain=lfm3b\|omni` | add an experimental brain to the picker (below) |
| `?phone` | preview phone mode on a desktop |
| `?grammar=0` | turn off the charset guard on chat generation |
| `?video=PATH&autolive=1` | play a same-origin video file through the whole pipeline and go live. This is what the test harness uses |
| `?log=1` | mirror the chat log to `localStorage` |

### Brains

| picker | model | download | license |
|---|---|---|---|
| Fast chat (default) | [`LiquidAI/LFM2.5-VL-450M-ONNX`](https://huggingface.co/LiquidAI/LFM2.5-VL-450M-ONNX), fp16 vision + q4 decoder | ~800 MB | LFM Open License v1.0 |
| Sharper chat | [`onnx-community/LFM3-VL-2B-ONNX`](https://huggingface.co/onnx-community/LFM3-VL-2B-ONNX), q4f16 | ~1.9 GB | LFM Open License v1.0 |
| Qwen 2B | [`onnx-community/Qwen3-VL-2B-Instruct-ONNX`](https://huggingface.co/onnx-community/Qwen3-VL-2B-Instruct-ONNX), q4f16 | ~2.3 GB | Apache-2.0 (Qwen3-VL) |
| Phone chat (phones only) | [`HuggingFaceTB/SmolVLM-256M-Instruct`](https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct), q4/q8 | ~180 MB | Apache-2.0 |
| `?brain=lfm3b` (experimental) | [`LiquidAI/LFM2.5-VL-3B-ONNX`](https://huggingface.co/LiquidAI/LFM2.5-VL-3B-ONNX), fp16 vision + q4 decoder | ~4 GB | LFM Open License v1.0 |
| `?brain=omni` (experimental) | [`LiquidAI/LFM3-Omni-2B-ONNX`](https://huggingface.co/LiquidAI/LFM3-Omni-2B-ONNX) on raw onnxruntime-web; hears speech itself, no Moonshine | ~1.6 GB, +510 MB audio encoder on first speech | LFM Open License v1.0 |

Speech-to-text uses [`onnx-community/moonshine-base-ONNX`](https://huggingface.co/onnx-community/moonshine-base-ONNX)
(~155 MB, MIT) by default, or `moonshine-tiny` (~76 MB) from ⚙.

The Liquid AI models are under the LFM Open License v1.0, which allows free use,
including commercial use below a revenue threshold. Read it before building on them.

### Phone mode

iPhones, iPads and Android phones get *phone mode* automatically. Their browsers
kill a tab whose memory passes roughly 1 GB, which even the 450M brain exceeds
while it loads. Phone mode instead runs:

- the 256M SmolVLM brain, which writes noticeably simpler chat;
- with the mic off, because speech recognition doesn't fit alongside it.

Android tablets keep the computer brains.

## The chat sim

- **Viewers have archetypes**, such as hype man, backseat gamer, lurker, regular,
  doomer, parasocial, troll, newcomer and copypasta. Each has its own posting rate
  and cosmetics like case, typos, trailing ellipses and emote habit. The roster
  persists, so regulars come back.
- **Cadence is bursty**, with droughts and pile-ons rather than a metronome. A
  scheduler picks what kind of line comes next: reaction, question, emote,
  backseat, reply, banter, a callback to a running joke, or meta. Emote lines,
  copypastas and a slice of real chat lines cost no GPU.
- **Motion is noticed.**
  - A frame-diff detector runs every 1.5 s. A scene change is a spike above the
    last ~30 s of motion, so a busy game needs a real cut and a still webcam
    only a nudge.
  - On a change, a three-line burst fires at once, sees the actual frame, and
    bumps the viewer count.
  - Chat then piles on for about 10 s, mostly with emotes, and catches its
    breath afterwards.
- **Moderation has consequences.**
  - Chat reacts to timeouts and bans, and a banned viewer's friends take sides.
  - Returning viewers announce themselves.
  - A standing "mods ban for this" culture forms from what you punish.
- **Real emotes.** The global BTTV/FFZ/7TV sets are hotlinked from their CDNs.
  The model is steered toward real codes, and cosmetics never touch a code, so
  emotes render as images.
- **Chat remembers you.** First-person facts you say on stream ("i have two
  dogs") pass a strict gate and become context. You can edit, delete or add
  them in ⚙.

### Output filtering

A real person is on camera and the page is public, so every model line passes a
reject list (`js/text.js`) before it renders. The list drops:

- slurs, sexual or body talk, and self-harm;
- the archetype brief coming back as chat ("HYPEMAN", "reacts like a troll");
- invented `@handles` and digit or symbol junk;
- lines that just repeat the caption or what the streamer said.

Emote codes that read as a jab when aimed at someone on camera are never loaded.
The canned lines pass the same list in `npm test`.

## How it works

```
camera / share / file ─► frame grab (1.5 s) ─► motion detector ─► scene change?
          │                                                         │
          └─► caption (~8 s, or on a change) ──┐                    ▼
mic ─► silence gate ─► Moonshine ASR ──────────┼──► chat prompt ─► VLM ─► reject list ─► chat
your typed messages ───────────────────────────┘     (+ the frame on a change)
```

- Everything runs in one module worker (`workers/llm-worker.js`) on
  transformers.js and WebGPU.
- The page (`js/main.js`) owns the clocks and context; `js/chat-sim.js`
  renders chat and the mod view.
- `js/cadence.js` and `js/culture.js` are pure functions so node can test them.
- **Charset guard:**
  - Chat generation is constrained by a regex (`[A-Za-z0-9 ,.!?']{1,90}`) applied
    as a logits processor, so emoji faces, hashtags, `@` and template debris can
    never be sampled.
  - Captions and the fact prompt are unconstrained.
  - `?grammar=0` turns it off.
- **Brain switches** dispose the old model's GPU memory before the next one loads.

## Develop

WebGPU needs a secure context, and `http://localhost` counts. To serve the repo
root:

```sh
npm run serve        # python3 -m http.server 8619 --bind 127.0.0.1
```

Then open http://localhost:8619. (`./serve.sh` does the same with a named
process on macOS.)

Tests, with no browser and no dependencies:

```sh
npm test
```

The test files cover the text filters, the cadence budget, the culture loop and
the scorer's compare mode.

**Measuring chat, not vibing it.**

1. `tools/browser-run.mjs` drives the real page in headless Chrome over CDP and
   writes the session log.
2. `tools/score-chat.mjs` scores the log against a rubric and exits non-zero on
   any failure.

```sh
node tools/browser-run.mjs --out run.jsonl --minutes 4 \
  --url-params "autolive=1&video=videos/your-clip.mp4"   # add --mic to let audio through
npm run score -- run.jsonl
```

How the harness behaves:

- Videos go in `videos/`, which is gitignored, so bring your own.
- Run one Chrome at a time: two headless WebGPU Chromes deadlock the second.
- Without `--mic` the harness forces the mic off.

The rubric:

| metric | target |
|---|---|
| caption-echo rate | ≤ 10 % |
| question rate (real chat measured 3–4.4 %) | 2–10 % |
| emote rate | 25–50 % |
| unique bigram ratio | ≥ 0.60 |
| burst after a scene change | ≥ 2× baseline |
| first chat line after a mod action | ≤ 6 s |
| template repeats | ≤ 15 % |
| unsafe lines | 0 |
| persona leak | ≤ 3 % |
| junk | ≤ 5 % |
| emote-render failure | ≤ 5 % |
| speech echo | ≤ 10 % |

`docs/sample-chatlog-2026-10-28.jsonl` is a scored run of the current build.

**Real chat for comparison.** `tools/extract-real-chat.mjs` OCRs the burned-in
chat panel of a saved VOD into a timestamped corpus. It needs ffmpeg and
tesseract on `PATH`.

```sh
node tools/extract-real-chat.mjs --video videos/vod.mp4 --region W:H:X:Y
```

`score-chat.mjs --compare real.jsonl run.jsonl` diffs the two distributions.

In the page console, `__spasmDump()` returns the session log and
`__spasmDownload()` saves it as JSONL. `window.__spasmtv` holds live counters.

Code comments cite design sections from the project's working notes, which are
not part of this repo:

- §C: cadence
- §D: moderation culture
- §F: the rubric
- §G: real-chat comparison
- §H: the charset guard
- U-numbers: work units

## Known limits

- **Browsers.** Desktop needs Chrome or Edge with WebGPU and `shader-f16`, which
  any recent Apple Silicon or discrete GPU has. Desktop Safari and Firefox are
  untested.
- **The fast brain writes dumb chat.** That is the point. The 2B brains are there
  when you want sharper lines over speed.
- **The first lines after load can lag** a few seconds while the GPU warms up.
- **The charset guard strips some punctuation.** It forbids `-`, `~`, `*` and
  curly quotes, so `straight-eye-open` comes out `straight eye open`.

## License

The code is [MIT](LICENSE). The models are downloaded at runtime under their own
licenses (table above). Emote images belong to their creators and are served by
BTTV, FFZ and 7TV.
