// Frontiers Celestia's routes (the open games list, bug reports and cloud saves), mounted at
// /fc by server.js before its body parser, so a report with a screenshot isn't
// cut off by the default 100 KB limit. Its own parsers, limits and 404 stay
// inside /fc.

const cfg = require('./config');
const { createApp } = require('./app');

if (cfg.isProduction && process.env.FC_GITHUB_API_URL) {
  console.error('[fc] FC_GITHUB_API_URL is a test hook; ignoring reports until it is unset.');
  cfg.githubToken = '';
}

module.exports = createApp(cfg);
