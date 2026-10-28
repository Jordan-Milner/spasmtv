# U6 — §G real-chat ground truth (tools/extract-real-chat.mjs + score-chat --compare)

Goal: turn a YouTube-saved Twitch VOD (chat overlay burned into the frame)
into a timestamped real-chat corpus, and diff our simulated chat's
distribution against it. Node stdlib + child_process only.

Read first: PLAN-CHAT-V2.md §G, tools/score-chat.mjs (existing §F scorer,
its log-event shape: {t, kind, text, ctx:{viewer, archetype, kind, shown,
codes, model}}), tools/browser-run.mjs (how dumps are produced).

Binaries (installed): ffmpeg, ffprobe, tesseract at /opt/homebrew/bin.

## A. tools/extract-real-chat.mjs

    node tools/extract-real-chat.mjs --video videos/foo.mp4 [--out videos/foo.realchat.jsonl]
         [--fps 2] [--start 0 --dur 0(all)] [--region W:H:X:Y] [--preview]

1. ffprobe the video (duration, size).
2. Region: default = the RIGHT 30% of the frame, full height
   (`--region W:H:X:Y` overrides; Twitch VOD-with-chat uploads put the chat
   panel there). `--preview` writes ONE annotated png (crop box drawn) to
   `/tmp/extract-preview.png` and exits — for finding the region by eye.
3. ffmpeg: `-ss start -t dur -i video -vf crop=W:H:X:Y,scale=iw*3:ih*3:flags=lanczos,fps=F`
   → png frames to a tmp dir (`mkdtemp`). Upscale ~3× — chat text is small
   and tesseract needs the stroke width.
4. Per frame: `tesseract frame.png stdout --psm 6` (spawnSync, one at a
   time). Parse lines; Twitch overlay format is `Name: message` — split on
   the first ':', no name → user:null. Trim OCR noise: drop lines < 2 chars,
   strip non-printables, collapse spaces.
5. Dedupe across frames: chat lines PERSIST between frames. Keep the last
   seen N=25 lines; a parsed line that matches (same user + text, or same
   normalized text) a line already emitted whose last-seen frame is recent
   (≤ 3 frames back) is a repeat — update last-seen, don't re-emit. When the
   chat scrolls, old lines vanish and new ones appear at the bottom; a line
   not seen for > 3 consecutive frames is gone. Emit each unique line ONCE
   at its FIRST-seen timestamp.
   - Timestamp: frame index / fps + --start.
6. Output jsonl: `{"t": <seconds float>, "user": <string|null>, "text": <string>}`
   one per line. Also print a summary: lines extracted, unique users, median
   gap, top 10 tokens.
7. Robustness: tesseract missing / ffmpeg fails → clear stderr message,
   exit 1. No partial silent output.

## B. tools/score-chat.mjs --compare

    node tools/score-chat.mjs --compare videos/foo.realchat.jsonl /tmp/sim-run.jsonl [--label "vodname"]

Prints a side-by-side table and a per-metric verdict (MATCH / OFF — with the
sim value, the real value, and tolerance). Real chat's ABSOLUTE rate is
viewer-count-scaled; compare SHAPE:

| metric | how | verdict |
|---|---|---|
| median words/line + p90 | token count | within ±2 / ±5 |
| % 1–2 word lines | | within ±10pp |
| % containing an emote code | sim: ctx.codes non-empty OR known-code regex; real: token that is ALL-CAPS-ish 2–8 chars or in the sim's emote-hint set (approximation — say so in the output) | within ±10pp |
| % emote-only lines | | within ±8pp |
| % question lines | contains '?' | within ±10pp |
| % ALL-CAPS lines | | within ±10pp |
| burstiness | coefficient of variation of per-5s-bucket counts | ratio sim/real in [0.5, 2] |
| msgs/viewer/min | unique users vs lines vs duration | ratio in [0.25, 4] |
| top-10 emote overlap | sim top codes ∩ real top codes | report only (informational) |

Exit non-zero if any verdict (except informational) is OFF. Keep the existing
§F rubric mode working unchanged when --compare is absent.

## Verification

- `node --check` both files.
- Self-test: tools/test-compare.mjs — synthesize a fake real jsonl + fake sim
  jsonl engineered to MATCH and to MISS two metrics; assert the verdicts and
  exit codes. (No network, no video.)
- Real smoke (verifier runs): extract 60s from a downloaded VOD, eyeball 10
  extracted lines against the actual frames.
