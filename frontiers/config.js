// Everything the Frontiers Celestia routes read from the environment, in one
// place. Prefixed FC_ so they never clash with MusicGrid's own settings.

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const isProduction = (process.env.NODE_ENV || '').toLowerCase() === 'production';

module.exports = {
  port: num(process.env.PORT, 3000),
  isProduction,

  // Trimmed: a token pasted with a trailing space or newline is a 401 from GitHub.
  githubToken: (process.env.FC_GITHUB_TOKEN || '').trim(),
  githubRepo: (process.env.FC_GITHUB_REPO || '').trim(),
  githubBranch: (process.env.FC_GITHUB_BRANCH || 'main').trim(),
  // A test hook: the tests point this at a fake GitHub. Refused in production,
  // because whatever it names gets the token.
  githubApi: (process.env.FC_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),

  // Per address, and for everyone together. The last one is the most a flood
  // from many addresses can add to the repo in a day.
  perIpHour: num(process.env.FC_REPORTS_PER_IP_HOUR, 10),
  perIpDay: num(process.env.FC_REPORTS_PER_IP_DAY, 30),
  perDay: num(process.env.FC_REPORTS_PER_DAY, 300),
  // The game retries a report it didn't hear back about. The same report
  // inside this window is answered without filing it again.
  dedupeHours: num(process.env.FC_DEDUPE_HOURS, 24),

  // Cloud saves are kept in MusicGrid's own database (a table of their own,
  // fc_cloud_saves). Without it they're off in production.
  databaseUrl: (process.env.FC_DATABASE_URL || process.env.DATABASE_URL || '').trim(),
  // The most save codes kept at once, and backups one address may send an hour.
  savesMax: num(process.env.FC_SAVES_MAX, 5000),
  saveUploadsPerIpHour: num(process.env.FC_SAVE_UPLOADS_PER_IP_HOUR, 30),
};
