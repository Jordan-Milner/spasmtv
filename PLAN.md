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

- 2026-10-27: scaffolded; research agents A+B dispatched. Next: build worker on
  their return, then verify.
