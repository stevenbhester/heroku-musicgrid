// Last Mile's routes, mounted at /lm by server.js before its body parser (a
// report with a screenshot is bigger than the default 100 KB). Settings are
// prefixed LM_ so they never clash with MusicGrid's or Frontiers Celestia's:
//   LM_GITHUB_TOKEN   a fine-grained token for the feedback repo only
//                     (Contents: read and write, Issues: read and write)
//   LM_GITHUB_REPO    default stevenbhester/last-mile-feedback
//   LM_GITHUB_BRANCH  default main
//   LM_REPORTS_PER_IP_HOUR / _PER_IP_DAY / _PER_DAY, LM_DEDUPE_HOURS
// Without a token, POST /feedback answers 503 and nothing is filed.

const { createApp } = require('./app');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const isProduction = (process.env.NODE_ENV || '').toLowerCase() === 'production';

const cfg = {
  isProduction,
  githubToken: (process.env.LM_GITHUB_TOKEN || '').trim(),
  githubRepo: (process.env.LM_GITHUB_REPO || 'stevenbhester/last-mile-feedback').trim(),
  githubBranch: (process.env.LM_GITHUB_BRANCH || 'main').trim(),
  // A test hook (a fake GitHub). Refused in production: whatever it names gets the token.
  githubApi: (process.env.LM_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
  perIpHour: num(process.env.LM_REPORTS_PER_IP_HOUR, 10),
  perIpDay: num(process.env.LM_REPORTS_PER_IP_DAY, 30),
  perDay: num(process.env.LM_REPORTS_PER_DAY, 300),
  dedupeHours: num(process.env.LM_DEDUPE_HOURS, 24),
};

if (cfg.isProduction && process.env.LM_GITHUB_API_URL) {
  console.error('[lm] LM_GITHUB_API_URL is a test hook; ignoring reports until it is unset.');
  cfg.githubToken = '';
}

module.exports = createApp(cfg);
