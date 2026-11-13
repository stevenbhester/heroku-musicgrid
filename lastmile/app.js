// Last Mile's routes: POST /feedback (bug reports and feedback sent from inside
// the game, each filed as an issue in a GitHub repo) and GET /health. Built on
// Frontiers Celestia's report pipeline (frontiers/): the same GitHub client,
// filing, de-duplication and rate limits, with Last Mile's own fields and issue.

const express = require('express');
const { createGitHub } = require('../frontiers/github');
const { createLimiter } = require('../frontiers/ratelimit');
const { createReporter, DailyCapReached } = require('../frontiers/reports');
const { validateFeedback } = require('./validate');
const issue = require('./issue');

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

  app.get('/health', (req, res) => res.json({ ok: true, filing }));

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
