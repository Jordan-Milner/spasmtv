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

// the caption-echo disease (the v1.1 sample log of 2026-10-27, since replaced):
// a line made only of caption words ("green background white square") is an
// echo even when its Jaccard vs the long caption sits under 0.5, because the
// line is short.
export function echoesScene(line, scene, thresh = 0.5) {
  if (jaccard(line, scene) > thresh) return true;
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
export function reactionSeed(scene, n = 3) {
  const all = [...new Set(normTokens(scene).filter((w) => !SEED_STOP.has(w)))];
  const words = all.filter((w) => !SEED_STOP.has(w) && w.length > 2);
  // a caption that is pure description ("…a large white letter D") still gets a
  // hook, otherwise the demo feed would give the model nothing to react to
  return (words.length ? words : all).slice(0, n).join(' ') || 'the stream';
}

/* ---- output safety -------------------------------------------------
 * The camera points at a real person and the page is public, so a line that
 * slurs, sexualises, body-shames or tells someone to hurt themselves is
 * dropped before it renders. Roots match inside a word on purpose (the 450M
 * wrote "smashfuckr"); words that are also pieces of innocent words ("rape" in
 * "grape") match whole only. Emote codes in EMOTE_BLOCK are real global
 * BTTV/7TV emotes that read as a jab when an AI aims them at someone on camera. */

const UNSAFE_ROOTS = ['fuck', 'cunt', 'nigg', 'fagg', 'faggot', 'retard', 'tranny', 'twat',
  'whore', 'slut', 'rapist', 'porn', 'dildo', 'titties', 'pussy', 'spastic'];
const UNSAFE_WORDS = new Set(['rape', 'raped', 'raping', 'kys', 'fag', 'spaz', 'dick', 'cock',
  'tits', 'boobs', 'boobies', 'sex', 'sexy', 'nude', 'naked', 'horny', 'fat', 'fatty', 'fatass',
  'obese', 'ugly', 'hideous', 'suicide', 'unalive', 'affair', 'affairs']);
// the person on camera's love life is off limits — the phone brain on prod wrote
// "You appear to be having an affair with the woman you're posing for"
const UNSAFE_PHRASE = /\b(kill (yo)?ur ?self|kill yourself|neck yourself|go die|end it all|cheating on (you|him|her|them)|your (wife|husband|girlfriend|boyfriend|gf|bf))\b/i;
export const EMOTE_BLOCK = new Set(['twat', 'gayge', 'gachigasm', 'gachibass']);

export function unsafeLine(s) {
  const t = String(s || '');
  if (UNSAFE_PHRASE.test(t)) return true;
  return t.toLowerCase().split(/\s+/).some((raw) => {
    const w = raw.replace(/[^a-z]/g, '');
    return w && (UNSAFE_WORDS.has(w) || EMOTE_BLOCK.has(w) || UNSAFE_ROOTS.some((r) => w.includes(r)));
  });
}

// emote codes the app may show or steer the model toward. FFZ's one-letter
// modifiers ("c!", "w!") are effects, not emotes — they render as junk alone.
export const safeEmote = (code) =>
  !!code && !/^[a-z]!$/i.test(code) && !EMOTE_BLOCK.has(String(code).toLowerCase()) && !unsafeLine(code);

/* ---- persona / instruction leakage ---------------------------------
 * The 450M answers "your vibe: the hype man" with "HYPEMAN" and "Reaction like
 * a troll says nothing." (11 of 50 model lines in the 2026-10-28 fast run).
 * Archetype names and the react-* family are the brief, not chat. PROMPT_LEAK
 * is the rest of the prompt coming back: "REACT LIKE A VIEWER WITH…", "No
 * emotes allowed; keep your voice", and — once scene changes started firing on
 * real footage — "on screen just changed…", "on screen, random drawn thing i
 * see…" (5 of 47 model lines, from "On screen, roughly:" and "Something on
 * screen just changed."). */
const PERSONA_LEAK = /\b(react(s|ed|ing|ion|ions)?|hype ?-?m[ae]n|hypem[ae]n|troll(s|ing|ed)?|doomer|parasocial|backseat(s|ing|er)?|copypasta|newcomer|earnest|chatter ?line|chat ?line|persona|archetype)\b/i;
const PROMPT_LEAK = /\b(react like a viewer|like a viewer who|max ?12 ?words|never describe|write only the message|one short chat message|your vibe|stream_name|no emotes?|no description|no quotes?|no hashtags?|keep your voice|lowercase only|one emote from|on ?screen,? roughly|something on ?screen|(on ?screen|screen) just changed|just changed)\b|^\W*on ?screen\b/i;
/* UI narration — the 256M looking at a screenshot of a stream and describing the
 * interface instead of reacting to it (post2-phone, 7 of 44 model lines, none of
 * them caught by the junk metric): "The user's profile picture.", "The text reads
 * as follows...", "The last comment was written by zlox." */
const UI_LEAK = /\bthe (user'?s|streamer'?s|viewer'?s|chat'?s)? ?(profile picture|avatar|username|user ?name|display name|text|caption|comment|message|image|picture|screenshot)\b|\breads as follows\b|\bwritten by\b|\bbe respectful\b|\bplease (note|remember)\b/i;
export const personaLeak = (s) => PERSONA_LEAK.test(String(s || '')) || PROMPT_LEAK.test(String(s || ''))
  || UI_LEAK.test(String(s || ''));

/* prompt-tag echo — the prompt feeds data as bracketed tags ([see …], [new],
 * [vibe …]) and ends with the completion cue "Chat line:". A bracket is never
 * real chat, so an echo of the framing is unmissable rather than plausible. */
export const tagEcho = (s) => { const t = String(s || ''); return /[\[\]]/.test(t) || /^\W*(chat line|vibe)\b/i.test(t); };

/* ---- junk ------------------------------------------------------------
 * The 256M phone brain's failure shape: "@@/234506579", "@bryan@fergie@gabe_",
 * "*ck". An @mention is only real chat when it names someone in the room —
 * an invented @handle may be a real person's, so it never renders. */
export function junkLine(s, allowNames = []) {
  let t = String(s || '');
  for (const n of allowNames) if (n) t = t.split('@' + n).join(n);
  if (t.includes('@')) return true;
  if (/\d{5,}/.test(t)) return true;
  // a number with a leading zero is the model reading a filename or a timestamp
  // back ("0560 in my mind!"); real chat types "100", "240p", years — not "0560"
  if (/\b0\d{2,}\b/.test(t)) return true;
  // mostly symbols: "%%%% ##", "|..| ..." (":tf:" is an emote, exactly half)
  const chars = t.replace(/\s/g, '');
  const symbols = chars.replace(/[A-Za-z0-9]/g, '');
  return chars.length >= 4 && symbols.length / chars.length > 0.5;
}

/* ---- speech echo ----------------------------------------------------
 * Chat that repeats the streamer back ("Welcome back to the stream!" after
 * "hey everyone, welcome back to the stream") is the speech twin of the
 * caption echo: 8 of 34 speech-context lines in the 2026-10-28 audio run.
 * A one-word answer ("welcome!") is chat, not an echo. */
export function echoesSpeech(line, speech) {
  if (!speech) return false;
  if (jaccard(line, speech) > 0.5) return true;
  const said = new Set(normTokens(speech).filter((w) => w.length > 2));
  const own = normTokens(line).filter((w) => w.length > 2);
  if (own.length >= 2 && own.every((w) => said.has(w))) return true;
  const squash = (x) => normTokens(x).join('');
  const l = squash(line);
  return l.length >= 8 && squash(speech).includes(l);
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
