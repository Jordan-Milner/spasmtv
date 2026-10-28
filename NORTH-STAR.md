# NORTH-STAR — twitch-sim (SpasmTV)

**What it is:** an AI Twitch stream that watches *you*. The user's webcam (or a
shared tab, or a video file) is the "stream"; a small vision-language model
(Liquid AI's LFM family by default) runs fully in-browser on WebGPU and roleplays
the Twitch chat reacting to what it sees — and, via a local Moonshine ASR model,
to what the user *says* into their mic.
Broadly applicable: nothing about the streamer is precoded (no identity, gender,
or setup assumptions — the model reads what the camera shows).

**Invariants that don't bend:**
- **Zero backend.** No server we own does any inference or storage. Static files
  + model weights fetched from HF's CDN at runtime + all compute on the user's
  GPU. Hosting this = static file hosting, nothing more.
- **Nothing the user produces leaves the browser.** Frames, mic audio and
  transcripts never touch a network. The page downloads only code (jsDelivr),
  model weights (Hugging Face, cached after the first load) and public emote
  sets (BTTV/FFZ/7TV). The chat log lives in memory unless `?log=1`.
- **A real person is on camera and the page is public.** No line that slurs,
  sexualises, body-shames or tells someone to hurt themselves ever renders —
  model lines and canned lines pass the same reject list (`js/text.js`).
- **Twitch-chat energy, not chatbot energy.** Messages are short, lowercase,
  emote-sprinkled, reaction-shaped. A long well-formed sentence is a failure.
- **It must feel live.** Cadence ~1 msg / 2–3 s, bursts on scene changes,
  drifting viewer count, replies to spoken words within seconds.

**Non-goals:** real Twitch API integration, accounts, video generation, TTS
streamer voice, real moderation of real people. Phones get a deliberately
smaller brain (phone mode) rather than parity.

**Where truth lives:** this file and the repo; `tools/score-chat.mjs` is the
measure of whether chat is good. The working plans and run reports are kept in
the maintainer's local `notes/` worktree (branch `notes`, never pushed).
