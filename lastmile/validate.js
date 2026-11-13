// What a Last Mile report may look like. Only the fields named here go any
// further: anything else in the JSON is dropped.

const { clean, oneLine, scrub } = require('../frontiers/text');

// The game stays well under these (Feedback in scripts/feedback.gd). A field
// past its limit means something other than the game sent it, so it's refused.
const LIMITS = {
  description: 4_000,
  where: 80,
  system: 4_000,
  godotLog: 131_072,
  screenshotBytes: 1_048_576,
};
const KINDS = ['bug', 'feedback'];
const VERSION = /^[\w .()+-]{1,32}$/;
const MADE_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function text(body, field, limit) {
  const value = body[field];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${field} must be text.`);
  if (value.length > limit) throw new Error(`${field} is too long.`);
  return value;
}

function screenshot(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !BASE64.test(value)) throw new Error('screenshot must be base64.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > LIMITS.screenshotBytes) throw new Error('screenshot is too big.');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('screenshot must be a JPEG.');
  return bytes;
}

function read(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Send a JSON object.');
  if (!KINDS.includes(body.kind)) throw new Error('kind must be bug or feedback.');
  if (typeof body.version !== 'string' || !VERSION.test(body.version)) throw new Error('version is missing or odd.');
  const logs = body.logs === undefined || body.logs === null ? {} : body.logs;
  if (typeof logs !== 'object' || Array.isArray(logs)) throw new Error('logs must be an object.');
  const description = scrub(clean(text(body, 'description', LIMITS.description))).trim();
  if (!description) throw new Error('A report needs a few words.');
  return {
    kind: body.kind,
    version: body.version,
    description,
    where: scrub(oneLine(text(body, 'where', LIMITS.where))),
    madeAt: typeof body.made_at === 'string' && MADE_AT.test(body.made_at) ? body.made_at : '',
    system: scrub(clean(text(body, 'system', LIMITS.system))),
    logs: { godot: scrub(clean(text(logs, 'godot', LIMITS.godotLog))), perf: '' },
    screenshot: screenshot(body.screenshot),
  };
}

function validateFeedback(body) {
  try {
    return { ok: true, report: read(body) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { validateFeedback, LIMITS };
