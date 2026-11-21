// Computer players, named for the family. Each level plans its words at round start:
// how many it finds, how long they are, how fast it gets going, and how often it fumbles.
const crypto = require('crypto');
const { common, valid, naughty } = require('./dict');

const LEVELS = {
  tara:      { name: 'Tara',      label: 'Very easy', share: 0.06, max: 8,  maxLen: 4,  commonOnly: true,  first: [12, 20], typos: [1, 3], setPause: 1.0, voteYes: 0.75, attitude: { good: 0.9 } },
  max:       { name: 'Max',       label: 'Easy',      share: 0.12, max: 15, maxLen: 5,  commonOnly: true,  first: [7, 12],  typos: [0, 2], setPause: 0.7, voteYes: 0.55, attitude: { good: 0.4 } },
  maya:      { name: 'Maya',      label: 'Medium',    share: 0.25, max: 32, maxLen: 7,  commonOnly: false, first: [4, 8],   typos: [0, 1], setPause: 0.45, voteYes: 0.45, attitude: { good: 0.8 } },
  valentina: { name: 'Valentina', label: 'Hard',      share: 0.45, max: 75, maxLen: 16, commonOnly: false, first: [2, 4],   typos: [0, 0], setPause: 0.2, voteYes: 0.2, attitude: { good: 0.25 } },
};

const rnd = () => crypto.randomInt(1e9) / 1e9;
const between = (a, b) => a + rnd() * (b - a);

// Returns [{ at (ms into round), w, path }] sorted by time.
function plan(level, round, roundMs) {
  const L = LEVELS[level];
  const all = [...round.words].filter(([w]) => w.length <= L.maxLen && !naughty.has(w)); // (the bots keep it clean)
  // Common words first; harder bots dip into rarer ones.
  let pool = all.filter(([w]) => common.has(w));
  if (!L.commonOnly) {
    const rare = all.filter(([w]) => !common.has(w));
    pool = pool.concat(rare.filter(() => rnd() < (level === 'valentina' ? 0.8 : 0.3)));
  }
  const timeScale = Math.min(2.5, Math.max(0.5, roundMs / 120000));
  const want = Math.min(pool.length, Math.max(1, Math.round(Math.min(L.max * timeScale, round.words.size * L.share * timeScale))));
  // Shuffle, then favour short words early and long ones late, the way people tend to play.
  pool.sort(() => rnd() - 0.5);
  const picks = pool.slice(0, want).sort((a, b) => a[0].length - b[0].length + (rnd() - 0.5) * 2.5);
  const start = between(...L.first) * 1000;
  const end = roundMs - 2500;
  const out = picks.map(([w, path], i) => ({ at: start + ((end - start) * (i + rnd() * 0.8)) / Math.max(1, picks.length), w, path }));
  // A few honest mistakes for the easier bots.
  const typos = Math.round(between(L.typos[0], L.typos[1] + 0.99) - 0.49);
  for (let k = 0; k < typos; k++) {
    const t = fakeWord(round);
    if (t) out.push({ at: between(start, end), ...t });
  }
  return out.sort((a, b) => a.at - b.at);
}

// A traceable 3-4 tile path that isn't a word.
function fakeWord(round) {
  const n = round.size;
  for (let tries = 0; tries < 40; tries++) {
    const path = [crypto.randomInt(n * n)];
    const len = 3 + crypto.randomInt(2);
    while (path.length < len) {
      const last = path[path.length - 1];
      const nb = [];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const r = Math.floor(last / n) + dr, c = (last % n) + dc;
        if ((dr || dc) && r >= 0 && c >= 0 && r < n && c < n && !path.includes(r * n + c)) nb.push(r * n + c);
      }
      if (!nb.length) break;
      path.push(nb[crypto.randomInt(nb.length)]);
    }
    const w = path.map(i => round.tiles[i]).join('');
    if (path.length >= 3 && !valid.has(w) && /^[a-z]+$/.test(w)) return { w, path };
  }
  return null;
}

function attitude(level) {
  return rnd() < LEVELS[level].attitude.good ? 'good' : 'bad';
}

module.exports = { LEVELS, plan, attitude };
