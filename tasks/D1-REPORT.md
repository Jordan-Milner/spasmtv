# D1 report — real-chat extraction (§G)

The fleet card's extraction actually completed; only the 600 s verify timeout (two full OCR passes) killed it before the report was written.

| VOD | region | lines | with a username | verdict |
|---|---|---|---|---|
| vod-fnf-work.mp4 | `--region 300:500:980:220` | 4805 | 2463 (556 users) | usable — clean names, real chat text (e.g. "MARIO WAHHH", "Holy shit its maro") |
| vod-phantom.mp4 | default right-30% | 28758 | 3103 (1976 "users") | NOISY — hard mode as the plan predicted; OCR garbles names, many fragments. Needs a tighter `--region` or higher-res source before it counts as ground truth. |

Use fnf-work as the §G comparison corpus; phantom is not trustworthy as-is. Tool fixes bundled in this change: `crop=` prefix, right-30% x offset, drawbox preview.
Next (not done here): `score-chat.mjs --compare` against a sim run on the same video.
