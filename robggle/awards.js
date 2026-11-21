// For-fun awards: silly end-of-round categories worth real points, like bonus stars in a party game.
// A few are picked at random each round from the ones somebody actually qualifies for. They can be
// unfair (the lowest score gets a snack); that's the point.
const VOWELS = new Set('aeiou');
const RARE = new Set('jkqxz');
const SCRABBLE = { a: 1, b: 3, c: 3, d: 2, e: 1, f: 4, g: 2, h: 4, i: 1, j: 8, k: 5, l: 1, m: 3, n: 1, o: 1, p: 3, q: 10, r: 1, s: 1, t: 1, u: 1, v: 4, w: 4, x: 8, y: 4, z: 10 };
const U = w => w.toUpperCase();
const sec = ms => `${Math.max(0, Math.round(ms / 1000))}s`;
const count = (w, fn) => [...w].filter(fn).length;
// A number that orders words alphabetically (first six letters are plenty).
const alpha = w => [...w.slice(0, 6).padEnd(6, '`')].reduce((n, c) => n * 27 + (c.charCodeAt(0) - 96), 0);
// Best word by some score: { v, d } with the word in the detail.
const bestWord = (ws, score, fmt) => {
  let b = null;
  for (const x of ws) { const v = score(x); if (v != null && (!b || v > b.v)) b = { v, x }; }
  return b ? { v: b.v, d: fmt(b.x, b.v) } : null;
};

// Each award: val(p) returns { v, d } (higher wins, or lower when low is set) or null if they don't qualify.
function catalog(g) {
  const { size, letter } = g;
  const rc = i => [Math.floor(i / size), i % size];
  const edge = i => { const [r, c] = rc(i); return r === 0 || c === 0 || r === size - 1 || c === size - 1; };
  const corner = i => { const [r, c] = rc(i); return (r === 0 || r === size - 1) && (c === 0 || c === size - 1); };
  const steps = path => path.slice(1).map((i, k) => { const [r1, c1] = rc(path[k]), [r2, c2] = rc(i); return [r2 - r1, c2 - c1]; });
  const n = (v, one, many = one + 's') => `${v} ${v === 1 ? one : many}`;
  const tally = (ws, fn, min, one, many) => { const v = ws.filter(fn).length; return v >= min ? { v, d: n(v, one, many) } : null; };
  return [
    { key: 'vowels', icon: 'drop', title: 'Vowel Enthusiast', blurb: 'Most vowels in all your words',
      val: p => { const v = p.ws.reduce((s, x) => s + count(x.w, c => VOWELS.has(c)), 0); return v ? { v, d: n(v, 'vowel') } : null; } },
    { key: 'consonants', icon: 'book', title: 'Consonant Cruncher', blurb: 'Most consonants in one word',
      val: p => bestWord(p.ws, x => count(x.w, c => !VOWELS.has(c)), (x, v) => `${U(x.w)} (${v})`) },
    { key: 'distinct', icon: 'letters', title: 'Alphabet Soup', blurb: 'Most different letters used',
      val: p => { const v = new Set(p.ws.flatMap(x => [...x.w])).size; return v ? { v, d: n(v, 'different letter') } : null; } },
    { key: 'early', icon: 'sun', title: 'Early Bird', blurb: 'First word of the round', low: true,
      val: p => (p.ws.length ? { v: p.ws[0].at, d: `${U(p.ws[0].w)} at ${sec(p.ws[0].at)}` } : null) },
    { key: 'late', icon: 'moon', title: 'Night Owl', blurb: 'Last word of the round',
      val: p => { const x = p.ws[p.ws.length - 1]; return x ? { v: x.at, d: `${U(x.w)} at ${sec(x.at)}` } : null; } },
    { key: 'wrong', icon: 'book', title: 'Creative Spelling', blurb: 'Most words the dictionary turned down',
      val: p => (p.rejected >= 2 ? { v: p.rejected, d: n(p.rejected, 'made-up word') } : null) },
    { key: 'short', icon: 'ant', title: 'Short Stack', blurb: 'Most 3-letter words',
      val: p => tally(p.ws, x => x.w.length === 3, 2, 'tiny word') },
    { key: 'plural', icon: 'stack', title: 'Plural Pusher', blurb: 'Most words ending in S',
      val: p => tally(p.ws, x => x.w.endsWith('s'), 2, 'word', 'words') },
    { key: 'tiles', icon: 'grid', title: 'Letter Hog', blurb: 'Most letters traced in total',
      val: p => { const v = p.ws.reduce((s, x) => s + x.w.length, 0); return v ? { v, d: n(v, 'letter') } : null; } },
    { key: 'corners', icon: 'grid', title: 'Corner Office', blurb: 'Most words touching a corner',
      val: p => tally(p.ws, x => x.path && x.path.some(corner), 2, 'word') },
    { key: 'inside', icon: 'grid', title: 'Inside Job', blurb: 'Most words that never touch the edge',
      val: p => tally(p.ws, x => x.path && !x.path.some(edge), 1, 'word') },
    { key: 'edge', icon: 'ruler', title: 'Edge Lord', blurb: 'Longest word traced along the edge',
      val: p => bestWord(p.ws, x => (x.path && x.path.every(edge) && x.w.length >= 3 ? x.w.length : null), x => U(x.w)) },
    { key: 'double', icon: 'cards', title: 'Double Trouble', blurb: 'Most words with a double letter',
      val: p => tally(p.ws, x => /(.)\1/.test(x.w), 1, 'word') },
    { key: 'front', icon: 'book', title: 'Front of the Dictionary', blurb: 'The word that comes first alphabetically',
      val: p => bestWord(p.ws, x => -alpha(x.w), x => U(x.w)) },
    { key: 'back', icon: 'book', title: 'Back of the Dictionary', blurb: 'The word that comes last alphabetically',
      val: p => bestWord(p.ws, x => alpha(x.w), x => U(x.w)) },
    { key: 'scrabble', icon: 'star', title: 'Scrabble Snob', blurb: 'Highest Scrabble score in one word',
      val: p => bestWord(p.ws, x => [...x.w].reduce((s, c) => s + (SCRABBLE[c] || 0), 0), (x, v) => `${U(x.w)} (${v} in Scrabble)`) },
    { key: 'bookends', icon: 'book', title: 'Bookends', blurb: 'Most words that start and end with the same letter',
      val: p => tally(p.ws, x => x.w[0] === x.w[x.w.length - 1], 1, 'word') },
    { key: 'hive', icon: 'users', title: 'Hive Mind', blurb: 'Most words somebody else found too',
      val: p => tally(p.ws, x => (g.finders.get(x.w) || 0) >= 2, 2, 'shared word') },
    { key: 'slow', icon: 'snail', title: 'Taking It Slow', blurb: 'Longest wait between two words',
      val: p => { if (p.ws.length < 2) return null; let v = 0; for (let i = 1; i < p.ws.length; i++) v = Math.max(v, p.ws[i].at - p.ws[i - 1].at); return { v, d: `${sec(v)} of deep thought` }; } },
    { key: 'rapid', icon: 'bolt', title: 'Rapid Fire', blurb: 'Two words closest together', low: true,
      val: p => { if (p.ws.length < 2) return null; let v = Infinity; for (let i = 1; i < p.ws.length; i++) v = Math.min(v, p.ws[i].at - p.ws[i - 1].at); return { v, d: `${(v / 1000).toFixed(1)}s apart` }; } },
    { key: 'sprint', icon: 'bolt', title: 'Fast Starter', blurb: 'Most words in the first 20 seconds',
      val: p => tally(p.ws, x => x.at <= 20000, 1, 'word') },
    { key: 'closer', icon: 'clock', title: 'The Closer', blurb: 'Most words in the last 20 seconds',
      val: p => tally(p.ws, x => x.at >= g.roundMs - 20000, 1, 'word') },
    { key: 'blackjack', icon: 'cards', title: 'Blackjack', blurb: 'Score closest to 21 without going over', low: true,
      val: p => (p.gross > 0 && p.gross <= 21 ? { v: 21 - p.gross, d: `${p.gross} points` } : null) },
    { key: 'underdog', icon: 'gift', title: 'Underdog Snack', blurb: 'The lowest score gets a snack', low: true,
      val: p => ({ v: p.gross, d: `${n(p.gross, 'point')}, bless them` }) },
    { key: 'selfie', icon: 'users', title: 'Name Dropper', blurb: 'Most words starting with the first letter of your name',
      val: p => { const L = (p.name || '').toLowerCase().replace(/[^a-z]/g, '')[0]; return L ? tally(p.ws, x => x.w[0] === L, 1, `${U(L)} word`) : null; } },
    { key: 'busy', icon: 'pencil', title: 'Busy Thumbs', blurb: 'Most words tried, right or wrong',
      val: p => (p.tries ? { v: p.tries, d: n(p.tries, 'try', 'tries') } : null) },
    { key: 'scenic', icon: 'car', title: 'Scenic Route', blurb: 'Longest trip around the board in one word',
      val: p => bestWord(p.ws, x => (x.path ? steps(x.path).reduce((s, [a, b]) => s + Math.hypot(a, b), 0) : null), x => U(x.w)) },
    { key: 'rare', icon: 'q', title: 'Rare Letter Collector', blurb: 'Most J, K, Q, X and Z',
      val: p => { const v = p.ws.reduce((s, x) => s + count(x.w, c => RARE.has(c)), 0); return v ? { v, d: n(v, 'rare letter') } : null; } },
    { key: 'letter', icon: 'letters', title: `${U(letter)} Fan Club`, blurb: `Most ${U(letter)}'s (this round's lucky letter)`,
      val: p => { const v = p.ws.reduce((s, x) => s + count(x.w, c => c === letter), 0); return v ? { v, d: n(v, U(letter), `${U(letter)}'s`) } : null; } },
    { key: 'novowel', icon: 'z', title: 'Who Needs Vowels?', blurb: 'Longest word without A, E, I, O or U',
      val: p => bestWord(p.ws, x => (count(x.w, c => VOWELS.has(c)) ? null : x.w.length), x => U(x.w)) },
    { key: 'onetrack', icon: 'flag', title: 'One-Track Mind', blurb: 'Most words starting with the same letter',
      val: p => { const by = {}; for (const x of p.ws) by[x.w[0]] = (by[x.w[0]] || 0) + 1; const [L, v] = Object.entries(by).sort((a, b) => b[1] - a[1])[0] || []; return v >= 2 ? { v, d: `${v} words starting with ${U(L)}` } : null; } },
    { key: 'diagonal', icon: 'bolt', title: 'Diagonal Dancer', blurb: 'Most diagonal moves',
      val: p => { const v = p.ws.reduce((s, x) => s + (x.path ? steps(x.path).filter(([a, b]) => a && b).length : 0), 0); return v ? { v, d: n(v, 'diagonal hop') } : null; } },
    { key: 'straight', icon: 'ruler', title: 'Straight Shooter', blurb: 'Longest word in a perfectly straight line',
      val: p => bestWord(p.ws, x => { if (!x.path || x.w.length < 3) return null; const s = steps(x.path); return s.every(([a, b]) => a === s[0][0] && b === s[0][1]) ? x.w.length : null; }, x => U(x.w)) },
    { key: 'anagram', icon: 'cards', title: 'Anagram Artist', blurb: 'Most pairs of words with the same letters',
      val: p => { const by = {}; for (const x of p.ws) { const k = [...x.w].sort().join(''); by[k] = (by[k] || 0) + 1; } const v = Object.values(by).reduce((s, c) => s + (c * (c - 1)) / 2, 0); return v ? { v, d: n(v, 'anagram pair') } : null; } },
    { key: 'quality', icon: 'scroll', title: 'Quality Over Quantity', blurb: 'Longest average word',
      val: p => (p.ws.length >= 2 ? (v => ({ v, d: `${v.toFixed(1)} letters a word` }))(p.ws.reduce((s, x) => s + x.w.length, 0) / p.ws.length) : null) },
  ];
}

// players: [{ id, name, gross, ws: [{ w, at, path }] (in the order found), tries, rejected }]
function pick({ players, size, tiles, roundMs, finders, rand = Math.random, howMany }) {
  if (players.length < 2) return [];
  const letters = [...new Set(tiles.filter(t => t.length === 1 && t !== 'q'))];
  const letter = letters[Math.floor(rand() * letters.length)] || 'e';
  const list = catalog({ size, letter, roundMs, finders });
  const top = Math.max(0, ...players.map(p => p.gross));
  // Worth about an eighth of the leader's round, in steps of 5: enough to swing a close game.
  const pts = Math.min(50, Math.max(5, Math.round((top * 0.12) / 5) * 5));
  const ready = [];
  for (const a of list) {
    const vals = players.map(p => ({ p, r: a.val(p) })).filter(x => x.r && Number.isFinite(x.r.v));
    if (!vals.length) continue;
    const best = a.low ? Math.min(...vals.map(x => x.r.v)) : Math.max(...vals.map(x => x.r.v));
    const win = vals.filter(x => x.r.v === best);
    if (win.length === players.length) continue; // everyone tied: no award
    ready.push({ key: a.key, icon: a.icon, title: a.title, blurb: a.blurb, pts, winners: win.map(x => ({ id: x.p.id, detail: x.r.d })) });
  }
  for (let i = ready.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [ready[i], ready[j]] = [ready[j], ready[i]]; }
  // Spread them around: take an award for someone who hasn't won one yet whenever there is one.
  const want = Math.min(ready.length, howMany || (players.length >= 4 ? 4 : 3));
  const out = [], won = new Set();
  while (out.length < want) {
    const k = Math.max(0, ready.findIndex(a => a.winners.every(w => !won.has(w.id))));
    const [a] = ready.splice(k, 1);
    a.winners.forEach(w => won.add(w.id));
    out.push(a);
  }
  return out;
}

module.exports = { pick, catalog };
