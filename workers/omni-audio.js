// omni-audio.js — the LFM3-Omni log-mel front end (Lfm3OmniFeatureExtractor):
// 16 kHz mono → 400-sample Hann windows, hop 160, no centering → power → 128
// slaney mel bins → log10 clamped at -12 → (x+4)/4. Pure, no DOM: node can
// import it (tools/test-omni-audio.mjs checks it against the Python reference).

const N_FFT = 400, HOP = 160, NM = 128, SR = 16000, NF = N_FFT / 2 + 1;

const hz2mel = (f) => (f >= 1000 ? 15 + Math.log(f / 1000) * (27 / Math.log(6.4)) : 3 * f / 200);
const mel2hz = (m) => (m >= 15 ? 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)) : 200 * m / 3);

let FB = null, COS = null, SIN = null, WIN = null;
function init() {
  if (FB) return;
  const fft = Array.from({ length: NF }, (_, i) => (i * SR) / 2 / (NF - 1));
  const lo = hz2mel(0), hi = hz2mel(SR / 2);
  const ff = Array.from({ length: NM + 2 }, (_, i) => mel2hz(lo + ((hi - lo) * i) / (NM + 1)));
  FB = new Float32Array(NM * NF); // [mel][freq]
  for (let m = 0; m < NM; m++) {
    const enorm = 2 / (ff[m + 2] - ff[m]);
    for (let k = 0; k < NF; k++) {
      const down = -(ff[m] - fft[k]) / (ff[m + 1] - ff[m]);
      const up = (ff[m + 2] - fft[k]) / (ff[m + 2] - ff[m + 1]);
      FB[m * NF + k] = Math.max(0, Math.min(down, up)) * enorm;
    }
  }
  COS = new Float32Array(NF * N_FFT); SIN = new Float32Array(NF * N_FFT);
  for (let k = 0; k < NF; k++) for (let n = 0; n < N_FFT; n++) {
    const a = (2 * Math.PI * k * n) / N_FFT;
    COS[k * N_FFT + n] = Math.cos(a); SIN[k * N_FFT + n] = -Math.sin(a);
  }
  WIN = Float32Array.from({ length: N_FFT }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT));
}

// returns { data: Float32Array [NM * frames] (row-major mel x frames), frames, tokens }
export function logMel(wav) {
  init();
  const n = wav.length;
  const padded = n < N_FFT ? N_FFT : n + ((HOP - ((n - N_FFT) % HOP)) % HOP);
  const frames = 1 + Math.floor((padded - N_FFT) / HOP);
  const x = new Float32Array(padded); x.set(wav);
  const out = new Float32Array(NM * frames);
  const buf = new Float32Array(N_FFT), pow = new Float32Array(NF);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N_FFT; i++) buf[i] = x[f * HOP + i] * WIN[i];
    for (let k = 0; k < NF; k++) {
      let re = 0, im = 0;
      const o = k * N_FFT;
      for (let i = 0; i < N_FFT; i++) { re += buf[i] * COS[o + i]; im += buf[i] * SIN[o + i]; }
      pow[k] = re * re + im * im;
    }
    for (let m = 0; m < NM; m++) {
      let s = 0;
      const o = m * NF;
      for (let k = 0; k < NF; k++) s += FB[o + k] * pow[k];
      const lm = Math.max(Math.log10(Math.max(s, 1e-30)), -12);
      out[m * frames + f] = (lm + 4) / 4;
    }
  }
  return { data: out, frames, tokens: Math.ceil(frames / 8) };
}
