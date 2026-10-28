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
];

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
  { label: '1 sec', ms: 1000 },
  { label: '1 hour', ms: 3600e3 },
  { label: '1 day', ms: 86400e3 },
  { label: '1 week', ms: 604800e3 },
];

export class ChatSim {
  constructor() {
    this.messagesEl = document.getElementById('chat-messages');
    this.scrollEl = document.getElementById('chat-scroll');
    this.viewerCountEl = document.getElementById('viewer-count');
    this.viewers = [];
    this.mvp = null;
    this.emotes = new Map();
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

  buildRoster(n = 34) {
    const seen = new Set();
    this.viewers = [];
    while (this.viewers.length < n) {
      const name = makeName();
      if (seen.has(name)) continue;
      seen.add(name);
      this.viewers.push({
        name, color: COLORS[this.viewers.length % COLORS.length],
        q: 0, msgs: [], warned: false, bannedUntil: 0, justReturned: false,
      });
    }
    this.mvp = null;
  }

  byName(name) { return this.viewers.find((v) => v.name === name); }

  activeViewers() {
    return this.viewers.filter((v) => !v.bannedUntil || v.bannedUntil < Date.now());
  }

  pickViewer() {
    const pool = this.activeViewers();
    for (let i = 0; i < 6; i++) {
      const v = pool[(Math.random() * pool.length) | 0];
      if (v && v.name !== this.lastViewer) { this.lastViewer = v.name; return v; }
    }
    return pool[0] || null;
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
    if (this.emoteRe) {
      html = html.replace(this.emoteRe, (m, ws, code) => {
        const url = this.emotes.get(code);
        return `${ws}<img class="emote-img" alt="${code}" title="${code}" src="${url}" loading="lazy"/>`;
      });
    }
    return html;
  }

  chat(text, viewer = this.pickViewer()) {
    if (!viewer || (viewer.bannedUntil && viewer.bannedUntil > Date.now())) return null;
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

    const el = document.createElement('div');
    el.className = 'msg';
    el.innerHTML =
      `${badge}<span class="user" style="color:${viewer.color}"></span>` +
      `<span class="sep">: </span><span class="text"></span>`;
    el.querySelector('.user').textContent = viewer.name;
    el.querySelector('.text').innerHTML = this._formatText(text);
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

  /* ---------------- mod view ---------------- */

  yell(viewer) {
    viewer.warned = true;
    this.mod(`🛡️ @${viewer.name} — ${YELLS[(Math.random() * YELLS.length) | 0]}`);
  }

  ban(viewer, ms, label) {
    viewer.bannedUntil = Date.now() + ms;
    if (ms > 1000) viewer.justReturned = true;
    this.system(`@${viewer.name} has been timed out (${label}) 🪓`);
    if (ms === 1000) {
      setTimeout(() => {
        viewer.bannedUntil = 0;
        this.system(`@${viewer.name} survived the 1 second ban`);
      }, 1400);
    }
    this._renderModCard(viewer);
  }

  unban(viewer) {
    viewer.bannedUntil = 0;
    viewer.justReturned = true;
    this.system(`@${viewer.name} was unbanned. pray.`);
    this._renderModCard(viewer);
  }

  openModCard(viewer, x, y) {
    let card = document.getElementById('modcard');
    if (!card) {
      card = document.createElement('div');
      card.id = 'modcard';
      document.body.appendChild(card);
      document.addEventListener('click', (e) => {
        if (!card.hidden && !card.contains(e.target) && !e.target.closest('.user')) card.hidden = true;
      });
    }
    card._viewer = viewer;
    card.hidden = false;
    const pad = 12, w = 280;
    card.style.left = Math.min(x, window.innerWidth - w - pad) + 'px';
    card.style.top = Math.min(y, window.innerHeight - 320) + 'px';
    this._renderModCard(viewer);
  }

  _renderModCard(viewer) {
    const card = document.getElementById('modcard');
    if (!card || card.hidden || card._viewer !== viewer) return;
    const banned = viewer.bannedUntil > Date.now();
    card.innerHTML = `
      <div class="mc-head">
        <b style="color:${viewer.color}">${escapeHtml(viewer.name)}</b>
        ${viewer.warned ? '<span class="ubadge q">warned</span>' : ''}
        ${banned ? '<span class="ubadge mvp">banned</span>' : ''}
        <span class="mc-close">✕</span>
      </div>
      <div class="mc-msgs"></div>
      <div class="mc-actions">
        <button class="mc-yell">Yell</button>
        ${TIMEOUTS.map((t) => `<button data-ms="${t.ms}" data-label="${t.label}">${t.label}</button>`).join('')}
        <button class="mc-custom">custom</button>
        <button class="mc-unban">unban</button>
      </div>`;
    card.querySelector('.mc-close').onclick = () => { card.hidden = true; };
    card.querySelector('.mc-yell').onclick = () => { this.yell(viewer); this._renderModCard(viewer); };
    card.querySelectorAll('[data-ms]').forEach((b) => {
      b.onclick = () => this.ban(viewer, +b.dataset.ms, b.dataset.label);
    });
    card.querySelector('.mc-custom').onclick = () => {
      const mins = parseFloat(prompt(`Custom timeout for ${viewer.name} (minutes):`, '10'));
      if (mins > 0) this.ban(viewer, Math.min(mins * 60e3, 31e9), `${mins} min`);
    };
    card.querySelector('.mc-unban').onclick = () => this.unban(viewer);

    const box = card.querySelector('.mc-msgs');
    const recent = viewer.msgs.slice(-12);
    box.innerHTML = recent.length
      ? recent.map((m) => `<div class="mc-msg">${escapeHtml(m.text)}</div>`).join('')
      : '<div class="mc-msg dim">no messages yet</div>';
  }
}
