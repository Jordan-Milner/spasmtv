// chat-sim.js — fake-viewer metadata, chat DOM rendering, emote images,
// ❓/MVP badges, and the mod view (per-viewer card, yell, timeouts).
// No model logic lives here; generation context is main.js's job.

const COLORS = [
  '#ff4f4f', '#faaf19', '#00c78b', '#4f7dff', '#b22222', '#ff69b4',
  '#9147ff', '#00ad03', '#d2691e', '#5f9ea0', '#1e90ff', '#ff4500',
  '#2e8b57', '#daa520', '#8a2be2', '#5f9ea0',
];

const NAME_A = ['x', 'ttv_', 'lil', 'its', 'not', 'the', 'big', 'im', 'lil', '', '', ''];
const NAME_B = [
  'goose', 'moth', 'toast', 'nacho', 'waffle', 'rat', 'goblin', 'frog', 'doomer',
  'cactus', 'noodle', 'ghost', 'ham', 'squid', 'ferret', 'beans', 'pixel', 'blitz',
  'sock', 'crow', 'toaster', 'gremlin', 'opossum', 'newt', 'moth', 'pickle', 'duck',
  'loaf', 'sprocket', 'wisp', 'lemur', 'beetle',
];
const NAME_C = ['', '', '', '42', '99', '01', 'x', '7', '_live', 'tv', '_irl', '2000', '34'];

const YELLS = [
  'watch it.',
  'one more word and you are timed out.',
  'we can see you.',
  'behave. this is a wholesome stream.',
  'mods are awake, just so you know.',
  'you are testing the limits of my patience.',
  'we discussed you in the mod discord.',
];

const ARCHETYPES = {
  'hype-man':    { weight: 3, freq: 1.0, hint: 'you are the hype man — a few words at maximum energy, pile onto anything exciting (your lines get shouted in caps for you)',           case: 'upper', ellipsis: false, typo: 0.02, emote: 1.3 },
  'backseat':    { weight: 2, freq: 0.9, hint: 'a backseat gamer — tell the streamer what to do next, unprompted, with timestamps',       case: 'lower', ellipsis: false, typo: 0.03, emote: 0.8 },
  'lurker':      { weight: 4, freq: 0.4, hint: 'a lurker — nearly silent, post only a single word or emote now and then',                 case: 'lower', ellipsis: true,  typo: 0.02, emote: 1.0 },
  'regular':     { weight: 3, freq: 1.3, hint: 'a regular — treat something on screen like a running joke you\u2019ve seen every stream', case: 'lower', ellipsis: true,  typo: 0.04, emote: 1.0 },
  'earnest':     { weight: 2, freq: 0.8, hint: 'earnest — ask one genuine short question about the streamer or the room',                case: 'lower', ellipsis: true,  typo: 0.03, emote: 0.7 },
  'doomer':      { weight: 2, freq: 0.7, hint: 'a doomer — ironic defeatist, \\"this is who i am now\\" energy',                        case: 'lower', ellipsis: true,  typo: 0.05, emote: 0.8 },
  'parasocial':  { weight: 2, freq: 0.8, hint: 'parasocial — talk to the streamer like a close friend, bring up things you \\"remember\\"', case: 'lower', ellipsis: true,  typo: 0.04, emote: 1.0 },
  'troll':       { weight: 2, freq: 0.7, hint: 'a troll — skate the line, say something just barely dumb enough to draw a mod',          case: 'lower', ellipsis: false, typo: 0.03, emote: 1.0 },
  'newcomer':    { weight: 1, freq: 0.5, hint: 'a newcomer — first time here, ask what\u2019s going on',                                  case: 'lower', ellipsis: true,  typo: 0.03, emote: 0.6 },
  'copypasta':   { weight: 1, freq: 0.3, hint: 'a copypasta lurker — occasionally paste a classic wall of text verbatim',                case: 'mixed', ellipsis: false, typo: 0.00, emote: 0.5 },
};

// The 10 archetypes above. Kept as the single source of truth for roster
// assignment, message-frequency weighting, and the instruction personaHint.
const ARCHETYPE_KEYS = Object.keys(ARCHETYPES);

// persisted roster: names + archetypes survive reloads so regulars stay theirs
const ROSTER_KEY = 'spasmtv-roster';
const ROSTER_VERSION = 1;

// weighted pick of a random archetype from the roster table
function pickArchetype() {
  // total weight so Math.random() in [0,1) maps onto the weight axis
  const total = ARCHETYPE_KEYS.reduce((s, k) => s + ARCHETYPES[k].weight, 0);
  let r = Math.random() * total;
  for (const k of ARCHETYPE_KEYS) {
    r -= ARCHETYPES[k].weight;
    if (r <= 0) return k;
  }
  return ARCHETYPE_KEYS[0];
}

// weighted pick of an index into a pool, weighted by each viewer's archetype
// message-frequency — regulars dominate, lurkers and newcomers rarely post.
// `mult(viewer)` lets §D raise one archetype's share (trolls when the mods are quiet)
function pickByFreq(pool, mult = () => 1) {
  const total = pool.reduce((s, v) => s + (v.archetype.freq || 1) * mult(v), 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= (pool[i].archetype.freq || 1) * mult(pool[i]);
    if (r <= 0) return i;
  }
  return pool.length - 1;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function makeName() {
  const pick = (a) => a[(Math.random() * a.length) | 0];
  return (pick(NAME_A) + pick(NAME_B) + pick(NAME_C)).replace(/^_+/, '') || 'lurker';
}

const TIMEOUTS = [
  { label: '1s', ms: 1000 },
  { label: '30s', ms: 30000 },
  { label: '1m', ms: 60000 },
  { label: '5m', ms: 300000 },
  { label: '30m', ms: 1800000 },
  { label: '1h', ms: 3600e3 },
  { label: '1d', ms: 86400e3 },
  { label: '1w', ms: 604800e3 },
];

function hashStr(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

// deterministic flavor stats for the mod usercard — clearly a sim, but fun
function fakeStats(viewer) {
  const h = hashStr(viewer.name);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    followers: 3 + (h % 9000),
    created: `${2008 + (h % 17)}-${pad(1 + ((h >> 4) % 12))}-${pad(1 + ((h >> 8) % 28))}`,
    followingSince: `${2019 + ((h >> 6) % 7)}-${pad(1 + ((h >> 10) % 12))}-${pad(1 + ((h >> 14) % 28))}`,
    months: h % 49,
  };
}

export class ChatSim {
  constructor() {
    this.messagesEl = document.getElementById('chat-messages');
    this.scrollEl = document.getElementById('chat-scroll');
    this.viewerCountEl = document.getElementById('viewer-count');
    this.viewers = [];
    this.mvp = null;
    this.emotes = new Map();
    this.lastEmotes = [];   // codes rendered as images in the last line
    this.emoteRe = null;
    this.lastViewer = null;
    this.viewerCount = 0;
    this._viewerTimer = null;
  }

  setEmotes(map) {
    this.emotes = map;
    const codes = [...map.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
    this.emoteRe = codes.length
      ? new RegExp('(^|\\s)(' + codes.join('|') + ')(?=\\s|$)', 'g')
      : null;
  }

  _makeViewer(name, archetypeKey) {
    const archetype = ARCHETYPES[archetypeKey];
    return {
      name,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      archetype,          // the archetype object (hint + cosmetics + freq)
      archetypeKey,       // its key, e.g. "regular"
      personaHint: archetype.hint, // handed to the worker as the base persona
      q: 0, msgs: [], warned: false, bannedUntil: 0, justReturned: false,
      lastBanMs: 0, history: [],   // §D: what the mods have done to this viewer
    };
  }

  // Build (or rebuild) the roster. Names + archetypes are seeded once into
  // localStorage so the same regulars show up on every reload. A fresh browser
  // gets a new seed; an existing seed is reused and only grown.
  buildRoster(n = 34) {
    let seed = null;
    try { seed = JSON.parse(localStorage.getItem(ROSTER_KEY)); } catch {}
    if (!seed || seed.version !== ROSTER_VERSION || !Array.isArray(seed.viewers)) {
      seed = { version: ROSTER_VERSION, viewers: [] };
    }
    const seen = new Set();
    this.viewers = [];
    for (let i = 0; this.viewers.length < n; i++) {
      let name, archetypeKey;
      if (i < seed.viewers.length) {
        const s = seed.viewers[i];
        name = s.name;
        archetypeKey = ARCHETYPES[s.archetype] ? s.archetype : pickArchetype();
      } else {
        do { name = makeName(); } while (seen.has(name));
        archetypeKey = pickArchetype();
      }
      seen.add(name);
      this.viewers.push(this._makeViewer(name, archetypeKey));
    }
    // persist just the identity we care about (name + archetype)
    seed.viewers = this.viewers.map((v) => ({ name: v.name, archetype: v.archetypeKey }));
    try { localStorage.setItem(ROSTER_KEY, JSON.stringify(seed)); } catch {}
    this.mvp = null;
    this.lastViewer = null;
  }

  byName(name) { return this.viewers.find((v) => v.name === name); }

  activeViewers() {
    return this.viewers.filter((v) => !v.bannedUntil || v.bannedUntil < Date.now());
  }

  pickViewer(mult = () => 1) {
    const pool = this.activeViewers();
    if (!pool.length) return null;
    // weighted by archetype frequency — regulars/posts dominate, lurkers rare
    for (let attempt = 0; attempt < 8; attempt++) {
      const v = pool[pickByFreq(pool, mult)];
      if (v && v.name !== this.lastViewer) { this.lastViewer = v.name; return v; }
    }
    return pool[pickByFreq(pool, mult)];
  }

  // Client-side cosmetics applied to the DISPLAYED text only: a case style,
  // an occasional trailing ellipsis, a subtle typo, and (for high-emote
  // archetypes) a chance to tack on a real emote. The raw model text is what
  // gets logged, so the scorer never sees cosmetic noise.
  render(viewer, text) {
    let t = text;
    if (t.length > 4 && Math.random() < viewer.archetype.typo) {
      const words = t.split(' ');
      const wi = (Math.random() * words.length) | 0;
      const w = words[wi];
      if (w.length > 3) {
        const p = 1 + ((Math.random() * (w.length - 2)) | 0);
        if (w[p] !== w[p - 1])
          words[wi] = w.slice(0, p - 1) + w[p] + w[p - 1] + w.slice(p + 1);
      }
      t = words.join(' ');
    }
    if (viewer.archetype.case === 'upper') t = t.toLowerCase().toUpperCase();
    else if (viewer.archetype.case === 'mixed' && Math.random() < 0.3) {
      t = t.split('').map((c) => (Math.random() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join('');
    }
    if (viewer.archetype.ellipsis && Math.random() < 0.5 && !/[.!?…]$/.test(t)) t += '…';
    // emote affinity per archetype (§A): real chat carries an emote in about a
    // third of lines, so the affinity multiplies a base chance, not an excess
    if (!/[A-Z]{2,}$/.test(t) && Math.random() < (viewer.archetype.emote || 1) * 0.32)
      t += ' ' + this.randomEmote();
    return t;
  }

  _append(el) {
    const nearBottom =
      this.scrollEl.scrollHeight - this.scrollEl.scrollTop - this.scrollEl.clientHeight < 60;
    this.messagesEl.appendChild(el);
    while (this.messagesEl.children.length > 250) this.messagesEl.firstChild.remove();
    if (nearBottom) this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }

  _formatText(text) {
    let html = escapeHtml(text);
    this.lastEmotes = [];
    if (this.emoteRe) {
      html = html.replace(this.emoteRe, (m, ws, code) => {
        const url = this.emotes.get(code);
        this.lastEmotes.push(code);   // what the §F emote metric measures
        return `${ws}<img class="emote-img" alt="${code}" title="${code}" src="${url}" loading="lazy"/>`;
      });
    }
    return html;
  }

  chat(text, viewer = this.pickViewer()) {
    if (!viewer || (viewer.bannedUntil && viewer.bannedUntil > Date.now())) return null;
    // a viewer repeating their own line verbatim reads as a glitch, not a bit —
    // the worker dedupes model lines globally, this catches the rest per-viewer
    const norm = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (viewer.msgs.slice(-5).some((m) => norm(m.text) === norm(text))) return null;
    const isQ = text.includes('?');
    if (isQ) {
      viewer.q += 1;
      const top = this.activeViewers().reduce((a, b) => (b.q > (a ? a.q : 0) ? b : a), null);
      if (top && top.q >= 2 && this.mvp !== top) {
        this.mvp = top;
        this.system(`${top.name} is chat MVP 😎`);
      }
    }
    viewer.msgs.push({ t: Date.now(), text });
    if (viewer.msgs.length > 30) viewer.msgs.shift();

    const badge = this.mvp === viewer
      ? '<span class="ubadge mvp">MVP</span>'
      : isQ ? '<span class="ubadge q">❓</span>' : '';

    const shown = this.render(viewer, text);
    this.lastRendered = shown;   // what the viewer actually read — the log needs it
    const el = document.createElement('div');
    el.className = 'msg';
    el.innerHTML =
      `${badge}<span class="user" style="color:${viewer.color}"></span>` +
      `<span class="sep">: </span><span class="text"></span>`;
    el.querySelector('.user').textContent = viewer.name;
    el.querySelector('.text').innerHTML = this._formatText(shown);
    this._append(el);
    return viewer;
  }

  system(text) {
    const el = document.createElement('div');
    el.className = 'msg system';
    el.textContent = text;
    this._append(el);
  }

  mod(text) {
    const el = document.createElement('div');
    el.className = 'msg modmsg';
    el.textContent = text;
    this._append(el);
  }

  streamer(text) {
    const el = document.createElement('div');
    el.className = 'msg streamer';
    el.innerHTML = '<span class="badge">STREAMER</span><span class="text"></span>';
    el.querySelector('.text').innerHTML = this._formatText(text);
    this._append(el);
  }

  randomEmote() {
    if (!this.emotes.size) return 'KEKW';
    const codes = [...this.emotes.keys()].filter((k) => k.length <= 10);
    return (codes.length ? codes : [...this.emotes.keys()])[(Math.random() * (codes.length || this.emotes.size)) | 0];
  }

  setViewerCount(n) {
    this.viewerCount = n;
    this.viewerCountEl.textContent = n.toLocaleString();
  }

  startViewerDrift(base = 27) {
    this.setViewerCount(base);
    clearInterval(this._viewerTimer);
    this._viewerTimer = setInterval(() => {
      const drift = (Math.random() * 6 - 2.6) | 0;
      this.setViewerCount(Math.max(6, this.viewerCount + drift));
    }, 4500);
  }

  stopViewerDrift() { clearInterval(this._viewerTimer); }

  /* ---------------- mod view ----------------
   * Every action records itself on the viewer (the card shows the history) and
   * fires onModAction so main.js can run the culture loop (§D). chat-sim stays
   * free of model logic — it reports, main.js reacts. */

  _modAction(viewer, action, label) {
    this._acting = true;
    setTimeout(() => { this._acting = false; }, 0);
    viewer.history.unshift({ action, label: label || '', t: Date.now() });
    if (viewer.history.length > 6) viewer.history.pop();
    this.onModAction?.({ action, viewer, label });
  }

  yell(viewer) {
    viewer.warned = true;
    this.mod(`🛡️ @${viewer.name} — ${YELLS[(Math.random() * YELLS.length) | 0]}`);
    this._modAction(viewer, 'yell');
  }

  warn(viewer) {
    viewer.warned = true;
    this.mod(`⚠️ @${viewer.name} — that's a formal warning.`);
    this._modAction(viewer, 'warn');
  }

  ban(viewer, ms, label) {
    viewer.bannedUntil = Date.now() + ms;
    viewer.lastBanMs = ms;
    if (ms > 1000) viewer.justReturned = true;
    this.system(`@${viewer.name} has been timed out (${label}) 🪓`);
    if (ms === 1000) {
      setTimeout(() => {
        viewer.bannedUntil = 0;
        this.system(`@${viewer.name} survived the 1 second ban`);
      }, 1400);
    }
    this._renderModCard(viewer);
    this._modAction(viewer, 'timeout', label);
  }

  banForever(viewer) {
    viewer.bannedUntil = Infinity;
    viewer.justReturned = true;
    viewer.lastBanMs = Infinity;
    this.system(`@${viewer.name} has been banned 🪦`);
    this._renderModCard(viewer);
    this._modAction(viewer, 'ban');
  }

  unban(viewer) {
    viewer.bannedUntil = 0;
    viewer.justReturned = true;
    this.system(`@${viewer.name} was unbanned. pray.`);
    this._renderModCard(viewer);
    this._modAction(viewer, 'unban');
  }

  openModCard(viewer, x, y) {
    let card = document.getElementById('modcard');
    if (!card) {
      card = document.createElement('div');
      card.id = 'modcard';
      document.body.appendChild(card);
      card.addEventListener('pointerdown', (e) => {
        if (!e.target.closest('.mc-head') || e.target.closest('button')) return;
        const startX = e.clientX - card.offsetLeft;
        const startY = e.clientY - card.offsetTop;
        const move = (ev) => {
          card.style.left =
            Math.max(4, Math.min(window.innerWidth - card.offsetWidth - 4, ev.clientX - startX)) + 'px';
          card.style.top =
            Math.max(4, Math.min(window.innerHeight - card.offsetHeight - 4, ev.clientY - startY)) + 'px';
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      document.addEventListener('click', (e) => {
        // an action button re-renders the card (innerHTML) mid-click, so by the time
        // the click bubbles here the button is detached — _acting covers that window
        if (card.hidden || this._acting || card.contains(e.target) || e.target.closest('.user')) return;
        card.hidden = true;
        this.onUncenter?.(card._viewer);
      });
    }
    const wasCentered = card._viewer;
    card._viewer = viewer;
    card.hidden = false;
    card.style.left = Math.min(x, window.innerWidth - 300) + 'px';
    card.style.top = Math.min(y, Math.max(8, window.innerHeight - 380)) + 'px';
    this._renderModCard(viewer);
    if (wasCentered !== viewer) this.onCenter?.(viewer);   // §D: the crowd notices
  }

  // the card's ✕ — main.js needs to know the spot was vacated with no action
  _closeCard(card) {
    const v = card._viewer;
    card.hidden = true;
    this.onUncenter?.(v);
  }

  _renderModCard(viewer) {
    const card = document.getElementById('modcard');
    if (!card || card.hidden || card._viewer !== viewer) return;
    const banned = viewer.bannedUntil > Date.now();
    const st = fakeStats(viewer);
    card.innerHTML = `
      <div class="mc-head">
        <div class="mc-title">Mod View</div>
        <div class="mc-id">
          <div class="mc-namerow">
            <b style="color:${viewer.color}">${escapeHtml(viewer.name)}</b>
            <span class="mc-chip">ID: ${(hashStr(viewer.name) % 90000000) + 10000000}</span>
          </div>
          <div class="mc-stat">Followers: ${st.followers.toLocaleString()}</div>
          <div class="mc-stat">Created: ${st.created}</div>
          <div class="mc-stat">♥ Following since ${st.followingSince}</div>
          <div class="mc-stat">★ Previously subscribed for ${st.months} month${st.months === 1 ? '' : 's'}</div>
        </div>
        <span class="mc-close">✕</span>
      </div>
      <div class="mc-pills">
        <button class="mc-yell">🛡 Yell</button>
        <button class="mc-warn">⚠ Warn</button>
        ${viewer.warned ? '<span class="ubadge q">on thin ice</span>' : ''}
        ${banned ? '<span class="ubadge mvp">timed out</span>' : ''}
      </div>
      <div class="mc-strip">
        <button class="mc-unban" title="Unban">⚡</button>
        <span class="mc-strip-label">Timeouts</span>
        <button class="mc-banforever" title="Ban forever">🚫</button>
      </div>
      <div class="mc-durs">
        ${TIMEOUTS.map((t) => `<button data-ms="${t.ms}" data-label="${t.label}">${t.label}</button>`).join('')}
        <button class="mc-custom">custom</button>
      </div>
      <div class="mc-msgs"></div>`;

    card.querySelector('.mc-close').onclick = () => this._closeCard(card);
    card.querySelector('.mc-yell').onclick = () => { this.yell(viewer); this._renderModCard(viewer); };
    card.querySelector('.mc-warn').onclick = () => { this.warn(viewer); this._renderModCard(viewer); };
    card.querySelectorAll('[data-ms]').forEach((b) => {
      b.onclick = () => this.ban(viewer, +b.dataset.ms, b.dataset.label);
    });
    card.querySelector('.mc-custom').onclick = () => {
      const mins = parseFloat(prompt(`Custom timeout for ${viewer.name} (minutes):`, '10'));
      if (mins > 0) this.ban(viewer, Math.min(mins * 60e3, 31e9), `${mins} min`);
    };
    card.querySelector('.mc-unban').onclick = () => this.unban(viewer);
    card.querySelector('.mc-banforever').onclick = () => this.banForever(viewer);

    const box = card.querySelector('.mc-msgs');
    const recent = viewer.msgs.slice(-12);
    const history = viewer.history.length
      ? `<div class="mc-msg history">last actions: ${viewer.history
          .map((h) => `${h.action}${h.label ? ` (${h.label})` : ''}`).join(' · ')}</div>`
      : '<div class="mc-msg history dim">no actions taken</div>';
    box.innerHTML = history + (recent.length
      ? recent.map((m) =>
          `<div class="mc-msg${viewer.warned ? ' hot' : ''}">` +
          `<span style="color:${viewer.color}">${escapeHtml(viewer.name)}</span> ` +
          `${escapeHtml(m.text)}</div>`).join('')
      : '<div class="mc-msg dim">no messages yet</div>');
  }
}

export { ARCHETYPES, ARCHETYPE_KEYS, pickArchetype, pickByFreq, ROSTER_KEY, ROSTER_VERSION };
