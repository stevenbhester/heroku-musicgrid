// Family Chaos Mode: the server plans every interruption at round start so all phones and the TV
// see them at the same moment, and so the server can enforce the rules they change.
const crypto = require('crypto');

// warn: banner/tutorial time before the effect starts. dur: how long the effect lasts.
// Longer, more involved events get more time; weight is how often each comes up.
const TYPES = {
  sam:       { weight: 1.0, warn: 3000, dur: 14000 },
  sleepover: { weight: 1.0, warn: 3000, dur: 16000 },
  robbert:   { weight: 0.9, warn: 3500, dur: 18000 },
  leak:      { weight: 0.8, warn: 3000, dur: 20000 },
  banana:    { weight: 0.8, warn: 3500, dur: 25000 },
  set:       { weight: 0.6, warn: 5000, dur: 40000 },
};
const QUIET_START = 15000; // let everyone settle in first
const QUIET_END = 8000;    // and keep the last seconds clean
const GAP = 6000;          // breathing room between events

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

// Sleepover: three lines doze off one tile at a time, sleep a few seconds, then wake up.
function sleepoverData(size, dur) {
  const all = lines(size);
  const zs = [];
  const count = 3;
  const slot = dur / count;
  for (let k = 0; k < count; k++) {
    const line = all.splice(crypto.randomInt(all.length), 1)[0];
    const order = rnd() < 0.5 ? line : line.slice().reverse();
    const start = k * slot + 300;
    const step = 320;
    const hold = slot - 600 - order.length * step * 2;
    order.forEach((tile, j) => zs.push({ tile, from: Math.round(start + j * step), to: Math.round(start + order.length * step + Math.max(1500, hold) + j * step) }));
  }
  return { zs };
}

function plan(timeSec, size, allowed) {
  const kinds = Object.keys(TYPES).filter(t => !allowed || allowed.includes(t));
  if (!kinds.length) return [];
  const T = timeSec * 1000;
  const window = T - QUIET_START - QUIET_END;
  if (window < 20000) return [];
  if (timeSec <= 60 && rnd() < 0.25) return []; // not every game gets chaos
  let n = Math.round(timeSec / 50 + rnd() * 0.8 - 0.4);
  n = Math.max(1, Math.min(6, n));
  let pool = kinds.slice();
  let chosen = [];
  for (let i = 0; i < n; i++) {
    if (!pool.length) pool = kinds.filter(t => kinds.length === 1 || !chosen.slice(-1).includes(t));
    const t = pickWeighted(pool);
    chosen.push(t);
    pool = pool.filter(x => x !== t);
  }
  const len = t => TYPES[t].warn + TYPES[t].dur;
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
  const cuts = Array.from({ length: chosen.length + 1 }, () => rnd());
  const cutSum = cuts.reduce((a, b) => a + b, 0) || 1;
  let t = QUIET_START + (spare * cuts[0]) / cutSum;
  return chosen.map((type, i) => {
    const spec = TYPES[type];
    const ev = { id: `${type}${i}`, type, warnAt: Math.round(t), at: Math.round(t + spec.warn), dur: spec.dur, data: {} };
    if (type === 'sleepover') ev.data = sleepoverData(size, spec.dur);
    if (type === 'sam') ev.data = { seed: crypto.randomInt(1e6) };
    if (type === 'leak') ev.data = { chance: 0.25 };
    t = ev.at + spec.dur + GAP + (spare * cuts[i + 1]) / cutSum;
    return ev;
  });
}

// Is an event of this type active `ms` into the round? Returns the event or null.
function active(events, type, ms) {
  return (events || []).find(e => e.type === type && ms >= e.at && ms < e.at + e.dur) || null;
}

// The letter on a tile `ms` into the round (sleepover turns tiles into Z).
function letterAt(round, i, ms) {
  const e = active(round.chaos, 'sleepover', ms);
  if (e) {
    const rel = ms - e.at;
    if (e.data.zs.some(z => z.tile === i && rel >= z.from && rel < z.to)) return 'z';
  }
  return round.tiles[i];
}

// Dev only: the listed events back to back from 5s in, so each can be checked on purpose.
function forced(types, size) {
  let t = 2000;
  return types.filter(x => TYPES[x]).map((type, i) => {
    const spec = TYPES[type];
    const ev = { id: `${type}${i}`, type, warnAt: t, at: t + spec.warn, dur: spec.dur, data: {} };
    if (type === 'sleepover') ev.data = sleepoverData(size, spec.dur);
    if (type === 'sam') ev.data = { seed: crypto.randomInt(1e6) };
    if (type === 'leak') ev.data = { chance: +(process.env.ROBGGLE_LEAK || 0.25) };
    t = ev.at + spec.dur + 2000;
    return ev;
  });
}

module.exports = { plan, forced, active, letterAt, TYPES };
