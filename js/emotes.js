// emotes.js — global Twitch-culture emote sets from open CDNs (BTTV / FFZ / 7TV).
// No auth, no backend: the page fetches the public set lists and hotlinks the
// CDN images directly. If every fetch fails we fall back to styled text codes.

export async function loadEmotes() {
  const map = new Map(); // code → url
  const add = (code, url) => {
    if (!code || !url) return;
    code = String(code).trim();
    if (!code || code.length > 20 || map.has(code)) return;
    map.set(code, url);
  };

  try {
    const r = await fetch('https://api.betterttv.net/3/cached/emotes/global').then((r) => r.json());
    for (const e of r || []) add(e.code, `https://cdn.betterttv.net/emote/${encodeURIComponent(e.id)}/2x`);
  } catch {}

  try {
    const r = await fetch('https://api.frankerfacez.com/v1/set/global').then((r) => r.json());
    for (const sid of r?.default_sets || [])
      for (const em of r.sets?.[sid]?.emoticons || [])
        add(em.name, em.urls?.[2] || em.urls?.[1] || em.urls?.[4]);
  } catch {}

  try {
    const r = await fetch('https://7tv.io/v3/emote-sets/global').then((r) => r.json());
    for (const e of r?.emotes || [])
      add(e.name, `https://cdn.7tv.app/emote/${encodeURIComponent(e.id)}/2x.webp`);
  } catch {}

  return map;
}

// short, chat-shaped codes the model can plausibly be steered toward
export function emoteHintFrom(map, max = 26) {
  return [...map.keys()]
    .filter((k) => /^[A-Za-z]\w{1,11}$/.test(k))
    .sort((a, b) => a.length - b.length)
    .slice(0, max);
}
