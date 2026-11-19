// One Lobby per game. The server is the only clock and the only judge of words.
const crypto = require('crypto');
const { deal, points, fnv, common } = require('./board');

const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels, so codes never spell words
const PLAYER_COLORS = ['#ff6b4a', '#3ee0b0', '#ffd23f', '#5ab0ff', '#ff5ca8', '#b48cff', '#9be15d', '#ff9f43', '#4de8f0', '#f78fb3', '#c7ecee', '#e1b12c'];
const ALLIANCE_COLORS = ['#ff6b4a', '#3ee0b0', '#5ab0ff', '#ffd23f', '#ff5ca8', '#b48cff'];
const ALLY_ADJ = ['Sneaky', 'Mighty', 'Midnight', 'Crispy', 'Feral', 'Cosmic', 'Spicy', 'Velvet', 'Turbo', 'Grumpy', 'Lucky', 'Wobbly'];
const ALLY_NOUN = ['Pickles', 'Owls', 'Meatballs', 'Raccoons', 'Noodles', 'Goblins', 'Pancakes', 'Walruses', 'Gremlins', 'Biscuits', 'Moths', 'Waffles'];

const COUNTDOWN_MS = 3600;
const GRACE_MS = 1500;       // words traced at the buzzer still count while they travel
const HOST_HANDOFF_MS = 30000;
const SOLO_MULT = 2;

const lobbies = new Map();

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!lobbies.has(c)) return c;
  }
}

const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);

class Lobby {
  constructor() {
    this.code = newCode();
    this.members = new Map(); // id -> member
    this.alliances = new Map();
    this.hostId = null;
    this.phase = 'lobby';
    this.settings = { size: 4, minLen: 3, time: 120 };
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
        ws, connected: true, leftAt: 0,
      };
      this.members.set(m.id, m);
      if (!this.hostId) this.hostId = m.id;
    }
    ws.member = m; ws.lobby = this;
    this.emptySince = 0;
    this.send(m, { t: 'joined', code: this.code, you: { id: m.id, token: m.token, role: m.role } });
    this.broadcastState();
    if (this.round && (this.phase === 'countdown' || this.phase === 'playing')) this.send(m, this.roundMsg(m));
    if (this.phase === 'results' && this.lastResults) this.send(m, this.lastResults);
    return { member: m };
  }

  disconnect(ws) {
    const m = ws.member;
    if (!m || m.ws !== ws) return;
    m.connected = false; m.ws = null; m.leftAt = Date.now();
    if (![...this.members.values()].some(x => x.connected)) this.emptySince = Date.now();
    this.broadcastState();
  }

  leave(m) {
    this.members.delete(m.id);
    if (m.alliance) this.pruneAlliances();
    if (this.hostId === m.id) this.pickHost();
    if (this.round) this.round.found.delete(m.id);
    if (!this.members.size) this.emptySince = Date.now();
    this.broadcastState();
  }

  pickHost() {
    const live = [...this.members.values()].filter(x => x.connected);
    const next = live.find(x => x.role === 'screen') || live[0] || [...this.members.values()][0];
    this.hostId = next ? next.id : null;
  }

  // Called every few seconds.
  tick(now) {
    const host = this.members.get(this.hostId);
    if (host && !host.connected && now - host.leftAt > HOST_HANDOFF_MS) {
      const live = [...this.members.values()].filter(x => x.connected);
      if (live.length) { this.hostId = (live.find(x => x.role === 'screen') || live[0]).id; this.broadcastState(); }
    }
    // Drop players who have been gone a long time while the lobby sits idle.
    if (this.phase === 'lobby') {
      for (const m of [...this.members.values()]) if (!m.connected && now - m.leftAt > 15 * 60000) this.leave(m);
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
    let minLen = clamp(s.minLen, 3, 6, this.settings.minLen);
    this.settings = { size, minLen, time: clamp(s.time, 30, 600, this.settings.time) };
    this.broadcastState();
  }

  start(m) {
    if (m.id !== this.hostId || (this.phase !== 'lobby' && this.phase !== 'results')) return;
    if (![...this.members.values()].some(x => x.role === 'player')) return this.send(m, { t: 'error', msg: 'Need at least one player.' });
    this.clearTimers();
    const { size, minLen, time } = this.settings;
    const { tiles, words } = deal(size, minLen);
    const salt = crypto.randomBytes(4).toString('hex');
    const now = Date.now();
    this.roundNo++;
    this.round = {
      no: this.roundNo, tiles, size, minLen, words, salt,
      startAt: now + COUNTDOWN_MS,
      endsAt: now + COUNTDOWN_MS + time * 1000,
      found: new Map(), // memberId -> Map(word -> ms into round)
      hashes: [...words.keys()].map(w => fnv(salt + w)),
    };
    this.phase = 'countdown';
    this.lastResults = null;
    for (const x of this.members.values()) this.send(x, this.roundMsg(x));
    this.broadcastState();
    this.later(() => { this.phase = 'playing'; this.broadcastState(); }, COUNTDOWN_MS);
    this.later(() => this.finish(), this.round.endsAt - now + GRACE_MS);
  }

  roundMsg(m) {
    const r = this.round;
    const mine = r.found.get(m.id);
    const allyWords = [];
    for (const a of this.allies(m)) {
      const f = r.found.get(a.id);
      if (f) for (const w of f.keys()) allyWords.push({ w, by: a.id, path: r.words.get(w) });
    }
    return {
      t: 'round', no: r.no, tiles: r.tiles, size: r.size, minLen: r.minLen,
      startAt: r.startAt, endsAt: r.endsAt, salt: r.salt, hashes: r.hashes, total: r.words.size,
      mine: mine ? [...mine.keys()] : [], allyWords,
    };
  }

  word(m, raw) {
    const r = this.round;
    const w = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!r || m.role !== 'player') return;
    const now = Date.now();
    const reply = (ok, reason, extra = {}) => this.send(m, { t: 'wordResult', w, ok, reason, ...extra });
    if (now < r.startAt - 300 || now > r.endsAt + GRACE_MS) return reply(false, 'time');
    if (w.length < r.minLen) return reply(false, 'short');
    if (!r.words.has(w)) return reply(false, 'bad');
    let mine = r.found.get(m.id);
    if (!mine) r.found.set(m.id, (mine = new Map()));
    if (mine.has(w)) return reply(false, 'dupe');
    mine.set(w, now - r.startAt);
    reply(true, null, { pts: points(w) });
    for (const a of this.allies(m)) this.send(a, { t: 'ally', w, by: m.id, path: r.words.get(w) });
    this.broadcast({ t: 'counts', counts: this.counts() });
  }

  counts() {
    const out = {};
    if (this.round) for (const [id, f] of this.round.found) out[id] = f.size;
    return out;
  }

  finish() {
    const r = this.round;
    if (!r || this.phase === 'results') return;
    this.phase = 'results';

    // Which group found each word? An alliance counts as one group; a lone player is their own.
    const groupOf = id => { const m = this.members.get(id); return m && m.alliance ? 'a:' + m.alliance : 'p:' + id; };
    const finders = new Map();
    for (const [id, f] of r.found) for (const [w, at] of f) {
      if (!finders.has(w)) finders.set(w, []);
      finders.get(w).push({ id, at });
    }

    const roundScore = {};
    const soloCount = {};
    const words = [];
    for (const [w, list] of finders) {
      list.sort((a, b) => a.at - b.at);
      const groups = new Set(list.map(x => groupOf(x.id)));
      const solo = groups.size === 1 && this.members.size > 1 && [...this.members.values()].filter(x => x.role === 'player').length > 1;
      const base = points(w);
      const pts = solo ? base * SOLO_MULT : base;
      for (const x of list) {
        roundScore[x.id] = (roundScore[x.id] || 0) + pts;
        if (solo) soloCount[x.id] = (soloCount[x.id] || 0) + 1;
      }
      const g = [...groups][0];
      words.push({ w, base, pts, solo, soloBy: solo ? (g.startsWith('a:') ? { alliance: g.slice(2) } : { player: g.slice(2) }) : null, finders: list.map(x => x.id), path: r.words.get(w) });
    }
    words.sort((a, b) => a.w.length - b.w.length || a.finders.length - b.finders.length || a.w.localeCompare(b.w));

    const players = [];
    for (const m of this.members.values()) {
      if (m.role !== 'player') continue;
      m.total += roundScore[m.id] || 0;
      players.push({ id: m.id, name: m.name, color: m.color, alliance: m.alliance, round: roundScore[m.id] || 0, total: m.total, words: (r.found.get(m.id) || new Map()).size, solos: soloCount[m.id] || 0 });
    }
    const alliances = [...this.alliances.values()].map(a => {
      const mem = players.filter(p => p.alliance === a.id);
      return { ...a, members: mem.map(p => p.id), round: mem.reduce((s, p) => s + p.round, 0), total: mem.reduce((s, p) => s + p.total, 0) };
    }).filter(a => a.members.length);

    const missed = [...r.words.keys()]
      .filter(w => !finders.has(w) && common.has(w))
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .slice(0, 10)
      .map(w => ({ w, pts: points(w), path: r.words.get(w) }));

    const best = words.slice().sort((a, b) => b.w.length - a.w.length || (b.solo - a.solo))[0] || null;

    this.lastResults = {
      t: 'results', no: r.no, tiles: r.tiles, size: r.size, words, players, alliances, missed,
      possible: r.words.size, best: best ? { w: best.w, by: best.finders } : null, soloMult: SOLO_MULT,
    };
    this.broadcast(this.lastResults);
    this.broadcastState();
  }

  backToLobby(m) {
    if (m.id !== this.hostId || this.phase !== 'results') return;
    this.phase = 'lobby';
    this.broadcastState();
  }

  resetScores(m) {
    if (m.id !== this.hostId || this.phase !== 'lobby') return;
    for (const x of this.members.values()) x.total = 0;
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
      members: [...this.members.values()].map(m => ({ id: m.id, role: m.role, name: m.name, color: m.color, alliance: m.alliance, total: m.total, connected: m.connected })),
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

  isLive() { return [...this.members.values()].some(m => m.connected); }

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
