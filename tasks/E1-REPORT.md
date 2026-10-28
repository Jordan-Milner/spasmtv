# E1 report — §E video sources

Finished by hand after the fleet card (code-64k) stopped at iter 20 with HTML/CSS and the audio-tap refactor done but no source wiring.

## Functions touched (js/main.js)
- `goLiveAfterLoad` — source precedence file > share > demo > camera; mic only started when no audio tap exists yet.
- `stopEverything` — calls `stopVideoSources()`.
- `activeSource` — returns `#file-video` when unhidden.
- `wireAudioTap(track, mediaEl)` — refactored out of `startMic`; also `createMediaElementSource` for files (routed to destination so it stays audible); resumes a suspended context.
- New: `showVideoSource`, `stopVideoSources`, `startShareFeed` (getDisplayMedia video+audio; track `ended` → stop), `startFileFeed` (fresh element per go-live because MediaElementSource binds once; loop; muted fallback if autoplay is refused), `setFileVideo`, `swapToFile` (mid-stream swap), drag/drop + picker + share/demo exclusivity handlers, `?video=` boot param.
- index.html: share toggle, `+` file button, hidden file input, `#file-video`. css: `#file-video`, `.dragging`.
- tools/browser-run.mjs: `--autoplay-policy=no-user-gesture-required`.

## Deviations from the U4 unit
- Share audio is used when the share carries an audio track (plan §E: chat hears the tab); with no audio track the mic is the fallback. U4 said mic wins; that would make the headline demo path deaf by default since the mic toggle is on.
- File audio is tapped only when the mic toggle is on (ASR is loaded only then).

## Verified
`?autolive&video=/videos/content-fnaf.mp4` headless: phase=live, 12 chat lines / 8 captions in ~1 min, captions describe the game footage. ASR path (audio into the gate) NOT exercised — the harness forces mic off. Drag-drop and share picker need a manual look.
