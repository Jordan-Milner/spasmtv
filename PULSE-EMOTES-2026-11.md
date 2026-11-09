# Pulse — twitch-sim-emotes — progress

Item `twitch-sim-emotes` · pulse worker · started 2026-11-08 (late evening).
Prompt: `/Users/jordan/.pulse/prompts/twitch-sim-emotes.md`.
Goal: cut emote saturation to the real band (≤10% of lines carry an emote,
≤4% emote-only), measured with a 10-minute harness run, ship to master +
GitHub Pages.

## State of master when I picked it up

- HEAD `b20b1d7`, clean tree, up to date with origin/master.
- Commit `c612dff` (2026-11-02) already gated the prompt: `js/main.js`
  `sendChatMessage()` only puts `emotes` in the context for `kind === 'emote'`
  ("only an emote line is offered emotes"). The handoff listed this as uncommitted
  work; it has since been committed and pushed. So the *prompt-side* half of handoff
  item 1 is live; what is NOT measured is whether it actually moved the rate
  (the handoff deliberately did not tune blind).
- Remaining levers if the rate is still high: `KIND_WEIGHTS.emote = 18` in
  `js/cadence.js` (the template emote-kind share; handoff calls it "a third" of
  the saturation), `pileOnKind` (55% emote during pile-ons), and the worker
  prompt `[emote ok: …]` line.

## Background processes (stop by pid, never pkill by pattern)

Started before the naming addendum, so unnamed — pids recorded instead:
- serve (`npm run serve` → 127.0.0.1:8619): pid **83228** — kill when item closes
- baseline browser-run: pid **83294** — finished
Named per the addendum (both finished at their deadline):
- iteration-1 browser-run `pulse-twitch-sim-emotes-run`: pid **33049** — finished
- iteration-2 browser-run `pulse-twitch-sim-emotes-run2`: pid **42872** — finished

## Log

### 2026-11-08 — baseline

- `npm test` → 8 suites: modules ok (14 modules, imports + #ids resolve),
  text ok (893 assertions), cadence ok, culture ok, viewers ok, compare ok,
  omni-audio SKIP (needs /tmp/omni fixtures), audio-gate ok (33 assertions).
- Server: `nohup npm run serve` → 127.0.0.1:8619.
- Baseline run: `node tools/browser-run.mjs --out /tmp/pulse-emotes-before.jsonl
  --minutes 10 --url-params "autolive=1&video=videos/vod-fnf-work.mp4"` (the clip
  the earlier harness reports used).
- Score + `--compare` against `data/real/2026-10-28-round2-small.jsonl`.

### 2026-11-08 — baseline results

- rubric `npm run score -- /tmp/pulse-emotes-before.jsonl`: chat 253 · span 10.0 min.
  **emote rate 42.7% FAIL** (108/253; want ≤10%) · emote-only 1.6% PASS (4/253;
  want ≤4%) · sceneLinkage 7.7% FAIL-ish (8/104 frame-only model lines, want >8%)
  · 8 metrics failing, 4 unavailable (no mod actions, no speech lines, template
  repeat n<6, blind-linkage n=7).
- `--compare` vs data/real/2026-10-28-round2-small.jsonl: **17 metrics, 2 OFF**
  (% with emote 42.7 vs 7.7; % reply 13.8 vs 7.7 — pre-existing, untouched by
  this item).
- Breakdown (node /tmp/emote-breakdown.mjs): **template:emote n=109 (43% of all
  lines), 98 with codes (90% of the kind)** · model n=111, 9 coded (8%) · all
  other template kinds ≈0 coded. The prompt gating shipped in c612dff worked;
  the saturation is the scheduler's emote-kind machinery: KIND_WEIGHTS.emote 18,
  pileOnKind 0.55, chants 0.5/0.35, dress append 5%. This clip is change-dense:
  16 scene events, pile-on windows cover 20% of the span but carry 120/253 lines
  (67 of them emote-kind), 41 chant-ish lines.

### 2026-11-08 — the fix (all scheduler/template, no prompt change)

- `js/cadence.js`: KIND_WEIGHTS.emote 18 → **10**; templateLine('emote') coded
  split 85% → **12%** (bare 8% / stacked 2% / tag 2%), keysmash only on hype
  (13%), fills 75–88%; TEXT_FILLS 5 bare-biased strings → codeless pool (no
  bare f/F/W/lmao: the scorer's hint set reads those as emote-only and the ≤4%
  ceiling has no room); planBurst chant 0.5 → **0.08**; pileOnBurst chant
  0.35 → **0.03**; pileOnKind 0.55 → **0.75** (waves stay free-line-heavy for
  the gen budget — the wave's cheapness was always the point; the code rate was
  the bug).
- `js/chat-sim.js`: dress() emote append 5% → **2%** per archetype point.
- `js/main.js`: one stale comment ("a third of emote lines into keysmash").
- Tests FIRST: new pins in tools/test-cadence.mjs (coded share ≤20% — failed at
  85% before; chant rates; weight ≤12). Full suite: 8 ok + 1 skip, **921
  assertions** (was 893). Pile-on gen budget gate caught pk=0.70 (20.2 > 20
  gen/min), pk=0.75 lands 19.7/min — the budget is the binding constraint the
  emote share was silently servicing.

After-runs below (iteration 1 exposed a fill-wall regression, iteration 2 fixed
it by mining data/real/ for fill texture).

### 2026-11-08 — iteration 1 after-run (pid 33049, /tmp/pulse-emotes-after.jsonl)

- chat 275 · **emote 6.9% PASS** (was 42.7) · emote-only 1.5% PASS · sceneLinkage
  7.8% · burst 2.36×. But the fill wall: **repeat 36.4% FAIL** (want 2-9; real
  4.7) — 19 fill strings × ~80 fills/10 min = every string ≥5× — plus
  contagion echo amplifying the wall (echo lines 8→25) and % 1-2 word OFF
  (53.8, tol 10); ellipsis rose 1.2→3.6 (more text lines × the 4% ellipsis dress).

### 2026-11-08 — iteration 2: mined the corpus for fill texture

- TEXT_FILLS 19 → **26 strings, mined from data/real/** (most frequent 1-3 word
  PRIVMSG lines; one-room memes excluded — "aura"×194, "d3"×187 are that room's
  moment, not Twitch energy; loaded-code tokens like "kek"/"icant" excluded —
  they'd render as images). Kept only corpus-evidenced strings: noted/cap/aware/
  rt/huh/yep/yapping/mhm/cooked/sus/larp/npcing/holy/man joined gg/o7/nice/fr/
  real/classic/no way/based/true/wow/'F in the chat'/'gg wp'. Invented zero-
  evidence strings dropped ("insane","sheesh","big W","actual cinema","ok then"…).
- ellipsis dress 0.04 → 0.01 (real rooms ≈0.8%; fixes the iteration-1 regression).
- Tests: 935 assertions, 8 ok + 1 skip.

### 2026-11-08 — iteration 2 after-run (pid 42872, /tmp/pulse-emotes-after2.jsonl) — FINAL

- chat 232 · span 8.7 min (load slack ate more this run).
- **emote 6.9% PASS** (16/232; baseline 42.7; real rooms 3.3-5.7) ·
  **emote-only 2.6% PASS** (6/232; ≤4) · **repeat 5.2% PASS** (real 4.7 — MATCH)
  · ellipsis 0.0 PASS · sceneLinkage 10.6% PASS (was 7.7/7.8 — floor is 8) ·
  burst 2.27× PASS · emote-render fail 0 · unsafe/persona/junk 0 ·
  caption-echo 0 · one-line-user 56.6 PASS.
- `--compare` vs round2-small: **2 OFF — % names a chatter 17.7 and % reply 17.7**
  (real 9.1 / 7.7). Baseline read 13.8/13.8 (already failing both rubric bands);
  the rise is ~1.2pp denominator (same reply volume over 232 vs 253 lines) plus
  run swing (question swung 12.4→15.9 across runs too). Untouched by this item:
  threadSeed, fireThreadReply, KIND_WEIGHTS for reply. Pre-existing law mismatch,
  recorded for a future item — NOT tuned here: thread replies are the
  "chat talks to itself" texture the north star wants live; cutting the seed rate
  to chase the band on one noisy pair risks the live feel.
- Hairline FAILs vs rubric bands (all within run swing, baseline values in parens):
  one-word 36.6 (32; ceiling 36 — one line over) · ALL-CAPS 9.1 (6.3; floor 10 —
  moved toward the band, compare MATCHes real 5.1 tol 10) · exclamation 3.02 (1.2;
  n=7 vs n=3 — two lines of swing) · question 15.9 (13.4; pre-existing FAIL,
  compare MATCH).
- Iteration-1 fix worked as designed: model lines 3/118 coded (1.3% of kind —
  dress 2% + prompt gating), template:emote 12/76 (16% of kind vs pinned ≤20%).

### Verdict

Emote saturation is dead, measured twice: 42.7% → 6.9% of lines carry a rendered
emote (≤10 law, real rooms 3.3-5.7), emote-only baseline 1.6% → 2.6% (≤4), with
the free-line gen budget intact (pile-on sim 19.7 calls/min ≤ 20, wave 2.25× ≥2×).
The fix is scheduler/template land only — no prompt or model change: c612dff's
prompt gating was already holding model lines at ~8%; the emote-kind machinery
(weight 18, 85% coded template, chants, 5% dress) was the saturation. Shipped to
master; handoff in notes/HANDOFF-2026-11-08.md.
