# PLAN — twitch-sim (LurkerTV)

AI Twitch stream simulator: LiquidAI vision model (WebGPU, in-browser) watches
the user's webcam and generates the Twitch chat reacting to them. Mic audio is
transcribed locally (Whisper-class, WebGPU) so chat can react to speech too.
100% client-side; models fetched from HF CDN; no backend of any kind.

## Architecture

```
index.html            layout: stream stage (video + overlays + captions) | chat panel
css/style.css         Twitch-dark theme
js/main.js            orchestration: camera/demo feed, frame capture + diff,
                      scheduling loop, worker client, captions, chat form
js/chat-sim.js        fake-viewer roster (names/colors), chat DOM rendering,
                      viewer-count drift, hype bursts. No model logic.
workers/llm-worker.js transformers.js: VLM (caption + chat messages) + ASR,
                      one WebGPU worker, internal promise queue
serve.sh              named static server (ps: twitch-sim-server) — needed only
                      because WebGPU requires a secure (http://localhost) context
```

**Worker protocol** (single worker, queued):

```
→ {type:'load', model:'fast'|'quality'}          ← {type:'progress'…} {type:'ready'} {type:'error'}
→ {type:'caption', id, image:{data,width,height}, }  ← {type:'caption', id, text}
→ {type:'chat', id, context:{scene, speech, sceneChange, userMsg, history[]}}
                                                 ← {type:'chat', id, messages:[…]}
→ {type:'transcribe', id, pcm:Float32Array}      ← {type:'transcribe', id, text}
```

## Steps

1. [x] Recon (no project collision; node 22 / python 3.14 present)
2. [ ] Research A: LiquidAI WebGPU VLM — repo IDs, runtime code, license
3. [ ] Research B: WebGPU ASR + RawImage/capture recipes + fake-media test flags
4. [x] Scaffold: repo, UI shell, chat-sim module, serve.sh
5. [ ] Build llm-worker.js (VLM caption + chat generation, exact HF IDs from A)
6. [ ] Build audio path (mic → 16k Float32 → silence-gated chunks → ASR) from B
7. [ ] Wire main.js loops to worker; tune cadence + prompts
8. [ ] Verify in browser (fake-media Chrome or demo mode): models load, chat
       messages appear reacting to the feed, mic transcript shows, no console errors
9. [ ] README + manifest.yaml row + ./proj check + commit

## Product decisions made (Jordan was away — flag anything to revisit)

- One model does caption AND chat messages (per-message generate calls, temp ~1.0,
  max ~28 new tokens) rather than VLM→separate text model; keeps memory ~one model.
- "fast" = smallest VL model (default), "quality" = 1.6B option in the dropdown.
- Chat reacts via context: latest scene caption (refreshed ~8 s or on scene change),
  last ~300 chars of transcribed speech, recent chat lines (dedupe pressure),
  anything the user types into the chat box (they can talk to their own chat).
- Demo mode (no camera) = canvas-generated animated "stream", so anyone can try
  it without granting permissions; also our automated-test path.
- Names/colors/emotes are client-side cosmetics; the model only writes message text.

## Ledger

- 2026-10-27: scaffolded; research A+B returned; worker built on verified IDs
  (LFM2.5-VL-450M-ONNX fast / LFM3-VL-2B-ONNX sharp; moonshine-tiny ASR;
  transformers.js 4.3.2). End-to-end verified in a fake-media Chrome: model
  load, captions, chat generation, ASR round-trips all green.
- Live bugfixes from verification: `[hidden]` CSS override left the offline
  cover over the video; ASR progress bar race after going live; persona-echo
  + degeneration loops (Jordan's live session was the evidence) → v1.1 worker
  (instruction-style personas, no recent-echo in prompt, Jaccard dedupe, hotter
  retry), question/MVP badges, mod view (yell + timeouts), real emotes
  (BTTV/FFZ/7TV), widescreen/mobile layout, chat log with generation context
  (`docs/sample-chatlog-2026-10-27.json`).
- Serving: localhost :8619 (named `twitch-sim-server`) + tailnet
  https://jordans-maxbook.tail38dbd0.ts.net/ via `tailscale serve --bg 8619`.
- 2026-10-27/28: SpasmTV rename (was LurkerTV). Settings panel: vision detail
  (512/640/768), motion focus crop, varied viewer views, ASR model (tiny/base,
  hot-swappable), per-machine latency readout. Mod card v2 (Twitch usercard
  style, draggable, fake stats, warn + 1s/1w/custom timeouts + permanent ban).
  Chat memory: ASR fact extraction → localStorage facts → chat context.
  Deployed: github.com/Jordan-Milner/spasmtv → Pages (master, root, CNAME
  spasm.milner.zone set via API). DNS CNAME = manual Jordan step (no CF creds
  on the machine; ask logged).
- **Processor constraints learned the hard way** (all verified via a live bisect
  matrix): LFM2.5-VL processor has NO null-image mode and treats image arrays
  as batch — every generate call must pass exactly one image whose
  `<image>` template slot matches (else "tokens 0, features N"). NaFlex encoder
  resizes any input to a fixed grid (256 features @512²) regardless of input
  size. Text-only VLM chat = blank-image stand-in with its image slot.
  Multi-frame before/after is NOT servable on either ONNX family today
  (LFM3-VL-2B is video-native but transformers.js path is single-image);
  varied single views (motion crop vs wide) is the shipped substitute.
- Open / next candidates: Funnel if Alaina is off-tailnet; true multi-frame
  serving (ORT webgpu graphs or a batch-capable export) for real motion memory;
  InterruptableStoppingCriteria for stale caption jobs.
- 2026-10-28: mobile. (a) phone layout: topbar controls wrapped to their own
  row (a `<select>` never shrinks below its longest option — that pushed Go
  live/⚙ off-screen), body → flex column (no calc(100%-50px)), 100dvh,
  settings popover → full-width sheet, 16px inputs (iOS focus-zoom guard).
  (b) iPhone crash: Safari jetsams the tab at model load — fp16 vision encoder
  (~400 MB) + transient fetch copy puts peak RSS over the ~1–1.5 GB
  WebContent limit; uncatchable reload, retry can wedge the tab. Phone mode
  replaces the hard gate: `phone:true` on the load msg → worker forces the
  450M brain with vision_encoder **q8** (repo ships q4/q8 encoders — verified
  via HF API file list); UI pins brain to fast + mic (ASR) off; `?phone`
  previews the mode on desktop. If the tab still reloads during load, that
  phone can't hold even q8 — no catchable error exists for a jetsam kill.
- 2026-10-28: **active plan is `PLAN-CHAT-V2.md`** ("the regulars": archetype
  roster, anti-echo prompt v3, kind scheduler, moderation-tuned culture, video
  sources, `tools/score-chat.mjs` rubric). Its 6 buildable steps are Hub cards
  (project slug `twitch-sim`, Lane Specced, Repo `~/Projects/twitch-sim`) so the
  autonomous fleet picks them up; the tuning loop stays a human card because it
  needs eyes on transcripts.
