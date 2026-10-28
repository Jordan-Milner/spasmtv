// culture.js — §D, the moderation-tuned crowd, as pure functions. Who the mods
// ban changes what chat becomes: a standing note about what gets you banned,
// factioned bursts when it happens, trolls who gain ground while nobody is
// moderated, and a mood that sours over a purge. Pure so tools/test-culture.mjs
// can assert the loop without a browser.

import { normTokens } from './text.js';

// the three factions a ban splits a chat into. {name} is the victim.
export const FACTIONS = {
  mourner: ['F', 'rip {name}', 'he was funny tho', 'not the ban', 'biggest loss for chat', 'F for {name}'],
  bootlicker: ["mods doing god's work", 'finally', 'justice is real', 'mod app when', 'thank you mods', 'the mods are the real heroes'],
  critic: ['free {name}', 'mods on one', 'what did {name} even do', 'ban abuse fr', 'he was the content', 'this is why chat is dead'],
};

// a reactor picks a side by who they are: trolls defend trolls, parasocials
// side with the streamer, lurkers just press F
export function factionFor(archetypeKey, rnd = Math.random) {
  const r = rnd();
  switch (archetypeKey) {
    case 'troll': return r < 0.7 ? 'critic' : 'mourner';
    case 'parasocial': return r < 0.7 ? 'bootlicker' : 'mourner';
    case 'hype-man': return r < 0.5 ? 'mourner' : 'bootlicker';
    case 'doomer': return r < 0.6 ? 'mourner' : 'critic';
    case 'regular': return r < 0.55 ? 'mourner' : 'critic';
    case 'lurker': return 'mourner';
    case 'backseat': return r < 0.5 ? 'critic' : 'bootlicker';
    default: return ['mourner', 'bootlicker', 'critic'][(r * 3) | 0];
  }
}

export function cultureLine(faction, victimName, rnd = Math.random) {
  const pool = FACTIONS[faction] || FACTIONS.mourner;
  return pool[(rnd() * pool.length) | 0].replace(/\{name\}/g, victimName);
}

// crude pattern extraction: the tokens the victim kept saying. Repeated tokens
// first; with almost nothing to go on, the longest word in the last message.
export function patternOf(msgs = []) {
  const counts = new Map();
  for (const m of msgs)
    for (const w of normTokens(m.text || m))
      if (w.length > 2) counts.set(w, (counts.get(w) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const repeated = ranked.filter(([, c]) => c >= 2).slice(0, 3).map(([w]) => w);
  if (repeated.length) return repeated.join(' ');
  const last = msgs[msgs.length - 1];
  const words = normTokens(last?.text || last || '').filter((w) => w.length > 3);
  // nothing repeated → one token, the longest, ties going to the newest word
  return words.sort((a, b) => a.length - b.length).pop() || '';
}

// how loud trolls are right now: 1× straight after a mod action, up to 3× when
// the mods have been quiet for 10+ min. The community needs its mod.
export function trollWeight(now, lastActionAt, base = 1) {
  const mins = Math.max(0, (now - lastActionAt) / 60000);
  return base * (1 + Math.min(2, mins / 5));
}

// who ignores the standing rule: trolls basically dare you, everyone else obeys
export function defies(archetypeKey, note, rnd = Math.random) {
  if (!note) return false;
  const p = archetypeKey === 'troll' ? 0.4
    : archetypeKey === 'copypasta' ? 0.2
    : archetypeKey === 'doomer' || archetypeKey === 'regular' ? 0.1
    : 0.03;
  return rnd() < p;
}

// mood drift: a purge makes chat quieter and resentful
export function moodOf(actions, now = Date.now(), windowMs = 180e3) {
  const n = (actions || []).filter((a) => now - a.t < windowMs).length;
  return n >= 4 ? 'purge' : n >= 2 ? 'tense' : 'calm';
}

export const MOOD_GAP = { calm: 1, tense: 1.12, purge: 1.3 };   // quieter chat
export const DEAD_CHAT_LINES = [
  'chat so dead since the purge', 'where is everyone', 'quiet chat today…',
  'mods cleared the place out', 'we lost the good ones',
];

// centering (opening someone's card) — the crowd notices
export const ONLOOKER_LINES = [
  'mods looking at {name}', '{name} is COOKED', 'what did {name} do',
  'chat what is happening', 'someone warn him', 'oh no', '{name} got the card',
];
export const RELIEF_LINES = [
  'false alarm', 'mods were just admiring his profile', 'he is safe??',
  'chat exhaled', 'no ban?? worst modding', 'card without a ban is a flex',
];
// the centered viewer gets one guaranteed line, by who they are
export function spotLine(archetypeKey, rnd = Math.random) {
  const pick = (a) => a[(rnd() * a.length) | 0];
  switch (archetypeKey) {
    case 'troll': return pick(['worth it', 'do your worst', 'im not sorry', 'ban me and chat dies']);
    case 'earnest': return pick(['what did i do??', 'im behaving i promise', 'i did nothing!!', 'why is my card open']);
    case 'parasocial': return pick(['you believe me right', 'i would never do that', 'we are friends though']);
    case 'hype-man': return pick(['THIS IS THE CONTENT', 'BIGGEST MOMENT OF THE STREAM']);
    case 'doomer': return pick(['knew it', 'this is who i am now', 'of course its me']);
    default: return pick(['im behaving im behaving', 'this is a misunderstanding', 'mods so serious today']);
  }
}
