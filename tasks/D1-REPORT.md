# D1 — §G real-chat ground truth extraction (U6 section A)

Run 2026-10-28 on this lane (`/Users/jordan/Projects/twitch-sim`).
Tool: `tools/extract-real-chat.mjs`. Binaries: `/opt/homebrew/bin/{ffmpeg,ffprobe,tesseract}`
(ffmpeg 9.0.1, tesseract 5.x). Outputs land in `videos/`, which is gitignored
(`git check-ignore -v` → `.gitignore:6:videos/`); I staged and committed nothing.
The lane owner committed the tool fixes mid-session as `6b48b28` ("§G
extract-real-chat fixes") — `git diff HEAD -- tools/extract-real-chat.mjs` is now
empty because they are in that commit, not because I committed them.

**Budget note:** the two full VODs are ~4.5 min and ~7 min of tesseract, so the
verify chain is ~12 min end to end — a 600 s test timeout kills it after the
first command (that is what happened to the earlier D1 attempt this report
replaces). Run the two commands separately, or raise the timeout.

## Verdict in one line

`vod-fnf-work.mp4` is a **usable ground-truth corpus** (4805 lines, 556 users,
median 3 words/line). `vod-phantom.mp4` is **not** — its chat panel is clipped by
the right edge of the frame, so only ~10 characters of every line are on screen;
the default-region output is a noise-dominated best effort, as the task allowed.

## Commands run (the lane's verify)

```
$ node tools/extract-real-chat.mjs --video videos/vod-fnf-work.mp4 \
      --region 300:500:980:220 --fps 2 --out videos/vod-fnf-work.realchat.jsonl
wrote videos/vod-fnf-work.realchat.jsonl: 4805 lines · 556 users      # exit 0, ~4.5 min
$ node tools/extract-real-chat.mjs --video videos/vod-phantom.mp4 --fps 2 \
      --out videos/vod-phantom.realchat.jsonl
wrote videos/vod-phantom.realchat.jsonl: 28758 lines · 1976 users     # exit 0, ~7 min
$ test $(wc -l < videos/vod-fnf-work.realchat.jsonl) -ge 50
GATE OK: 4805 lines                                                   # exit 0
```

Both videos are 1280x720, 720.07 s, so `--fps 2` = 1440 frames each, one
`tesseract --psm 6` call per frame.

---

## 1. videos/vod-fnf-work.mp4 — region 300:500:980:220

| metric | value |
|---|---|
| lines | **4805** |
| unique users | **556** |
| lines with a parsed `user` | 2463 (51.3 %) |
| median words/line | **3** (mean 3.05, p90 6) |
| distinct `(user,text)` keys | 2062 → 2743 lines are re-emissions of an earlier key |
| time span | 0.0 – 719.5 s (whole VOD), 6.67 lines/s |
| questions (`?`) | 4.4 % |
| top tokens | a(365) the(342) mario(319) dave(264) you(251) it(245) chat(197) to(196) movie(185) s(176) |

10 sample lines (`videos/vod-fnf-work.realchat.jsonl`, spread over the timeline):

```json
{"t":12,"user":"thevees_right","text":"I'm first"}
{"t":53.5,"user":"sonica_fam","text":"How da Renewal"}
{"t":138.5,"user":"ProdDotSplot","text":"Saturday night"}
{"t":210,"user":"tordfriendtwo2","text":"Yo esperando, yo"}
{"t":265,"user":"noahcgonzales","text":"People on TikTok"}
{"t":308.5,"user":"i_mine_and_craft","text":"Banana kk."}
{"t":435.5,"user":"joahegonzales","text":"Dave get to work"}
{"t":490.5,"user":"iheartmitski9","text":"DAVID PLEASE"}
{"t":526,"user":"&","text":"| want to see it"}
{"t":603.5,"user":"kurryarts","text":"Bowsers song was the ;"}
```

Eyeballed against `/tmp/d1/fnf-120.png` etc.: the panel really is at
x≈1040–1265, y≈100–660, so `300:500:980:220` (x 980–1280, y 220–720) catches the
lower ~2/3 of the panel plus the "Send a message"/`Chat` box (which is where the
`user:null` "Send a message" and "| Chat" lines come from). Usernames match the
frame exactly (`ProdDotSplot`, `noahcgonzales`, `zabloingoing`), so the region is
right.

Known quality limits of this corpus (both are spec'd behaviour of the tool, not
region problems):

- **OCR flicker re-emits.** Dedupe (§A.5) is exact-key with a 3-frame (1.5 s)
  persistence window, and tesseract drops a character on some frames, so
  `Merry Christmas` / `Merry Christmas j` / `Merry Christmas *` are three keys.
  Measured: 4805 emitted vs 2062 distinct keys — the absolute rate is inflated
  ~2.3x. Message *shape* (words/line, users, token mix) is still representative;
  **rate** and burstiness numbers from this corpus are not.
- **`median gap: 0.00s`** in the tool summary is arithmetic, not a bug: every
  line parsed out of one frame carries that frame's timestamp, so intra-frame
  gaps are 0. Burstiness in `score-chat --compare` should be read per 5 s bucket,
  not from this field.
- Emote images OCR as junk tokens (`+`, `;`, `&`, `@`) or as a broken `user`
  (`&`, `By IX`, `Fy }X` — those are badge glyphs left of a username). ~5 % of
  lines. `--region 260:560:1020:100` trims the badge column if a later unit wants
  cleaner usernames; I did not change the lane's command.

## 2. videos/vod-phantom.mp4 — default region (right 30 %), best effort

| metric | value |
|---|---|
| lines | **28758** |
| unique users | **1976** |
| lines with a parsed `user` | 3103 (10.8 %) |
| median words/line | **2** (mean 2.72, p90 5) |
| distinct `(user,text)` keys | 18291 → 10467 re-emissions |
| time span | 0.0 – 719.5 s, 39.9 lines/s (impossible for a 369-viewer chat → noise-dominated) |
| questions (`?`) | 3.0 % |
| lines whose `user` is a plausible Twitch login | **15** out of 28758 |

10 sample lines (`videos/vod-phantom.realchat.jsonl`) — these are the *cleanest*
lines it produces:

```json
{"t":41,"user":"gin7_","text":"pret"}
{"t":63.5,"user":"Reznor","text":"Jack = ="}
{"t":230,"user":"ants","text":"2 - Shraquet: |"}
{"t":289,"user":"bees","text":"es Te pr"}
{"t":350.5,"user":"sede","text":"* . : b |"}
{"t":240,"user":null,"text":"tc 8"}
{"t":0,"user":null,"text":"| > iB"}
{"t":719.5,"user":"2 HaiOreo","text":"w"}
{"t":719.5,"user":null,"text":"v . Toshiscool"}
{"t":719.5,"user":null,"text":"v aA"}
```

### Why it fails — the panel is off-frame, not a noise-gate problem

The recording is a browser window whose chat column runs past the right edge of
the 1280x720 frame: the panel divider is at **x≈1212** and the first glyph of a
line at **x≈1224**, so only **~56–76 px ≈ 8–12 characters** of every chat line
are inside the image. Verified by cropping `x=1200 w=80` at t=10/200/400/700
(`/tmp/d1/cols.png`): `castr34: i g`, `tu_mama0:`, `she_luvs_n`, `guy in front`,
`water blew` — usernames are cut **before** their `:`, which is why `user` is
null on 89 % of the lines (the split-on-first-`:` rule never fires), and message
text is truncated to a fragment.

The remaining ~90 % of the default right-30 % crop (x 896–1280) is **not chat**:
the Adobe Illustrator asset list (`arm chil left`, `bf clenched fist`, …) at
x≈1030–1200, the desktop, and the Twitch/YouTube chrome. That list is ordinary
English words, so the letters-ratio noise gate cannot separate it from chat —
only geometry can.

Regions tried, on the same 60 s window (t=240–300) for a fair comparison:

| region | lines | users | verdict |
|---|---|---|---|
| default right-30 % (`384:720:896:0`) | 2591 | 128 | asset list + clipped chat |
| `300:560:960:140` (the fallback in the task) | 1320 | 19 | worse — sits on the asset list; tokens `therea`, `sa` |
| `80:600:1200:100` (chat column only) | 386 | 9 | **cleanest**: `guy in front`, `water blew`, `funkin it wa`, `DragonXLis`, `PatchySou` — real chat, but clipped and `user` always null |

So the best achievable from this VOD is `--region 80:600:1200:100`, and even that
yields truncated message fragments with no usernames. **Recommendation: use
`vod-fnf-work.mp4` as the §G ground truth and drop `vod-phantom.mp4`** (or, if it
must stay, filter to lines with a non-null `user`, which leaves 15 rows). A
re-download at a wider capture resolution would be the only real fix, and
re-downloading is out of scope for this unit.

## OCR tuning applied (all in `tools/extract-real-chat.mjs`, nothing else)

Three changes, all of them required before the extraction could run at all — no
algorithm/spec change (§A.5 dedupe, `--psm 6`, 3x lanczos, `format=gray,negate`
and the noise gate are untouched):

1. **`--region` produced an invalid filtergraph — the lane's fnf command could
   not run.** The region branch built `crop = "300:500:980:220"` with no `crop=`
   filter name, so ffmpeg said `No such filter: '300:500:980:220'` and exited 1.
   Now the crop string is always assembled as `crop=W:H:X:Y`.
2. **Default region was the LEFT 30 %, not the right.** `crop=W*0.3:H:0:0` uses
   x=0 = left edge; the spec (§A.2) and the phantom verify command want the
   **right** panel. Now x = `W0 - round(W0*0.3)`. This is what makes the phantom
   default command read the chat column at all (before, it read the timeline).
3. **`--preview` was broken twice over.** `boxcolor=…:boxwidth=…` was written as
   a *separate* filter after a comma (filtergraph parse error), and this ffmpeg
   build has **no `drawtext`** (`No such filter: 'drawtext'` — built without
   freetype). Preview now draws the crop box on the *uncropped* frame with
   `drawbox` and prints the resolved geometry, which is what "find the region by
   eye" actually needs:

   ```
   $ node tools/extract-real-chat.mjs --video videos/vod-fnf-work.mp4 --region 300:500:980:220 --preview
   wrote preview to /tmp/extract-preview.png (crop 300x500 at 980,220)
   ```

`node --check tools/extract-real-chat.mjs` passes. `git status` shows no staged
files; `videos/*.jsonl` are ignored by the existing `videos/` rule.

## Residual risks / follow-ups for the lane owner

- The fnf corpus over-counts messages ~2.3x (OCR-flicker re-emission). If
  `score-chat --compare` judges rate or burstiness, either widen the §A.5
  persistence window from 3 frames to ~8 (4 s at fps 2) or dedupe on
  `(user,text)` globally — that is a **spec** decision (§A.5 states 3 frames),
  so I left the code faithful to the spec and flagged it here instead.
- `median gap: 0.00s` is always ~0 with multi-line frames; the summary line is
  misleading as written.
- The fnf region misses the top ~120 px of the panel (the region's y starts at
  220 while the panel starts at ~100), so the first lines of a burst that scroll
  past quickly are lost. Acceptable for a distribution sample; `--region
  260:560:1020:100` recovers them if wanted.
- 4805 lines / 720 s = 6.7 lines/s vs a plausible real ~1–2 msg/s: shape metrics
  (words/line, % questions, token mix) are trustworthy, absolute rates are not.
- `content-fnaf.mp4` (137 MB) was never touched — no `.part` files, no download
  in progress when I started, and I restarted nothing.
