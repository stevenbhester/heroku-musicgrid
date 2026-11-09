// Report text comes from anyone who can reach the endpoint, so none of it is
// trusted. These are the three things done to it on the way into an issue.

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;
// Control characters, except tab and newline.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Characters that don't show: zero-width ones, the ones that reverse text so it
// reads differently from what it says, and the Unicode tag block.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

function clean(text) {
  return String(text ?? '')
    .replace(ANSI, '')
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '');
}

// For a field that must stay on its own line, so it can't pose as another one.
function oneLine(text) {
  return clean(text).replace(/\s+/g, ' ').trim();
}

// The game takes these out before sending (Diagnostics.scrub). They're taken out
// here too, because a mistake in a shipped game can't be fixed from here later.
// An invite code is the host's addresses packed into letters and digits
// (Net.encode_code), so an old code is as private as an address.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const HEX = '[0-9a-f]{1,4}';
const SCRUBS = [
  [/\bF[1-9][0-9A-Z]{2}(?:-[0-9A-Z]{1,4}){1,7}\b/gi, '<invite code>'],
  [/\bF[1-3][0-9A-Z]{7,20}\b/gi, '<invite code>'],
  [/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\r\n"'<>|:*?]+/gi, '$1<user>'],
  [/(\/(?:Users|home)\/)[^/\r\n"'<>|:*?\s]+/g, '$1<user>'],
  [new RegExp(`(?<!\\d|\\d\\.)(?:${OCTET}\\.){3}${OCTET}(?!\\d|\\.\\d)`, 'g'), '<ip>'],
  [new RegExp(`(?<![\\w:.])(?:${HEX}:){7}${HEX}(?![\\w:])`, 'gi'), '<ip>'],
  [new RegExp(`(?<![\\w:.])(?:${HEX}(?::${HEX}){0,6}::(?:${HEX}(?::${HEX}){0,6})?|::${HEX}(?::${HEX}){0,6})(?![\\w:])`, 'gi'), '<ip>'],
];

function scrub(text) {
  return SCRUBS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

// A code block nothing inside it can close: longer than any run of backticks in
// the text. Inside one, GitHub doesn't ping @mentions, link #123, load images
// or render HTML, so this is what keeps report text from acting on the page.
function fence(text) {
  const longest = (text.match(/`+/g) || []).reduce((n, run) => Math.max(n, run.length), 0);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}text\n${text}\n${ticks}`;
}

module.exports = { clean, oneLine, scrub, fence };
