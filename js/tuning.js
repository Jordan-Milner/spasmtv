// tuning.js — every knob that shapes the chat, in one schema. The settings
// panel is generated from TUNE_SCHEMA, values persist in localStorage, and the
// live `tune` object is mutated in place so any module can read tune.<key>
// at use time (no restart needed, except where noted on the control).

const KEY = 'spasmtv-tune';

// type: 'range' (min/max/step) | 'check' | 'text'. `worker:true` keys ride along
// on every chat request so llm-worker.js can use them.
export const TUNE_SCHEMA = [
  { group: 'Brain sampling', open: true, items: [
    { key: 'temperature', label: 'temperature', type: 'range', min: 0.3, max: 1.5, step: 0.05, def: 0.85, worker: true, help: 'higher = wilder, lower = safer/blander' },
    { key: 'topP', label: 'top-p', type: 'range', min: 0.5, max: 1, step: 0.01, def: 0.95, worker: true, help: 'Nucleus sampling: only the most likely tokens that add up to this probability are considered. Lower = more predictable.' },
    { key: 'topK', label: 'top-k (0 = off)', type: 'range', min: 0, max: 100, step: 1, def: 0, worker: true, help: 'cuts the long tail of weird tokens' },
    { key: 'repPenalty', label: 'repetition penalty', type: 'range', min: 1, max: 1.5, step: 0.01, def: 1.15, worker: true, help: 'too high makes a 450M model babble to avoid repeating itself' },
    { key: 'maxNewTokens', label: 'max tokens / line', type: 'range', min: 8, max: 60, step: 1, def: 20, worker: true, help: 'Hard cap on tokens generated per chat line. Short caps cut rambling and speed up chat.' },
    { key: 'maxWords', label: 'trim lines to N words', type: 'range', min: 4, max: 30, step: 1, def: 14, worker: true, help: 'Lines longer than this are trimmed with an ellipsis after generation.' },
  ]},
  { group: 'Prompt', open: true, items: [
    { key: 'seedWords', label: 'scene keywords given to the model', type: 'range', min: 1, max: 12, step: 1, def: 6, worker: true, help: 'was 3 — with so few the model has nothing to react to and goes generic' },
    { key: 'styleExamples', label: 'real-chat style examples', type: 'range', min: 0, max: 6, step: 1, def: 3, worker: true, help: 'few-shot lines shaped like real Twitch chat; the strongest lever against bland output' },
    { key: 'extraDirection', label: 'extra direction (added to every prompt)', type: 'text', def: '', worker: true, help: 'e.g. "chat is roasting the streamer" or "everyone loves this"' },
  ]},
  { group: 'Filters', items: [
    { key: 'echoScene', label: 'caption-echo cutoff (Jaccard)', type: 'range', min: 0.2, max: 0.9, step: 0.05, def: 0.5, worker: true, help: 'lower = stricter against lines that repeat the caption' },
    { key: 'priorSim', label: 'repeat-of-recent cutoff', type: 'range', min: 0.4, max: 1, step: 0.05, def: 0.75, worker: true, help: 'A new line this similar (word overlap) to something recent is thrown away. Lower = stricter anti-repeat.' },
    { key: 'genderDamp', label: 'drop gendered lines %', type: 'range', min: 0, max: 100, step: 5, def: 50, worker: true, help: 'Chance to drop a line that calls the streamer he/she/man/girl. Small models over-assume gender.' },
    { key: 'keysmash', label: 'reject keysmash', type: 'check', def: true, worker: true, help: 'Reject lines that are mostly vowel-less gibberish like "EZERLAFUNKEBOH". Leave on.' },
  ]},
  { group: 'Cadence', items: [
    { key: 'gapScale', label: 'chat speed (×)', type: 'range', min: 0.3, max: 3, step: 0.1, def: 1, help: '2 = twice as many ticks. Watch the GPU latency chip.' },
    { key: 'droughtP', label: 'drought chance %', type: 'range', min: 0, max: 60, step: 1, def: 20, help: 'Chance that chat goes quiet for 4–8 seconds instead of keeping a steady beat.' },
    { key: 'flurryP', label: 'flurry (burst) chance %', type: 'range', min: 0, max: 80, step: 1, def: 30, help: 'Chance that a tick fires 2–3 lines at once (pile-ons and chants).' },
    { key: 'maxPending', label: 'max concurrent generations', type: 'range', min: 1, max: 4, step: 1, def: 2, help: 'lines are dropped (not queued) beyond this' },
    { key: 'banModelChance', label: 'model line in ban reactions %', type: 'range', min: 0, max: 100, step: 5, def: 55, help: 'When someone is banned, the chance one of the reaction lines is written by the model instead of a template. Templates are instant and free.' },
  ]},
  { group: 'What chat says (kind mix)', items: [
    { key: 'kw_reaction', label: 'reactions', type: 'range', min: 0, max: 100, step: 1, def: 39, help: 'Relative weight for lines that react to what is on screen.' },
    { key: 'kw_emote', label: 'emote-only (free)', type: 'range', min: 0, max: 100, step: 1, def: 13, help: 'Relative weight for emote-only lines, F spam and chants. These cost no GPU.' },
    { key: 'kw_question', label: 'questions', type: 'range', min: 0, max: 100, step: 1, def: 21, help: 'Relative weight for viewers asking a short question.' },
    { key: 'kw_backseat', label: 'backseat', type: 'range', min: 0, max: 100, step: 1, def: 8, help: 'Relative weight for viewers telling the streamer what to do.' },
    { key: 'kw_reply', label: 'replies', type: 'range', min: 0, max: 100, step: 1, def: 6, help: 'Relative weight for viewers replying to a specific earlier line.' },
    { key: 'kw_banter', label: 'banter', type: 'range', min: 0, max: 100, step: 1, def: 6, help: 'Relative weight for viewers talking to each other instead of the stream.' },
    { key: 'kw_callback', label: 'callbacks / bits', type: 'range', min: 0, max: 100, step: 1, def: 5, help: 'Relative weight for running jokes resurfacing. Only fires once a bit exists.' },
    { key: 'kw_meta', label: 'meta', type: 'range', min: 0, max: 100, step: 1, def: 3, help: 'Relative weight for chatter about the stream itself: lag, title, viewer count.' },
    { key: 'kw_greeting', label: 'greetings', type: 'range', min: 0, max: 100, step: 1, def: 2, help: 'Relative weight for new arrivals saying hi. Only fires during hype.' },
  ]},
  { group: 'Who talks (archetype volume ×)', items: [
    ...['hype-man', 'backseat', 'lurker', 'regular', 'earnest', 'doomer', 'parasocial', 'troll', 'newcomer', 'copypasta']
      .map((a) => ({ key: 'freq_' + a, label: a, type: 'range', min: 0, max: 3, step: 0.1, def: 1, help: 'How much this kind of viewer talks. 0 = muted, 3 = dominates chat. Applies live.' })),
  ]},
  { group: 'Moderation culture', items: [
    { key: 'trollBase', label: 'troll volume ×', type: 'range', min: 0, max: 4, step: 0.1, def: 1, help: 'also scales up on its own the longer mods stay quiet' },
    { key: 'defiance', label: 'rule-breaking ×', type: 'range', min: 0, max: 4, step: 0.1, def: 1, help: 'how often viewers break the standing "mods ban for it" rule' },
  ]},
  { group: 'Vision timing', items: [
    { key: 'sceneChange', label: 'scene-change sensitivity', type: 'range', min: 0.01, max: 0.2, step: 0.005, def: 0.055, help: 'lower = more things count as "something changed"' },
    { key: 'tickFrame', label: 'frame grab every (ms)', type: 'range', min: 500, max: 5000, step: 100, def: 1500, help: 'How often a frame is grabbed to check for motion. Faster costs CPU, not GPU.' },
    { key: 'tickCaption', label: 're-caption every (ms)', type: 'range', min: 2000, max: 20000, step: 500, def: 8000, help: 'How often the scene is re-described by the vision model. Slower = less GPU but staler context.' },
  ]},
];

export const tune = {};
const DEFAULTS = {};
for (const g of TUNE_SCHEMA) for (const it of g.items) DEFAULTS[it.key] = it.def;
Object.assign(tune, DEFAULTS);

export function loadTune() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const k of Object.keys(DEFAULTS)) if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) tune[k] = saved[k];
  } catch { /* storage blocked — defaults */ }
}
export function saveTune() {
  try { localStorage.setItem(KEY, JSON.stringify(tune)); } catch {}
}
export function resetTune(keys) {
  for (const k of keys || Object.keys(DEFAULTS)) tune[k] = DEFAULTS[k];
  saveTune();
}

export function kindWeights() {
  const w = {};
  for (const k of ['reaction', 'emote', 'question', 'backseat', 'reply', 'banter', 'callback', 'meta', 'greeting']) w[k] = tune['kw_' + k];
  return Object.values(w).some((v) => v > 0) ? w : { reaction: 1 };
}

// the subset the worker needs, sent with every chat request
export function workerTune() {
  const o = {};
  for (const g of TUNE_SCHEMA) for (const it of g.items) if (it.worker) o[it.key] = tune[it.key];
  return o;
}

// build the panel into `root`; calls onChange(key) after any edit
export function renderTunePanel(root, onChange = () => {}) {
  root.textContent = '';
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const head = mk('div', 'set-head', 'Chat tuning');
  const resetAll = mk('button', 'ghost tune-reset', 'reset all');
  resetAll.addEventListener('click', () => { resetTune(); renderTunePanel(root, onChange); onChange('*'); });
  head.append(' ', resetAll);
  root.append(head);
  for (const g of TUNE_SCHEMA) {
    const det = mk('details', 'tune-group');
    if (g.open) det.open = true;
    det.append(mk('summary', '', g.group));
    for (const it of g.items) {
      const row = mk('div', 'tune-row');
      const lab = mk('label', '', it.label);
      if (it.help) {
        const q = mk('span', 'tune-q', '?');
        q.title = it.help;
        q.tabIndex = 0;
        lab.append(' ', q);
      }
      let input;
      if (it.type === 'range') {
        input = mk('input'); input.type = 'range';
        input.min = it.min; input.max = it.max; input.step = it.step; input.value = tune[it.key];
        const val = mk('span', 'tune-val', String(tune[it.key]));
        input.addEventListener('input', () => { tune[it.key] = +input.value; val.textContent = input.value; saveTune(); onChange(it.key); });
        row.append(lab, input, val);
      } else if (it.type === 'check') {
        input = mk('input'); input.type = 'checkbox'; input.checked = !!tune[it.key];
        input.addEventListener('change', () => { tune[it.key] = input.checked; saveTune(); onChange(it.key); });
        row.append(lab, input);
      } else {
        input = mk('input'); input.type = 'text'; input.maxLength = 160; input.value = tune[it.key];
        input.addEventListener('change', () => { tune[it.key] = input.value; saveTune(); onChange(it.key); });
        row.classList.add('tune-text'); row.append(lab, input);
      }
      if (it.help) {
        // hover shows the tooltip; tap/click (phones) toggles the same text inline
        const h = mk('div', 'tune-help', it.help); h.hidden = true; row.append(h);
        lab.querySelector('.tune-q').addEventListener('click', () => { h.hidden = !h.hidden; });
      }
      det.append(row);
    }
    const r = mk('button', 'ghost tune-reset', 'reset group');
    r.addEventListener('click', () => { resetTune(g.items.map((i) => i.key)); renderTunePanel(root, onChange); onChange('*'); });
    det.append(r);
    root.append(det);
  }
}
