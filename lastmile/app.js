// Last Mile's routes: POST /feedback (bug reports and feedback sent from inside
// the game, each filed as an issue in a GitHub repo), POST and GET /ratings
// (testers' level ratings, kept in the database: see ratings.js), POST /daily and
// GET /daily/stats (daily puzzle results and today's numbers: see daily.js) and GET /health. Built on
// Frontiers Celestia's report pipeline (frontiers/): the same GitHub client,
// filing, de-duplication and rate limits, with Last Mile's own fields and issue.

const express = require('express');
const { createGitHub } = require('../frontiers/github');
const { createLimiter } = require('../frontiers/ratelimit');
const { createReporter, DailyCapReached } = require('../frontiers/reports');
const { validateFeedback } = require('./validate');
const issue = require('./issue');
const { createRatings, createMemoryStore, createPgStore, BadRating } = require('./ratings');
const daily = require('./daily');

// A screenshot of 1 MB is about 1.4 MB as base64, and the log fits in the rest.
const BODY_LIMIT = '2mb';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function createApp(cfg) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (cfg.isProduction && req.get('x-forwarded-proto') === 'http') return res.status(403).json({ error: 'Use https.' });
    next();
  });

  const filing = Boolean(cfg.githubToken && cfg.githubRepo);
  const limiter = createLimiter();
  const reporter = filing ? createReporter({
    github: createGitHub({ token: cfg.githubToken, repo: cfg.githubRepo, branch: cfg.githubBranch, api: cfg.githubApi, agent: 'last-mile-feedback' }),
    allow: () => limiter.hit('everyone', 'today', cfg.perDay, DAY).allowed,
    dedupeMs: cfg.dedupeHours * HOUR,
    format: issue,
    labels: (report) => [report.kind, 'from-game'],
  }) : null;

  // Level ratings keep to Postgres when there's a database. Without one they're
  // held in memory, which a restart wipes, so production turns them off instead.
  const ratingsStore = cfg.ratingsStore
    || (cfg.databaseUrl ? createPgStore({ url: cfg.databaseUrl }) : null)
    || (cfg.isProduction ? null : createMemoryStore());
  const ratings = ratingsStore ? createRatings({ store: ratingsStore }) : null;
  const ratingsRoute = (job) => async (req, res) => {
    if (!ratings) return res.status(503).json({ error: 'Ratings aren\'t being taken right now.' });
    try {
      const out = await job(req);
      res.status(out.status).json(out.body);
    } catch (err) {
      if (err instanceof BadRating) return res.status(400).json({ error: err.message });
      console.error(`[lm ratings] ${err.message}`);
      res.status(502).json({ error: 'Couldn\'t save that just now. Try again later.' });
    }
  };

  // Daily results: the same database, or memory off production.
  const dailyStore = cfg.dailyStore
    || (cfg.databaseUrl ? daily.createPgStore({ url: cfg.databaseUrl }) : null)
    || (cfg.isProduction ? null : daily.createMemoryStore());
  const days = dailyStore ? daily.createDaily({ store: dailyStore }) : null;
  const dailyRoute = (job) => async (req, res) => {
    if (!days) return res.status(503).json({ error: 'Daily results aren\'t being taken right now.' });
    try {
      const out = await job(req);
      res.status(out.status).json(out.body);
    } catch (err) {
      if (err instanceof daily.BadResult) return res.status(400).json({ error: err.message });
      console.error(`[lm daily] ${err.message}`);
      res.status(502).json({ error: 'Couldn\'t do that just now. Try again later.' });
    }
  };

  app.get('/health', (req, res) => res.json({ ok: true, filing, ratings: Boolean(ratings), daily: Boolean(days) }));

  app.post(
    '/daily',
    limiter.limit({ name: 'daily-hour', max: cfg.dailyPerIpHour || 120, windowMs: HOUR, error: 'Too many results. Try again later.' }),
    express.json({ limit: '8kb', strict: true }),
    dailyRoute((req) => days.add(req.body)),
  );
  app.get(
    '/daily/stats',
    limiter.limit({ name: 'daily-stats-hour', max: cfg.dailyStatsPerIpHour || 600, windowMs: HOUR, error: 'Too many requests. Try again later.' }),
    dailyRoute((req) => days.stats(req.query)),
  );

  app.post(
    '/ratings',
    limiter.limit({ name: 'rate-hour', max: cfg.ratingsPerIpHour, windowMs: HOUR, error: 'Too many ratings. Try again later.' }),
    express.json({ limit: '32kb', strict: true }),
    ratingsRoute((req) => ratings.add(req.body)),
  );
  // Reading them back is for Steven only: the same key as MusicGrid's admin page.
  app.get('/ratings', (req, res, next) => {
    if (!cfg.adminKey) return res.status(503).json({ error: 'Set ADMIN_KEY in the Heroku config vars to read ratings.' });
    if (req.get('x-admin-key') !== cfg.adminKey) return res.status(401).json({ error: 'Admin key required.' });
    next();
  }, ratingsRoute((req) => ratings.list(req.query)));

  app.post(
    '/feedback',
    limiter.limit({ name: 'hour', max: cfg.perIpHour, windowMs: HOUR }),
    limiter.limit({ name: 'day', max: cfg.perIpDay, windowMs: DAY }),
    express.json({ limit: BODY_LIMIT, strict: true }),
    async (req, res) => {
      if (!reporter) return res.status(503).json({ error: 'Feedback isn\'t being taken right now.' });
      const result = validateFeedback(req.body);
      if (!result.ok) return res.status(400).json({ error: result.error });
      try {
        const { id, duplicate } = await reporter.file(result.report);
        res.status(duplicate ? 200 : 201).json({ ok: true, id, duplicate });
      } catch (err) {
        if (err instanceof DailyCapReached) {
          res.setHeader('Retry-After', '3600');
          return res.status(429).json({ error: 'Too many reports today. Try again later.' });
        }
        console.error(`[lm feedback] Not filed: ${err.message}`);
        res.status(502).json({ error: 'Couldn\'t send that just now. Try again later.' });
      }
    },
  );

  app.use((req, res) => res.status(404).json({ error: 'Nothing here.' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That report is too big.' });
    if (err.status >= 400 && err.status < 500) return res.status(400).json({ error: 'That isn\'t valid JSON.' });
    console.error(`[lm feedback] ${err.message}`);
    res.status(500).json({ error: 'Something went wrong.' });
  });
  return app;
}

module.exports = { createApp };
