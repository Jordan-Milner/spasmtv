# What makes Twitch chat, Twitch chat

Measured 2026-10-28, not guessed. Every number here comes from
`node tools/fingerprint.mjs --real 'data/real/*.jsonl' --sim '<run>.jsonl' --by-channel`
(full dump in `notes/fingerprint-2026-10-28.txt`), and every claim about our own
chat comes from the same tool run against a real `tools/browser-run.mjs` log.

## The corpus

`tools/collect-chat.mjs` reads **live public Twitch chat over anonymous IRC**
(`NICK justinfan*`, no token, no key, port 443) with the same tags the Twitch
client gets: emote ranges, badges, reply target, first-msg, user-id. Three
rounds, ~30 minutes wall clock, **9,269 lines from 10 rooms**, 6 of them with
enough volume to measure:

| room | lines/min | what it is |
|---|---|---|
| jynxzi | 347 | huge gaming/variety |
| lirik | 170 | big variety/gaming |
| hasanabi | 76 | big talk/politics |
| shroud | 24 | big channel, quiet moment |
| sykkuno | 17 | big channel, quiet moment |
| b0aty | 14 | genuinely small room (OSRS raid night) |

Known biases, stated so nobody has to rediscover them: one time-of-day (US
morning / EU afternoon), English only, **live chat only** (no VOD-era chat), no
raids happened during the window, no room under ~13 lines/min, and the two
"quiet" rooms are big channels having a quiet minute rather than permanently
small channels. The 13–24 lines/min band is the one our product lives in, and
b0aty is the only room that is small by nature rather than by moment.

## The table that matters

REAL is per-room. SIM is all three shipped brains (fast / phone / omni) of
`post4-*`, which run at ~23 lines/min — i.e. **our volume is already a small
room.** The mismatch is not speed. It is texture.

| metric | jynxzi | lirik | hasanabi | shroud | sykkuno | b0aty | **SIM** |
|---|---|---|---|---|---|---|---|
| lines/min | 347 | 170 | 76 | 24 | 17 | 14 | **23** |
| burst index (10 s) | 22.6 | 7.6 | 2.9 | 3.3 | 1.5 | 7.0 | 1.7 |
| chars median | 7 | 11 | 25 | 17 | 25 | 14 | **10** |
| one-word lines | 54% | 46% | 23% | 33% | 16% | 36% | 52% |
| **lines with an emote** | 3.8% | 9.4% | 7.6% | 5.7% | 9.1% | 3.3% | **47.8%** |
| emote-only lines | 3.5% | 5.8% | 3.6% | 2.1% | 3.5% | 0.5% | **36.8%** |
| ALL CAPS | 22% | 25% | 24% | 12% | 3% | 10% | 7% |
| ends with ? | 3.9% | 1.9% | 4.6% | 11% | 9.1% | 8.5% | 4.4% |
| one-line users | 47% | 37% | 66% | 52% | 42% | 55% | **0%** |
| reply lines | 0.4% | 2.9% | 14.1% | 5.7% | 7.7% | 7.5% | 3.3% |
| **names another chatter** | 0.8% | 2.9% | 10.9% | 3.9% | 6.5% | 6.1% | **0%** |
| copypasta (≥5×) | 46% | 30% | 9% | 8% | 2% | 7% | **26%** |
| notices/min (sub, milestone, mod) | 7.6 | 0.8 | 1.8 | 0.3 | 0 | 0.1 | **0** |
| moderation/min | 2.6 | 0 | 0.4 | 0 | 0 | 0.1 | 0 |

## What that says

**1. Emotes are seasoning, not sentences.** Not one room — not even a 347
lines/minute room — has emotes in more than **9.4%** of its lines. Ours: **48%**,
and **37% of our lines are nothing but an emote**, against a real range of
0.5–5.8%. Real emotes also *stack* (2.2 emotes per emote line, `Pred MONKA`,
`grappling hook Pog`) and they **decorate a sentence** rather than replace it.
The shipped rubric band for emote rate is 25–50%; that band is a fabrication and
it has been steering us away from real chat for weeks.

**2. A small room is a conversation, not a crowd of caption-readers.** In the
13–24 lines/min rooms, 6–8% of lines are replies and 4–11% name another chatter;
in b0aty and sykkuno the dominant shape is a *group deliberating together*:

> `ityler15: do you know if the whole team has to block every one of those veins?  or can just 1 person do it?`
> `outofstock_ (↩Orcsrox): @Orcsrox money`
> `Orcsrox: @outofstock_ okay ty`
> `Kunal_Sidd: You guys need to start hosting events in Paleto or something lol`

Ours: **0% replies to a named person, 0% naming another chatter.** Thirty
individuals narrate a screen at each other. That is the single biggest
difference in feel, and no prompt tweak fixes it — the cadence engine has to
*choose a previous line and a person* sometimes.

**3. The silent majority is the room.** 37–66% of the people who ever speak in a
real room say exactly one thing and never again; a real room cycles through
hundreds of names (jynxzi: 1,335 users in 14 minutes). We have 34 roster names
each producing ~13 lines. A room where everyone is a regular has no social
texture — there is nobody to be a newcomer to.

**4. Novelty is overrated; echo is the texture.** Real rooms repeat themselves
enormously — `lol` ×219, `aura` ×194, `67` ×120, `f` ×104 in 30 minutes — and
46% of jynxzi's lines are part of a line repeated ≥5 times. But the repeats are
*contagious in bursts*, not scheduled: someone says it, ten people say it, it
dies. Our `unique bigram ratio > 0.6` metric rewards the opposite of what real
chat does; our copypasta is template-driven and evenly spread (26% at small-room
volume, where real small rooms paste 2–9%).

**5. We over-punctuate a shouty medium.** `!` in 11.4% of our lines vs 1.4%
real; `…` in 4.2% vs 0.8%; ALL CAPS 7% vs 10–25%. We write *polite prose with
occasional emphasis*; real chat is mostly flat lowercase with rare, extreme
emphasis.

**6. The room has an economy we do not simulate.** 0.1–7.6 notices per minute:
subs, resubs ("They've subscribed for 29 months"), watch streaks, announcements,
and CLEARCHAT moderation (42 in this window). Real chat reacts to those. Our
chat has no sub, no mod, no VIP, no first-time chatter (0% vs 0.6%), and no
moderation event unless we script one.

**7. Lines are longer and stranger than we write them.** Small-room median is
14–25 characters with whole subordinate clauses, personal history, and typos:

> `demoeeeee: just coming back to my IM after  3 years, spamming TOA, 260. 3 Lightbearers in 120 Normal, 20 expert. I can do experts in 45 mins, and my 260s in 35. Should I just do expert? No fang or I would be doing expert.`

Our prompt says **"2 to 6 words"** — which produced 52% one-word lines. That
instruction was correct for jynxzi and wrong for the room we are actually
running.

## The laws, as rules

1. Emote in ≤10% of lines; emote-only in ≤4%; when present, 1–3 stacked, and usually attached to a sentence.
2. ~8% of lines reply to a specific earlier line, within ~10 s of it; ~6% name another chatter by handle.
3. ~50% of the people who ever speak say exactly one line; the roster needs a long tail of one-timers, not 34 regulars.
4. 20-lines/min means a 10-second burst index of 1.5–7, with real silences (median gap ~2 s), not a metronome.
5. Length: median ~15–25 characters, 16–36% one-word — not 52%.
6. Punctuation: `!` ≤3%, `…` ≤1%, ALL CAPS 10–25% *of lines that shout*, questions 4–11%.
7. Repetition is a spike with a half-life, not a rotation: a token enters the air, gets echoed by a decaying fraction of the next N lines, then dies.
8. Notices happen (sub, milestone, mod action) and the room reacts within seconds.
9. Mods/VIPs/subs exist and are visible; a mod's line carries weight.
10. The topic is shared: in a small room most lines are about the same thing at the same time, and they build on each other.

## What we still do not know

- What a **permanently tiny** room (5–40 viewers, 2–8 lines/min) looks like — the
  closest we got is b0aty at 13.6. That is the real bottom of our range.
- VOD-era chat (older slang, different emote set) and non-English rooms.
- Raid dynamics: none fired during the window, so the "raid = sudden 10× volume
  + `raid raid raid`" behaviour is still unmeasured folklore in our codebase.
- How long a bit lives in *wall-clock* terms: the sampler strides the files, so
  the contagion agent's timeline claims need a continuous capture to confirm.
