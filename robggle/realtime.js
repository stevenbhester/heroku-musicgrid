// The WebSocket side of Robggle, attachable to any Node http server.
// Used by index.js (local dev) and by the MusicGrid server (production, under /rg).
const { WebSocketServer } = require('ws');
const { Lobby, lobbies } = require('./lobby');

const ALLOWED_ORIGINS = /^(https:\/\/(www\.)?stevenhester\.com|http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?)$/;

function lobbyList() {
  return [...lobbies.values()].filter(l => l.isLive()).map(l => l.summary())
    .sort((a, b) => (a.phase === 'lobby' ? 0 : 1) - (b.phase === 'lobby' ? 0 : 1)).slice(0, 40);
}

// Only takes upgrade requests for `path`; any other upgrade on the server is left alone.
function attach(server, path) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== path) return;
    const o = req.headers.origin;
    // The iOS app's web view sends the site's origin; anything else foreign is refused.
    if (o && !ALLOWED_ORIGINS.test(o)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let budget = 40; // simple flood guard: messages per second
    const refill = setInterval(() => { budget = 40; }, 1000);

    ws.on('message', buf => {
      if (--budget < 0) return;
      let msg;
      try { msg = JSON.parse(buf); } catch { return; }
      const m = ws.member, lobby = ws.lobby;
      switch (msg.t) {
        case 'ping': return ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
        case 'create': {
          if (lobby) return;
          const r = new Lobby().join(ws, msg);
          if (r.error) ws.send(JSON.stringify({ t: 'error', msg: r.error }));
          return;
        }
        case 'join': {
          if (lobby) return;
          const l = lobbies.get(String(msg.code || '').toUpperCase());
          if (!l) return ws.send(JSON.stringify({ t: 'error', code: 'nolobby', msg: "That lobby doesn't exist (or it ended)." }));
          const r = l.join(ws, msg);
          if (r.error) ws.send(JSON.stringify({ t: 'error', msg: r.error }));
          return;
        }
      }
      if (!m || !lobby) return;
      switch (msg.t) {
        case 'settings': return lobby.setSettings(m, msg);
        case 'start': return lobby.start(m);
        case 'word': return lobby.word(m, msg.w);
        case 'alliance': return lobby.setAlliance(m, msg.id);
        case 'rename': lobby.rename(m, msg.name); return;
        case 'lobby': return lobby.backToLobby(m);
        case 'resetScores': return lobby.resetScores(m);
        case 'leave': lobby.leave(m); ws.member = null; ws.lobby = null; return;
      }
    });

    ws.on('close', () => { clearInterval(refill); if (ws.lobby) ws.lobby.disconnect(ws); });
  });

  // Heartbeat drops dead sockets; lobby ticks hand off hosts and clean up empty games.
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
    const now = Date.now();
    for (const l of [...lobbies.values()]) {
      l.tick(now);
      if (l.emptySince && now - l.emptySince > 20 * 60000) l.destroy();
      else if (now - l.createdAt > 24 * 3600000 && !l.isLive()) l.destroy();
    }
  }, 5000);
  beat.unref();
  return wss;
}

module.exports = { attach, lobbyList, ALLOWED_ORIGINS };
