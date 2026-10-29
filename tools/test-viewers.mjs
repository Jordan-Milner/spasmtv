// test-viewers.mjs — §A silent majority (law 3). 37-66% of the people who ever
// speak in a real room say exactly one line and vanish. A roster of permanent
// regulars can't produce that; the drive-by in ChatSim.pickViewer is what does.
// This pins the mechanism in node (it was only ever browser-verified) so a
// future tweak to DRIVE_BY_P or the name pool can't silently collapse it.
//
//   node tools/test-viewers.mjs

import assert from 'node:assert/strict';

// chat-sim.js touches the DOM only inside methods we never call here; stub the
// two globals its constructor reaches for.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { getElementById: () => null };
const { ChatSim } = await import('../js/chat-sim.js');

// one-line-user % over a realistic sample window, averaged over many rooms
function oneLineRate(lines, rooms = 150) {
  let sum = 0;
  for (let r = 0; r < rooms; r++) {
    const sim = new ChatSim();
    sim.buildRoster(34);
    const counts = new Map();
    for (let i = 0; i < lines; i++) {
      const v = sim.pickViewer();
      counts.set(v.name, (counts.get(v.name) || 0) + 1);
    }
    const one = [...counts.values()].filter((n) => n === 1).length;
    sum += one / counts.size;
  }
  return sum / rooms;
}

// the fingerprint window is ~60-120 lines; the band is 0.37-0.66. (Very short
// windows read high — drive-bys are unique by construction — but a real sample
// is longer and regulars accumulate; the live run measured 54.5%.)
for (const lines of [60, 90, 120]) {
  const rate = oneLineRate(lines);
  assert.ok(rate >= 0.37 && rate <= 0.66,
    `one-line users over ${lines} lines = ${(rate * 100).toFixed(1)}%, outside 37-66%`);
}

// a drive-by is transient (speaks once, never joins the roster) and unique-named
{
  const sim = new ChatSim();
  sim.buildRoster(34);
  const rosterNames = new Set(sim.viewers.map((v) => v.name));
  let driveBys = 0, reused = 0;
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const v = sim.pickViewer();
    if (v.transient) { driveBys++; if (rosterNames.has(v.name)) reused++; if (seen.has(v.name)) reused++; seen.add(v.name); }
  }
  assert.ok(driveBys > 30, `expected drive-bys, got ${driveBys}/300`);
  assert.equal(reused, 0, 'a drive-by must be a fresh name not already on the roster');
}

console.log('ok — viewers: drive-by silent majority lands in the 37-66% band, drive-bys are unique transients');
