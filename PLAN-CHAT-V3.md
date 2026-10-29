# PLAN-CHAT-V3 — from "reads a screen" to "is a room"

Resume point after the 2026-10-28 release + the reaction/speed fix (`66266ac`).
Source of intent: `docs/twitch-chat-fingerprint.md` (the 10 laws, measured against
6 real rooms). This plan closes the laws that fix is *not* about.

## Where we are (post-`66266ac`, verified in a 3-min headless run)

> **STATUS 2026-10-29 — all 7 layers shipped.** Commits `b8ccf00`→`1b96cac`
> (L1 re-band scorer · L2 room talks to itself · L3 silent majority · L4 echo
> contagion · L5 room economy/subs · L6 voice/punctuation · L7 ship Omni +
> ellipsis fix). `npm test` green (892 assertions). Omni now a public brain;
> shape compare vs the real small-room corpus is 12/16 MATCH (OFF: emote OCR
> artifact, small-sample caps, run-to-run cadence variance). See
> `notes/HANDOFF-2026-10-29.md` for the resume point and open questions.
- Latency 0.25–0.29 s; every visual line now sees the live frame. **Laws about
  seeing the screen are done.**
- Emote rate 48.8%, caption-echo 0%, unsafe/persona/junk 0%.
- The scorer's emote band (25–50%) is a **fabrication** the fingerprint doc
  disproved (real: ≤10% lines carry an emote, ≤4% emote-only). It is currently
  *rewarding the wrong thing*.

## The gap, in one line
We are a crowd of 34 people narrating a screen at each other. A real small room
is a **conversation**: people reply to and name each other, half the speakers are
one-timers, the room echoes a token in a decaying burst, and it reacts to
subs/mods. That social texture is the next layer — and the fingerprint doc is
explicit that **no prompt tweak fixes it; the cadence engine has to choose a
previous line and a person.**

---

## Layer 1 — make the yardstick honest (do first, ~1 h, low risk)
The scorer is the thing steering us. Fix it before optimizing against it.
- **Re-band `tools/score-chat.mjs` to the measured laws**, not the old guesses:
  - emote rate `0.25–0.50` → **`≤0.10`**; add **emote-only `≤0.04`**.
  - one-word lines → band **`0.16–0.36`** (we're at 52%).
  - add metrics the doc measures but the scorer lacks: **one-line-user %**
    (target 0.37–0.66), **names-another-chatter %** (0.04–0.11), **ALL-CAPS %**
    (0.10–0.25), **median chars** (15–25), **`!` ≤0.03 / `…` ≤0.01**.
  - `unique bigram ratio > 0.6` **rewards the opposite of real chat** (law 4:
    echo is the texture). Demote it to informational or invert it.
- Add a `test-text`/`score` self-case so the new bands can't silently regress.
- **Gate:** every later layer is measured by this scorer, so it lands first.

## Layer 2 — the room talks to itself (the headline, ~1 day, medium risk)
Laws 2, 3, 10 — the single biggest felt difference (0% → real 6–8% replies,
0% → 4–11% naming).
- **Conversation thread in the scheduler** (`js/cadence.js` + `js/main.js`):
  sometimes pick a *recent line + its author* and make the next line a reply/
  quote to *that person*, within ~10 s. The `replyTo` plumbing + `@name` prefix
  already exist (`main.js` onWorkerMessage) — this makes the engine *choose* it
  at the measured rate instead of only on user messages.
- **Name-another-chatter** without a formal reply: a line that @-mentions or
  addresses someone present (~6%). Reuse the roster + `pickRecent`.
- **Shared topic / build-on (law 10):** bias consecutive visual lines toward the
  current caption's subject so the room is "about the same thing at once."
- **Gate:** scorer one-line/names/reply bands move into range; read the transcript
  (metrics have missed leaks before — HANDOFF rule).

## Layer 3 — the silent majority + a long tail (~half day, low risk)
Law 3 — 37–66% of speakers say exactly one line; we have 34 permanent regulars.
- The `DRIVE_BY_P = 0.22` transient viewer is the seed. **Raise the one-timer
  share and widen the name pool** so distinct-speaker count climbs toward real
  (b0aty: 92 users in ~15 min) and one-line-user % lands in band.
- Keep a small core of true regulars (the roster) so callbacks still land.
- **Gate:** scorer one-line-user % and distinct-speaker/min.

## Layer 4 — echo, not rotation (~half day, medium risk)
Law 4/7 — a token enters the air, a decaying fraction of the next N lines echo
it, then it dies. Our copypasta is template-driven and evenly spread.
- **Contagion agent:** when a line lands, with decaying probability the next few
  lines reuse its token/phrase (the `bit` system is a heavyweight version —
  generalize it to short tokens like `lol`, `67`, `aura`).
- Retire the `unique bigram` reward (Layer 1) so this isn't fought by the metric.
- **Gate:** copypasta/repeat % in the small-room band (2–9%), burst-shaped not
  uniform.

## Layer 5 — the room has an economy (~half day, medium risk)
Laws 8, 9 — 0.1–7.6 notices/min (subs, resubs, milestones, mod actions) and the
room reacts within seconds; mods/VIPs/subs are visible and carry weight.
- **Synthesize notices** on a timer (sub/resub-with-tenure, watch-streak, a
  periodic mod action) and feed them as a reaction trigger (like `ban` today).
- **Badge/role weight:** mods/VIPs/subs render a badge; a mod line gets cadence
  weight. The `ban`/`banreact` path already exists — generalize to notices.
- **Gate:** notices/min > 0 and a ban/sub-reaction latency metric.

## Layer 6 — voice: length, caps, punctuation (~2 h, low risk, prompt-only)
Laws 5, 6 — small-room median is 15–25 chars with clauses; we say "2 to 6 words"
→ 52% one-word, and we over-punctuate (`!` 11% vs 1.4%).
- **Length is source-tuned, not just a prompt string:** the real trimmer is
  `maxNewTokens` (def 12) + `maxWords` (def 8) in `js/tuning.js`; the "2 to 6
  words" line in `llm-worker.js` is cosmetic. Retune both to the small-room
  median and soften the prompt.
- **This also kills the mid-sentence truncation** ("because I didn…") flagged in
  the last run — a slightly higher `maxNewTokens` lets short lines finish.
- Punctuation: drop `!`/`…` generation, raise ALL-CAPS on shout lines.
- **Gate:** scorer median-chars, one-word, `!`, `…`, caps bands.

## Layer 7 — ship the best brain (small, gated on evidence)
HANDOFF step 2: Jordan regards **Omni** as the best brain (OMNI-REPORT: most
Twitch-like, grounded, 1.07 s/line) but it's still `EXPERIMENTAL` in
`js/main.js:1383` and absent from the `index.html` picker.
- If an Omni run passes the (corrected) rubric: add the `<option>`, drop it from
  `EXPERIMENTAL`, update README brains table + `?brain=` row, note the charset
  guard doesn't apply to Omni (its own sampler; `keep()` still filters).
- **Open question to Jordan (carried from HANDOFF):** should phones/iPads pick a
  2B brain behind a "may crash this tab" warning? Currently pinned to SmolVLM-256M.

---

## Sequencing & risk
1 → 2 → 3 → 4 → 5 → 6 → 7. Layer 1 first (it's the yardstick). Layers 2–5 are the
"become a room" core and touch the scheduler — keep one writer, re-run
`npm test` + a headless `browser-run` + `score-chat` after each, and **read the
transcript** (the metrics have missed leaks before). Each new leak shape gets a
`test-text.mjs` case.

## What we still don't know (from the doc — don't fake these)
- A permanently tiny room (5–40 viewers, 2–8 lines/min) — closest sample is
  b0aty at 13.6. Our bottom of range is unmeasured.
- VOD-era chat, non-English rooms, live raid dynamics (no raid fired in the
  window — "raid = 10× volume + `raid raid raid`" is still folklore in our code).
- Bit half-life in wall-clock terms needs a continuous capture to confirm.
