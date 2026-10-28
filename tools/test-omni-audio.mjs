// Checks workers/omni-audio.js against features computed by the Python reference
// (numpy port of Lfm3OmniFeatureExtractor). The fixtures are generated, not
// shipped: speech.f32 (16 kHz mono PCM) + py_feat.f32 (the reference features)
// in $OMNI_FIXTURES (default /tmp/omni). Without them the check SKIPs.
//   OMNI_FIXTURES=/path node tools/test-omni-audio.mjs
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logMel } from '../workers/omni-audio.js';
const dir = process.env.OMNI_FIXTURES || '/tmp/omni';
const wavPath = join(dir, 'speech.f32'), refPath = join(dir, 'py_feat.f32');
if (!existsSync(wavPath) || !existsSync(refPath)) {
  console.log(`skip — omni log-mel check needs ${wavPath} + ${refPath}`);
  process.exit(0);
}
const wav = new Float32Array(readFileSync(wavPath).buffer.slice(0));
const ref = new Float32Array(readFileSync(refPath).buffer.slice(0));
const { data, frames, tokens } = logMel(wav);
if (data.length !== ref.length) throw new Error(`size ${data.length} vs ${ref.length}`);
let maxd = 0;
for (let i = 0; i < ref.length; i++) maxd = Math.max(maxd, Math.abs(data[i] - ref[i]));
console.log(`frames ${frames} tokens ${tokens} max|diff| ${maxd.toExponential(2)}`);
if (maxd > 1e-3) { console.error('FAIL'); process.exit(1); }
console.log('ok — JS log-mel matches the reference');
