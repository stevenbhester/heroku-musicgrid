// The whole API: POST /reports, POST and GET /lobby, and GET /health.

const express = require('express');
const { createGitHub } = require('./github');
const { createLimiter } = require('./ratelimit');
const { createReporter, DailyCapReached } = require('./reports');
const { validateReport } = require('./validate');
const { createLobby } = require('./lobby');

// A screenshot of 1 MB is about 1.4 MB as base64, and the logs fit in the rest.
const BODY_LIMIT = '2mb';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function createApp(cfg) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Reports hold logs, and the game only ever uses https, so plain http is
  // refused rather than redirected. Heroku says which one was used.
  app.use((req, res, next) => {
    if (cfg.isProduction && req.get('x-forwarded-proto') === 'http') return res.status(403).json({ error: 'Use https.' });
    next();
  });

  const filing = Boolean(cfg.githubToken && cfg.githubRepo);
  const limiter = createLimiter();
  const reporter = filing ? createReporter({
    github: createGitHub({ token: cfg.githubToken, repo: cfg.githubRepo, branch: cfg.githubBranch, api: cfg.githubApi }),
    allow: () => limiter.hit('everyone', 'today', cfg.perDay, DAY).allowed,
    dedupeMs: cfg.dedupeHours * HOUR,
  }) : null;

  app.get('/health', (req, res) => res.json({ ok: true, filing }));

  // The limits come before the body is read, so a flood costs almost nothing.
  app.post(
    '/reports',
    limiter.limit({ name: 'hour', max: cfg.perIpHour, windowMs: HOUR }),
    limiter.limit({ name: 'day', max: cfg.perIpDay, windowMs: DAY }),
    express.json({ limit: BODY_LIMIT, strict: true }),
    async (req, res) => {
      if (!reporter) return res.status(503).json({ error: 'Reports aren\'t being taken right now.' });
      const result = validateReport(req.body);
      if (!result.ok) return res.status(400).json({ error: result.error });
      try {
        const { id, duplicate } = await reporter.file(result.report);
        res.status(duplicate ? 200 : 201).json({ ok: true, id, duplicate });
      } catch (err) {
        if (err instanceof DailyCapReached) {
          res.setHeader('Retry-After', '3600');
          return res.status(429).json({ error: 'Too many reports today. Try again later.' });
        }
        console.error(`[reports] Not filed: ${err.message}`);
        res.status(502).json({ error: 'Couldn\'t file that just now. Try again later.' });
      }
    },
  );

  // The open games list (see lobby.js). A host beats every 30 s, so 10 a
  // minute from one address is plenty.
  const lobby = createLobby();
  app.post(
    '/lobby',
    limiter.limit({ name: 'lobby', max: 10, windowMs: 60_000 }),
    express.json({ limit: '4kb', strict: true }),
    (req, res) => {
      if (!lobby.beat(req.body)) return res.status(400).json({ error: 'Not an open game.' });
      res.json({ ok: true });
    },
  );
  app.get('/lobby', (req, res) => res.json({ games: lobby.list() }));

  app.use((req, res) => res.status(404).json({ error: 'Nothing here.' }));

  // Express's default would answer with a stack trace outside production.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That report is too big.' });
    if (err.status >= 400 && err.status < 500) return res.status(400).json({ error: 'That isn\'t valid JSON.' });
    console.error(`[reports] ${err.message}`);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return app;
}

module.exports = { createApp };
