// cadence.js — the §C scheduler as pure functions: which message kind to write
// next, how long till the next line, and how many lines a tick fires. Pure and
// tiny on purpose so tools/test-cadence.mjs can simulate ten minutes of chat in
// node and assert the rate budget (≤ today's 20 lines/min) without a browser.

// §C weights. "emote" is the only kind that never costs a generate call.
export const KIND_WEIGHTS = {
  reaction: 39, emote: 13, question: 21, backseat: 8,
  reply: 6, banter: 6, callback: 5, meta: 3, greeting: 2,
};

// who is allowed to ask questions — question inflation (§ diagnosis 2) came
// from too many personas asking; a doomer or a hype-man does not interrogate
export const ASKERS = new Set(['earnest', 'newcomer', 'parasocial', 'regular', 'backseat', 'troll', 'doomer']);

export function pickKind(rnd = Math.random, weights = KIND_WEIGHTS) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (const [k, w] of Object.entries(weights)) {
    r -= w;
    if (r <= 0) return k;
  }
  return 'reaction';
}

// state/archetype modulation: a kind that can't be honoured degrades to a
// reaction rather than firing an empty prompt.
//   viewer    { archetypeKey }
//   ctx       { bits, recent, sceneChange, userMsg, hype }
export function gateKind(kind, viewer, ctx = {}) {
  if (kind === 'question' && !ASKERS.has(viewer?.archetypeKey)) return 'reaction';
  if (kind === 'callback' && !ctx.bits?.length) return 'reaction';
  if (kind === 'reply' && !(ctx.recent?.length || ctx.userMsg)) return 'banter';
  if (kind === 'greeting' && !ctx.hype) return 'meta';
  return kind;
}

// gap until the next chat tick. Droughts (4–8 s of silence) and the short
// recovery gap after a flurry are what make chat not read as a metronome.
export function nextGapMs(rnd = Math.random) {
  const p = rnd();
  if (p < 0.20) return 4000 + rnd() * 4000;      // drought: nothing for 4–8 s
  if (p < 0.32) return 1500 + rnd() * 1500;      // post-flurry settle
  return 2700 + rnd() * 3200;                    // normal turn-taking, 2.7–5.9 s
}

// what one tick fires. A flurry is 3 lines inside 1.5 s (offsets from now);
// `chant` means the whole burst is one emote repeated by different viewers.
export function planBurst(rnd = Math.random) {
  const p = rnd();
  if (p < 0.10) {
    const a = 380 + rnd() * 320;
    return { n: 3, offsets: [0, a, Math.min(1450, a + 380 + rnd() * 320)], chant: rnd() < 0.5 };
  }
  if (p < 0.30) return { n: 2, offsets: [0, 500 + rnd() * 700], chant: false };
  return { n: 1, offsets: [0], chant: false };
}

// template lines — real chat is full of these and they cost no GPU
const SMASH = ['asdfghjkl', 'ajskdlfj', 'sdkfjlsd', 'kdjfslkd', 'aksjdlkf'];
const FILLS = ['F', 'f', 'F in the chat', 'KEKW', 'LUL', 'docL', 'WeirdChamp'];
const QUESTIONS = [
  'what game is this?', 'what are you playing?', 'how long have you been streaming?',
  'where are you from?', 'what happened last stream?', 'can you play what i said?',
];

// the classics. Asking the 450M to invent a copypasta produced "Max_1CIPASTAS"
// (observed in the first §C run) — a copypasta viewer pastes, it doesn't write.
export const PASTAS = [
  'have you ever been so far even as decided to use even go want to look more like?',
  '┬─┬ ノ( ゜-゜ノ)',
  'i am once again asking for one (1) emote',
  'this message is so sad, alexa play despacito',
  '┬┴┬┴┤(･_├┬┴┬┴ lying down while watching',
];

// a copypasta archetype sometimes pastes instead of reacting (no GPU call)
export function maybePasta(kind, viewerKey, rnd = Math.random) {
  return kind === 'reaction' && viewerKey === 'copypasta' && rnd() < 0.3
    ? PASTAS[(rnd() * PASTAS.length) | 0]
    : null;
}

export function templateLine(kind, { emote = () => 'KEKW', hype = false, chant = null } = {}) {
  if (chant) return chant;
  if (kind === 'question') return QUESTIONS[(Math.random() * QUESTIONS.length) | 0];
  if (kind !== 'emote') return null;
  const r = Math.random();
  if (hype && r < 0.35) return SMASH[(Math.random() * SMASH.length) | 0];
  if (r < 0.75) return emote();
  return FILLS[(Math.random() * FILLS.length) | 0];
}

/* ---- bits: a line that lands during a hype peak becomes a running joke ----
 * Rare and deduped (the echo-loop lesson): one bit at a time, ~10 min life,
 * and the callback kind quotes it rather than re-generating it. */
export function maybeBit(bits, line, { hype = false, now = Date.now(), chance = 0.12 } = {}) {
  if (!hype || !line || line.length < 4 || line.length > 40) return bits || [];
  if (Math.random() > chance) return bits || [];
  const clean = line.trim();
  if ((bits || []).some((b) => b.text.toLowerCase() === clean.toLowerCase())) return bits;
  return [{ text: clean, until: now + 600e3 }];
}

export function liveBits(bits, now = Date.now()) {
  return (bits || []).filter((b) => b.until > now);
}
