// Genuine Twitch chat lines read off VOD chat panels by tools/extract-real-chat.mjs
// (§G OCR), hand-filtered: OCR-clean, complete (not cropped mid-sentence), not
// tied to one video's subject. Small on purpose — grow it by re-running the
// extractor with a tighter --region, then curating again. The "canned real-chat
// %" tuning slider mixes these (plus STYLE_EXAMPLES) in for free, no GPU.
import { STYLE_EXAMPLES } from './style-examples.js';

export const REAL_LINES = [
  'YOURE ALIVE?!?', 'dont spoil please!!', 'Saw it yesterday', 'Saturday night', 'no lol',
  'Hello humans', 'Time for sleep', 'Good evening', 'sounds good now', 'now its like normal volume',
  'Merry Christmas', 'long time', 'Bro im tired', 'YESSSSSSS', 'Not really', 'Yooooo0o',
  'it wasnt allat that fun', 'Hey man', 'sup', 'Today Is release',
];

export const CANNED_POOL = [...REAL_LINES, ...STYLE_EXAMPLES];
