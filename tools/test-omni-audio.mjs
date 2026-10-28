// Checks workers/omni-audio.js against features computed by the Python reference
// (numpy port of Lfm3OmniFeatureExtractor). Needs /tmp/omni/{speech.f32,py_feat.f32}.
//   node tools/test-omni-audio.mjs
import { readFileSync } from 'node:fs';
import { logMel } from '../workers/omni-audio.js';
const wav = new Float32Array(readFileSync('/tmp/omni/speech.f32').buffer.slice(0));
const ref = new Float32Array(readFileSync('/tmp/omni/py_feat.f32').buffer.slice(0));
const { data, frames, tokens } = logMel(wav);
if (data.length !== ref.length) throw new Error(`size ${data.length} vs ${ref.length}`);
let maxd = 0;
for (let i = 0; i < ref.length; i++) maxd = Math.max(maxd, Math.abs(data[i] - ref[i]));
console.log(`frames ${frames} tokens ${tokens} max|diff| ${maxd.toExponential(2)}`);
if (maxd > 1e-3) { console.error('FAIL'); process.exit(1); }
console.log('ok — JS log-mel matches the reference');
