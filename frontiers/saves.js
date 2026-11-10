// Cloud save backups: a player backs up a save from one device and gets a save
// code; any device can fetch it again with that code. A save can also be found
// by its farm's name, which hands back the save but not its code.
//
//   POST /saves             { save, farm, time, version, saved_at, code?, key? }
//                           -> 201 { ok, code, key, updated: false }   a new backup
//                           -> 200 { ok, code, key, updated: true }    code + key matched: replaced
//   GET  /saves/:code       -> { code, key, farm, time, version, saved_at, size, save }
//   GET  /saves?farm=name   -> { saves: [ { id, farm, time, version, saved_at, size } ] }
//   GET  /saves/found/:id   -> { id, farm, time, version, saved_at, size, save }
//
// `save` is the save file gzipped, then base64. The server checks it unpacks
// to a JSON object, but otherwise stores it as it came. `key` is what lets the
// same code be backed up again: the game keeps it in the save itself, so every
// device the save moves to (by its code) keeps backing up to the same code.
// Saves are kept in Postgres when there's a database, and in memory otherwise
// (tests, and running it by hand: a restart forgets them all).

const crypto = require('crypto');
const zlib = require('zlib');
const { oneLine } = require('./text');

// Shared with the game's invite codes (Net.CODE_ALPHABET): no I, L, O or U.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// "S" and seven characters: 35 bits, shown as SXXX-XXXX.
const CODE_LENGTH = 8;
const LIMITS = {
  // A late-game save is about 350 KB of JSON and gzips to well under this.
  saveBytes: 1_572_864,
  // What it may unpack to. Anything bigger isn't one of the game's saves.
  unpackedBytes: 8_388_608,
  farm: 40,
  findResults: 20,
};
const VERSION = /^[\w .+-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KEY = /^[0-9a-f]{32}$/;
const LIST_ID = /^[0-9a-f]{16}$/;

// The same reading as the game's CloudSave.normalize_code: case, dashes and
// spaces don't matter, and I, L and O are read as 1, 1 and 0.
function normalizeCode(text) {
  if (typeof text !== 'string') return '';
  let out = '';
  for (let ch of text.toUpperCase()) {
    if (ch === 'I' || ch === 'L') ch = '1';
    else if (ch === 'O') ch = '0';
    if (ALPHABET.includes(ch)) out += ch;
  }
  return out.length === CODE_LENGTH && out[0] === 'S' ? out : '';
}

const showCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

function newCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH - 1);
  let code = 'S';
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
  return code;
}

class BadSave extends Error {}

// What a backup may look like. Only these fields go any further.
function readBackup(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadSave('Send a JSON object.');
  if (typeof body.save !== 'string' || !BASE64.test(body.save)) throw new BadSave('save must be base64.');
  const data = Buffer.from(body.save, 'base64');
  if (data.length > LIMITS.saveBytes) throw new BadSave('That save is too big.');
  if (data[0] !== 0x1f || data[1] !== 0x8b) throw new BadSave('save must be gzipped.');
  let parsed;
  try {
    parsed = JSON.parse(zlib.gunzipSync(data, { maxOutputLength: LIMITS.unpackedBytes }).toString('utf8'));
  } catch {
    throw new BadSave('save isn\'t a gzipped save file.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BadSave('save isn\'t a save file.');
  if (typeof body.version !== 'string' || !VERSION.test(body.version)) throw new BadSave('version is missing or odd.');
  const farm = typeof body.farm === 'string' ? oneLine(body.farm).slice(0, LIMITS.farm) : '';
  if (!farm) throw new BadSave('farm is missing.');
  const time = Number(body.time);
  const savedAt = Number(body.saved_at);
  return {
    meta: {
      farm,
      time: Number.isFinite(time) && time >= 0 ? Math.min(time, 1e9) : 0,
      version: body.version,
      savedAt: Number.isFinite(savedAt) && savedAt > 0 ? Math.floor(savedAt) : Math.floor(Date.now() / 1000),
      size: data.length,
    },
    data,
    code: normalizeCode(body.code),
    key: typeof body.key === 'string' && KEY.test(body.key) ? body.key : '',
  };
}

const publicMeta = (row) => ({ farm: row.farm, time: row.time, version: row.version, saved_at: row.savedAt, size: row.size });

// --- Stores: the same few calls, kept in memory or in Postgres. -----------------

function createMemoryStore() {
  const rows = new Map(); // code -> row
  const copy = (row) => (row ? { ...row } : null);
  return {
    kind: 'memory',
    async ready() {},
    async count() { return rows.size; },
    async insert(row) {
      if (rows.has(row.code)) return false;
      rows.set(row.code, { ...row, updatedAt: Date.now() });
      return true;
    },
    async replace(code, key, meta, data) {
      const row = rows.get(code);
      if (!row || row.key !== key) return false;
      Object.assign(row, meta, { data, updatedAt: Date.now() });
      return true;
    },
    async byCode(code) { return copy(rows.get(code)); },
    async byListId(id) { return copy([...rows.values()].find((r) => r.listId === id)); },
    async find(farm, limit) {
      const q = farm.toLowerCase();
      return [...rows.values()]
        .filter((r) => r.farm.toLowerCase().includes(q))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map(copy);
    },
  };
}

// `pool` is a pg Pool (MusicGrid passes its own), or made from `url`.
function createPgStore({ pool, url }) {
  if (!pool) {
    const { Pool } = require('pg'); // eslint-disable-line global-require
    pool = new Pool({
      connectionString: url,
      // A few at most: on MusicGrid this shares the database with MusicGrid's own pool.
      max: 3,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    });
    pool.on('error', (err) => console.error(`[saves] Idle database connection: ${err.message}`));
  }
  const fromDb = (r) => r && ({
    code: r.code, key: r.key, listId: r.list_id, farm: r.farm, time: Number(r.play_time), version: r.version,
    savedAt: Number(r.saved_at), size: r.size, data: r.data,
  });
  const COLUMNS = 'code, key, list_id, farm, play_time, version, saved_at, size';
  let made = null;
  return {
    kind: 'postgres',
    ready() {
      made = made || (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS fc_cloud_saves (
          code TEXT PRIMARY KEY, key TEXT NOT NULL, list_id TEXT NOT NULL UNIQUE,
          farm TEXT NOT NULL, play_time DOUBLE PRECISION NOT NULL DEFAULT 0, version TEXT NOT NULL,
          saved_at BIGINT NOT NULL, size INTEGER NOT NULL, data BYTEA NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        await pool.query('CREATE INDEX IF NOT EXISTS fc_cloud_saves_farm ON fc_cloud_saves (lower(farm))');
      })().catch((err) => { made = null; throw err; });
      return made;
    },
    async count() {
      return (await pool.query('SELECT COUNT(*)::int AS n FROM fc_cloud_saves')).rows[0].n;
    },
    async insert(row) {
      const res = await pool.query(
        `INSERT INTO fc_cloud_saves (code, key, list_id, farm, play_time, version, saved_at, size, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
        [row.code, row.key, row.listId, row.farm, row.time, row.version, row.savedAt, row.size, row.data]);
      return res.rowCount === 1;
    },
    async replace(code, key, meta, data) {
      const res = await pool.query(
        `UPDATE fc_cloud_saves SET farm = $3, play_time = $4, version = $5, saved_at = $6, size = $7, data = $8,
         updated_at = now() WHERE code = $1 AND key = $2`,
        [code, key, meta.farm, meta.time, meta.version, meta.savedAt, meta.size, data]);
      return res.rowCount === 1;
    },
    async byCode(code) {
      return fromDb((await pool.query(`SELECT ${COLUMNS}, data FROM fc_cloud_saves WHERE code = $1`, [code])).rows[0]);
    },
    async byListId(id) {
      return fromDb((await pool.query(`SELECT ${COLUMNS}, data FROM fc_cloud_saves WHERE list_id = $1`, [id])).rows[0]);
    },
    async find(farm, limit) {
      // LIKE's own wildcards in a farm name are matched as themselves.
      const pattern = `%${farm.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const res = await pool.query(
        `SELECT ${COLUMNS} FROM fc_cloud_saves WHERE lower(farm) LIKE $1 ORDER BY updated_at DESC LIMIT $2`,
        [pattern, limit]);
      return res.rows.map(fromDb);
    },
  };
}

// --- The routes. -----------------------------------------------------------------

// `store` is one of the above; `maxSaves` is the most codes kept at once (a
// full store still takes new backups of codes it has).
function createSaves({ store, maxSaves }) {
  async function backup(body) {
    const { meta, data, code, key } = readBackup(body);
    await store.ready();
    if (code && key && await store.replace(code, key, meta, data)) {
      return { status: 200, body: { ok: true, code: showCode(code), key, updated: true } };
    }
    if (await store.count() >= maxSaves) return { status: 507, body: { error: 'Cloud saves are full right now.' } };
    for (let tries = 0; tries < 5; tries += 1) {
      const row = { ...meta, code: newCode(), key: crypto.randomBytes(16).toString('hex'), listId: crypto.randomBytes(8).toString('hex'), data };
      if (await store.insert(row)) {
        return { status: 201, body: { ok: true, code: showCode(row.code), key: row.key, updated: false } };
      }
    }
    throw new Error('no free code after five tries');
  }

  async function fetchByCode(text) {
    const code = normalizeCode(text);
    if (!code) return { status: 400, body: { error: 'That isn\'t a save code.' } };
    await store.ready();
    const row = await store.byCode(code);
    if (!row) return { status: 404, body: { error: 'No save has that code.' } };
    return { status: 200, body: { code: showCode(row.code), key: row.key, ...publicMeta(row), save: row.data.toString('base64') } };
  }

  async function fetchFound(id) {
    if (!LIST_ID.test(id)) return { status: 404, body: { error: 'No such save.' } };
    await store.ready();
    const row = await store.byListId(id);
    if (!row) return { status: 404, body: { error: 'No such save.' } };
    return { status: 200, body: { id: row.listId, ...publicMeta(row), save: row.data.toString('base64') } };
  }

  async function find(farm) {
    const q = typeof farm === 'string' ? oneLine(farm).slice(0, LIMITS.farm) : '';
    if (q.length < 2) return { status: 400, body: { error: 'Type at least two letters of the farm\'s name.' } };
    await store.ready();
    const rows = await store.find(q, LIMITS.findResults);
    return { status: 200, body: { saves: rows.map((r) => ({ id: r.listId, ...publicMeta(r) })) } };
  }

  return { backup, fetchByCode, fetchFound, find };
}

module.exports = { createSaves, createMemoryStore, createPgStore, normalizeCode, showCode, readBackup, BadSave, LIMITS, ALPHABET };
