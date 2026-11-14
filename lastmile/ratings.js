// Level ratings from inside Last Mile: after a level, a tester who has turned
// "Rate levels" on says how hard, how fun and how frustrating it was, picks a
// few descriptors, maybe adds a note, and the game sends that with what it
// counted while they played (wrong moves, undos, hints, restarts, time).
//
//   POST /ratings            the rating (see readRating for the fields) -> 201 { ok, id }
//                            the same id again -> 200 { ok, id, duplicate: true }
//   GET  /ratings            admin only (x-admin-key): { ratings: [...] }, oldest first
//        ?since=<ISO time>   only those received after it
//        ?limit=<n>          at most n (default 5000, most 20000)
//
// Nothing here says who a player is: `device` is a random id the game made up
// the first time it ran, `session` a random id per launch. No address is kept.
// Ratings are kept in Postgres when there's a database, and in memory otherwise
// (tests, and running it by hand: a restart forgets them all).

const { clean, oneLine } = require('../frontiers/text');

const HEX32 = /^[0-9a-f]{32}$/;
const VERSION = /^[\w .()+-]{1,32}$/;
const MADE_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const TAG = /^[a-z0-9_]{1,32}$/;
const STAT_KEY = /^[a-z0-9_]{1,40}$/;
const LIMITS = { note: 600, title: 60, flavor: 24, where: 40, fp: 24, tags: 16, stats: 80, statText: 80 };

class BadRating extends Error {}

function id32(body, field) {
  const v = body[field];
  if (typeof v !== 'string' || !HEX32.test(v)) throw new BadRating(`${field} must be 32 hex characters.`);
  return v;
}

function stars(body, field) {
  const v = body[field];
  if (v === undefined || v === null) return 0;
  if (!Number.isInteger(v) || v < 0 || v > 5) throw new BadRating(`${field} must be 0 to 5.`);
  return v;
}

function short(body, field, limit) {
  const v = body[field];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new BadRating(`${field} must be text.`);
  if (v.length > limit) throw new BadRating(`${field} is too long.`);
  return oneLine(v);
}

// What a rating may look like. Only these fields go any further.
function readRating(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRating('Send a JSON object.');
  if (!Number.isInteger(body.level) || body.level < 0 || body.level > 100000) throw new BadRating('level is missing or odd.');
  if (typeof body.version !== 'string' || !VERSION.test(body.version)) throw new BadRating('version is missing or odd.');
  if (body.made_at !== undefined && (typeof body.made_at !== 'string' || !MADE_AT.test(body.made_at))) throw new BadRating('made_at is odd.');
  const tags = body.tags === undefined ? [] : body.tags;
  if (!Array.isArray(tags) || tags.length > LIMITS.tags || tags.some((t) => typeof t !== 'string' || !TAG.test(t))) {
    throw new BadRating('tags must be a short list of names.');
  }
  const note = body.note === undefined || body.note === null ? '' : body.note;
  if (typeof note !== 'string' || note.length > LIMITS.note) throw new BadRating('note is too long.');
  const stats = {};
  const given = body.stats === undefined ? {} : body.stats;
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw new BadRating('stats must be an object.');
  const keys = Object.keys(given);
  if (keys.length > LIMITS.stats) throw new BadRating('stats has too much in it.');
  for (const k of keys) {
    const v = given[k];
    if (!STAT_KEY.test(k)) throw new BadRating('stats has an odd name in it.');
    if (typeof v === 'number' && Number.isFinite(v)) stats[k] = v;
    else if (typeof v === 'boolean') stats[k] = v;
    else if (typeof v === 'string' && v.length <= LIMITS.statText) stats[k] = oneLine(v);
    else throw new BadRating(`stats.${k} must be a number, true or false, or a few words.`);
  }
  return {
    id: id32(body, 'id'),
    device: id32(body, 'device'),
    session: id32(body, 'session'),
    level: body.level,
    levelFp: short(body, 'level_fp', LIMITS.fp),
    title: short(body, 'title', LIMITS.title),
    flavor: short(body, 'flavor', LIMITS.flavor),
    where: short(body, 'where', LIMITS.where),
    version: body.version,
    madeAt: body.made_at || '',
    difficulty: stars(body, 'difficulty'),
    fun: stars(body, 'fun'),
    frustration: stars(body, 'frustration'),
    tags: [...new Set(tags)],
    note: clean(note).trim(),
    stats,
  };
}

function createMemoryStore() {
  const rows = new Map();
  return {
    kind: 'memory',
    async ready() {},
    async insert(r) {
      if (rows.has(r.id)) return false;
      rows.set(r.id, { ...r, receivedAt: new Date().toISOString() });
      return true;
    },
    async list(since, limit) {
      return [...rows.values()].filter((r) => !since || r.receivedAt > since).slice(0, limit);
    },
  };
}

function createPgStore({ pool, url }) {
  if (!pool) {
    const { Pool } = require('pg'); // eslint-disable-line global-require
    pool = new Pool({
      connectionString: url,
      // A couple at most: this shares the database with MusicGrid's own pool.
      max: 2,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    });
    pool.on('error', (err) => console.error(`[lm ratings] Idle database connection: ${err.message}`));
  }
  let made = null;
  return {
    kind: 'postgres',
    ready() {
      made = made || (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS lm_level_ratings (
          id TEXT PRIMARY KEY, device TEXT NOT NULL, session TEXT NOT NULL,
          level INTEGER NOT NULL, level_fp TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
          flavor TEXT NOT NULL DEFAULT '', place TEXT NOT NULL DEFAULT '', version TEXT NOT NULL,
          made_at TEXT NOT NULL DEFAULT '', difficulty SMALLINT NOT NULL DEFAULT 0, fun SMALLINT NOT NULL DEFAULT 0,
          frustration SMALLINT NOT NULL DEFAULT 0, tags JSONB NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '',
          stats JSONB NOT NULL DEFAULT '{}', received_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        await pool.query('CREATE INDEX IF NOT EXISTS lm_level_ratings_received ON lm_level_ratings (received_at)');
        await pool.query('CREATE INDEX IF NOT EXISTS lm_level_ratings_level ON lm_level_ratings (level)');
      })().catch((err) => { made = null; throw err; });
      return made;
    },
    async insert(r) {
      const res = await pool.query(
        `INSERT INTO lm_level_ratings (id, device, session, level, level_fp, title, flavor, place, version, made_at,
           difficulty, fun, frustration, tags, note, stats)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ON CONFLICT DO NOTHING`,
        [r.id, r.device, r.session, r.level, r.levelFp, r.title, r.flavor, r.where, r.version, r.madeAt,
          r.difficulty, r.fun, r.frustration, JSON.stringify(r.tags), r.note, JSON.stringify(r.stats)]);
      return res.rowCount === 1;
    },
    async list(since, limit) {
      const res = await pool.query(
        `SELECT id, device, session, level, level_fp, title, flavor, place, version, made_at, difficulty, fun,
                frustration, tags, note, stats, received_at
         FROM lm_level_ratings WHERE ($1::timestamptz IS NULL OR received_at > $1::timestamptz)
         ORDER BY received_at LIMIT $2`, [since || null, limit]);
      return res.rows.map((r) => ({
        id: r.id, device: r.device, session: r.session, level: r.level, levelFp: r.level_fp, title: r.title,
        flavor: r.flavor, where: r.place, version: r.version, madeAt: r.made_at, difficulty: r.difficulty, fun: r.fun,
        frustration: r.frustration, tags: r.tags, note: r.note, stats: r.stats, receivedAt: r.received_at.toISOString(),
      }));
    },
  };
}

function createRatings({ store }) {
  return {
    async add(body) {
      const rating = readRating(body);
      await store.ready();
      const fresh = await store.insert(rating);
      return { status: fresh ? 201 : 200, body: fresh ? { ok: true, id: rating.id } : { ok: true, id: rating.id, duplicate: true } };
    },
    async list(query) {
      let since = '';
      if (query.since !== undefined) {
        const t = new Date(String(query.since));
        if (Number.isNaN(t.getTime())) throw new BadRating('since must be a time.');
        since = t.toISOString();
      }
      const limit = Math.min(20000, Math.max(1, Number.parseInt(query.limit, 10) || 5000));
      await store.ready();
      return { status: 200, body: { ratings: await store.list(since, limit) } };
    },
  };
}

module.exports = { createRatings, createMemoryStore, createPgStore, readRating, BadRating };
