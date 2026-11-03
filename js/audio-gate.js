// audio-gate.js — the last filter before a chunk of audio reaches a model.
//
// Why it exists: the RMS gate in main.js opens on *energy*, so a steady bed
// (computer hum, fan, fridge, a streamer humming or singing along) rides
// through to ASR, and a generative omni model does not answer those with
// nothing — it answers with a DESCRIPTION of the sound, which then becomes the
// room's topic. Measured 2026-11-02 with tools/probe.mjs noise-probe, Omni
// LFM3-Omni-2B, 16 kHz fixtures from tools/noise-fixture.mjs:
//
//   mains hum / fan / keyboard clatter / music bed / silence → "NONE" (already fine)
//   a hummed tune                                            → 'The speaker says, "Oh."'
//   speech over a hum or fan bed                             → transcribed correctly
//
// So the bed worth catching is the *speech-shaped* one, and the feature that
// separates it is voiced/unvoiced alternation: speech jumps between vowels
// (zero-crossing rate ~0.02) and fricatives and stops (s f t k, ~0.15), while a
// hum, a sung note, a fan or a music bed holds roughly one crossing rate the
// whole time. cv (sd/mean) of the crossing rate over the frames that carry
// signal is wide for speech, narrow for everything else:
//
//   speech (real stream chunks through the app's own gate) 0.60 0.86 1.03 1.26
//   speech fixture 1.73 · speech over a noise bed 1.65 1.68
//   hummed tune 0.19 · music 0.28 · mains hum 0.14 · silence 0.00
//   fan 0.60 · keyboard 1.96  ← pass the gate, and the model already says NONE
//
// shortcut: thresholds measured on synthetic beds and 30 s of real stream
// audio; real *singing with words* looks like speech to this and still gets
// transcribed. Upgrade path = a real VAD (silero via WASM) if that bites.

const FRAME_MS = 20;      // 320 samples at 16 kHz
const MIN_ZCV = 0.4;      // below this the crossing rate never moves: a tone, not talk
const LOUD_FRAC = 0.15;   // judge only frames above 15% of the chunk's loudest

/** @param pcm Float32Array mono @ 16 kHz @returns {boolean} */
export function looksLikeSpeech(pcm) {
  const win = Math.round(16000 * FRAME_MS / 1000);
  if (!pcm || pcm.length < win * 4) return false;
  const n = Math.floor(pcm.length / win);
  const env = new Float64Array(n), zcr = new Float64Array(n);
  let peak = 0;
  for (let k = 0; k < n; k++) {
    let sum = 0, z = 0, o = k * win;
    for (let i = 0; i < win; i++) {
      const v = pcm[o + i];
      sum += v * v;
      if (i && (v < 0) !== (pcm[o + i - 1] < 0)) z++;
    }
    env[k] = Math.sqrt(sum / win);
    zcr[k] = z / win;
    if (env[k] > peak) peak = env[k];
  }
  if (!peak) return false;                       // digital silence
  const floor = peak * LOUD_FRAC;
  let cnt = 0, sum = 0, sumSq = 0;
  for (let k = 0; k < n; k++) {
    if (env[k] < floor) continue;
    cnt += 1; sum += zcr[k]; sumSq += zcr[k] * zcr[k];
  }
  if (cnt < 4) return false;
  const mean = sum / cnt;
  if (!mean) return false;                       // no crossings at all: a DC/flat tone
  return Math.sqrt(Math.max(0, sumSq / cnt - mean * mean)) / mean >= MIN_ZCV;
}

// A generative ASR that hears a non-voice answers with a DESCRIPTION of the
// sound rather than nothing — measured 2026-11-02 (tools/probe.mjs noise-probe):
// a hummed tune came back as 'The speaker says, "Oh."'. looksLikeSpeech stops
// most of that upstream; this is the net for what slips past, because one such
// line lands in state.speech and the room will not let the topic go.
// shortcut: shape-matched, not model-checked. It deliberately says nothing about
// sentences that merely *mention* a sound mid-sentence ("someone's humming
// today" is a real thing a streamer says), and it will eat a rare line that
// really does open with "a man…" / "singing…".
// The `a …<sound noun>` branch is the 2026-11-02 field fix: the adjective list
// caught "a soft click" but not the "a metallic click" a keyboard near the mic
// actually produced, and one such line in state.speech has the room repeating it
// for minutes.
// shortcut: it needs the article, so a bare "metallic click" still slips; widen
// only if a run shows that shape.
const SOUND_DESCRIPTION = /^(the (speaker|audio|sound|voice|noise|music|background|clip|recording)|a (person|man|woman|voice|soft|low|steady|constant|gentle|quiet|sound of|noise of)|sound of|noise of|ambient\b|background\b|music\b|singing\b|humming\b|laughter|coughing|applause|an?\s[\w -]{0,24}?(click|clack|tap|typing|tapping|beep|buzz|hum|thud|knock|ding|bang|clatter|static|whir|rustl|scratch|footstep|noise|sound)(?:s|ing|ed|ring)?\b)/i;

/** @param text an ASR line @returns {boolean} true when it describes a sound instead of transcribing words */
export function isSoundDescription(text) {
  return SOUND_DESCRIPTION.test((text || '').trim());
}
