// Files a validated report: its logs and screenshot into the repo, then an issue
// that links them. Heroku's disk is wiped on every restart, so nothing is kept
// here but a short list of what was filed recently.

const crypto = require('crypto');
const fcIssue = require('./issue');

class DailyCapReached extends Error {}

// A report's id comes from what's in it, so the game retrying the same report
// gets the same id, and so the same folder in the repo.
function reportId(report) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ ...report, screenshot: undefined }));
  if (report.screenshot) hash.update(report.screenshot);
  return hash.digest('hex').slice(0, 12);
}

// `allow` says whether today's cap has room (it's only asked about new reports).
// `format` writes the issue ({ issueTitle, issueBody }; Frontiers Celestia's by
// default) and `labels(report)` names its labels, if any. (Last Mile's reports
// use both: lastmile/.)
function createReporter({ github, allow, dedupeMs, format = fcIssue, labels = null }) {
  const recent = new Map(); // id -> { at, done }
  // GitHub writes go one at a time: two commits at once conflict on the branch,
  // and GitHub asks API clients not to make concurrent writes.
  let tail = Promise.resolve();
  function inTurn(job) {
    const run = tail.then(job, job);
    tail = run.catch(() => {});
    return run;
  }

  function forgetOld() {
    const oldest = Date.now() - dedupeMs;
    for (const [id, entry] of recent) if (entry.at < oldest) recent.delete(id);
  }

  async function store(report, id) {
    const folder = `reports/${new Date().toISOString().slice(0, 10)}_${id}`;
    const files = [];
    const add = (name, label, content) => files.push({ name, label, content, path: `${folder}/${name}`, url: github.fileUrl(`${folder}/${name}`) });
    if (report.screenshot) add('screenshot.jpg', 'Screenshot', report.screenshot);
    if (report.logs.godot) add('godot_log.txt', 'Full Godot log', report.logs.godot);
    if (report.logs.perf) add('perf_log.txt', 'Performance log', report.logs.perf);
    for (const file of files) await github.putFile(file.path, file.content, `Report ${id}: ${file.name}`);
    return github.createIssue(format.issueTitle(report), format.issueBody(report, { id, files }), labels ? labels(report) : undefined);
  }

  async function file(report) {
    forgetOld();
    const id = reportId(report);
    const seen = recent.get(id);
    if (seen) {
      await seen.done;
      return { id, duplicate: true };
    }
    if (!allow()) throw new DailyCapReached('Today\'s reports are full.');
    const done = inTurn(() => store(report, id));
    recent.set(id, { at: Date.now(), done });
    try {
      await done;
    } catch (err) {
      // Not filed, so the game's retry must get through.
      recent.delete(id);
      throw err;
    }
    return { id, duplicate: false };
  }

  return { file };
}

module.exports = { createReporter, DailyCapReached };
