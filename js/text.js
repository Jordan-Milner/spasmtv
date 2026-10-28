// text.js — the shared text plumbing: tokenising, Jaccard similarity, the
// caption-echo guard and the reaction seed. One definition on purpose:
// workers/llm-worker.js uses these to reject bad generations, main.js uses them
// for dedupe, and tools/score-chat.mjs scores a log with the same yardstick the
// runtime used. Plain ESM, no deps, so node can import it directly.

export const normTokens = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

export function jaccard(a, b) {
  const A = new Set(normTokens(a));
  const B = new Set(normTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / new Set([...A, ...B]).size;
}

// true when `line` is too close to ANY of `priors` (the dedupe pressure)
export function tooSimilar(line, priors, thresh = 0.75) {
  if (!normTokens(line).length) return true;
  return priors.some((p) => jaccard(line, p) >= thresh);
}

// the caption-echo disease (docs/sample-chatlog-2026-10-27.json): a line made
// only of caption words ("green background white square") is an echo even when
// its Jaccard vs the long caption sits under 0.5, because the line is short.
export function echoesScene(line, scene) {
  if (jaccard(line, scene) > 0.5) return true;
  const sceneWords = new Set(normTokens(scene).filter((w) => w.length > 2));
  const own = normTokens(line).filter((w) => w.length > 2);
  return own.length >= 2 && own.every((w) => sceneWords.has(w));
}

// the vocabulary of "describing a picture" — stripped so the seed handed to the
// model is a topic, not a sentence it can finish
const SEED_STOP = new Set(('a an the of with and or in on at to for is are am was were be been ' +
  'this that it its there they them you your we our i my me from by but so not no yes some any ' +
  'large small big little tall short ' +
  'white black grey gray brown silver green blue red yellow orange purple pink dark light bright ' +
  'background foreground center centre middle top bottom left right corner side border edge ' +
  'letter number symbol shape object item thing appears shows seen').split(' '));

// caption → up to 3 content words. "A green background with a large white
// letter D" → "d". Deliberately useless as a description.
export function reactionSeed(scene) {
  const all = [...new Set(normTokens(scene).filter((w) => !SEED_STOP.has(w)))];
  const words = all.filter((w) => !SEED_STOP.has(w) && w.length > 2);
  // a caption that is pure description ("…a large white letter D") still gets a
  // hook, otherwise the demo feed would give the model nothing to react to
  return (words.length ? words : all).slice(0, 3).join(' ') || 'the stream';
}

/* ---- fact extraction gate ------------------------------------------
 * "not everything the streamer says is a memory." The 450M classifier prompt
 * alone can't be trusted (it almost never answers NO), so this pure gate runs
 * BEFORE any model call and a third-person shape check runs after it. Bias is
 * deliberately toward NO: a missed fact costs one line of context, a junk
 * fact poisons every chat prompt until someone edits the settings panel. */

// first-person statements that can carry something durable
const FACT_SIGNAL = /\b(i\s*am|i'?m|my|i\s*have|i'?ve|ive|i\s*live[sd]?|i\s*work[ed]?|i\s*used\s*to|i\s*like[sd]?|i\s*love[sd]?|i\s*hate[sd]?|i\s*play[ed]?|i\s*was\s*born|my\s*name|call\s*me|we\s*live|we\s*have|i\s*stud(y|ied)|i\s*own|i\s*drive|i\s*ride|i'?m\s*from|we'?re\s*from)\b/i;
// filler/commands — the first words out of a talking mouth, never biography
const FACT_OPENER = /^(hold|wait|look|watch|listen|check|chat|guys|brb|lol|lmao|haha|thanks?|sorry|oh|uh|um|whoa|wow|nice|cool|damn|ok|okay|yeah|yes|nah|nope|hey|hi|hello|so|and|but|right|alright|let|lets?|can|could|would|should|do|does|did|is|are|was|were|what|who|where|when|why|how)\b/i;
// stream-context and transient-time talk: about the stream, not the streamer
const FACT_ANYWHERE = /\b(today|tonight|right now|currently|this morning|this stream|on stream|the stream|streaming|tomorrow|yesterday)\b/i;
// moods and motion — "i'm tired", "i'm going to" pass the signal but say nothing
const FACT_TRANSIENT = /\b(tired|hungry|sleepy|bored|sick|excited|annoyed|confused|ready|late|done|going|gonna|leaving|coming|getting|streaming)\b/i;

export function factCandidate(s) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  const words = t.split(' ');
  if (words.length < 4 || words.length > 25) return false;
  if (t.includes('?')) return false;
  if (/\byou(r|rs)?\b/i.test(t)) return false;        // addressed at someone else
  if (!FACT_SIGNAL.test(t)) return false;             // no durable shape at all
  if (FACT_OPENER.test(t)) return false;
  if (FACT_ANYWHERE.test(t)) return false;
  if (FACT_TRANSIENT.test(t)) return false;
  return true;
}
