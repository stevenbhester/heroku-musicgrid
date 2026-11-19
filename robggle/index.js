// Mounted by the MusicGrid server (stevenbhester/heroku-musicgrid):
//   const robggle = require('./robggle'); app.use('/rg', robggle.router); ... robggle.attach(server)
// Lobby list: GET /rg/api/lobbies   Game socket: /rg/ws
const express = require('express');
const { attach, lobbyList, ALLOWED_ORIGINS } = require('./realtime');

const router = express.Router();
router.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.test(o)) { res.set('Access-Control-Allow-Origin', o); res.set('Vary', 'Origin'); }
  next();
});
router.get('/api/lobbies', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ lobbies: lobbyList() }); });
router.get('/api/health', (req, res) => res.send('ok'));

module.exports = { router, attach: server => attach(server, '/rg/ws') };
