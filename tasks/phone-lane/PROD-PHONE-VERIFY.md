# PROD PHONE VERIFY — spasmtv runtime (deploy 5546988)

**Verdict: FAIL as specified — production phone mode itself WORKS.**

`--url-params 'phone'` omits `autolive`, and the deployed page only auto-clicks
start and mirrors `phase=/chat=/err=` into `document.title` under `?autolive`
(`js/main.js:849-857`). With `?phone` alone it never goes live and polls a title
with no counters. Harness-invocation gap, not a deploy bug.

## Run 1 — as specified (FAIL)

- Final poll: `… SpasmTV — an AI Twitch stream that watches you :: phone mode — small 256M brain, mic off`
- Final line: `wrote /tmp/prod-phone-run.jsonl: 0 events · SpasmTV — an AI Twitch stream that watches you`
- chat: **0** (need ≥5); `phase=` never present; **no error text** — `err=` never
  appeared (autolive title mirror off).
- ~180 MB HF download succeeded (profile → 163 MB): model fetch over the
  production origin works. Log: `/tmp/prod-phone-run.log`

## Run 2 — same command, `--url-params 'phone&autolive'` (PASS)

`… 32 events · LURKER phase=live chat=25 cap=7 asr=0 mf=0 lat=0.72 err= | cap:"The black background is a bit dark." | msg:"My heart went through you—he’s telling me my phone"`

chat=**25** kind="chat" events, `err=` empty, 0.72 s.
Log: `/tmp/prod-phone-run-autolive.log`

## Sample chat (run 2)

1. You’ve made your exit at for this video channel and I am looking…
2. You appear to be having an affair with the woman you’re posing for…
3. It's like this |.
4. I was thinking i would give up for some questions but am not sure…
5. This man says "CALIF”? “that’s not in this part…” He likes hamburgers
6. What was y’all up to at teh last video? writing one white mike sound…
7. Woah ah hey that was cute! -i really want to say again ...?
8. Be careful about your pre-registering on my videos and chats.

In-persona, no repeats, no error text — expected 256M quality; `asr=0` by design
(mic off on phones). Not checked: real iPhone / iOS jetsam (headless Chrome only).
