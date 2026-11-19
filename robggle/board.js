// Board dealing and solving. Tiles are lowercase strings; "qu" is one tile.
const { valid, common, prefixes } = require('./dict');

// Our own letter odds (not any commercial dice set), tuned so boards feel generous.
const WEIGHTS = {
  e: 12, a: 9, i: 8, o: 8, t: 8, n: 7, s: 7, r: 7, l: 5, h: 4, d: 4, u: 3.5,
  c: 3, m: 3, p: 2.2, g: 2, b: 2, f: 1.8, w: 1.8, y: 1.8, k: 1, v: 1, x: 0.4,
  j: 0.3, z: 0.3, qu: 0.5,
};
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const BAG = Object.entries(WEIGHTS);
const TOTAL = BAG.reduce((s, [, w]) => s + w, 0);

function drawTile(rand) {
  let r = rand() * TOTAL;
  for (const [t, w] of BAG) { if ((r -= w) <= 0) return t; }
  return 'e';
}

function neighbours(size) {
  const out = [];
  for (let i = 0; i < size * size; i++) {
    const r = Math.floor(i / size), c = i % size, n = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && cc >= 0 && rr < size && cc < size) n.push(rr * size + cc);
    }
    out.push(n);
  }
  return out;
}

// Returns Map word -> path (array of tile indices) for every valid word on the board.
function solve(tiles, size, minLen) {
  const adj = neighbours(size);
  const found = new Map();
  const used = new Array(tiles.length).fill(false);
  const path = [];
  function walk(i, sofar) {
    const word = sofar + tiles[i];
    const isWord = valid.has(word);
    if (!isWord && !prefixes.has(word)) return;
    used[i] = true; path.push(i);
    if (isWord && word.length >= minLen && !found.has(word)) found.set(word, path.slice());
    for (const n of adj[i]) if (!used[n]) walk(n, word);
    used[i] = false; path.pop();
  }
  for (let i = 0; i < tiles.length; i++) walk(i, '');
  return found;
}

function deal(size, minLen, rand = Math.random) {
  const n = size * size;
  const want = { 4: 45, 5: 110, 6: 180 }[size] * (minLen <= 3 ? 1 : minLen === 4 ? 0.6 : 0.3);
  let best = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const tiles = [];
    const counts = {};
    while (tiles.length < n) {
      const t = drawTile(rand);
      const cap = Math.max(2, Math.ceil(n * 0.14));
      if ((counts[t] || 0) >= (VOWELS.has(t) || t === 'qu' ? cap : Math.max(2, cap - 1))) continue;
      if (t === 'qu' && counts.qu) continue;
      counts[t] = (counts[t] || 0) + 1;
      tiles.push(t);
    }
    const vowels = tiles.filter(t => VOWELS.has(t)).length / n;
    if (vowels < 0.27 || vowels > 0.47) continue;
    const words = solve(tiles, size, minLen);
    if (!best || words.size > best.words.size) best = { tiles, words };
    if (words.size >= want) break;
  }
  return best;
}

// Points by letters ("qu" counts as two letters). Classic-style curve.
function points(word) {
  const L = word.length;
  if (L <= 4) return 1;
  if (L === 5) return 2;
  if (L === 6) return 3;
  if (L === 7) return 5;
  return 11;
}

// Must match the browser's copy in web/robggle/assets/net.js.
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

module.exports = { deal, solve, points, fnv, common };
