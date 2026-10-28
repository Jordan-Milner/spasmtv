# U8 — §H grammar guard: regex-constrained chat lines (workers/llm-worker.js)

Goal: constrain chat-message generation to a chat-safe character set with
`@huggingface/transformers-structured-output`'s `StructuredOutputProcessor`
(a `logits_processor` for `model.generate()`), so emoji faces, hashtags,
uppercase debris, and prompt-leak fragments become unsampleable instead of
post-filtered — and fewer lines die in `keep()` → fewer retry GPU calls per
kept line. Research context: docs/RESEARCH-CHAT-WEBGPU.md §4.

Read first: PLAN-CHAT-V2.md §B + §H, workers/llm-worker.js (`load()`,
`generate()`, `onChat()`, `toChatLines()`, the `keep()` filter chain),
tools/browser-run.mjs.

Facts you can rely on (verified 2026-10-28 against
@huggingface/transformers-structured-output@4.3.2): dependency-free,
peer-dep `@huggingface/transformers@^4.3.2` (we pin 4.3.2); import shape
`import { StructuredOutputProcessor } from
'https://cdn.jsdelivr.net/npm/@huggingface/transformers-structured-output@4.3.2'`;
JSON-schema or **regex** mode; regex is FULL-STRING only, and lookarounds,
backreferences, lazy quantifiers, and Unicode character classes are
unsupported; ONE generated sequence at a time (our chat gen is one line per
call — fine); model and tokenizer must share `eos_token_id`.

Constraints (invariants): zero backend; the import is a CDN ESM module
exactly like the transformers.js import itself — no build step, no npm.
Caption + ASR fact-extraction paths stay UNCONSTRAINED. Keep every existing
post-gen filter (keysmash is charset-legal; Jaccard/echo/persona filters
unaffected) — the guard is a front door, not a replacement backstop.

## Work items

1. **Tokenizer** (llm-worker.js `load()`): alongside processor+model,
   `AutoTokenizer.from_pretrained(cfg.id)` (add AutoTokenizer to the
   existing transformers import). Stash it next to `model`.
2. **Regex**: `[A-Za-z0-9 ,.!?']{1,90}` — caps allowed (emote codes are
   uppercase text), apostrophes allowed, everything else (emoji, hashtags,
   template debris brackets, non-ASCII) unsampleable. Build the processor
   per chat call (it is cheap; state carries per generation) or reuse one
   per model load — your call, say why in the report.
3. **Wire-in**: `generate()` gains an opt-in `grammar = false` param; only
   `onChat()`'s calls pass `true`. If the processor throws (e.g. eos_token_id
   mismatch), catch ONCE, set a module flag `grammarBroken = true`, log to
   console, and continue unguarded — a broken guard must never kill chat.
4. **Kill switch**: read `?grammar=0` in js/main.js where other params are
   read, pass through the load message, default ON for desktop, always OFF
   in phone mode (one less moving part there).
5. **Measure**: two headless runs on the same content (any videos/ file, or
   demo if none — say which): guard on vs off. Report per run: total
   generate calls (first-pass + retries), kept lines, and the §F-style
   metrics via tools/score-chat.mjs if present. The win condition is
   fewer retries at equal-or-better scores.

## Verification

- `node --check` on both touched files.
- Guard-on run log contains ZERO lines that toChatLines would have had to
  strip (no emoji, no hashtags, no `[…]` template debris, no
  PROMPT_LEAK-pattern text).
- Report: calls/kept/retries table (on vs off) + score comparison + the
  catch-flag never tripped (or the verbatim error if it did).
- If scores DROP with the guard on (masked-token mass distorting the
  distribution is the known risk), report that and flip the default to OFF
  — the kill switch ships either way.
