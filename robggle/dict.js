// Word list: SCOWL (Kevin Atkinson, permissive license) via the wordlist-english package.
// "valid" accepts anything up to size 70; "common" (up to 50) is what we show as missed words.
const lists = require('wordlist-english');
const fs = require('fs');
const path = require('path');

// badwords-list ships as ES modules only, so read its word array as text.
// Found by walking Node's module search paths, so this works wherever the folder is mounted.
const badFile = module.paths.map(d => path.join(d, 'badwords-list/dist/array.js')).find(f => fs.existsSync(f));
const badSrc = badFile ? fs.readFileSync(badFile, 'utf8') : '';
const blocked = new Set((badSrc.match(/["']([^"']+)["']/g) || []).map(q => q.slice(1, -1).toLowerCase()));

const VALID_LEVELS = [10, 20, 35, 40, 50, 55, 60, 70];
const COMMON_MAX = 50;

const valid = new Set();
const common = new Set();
// American spellings plus the British, Canadian and Australian ones (AXE, GREY, COLOUR): families mix them.
// Only American words up to size 50 are shown as missed words, so nobody is told they missed COLOUR.
const VARIANTS = ['', 'british/', 'canadian/', 'australian/'];
const hit = (set, w) => set.has(w) || (w.endsWith('s') && set.has(w.slice(0, -1))) || (w.endsWith('es') && set.has(w.slice(0, -2)));
// Slurs never count. (The profanity list has some; these are the rest that the word lists would let through.)
const SLURS = new Set(['chink', 'coon', 'dyke', 'fag', 'fagging', 'faggot', 'homo', 'nigga', 'niggaz', 'nigger', 'retard', 'retarded', 'kike', 'spic', 'spick',
  'gook', 'wop', 'dago', 'wetback', 'tranny', 'paki', 'raghead', 'towelhead', 'darky', 'darkie', 'pickaninny', 'jigaboo', 'injun', 'squaw',
  'redskin', 'negro', 'shemale', 'lesbo', 'polack', 'chinaman', 'jap', 'spaz', 'spastic', 'mongoloid', 'halfbreed', 'gyp', 'gypped']);
// Words the profanity list catches that are perfectly ordinary (or only match it by accident, like SPACES):
// plain words again, with no fuss made.
const INNOCENT = new Set(['assess', 'balls', 'ballses', 'bestial', 'bloody', 'breasts', 'bum', 'bums', 'buttes', 'cokes', 'cox', 'coxes', 'crapes', 'dink',
  'dogging', 'fanny', 'flange', 'flanges', 'god', 'gods', 'hell', 'hells', 'hoar', 'hoars', 'hoer', 'hoers', 'japes', 'knob', 'knobs', 'lust', 'lusting',
  'lusts', 'masochist', 'masochists', 'muff', 'muffs', 'nob', 'nobs', 'pawn', 'pawns', 'pusses', 'rimming', 'sadist', 'sadists', 'screwing', 'sex',
  'sexes', 'snatch', 'snatches', 'spaces', 'willies']);
// Everything else on the profanity list is a real word that counts, and gets a reaction: swearing is allowed here.
// Naughty words are never "common": they aren't shown as missed, hidden for the Wordle, planted, or played by bots.
const naughty = new Set();
for (const v of VARIANTS) for (const lvl of VALID_LEVELS) {
  for (const raw of lists[`english/${v}${lvl}`] || []) {
    if (!/^[a-z]+$/.test(raw)) continue; // drops proper nouns, accents, apostrophes
    if (raw.length < 3 || raw.length > 16) continue;
    if (hit(SLURS, raw)) continue;
    if (!/[aeiouy]/.test(raw)) continue; // abbreviations like "dkl"
    valid.add(raw);
    const rude = hit(blocked, raw) && !INNOCENT.has(raw);
    if (rude) naughty.add(raw);
    else if (!v && lvl <= COMMON_MAX) common.add(raw);
  }
}

// Every prefix of every word, so the board solver can prune dead ends.
const prefixes = new Set();
for (const w of valid) for (let i = 1; i < w.length; i++) prefixes.add(w.slice(0, i));

module.exports = { valid, common, prefixes, blocked, naughty };
