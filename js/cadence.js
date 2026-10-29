// cadence.js — the §C scheduler as pure functions: which message kind to write
// next, how long till the next line, and how many lines a tick fires. Pure and
// tiny on purpose so tools/test-cadence.mjs can simulate ten minutes of chat in
// node and assert the rate budget (≤ today's 20 lines/min) without a browser.

import { pickFresh } from './culture.js';

// §C weights. "emote" is the only kind that never costs a generate call.
// The free (emote/fill) share is the main speed lever: every non-emote line
// costs a GPU generation, so starving it backs up the queue and chat goes slow.
// 2026-10-28: an over-correction toward the measured 3-9% emote stat cut this
// to ~26% and made chat both slow and (because reactions then ran text-only)
// unresponsive to the screen. Kept the measured reply bump (6→10); restored the
// free share. Emote *rate* is still held down by the stricter templateLine below.
export const KIND_WEIGHTS = {
  reaction: 40, emote: 18, question: 16, backseat: 8,
  reply: 15, banter: 6, callback: 5, meta: 3, greeting: 2,
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
export function nextGapMs(rnd = Math.random, opts = {}) {
  const drought = (opts.droughtP ?? 20) / 100;
  const scale = opts.gapScale || 1;
  return gapRaw(rnd, drought) / scale;
}

function gapRaw(rnd, drought) {
  const p = rnd();
  if (p < drought) return 4000 + rnd() * 4000;      // drought: nothing for 4–8 s
  if (p < drought + 0.12) return 1500 + rnd() * 1500;      // post-flurry settle
  return 2700 + rnd() * 3200;                    // normal turn-taking, 2.7–5.9 s
}

// what one tick fires. A flurry is 3 lines inside 1.5 s (offsets from now);
// `chant` means the whole burst is one emote repeated by different viewers.
export function planBurst(rnd = Math.random, opts = {}) {
  const flurry = (opts.flurryP ?? 30) / 100;   // total chance of a multi-line tick
  const p = rnd() * 0.30 / Math.max(flurry, 1e-9);   // rescale so defaults stay 10% / 20%
  if (p < 0.10) {
    const a = 380 + rnd() * 320;
    return { n: 3, offsets: [0, a, Math.min(1450, a + 380 + rnd() * 320)], chant: rnd() < 0.5 };
  }
  if (p < 0.30) return { n: 2, offsets: [0, 500 + rnd() * 700], chant: false };
  return { n: 1, offsets: [0], chant: false };
}

/* ---- pile-on: chat answers a change on screen with a wave ----
 * Measured 2026-10-28: once the change detector fired on real footage, chat in
 * the 10 s after a change still ran at 0.84× its normal rate — a change bought
 * one burst, then the usual gaps resumed. Real chat floods after a moment: a
 * flurry at once, quick follow-ups, then a breather that hands the time back.
 * Follow-ups lean on free emote lines so the wave costs little GPU. */
export const PILE_ON_MS = 10000;

// the tick a change pulls forward: always three lines, sometimes one chant
export function pileOnBurst(rnd = Math.random) {
  const a = 250 + rnd() * 350;
  return { n: 3, offsets: [0, a, a + 300 + rnd() * 450], chant: rnd() < 0.35 };
}
// one line per follow-up tick, every 0.9–1.6 s while the wave lasts
export const pileOnGap = (rnd = Math.random) => 900 + rnd() * 700;
// the first gap after the wave: chat catches its breath
export const breatherGap = (rnd = Math.random) => 6000 + rnd() * 4000;
// follow-ups lean on free emote lines so the wave costs little GPU. The wave is
// a hype moment — real floods after a change are emote-heavy — so it stays
// emote-forward even though calm chat is not (the 3-9% fingerprint is the calm
// baseline, not a burst).
export const pileOnKind = (rnd = Math.random) => (rnd() < 0.55 ? 'emote' : 'reaction');

// template lines — real chat is full of these and they cost no GPU
export const SMASH = ['asdfghjkl', 'ajskdlfj', 'sdkfjlsd', 'kdjfslkd', 'aksjdlkf'];
// plain-text fills, never emote codes: a code here that the loaded sets lack
// renders as a stray word ("WeirdChamp" in the 2026-10-28 phone run). Codes
// come from emote(), which only hands out loaded ones.
export const TEXT_FILLS = ['F', 'f', 'F in the chat', 'gg', 'o7'];
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

// one or two words that a real chatter hangs an emote on — measured emote
// lines usually DECORATE a sentence instead of replacing it
const EMOTE_TAG = ['nice', 'lmao', 'W', 'fr', 'real', 'classic', 'sheesh', 'o7', 'big W', 'insane'];

// `recent` is main.js's freshness ring: a canned question or fill the crowd
// just heard is skipped (chants repeat on purpose; emotes come from emote())
export function templateLine(kind, { emote = () => 'KEKW', hype = false, chant = null, recent = [] } = {}) {
  if (chant) return chant;
  if (kind === 'question') return pickFresh(QUESTIONS, recent);
  if (kind !== 'emote') return null;
  const r = Math.random();
  if (hype && r < 0.35) return SMASH[(Math.random() * SMASH.length) | 0];
  // real rooms: emote-only in 0.5-6% of ALL lines, ~2.2 emotes per emote line.
  // This branch used to return a bare emote 75% of the time.
  if (r < 0.30) return emote();
  if (r < 0.50) return `${emote()} ${emote()}`;
  if (r < 0.85) return `${EMOTE_TAG[(Math.random() * EMOTE_TAG.length) | 0]} ${emote()}`;
  return pickFresh(TEXT_FILLS, recent);
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

/* ---- conversation thread: the room talks to itself (Layer 2) ----
 * Law 2 (6 real rooms): 6-8% of lines reply to a specific earlier line and
 * name the person. The scheduler fired `reply` at ~4.5% and pickRecent rarely
 * landed on a name the reply could use, so the room read as a crowd, not a
 * room. When a line lands, a chatter answers *that person* within a short
 * window — a reply is pulled forward, not left to the dice. `threadP` is the
 * chance a line seeds a reply; `threadDelayMs` how long the reply waits. */
export const threadSeed = (rnd = Math.random, threadP = 0.16) => rnd() < threadP;
export const threadDelayMs = (rnd = Math.random) => 1200 + rnd() * 2600;

/* ---- contagion: echo, not rotation (Layer 4) ----
 * Law 4/7 (6 real rooms): a token enters the air, a decaying fraction of the
 * next N lines echo it, then it dies — `lol`×219, `aura`×194, `67`×120. Our
 * copypasta was template-driven and evenly spread (26% at small-room volume,
 * where real rooms paste 2-9%). This is the burst the metric wants: a spike
 * with a half-life, not a rotation. `seedContagion` picks a short token from a
 * line that just landed; `contagionEcho` is the decaying chance the next line
 * reuses it; the caller keeps the token alive for a few lines then drops it. */
// chat-native words that actually go viral — the fingerprint's `lol`/`aura`/`67`/
// `f`. A whitelist, not a stopword blacklist: prose words (`was`, `nam`) and
// proper names never become a chant, so only these are allowed into the air.
const ECHOABLE = new Set(['lol','lmao','oml','kekw','pog','poggers','aura','rizz','cap','fr','real','based','cooked','goated','goat','sheesh','slay','bet','sus','mid','bussin','banger','ratio','gyat','skibidi','ohio','brainrot','cope','seethe','diff','ez','gg','ggs','nice','insane','crazy','wild','67','o7','f','w','l']);

// a token worth echoing: a chat-native word that appears in the line. Returns
// null when the line has nothing viral in it (most lines — calm chat barely
// echoes; a real hook like "lol" or "aura" is what starts a burst).
export function seedContagion(text, rnd = Math.random, seedP = 0.25) {
  if (rnd() >= seedP) return null;
  const words = (text || '').toLowerCase().match(/[a-z0-9]{1,9}/g) || [];
  const cands = words.filter((w) => ECHOABLE.has(w));
  return cands.length ? cands[(rnd() * cands.length) | 0] : null;
}

// decaying echo probability: strong right after the seed, fades over `life`
// lines so the token spikes then dies instead of rotating forever.
export function contagionEcho(age, rnd = Math.random, { p0 = 0.5, life = 6 } = {}) {
  if (age >= life) return false;
  return rnd() < p0 * (1 - age / life);
}
