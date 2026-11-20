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

// Does this path touch two opposite sides of the board?
function spans(path, size) {
  let r0 = false, r1 = false, c0 = false, c1 = false;
  for (const i of path) {
    const r = Math.floor(i / size), c = i % size;
    if (r === 0) r0 = true; if (r === size - 1) r1 = true;
    if (c === 0) c0 = true; if (c === size - 1) c1 = true;
  }
  return (r0 && r1) || (c0 && c1);
}

// Returns Map word -> path (array of tile indices) for every valid word on the board.
// The map's .spanning set holds the words that can be traced (by any path) from one side to the other.
function solve(tiles, size, minLen) {
  const adj = neighbours(size);
  const found = new Map();
  const spanning = new Set();
  const used = new Array(tiles.length).fill(false);
  const path = [];
  function walk(i, sofar) {
    const word = sofar + tiles[i];
    const isWord = valid.has(word);
    if (!isWord && !prefixes.has(word)) return;
    used[i] = true; path.push(i);
    if (isWord && word.length >= minLen) {
      if (!found.has(word)) found.set(word, path.slice());
      if (!spanning.has(word) && path.length >= size && spans(path, size)) spanning.add(word);
    }
    for (const n of adj[i]) if (!used[n]) walk(n, word);
    used[i] = false; path.pop();
  }
  for (let i = 0; i < tiles.length; i++) walk(i, '');
  found.spanning = spanning;
  return found;
}

// Everyday words long enough to cross each board size, for planting.
const PLANT = {};
for (const size of [4, 5, 6]) PLANT[size] = [...common].filter(w => !w.includes('q') && w.length >= size && w.length <= size + 3);

// Lay a word along a random edge-to-edge path. Letters already on the board may be reused if they match.
function plant(grid, size, word, adj, rand) {
  for (let tries = 0; tries < 30; tries++) {
    const vertical = rand() < 0.5;
    const startSide = Math.floor(rand() * size);
    const start = vertical ? startSide : startSide * size; // top row or left column
    const reached = i => (vertical ? Math.floor(i / size) : i % size) === size - 1;
    const path = [];
    const used = new Set();
    let steps = 0;
    const go = i => {
      if (++steps > 400) return false;
      if (grid[i] && grid[i] !== word[path.length]) return false;
      path.push(i); used.add(i);
      if (path.length === word.length) { if (reached(i) || path.some(reached)) return true; }
      else {
        const next = adj[i].filter(n => !used.has(n)).sort(() => rand() - 0.5);
        for (const n of next) if (go(n)) return true;
      }
      path.pop(); used.delete(i);
      return false;
    };
    if (go(start)) { path.forEach((i, k) => { grid[i] = word[k]; }); return true; }
  }
  return false;
}

// How many everyday words a board should hold, by size and round length. Longer rounds need more to find,
// and every board should have a few words that cross it (the bridge bonus).
function targets(size, minLen, time = 120) {
  const t = Math.min(1.45, Math.max(0.8, Math.sqrt(time / 120)));
  const words = { 4: 60, 5: 115, 6: 175 }[size] * (minLen <= 3 ? 1 : 0.65) * t;
  const spanning = { 4: 8, 5: 6, 6: 5 }[size] * Math.min(1.35, t);
  return { words: Math.round(words), spanning: Math.round(spanning) };
}

function deal(size, minLen, time = 120, rand = Math.random) {
  const n = size * size;
  const want = targets(size, minLen, time);
  const adj = neighbours(size);
  const cap = Math.max(2, Math.ceil(n * 0.14));
  let best = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const grid = new Array(n).fill(null);
    // Most big boards start from one or two long planted words; small boards usually have plenty already.
    const plants = size === 4 ? (rand() < 0.35 ? 1 : 0) : size === 5 ? (rand() < 0.7 ? 1 : 2) : (rand() < 0.4 ? 1 : 2);
    for (let k = 0; k < plants; k++) plant(grid, size, PLANT[size][Math.floor(rand() * PLANT[size].length)], adj, rand);
    const counts = {};
    for (const t of grid) if (t) counts[t] = (counts[t] || 0) + 1;
    let guard = 0;
    for (let i = 0; i < n; i++) {
      while (!grid[i] && guard++ < 5000) {
        const t = drawTile(rand);
        if ((counts[t] || 0) >= (VOWELS.has(t) || t === 'qu' ? cap : Math.max(2, cap - 1))) continue;
        if (t === 'qu' && counts.qu) continue;
        counts[t] = (counts[t] || 0) + 1;
        grid[i] = t;
      }
      if (!grid[i]) grid[i] = 'e';
    }
    // A planted word can overload one letter; skip boards where any letter is far over its share.
    if (Object.entries(counts).some(([t, c]) => c > cap + 1)) continue;
    const vowels = grid.filter(t => VOWELS.has(t)).length / n;
    if (vowels < 0.27 || vowels > 0.5) continue;
    const words = solve(grid, size, minLen);
    const everyday = [...words.keys()].filter(w => common.has(w)).length;
    const crossing = [...words.spanning].filter(w => common.has(w)).length;
    const score = Math.min(everyday / want.words, crossing / want.spanning, 1.2) + Math.min(everyday / want.words, 1.5) * 0.01;
    if (!best || score > best.score) best = { tiles: grid, words, score, everyday, crossing };
    if (everyday >= want.words && crossing >= want.spanning) break;
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

module.exports = { deal, solve, points, fnv, common, targets };
