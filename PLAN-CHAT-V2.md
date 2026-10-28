# PLAN — Chat v2: "the regulars" (personality, moderation-tuned culture, video sources)

Goal: make the chat feel like a living community — recognizable regulars with
personalities, social physics around moderation (culture tunes itself based on
who the streamer bans), and the ability to run YouTube videos through the whole
pipeline as stream content + tuning corpus.

Evidence base: `docs/sample-chatlog-2026-10-27.json` (160 events, fake-camera
session) — diagnosis below cites it. Invariants from NORTH-STAR.md hold: zero
backend, one generate call per message, nothing leaves the browser, Twitch
energy not chatbot energy.

## Diagnosis (from the sample log)

1. **Caption-paraphrase disease** — the dominant failure. >60% of chat lines
   are near-copies of the scene caption ("green background with white letter
   D" ×40). Cause: `The stream right now: ${scene}` anchors the 450M; its
   prior for "describe image" swamps the persona instruction.
2. **Question inflation** — 3/9 personas ask questions + the MVP mechanic
   rewards questions → chat is an interrogation, not a crowd.
3. **No persistence** — personas rotate round-robin across random viewers;
   nobody is recognizable, no regulars, no relationships.
4. **No social physics** — bans/yells/warnings produce one system line; the
   crowd never reacts, never adapts, never changes mood.
5. **Metronome cadence** — exactly 1 msg / 2.3 s; real chat is bursty
   (droughts, pile-ons, spam walls).
6. **No video source** — camera or demo canvas only; can't run YouTube
   content through it.

## Design

### A. Archetypes — persistent viewer personalities (chat-sim.js)

Roster entries get a stable archetype (weighted like a real chat) plus quirks:

| archetype | weight | shape |
|---|---|---|
| hype-man | 3 | caps, !!!, POGGERS, piles onto hype bursts |
| backseat | 2 | advice, "no no go LEFT", timestamps |
| lurker | 4 | rare 1-word/emote-only lines |
| regular | 3 | treats scene like a running joke, "every stream" |
| earnest | 2 | genuine questions (existing ❓/MVP flow) |
| doomer | 2 | ironic defeat, "this is who i am now" |
| parasocial | 2 | talks to streamer like a friend, uses facts memory |
| troll | 2 | skates the line — **ban bait**; gives mods work |
| newcomer | 1 | "first time here", asks what's going on |
| copypasta | 1 | occasionally pastes a classic |

- Archetype → `personaHint` (instruction-phrased, per the v1.1 lesson) +
  client-side cosmetics: case style, ellipsis habit, typo rate, emote affinity,
  message-frequency weight. Model writes text; quirks render client-side.
- **Roster persists in localStorage** (seeded names+archetypes) so regulars
  survive reloads across sessions.
- Message frequency weighted by archetype (regulars dominate, lurkers rare) —
  real chat voice distribution.

### B. Prompt v3 — reaction-first, anti-echo (llm-worker.js)

- Replace caption-as-anchor with a short **reaction seed**: caption compressed
  to a few keywords; explicit "react — never describe what's visible, never
  mention colors/backgrounds/letters unless it's a joke".
- Post-gen filter extended: reject lines too similar to the caption itself
  (Jaccard vs `ctx.scene` tokens), not just to prior messages.
- **Reply-to without the echo loop**: a "reply" message kind passes exactly
  ONE recent line + author name (the v1.1 lesson banned pasting the recent
  window; one line with a reply instruction is a different shape — verified
  against degeneration in the tuning loop).
- Non-visual kinds (greeting, meta, banter) send no scene at all.

### C. Message-kind scheduler + bursty cadence (main.js)

- Per tick, pick a kind by weights (modulated by state):
  reaction ~50% · banter/reply ~12% · emote-only ~10% · question ~10% ·
  backseat ~8% · meta/greeting ~5% · bit/callback ~5%. Scene-change bursts
  force reactions; post-ban forces C(D).
- **Emote-only + chant lines are template-generated client-side** (no GPU
  call): "F", single emote, keyboard smash on hype, and a chant = 3+ viewers
  repeating one emote within a burst. Cheaper AND more real.
- Bursty Poisson-ish cadence: base rate per-archetype, occasional droughts
  (4–8 s) and flurries (3 lines in 1.5 s) instead of the 2.3 s metronome.
- **Bits (in-jokes)**: when a line lands during a hype peak, small chance it
  becomes a bit; resurfaces as "callback" kind occasionally for ~10 min.
  Rare + deduped (echo-loop lesson).

### D. Moderation-tuned culture — "tune it based on who they're banning"

The headline. Culture state (`sim.culture`) driven entirely by mod actions:

- **Every mod action** (yell/warn/timeout/ban) records the victim + their last
  ≤3 messages → pattern extraction (crude: dominant tokens of banned speech).
- **Reaction burst** within ~5 s: 2–4 messages, faction-based — mourners
  ("F", "rip", "he was funny tho"), bootlickers ("mods doing god's work"),
  critics ("free X", "mods on one", "what did he even do"), chosen by the
  reactor's archetype (trolls defend trolls, parasocials side with streamer).
  Mix: template one-liners (instant, no GPU) + 1 model-generated line with a
  "X was just banned; their last message was Y — react" prompt.
- **Standing culture note** (~5 min): "chat rule lately (mods ban for it):
  <pattern>" injected into reaction prompts → most archetypes comply; troll
  archetype has defiance probability → repeat offenders emerge naturally =
  the mod has real work. **Entropy without moderation**: troll spawn weight
  rises slowly when no mod action has happened for a while — the community
  needs its mod. That's the tuning loop: who you ban shapes who chat becomes.
- **Mood drift**: ban-heavy stretch → chat quieter + resentful ("chat so dead
  since the purge"); returning prisoners split grudge/reformed by ban length.
- Mod card shows "last action taken" history per viewer (thin-ice badge
  already exists).
- **Centering** (opening the mod card on someone): the crowd notices —
  2–3 onlooker lines ("mods looking at X", "X is COOKED", "what did he do")
  and the **centered viewer is guaranteed one line while on the spot**,
  persona-aware: troll doubles down, earnest panics innocence, warned viewer
  "i'm behaving i'm behaving", parasocial pleads. Card closed with no action
  → relief beat ("false alarm", "mods were just admiring his profile").
  Centering-without-action also raises culture tension (D's entropy feed).

### E. Video sources — run YouTube through it (main.js + index.html)

- **Share screen/tab** (`getDisplayMedia({video, audio:true})`): play YouTube
  in the shared tab → chat sees the video AND hears it (tab audio into the
  existing RMS gate → ASR → speech context). Zero setup, the magic demo path.
- **Video file drop / picker**: drag an .mp4/.webm onto the stage (or file
  input) → `<video>` element → same capture path; element audio routed into
  the gate. For yt-dlp'd videos.
- `?video=<served-path>&autolive` URL params: autoplay a file through the full
  pipeline unattended — the automated tuning harness input.
- User-supplied media only; no YouTube API, no backend — invariants intact.
  Phone mode: file video works, screen share audio→ASR stays desktop-only.

### F. Log + rubric — the tuning loop

- Log entries gain: archetype, kind, ban-event linkage (`kind:'banreact'`).
- `tools/score-chat.mjs` (node, no deps) scoring a `__lurkerDownload()` jsonl:
  - caption-echo rate: Jaccard(msg, caption) > 0.5 → **< 10%** of model lines
  - question rate: **10–25%** · emote rate: **25–50%** contain a real code
  - unique bigram ratio across session: **> 0.6**
  - burst correlation: chat-rate in the 10 s after a scene change ≥ 2× baseline
  - ban-reaction latency: first reaction **< 6 s** after a mod action
- Corpus: 3 yt-dlp'd videos (360p, ~3 min each; e.g. a gaming clip, a
  just-chatting/vlog segment, a video-essay/music segment) in `videos/`
  (gitignored). One manual-ban scripted run to exercise (D).

### G. Real-chat ground truth — VODs with chat, run through the same content

Top rung of the tuning ladder (the §F rubric numbers are only priors; real
Twitch chat is the target distribution).

1. yt-dlp 2–3 YouTube videos that show a Twitch VOD **with the chat overlay
   visible** (compilations, VOD uploads) → `videos/`, gitignored.
2. `tools/extract-real-chat.mjs`: ffmpeg crops the chat panel and samples it
   ~2 fps → tesseract OCR (installed, `/opt/homebrew/bin`) → dedupe lines
   across frames → `videos/<name>.realchat.jsonl` with timestamps.
3. Play the **same video** through the sim (`?video=` from §E) → sim log.
4. `tools/score-chat.mjs --compare real.jsonl sim.jsonl`: side-by-side
   distribution diff — length histogram, % emote-only, % with emote, %
   question, % all-caps, % 1–2 words, top-emote overlap, burstiness
   (coefficient of variation over 5 s buckets), msgs/viewer/min. Tune prompt
   + weights until the sim's SHAPE sits inside the real distribution
   (absolute rate is viewer-count-scaled by design; shape is the target).

### H. Brain upgrades on the same WebGPU runtime (research 2026-10-28)

Full research + sources: `docs/RESEARCH-CHAT-WEBGPU.md`. Runtime verdict:
stay on transformers.js 4.3.2 (latest; WebLLM has no VLM path, so models +
decoding + data are the only levers).

- **U7 — third quality brain: Qwen3-VL-2B** (onnx-community ONNX, q4f16
  ≈1.38 GB, **Apache-2.0** — which also re-opens the fine-tune-and-rehost
  path the LFM licenses close). Benchmarks put it ahead of same-size peers;
  our scorer is the arbiter. Unit: `tasks/U7-qwen3vl-quality-brain.md`.
- **U8 — grammar guard**: `@huggingface/transformers-structured-output`
  (dep-free regex/JSON-schema logits processor; chat gen is already
  single-sequence) makes emoji/hashtag/caps/prompt-leak debris unsampleable
  at the source → fewer rejected retries per kept line. Keysmash filter
  stays (charset-legal). Unit: `tasks/U8-grammar-guard.md`.
- **Sampling reality** (verified in the pinned 4.3.2 bundle): min_p is NOT
  implemented (its only strings are `min_pixels`); num_return_sequences is
  unreliable — temperature/top_p/top_k/repetition_penalty/typical_p/
  no_repeat_ngram + sequential retry are what we have. `no_repeat_ngram`
  is the untested one worth an A/B against echo loops.
- **Parked, bigger levers** (Needs Jordan below): split-brain (450M VLM
  captions + Qwen3-1.7B-ONNX writes chat; desktop-only tier, +~1 GB) and
  SFT/LoRA on real chat corpora (TwitchChat AIIDE 2020, TTS-AGI/twitch,
  our §G OCR corpus → merge → ONNX q4 → HF-host; needs a license-clean
  base model, i.e. U7's Qwen).
- Phone later: 4.1.0 added q1/q1f16/q2/q2f16 dtypes — lighter vision
  encoders if iOS still jetsams; quality must be re-checked.

## Steps

One line each, because the lane supervisor reads this file as the backlog; the
long form of every step is the section it names.

- [x] chat-sim.js (§A) — stable weighted archetype per roster entry from the §A table, roster persisted in localStorage so regulars survive reloads, per-archetype cosmetics rendered client-side (case style, ellipsis, typo rate, emote affinity) with message-frequency weights, plus the instruction-phrased personaHint handed to the worker. Verify: reload twice, the same viewer names keep the same archetypes.
- [x] workers/llm-worker.js (§B) — prompt v3: reaction seed instead of the caption anchor, an explicit react-don't-describe instruction, post-gen rejection of any line whose token Jaccard vs `ctx.scene` is over 0.5, a reply-to kind carrying exactly one recent line plus its author, non-visual kinds sent with the blank-image stand-in (the processor has no null-image mode — see PLAN.md).
- [x] js/main.js (§C) — verified: node budget test (18.9 lines/min, 14.9 gen/min, both ≤ 20) + live headless run; committed 598c94d.
- [x] js/main.js + js/chat-sim.js (§D) — verified live: scripted ban → first reaction 856ms (run1) / 698ms (run3), 6 lines < 6 s, spot/banreact/relief kinds all firing; committed 598c94d.
- [x] js/main.js + index.html (§E) — DONE 6b48b28 (headless ?video= run live; ASR-from-video + drag/share need a manual look, see tasks/E1-REPORT.md). video sources: `getDisplayMedia` screen/tab share with audio, drag-drop or file-picker video on the stage, both through the existing frame capture and both routed into the existing RMS gate so ASR gets speech; `?video=PATH&autolive` autoplays a file through the whole pipeline.
- [x] tools/extract-real-chat.mjs + --compare — built (desk lane + integration fixes: streams[0] parse, crop= prefix, FFPEG typo, gray+negate chain, OCR noise gate), self-test green, smoked on real VOD probes. FNF VOD chat panel region: `--region 300:500:980:220` (OCR reads usernames cleanly); phantom VOD = right-30% default, hard mode.
- [x] tools/score-chat.mjs (§F) — seven metrics now (added template-repeat), exit codes, `videos/` gitignored. Run4 rubric GREEN on the demo feed: echo 0%, questions 20.5%, emote 25%, bigrams 95.8%.
- [x] (A/B done 2026-10-28, 1.5 min each on vod-fnf-work: Qwen3-VL-2B loads with textFirst and is best grounded at 0.48 s/line; LFM2.5-VL-3B loads but 1.45 s/line for similar quality; LFM3-VL-2B 0.28 s/line. Pick via dropdown or ?brain=qwen|lfm3b|quality.) workers/llm-worker.js + js/main.js (§H/U7) — add onnx-community/Qwen3-VL-2B-Instruct-ONNX (q4f16) as a selectable third brain and A/B it against LFM3-VL-2B on the same video through the scorer; a verbatim load failure is a valid result. Unit: tasks/U7-qwen3vl-quality-brain.md. Verify: both brains reach ready headless (or the error is captured); score table in the report.
- [x] workers/llm-worker.js + js/main.js (§H/U8) — StructuredOutputProcessor regex guard on the chat path only, kill switch via ?grammar=0, phone always off; measure retries vs guard-off on the same content. Unit: tasks/U8-grammar-guard.md. Verify: DONE — guard-on 0/48 model lines outside the charset, 1.19 vs 1.29 GPU calls per kept line, no score regression; tasks/U8-REPORT.md. NOTE the spec's CDN import shape is CJS (see report). Branch feat/grammar-guard.
- [ ] README — tuning-corpus section and the new sources; append the PLAN.md ledger line; commit by path.

## Needs Jordan

- [ ] Final vibe check: once the paired runs land, read one sim transcript next to
      its real VOD chat — scoring green while being boring is the failure only an
      eyeball catches. Everything else is agent-reachable.
- [ ] Hub cards for §H/U7+U8 (2026-10-28): the researching session had no
      Coda MCP, so the two units exist as files + plan lines but not as Hub
      cards — seed them like the six chat-v2 cards (project `twitch-sim`,
      Lane Specced, repo `~/Projects/twitch-sim`) or run them from the plan
      backlog directly.
- [ ] Fine-tune go/no-go (§H): after U7's verdict — SFT/LoRA on real chat
      corpora with a license-clean base (the Qwen brain), training on his
      Mac or the fleet. His call on the time budget.

Risks:
- Echo-loop regression (the v1.1 killer) — reply-to/ban prompts paste minimal
  text; bigram-uniqueness metric guards it in the rubric.
- Latency budget: kind scheduler ADDS load; emote/chant template lines are
  free, keeping net GPU calls near current rates.
- 450M ceiling: some kinds (parasocial warmth) may only shine on the 2B
  brain; rubric runs on the fast brain (the default) and we accept dumber
  warmth there.
