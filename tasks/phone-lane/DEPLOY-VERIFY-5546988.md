# DEPLOY-VERIFY-5546988 — SpasmTV phone-mode deploy

Production asset verification for commit 5546988 against https://spasm.milner.zone.
Each asset fetched with a unique `?cb=<random>` cache-busting query (cache max-age=600).

## Checks

1. workers/llm-worker.js contains 'HuggingFaceTB/SmolVLM-256M-Instruct', contains 'textFirst', and load() routes m.phone to the phone config — PASS (all three substrings present; m.phone branch resolves the phone model config)
2. js/main.js contains '256M SmolVLM brain' — PASS (string present)
3. Weight files on HF hub (Content-Length via curl -sIL):
   - onnx/vision_encoder_q4.onnx — PASS (~63.8 MB)
   - onnx/embed_tokens_quantized.onnx — PASS (~28.4 MB)
   - onnx/decoder_model_merged_q4.onnx — PASS (~86.6 MB)

## Verdict

PASS — all checks green; deployed assets verified.
