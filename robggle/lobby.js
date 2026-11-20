// One Lobby per game. The server is the only clock and the only judge of words.
const crypto = require('crypto');
const { deal, points, fnv, common } = require('./board');
const { valid } = require('./dict');
const chaos = require('./chaos');
const { award } = require('./badges');
const banter = require('./banter');
const bots = require('./bots');

const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels, so codes never spell words
const PLAYER_COLORS = ['#ff6b4a', '#3ee0b0', '#ffd23f', '#5ab0ff', '#ff5ca8', '#b48cff', '#9be15d', '#ff9f43', '#4de8f0', '#f78fb3', '#c7ecee', '#e1b12c'];
const ALLIANCE_COLORS = ['#ff6b4a', '#3ee0b0', '#5ab0ff', '#ffd23f', '#ff5ca8', '#b48cff'];
const ALLY_ADJ = ['Sneaky', 'Mighty', 'Midnight', 'Crispy', 'Feral', 'Cosmic', 'Spicy', 'Velvet', 'Turbo', 'Grumpy', 'Lucky', 'Wobbly'];
const ALLY_NOUN = ['Pickles', 'Owls', 'Meatballs', 'Raccoons', 'Noodles', 'Goblins', 'Pancakes', 'Walruses', 'Gremlins', 'Biscuits', 'Moths', 'Waffles'];

const COUNTDOWN_MS = 3600;
const GRACE_MS = 1500;       // words traced at the buzzer still count while they travel
const HOST_HANDOFF_MS = 30000;
const SOLO_MULT = 2;
const VOTE_MS = 12000;
const MAX_CHALLENGES = 3;
const MAX_BOTS = 6;
const COOP_CAP_MS = 30 * 60000; // Pass the Pen has no clock; this is just a backstop
const PEN_TIMES = [30, 45, 60, 90];
const DRY_TIMES = [10, 15, 20, 30];

const lobbies = new Map();

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!lobbies.has(c)) return c;
  }
}

const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
const { blocked } = require('./dict');
// Names show up in the public games list, so anything off-color becomes "Player".
const cleanName = s => {
  const name = String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
  const lower = name.toLowerCase();
  const words = lower.split(/[^a-z]+/).filter(Boolean);
  if (words.some(w => blocked.has(w)) || blocked.has(lower.replace(/[^a-z]/g, ''))) return 'Player';
  return name;
};

class Lobby {
  constructor() {
    this.code = newCode();
    this.members = new Map(); // id -> member
    this.alliances = new Map();
    this.hostId = null;
    this.phase = 'lobby';
    this.settings = { size: 4, minLen: 3, time: 120, handicap: false, chaos: false, chaosTypes: Object.keys(chaos.TYPES), mode: 'versus', penTime: 45, dryTime: 15 };
    this.customWords = new Set(); // challenged words the family voted in
    this.revealSpeed = 1;
    this.round = null;
    this.roundNo = 0;
    this.lastResults = null;
    this.timers = [];
    this.emptySince = Date.now();
    this.createdAt = Date.now();
    lobbies.set(this.code, this);
  }

  // ---------- membership ----------
  join(ws, { role, name, token }) {
    let m = token && [...this.members.values()].find(x => x.token === token);
    if (m) {
      if (m.ws && m.ws !== ws) { try { m.ws.close(4000, 'replaced'); } catch {} }
      m.ws = ws; m.connected = true;
      if (name) m.name = cleanName(name) || m.name;
    } else {
      role = role === 'screen' ? 'screen' : 'player';
      const players = [...this.members.values()].filter(x => x.role === 'player');
      if (role === 'player' && players.length >= 16) return { error: 'This lobby is full.' };
      const used = new Set(players.map(p => p.color));
      m = {
        id: crypto.randomBytes(4).toString('hex'),
        token: crypto.randomBytes(12).toString('hex'),
        role,
        name: role === 'screen' ? 'Screen' : (cleanName(name) || 'Player'),
        color: PLAYER_COLORS.find(c => !used.has(c)) || PLAYER_COLORS[players.length % PLAYER_COLORS.length],
        alliance: null,
        total: 0,
        hcpHistory: [], // golf-style differentials, newest last
        ws, connected: true, leftAt: 0,
      };
      this.members.set(m.id, m);
      if (!this.hostId) this.hostId = m.id;
    }
    ws.member = m; ws.lobby = this;
    this.emptySince = 0;
    this.send(m, { t: 'joined', code: this.code, you: { id: m.id, token: m.token, role: m.role } });
    this.broadcastState();
    if (this.round && (this.phase === 'countdown' || this.phase === 'playing' || this.phase === 'voting')) this.send(m, this.roundMsg(m));
    if (this.phase === 'voting' && this.vote && this.vote.cur) this.send(m, this.voteMsg());
    if (this.phase === 'results' && this.lastResults) { this.send(m, this.lastResults); this.send(m, { t: 'revealCtl', speed: this.revealSpeed }); }
    return { member: m };
  }

  disconnect(ws) {
    const m = ws.member;
    if (!m || m.ws !== ws) return;
    m.connected = false; m.ws = null; m.leftAt = Date.now();
    if (!this.humansOnline()) this.emptySince = Date.now();
    this.broadcastState();
  }

  humansOnline() { return [...this.members.values()].some(x => x.connected && !x.bot); }

  leave(m) {
    this.members.delete(m.id);
    if (m.alliance) this.pruneAlliances();
    if (this.hostId === m.id) this.pickHost();
    if (this.round) this.round.found.delete(m.id);
    if (!this.humansOnline()) this.emptySince = Date.now();
    this.broadcastState();
  }

  pickHost() {
    const humans = [...this.members.values()].filter(x => !x.bot);
    const live = humans.filter(x => x.connected);
    const next = live.find(x => x.role === 'screen') || live[0] || humans[0];
    this.hostId = next ? next.id : null;
  }

  // Called every few seconds.
  tick(now) {
    const host = this.members.get(this.hostId);
    if (host && !host.connected && now - host.leftAt > HOST_HANDOFF_MS) {
      const live = [...this.members.values()].filter(x => x.connected && !x.bot);
      if (live.length) { this.hostId = (live.find(x => x.role === 'screen') || live[0]).id; this.broadcastState(); }
    }
    const c = this.round && this.round.coop;
    if (c && !c.ended && this.phase === 'playing' && c.holder) {
      const h = this.members.get(c.holder);
      if (!h || (!h.connected && now - h.leftAt > 3000)) this.nextTurn();
    }
    // Drop players who have been gone a long time while the lobby sits idle.
    if (this.phase === 'lobby') {
      for (const m of [...this.members.values()]) if (!m.connected && now - m.leftAt > 15 * 60000) this.leave(m);
    }
  }

  // ---------- computer players ----------
  addBot(m, level) {
    if (m.id !== this.hostId || (this.phase !== 'lobby' && this.phase !== 'results')) return;
    const L = bots.LEVELS[level];
    if (!L) return;
    const players = this.playerList();
    if (players.length >= 16) return this.send(m, { t: 'error', msg: 'This lobby is full.' });
    if (players.filter(p => p.bot).length >= MAX_BOTS) return this.send(m, { t: 'error', msg: `Up to ${MAX_BOTS} bots per game.` });
    const used = new Set(players.map(p => p.color));
    const base = `${L.name} Bot`;
    let name = base;
    for (let k = 2; players.some(p => p.name === name); k++) name = `${base} ${k}`;
    const b = {
      id: crypto.randomBytes(4).toString('hex'), token: null, role: 'player', bot: level, name,
      color: PLAYER_COLORS.find(c => !used.has(c)) || PLAYER_COLORS[players.length % PLAYER_COLORS.length],
      alliance: null, total: 0, hcpHistory: [], ws: null, connected: true, leftAt: 0,
    };
    this.members.set(b.id, b);
    this.broadcastState();
  }

  removeBot(m, id) {
    if (m.id !== this.hostId) return;
    const b = this.members.get(id);
    if (!b || !b.bot) return;
    this.leave(b);
  }

  // Each bot's planned words go out on timers, held back while chaos says they can't count yet.
  runBots() {
    const r = this.round;
    const roundMs = r.endsAt - r.startAt;
    for (const b of this.playerList().filter(p => p.bot)) {
      const L = bots.LEVELS[b.bot];
      const setEv = r.chaos.find(e => e.type === 'set');
      const setPauseUntil = setEv ? setEv.at + setEv.dur * L.setPause : -1;
      for (const x of bots.plan(b.bot, r, roundMs)) {
        const tryIt = () => {
          if (this.round !== r || this.phase !== 'playing') return;
          const ms = Date.now() - r.startAt;
          if (ms > roundMs) return;
          const blocked =
            (setEv && ms >= setEv.at && ms < setPauseUntil) ||
            (chaos.active(r.chaos, 'robbert', ms) && x.w.length !== 3) ||
            (chaos.active(r.chaos, 'banana', ms) && r.banana.get(b.id) && x.path.some(i => r.banana.get(b.id).removed.has(i))) ||
            this.wordAt(x.path, ms) !== x.w;
          if (blocked) { this.later(tryIt, 2500 + crypto.randomInt(2000)); return; }
          this.word(b, x.w, x.path);
        };
        this.later(tryIt, r.startAt + x.at - Date.now());
      }
    }
  }

  // ---------- alliances ----------
  setAlliance(m, choice) {
    if (m.role !== 'player' || this.phase !== 'lobby') return;
    if (choice === 'new') {
      const usedNames = new Set([...this.alliances.values()].map(a => a.name));
      let name;
      for (let i = 0; i < 40 && (!name || usedNames.has(name)); i++) {
        name = `${ALLY_ADJ[crypto.randomInt(ALLY_ADJ.length)]} ${ALLY_NOUN[crypto.randomInt(ALLY_NOUN.length)]}`;
      }
      const usedColors = new Set([...this.alliances.values()].map(a => a.color));
      const a = { id: crypto.randomBytes(3).toString('hex'), name, color: ALLIANCE_COLORS.find(c => !usedColors.has(c)) || ALLIANCE_COLORS[0] };
      this.alliances.set(a.id, a);
      m.alliance = a.id;
    } else if (choice && this.alliances.has(choice)) {
      m.alliance = choice;
    } else {
      m.alliance = null;
    }
    this.pruneAlliances();
    this.broadcastState();
  }

  pruneAlliances() {
    for (const id of this.alliances.keys()) {
      if (![...this.members.values()].some(x => x.alliance === id)) this.alliances.delete(id);
    }
  }

  allies(m) {
    if (!m.alliance) return [];
    return [...this.members.values()].filter(x => x.alliance === m.alliance && x.id !== m.id);
  }

  // ---------- settings & rounds ----------
  setSettings(m, s) {
    if (m.id !== this.hostId || this.phase !== 'lobby') return;
    const size = clamp(s.size, 4, 6, this.settings.size);
    const minLen = clamp(s.minLen, 3, 6, this.settings.minLen);
    this.settings = {
      size, minLen,
      time: clamp(s.time, 30, 600, this.settings.time),
      handicap: s.handicap == null ? this.settings.handicap : !!s.handicap,
      chaos: s.chaos == null ? this.settings.chaos : !!s.chaos,
      chaosTypes: this.settings.chaosTypes,
      mode: s.mode === 'coop' || s.mode === 'versus' ? s.mode : this.settings.mode,
      penTime: PEN_TIMES.includes(+s.penTime) ? +s.penTime : this.settings.penTime,
      dryTime: DRY_TIMES.includes(+s.dryTime) ? +s.dryTime : this.settings.dryTime,
    };
    if (Array.isArray(s.chaosTypes)) {
      const picked = Object.keys(chaos.TYPES).filter(t => s.chaosTypes.includes(t));
      if (picked.length) this.settings.chaosTypes = picked; // at least one stays on
    }
    if (process.env.ROBGGLE_DEV && Array.isArray(s.force)) this.devForce = s.force.length ? s.force.map(String) : null;
    this.broadcastState();
  }

  start(m) {
    if (m.id !== this.hostId || (this.phase !== 'lobby' && this.phase !== 'results')) return;
    if (!this.playerList().length) return this.send(m, { t: 'error', msg: 'Need at least one player.' });
    this.clearTimers();
    const { size, minLen, time } = this.settings;
    const coop = this.settings.mode === 'coop';
    if (coop && !this.playerList().some(p => !p.bot)) return this.send(m, { t: 'error', msg: 'Pass the Pen needs at least one person.' });
    const { tiles, words } = deal(size, minLen, coop ? 240 : time);
    const salt = crypto.randomBytes(4).toString('hex');
    const now = Date.now();
    this.roundNo++;
    this.revealSpeed = 1;
    this.vote = null;
    this.round = {
      no: this.roundNo, tiles, size, minLen, words, salt,
      startAt: now + COUNTDOWN_MS,
      endsAt: now + COUNTDOWN_MS + (coop ? COOP_CAP_MS : time * 1000),
      mode: coop ? 'coop' : 'versus',
      found: new Map(),     // memberId -> Map(word -> { at, path, bonus, via, from })
      rejected: new Map(),  // memberId -> Map(word -> { path, challenged })
      stats: new Map(),     // memberId -> numbers the badges read
      challenges: [],       // { id, w, path, by: [{ id, at, path }] }
      banana: new Map(),    // memberId -> { removed: Set(tile), count }
      bananaSplit: [],
      tips: new Map(),        // Steven & Erin: words announced to everyone -> who found them
      hashes: [...words.keys()].map(w => fnv(salt + w)),
      chaos: process.env.ROBGGLE_DEV && this.devForce ? chaos.forced(this.devForce, size) : this.settings.chaos ? chaos.plan(coop ? 300 : time, size, this.settings.chaosTypes.filter(t => !coop || t !== 'leak')) : [],
      coop: coop ? { idx: -1, holder: null, turnNo: 0, dryTurns: 0, turns: [], turnWords: 0, turnStart: 0, lastWordAt: 0, timer: null, ended: false } : null,
    };
    this.phase = 'countdown';
    this.lastResults = null;
    for (const x of this.members.values()) this.send(x, this.roundMsg(x));
    this.broadcastState();
    this.later(() => { this.phase = 'playing'; this.broadcastState(); }, COUNTDOWN_MS);
    for (const e of this.round.chaos) {
      if (e.type === 'banana') this.later(() => this.bananaEnd(), this.round.startAt + e.at + e.dur - now);
    }
    this.later(() => this.finish(), this.round.endsAt - now + GRACE_MS);
    if (coop) this.later(() => this.nextTurn(), COUNTDOWN_MS);
    else this.runBots();
  }

  // ---------- Pass the Pen (co-op) ----------
  // Whose turn is next: people only (bots sit this mode out), in join order, skipping anyone offline.
  nextTurn() {
    const r = this.round, c = r && r.coop;
    if (!c || c.ended) return;
    const now = Date.now();
    clearTimeout(c.timer);
    if (c.holder) {
      c.turns.push({ id: c.holder, words: c.turnWords, ms: now - c.turnStart });
      c.dryTurns = c.turnWords ? 0 : c.dryTurns + 1;
      if (c.dryTurns >= 2) return this.coopEnd('dry');
    }
    const people = this.playerList().filter(p => !p.bot);
    if (!people.some(p => p.connected)) return this.coopEnd('empty');
    let next = null;
    for (let k = 1; k <= people.length && !next; k++) {
      const p = people[(c.idx + k) % people.length];
      if (p.connected) { next = p; c.idx = (c.idx + k) % people.length; }
    }
    c.holder = next.id;
    c.turnNo++;
    c.turnStart = now;
    c.lastWordAt = now;
    c.turnWords = 0;
    this.coopSchedule();
    this.broadcast(this.penMsg());
  }

  coopSchedule() {
    const c = this.round.coop;
    clearTimeout(c.timer);
    const due = Math.min(c.turnStart + this.settings.penTime * 1000, c.lastWordAt + this.settings.dryTime * 1000);
    c.timer = setTimeout(() => this.nextTurn(), Math.max(0, due - Date.now()));
    this.timers.push(c.timer);
  }

  penMsg() {
    const r = this.round, c = r.coop;
    return {
      t: 'pen', holder: c.holder, turnNo: c.turnNo, dryTurns: c.dryTurns,
      turnEndsAt: c.turnStart + this.settings.penTime * 1000, dryAt: c.lastWordAt + this.settings.dryTime * 1000,
      found: this.teamWords().length, total: r.words.size,
    };
  }

  teamWords() {
    const out = [];
    for (const [id, f] of this.round.found) for (const [w, x] of f) out.push({ w, by: id, at: x.at, pts: points(w) + (x.bonus || 0), path: x.path });
    return out.sort((a, b) => a.at - b.at);
  }

  passPen(m) {
    const c = this.round && this.round.coop;
    if (c && !c.ended && this.phase === 'playing' && m.id === c.holder) this.nextTurn();
  }

  coopEnd(reason) {
    const r = this.round, c = r.coop;
    if (c.ended) return;
    c.ended = true;
    clearTimeout(c.timer);
    r.endsAt = Date.now();
    this.broadcast({ t: 'coopEnd', reason, turns: c.turns.length });
    this.later(() => this.finish(), GRACE_MS);
  }

  playerList() { return [...this.members.values()].filter(x => x.role === 'player'); }

  stat(id) {
    const r = this.round;
    if (!r.stats.has(id)) r.stats.set(id, { times: [], rejected: 0 });
    return r.stats.get(id);
  }
  bump(id, key, n = 1) { const s = this.stat(id); s[key] = (s[key] || 0) + n; }

  roundMsg(m) {
    const r = this.round;
    const mine = r.found.get(m.id) || new Map();
    const allyWords = [];
    for (const a of this.allies(m)) {
      const f = r.found.get(a.id);
      if (f) for (const [w, x] of f) if (x.via !== 'leak') allyWords.push({ w, by: a.id, path: x.path });
    }
    const b = r.banana.get(m.id);
    return {
      t: 'round', no: r.no, tiles: r.tiles, size: r.size, minLen: r.minLen,
      startAt: r.startAt, endsAt: r.endsAt, salt: r.salt, hashes: r.hashes, total: r.words.size,
      mine: [...mine].map(([w, x]) => ({ w, pts: points(w) + (x.bonus || 0), via: x.via, from: x.from })),
      allyWords,
      rejected: [...(r.rejected.get(m.id) || new Map())].map(([w, x]) => ({ w, challenged: !!x.challenged })),
      chaos: r.chaos,
      banana: b ? { removed: [...b.removed], count: b.count, done: !!b.done } : null,
      bananaCounts: this.bananaCounts(),
      bananaSplit: r.bananaSplit,
      tips: [...r.tips].map(([w, x]) => ({ w, from: x.from, at: x.at })),
      handicap: this.settings.handicap,
      custom: [...this.customWords].map(w => fnv(r.salt + w)),
      mode: r.mode,
      pen: r.coop && r.coop.holder ? this.penMsg() : null,
      team: r.coop ? this.teamWords().map(x => ({ w: x.w, by: x.by, pts: x.pts })) : null,
      settings: { penTime: this.settings.penTime, dryTime: this.settings.dryTime },
    };
  }

  // Letters of `path` as the board looked `ms` into the round (Z tiles during a sleepover).
  wordAt(path, ms) { return path.map(i => chaos.letterAt(this.round, i, ms)).join(''); }

  validPath(path) {
    const r = this.round, n = r.size;
    if (!Array.isArray(path) || !path.length || path.length > n * n) return false;
    const seen = new Set();
    for (let k = 0; k < path.length; k++) {
      const i = path[k];
      if (!Number.isInteger(i) || i < 0 || i >= n * n || seen.has(i)) return false;
      seen.add(i);
      if (k) {
        const a = path[k - 1];
        if (Math.abs(Math.floor(a / n) - Math.floor(i / n)) > 1 || Math.abs((a % n) - (i % n)) > 1) return false;
      }
    }
    return true;
  }

  // +2 for touching two opposite sides, +5 for touching all four.
  bridgeBonus(path) {
    const n = this.round.size;
    const rows = new Set(path.map(i => Math.floor(i / n))), cols = new Set(path.map(i => i % n));
    const v = rows.has(0) && rows.has(n - 1), h = cols.has(0) && cols.has(n - 1);
    return v && h ? 5 : v || h ? 2 : 0;
  }

  word(m, raw, path) {
    const r = this.round;
    if (!r || m.role !== 'player') return;
    const w = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
    const now = Date.now();
    const ms = now - r.startAt;
    const reply = (ok, reason, extra = {}) => this.send(m, { t: 'wordResult', w, ok, reason, ...extra });
    if (this.phase !== 'playing' && this.phase !== 'countdown') return reply(false, 'time');
    if (now < r.startAt - 300 || now > r.endsAt + GRACE_MS) return reply(false, 'time');
    const st = this.stat(m.id);
    st.times.push(ms);
    if (!this.validPath(path)) return reply(false, 'path');
    // The tiles can change under a word (Z's), so accept the letters as they were a moment ago too.
    const matchMs = [ms, ms - 700, ms - 1400].find(t => this.wordAt(path, t) === w);
    if (matchMs === undefined) return reply(false, 'path');
    const banana = chaos.active(r.chaos, 'banana', ms);
    const bState = r.banana.get(m.id);
    if (banana && bState && path.some(i => bState.removed.has(i))) return reply(false, 'banana');
    if (chaos.active(r.chaos, 'robbert', ms) && w.length !== 3) { this.bump(m.id, 'robbertBad'); return reply(false, 'robbert'); }
    if (w.length < r.minLen) return reply(false, 'short');
    const c = r.coop;
    if (c && (c.ended || m.id !== c.holder)) return reply(false, 'notyou');
    let mine = r.found.get(m.id);
    if (!mine) r.found.set(m.id, (mine = new Map()));
    if (mine.has(w)) return reply(false, 'dupe');
    if (c && [...r.found.values()].some(f => f.has(w))) return reply(false, 'teamdupe');
    if (!valid.has(w) && !this.customWords.has(w)) {
      if (!r.rejected.has(m.id)) r.rejected.set(m.id, new Map());
      if (!r.rejected.get(m.id).has(w)) r.rejected.get(m.id).set(w, { path, at: ms });
      st.rejected++;
      const used = [...r.rejected.get(m.id).values()].filter(x => x.challenged).length;
      return reply(false, 'bad', { challengeable: used < MAX_CHALLENGES });
    }

    // Accepted.
    const bonus = this.bridgeBonus(path);
    let via = null, from = null;
    for (const a of this.allies(m)) {
      const x = r.found.get(a.id) && r.found.get(a.id).get(w);
      if (x && x.via !== 'leak' && x.at < ms) { via = 'copy'; from = a.id; }
    }
    mine.set(w, { at: ms, path, bonus, via, from });
    if (via === 'copy') { this.bump(m.id, 'copied'); this.bump(from, 'copiedFrom'); }
    const tip = r.tips.get(w);
    if (tip && tip.from !== m.id && tip.at < ms) { this.bump(m.id, 'tookTips'); this.bump(tip.from, 'tipTaken'); }
    if (bonus) this.bump(m.id, 'bridges');
    if (path.some(i => chaos.letterAt(r, i, matchMs) !== r.tiles[i])) this.bump(m.id, 'zWords');
    if (chaos.active(r.chaos, 'sam', ms)) this.bump(m.id, 'samWords');
    if (chaos.active(r.chaos, 'robbert', ms)) this.bump(m.id, 'robbertWords');
    let bananaDone = false;
    if (banana) {
      const b = bState || { removed: new Set(), count: 0, done: false };
      r.banana.set(m.id, b);
      if (!b.done) {
        path.forEach(i => b.removed.add(i));
        b.count += path.length;
        // Half the board in the banana and it's done: the tiles come back, and the first one there wins the badge.
        if (b.count >= banana.data.full) {
          b.done = true;
          b.removed.clear();
          bananaDone = true;
          const first = !r.bananaSplit.length;
          if (first) { r.bananaSplit = [m.id]; const st2 = this.stat(m.id); st2.bananaSplit = true; st2.banana = b.count; }
          this.later(() => this.broadcast({ t: 'bananaWin', id: m.id, first, count: b.count }), 50);
        }
      }
    }
    // Steven & Erin's Alliance Mode: some words get announced to everyone. They still have to find them.
    let leaked = false;
    const leak = chaos.active(r.chaos, 'leak', ms);
    if (leak && !r.tips.has(w) && crypto.randomInt(1000) < leak.data.chance * 1000) {
      leaked = true;
      r.tips.set(w, { from: m.id, at: ms });
      this.bump(m.id, 'leaked');
      this.later(() => this.broadcast({ t: 'tip', w, from: m.id, at: ms }), 30);
    }
    reply(true, null, { pts: points(w) + bonus, bonus, leaked, path: banana ? path : undefined, bananaDone });
    if (c) {
      c.turnWords++;
      c.lastWordAt = Date.now();
      this.broadcast({ t: 'coopWord', w, by: m.id, pts: points(w) + bonus, bonus });
      if (this.teamWords().length >= r.words.size) { this.coopEnd('all'); return; }
      this.coopSchedule();
      this.broadcast(this.penMsg());
    }
    for (const a of this.allies(m)) this.send(a, { t: 'ally', w, by: m.id, path });
    this.broadcast({ t: 'counts', counts: this.counts(), banana: banana ? this.bananaCounts() : undefined });
    if (bonus) this.broadcast({ t: 'bridge', id: m.id, kind: bonus === 5 ? 'both' : 'one', bonus });
  }

  bananaCounts() {
    const out = {};
    if (this.round) for (const [id, b] of this.round.banana) out[id] = b.count;
    return out;
  }

  bananaEnd() {
    const r = this.round;
    if (!r) return;
    for (const b of r.banana.values()) b.removed.clear();
    this.broadcast({ t: 'bananaEnd', winner: r.bananaSplit[0] || null, counts: this.bananaCounts() });
  }

  setCleared(m, ms) {
    if (!this.round || m.role !== 'player') return;
    const s = this.stat(m.id);
    if (!s.setCleared) s.setCleared = clamp(ms, 1, 60000, 1);
  }

  counts() {
    const out = {};
    if (this.round) for (const [id, f] of this.round.found) out[id] = f.size;
    return out;
  }

  // ---------- challenges ----------
  challenge(m, raw) {
    const r = this.round;
    if (!r || m.role !== 'player' || (this.phase !== 'playing' && this.phase !== 'countdown')) return;
    const w = String(raw || '').toLowerCase();
    const rej = r.rejected.get(m.id);
    const x = rej && rej.get(w);
    if (!x || x.challenged) return;
    if ([...rej.values()].filter(y => y.challenged).length >= MAX_CHALLENGES) return this.send(m, { t: 'error', msg: `Only ${MAX_CHALLENGES} challenges per round.` });
    x.challenged = true;
    this.bump(m.id, 'challenges');
    let c = r.challenges.find(y => y.w === w);
    if (!c) r.challenges.push((c = { id: crypto.randomBytes(3).toString('hex'), w, path: x.path, by: [] }));
    c.by.push({ id: m.id, at: x.at, path: x.path });
    this.send(m, { t: 'challengeAck', w });
    this.broadcast({ t: 'challengeCount', n: r.challenges.length });
  }

  runVotes() {
    const r = this.round;
    this.phase = 'voting';
    this.vote = { list: r.challenges.slice(), idx: -1, cur: null };
    this.broadcastState();
    this.nextVote();
  }

  nextVote() {
    const v = this.vote;
    v.idx++;
    if (v.idx >= v.list.length) { v.cur = null; return this.results(); }
    const c = v.list[v.idx];
    const challengers = new Set(c.by.map(b => b.id));
    const eligible = this.playerList().filter(p => p.connected && !challengers.has(p.id)).map(p => p.id);
    v.cur = { c, eligible: new Set(eligible), yes: new Set(), no: new Set(), endsAt: Date.now() + VOTE_MS };
    if (!eligible.length) return this.closeVote(true);
    this.broadcast(this.voteMsg());
    this.later(() => this.closeVote(), VOTE_MS);
    for (const id of eligible) {
      const b = this.members.get(id);
      if (b && b.bot) this.later(() => this.castVote(b, c.id, crypto.randomInt(1000) < bots.LEVELS[b.bot].voteYes * 1000), 1500 + crypto.randomInt(3000));
    }
  }

  voteMsg() {
    const v = this.vote, cur = v.cur;
    return {
      t: 'vote', id: cur.c.id, w: cur.c.w, path: cur.c.path, by: cur.c.by.map(b => b.id),
      endsAt: cur.endsAt, index: v.idx, total: v.list.length, eligible: [...cur.eligible],
      yes: cur.yes.size, no: cur.no.size, tiles: this.round.tiles, size: this.round.size,
    };
  }

  castVote(m, id, yes) {
    const cur = this.vote && this.vote.cur;
    if (!cur || cur.c.id !== id || !cur.eligible.has(m.id)) return;
    cur.yes.delete(m.id); cur.no.delete(m.id);
    (yes ? cur.yes : cur.no).add(m.id);
    this.broadcast({ t: 'voteTally', id, yes: cur.yes.size, no: cur.no.size, voted: [...cur.yes, ...cur.no] });
    if (cur.yes.size + cur.no.size >= cur.eligible.size) { this.clearTimers(); this.later(() => this.closeVote(), 700); }
  }

  closeVote(auto) {
    const cur = this.vote && this.vote.cur;
    if (!cur || cur.closed) return;
    cur.closed = true;
    const r = this.round;
    const accepted = auto ? true : cur.yes.size > cur.no.size; // majority of the votes cast
    const c = cur.c;
    for (const b of c.by) {
      if (accepted) {
        let f = r.found.get(b.id);
        if (!f) r.found.set(b.id, (f = new Map()));
        if (!f.has(c.w)) f.set(c.w, { at: b.at, path: b.path, bonus: this.bridgeBonus(b.path), via: 'challenge' });
        this.bump(b.id, 'challengesWon');
      } else this.bump(b.id, 'challengesLost');
    }
    if (accepted) this.customWords.add(c.w);
    this.broadcast({ t: 'voteResult', id: c.id, w: c.w, accepted, yes: cur.yes.size, no: cur.no.size, auto: !!auto });
    this.later(() => this.nextVote(), 2600);
  }

  // ---------- end of round ----------
  finish() {
    const r = this.round;
    if (!r || this.phase === 'results' || this.phase === 'voting') return;
    if (r.challenges.length) return this.runVotes();
    this.results();
  }

  handicapIndex(m) {
    const h = m.hcpHistory;
    if (h.length < 2) return 0; // like golf, you need a couple of rounds before you get one
    const n = Math.max(1, Math.ceil(h.length * 0.4));            // golf: best 8 of the last 20
    const best = h.slice().sort((a, b) => a - b).slice(0, n);
    return Math.min(60, Math.round((best.reduce((s, x) => s + x, 0) / n) * 0.96 * 10) / 10); // golf's 96%
  }

  results() {
    const r = this.round;
    this.phase = 'results';
    this.vote = null;
    const players = this.playerList().filter(p => !r.coop || !p.bot);

    // Which group found each word? An alliance counts as one group; a lone player is their own.
    const groupOf = id => { const m = this.members.get(id); return m && m.alliance ? 'a:' + m.alliance : 'p:' + id; };
    const finders = new Map();
    for (const [id, f] of r.found) for (const [w, x] of f) {
      if (!this.members.has(id)) continue;
      if (!finders.has(w)) finders.set(w, []);
      finders.get(w).push({ id, ...x });
    }

    const gross = {}, soloCount = {}, bridgeCount = {};
    const words = [];
    const n2 = r.size * r.size;
    const heatAll = new Array(n2).fill(0);
    const heatBy = {};
    for (const [w, list] of finders) {
      list.sort((a, b) => a.at - b.at);
      const groups = new Set(list.map(x => groupOf(x.id)));
      const solo = !r.coop && groups.size === 1 && players.length > 1;
      const base = points(w);
      const pts = solo ? base * SOLO_MULT : base;
      const bonus = {}, via = {};
      for (const x of list) {
        gross[x.id] = (gross[x.id] || 0) + pts + (x.bonus || 0);
        if (solo) soloCount[x.id] = (soloCount[x.id] || 0) + 1;
        if (x.bonus) { bonus[x.id] = x.bonus; bridgeCount[x.id] = (bridgeCount[x.id] || 0) + 1; }
        if (x.via) via[x.id] = x.via;
        if (x.via !== 'leak' && x.path) {
          heatBy[x.id] = heatBy[x.id] || new Array(n2).fill(0);
          for (const i of x.path) { heatBy[x.id][i]++; heatAll[i]++; }
        }
      }
      const g = [...groups][0];
      const own = list.find(x => x.via !== 'leak') || list[0];
      words.push({
        w, base, pts, solo, soloBy: solo ? (g.startsWith('a:') ? { alliance: g.slice(2) } : { player: g.slice(2) }) : null,
        finders: list.map(x => x.id), bonus, via, path: own.path || r.words.get(w),
      });
    }
    words.sort((a, b) => a.w.length - b.w.length || a.finders.length - b.finders.length || a.w.localeCompare(b.w));

    const bananaBonus = {}; // the Banana Split is a badge now, not points
    const after = id => gross[id] || 0;
    const best = Math.max(0, ...players.map(p => after(p.id)));

    const out = [];
    for (const m of players) {
      const g = after(m.id);
      const useHcp = this.settings.handicap && !r.coop;
      const hcp = useHcp ? this.handicapIndex(m) : 0;
      const strokes = useHcp ? Math.round((hcp / 100) * best) : 0;
      const net = g + strokes;
      m.total += net;
      if (useHcp && best > 0) {
        m.hcpHistory.push(((best - g) / best) * 100);
        if (m.hcpHistory.length > 10) m.hcpHistory.shift();
      }
      out.push({
        id: m.id, name: m.name, color: m.color, alliance: m.alliance,
        gross: gross[m.id] || 0, bananaBonus: bananaBonus[m.id] || 0, hcp, strokes, round: net, total: m.total,
        words: (r.found.get(m.id) || new Map()).size, solos: soloCount[m.id] || 0, bridges: bridgeCount[m.id] || 0,
        nextHcp: this.settings.handicap ? this.handicapIndex(m) : 0,
      });
    }
    const alliances = [...this.alliances.values()].map(a => {
      const mem = out.filter(p => p.alliance === a.id);
      return { ...a, members: mem.map(p => p.id), round: mem.reduce((s, p) => s + p.round, 0), total: mem.reduce((s, p) => s + p.total, 0) };
    }).filter(a => a.members.length);

    const missed = [...r.words.keys()]
      .filter(w => !finders.has(w) && common.has(w))
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .slice(0, 10)
      .map(w => ({ w, pts: points(w), path: r.words.get(w) }));
    const bestWord = words.filter(x => Object.values(x.via).every(v => v !== 'leak') || x.finders.length).slice().sort((a, b) => b.w.length - a.w.length || (b.solo - a.solo))[0] || null;

    // Badge inputs per player.
    const perPlayer = new Map();
    for (const m of players) {
      const s = { ...this.stat(m.id) };
      const own = [...(r.found.get(m.id) || new Map())].filter(([, x]) => x.via !== 'leak').sort((a, b) => a[1].at - b[1].at);
      s.words = own.map(([w]) => w);
      s.orderWords = s.words;
      s.wordTimes = own.map(([, x]) => x.at);
      s.bridges = bridgeCount[m.id] || 0;
      perPlayer.set(m.id, s);
    }
    const badges = award({ players: out, perPlayer, roundMs: r.endsAt - r.startAt, words, coop: !!r.coop });

    this.lastResults = {
      t: 'results', no: r.no, tiles: r.tiles, size: r.size, words, players: out, alliances, missed,
      possible: r.words.size, best: bestWord ? { w: bestWord.w, by: bestWord.finders.filter(id => bestWord.via[id] !== 'leak') } : null,
      soloMult: SOLO_MULT, heat: { all: heatAll, by: heatBy }, badges, handicap: this.settings.handicap,
      chaos: r.chaos.map(e => e.type), bananaSplit: r.bananaSplit,
      mode: r.mode,
      coop: r.coop ? { found: words.length, possible: r.words.size, turns: r.coop.turns, passes: r.coop.turns.length, points: out.reduce((sum, p) => sum + p.gross, 0) } : null,
    };
    this.banterLog = new Map();
    this.broadcast(this.lastResults);
    if (!r.coop) for (const b of players.filter(p => p.bot)) this.later(() => this.attitude(b, bots.attitude(b.bot)), 7000 + crypto.randomInt(9000));
    this.broadcastState();
  }

  revealCtl(m, msg) {
    if (m.id !== this.hostId || this.phase !== 'results') return;
    const out = { t: 'revealCtl' };
    if ([0.5, 1, 2, 4].includes(+msg.speed)) { this.revealSpeed = +msg.speed; out.speed = this.revealSpeed; }
    if (msg.skip) out.skip = true;
    this.broadcast(out);
  }

  // Good/bad winner/loser speech bubbles.
  attitude(m, kind) {
    const R = this.lastResults;
    if (!R || this.phase !== 'results' || m.role !== 'player' || R.mode === 'coop') return;
    const log = this.banterLog.get(m.id) || { n: 0, last: 0 };
    if (log.n >= 4 || Date.now() - log.last < 2500) return;
    log.n++; log.last = Date.now();
    this.banterLog.set(m.id, log);
    const ranked = R.players.slice().sort((a, b) => b.round - a.round);
    const me = R.players.find(p => p.id === m.id);
    if (!me) return;
    const won = me.round === ranked[0].round && me.round > 0;
    const others = R.players.filter(p => p.id !== m.id);
    const winner = ranked.find(p => p.id !== m.id && p.round === ranked[0].round) || ranked[0];
    const loser = others.slice().sort((a, b) => a.round - b.round)[0];
    const myWords = R.words.filter(w => w.finders.includes(m.id)).sort((a, b) => b.w.length - a.w.length);
    const tried = this.round && this.round.rejected.get(m.id);
    const role = (kind === 'bad' ? 'bad' : 'good') + (won ? 'Winner' : 'Loser');
    const text = banter.line(role, {
      me: me.name, pts: me.round, winner: winner ? winner.name : 'the winner', loser: loser ? loser.name : '',
      other: others.length ? others[Math.floor(Math.random() * others.length)].name : '',
      word: (myWords[0] && myWords[0].w || '').toUpperCase(),
      rejected: tried && tried.size ? [...tried.keys()].filter(w => !R.words.some(x => x.w === w))[0]?.toUpperCase() || '' : '',
      margin: Math.max(1, ranked[0].round - me.round),
    });
    this.broadcast({ t: 'banter', id: m.id, role, text });
  }

  backToLobby(m) {
    if (m.id !== this.hostId || this.phase !== 'results') return;
    this.phase = 'lobby';
    this.broadcastState();
  }

  resetScores(m) {
    if (m.id !== this.hostId || this.phase !== 'lobby') return;
    for (const x of this.members.values()) { x.total = 0; x.hcpHistory = []; }
    this.broadcastState();
  }

  rename(m, name) {
    m.name = cleanName(name) || m.name;
    this.broadcastState();
  }

  // ---------- plumbing ----------
  publicState() {
    return {
      t: 'state', code: this.code, phase: this.phase, hostId: this.hostId, settings: this.settings, roundNo: this.roundNo,
      members: [...this.members.values()].map(m => ({ id: m.id, role: m.role, name: m.name, color: m.color, alliance: m.alliance, total: m.total, connected: m.connected, bot: m.bot || null, hcp: m.role === 'player' ? this.handicapIndex(m) : 0 })),
      alliances: [...this.alliances.values()],
      counts: this.counts(),
    };
  }

  summary() {
    const host = this.members.get(this.hostId);
    const players = [...this.members.values()].filter(m => m.role === 'player');
    return {
      code: this.code, phase: this.phase, host: host ? host.name : '?',
      players: players.length, names: players.slice(0, 6).map(p => p.name),
      screen: [...this.members.values()].some(m => m.role === 'screen' && m.connected),
      settings: this.settings,
    };
  }

  isLive() { return this.humansOnline(); }

  send(m, msg) {
    if (m.ws && m.ws.readyState === 1) m.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const m of this.members.values()) this.send(m, s);
  }
  broadcastState() { this.broadcast(this.publicState()); }
  later(fn, ms) { this.timers.push(setTimeout(fn, ms)); }
  clearTimers() { this.timers.forEach(clearTimeout); this.timers = []; }
  destroy() { this.clearTimers(); lobbies.delete(this.code); }
}

module.exports = { Lobby, lobbies };
