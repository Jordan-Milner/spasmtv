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

## Steps

1. [ ] chat-sim.js: archetypes, persistent roster (localStorage), cosmetics
       renderer, weighted pickViewer. Verify: reload keeps the same regulars.
2. [ ] llm-worker.js: prompt v3 (reaction seed, no-caption-echo filter,
       reply-to single-line, ban-context prompt).
3. [ ] main.js: message-kind scheduler + bursty cadence + template lines
       (emote-only/chant/F/smash) + bits memory.
4. [ ] (D) culture state + mod-action reaction bursts + standing notes +
       entropy; mod-card history line; centering event (victim line + onlooker
       beat + relief on close).
5. [ ] (E) screen-share + file-drop sources + `?video=` param; route video/
       tab audio into the RMS gate.
6. [ ] tools/score-chat.mjs + videos/ corpus download.
7. [ ] Tuning loop: run each video + one ban session, score, iterate prompts
       and weights until rubric green; eyeball transcripts for vibe.
8. [ ] README (tuning-corpus section + new sources), PLAN.md ledger, commit.

Risks:
- Echo-loop regression (the v1.1 killer) — reply-to/ban prompts paste minimal
  text; bigram-uniqueness metric guards it in the rubric.
- Latency budget: kind scheduler ADDS load; emote/chant template lines are
  free, keeping net GPU calls near current rates.
- 450M ceiling: some kinds (parasocial warmth) may only shine on the 2B
  brain; rubric runs on the fast brain (the default) and we accept dumber
  warmth there.
