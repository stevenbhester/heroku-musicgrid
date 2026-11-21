// Family Chaos Mode: the server plans every interruption at round start so all phones and the TV
// see them at the same moment, and so the server can enforce the rules they change.
const crypto = require('crypto');

// warn: banner/tutorial time before the effect starts. dur: how long the effect lasts.
// Longer, more involved events get more time; weight is how often each comes up.
const TYPES = {
  sam:       { weight: 1.0, warn: 3000, dur: 14000 },
  sleepover: { weight: 1.0, warn: 3000, dur: 22000 },
  robbert:   { weight: 0.9, warn: 3500, dur: 18000 },
  leak:      { weight: 0.8, warn: 3000, dur: 20000 },
  banana:    { weight: 0.8, warn: 3500, dur: 25000 },
  set:       { weight: 0.6, warn: 5000, dur: 40000 },
  monster:   { weight: 0.9, warn: 3000, dur: 16000 },
  swap:      { weight: 0.9, warn: 3500, dur: 24000 },
  climb:     { weight: 0.8, warn: 3500, dur: 25000 },
  launch:    { weight: 0.8, warn: 3500, dur: 14000 },
  wordle:    { weight: 0.6, warn: 4000, dur: 40000 },
};
// Events that depend on each player's own words, so they sit out Pass the Pen (one pen, one list).
// (G-ma's Wordle does run there: the whole team shares one set of clues.)
const SOLO_ONLY = ['leak', 'climb', 'launch'];
// Nana's BaNanagrams scales with the board: more tiles to pull, more time and a bigger banana.
const durFor = (type, size) => (type === 'banana' ? (4 + size * size) * 1000 : TYPES[type].dur);
// Filling the banana takes half the board's tiles.
const bananaFull = size => Math.ceil((size * size) / 2);
const QUIET_START = 18000; // let everyone settle in first
const QUIET_END = 8000;    // and keep the last seconds clean
const GAP = 15000;         // at least this much calm between events

const rnd = () => crypto.randomInt(1e9) / 1e9;

function pickWeighted(pool) {
  const total = pool.reduce((s, t) => s + TYPES[t].weight, 0);
  let r = rnd() * total;
  for (const t of pool) if ((r -= TYPES[t].weight) <= 0) return t;
  return pool[pool.length - 1];
}

// Rows, columns and the two diagonals, as lists of tile indexes.
function lines(size) {
  const out = [];
  for (let r = 0; r < size; r++) out.push(Array.from({ length: size }, (_, c) => r * size + c));
  for (let c = 0; c < size; c++) out.push(Array.from({ length: size }, (_, r) => r * size + c));
  out.push(Array.from({ length: size }, (_, i) => i * size + i));
  out.push(Array.from({ length: size }, (_, i) => i * size + (size - 1 - i)));
  return out;
}

// Sleepover: three tiles scattered across the board get drowsy, nod off into Z's, snooze for most
// of the event (long enough to find a word through them), then wake up one after another.
const DROWSY_MS = 1800;
function sleepoverData(size, dur) {
  const n = size * size;
  const near = (a, b) => Math.abs(Math.floor(a / size) - Math.floor(b / size)) <= 1 && Math.abs((a % size) - (b % size)) <= 1;
  let tiles = [];
  for (let tries = 0; tries < 200; tries++) {
    tiles = [];
    while (tiles.length < 3) { const t = crypto.randomInt(n); if (!tiles.includes(t)) tiles.push(t); }
    if (!tiles.some((a, i) => tiles.some((b, j) => i < j && near(a, b)))) break; // no two touching
  }
  const zs = tiles.map((tile, k) => {
    const drowsy = 300 + k * 900;
    return { tile, drowsy, from: drowsy + DROWSY_MS, to: dur - 1400 - (2 - k) * 500 };
  });
  return { zs };
}

// P-pa Monster: the monster sits on one tile and hops to a new one every few seconds.
function monsterData(size, dur) {
  const n = size * size;
  const hops = [];
  let last = -1;
  for (let at = 0; at < dur - 2000; at += 4000) {
    let tile;
    do { tile = crypto.randomInt(n); } while (tile === last);
    hops.push({ at, tile });
    last = tile;
  }
  return { hops };
}

// Violet & Orin Run Around Time: pairs of touching tiles swap places, in three waves. Later waves build on
// earlier ones (a tile can travel), and everything goes home when the event ends.
function swapData(size, dur) {
  const n = size * size;
  const touching = (a, b) => a !== b && Math.abs(Math.floor(a / size) - Math.floor(b / size)) <= 1 && Math.abs((a % size) - (b % size)) <= 1;
  const waves = [];
  for (let k = 0; k < 3; k++) {
    const pairs = [], used = new Set();
    for (let tries = 0; tries < 200 && pairs.length < size - 2 + (k ? 1 : 0); tries++) {
      const a = crypto.randomInt(n), b = crypto.randomInt(n);
      if (!touching(a, b) || used.has(a) || used.has(b)) continue;
      used.add(a); used.add(b);
      pairs.push([a, b]);
    }
    waves.push({ at: Math.round((dur * k) / 3), pairs });
  }
  return { waves };
}

// Which original tile's letter sits at each spot, `rel` ms into a swap event.
function arrangement(e, rel, n) {
  const at = Array.from({ length: n }, (_, i) => i);
  for (const w of e.data.waves) {
    if (rel < w.at) break;
    for (const [a, b] of w.pairs) [at[a], at[b]] = [at[b], at[a]];
  }
  return at;
}

// The tile the monster is on, `rel` ms into its event.
function monsterTile(e, rel) {
  let tile = e.data.hops[0].tile;
  for (const h of e.data.hops) if (rel >= h.at) tile = h.tile;
  return tile;
}

function dataFor(type, size, dur, dev) {
  if (type === 'sleepover') return sleepoverData(size, TYPES.sleepover.dur);
  if (type === 'sam') return { seed: crypto.randomInt(1e6) };
  if (type === 'leak') return { chance: dev ? +(process.env.ROBGGLE_LEAK || 0.5) : 0.5 };
  if (type === 'banana') return { full: bananaFull(size) };
  if (type === 'monster') return monsterData(size, dur);
  if (type === 'swap') return swapData(size, dur);
  return {};
}

function plan(timeSec, size, allowed) {
  const kinds = Object.keys(TYPES).filter(t => !allowed || allowed.includes(t));
  if (!kinds.length) return [];
  const T = timeSec * 1000;
  const window = T - QUIET_START - QUIET_END;
  if (window < 20000) return [];
  if (timeSec <= 60 && rnd() < 0.25) return []; // not every game gets chaos
  let n = Math.round(timeSec / 70 + rnd() * 0.9 - 0.3);
  n = Math.max(1, Math.min(6, n));
  let pool = kinds.slice();
  let chosen = [];
  for (let i = 0; i < n; i++) {
    if (!pool.length) pool = kinds.filter(t => kinds.length === 1 || !chosen.slice(-1).includes(t));
    const t = pickWeighted(pool);
    chosen.push(t);
    pool = pool.filter(x => x !== t);
  }
  const len = t => TYPES[t].warn + durFor(t, size);
  // Drop the longest events until they all fit.
  while (chosen.length && chosen.reduce((s, t) => s + len(t), 0) + GAP * (chosen.length - 1) > window) {
    const longest = chosen.reduce((a, b) => (len(b) > len(a) ? b : a));
    chosen.splice(chosen.indexOf(longest), 1);
  }
  // Shuffle, then spread the spare time randomly between events.
  chosen.sort(() => rnd() - 0.5);
  // Spread repeats apart so the same event rarely comes back to back.
  for (let i = 1; i < chosen.length; i++) {
    if (chosen[i] !== chosen[i - 1]) continue;
    const j = chosen.findIndex((t, k) => k > i && t !== chosen[i - 1] && (k + 1 >= chosen.length || chosen[k + 1] !== chosen[i]));
    if (j > 0) [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
  }
  const spare = window - chosen.reduce((s, t) => s + len(t), 0) - GAP * Math.max(0, chosen.length - 1);
  // Uneven gaps: squaring the random cuts makes some lulls long and others short, so it never feels like a metronome.
  const cuts = Array.from({ length: chosen.length + 1 }, () => Math.pow(rnd(), 1.8) + 0.05);
  const cutSum = cuts.reduce((a, b) => a + b, 0) || 1;
  let t = QUIET_START + (spare * cuts[0]) / cutSum;
  return chosen.map((type, i) => {
    const spec = TYPES[type];
    const ev = { id: `${type}${i}`, type, warnAt: Math.round(t), at: Math.round(t + spec.warn), dur: durFor(type, size), data: {} };
    ev.data = dataFor(type, size, ev.dur);
    t = ev.at + ev.dur + GAP + (spare * cuts[i + 1]) / cutSum;
    return ev;
  });
}

// Is an event of this type active `ms` into the round? Returns the event or null.
function active(events, type, ms) {
  return (events || []).find(e => e.type === type && ms >= e.at && ms < e.at + e.dur) || null;
}

// The letter on a tile `ms` into the round (sleepover turns tiles into Z; Violet & Orin move letters around).
function letterAt(round, i, ms) {
  const e = active(round.chaos, 'sleepover', ms);
  if (e) {
    const rel = ms - e.at;
    if (e.data.zs.some(z => z.tile === i && rel >= z.from && rel < z.to)) return 'z';
  }
  const s = active(round.chaos, 'swap', ms);
  if (s) return round.tiles[arrangement(s, ms - s.at, round.tiles.length)[i]];
  return round.tiles[i];
}

// Dev only: the listed events back to back from 5s in, so each can be checked on purpose.
function forced(types, size) {
  let t = 2000;
  return types.filter(x => TYPES[x]).map((type, i) => {
    const spec = TYPES[type];
    const ev = { id: `${type}${i}`, type, warnAt: t, at: t + spec.warn, dur: durFor(type, size), data: {} };
    ev.data = dataFor(type, size, ev.dur, true);
    t = ev.at + ev.dur + 2000;
    return ev;
  });
}

// Wordle's marks for a guess against the hidden word: g (right spot), y (in the word, elsewhere), x (not in it).
// A guess of any length gets marks; only its first five spots can be green.
function wordleMarks(guess, target) {
  const g = [...guess], t = [...target];
  const marks = g.map(() => 'x');
  const left = {};
  t.forEach((c, i) => { if (g[i] === c) marks[i] = 'g'; else left[c] = (left[c] || 0) + 1; });
  g.forEach((c, i) => { if (marks[i] !== 'g' && left[c] > 0) { marks[i] = 'y'; left[c]--; } });
  return marks;
}

module.exports = { wordleMarks, plan, forced, active, letterAt, monsterTile, TYPES, SOLO_ONLY };
