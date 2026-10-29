#!/usr/bin/env node
// Fetch a short clip of REAL stream speech for the audio/reaction test path.
// The synthetic speech-demo.mp4 (one sentence on a 40s loop) is useless for
// measuring reaction latency — ASR only fires once per loop. Real stream audio
// talks continuously, so the gate/ASR/reaction path gets exercised for real.
//
//   node tools/fetch-stream-clip.mjs                 # first live channel it finds
//   node tools/fetch-stream-clip.mjs --channel shroud
//   node tools/fetch-stream-clip.mjs --seconds 60
//
// Writes videos/real-stream.mp4 (gitignored — this is a local test fixture, not
// a committed asset). Needs yt-dlp + ffmpeg on PATH. Twitch clips are live-only:
// run it while a channel is actually streaming.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SECONDS = arg('seconds', '45');
const CH = arg('channel', '');
const OUT = 'videos/real-stream.mp4';

const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;

// candidate channels to try in order if none named — talkative, usually live
const CANDIDATES = CH ? [CH] : ['shroud', 'xqc', 'kai_cenat', 'baha', 'akainc', 'ludwig'];

mkdirSync('videos', { recursive: true });
for (const ch of CANDIDATES) {
  const url = `https://twitch.tv/${ch}`;
  console.log(`trying ${url} …`);
  const ok = run('yt-dlp', [
    '--no-playlist', '-f', 'bv*[height<=480]+ba/b[height<=480]/b',
    '--live-from-start', '--download-sections', `*0:00-0:${SECONDS}`,
    '--merge-output-format', 'mp4', '-o', OUT, url,
  ]);
  if (ok) { console.log(`\nOK → ${OUT} (from ${ch})`); console.log('run: node /tmp/react-final.mjs  (or point ?video=videos/real-stream.mp4 at it)'); process.exit(0); }
}
console.error('no live channel produced a clip — name one with --channel <name> while it is streaming');
process.exit(1);
