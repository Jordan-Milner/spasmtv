# U8 — §H grammar guard: report

Branch `feat/grammar-guard` (worktree `~/Projects/twitch-sim-grammar`), unit spec:
`tasks/U8-grammar-guard.md`.

## What shipped

| File | Change |
|---|---|
| `workers/llm-worker.js` | `AutoTokenizer` imported + loaded with the model when the guard is wanted; `grammarModule()` lazy-loads `StructuredOutputProcessor`; `generate()` gained `grammar = false`; `onChat()` passes `grammar: true` (caption + ASR fact prompts untouched); cumulative `calls`/`drops` counters posted with every chat response; `ready` carries `grammar: <bool>`; a guard failure posts `grammar-off` with the verbatim error. |
| `js/main.js` | `state.grammar` (default ON, forced OFF on phones, OFF with `?grammar=0`) sent in the `load` message; `guard` event logged (`on` / `off` + error) so a rubric run proves which mode produced it. |

Processor is built **per chat call**, not once per load: the engine carries
mutable grammar state per generation (its docs say one sequence at a time), and
the constructor is a cheap automaton build next to a 300 ms generation. Building
it once per load would share that state across the first-pass and the hot retry.

## The gotcha that ate an hour

`import { StructuredOutputProcessor } from
'https://cdn.jsdelivr.net/npm/@huggingface/transformers-structured-output@4.3.2'`
— the import shape the unit spec was written against — **does not work**: that
bare URL serves the package's **CJS** build (`"use strict"; var __defProp…`), so
the named ESM import is `undefined` and the guard silently never engaged (first
measurement run showed a chat line full of `/` and `>` while logging nothing).

`/+esm` is a real ESM bundle, but it imports
`"/npm/@huggingface/transformers@4.3.2/+esm"` — a *different* URL from the one
this worker statically imports, i.e. a second copy of transformers.js, and the
processor must subclass the same `LogitsProcessor` the loaded model checks
against. So `grammarModule()` fetches `+esm`, rewrites that one specifier to the
URL the worker already loaded, and imports the result from a blob URL. One copy,
one class identity, no build step, no npm.

## A/B — same content (`videos/vod-fnf-work.mp4`, `?autolive=1`, 4 min, 450M brain)

Two headless runs on the same profile; only `&grammar=0` differs.

| | guard ON | guard OFF |
|---|---|---|
| chat lines (model / template) | 88 · 48 / 40 | 71 · 48 / 23 |
| chat `generate()` calls | 57 | 62 |
| first passes killed by `keep()` (retry cost) | 8 | 12 |
| calls per kept model line | **1.19** | 1.29 |
| model lines using a char outside the guard charset | **0 / 48** | 15 / 48 |
| emoji / `#hashtag` / `<…>`-`[…]` debris / prompt-leak | 0 | 0 |
| `grammar-off` catch tripped | no | no |

Outside-charset examples from the unguarded run: `reactor lol hey fam~`,
`Max Xyz y's mic straight-eye-open …`, `“what? i'm not sure” vague, confused
waiting *`. The guard forbids the curly quotes (`’ “ ”`), `~`, `*`, hyphens and
`*`-roleplay; straight apostrophes stay legal, so `I'm` and `today's` are fine.
(Trailing `…` in both runs is our own `toChatLines` 14-word truncation, not
sampled text.)

Scorer (`tools/score-chat.mjs`) on the same two logs:

| metric | guard ON | guard OFF |
|---|---|---|
| caption-echo rate | PASS 0.0 % | PASS 0.0 % |
| question rate | PASS 14.8 % | **FAIL 31.0 %** (over band) |
| emote rate | PASS 43.2 % | PASS 33.8 % |
| unique bigram ratio | PASS 91.0 % | PASS 91.3 % |
| burst correlation | FAIL 0.93× | FAIL 0.92× |
| ban latency / template repeat | n/a (no mod actions in this run) | n/a |

**Verdict: guard stays ON by default.** Fewer retries per kept line (1.19 vs
1.29), zero charset violations, and no score regression — the one FAIL it shares
with the off run (burst correlation) is the scene-change detector, not the
guard, and the off run fails one metric more.

## Cost of the charset, stated honestly

The model cannot sample `-`, so `straight-eye-open` becomes
`straight eye open`, and it cannot sample `…`/`~`/emoji. In a 4-minute A/B
against the same video that changed nothing the scorer measures and removed 15
lines' worth of debris; if Jordan decides Twitch hyphenation matters more, the
regex is one line (`CHAT_REGEX` in `workers/llm-worker.js`) and `?grammar=0`
turns the whole thing off without a code change.

## Reproduce

```
cd ~/Projects/twitch-sim-grammar && ln -sfn ~/Projects/twitch-sim/videos videos
python3 -m http.server 8621 --bind 127.0.0.1 &
node tools/browser-run.mjs --out /tmp/u8-on.jsonl --minutes 4 --port 9347 \
  --profile /tmp/grammar-chrome --base http://127.0.0.1:8621/ \
  --url-params "video=videos/vod-fnf-work.mp4&autolive=1"
# guard off: add &grammar=0
node tools/score-chat.mjs /tmp/u8-on.jsonl
```

One run per Chrome profile at a time, and never two headless WebGPU Chromes at
once: the second one hangs at `checking WebGPU` forever (`requestAdapter()`
never resolves). That is what cost the first two attempts here, not the guard.
