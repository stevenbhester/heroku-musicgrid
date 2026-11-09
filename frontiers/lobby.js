// The open games list: hosts post a heartbeat every 30 s while their homestead
// is open, and the join screen asks for the list. Held in memory only (one
// dyno); an entry is forgotten 90 s after its last heartbeat.
//
//   POST /lobby  { world, host, players, max, protocol, build, version, port, code }
//   GET  /lobby  { games: [ ...entries, newest first ] }

const EXPIRE_MS = 90_000;
const MAX_GAMES = 200;
const CODE = /^[0-9A-Z-]{4,64}$/;

function text(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function count(value, min, max, fallback) {
  const n = Number.isInteger(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

// A heartbeat made safe to hand to other players, or null if it isn't one.
function cleanEntry(body) {
  if (!body || typeof body !== 'object') return null;
  const code = text(body.code, 64).toUpperCase();
  const host = text(body.host, 24);
  if (!CODE.test(code) || !host) return null;
  return {
    world: text(body.world, 40) || `${host}'s homestead`,
    host,
    players: count(body.players, 1, 8, 1),
    max: count(body.max, 1, 8, 4),
    protocol: count(body.protocol, 0, 100000, 0),
    build: text(body.build, 24),
    version: text(body.version, 24),
    port: count(body.port, 1, 65535, 24680),
    code,
  };
}

function createLobby({ now = () => Date.now() } = {}) {
  const games = new Map(); // code -> { entry, seenAt }

  function sweep() {
    const cutoff = now() - EXPIRE_MS;
    for (const [code, game] of games) if (game.seenAt <= cutoff) games.delete(code);
  }

  function beat(body) {
    const entry = cleanEntry(body);
    if (!entry) return false;
    sweep();
    if (!games.has(entry.code) && games.size >= MAX_GAMES) return false;
    games.set(entry.code, { entry, seenAt: now() });
    return true;
  }

  function list() {
    sweep();
    return [...games.values()].sort((a, b) => b.seenAt - a.seenAt).map((g) => g.entry);
  }

  return { beat, list };
}

module.exports = { createLobby, cleanEntry, EXPIRE_MS };
