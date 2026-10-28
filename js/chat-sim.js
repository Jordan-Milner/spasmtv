// chat-sim.js — fake-viewer metadata + chat DOM rendering. No model logic lives here.

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

const EMOTES = [
  'KEKW', 'LUL', 'PogChamp', 'POGGERS', 'monkaS', 'Sadge', 'Clap', '5Head',
  'PepeLaugh', 'widepeepoHappy', 'Kappa', 'HeyGuys', 'NotLikeThis', 'peepoHappy',
  'EZ Clap', 'BibleThump', 'catJAM', 'Pog',
];

const EMOTE_RE = new RegExp(
  '(' + ['KEKW', 'LUL', 'PogChamp', 'POGGERS', 'monkaS', 'Sadge', 'Clap', '5Head',
    'PepeLaugh', 'widepeepoHappy', 'Kappa', 'HeyGuys', 'NotLikeThis', 'peepoHappy',
    'EZ Clap', 'BibleThump', 'catJAM', 'Pog'].map(escapeRe).join('|') + ')',
  'g'
);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function makeName() {
  const pick = a => a[(Math.random() * a.length) | 0];
  return (pick(NAME_A) + pick(NAME_B) + pick(NAME_C)).replace(/^_+/, '') || 'lurker';
}

export class ChatSim {
  constructor() {
    this.messagesEl = document.getElementById('chat-messages');
    this.scrollEl = document.getElementById('chat-scroll');
    this.viewerCountEl = document.getElementById('viewer-count');
    this.viewers = [];
    this.lastViewer = null;
    this.viewerCount = 0;
    this._viewerTimer = null;
  }

  buildRoster(n = 34) {
    const seen = new Set();
    this.viewers = [];
    while (this.viewers.length < n) {
      const name = makeName();
      if (seen.has(name)) continue;
      seen.add(name);
      this.viewers.push({ name, color: COLORS[this.viewers.length % COLORS.length] });
    }
  }

  pickViewer() {
    for (let i = 0; i < 6; i++) {
      const v = this.viewers[(Math.random() * this.viewers.length) | 0];
      if (v.name !== this.lastViewer) { this.lastViewer = v.name; return v; }
    }
    return this.viewers[0];
  }

  _append(el) {
    const nearBottom =
      this.scrollEl.scrollHeight - this.scrollEl.scrollTop - this.scrollEl.clientHeight < 60;
    this.messagesEl.appendChild(el);
    while (this.messagesEl.children.length > 250) this.messagesEl.firstChild.remove();
    if (nearBottom) this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }

  _formatText(text) {
    return escapeHtml(text).replace(EMOTE_RE, '<b class="emote">$1</b>');
  }

  chat(text, viewer = this.pickViewer()) {
    const el = document.createElement('div');
    el.className = 'msg';
    el.innerHTML =
      `<span class="user" style="color:${viewer.color}"></span>` +
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

  streamer(text) {
    const el = document.createElement('div');
    el.className = 'msg streamer';
    el.innerHTML = '<span class="badge">STREAMER</span><span class="text"></span>';
    el.querySelector('.text').innerHTML = this._formatText(text);
    this._append(el);
  }

  randomEmote() { return EMOTES[(Math.random() * EMOTES.length) | 0]; }

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
}
