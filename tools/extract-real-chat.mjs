// extract-real-chat.mjs — §A, the "real chat" front end. Turn a YouTube-saved
// Twitch VOD (chat overlay burned into the frame) into a timestamped chat
// corpus, then diff it against our simulated chat in score-chat.mjs --compare.
//
//   node tools/extract-real-chat.mjs --video videos/foo.mp4 \
//        [--out videos/foo.realchat.jsonl] [--fps 2] [--start 0 --dur 0(all)] \
//        [--region W:H:X:Y] [--preview]
//
// Node stdlib + child_process (spawnSync) only. ffmpeg/ffprobe/tesseract are
// expected on PATH (homebrew: /opt/homebrew/bin). No network.
//
// Pipeline: ffprobe → crop the right 30% (Twitch chat panel) → upscale ~3× →
// step through frames → tesseract each → parse "Name: message" lines → dedupe
// (chat persists across frames) → emit each unique line once at its first ts.

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const VIDEO = arg('video', null);
const OUT = arg('out', null);
const FPS = parseFloat(arg('fps', '2'));
const START = parseFloat(arg('start', '0'));
let DUR = arg('dur', '0'); // 0 or "all" → 0 (ffmpeg: no -t)
if (DUR === 'all') DUR = '0';
const REGION = arg('region', null);
const PREVIEW = flag('preview');

const FFPROBE = 'ffprobe';
const FFMPEG = 'ffmpeg';
const TESSERACT = 'tesseract';

const die = (msg) => {
  console.error(`extract-real-chat: ${msg}`);
  process.exit(1);
};

if (!VIDEO) die('no --video given (usage: --video foo.mp4 [--out foo.realchat.jsonl])');
if (!existsSync(VIDEO)) die(`video not found: ${VIDEO}`);

// resolve a command to a path (null when not on PATH) so the robustness
// clause can give a clear message instead of an opaque ENOENT
const which = (cmd) => {
  for (const p of (process.env.PATH || '').split(':')) {
    const cand = join(p, cmd);
    if (existsSync(cand)) return cand;
  }
  return null;
};
for (const bin of [FFPROBE, FFMPEG, TESSERACT]) {
  if (!which(bin)) die(`${bin} not found on PATH (homebrew install: /opt/homebrew/bin)`);
}

// --- 1. ffprobe: duration + size ------------------------------------------
const probe = spawnSync(FFPROBE, [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=duration,width,height',
  '-show_entries', 'format=duration',
  '-of', 'json', VIDEO,
], { encoding: 'utf8' });
if (probe.status !== 0) die(`ffprobe failed: ${probe.stderr?.toString().trim()}`);
let probeJson;
try { probeJson = JSON.parse(probe.stdout || '{}'); } catch { die('could not parse ffprobe json'); }
const stream = (probeJson.streams || [])[0] || {};   // ffprobe reports "streams": [...]
const fmt = probeJson.format || {};
const durStr = stream.duration || fmt.duration || null;
const duration = durStr ? parseFloat(durStr) : null;
const W0 = stream.width ? parseInt(stream.width, 10) : null;
const H0 = stream.height ? parseInt(stream.height, 10) : null;
if (!duration) die('ffprobe did not report a duration');

// --- 2. region ------------------------------------------------------------
// default = RIGHT 30% of the frame, full height. --region W:H:X:Y overrides.
let crop;
if (REGION) {
  const [cw, ch, cx, cy] = REGION.split(':').map((n) => parseFloat(n));
  if ([cw, ch, cx, cy].some((n) => Number.isNaN(n) || n <= 0))
    die(`bad --region "${REGION}" (want W:H:X:Y, positive numbers)`);
  crop = `${cw}:${ch}:${cx}:${cy}`;
} else {
  if (!W0 || !H0) die('could not read frame size from ffprobe');
  crop = `crop=${Math.round(W0 * 0.3)}:${H0}:0:0`;
}

if (PREVIEW) {
  // ONE annotated png: crop box drawn, so the region can be found by eye.
  const png = '/tmp/extract-preview.png';
  const draw = `drawtext=text='CROP':x=2:y=2:fontsize=24:color=yellow,`
    + `boxcolor=white@0.5:boxwidth=120:boxheight=24`;
  const r = spawnSync(FFMPEG, [
    '-y', '-ss', String(START), '-i', VIDEO, '-frames:v', '1',
    '-vf', `${crop},scale=iw*3:ih*3:flags=lanczos,fps=${FPS},${draw}`,
    png,
  ], { encoding: 'utf8' });
  if (r.status !== 0) die(`ffmpeg preview failed: ${r.stderr?.toString().trim()}`);
  console.log(`wrote preview to ${png}`);
  process.exit(0);
}

// --- 3. render frames to a tmp dir ----------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'extract-realchat-'));
try {
  const pattern = join(tmp, 'frame-%05d.png');
  // -ss start -t dur -i video -vf crop,scale(3x),fps=F → pngs
  const args = ['-y', '-ss', String(START)];
  if (DUR && parseFloat(DUR) > 0) args.push('-t', String(DUR));
  args.push('-i', VIDEO, '-vf', `${crop},scale=iw*3:ih*3:flags=lanczos,format=gray,negate,fps=${FPS}`, pattern);
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  if (r.status !== 0) die(`ffmpeg failed: ${r.stderr?.toString().trim()}`);

  // gather frames in order
  const frames = readdirSync(tmp)
    .filter((f) => /^frame-\d+\.png$/.test(f))
    .map((f) => join(tmp, f))
    .sort();
  if (!frames.length) die('ffmpeg produced no frames (check --start/--dur cover content)');

  // --- 4+5. OCR each frame, parse, dedupe -------------------------------
  // Dedupe: chat PERSISTS between frames, so a parsed line that matches an
  // already-emitted line whose last-seen frame is recent (<=3 frames back) is
  // a repeat — update last-seen, don't re-emit. When chat scrolls, old lines
  // vanish and a line not seen for >3 consecutive frames is gone; if it
  // reappears it emits at its new first ts. The seen set is bounded to the
  // last N=25 emitted lines (a line dropped from the window is treated as gone).
  const N = 25;
  const order = []; // keys in emission order (for FIFO eviction)
  const lastSeen = new Map(); // key -> last-seen frame index
  const out = [];

  const clean = (s) => s.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();

  const evict = () => {
    if (order.length <= N) return;
    const old = order.shift();
    lastSeen.delete(old);
  };

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const tsc = i / FPS + START;
    const ocr = spawnSync(TESSERACT, [frame, 'stdout', '--psm', '6'], { encoding: 'utf8' });
    if (ocr.status !== 0 && ocr.status !== 1)
      die(`tesseract failed on frame ${i}: ${ocr.stderr?.toString().trim()}`);

    const text = ocr.stdout || '';
    const lines = text.split('\n').map(clean).filter((l) => {
      if (l.length < 3) return false;
      const letters = (l.match(/[a-z]/gi) || []).length;
      return letters >= 2 && letters / l.replace(/ /g, '').length >= 0.5;
    });

    for (const raw of lines) {
      // Twitch overlay format is "Name: message" — split on the first ':',
      // no ':' → user is null.
      const idx = raw.indexOf(':');
      let user, msg;
      if (idx >= 0) {
        user = raw.slice(0, idx).trim();
        msg = raw.slice(idx + 1).trim();
      } else {
        user = null;
        msg = raw;
      }
      if (!msg) continue;
      const key = `${user ?? '‽'}\u0001${msg.toLowerCase()}`;
      const lastFrame = lastSeen.get(key);
      const recent = lastFrame !== undefined && i - lastFrame <= 3;
      if (!recent) {
        // first time (or a line that scrolled away and came back) — emit once
        // at its FIRST-seen timestamp.
        out.push({ t: parseFloat(tsc.toFixed(3)), user: user === null ? null : user, text: msg });
        order.push(key);
      }
      lastSeen.set(key, i);
      evict();
    }
  }

  // --- 6. output jsonl + summary ----------------------------------------
  const users = new Set(out.map((e) => e.user).filter(Boolean));
  const gaps = [];
  for (let i = 1; i < out.length; i++) gaps.push(out[i].t - out[i - 1].t);
  const median = (a) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const tokens = {};
  for (const e of out)
    for (const w of e.text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
      tokens[w] = (tokens[w] || 0) + 1;
  const top = Object.entries(tokens).sort((a, b) => b[1] - a[1]).slice(0, 10);

  if (OUT) {
    writeFileSync(OUT, out.map((e) => JSON.stringify(e)).join('\n') + '\n');
    console.log(`wrote ${OUT}: ${out.length} lines · ${users.size} users`);
  } else {
    console.log(out.map((e) => JSON.stringify(e)).join('\n'));
  }
  console.log(`\n--- summary ---`);
  console.log(`lines extracted: ${out.length}`);
  console.log(`unique users: ${users.size}`);
  console.log(`median gap: ${median(gaps).toFixed(2)}s`);
  console.log(`top 10 tokens: ${top.map(([w, c]) => `${w}(${c})`).join(', ')}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
