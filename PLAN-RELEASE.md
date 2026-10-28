# PLAN-RELEASE — make SpasmTV "done" as a public repo + live site

Review of `master` @ `ca174f8` (2026-10-28). The repo `Jordan-Milner/spasmtv` is
**already public** and GitHub Pages serves the **whole repo root** at
https://spasm.milner.zone — every tracked file is on the live site
(`/PLAN.md`, `/tasks/handoff-2026-10-28.json` both return 200).

Findings are grouped by what blocks "done". Each has the evidence that
established it. Decisions only Jordan can make are marked **[decide]**.

---

## A. Public-facing blockers

**A1. The privacy claim is wrong as written.** README + the offline cover say
"nothing is uploaded… the only network traffic is a one-time model download from
Hugging Face." Actual third-party traffic on every load: jsDelivr (transformers.js
4.3.2, onnxruntime-web 1.31.1 — statically imported even if Omni is never picked —
and the structured-output bundle), Hugging Face, and BTTV / FFZ / 7TV (set APIs at
boot + an image hotlink per emote per chat line). The claim that matters — camera,
mic and screen never leave the browser — *is* true (no fetch/XHR/WebSocket carries
frames or PCM). Fix: say exactly that, and list the CDNs.

**A2. Speech transcripts are silently persisted.** `js/main.js` mirrors the last
400 log events to `localStorage['lurker-log']` — ASR text, the streamer's typed
messages, extracted facts, scene captions — and restores them on reload. Nothing in
the UI says so, and "forget everything" clears `spasmtv-facts` only. Fix: log is
in-memory by default (persist only with `?log=1`), and "forget everything" clears
log + facts + roster + tuning.

**A3. Internal ops material is public and served.** `PLAN.md` (tailnet hostname,
a friend's first name, "Needs Jordan"), `PLAN-CHAT-V2.md`, `tasks/*.md`,
`tasks/handoff-2026-10-28.json` (absolute `/Users/jordan/...` paths, fleet card
manifests), `tasks/D1-REPORT.md` (real Twitch viewers' usernames + messages OCR'd
off a streamer's VOD), and README's tailnet URL + `tailscale funnel` instructions. Fix: move
`PLAN*.md` and `tasks/` out of the public tree (see **[decide] D2**), rewrite README
for an outsider. `docs/RESEARCH-CHAT-WEBGPU.md` is good public content — keep it,
strip the "Jordan" asides. The ts.net hostname is already in public Certificate
Transparency logs (Tailscale HTTPS certs are publicly logged), so rewriting history
for it buys nothing.

**A4. No LICENSE** → legally all-rights-reserved; nobody can fork or reuse it.
**[decide] D1** (recommend MIT). README must also say the *models* carry their own
terms: LiquidAI brains are `lfm1.0` (LFM Open License, not OSI), Qwen3-VL Apache-2.0,
SmolVLM Apache-2.0, Moonshine MIT (all verified via the HF API today).

**A5. No content-safety net on a camera-pointed-at-a-real-person app.** There is no
word/topic filter on model output. The `troll` archetype is told to "skate the line,
say something just barely dumb enough to draw a mod". The emote hint list the model
is steered toward currently includes `TwaT` and `Gayge` (live BTTV/7TV global sets,
checked today). The phone brain on prod wrote "You appear to be having an affair
with the woman you're posing for…" (`twitch-sim-phone-fix/tasks/PROD-PHONE-VERIFY.md`).
Fix: a `SAFETY` reject list in `keep()` (slurs, sexual content, body/appearance
insults, self-harm phrasing) + the same list filtering `emoteHintFrom` and rendered
emote codes; reword the troll hint to "dumb takes", not "the line".

**A6. Twitch affiliation.** Title says "an AI Twitch stream"; the mod card copies
Twitch's usercard. Add "not affiliated with Twitch" to the README and the offline
cover. **[decide] D4** the name: "SpasmTV" is fine in the US; in the UK "spaz" is a
disability slur and "spasm" reads adjacent — flagging it, your call.

## B. Correctness bugs (each verified)

**B1. Settings are never restored.** `saveSettings()` writes `spasmtv-settings`
but nothing reads it. Verified in the browser: set detail 768 / ASR tiny → reload →
UI shows 512 / base (localStorage still holds 768/tiny); the next change then
overwrites the saved values with defaults.

**B2. Switching brains leaks GPU memory.** `load()` in `workers/llm-worker.js`
reassigns `model`/`processor` without `dispose()`, and never tears down Omni's ORT
sessions. Stop → pick Qwen → go live keeps the old brain resident on the GPU.

**B3. Omni's runtime is a hard dependency of every brain.** `llm-worker.js`
statically imports `./omni.js`, which statically imports onnxruntime-web 1.31.1
from jsDelivr. If that one request fails, the worker fails for all brains.
Fix: `await import('./omni.js')` inside the omni path only.

**B4. Phone layout: the brain picker is an empty chevron.** At 375 px the
`#model-select { flex: 1; min-width: 0 }` rule squeezed it to ~20 px with no text,
and on iPhone it was also disabled while still reading "Fast chat (~800 MB)".
**FIXED in the working tree (uncommitted):** picker + ⚙ share a full-width first
row, 16 px font (no iOS focus zoom); in phone mode the picker shows
"Phone chat (256M, ~180 MB)" — the brain that actually loads — and stays pinned.
Verified at 375 px (normal + `?phone`) and desktop. Open question **[decide] D5**.

**B5. Android is not phone mode.** Detection is `iPad|iPhone|iPod` only; Android
Chrome has WebGPU and gets the desktop default (≈800 MB brain + Moonshine-base).
Fix: also treat `navigator.userAgentData?.mobile` / coarse-pointer + small-screen as
phone mode.

**B6. Dev hooks ship to prod.** `?video=` accepts any URL; a cross-origin video
taints the canvas, `getImageData` throws inside `tickFrame` before it reschedules,
and the frame loop dies silently. `?autolive` rewrites the tab title to
`LURKER phase=…`. Fix: `?video=` same-origin relative paths only; keep `?autolive`
(the harness needs it) but leave the title alone unless `location.hostname` is local.

**B7. Late chat after "End stream".** `onWorkerMessage` renders `chat` replies
without a phase check, and `pendingChat` is never reset on go-live (a lost reply
would permanently eat a slot).

**B8. Small ones.** The doomer/parasocial hints contain literal `\"` (double-escaped
in `ARCHETYPES`), so the prompt shows backslashes. `templateLine()` ignores the
`recent` freshness ring main.js passes it. `state.multiFrame` is never set (the
worker never sends it) — dead state.

**B9. Tooling doesn't work from a fresh clone.** `score-chat.mjs` throws on the
shipped `docs/sample-chatlog-2026-10-27.json` (it's a JSON array — what
`__lurkerDump()` produces — and the scorer only reads JSONL, though its header says
it accepts `__lurkerDump()` output). `test-omni-audio.mjs` reads a hard-coded
`/tmp/omni/speech.f32`. No `package.json`, so every node script warns
`MODULE_TYPELESS_PACKAGE_JSON` and there's no `npm test`.

## C. Docs that contradict the code

- Phone brain is described three ways: "450M with a q4 encoder" (README, Run it),
  "q8 fast brain" (README, Known limits), SmolVLM-256M (README model notes; the code).
- "Whisper-class" ASR (README, How it works) — it's Moonshine; default is `base`, not
  `tiny` as the model notes say.
- "four brains in the dropdown" — there are five; Omni isn't in the table.
- "LFM2-VL family" vs LFM2.5-VL; README title "twitch-sim (SpasmTV)", PLAN title
  "LurkerTV"; `__lurkerDump`, `lurker-log`, `lurker-chatlog-*.jsonl` leftovers.
- README tells outsiders to run `serve.sh`, which hard-codes an Xcode Python path.
  Works, but `python3 -m http.server` / `npx serve` is the outsider instruction.

## D. Output review

Three headless runs today on current `master`, scored with `tools/score-chat.mjs`
and then read line by line (logs: session scratchpad `run-fast.jsonl`,
`run-phone.jsonl`, `run-asr.jsonl`).

| run | source | rubric | what the eye sees |
|---|---|---|---|
| fast brain (default), 4 min | `vod-fnf-work.mp4` | echo 0 %, emote 30 %, bigrams 92 % PASS · questions 4 % FAIL | 11 / 50 model lines narrate the persona or the brief: "HYPEMAN" ×2, "Reaction like a troll says nothing.", "reacts like a regular…", "troll replay in cartoon cap draw". First line of the stream: `TwaT…`. One `smashfuckr`. |
| phone mode (SmolVLM-256M), 4.6 min | same | same PASS/FAIL pattern | About half the model lines are junk: `@@/234506579`, `@bryan@fergie@gabe_`, `*ck`, invented `@handles` that may be real people's, half-sentences in caps. This is what every iPhone visitor gets. |
| fast brain + audio, 3 min | `speech-demo.mp4` | n/a | **ASR from a video works** (first time it has been exercised — the harness forces the mic off unless `--mic`). Chat does react to speech ("Forgot coffee? Stay up!", "Mario's got a big red cap"), but 8 / 34 speech-context lines just repeat the streamer ("Welcome back to the stream!", "welcomeback"). |

What that adds to the fix list:

**D1. Client cosmetics break emotes.** `ChatSim.render()` appends `…` (ellipsis
archetypes, 50 %), upper-cases (hype-man), and swaps letters (typo) *before*
`_formatText` matches emote codes, so the code no longer matches and renders as
plain text: `TwaT…`, `ffzY…`, `POLEDOGE`, `ARIW`, `Woewe…` — 5 of 17 emote-only
lines on the fast run, 19 of 37 on the phone run. Fix: apply cosmetics to the
non-emote words only (tokenize, skip known codes), never add `…` to an emote-only line.

**D2. Persona / instruction leakage is the #1 visible defect on the default brain**
and nothing measures it. Fix: reject lines containing archetype keys, `react*`,
`hype ?man`, `viewer`, `chat(ter)?line` in `keep()` (extend `PROMPT_LEAK`), and add a
`persona-leak rate` metric (< 3 %) to the scorer so it can't regress silently.

**D3. Phone brain is not shippable as-is.** Options, best first: (a) turn the regex
grammar guard ON for phones (it's a logits processor plus a small tokenizer; it
would make `@`, `*`, `–`, curly quotes unsampleable) and reject `@` in `keep()`;
(b) phones run on templates + canned real-chat lines + the model only for
captions; (c) both. Then re-run this harness with `?phone`.

**D4. Speech echo.** Add `echoesSpeech()` (same shape as `echoesScene`) against
`ctx.speech` in `keep()`.

**D5. The rubric is miscalibrated and blind.** Its question target is 10–25 %, but
the real-chat corpus it's supposed to match measured 4.4 % (FNF) and 3.0 % (phantom)
(`tasks/D1-REPORT.md`) — today's 4 % is *on target* and the rubric fails it. And it
passes the phone run, which is mostly garbage. Fix: question band 2–10 %; add
persona-leak, `@`/non-word junk rate, and emote-render-failure metrics.

**D6. Motion never fires on real video.** 0 scene changes in 4 min of a real VOD
(and the README says the demo canvas never crosses the threshold either), so the
"chat sees the actual frame on a scene change" path never runs in any measured
session; burst correlation has been n/a in every run. Needs a `diffScore` trace in
the log, then a threshold that fires on cuts in real footage.

**D7. Ship a current sample log.** `docs/sample-chatlog-2026-10-27.json` is from
v1.1 and fails 4 of 4 scorable metrics (39 % caption-echo, 1 % emotes). Replace it
with a post-fix run.

## E. Repo hygiene

- `.gitignore`: add `.pi-subagents/`.
- Branch `feat/grammar-guard` is pre-rebase duplicates of commits already on master
  (local only) — delete. Lane `twitch-sim-phone-fix` holds only verify reports —
  fold the useful bit into this plan and tear the lane down.
- Experimental brains in the public dropdown: the README itself says Liquid 3B is
  "not worth it", and Omni downloads a 510 MB fp32 audio encoder. Keep them behind
  `?brain=` only.

---

## [decide] — Jordan's calls

- **D1 License:** MIT (recommended) / Apache-2.0 / none (stay all-rights-reserved).
- **D2 Where internal docs go:** (a) delete from the repo, keep a local untracked
  copy (recommended), (b) move to a private notes repo, (c) keep but stop serving
  them (Pages can't exclude paths — would need a `gh-pages` publish branch).
- **D3 Commit email:** `jordan.l.milner@gmail.com` is on ~50 public commits. Options:
  leave history, set repo-local `user.email` to the GitHub noreply going forward
  (recommended); or rewrite history + force-push (breaks nothing external — 0 forks —
  but is irreversible).
- **D4 Name:** keep "SpasmTV" or rename.
- **D5 Bigger brains on iPhone:** keep the picker pinned to the 256M brain
  (current, safe), or let iPhone users pick the 450M with a "may crash Safari"
  warning — the 450M was confirmed to jetsam a real iPhone, and a retry can wedge
  the tab.

## Files

- `README.md`, `index.html`, `css/style.css`, `js/main.js`, `js/chat-sim.js`,
  `js/cadence.js`, `js/emotes.js`, `js/text.js`, `workers/llm-worker.js`,
  `workers/omni.js`, `tools/score-chat.mjs`, `tools/test-omni-audio.mjs`,
  `tools/test-text.mjs` (safety-filter cases), `.gitignore`
- new: `LICENSE`, `package.json`
- removed from the tree (per D2): `PLAN.md`, `PLAN-CHAT-V2.md`, `tasks/`

## Steps

1. A3/D2/E — move internal docs out, `.gitignore`, delete stale branch, tear down lane.
2. A4/D1 — `LICENSE` + model-license section in README.
3. B1, B7, B8 — main.js/chat-sim/cadence small fixes.
4. B2, B3 — worker: dispose on brain switch, lazy omni import.
5. A2 — log in-memory by default, "forget everything" clears all four keys.
6. A5 — `SAFETY` reject list in `js/text.js` (pure, tested), used by `keep()`,
   template pickers and `emoteHintFrom`; troll hint reworded.
7. B5, B6 — Android phone mode, `?video=` same-origin, title hook (B4 already done).
8. Experimental brains → `?brain=` only.
9. D1, D2, D4 — emote-safe cosmetics, persona-leak + speech-echo rejection in `keep()`.
10. D3 — phone brain: grammar guard on + `@` rejection (and/or template-heavy phone chat).
11. D5, D6 — rubric: question band 2–10 %, new junk/leak/emote-render metrics;
    `diffScore` trace in the log, scene-change threshold tuned on real footage.
12. B9 — `package.json` (`"type": "module"`, `npm test` runs the four pure tests),
    scorer reads JSON array or JSONL, omni-audio test skips without its fixture.
13. C + A1 + A6 — README rewrite for outsiders (accurate network list, brain table,
    phone mode, model licenses, no tailnet), offline-cover copy.
14. Re-run the harness per shipped brain + phone mode + `--mic` on `speech-demo.mp4`,
    re-score, eyeball transcripts; replace the docs/ sample log (D7).
15. Commit, push (Pages redeploys), re-check the live site and that `/PLAN.md` 404s.

## Verification

```sh
npm test
node tools/score-chat.mjs docs/sample-chatlog-2026-10-27.json || true   # must parse, not throw
node --check js/main.js && node --check workers/llm-worker.js && node --check js/chat-sim.js
grep -L 'jordan\|tail38dbd0\|Alaina' README.md docs/RESEARCH-CHAT-WEBGPU.md
test -f LICENSE && test ! -e PLAN.md && test ! -d tasks
node tools/browser-run.mjs --out /tmp/spasmtv-fast.jsonl --minutes 4 --url-params "video=videos/vod-fnf-work.mp4&autolive=1" && node tools/score-chat.mjs /tmp/spasmtv-fast.jsonl
node tools/browser-run.mjs --out /tmp/spasmtv-phone.jsonl --minutes 3 --url-params "phone&video=videos/vod-fnf-work.mp4&autolive=1" && node tools/score-chat.mjs /tmp/spasmtv-phone.jsonl
node tools/browser-run.mjs --mic --out /tmp/spasmtv-asr.jsonl --minutes 3 --url-params "video=videos/speech-demo.mp4&autolive=1" && node tools/score-chat.mjs /tmp/spasmtv-asr.jsonl
```

Manual (not agent-reachable): a real iPhone load on the live site; the eyeball vibe
check of one transcript next to its real VOD chat (PLAN-CHAT-V2 "Needs Jordan").
