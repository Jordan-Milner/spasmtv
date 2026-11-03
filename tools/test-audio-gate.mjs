// test-audio-gate.mjs — the noise gate in front of ASR: real talk passes,
// speech-shaped noise does not.
//
// The signals here are synthesised (videos/ is gitignored, so a fixture a test
// depends on cannot live there). Real-audio validation is the run the module
// comment quotes: 30 s of a real stream, cut into chunks by the app's own RMS
// gate, scored 0.60-1.26 — every one above the 0.4 threshold — against 0.19 for
// a hummed tune. Node-only, no browser.
//   node tools/test-audio-gate.mjs
import assert from 'node:assert/strict';
import { looksLikeSpeech, isSoundDescription } from '../js/audio-gate.js';

const SR = 16000;
const norm = (x, peak) => {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  return x.map((v) => (v / (m || 1)) * peak);
};
const lowpass = (x, n) => { const buf = new Array(n).fill(0); let s = 0; return x.map((v, i) => { s += v - buf[i % n]; buf[i % n] = v; return s / n; }); };
let seed = 1234;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const noise = (n) => Array.from({ length: n }, () => rnd() * 2 - 1);

const hum = (secs = 3, peak = 0.05) => norm(
  Array.from({ length: SR * secs }, (_, i) => {
    const t = i / SR;
    return Math.sin(2 * Math.PI * 100 * t) + 0.5 * Math.sin(4 * Math.PI * 100 * t);
  }), peak);
const fan = (secs = 3, peak = 0.05) => norm(lowpass(lowpass(noise(SR * secs), 80), 80), peak);
const keys = (secs = 3, peak = 0.05) => {
  const x = hum(secs, 1);
  for (let k = 0; k < 12 * secs; k++) {
    const st = Math.floor(rnd() * (x.length - 1600));
    for (let i = 0; i < 800; i++) x[st + i] += (rnd() * 2 - 1) * Math.exp(-i / 120) * 4;
  }
  return norm(x, peak);
};
const music = (secs = 3, peak = 0.06) => norm(
  Array.from({ length: SR * secs }, (_, i) => {
    const t = i / SR, beat = i % (SR * 0.5);
    return Math.exp(-beat / 300) * Math.sin(2 * Math.PI * 60 * (beat / SR))
      + [196, 247, 294].reduce((a, f) => a + Math.sin(2 * Math.PI * f * t), 0) / 3
      + 0.05 * (rnd() * 2 - 1);
  }), peak);
// a person humming a tune: pitched notes with vibrato and note gaps — the one
// bed the model actually mis-transcribes, so the one the gate must catch
const tunedHum = (peak = 0.06) => {
  const out = [];
  for (const f of [220, 262, 294, 330, 392, 330, 294, 262]) {
    const n = Math.round(SR * 0.45);
    for (let i = 0; i < n; i++) {
      const t = i / SR, env = Math.min(1, i / 800) * Math.min(1, (n - i) / 1200);
      out.push(env * (Math.sin(2 * Math.PI * (f + 2 * Math.sin(2 * Math.PI * 5.5 * t)) * t)
        + 0.45 * Math.sin(4 * Math.PI * f * t)));
    }
    for (let i = 0; i < Math.round(SR * 0.06); i++) out.push(0);
  }
  return norm(out, peak);
};
// talk: alternating voiced (low crossings) and unvoiced (broadband) bursts with
// pauses between words — the voiced/unvoiced alternation the gate measures
const talk = (peak = 0.2) => {
  const out = [];
  for (let w = 0; w < 10; w++) {
    const voiced = rnd() > 0.4, n = Math.round(SR * (0.08 + rnd() * 0.14));
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      out.push(voiced
        ? Math.sin(2 * Math.PI * 120 * t) + 0.5 * Math.sin(4 * Math.PI * 120 * t)
        : (rnd() * 2 - 1) * 0.7);
    }
    for (let i = 0; i < Math.round(SR * (0.03 + rnd() * 0.08)); i++) out.push(0);
  }
  return norm(out, peak);
};
const mix = (a, b) => a.map((v, i) => v + (b[i % b.length] || 0));
const tail = (x) => [...x, ...new Array(Math.round(SR * 0.45)).fill(0)]; // a flush ends in silence

let n = 0;
const ok = (label, cond) => { assert.ok(cond, label); n += 1; };

for (const [name, sig] of Object.entries({ talk: talk(), talkOverHum: mix(talk(), hum(4, 0.02)), talkOverFan: mix(talk(), fan(4, 0.02)) }))
  ok(`${name} reaches the model`, looksLikeSpeech(new Float32Array(tail(sig))) === true);
for (const [name, sig] of Object.entries({
  silence: new Array(SR * 3).fill(0), hum: hum(), music: music(),
  // a 9 s bed is what the gate actually flushes: MAX_CHUNK_MS fills before a
  // steady noise ever stops on its own, and it ends in the usual silent tail
  humNineSeconds: hum(9), hummedTune: tunedHum(), hummedTuneNineSeconds: tunedHum().concat(tunedHum(), tunedHum()),
})) ok(`${name} is filtered out`, looksLikeSpeech(new Float32Array(tail(sig))) === false);

// fan and keyboard clatter do move their crossing rate, so they walk past this
// gate — on purpose. Raising the threshold to catch them (0.60) would cut real
// speech chunks that measure 0.60 too, and the probe already showed the model
// answers NONE for both, so there is nothing to fix at this layer.
for (const [name, sig] of Object.entries({ fan: fan(), keys: keys() }))
  ok(`${name} passes the gate (model already answers NONE)`, looksLikeSpeech(new Float32Array(tail(sig))) === true);

ok('a truncation too short to judge is dropped', looksLikeSpeech(new Float32Array(1000)) === false);
ok('silence after a loud bed is still a bed', looksLikeSpeech(new Float32Array([...hum(2), ...new Array(SR * 2).fill(0)])) === false);

// the net downstream of ASR: a line that describes a sound never becomes the
// room's topic. The "real talk" lines are transcripts a live run actually
// produced (node tools/browser-run.mjs --mic, 2026-11-02) — eating one of these
// is the failure mode that would quietly mute the streamer.
for (const line of ['The speaker says, "Oh."', 'A person is humming softly', 'Background music plays',
  'Music playing in the background', 'Humming', 'The audio is quiet', 'Sound of typing', 'Laughter'])
  ok(`described as sound: ${line}`, isSoundDescription(line) === true);
// the class the adjective list above missed, reported from a live session
// 2026-11-02: a keyboard near the mic came back as "a metallic click" and chat
// talked about the click for minutes
for (const line of ['A metallic click.', 'a clicking sound continues',
  'A sharp knock on the desk', 'An audible beep', 'A burst of static noise'])
  ok(`described as sound: ${line}`, isSoundDescription(line) === true);
for (const line of ['And someone\'s supposed to show up today, so...',
  'Hopefully resolved by next week \'cause like I\'m trying to grind, man.',
  'Yeah, I need, I need to knock out all of my hard modes today if at all possible.',
  'Hey everyone, welcome back to the stream.', 'i think the music in this level is fire',
  'someone is humming along in chat lol', 'a clickbait title'])
  ok(`real talk kept: ${line.slice(0, 28)}`, isSoundDescription(line) === false);

console.log(`audio-gate: ${n} assertions ok`);
