// The only two things the server asks GitHub to do: store a file and open an
// issue. Errors name the status and the step, never GitHub's reply, so nothing
// from it can reach a log line or a player.

const CONFLICT_RETRIES = 2;

function createGitHub({ token, repo, branch, api, timeoutMs = 7_000, retryDelayMs = 400 }) {
  function call(method, path, body) {
    return fetch(`${api}/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'frontiers-celestia-reports',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function fileExists(path) {
    const res = await call('GET', `/contents/${path}?ref=${branch}`);
    return res.ok;
  }

  // `path` is built by the server from the date and report id, never from
  // anything a player sent. A file already there is fine: a report's id comes
  // from its contents, so that's this same report, stored by a try that failed
  // further on. GitHub answers that with a 422, but it also uses 422 for bad
  // requests and for what it thinks is spam, so it's checked, not assumed.
  async function putFile(path, content, message) {
    const body = { message, branch, content: Buffer.from(content).toString('base64') };
    for (let attempt = 0; ; attempt += 1) {
      const res = await call('PUT', `/contents/${path}`, body);
      if (res.ok) return;
      if (res.status === 422 && await fileExists(path)) return;
      // Two commits landing on the branch at once. Worth another go.
      if (res.status === 409 && attempt < CONFLICT_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      throw new Error(`GitHub said ${res.status} storing a file`);
    }
  }

  async function createIssue(title, body) {
    const res = await call('POST', '/issues', { title, body });
    if (!res.ok) throw new Error(`GitHub said ${res.status} opening an issue`);
    return (await res.json()).number;
  }

  const fileUrl = (path) => `https://github.com/${repo}/blob/${branch}/${path}`;

  return { putFile, createIssue, fileUrl };
}

module.exports = { createGitHub };
