# NORTH-STAR — twitch-sim (SpasmTV)

**What it is:** an AI Twitch stream that watches *you*. The user's webcam is the
"stream"; a vision-language model (Liquid AI's LFM2.5-VL family) runs fully
in-browser on WebGPU and roleplays the Twitch chat reacting to what it sees —
and, via a local Whisper-class ASR model, to what the user *says* into their mic.
Broadly applicable: nothing about the streamer is precoded (no identity, gender,
or setup assumptions — the model reads what the camera shows).

**Invariants that don't bend:**
- **Zero backend.** No server we own does any inference or storage. Static files
  + model weights fetched from HF's CDN at runtime + all compute on the user's
  GPU. Hosting this = static file hosting, nothing more.
- **Nothing leaves the browser.** Frames and mic audio never touch a network
  (the only network traffic is one-time model download from HF).
- **Twitch-chat energy, not chatbot energy.** Messages are short, lowercase,
  emote-sprinkled, reaction-shaped. A long well-formed sentence is a failure.
- **It must feel live.** Cadence ~1 msg / 2–3 s, bursts on scene changes,
  drifting viewer count, replies to spoken words within seconds.

**Non-goals:** real Twitch API integration, accounts, video generation, TTS
streamer voice, moderation, mobile-WebGPU support (nice-to-have later).

**Where truth lives:** `PLAN.md` (plan + ledger), this file, the repo.
