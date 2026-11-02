// noise-fixture.mjs — build the audio fixtures videos/noise-*.f32 (16 kHz mono
// float32, gitignored like all of videos/) that the noise gate is measured and
// tested against: a 100 Hz mains hum, a fan/AC bed, keyboard clatter on a hum
// bed, a hummed tune, a music bed, and the real speech fixture from
// speech-test.f32 mixed over each bed.
//   node tools/noise-fixture.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const SR = 16000;
const write = (name, s) => writeFileSync(`videos/${name}.f32`, Buffer.from(new Float32Array(s).buffer));
const norm = (x, peak) => { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); return x.map((v) => (v / (m || 1)) * peak); };
const lowpass = (x, n) => { const buf = new Array(n).fill(0); let sum = 0; return x.map((v, i) => { sum += v - buf[i % n]; buf[i % n] = v; return sum / n; }); };
const noise = (n) => Array.from({ length: n }, () => Math.random() * 2 - 1);

const hum = (secs = 3, peak = 0.05) => norm(
  Array.from({ length: SR * secs }, (_, i) => {
    const t = i / SR;
    return Math.sin(2 * Math.PI * 100 * t) + 0.5 * Math.sin(2 * Math.PI * 200 * t) + 0.25 * Math.sin(2 * Math.PI * 300 * t);
  }), peak);
const fan = (secs = 3, peak = 0.05) => norm(lowpass(lowpass(noise(SR * secs), 80), 80), peak);
const keys = (secs = 3, peak = 0.05) => {
  const x = hum(secs, 1);
  for (let k = 0; k < 12 * secs; k++) {
    const st = Math.floor(Math.random() * (x.length - 1600));
    for (let i = 0; i < 800; i++) x[st + i] += (Math.random() * 2 - 1) * Math.exp(-i / 120) * 4;
  }
  return norm(x, peak);
};
const bed = (a, b) => { const t = b.length > a.length ? b : [...b, ...b, ...b].slice(0, a.length); return a.map((v, i) => v + t[i]); };
// the two beds worth filtering: a person humming a tune (the model answers it
// with 'The speaker says, "Oh."') and a music bed
const tune = (peak = 0.06) => {
  const out = [];
  for (const f of [220, 262, 294, 330, 392, 330, 294, 262]) {
    const n = Math.round(SR * 0.45);
    for (let i = 0; i < n; i++) {
      const t = i / SR, env = Math.min(1, i / 800) * Math.min(1, (n - i) / 1200);
      out.push(env * (Math.sin(2 * Math.PI * (f + 2 * Math.sin(2 * Math.PI * 5.5 * t)) * t) + 0.45 * Math.sin(4 * Math.PI * f * t)));
    }
    for (let i = 0; i < Math.round(SR * 0.06); i++) out.push(0);
  }
  return norm(out, peak);
};
const music = (secs = 3, peak = 0.06) => norm(Array.from({ length: SR * secs }, (_, i) => {
  const t = i / SR, beat = i % (SR * 0.5);
  return Math.exp(-beat / 300) * Math.sin(2 * Math.PI * 60 * (beat / SR))
    + [196, 247, 294].reduce((a, f) => a + Math.sin(2 * Math.PI * f * t), 0) / 3 + 0.05 * (Math.random() * 2 - 1);
}), peak);

write('noise-silence', new Array(SR * 3).fill(0));
write('noise-hum', hum());
write('noise-fan', fan());
write('noise-keys', keys());
write('noise-tune', tune());
write('noise-music', music());
const b = readFileSync('videos/speech-test.f32');
const speech = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
write('noise-speech-hum', bed(speech, hum(1, 0.02)));
write('noise-speech-fan', bed(speech, fan(1, 0.02)));
console.log('wrote videos/noise-*.f32');
