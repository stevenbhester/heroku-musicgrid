// Last Mile's daily puzzle results, for the "How everyone did" page: each player's result for the day
// (solved or not, score, time, tries, route length, undos, badges), and today's numbers for everyone.
//
//   POST /daily                one player's day (see readResult) -> 201 { ok } (or 200 if it changed nothing)
//                              One result per device per day: a later one replaces it, except that a
//                              solve is never replaced by a miss.
//   GET  /daily/stats?day=YYYY-MM-DD
//                              -> { day, players, solved, scoreAvg, scores, secs, tries, badges }
//                              scores: solvers by score, in tens ({"150": 12} is 150-159)
//                              secs: solvers by time, in 5 s steps up to 300 ("300" is 5 minutes or more)
//                              tries: solvers by tries taken ({"1": n, ... "6": n})
//                              badges: how many solvers earned each badge
//                              Worked out at most once a minute per day.
//
// Nothing here says who a player is: `device` is a random id the game made up. No address is kept.
// Kept in Postgres when there's a database, in memory otherwise (tests; a restart forgets them).

const HEX32 = /^[0-9a-f]{32}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^[\w .()+-]{1,32}$/;
const BADGE = /^[a-z0-9_]{1,24}$/;
const STATS_FOR_MS = 60_000;

class BadResult extends Error {}

function int(body, field, lo, hi) {
  const v = body[field];
  if (!Number.isInteger(v) || v < lo || v > hi) throw new BadResult(`${field} must be a whole number from ${lo} to ${hi}.`);
  return v;
}

// What a day's result may look like. Only these fields go any further.
function readResult(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadResult('Send a JSON object.');
  if (typeof body.device !== 'string' || !HEX32.test(body.device)) throw new BadResult('device must be 32 hex characters.');
  if (typeof body.day !== 'string' || !DAY.test(body.day)) throw new BadResult('day must be YYYY-MM-DD.');
  if (typeof body.version !== 'string' || !VERSION.test(body.version)) throw new BadResult('version is missing or odd.');
  if (typeof body.solved !== 'boolean') throw new BadResult('solved must be true or false.');
  const secs = body.secs;
  if (typeof secs !== 'number' || !Number.isFinite(secs) || secs < 0 || secs > 86400) throw new BadResult('secs is odd.');
  const badges = body.badges === undefined ? [] : body.badges;
  if (!Array.isArray(badges) || badges.length > 24 || badges.some((b) => typeof b !== 'string' || !BADGE.test(b))) {
    throw new BadResult('badges must be a short list of names.');
  }
  return {
    device: body.device,
    day: body.day,
    version: body.version,
    solved: body.solved,
    score: int(body, 'score', 0, 10000),
    secs: Math.round(secs * 10) / 10,
    tries: int(body, 'tries', 1, 20),
    tiles: int(body, 'tiles', 0, 10000),
    undos: int(body, 'undos', 0, 10000),
    badges: [...new Set(badges)],
  };
}

// Today's numbers from its rows.
function summarize(day, rows) {
  const out = { day, players: rows.length, solved: 0, scoreAvg: 0, scores: {}, secs: {}, tries: {}, badges: {} };
  let total = 0;
  for (const r of rows) {
    if (!r.solved) continue;
    out.solved += 1;
    total += r.score;
    const s = String(Math.floor(r.score / 10) * 10);
    out.scores[s] = (out.scores[s] || 0) + 1;
    const t = String(Math.min(300, Math.floor(r.secs / 5) * 5));
    out.secs[t] = (out.secs[t] || 0) + 1;
    const n = String(Math.min(6, r.tries));
    out.tries[n] = (out.tries[n] || 0) + 1;
    for (const b of r.badges) out.badges[b] = (out.badges[b] || 0) + 1;
  }
  out.scoreAvg = out.solved ? Math.round(total / out.solved) : 0;
  return out;
}

function createMemoryStore() {
  const rows = new Map();
  return {
    kind: 'memory',
    async ready() {},
    async put(r) {
      const key = `${r.device}|${r.day}`;
      const had = rows.get(key);
      if (had && had.solved && !r.solved) return false;
      rows.set(key, { ...r });
      return true;
    },
    async day(day) {
      return [...rows.values()].filter((r) => r.day === day);
    },
  };
}

function createPgStore({ pool, url }) {
  if (!pool) {
    const { Pool } = require('pg'); // eslint-disable-line global-require
    pool = new Pool({
      connectionString: url,
      max: 2, // it shares the database with MusicGrid's own pool
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    });
    pool.on('error', (err) => console.error(`[lm daily] Idle database connection: ${err.message}`));
  }
  let made = null;
  return {
    kind: 'postgres',
    ready() {
      made = made || (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS lm_daily_results (
          device TEXT NOT NULL, day TEXT NOT NULL, version TEXT NOT NULL, solved BOOLEAN NOT NULL,
          score INTEGER NOT NULL DEFAULT 0, secs REAL NOT NULL DEFAULT 0, tries SMALLINT NOT NULL DEFAULT 1,
          tiles INTEGER NOT NULL DEFAULT 0, undos INTEGER NOT NULL DEFAULT 0, badges JSONB NOT NULL DEFAULT '[]',
          received_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (device, day))`);
        await pool.query('CREATE INDEX IF NOT EXISTS lm_daily_results_day ON lm_daily_results (day)');
      })().catch((err) => { made = null; throw err; });
      return made;
    },
    async put(r) {
      const res = await pool.query(
        `INSERT INTO lm_daily_results (device, day, version, solved, score, secs, tries, tiles, undos, badges)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (device, day) DO UPDATE SET version = EXCLUDED.version, solved = EXCLUDED.solved,
           score = EXCLUDED.score, secs = EXCLUDED.secs, tries = EXCLUDED.tries, tiles = EXCLUDED.tiles,
           undos = EXCLUDED.undos, badges = EXCLUDED.badges, received_at = now()
         WHERE NOT lm_daily_results.solved OR EXCLUDED.solved`,
        [r.device, r.day, r.version, r.solved, r.score, r.secs, r.tries, r.tiles, r.undos, JSON.stringify(r.badges)]);
      return res.rowCount === 1;
    },
    async day(day) {
      const res = await pool.query(
        'SELECT solved, score, secs, tries, badges FROM lm_daily_results WHERE day = $1', [day]);
      return res.rows;
    },
  };
}

function createDaily({ store, now = () => Date.now() }) {
  const cache = new Map(); // day -> { at, body }
  return {
    async add(body) {
      const r = readResult(body);
      await store.ready();
      // (Today's numbers stay cached for up to a minute; the game shows the player's own result itself.)
      const changed = await store.put(r);
      return { status: changed ? 201 : 200, body: { ok: true } };
    },
    async stats(query) {
      const day = String(query.day || '');
      if (!DAY.test(day)) throw new BadResult('day must be YYYY-MM-DD.');
      const hit = cache.get(day);
      if (hit && now() - hit.at < STATS_FOR_MS) return { status: 200, body: hit.body };
      await store.ready();
      const body = summarize(day, await store.day(day));
      cache.set(day, { at: now(), body });
      return { status: 200, body };
    },
  };
}

module.exports = { createDaily, createMemoryStore, createPgStore, readResult, summarize, BadResult };
