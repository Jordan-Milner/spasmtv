// Content-agnostic lines shaped like real Twitch chat (length, casing, laziness
// — distilled from the OCR corpus in videos/*.realchat.jsonl, §G). Handed to the
// model as few-shot style, never as things to say; the worker drops any output
// that copies one.
export const STYLE_EXAMPLES = [
  'yooooooooo', 'no wayyyyy', 'long time no see', 'bro im tired', 'sounds good now',
  'not really', 'sup', 'omg please', 'YESSSSSSS', 'wait what', 'nah thats crazy',
  'lol he really did that', 'hello from ohio', 'i cant believe this', 'chat is this real',
  'PLEASE', 'thats actually insane', 'been here since the start', 'ok that was clean',
  'bruh', 'first time seeing this', 'that sounded better before', 'we are so back',
  'not the music again', 'this is peak', 'who let him cook', 'dont spoil it pls',
  'can u do that again', 'im crying', 'every time lol',
];
