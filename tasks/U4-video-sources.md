# U4 — §E video sources (js/main.js + index.html + css/style.css)

Goal: two new stream sources — share a screen/tab (with its audio) and play a
local video file — both feeding the EXISTING frame-capture pipeline, with their
audio routed into the EXISTING RMS gate (js/recorder-worklet.js via the
`pcm-tap` AudioWorklet) so ASR hears the video/tab. Plus `?video=PATH` so an
unattended harness can autoplay a served file.

Read first: PLAN-CHAT-V2.md §E, js/main.js (startMic/onPcm/activeSource/
drawCapture/goLiveAfterLoad/boot IIFE), index.html.

Constraints (invariants):
- Zero backend, no new deps, no network. stdlib + browser APIs only.
- Don't restructure existing camera/demo/mic logic — extend it.
- Phone mode must still boot (file video allowed; screen share degrades to
  video-only if no audio track — never crashes).

## Work items

1. **Share screen/tab toggle** (`index.html` #controls):
   - `<label class="toggle"><input type="checkbox" id="share-toggle"/> share</label>`
     next to #demo-toggle. Title: "Share a tab or screen — the chat watches it".
   - Checking share unchecks demo; checking demo unchecks share (same pattern
     as the existing demo↔mic pair in main.js). Share + mic may coexist
     (streamer talks over the shared tab) — do NOT auto-clear mic.
   - In `goLiveAfterLoad()`: if share checked →
     `navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true })`
     → same handling as camera (cam.srcObject, cam.hidden=false). If the
     result has audio tracks and mic is OFF, route them through the same
     AudioContext + pcm-tap path startMic() uses (factor that wiring into a
     reusable function; keep the RMS gate constants untouched). If mic is ON,
     mic wins for the gate — display audio is skipped (one gate input).
   - `track.onended` (user hits Stop sharing) → same path as End stream
     (stopEverything + resetToIdle + setStatus('', 'offline')).
   - Errors (NotAllowedError etc.) → humanizeMediaError + stopEverything +
     resetToIdle, same as camera failure path.

2. **Video file source** (drag-drop + picker):
   - index.html: `<button id="file-btn" class="ghost" title="Play a video file as the stream">+</button>`
     in #controls (before settings-btn), hidden `<input type="file" id="file-input" accept="video/*"/>`,
     and `<video id="file-video" playsinline hidden></video>` inside #video-wrap
     (before #offline-cover so overlays sit on top; css: like #cam —
     `#file-video:not([hidden]){width:100%;height:100%;object-fit:contain;background:#000}`).
   - main.js: `playFileVideo(file_or_url)` — object URL (file) or direct URL
     (string param case). Show the element (hide cam + demo canvas), set
     `loop = true`, `el.play()` (catch and retry on first pointerdown —
     autoplay policy). Wire audio: on the FIRST use, create
     `state.audioCtx` if absent (16 kHz attempt, same as startMic),
     `addModule('./recorder-worklet.js')`, `createMediaElementSource(el)` →
     connect to a pcm-tap node (reuse the same onPcm handler) AND to
     `audioCtx.destination` (so the human still hears it; the tap must not be
     connected to destination). Element volume stays 1 — the MediaElementSource
     tap outputs silence if the element is muted.
   - `activeSource()` returns the file-video element when it's unhidden
     (drawImage from a <video> already works; readyState guard exists).
   - Drag-drop on #video-wrap: dragover → preventDefault + a css class
     `dragging` on the wrap (dashed outline), drop → preventDefault, take the
     first file if `file.type.startsWith('video/')`.
   - The file button works live (mid-stream source swap) AND before Go live:
     if phase !== 'live', just stash the source; when the user goes live,
     `goLiveAfterLoad` prefers it over camera/demo (skip getUserMedia).
     Checking nothing else needed — file video coexists with mic.
   - Source precedence when several are set: `?video=` param > file video >
     share > demo > camera. Only one DISPLAY source at a time; on picking a
     new one, hide/stop the previous (stream tracks stopped, demo raf
     canceled — reuse stopEverything's per-source bits without killing the
     whole stream).

3. **`?video=PATH` boot param**:
   - In the boot IIFE: if `new URLSearchParams(location.search).get('video')`
     → decode it, `playFileVideo(path)` (no gesture: mark the element
     `muted=false, volume=1` and rely on harness autoplay flag; catch play()
     rejection and retry on any pointerdown). When `?autolive` later clicks
     Go live, goLiveAfterLoad must use the file source (no getUserMedia, no
     demo). The video param ALSO wins over the harness's injected
     demo-toggle (browser-run.mjs forces demo on when it has no camera —
     guard: if a file source is pending, ignore demo).
   - serve.sh serves the repo root, so `?video=/videos/foo.mp4` works for
     files in videos/ (dir is gitignored but serves fine).

## Verification

- `node --check js/main.js` clean; no console errors on load with no params.
- Manual (agent may skip, verifier will do): drag any mp4 onto the stage
  live → chat reacts to frames AND ASR captions the video's speech
  (latency chip shows asr samples).
- `?video=/videos/<test>.mp4&autolive` headless: title shows chat= climbing
  and captions describing the video — the verifier runs this via
  tools/browser-run.mjs.
- Report: list every function you touched and the exact diff summary lines.
