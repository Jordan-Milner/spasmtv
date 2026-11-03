// test-modules.mjs — the cross-boundary couplings no test can see.
//
// npm test imports cadence/culture/text/viewers — the pure modules. It never
// loads main.js or llm-worker.js, because they need DOM and Worker. So the two
// ways those files break in half are invisible:
//   1. a named import that the target module does not export. ES modules fail
//      the whole file at link time: one bad binding and the page is blank, with
//      a green test suite. This is not hypothetical — the onCaption/prompt phone
//      crash was exactly a main.js/worker contract breaking.
//   2. a $('#id') whose element is not in index.html — returns null, and the
//      first read of it throws at boot.
// Both are string/mechanical enough to check without a browser.
//   node tools/test-modules.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// every app module, discovered rather than listed — a hand-kept list goes stale
// the same week the code does
const APP = ['js', 'workers'].flatMap((dir) =>
  fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`));

/* ---- 1. every relative named import resolves ---- */

function exportsOf(rel) {
  const src = read(rel);
  const set = new Set();
  // export function|class|const|let|var NAME
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/gm)) set.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)) set.add(m[1]);
  // export { a, b as c }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm))
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) set.add(name.trim());
    }
  if (/export\s+default/.test(src)) set.add('default');
  return set;
}

{
  const cache = new Map();
  const broken = [];
  for (const rel of APP) {
    const src = read(rel);
    for (const m of src.matchAll(/import\s*(?:\{([^}]*)\}|([A-Za-z0-9_$]+))?\s*from\s*['"]([^'"]+)['"]/g)) {
      const [, named, bare, spec] = m;
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;   // bare = CDN/esm.sh, not ours
      const target = path.normalize(path.join(path.dirname(rel), spec));
      if (!fs.existsSync(path.join(ROOT, target))) { broken.push(`${rel}: no such file ${spec}`); continue; }
      if (!named) continue;
      if (!cache.has(target)) cache.set(target, exportsOf(target));
      const ex = cache.get(target);
      for (const raw of named.split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        if (name && !ex.has(name)) broken.push(`${rel}: '${name}' is not exported by ${spec}`);
      }
      void bare;
    }
  }
  assert.deepEqual(broken, [], `broken module bindings:\n  ${broken.join('\n  ')}`);
  console.log(`ok — ${APP.length} modules: every relative named import resolves`);
}

/* ---- 2. every $('#id') exists in the page (or is built by JS) ---- */

{
  const html = read('index.html');
  const staticIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // ids the app writes itself (mod card, message rows, feed items…) are as
  // reachable as the static ones; a typo in either is still caught by the query.
  // Two forms: id="…" inside a template, and el.id = '…' after createElement.
  const builtIds = new Set(APP.flatMap((rel) => {
    const src = read(rel);
    return [...src.matchAll(/id=["']([^"'\s$]+)["']/g), ...src.matchAll(/\.id\s*=\s*["']([A-Za-z0-9_-]+)["']/g)]
      .map((m) => m[1]);
  }));
  const missing = [];
  for (const rel of APP) {
    for (const m of read(rel).matchAll(/\$\(\s*['"]#([A-Za-z0-9_-]+)['"]/g))
      if (!staticIds.has(m[1]) && !builtIds.has(m[1])) missing.push(`${rel}: $('#${m[1]}')`);
    for (const m of read(rel).matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]/g))
      if (!staticIds.has(m[1]) && !builtIds.has(m[1])) missing.push(`${rel}: getElementById('${m[1]}')`);
  }
  assert.deepEqual(missing, [], `selectors with no matching element:\n  ${missing.join('\n  ')}`);
  console.log('ok — every #id selector resolves to an element in index.html or app-built markup');
}

/* ---- 3. the two files no test ever loads at least parse ---- */
// npm test imports the pure modules only; main.js and llm-worker.js need DOM
// and Worker, so today a stray brace in either is a blank page with a green
// suite. Parsing is a third of that gate for free.
{
  const bad = [];
  for (const rel of APP) {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' }); }
    catch (e) { bad.push(`${rel}: ${String(e.stderr).split('\n').slice(0, 3).join(' ')}`); }
  }
  assert.deepEqual(bad, [], `files that do not parse:\n  ${bad.join('\n  ')}`);
  console.log(`ok — all ${APP.length} app modules parse (incl. the DOM/Worker ones)`);
}

