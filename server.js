const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
const app = express();
const { OpenAI } = require('openai');

app.use(express.json());
const corsOptions ={
   origin:'*',
   credentials:true,
   optionSuccessStatus:200
}

app.use(cors(corsOptions)) 

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;  
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;  
const OPENAI_SECRET = process.env.OPENAI_API_KEY;

// PostgreSQL connection using Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : {
        rejectUnauthorized: false // Necessary for Heroku
    }
});

// Without this, a dropped idle database connection (Heroku Postgres
// maintenance, a network blip) crashes the whole server process.
pool.on('error', error => {
    console.error('Idle database connection error: ', error.message);
});


// Spotify app (client credentials) tokens last an hour, so reuse one
// instead of requesting a fresh token on every call.
let cachedSpotifyToken = null;
let cachedSpotifyTokenExpires = 0;

// Function to get Spotify access token
async function getSpotifyAccessToken() {
    if (cachedSpotifyToken && Date.now() < cachedSpotifyTokenExpires) {
        return cachedSpotifyToken;
    }
    const tokenResponse = await axios.post('https://accounts.spotify.com/api/token', 'grant_type=client_credentials', {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
        }
    });
    cachedSpotifyToken = tokenResponse.data.access_token;
    cachedSpotifyTokenExpires = Date.now() + ((tokenResponse.data.expires_in || 3600) - 60) * 1000;
    return cachedSpotifyToken;
}

// Since February 2026, Development Mode apps get a 400 ("Invalid limit") for
// any limit above 10 on Search and on Get Artist's Albums, so page by 10.
const SPOTIFY_PAGE_LIMIT = 10;
const MAX_ARTIST_ALBUMS = 50;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// GET a Spotify Web API URL with the app token. Retries once on an expired
// token and briefly on rate limits (429), then gives up.
async function spotifyGet(url, attempt = 0) {
    const accessToken = await getSpotifyAccessToken();
    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });
        return response.data;
    } catch (error) {
        const status = error.response ? error.response.status : null;
        if (status === 401 && attempt === 0) {
            cachedSpotifyToken = null;
            return spotifyGet(url, attempt + 1);
        }
        if (status === 429 && attempt < 2) {
            const retryAfter = Number(error.response.headers['retry-after']) || 1;
            await sleep(Math.min(retryAfter, 10) * 1000);
            return spotifyGet(url, attempt + 1);
        }
        throw error;
    }
}

// Smallest artist image that's still sharp in a 44px circle, or null.
function pickArtistImage(images) {
    const sorted = (images || []).filter(image => image && image.url).sort((a, b) => (a.width || 0) - (b.width || 0));
    const sharp = sorted.find(image => (image.width || 0) >= 120);
    return sharp ? sharp.url : (sorted.length ? sorted[sorted.length - 1].url : null);
}

const normalizeTitle = text => String(text || '').toLowerCase().trim().replace(/\s|'/g, '');

// Development Mode apps no longer receive track popularity (February 2026).
// Spotify orders an artist-filtered track search roughly by popularity, so a
// song's position in the artist's top 100 results stands in for it. Songs
// outside the top 100 count as deep cuts. Rankings are cached per artist.
const artistRankCache = new Map();
const ARTIST_RANK_PAGES = 10;
const ARTIST_RANK_TTL_MS = 6 * 60 * 60 * 1000;

async function artistTrackRanks(artistName) {
    const key = artistName.toLowerCase().trim();
    const cached = artistRankCache.get(key);
    if (cached && cached.expires > Date.now()) {
        return cached.ranks;
    }
    const ranks = new Map();
    const query = encodeURIComponent(`artist:"${artistName}"`);
    for (let page = 0; page < ARTIST_RANK_PAGES; page++) {
        const data = await spotifyGet(`https://api.spotify.com/v1/search?q=${query}&type=track&market=US&limit=${SPOTIFY_PAGE_LIMIT}&offset=${page * SPOTIFY_PAGE_LIMIT}`);
        const items = data.tracks.items;
        items.forEach((song, index) => {
            const name = normalizeTitle(song.name);
            if (!ranks.has(name)) {
                ranks.set(name, page * SPOTIFY_PAGE_LIMIT + index);
            }
        });
        if (items.length < SPOTIFY_PAGE_LIMIT) {
            break;
        }
    }
    if (artistRankCache.size > 300) {
        artistRankCache.delete(artistRankCache.keys().next().value);
    }
    artistRankCache.set(key, { ranks, expires: Date.now() + ARTIST_RANK_TTL_MS });
    return ranks;
}

async function estimatePopularity(artistName, songName) {
    try {
        const ranks = await artistTrackRanks(artistName);
        const rank = ranks.get(normalizeTitle(songName));
        return rank === undefined ? 1 : Math.max(1, 100 - rank);
    } catch (error) {
        console.error('Could not estimate popularity: ', error.message);
        return -1; // the client treats -1 as "score it the full 11 points"
    }
}

// Search artists by name, for the "pick any artists" grid builder. Uses the
// app token, so visitors don't need to connect their own Spotify account.
app.post('/search-artists', async (req, res) => {
    try {
        const query = String(req.body.query || '').trim().slice(0, 100);
        if (query.length < 2) {
            return res.json([]);
        }
        const data = await spotifyGet(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=artist&market=US&limit=${SPOTIFY_PAGE_LIMIT}`);
        const artists = data.artists.items.map(artist => ({
            id: artist.id,
            name: artist.name,
            img: pickArtistImage(artist.images),
            genres: (artist.genres || []).slice(0, 2)
        }));
        res.json(artists);
    } catch (error) {
        console.error('Error searching artists: ', error.message);
        res.status(500).send('Error searching artists');
    }
});

// ===================================================================
// Admin access
// Set ADMIN_KEY in the Heroku config vars to lock the admin-only
// endpoints. The admin page asks for the key once and sends it as an
// x-admin-key header. Until ADMIN_KEY is set, these stay open as before.
// ===================================================================
const ADMIN_KEY = process.env.ADMIN_KEY || '';

function requireAdmin(req, res, next) {
    if (!ADMIN_KEY || req.get('x-admin-key') === ADMIN_KEY) {
        return next();
    }
    res.status(401).json({ error: 'Admin key required' });
}

// The daily grid flips at midnight in this time zone (not Heroku's UTC).
const GRID_TIMEZONE = process.env.GRID_TIMEZONE || 'America/Chicago';
const TODAY_SQL = `(now() AT TIME ZONE '${GRID_TIMEZONE.replace(/'/g, '')}')::date`;

// ===================================================================
// Grid titles (OpenAI)
// gpt-4-turbo-preview was shut down on March 26, 2026. Try a few current
// models in order and remember the first one that works, so the next
// retirement doesn't break titles again. OPENAI_TITLE_MODEL overrides.
// ===================================================================
const TITLE_MODELS = [process.env.OPENAI_TITLE_MODEL, 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-4.1-mini']
    .filter((model, index, all) => model && all.indexOf(model) === index);
let workingTitleModel = null;
const BROKEN_TITLES = ['AI Failure Fallback Title', 'AI Error, No Fun Name', 'Placeholder Title', 'Fallback Grid Title'];

function titlePrompt(artistsJoined) {
    return `Your job is to create a clever, witty name for a custom trivia grid a user just created in my game, MusicGrid. The larger game is to guess songs that match categories and artists. There are 3 columns, each with one artist, and 3 rows, each with one category; users guess a song that matches the column's artist and the row's category. You need to name the title for a user's custom grid, with artists and categories they select. The name should be focused on the shared vibe of the artists; e.g. for Green Day/Linkin Park/My Chemical Romance, a clever version of Millenial Childhood Alt Rock would work. The name should be unique to the special vibe shared by the selected artists, always with as much specificity as possible for those three artists. Your suggestion should fit each of the three artists always. You can use vibes, genre, identity, time period, and more. Avoid cringey titles that feel uncool at all costs. You can either give it a summary title, or a funny prompt that describes the artists - a title of Artists Your Parents Would Hate or a title of Hyper-Pop Havoc would work if the artists were 100 gecs, Dorian Electra, and ElyOtto. Do not suggest titles that have a subtitle embedded with a colon, semicolon, hyphen, or other delimiter in any output. Reply with only the title: no quotes, no explanation, under 40 characters. The title you are generating now is for the artists: ${artistsJoined}`;
}

function cleanTitle(text) {
    let title = String(text || '').split('\n').map(line => line.trim()).find(Boolean) || '';
    title = title.replace(/^(title|grid name)\s*:\s*/i, '');
    title = title.replace(/^["'“”‘’*_`]+|["'“”‘’*_`]+$/g, '').trim();
    title = title.replace(/[.]+$/, '').trim();
    return title.slice(0, 60);
}

function fallbackTitle(artistsJoined) {
    const names = String(artistsJoined || '').split(',').map(name => name.trim()).filter(Boolean);
    if (names.length >= 3) return `${names[0]}, ${names[1]} & ${names[2]}`;
    if (names.length === 2) return `${names[0]} & ${names[1]}`;
    return names[0] || 'Custom MusicGrid';
}

async function generateGridTitle(artistsJoined) {
    if (!OPENAI_SECRET) {
        console.error('OPENAI_API_KEY is not set, using a fallback title');
        return null;
    }
    const models = workingTitleModel
        ? [workingTitleModel, ...TITLE_MODELS.filter(model => model !== workingTitleModel)]
        : TITLE_MODELS;
    for (const model of models) {
        try {
            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model,
                messages: [{ role: 'user', content: titlePrompt(artistsJoined) }]
            }, {
                headers: { 'Authorization': `Bearer ${OPENAI_SECRET}`, 'Content-Type': 'application/json' },
                timeout: 45000
            });
            const title = cleanTitle(response.data.choices[0].message.content);
            if (!title) continue;
            const check = await moderateTexts([title]);
            if (check[0] && check[0].flagged) {
                console.error(`Title "${title}" was flagged by moderation, using a fallback`);
                return null;
            }
            workingTitleModel = model;
            return title;
        } catch (error) {
            const status = error.response ? error.response.status : 'no response';
            const detail = error.response ? JSON.stringify(error.response.data).slice(0, 300) : error.message;
            console.error(`Title model ${model} failed (${status}): ${detail}`);
            // A bad key or an empty balance fails the same way for every model.
            if (status === 401 || (status === 429 && detail.includes('insufficient_quota'))) break;
        }
    }
    return null;
}

// ===================================================================
// Name screening for leaderboards
// 1) clean the text, 2) check a word list after undoing look-alike
// swaps (0->o, 1->i, $->s...), 3) ask OpenAI's free moderation model
// with stricter-than-default thresholds, since names are so short.
// Flagged names are swapped for a friendly random one; the original is
// kept in original_name so you can review it.
// ===================================================================
const MODERATION_MODEL = process.env.OPENAI_MODERATION_MODEL || 'omni-moderation-latest';
const NAME_MAX_LENGTH = 24;

// Stored base64-encoded so the repo doesn't display slurs in plain text.
// "anywhere" terms are blocked inside any name; "token" terms only as a
// whole word, because they also occur inside innocent words.
const decodeTerms = encoded => Buffer.from(encoded, 'base64').toString('utf8').split(',');
const BLOCK_ANYWHERE = decodeTerms('bmlnZyxuaWdnYSxmYWdnb3QsZmFnb3QsZmFnZyxraWtlLGNoaW5rcyx3ZXRiYWNrLHRyYW5ueSx0cmFubmllLHJhZ2hlYWQsdG93ZWxoZWFkLHBvcmNobW9ua2V5LGp1bmdsZWJ1bm55LHNhbmRuaWdnZXIscmV0YXJkLGN1bnQsd2hvcmUsaGl0bGVyLG5hemksa2lsbHlvdXJzZWxm');
const BLOCK_TOKENS = decodeTerms('ZmFnLGZhZ3MsY2hpbmssc3BpYyxzcGljayxjb29uLGNvb25zLGdvb2ssemlwcGVyaGVhZCxkeWtlLGtrayxjdW0sc2x1dCxyYXBlLHJhcGlzdCxoZWlsLGt5cw==');
const LOOKALIKES = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g' };

function cleanName(raw) {
    return String(raw || '')
        .normalize('NFKC')
        .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, NAME_MAX_LENGTH);
}

function wordListHit(name) {
    const folded = name.normalize('NFKD').replace(/[\u0300-\u036F]/g, '').toLowerCase()
        .split('').map(ch => LOOKALIKES[ch] || ch).join('');
    const letters = folded.replace(/[^a-z]/g, '');
    const squeezed = letters.replace(/(.)\1+/g, '$1');
    const tokens = folded.split(/[^a-z]+/).filter(Boolean);
    const anywhere = BLOCK_ANYWHERE.find(term => letters.includes(term) || (!/(.)\1/.test(term) && squeezed.includes(term)));
    if (anywhere) return 'word list';
    if (tokens.some(token => BLOCK_TOKENS.includes(token) || BLOCK_TOKENS.includes(token.replace(/(.)\1+/g, '$1')))) return 'word list';
    return null;
}

const MODERATION_THRESHOLDS = {
    'hate': 0.15, 'hate/threatening': 0.1, 'harassment': 0.35, 'harassment/threatening': 0.2,
    'sexual': 0.5, 'sexual/minors': 0.05, 'violence/graphic': 0.5, 'self-harm': 0.3, 'self-harm/instructions': 0.2, 'self-harm/intent': 0.2
};

// Returns one { flagged, reason } per input. If OpenAI can't be reached,
// it returns unflagged results so scores still go through (the word list
// still applies).
async function moderateTexts(texts) {
    if (!OPENAI_SECRET || !texts.length) return texts.map(() => ({ flagged: false, reason: null }));
    try {
        const response = await axios.post('https://api.openai.com/v1/moderations', {
            model: MODERATION_MODEL,
            input: texts
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_SECRET}`, 'Content-Type': 'application/json' },
            timeout: 8000
        });
        return response.data.results.map(result => {
            const scores = result.category_scores || {};
            const over = Object.keys(MODERATION_THRESHOLDS).find(category => (scores[category] || 0) > MODERATION_THRESHOLDS[category]);
            if (result.flagged || over) {
                const categories = Object.keys(result.categories || {}).filter(category => result.categories[category]);
                return { flagged: true, reason: 'moderation: ' + (categories[0] || over) };
            }
            return { flagged: false, reason: null };
        });
    } catch (error) {
        console.error('Moderation check failed, allowing name: ', error.response ? error.response.status : error.message);
        return texts.map(() => ({ flagged: false, reason: null }));
    }
}

const NAME_ADJECTIVES = ['Anonymous', 'Mystery', 'Secret', 'Incognito', 'Unnamed', 'Undercover', 'Masked', 'Quiet'];
const NAME_NOUNS = ['Bassist', 'Drummer', 'Roadie', 'Tambourine', 'Kazoo', 'Harmonica', 'Ukulele', 'Theremin', 'Cowbell', 'Keytar', 'Triangle', 'Oboe'];

function friendlyName(seed) {
    let hash = 0;
    for (const ch of String(seed)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return `${NAME_ADJECTIVES[hash % NAME_ADJECTIVES.length]} ${NAME_NOUNS[Math.floor(hash / NAME_ADJECTIVES.length) % NAME_NOUNS.length]}`;
}

async function screenName(rawName, seed) {
    const name = cleanName(rawName);
    if (!name) return { name: '', renamed: false, reason: null, original: null };
    let reason = wordListHit(name);
    if (!reason) reason = (await moderateTexts([name]))[0].reason;
    if (!reason) return { name, renamed: false, reason: null, original: null };
    return { name: friendlyName(seed || name), renamed: true, reason, original: name };
}

// ===================================================================
// Leaderboards
// New columns are added automatically at startup. Until that has run
// (or if the database refuses), everything falls back to the original
// name-only behavior.
// ===================================================================
const MAX_GRID_SCORE = 100; // 1 point for showing up + 9 squares x 11
let leaderboardSchemaReady = false;

async function ensureLeaderboardSchema() {
    try {
        await pool.query(`ALTER TABLE leaderboard_playerscores
            ADD COLUMN IF NOT EXISTS player_id TEXT,
            ADD COLUMN IF NOT EXISTS board_type TEXT,
            ADD COLUMN IF NOT EXISTS original_name TEXT,
            ADD COLUMN IF NOT EXISTS moderation_reason TEXT,
            ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ DEFAULT now()`);
        // Label older scores: daily if the id matches a daily grid, else custom.
        await pool.query(`UPDATE leaderboard_playerscores l
            SET board_type = CASE WHEN EXISTS (SELECT 1 FROM musicgrid_templates t WHERE t.grid_id::text = l.owning_grid_id::text)
                THEN 'daily' ELSE 'custom' END
            WHERE board_type IS NULL`);
        await pool.query('CREATE INDEX IF NOT EXISTS leaderboard_owning_grid_idx ON leaderboard_playerscores (owning_grid_id)');
        leaderboardSchemaReady = true;
        console.log('Leaderboard schema ready');
    } catch (error) {
        console.error('Could not update the leaderboard table, using the original columns: ', error.message);
    }
}
ensureLeaderboardSchema();

function validPlayerId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : null;
}

// Normalized view of the scores table that works before and after the
// new columns exist.
function scoresCte() {
    if (leaderboardSchemaReady) {
        return `scores AS (SELECT player_id, player_name, player_score::numeric AS score, owning_grid_id::text AS gid, board_type, submitted_at
            FROM leaderboard_playerscores)`;
    }
    return `scores AS (SELECT NULL::text AS player_id, player_name, player_score::numeric AS score, owning_grid_id::text AS gid,
            CASE WHEN owning_grid_id::text IN (SELECT grid_id::text FROM musicgrid_templates) THEN 'daily' ELSE 'custom' END AS board_type,
            NULL::timestamptz AS submitted_at
            FROM leaderboard_playerscores)`;
}

const PLAYER_KEY = `COALESCE(player_id, 'name:' || lower(trim(player_name)))`;

async function gridBoard(lbId, board, playerId, limit) {
    const { rows } = await pool.query(`WITH ${scoresCte()},
        entries AS (
            SELECT ${PLAYER_KEY} AS pkey, player_name, score, submitted_at FROM scores
            WHERE gid = $1::text AND board_type = $2
        ), best AS (
            SELECT DISTINCT ON (pkey) pkey, player_name, score FROM entries
            ORDER BY pkey, score DESC, submitted_at DESC NULLS LAST
        ), ranked AS (
            SELECT pkey, player_name, score,
                RANK() OVER (ORDER BY score DESC) AS rank,
                ROW_NUMBER() OVER (ORDER BY score DESC, player_name) AS rn,
                COUNT(*) OVER () AS players
            FROM best
        )
        SELECT rank, player_name, score, pkey = $3 AS me, players FROM ranked
        WHERE rn <= $4 OR pkey = $3 ORDER BY rn`, [String(lbId), board, playerId, limit]);
    return {
        players: rows.length ? Number(rows[0].players) : 0,
        entries: rows.map(row => ({ rank: Number(row.rank), player_name: String(row.player_name).trim(), player_score: Number(row.score), me: row.me === true }))
    };
}

// All-time: each player's best score on each daily grid, added up.
async function allTimeBoard(playerId, limit) {
    const { rows } = await pool.query(`WITH ${scoresCte()},
        daily AS (
            SELECT ${PLAYER_KEY} AS pkey, player_name, gid, score, submitted_at FROM scores WHERE board_type = 'daily'
        ), per_grid AS (
            SELECT pkey, gid, MAX(score) AS best FROM daily GROUP BY pkey, gid
        ), names AS (
            SELECT DISTINCT ON (pkey) pkey, player_name FROM daily
            ORDER BY pkey, submitted_at DESC NULLS LAST, player_name
        ), totals AS (
            SELECT p.pkey, n.player_name, SUM(p.best) AS total, COUNT(*) AS grids
            FROM per_grid p JOIN names n ON n.pkey = p.pkey GROUP BY p.pkey, n.player_name
        ), ranked AS (
            SELECT *, RANK() OVER (ORDER BY total DESC) AS rank,
                ROW_NUMBER() OVER (ORDER BY total DESC, player_name) AS rn,
                COUNT(*) OVER () AS players
            FROM totals
        )
        SELECT rank, player_name, total, grids, pkey = $1 AS me, players FROM ranked
        WHERE rn <= $2 OR pkey = $1 ORDER BY rn`, [playerId, limit]);
    return {
        players: rows.length ? Number(rows[0].players) : 0,
        entries: rows.map(row => ({ rank: Number(row.rank), player_name: String(row.player_name).trim(), total: Number(row.total), grids: Number(row.grids), me: row.me === true }))
    };
}

async function isDailyGridId(lbId) {
    const { rows } = await pool.query('SELECT 1 FROM musicgrid_templates WHERE grid_id::text = $1::text LIMIT 1', [String(lbId)]);
    return rows.length > 0;
}

// Both boards in one call. Body: { lb_id, board: 'daily' | 'custom', player_id }
app.post('/leaderboards', async (req, res) => {
    try {
        const lbId = req.body.lb_id;
        const board = req.body.board === 'custom' ? 'custom' : 'daily';
        const playerId = validPlayerId(req.body.player_id);
        const limit = Math.min(Number(req.body.limit) || 10, 50);
        const [grid, allTime] = await Promise.all([
            lbId === undefined || lbId === null ? { players: 0, entries: [] } : gridBoard(lbId, board, playerId, limit),
            allTimeBoard(playerId, limit)
        ]);
        res.json({ grid, allTime });
    } catch (err) {
        console.error('Error loading leaderboards: ', err.message);
        res.status(500).send('Error loading leaderboards');
    }
});

// ===================================================================
// Daily grid scheduling (admin)
// ===================================================================
function validDay(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value)) ? value : null;
}

app.post('/schedule-grid', requireAdmin, async (req, res) => {
    try {
        const gridId = req.body.grid_id;
        const day = validDay(req.body.reporting_day);
        if (!day) return res.status(400).json({ error: 'reporting_day must look like 2026-11-03' });
        const result = await pool.query('UPDATE musicgrid_templates SET reporting_day = $2::date WHERE grid_id = $1', [gridId, day]);
        res.json({ grid_id: gridId, reporting_day: day, rows: result.rowCount });
    } catch (err) {
        console.error('Error scheduling grid: ', err.message);
        res.status(500).send('Error scheduling grid');
    }
});

// Which grid plays on each day: the one with the latest reporting_day on
// or before that day. Days with no grid of their own repeat the last one.
app.get('/grid-calendar', async (req, res) => {
    try {
        const days = Math.min(Math.max(Number(req.query.days) || 21, 1), 90);
        const today = (await pool.query(`SELECT to_char(${TODAY_SQL}, 'YYYY-MM-DD') AS today`)).rows[0].today;
        const { rows } = await pool.query(`SELECT grid_id, to_char(MAX(reporting_day), 'YYYY-MM-DD') AS day, bool_or(is_live) AS live,
                STRING_AGG(DISTINCT CASE WHEN field_type = 'Artist' THEN field_value END, ', ') AS artists
            FROM musicgrid_templates WHERE reporting_day IS NOT NULL GROUP BY grid_id`);
        const calendar = [];
        const start = new Date(today + 'T00:00:00Z');
        for (let i = 0; i < days; i++) {
            const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
            const candidates = rows.filter(row => row.day <= date)
                .sort((a, b) => (b.day.localeCompare(a.day)) || ((b.live ? 1 : 0) - (a.live ? 1 : 0)) || (Number(b.grid_id) - Number(a.grid_id)));
            const pick = candidates[0];
            calendar.push({
                date,
                grid_id: pick ? pick.grid_id : null,
                artists: pick ? pick.artists : null,
                scheduled: Boolean(pick && pick.day === date)
            });
        }
        res.json({ today, timezone: GRID_TIMEZONE, calendar });
    } catch (err) {
        console.error('Error building grid calendar: ', err.message);
        res.status(500).send('Error building grid calendar');
    }
});

// ===================================================================
// One-off admin cleanups
// ===================================================================
app.post('/admin/retitle-custom-grids', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(Number(req.body.limit) || 20, 50);
        const { rows } = await pool.query(`SELECT custom_grid_id, STRING_AGG(field_value, ', ' ORDER BY field) AS artists
            FROM custom_templates WHERE field_type = 'Artist' AND grid_title = ANY($1)
            GROUP BY custom_grid_id ORDER BY custom_grid_id DESC LIMIT $2`, [BROKEN_TITLES, limit]);
        const updated = [];
        for (const row of rows) {
            const title = await generateGridTitle(row.artists) || fallbackTitle(row.artists);
            await pool.query('UPDATE custom_templates SET grid_title = $1 WHERE custom_grid_id = $2', [title, row.custom_grid_id]);
            updated.push({ custom_grid_id: row.custom_grid_id, title });
        }
        const remaining = await pool.query('SELECT COUNT(DISTINCT custom_grid_id) AS n FROM custom_templates WHERE grid_title = ANY($1)', [BROKEN_TITLES]);
        res.json({ updated, remaining: Number(remaining.rows[0].n) });
    } catch (err) {
        console.error('Error retitling grids: ', err.message);
        res.status(500).send('Error retitling grids');
    }
});

app.post('/admin/screen-leaderboard', requireAdmin, async (req, res) => {
    try {
        if (!leaderboardSchemaReady) return res.status(503).json({ error: 'Leaderboard columns are not ready yet' });
        const { rows } = await pool.query(`SELECT DISTINCT player_name FROM leaderboard_playerscores
            WHERE original_name IS NULL AND player_name IS NOT NULL`);
        const names = rows.map(row => row.player_name);
        const renamed = [];
        for (let i = 0; i < names.length; i += 32) {
            const batch = names.slice(i, i + 32);
            const ai = await moderateTexts(batch.map(cleanName));
            for (let j = 0; j < batch.length; j++) {
                const reason = wordListHit(cleanName(batch[j])) || ai[j].reason;
                if (!reason) continue;
                const newName = friendlyName(batch[j]);
                await pool.query(`UPDATE leaderboard_playerscores SET player_name = $2, original_name = $1, moderation_reason = $3
                    WHERE player_name = $1 AND original_name IS NULL`, [batch[j], newName, reason]);
                renamed.push({ from: batch[j], to: newName, reason });
            }
        }
        res.json({ scanned: names.length, renamed });
    } catch (err) {
        console.error('Error screening leaderboard: ', err.message);
        res.status(500).send('Error screening leaderboard');
    }
});

app.get('/admin/moderation-log', requireAdmin, async (req, res) => {
    try {
        if (!leaderboardSchemaReady) return res.json([]);
        const { rows } = await pool.query(`SELECT original_name, player_name, moderation_reason, owning_grid_id, submitted_at
            FROM leaderboard_playerscores WHERE original_name IS NOT NULL ORDER BY submitted_at DESC NULLS LAST LIMIT 100`);
        res.json(rows);
    } catch (err) {
        console.error('Error loading moderation log: ', err.message);
        res.status(500).send('Error loading moderation log');
    }
});

// Endpoint to search song guesses on Spotify
app.post('/search', async (req, res) => {
    try {
        const searchTerm = req.body.searchTerm;
        const easyModeBool = req.body.easyModeBool || false;
        const artistSearch = req.body.artistName || '';
        const accessToken = await getSpotifyAccessToken();
        let searchTermAppend = `"${searchTerm}"`;
        let artistSearchAppend = '';
        
        if(!easyModeBool) {
            searchTermAppend = `track:"${searchTerm}"`;
        }
        if(artistSearch.length === 0 || artistSearch === null) {
            artistSearchAppend = '';
        } else if (easyModeBool) {
            artistSearchAppend = ` ${artistSearch}`;
        } else {
            artistSearchAppend = ` artist:"${artistSearch}"`;
        }
        console.log('Fetching from spotify:' + `https://api.spotify.com/v1/search?q=${encodeURIComponent(searchTermAppend)}${encodeURIComponent(artistSearchAppend)}&type=track&market=US&limit=10`);
        const searchResponse = await axios.get(`https://api.spotify.com/v1/search?q=${encodeURIComponent(searchTermAppend)}${encodeURIComponent(artistSearchAppend)}&type=track&market=US&limit=10`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        songMatches = [];
        searchResponse.data.tracks.items.forEach(song => {
                    let artistMatch = false;
                    song.artists.forEach(artist => {
                        if(artist.name.toLowerCase().trim() == artistSearch.toLowerCase().trim()) {
                            artistMatch = true;
                        }
                    });
                    if(artistMatch) {
                        songMatches.push(song);
                    }
                });
        res.json(songMatches);
    } catch (error) {
        console.error('Error during search: ', error);
        res.status(500).send('Error during search');
    }
});


// Endpoint to search song answers on Spotify
app.post('/search-encoding-answer', async (req, res) => {
    const searchTerm = req.body.searchTerm || '';
    const encoderReq = req.body.encoderReq || false;
    const artistSearch = req.body.artistSearch || ``;
    // The encoder used to ask for 50 results at once. Spotify now caps search
    // at 10, so check up to three pages instead.
    const pages = encoderReq ? 3 : 1;
    const searchName = normalizeTitle(searchTerm);
    const searchArtist = normalizeTitle(artistSearch);
    let searchableSong = encodeURIComponent(`"${searchTerm}"`).replace(/\s|'/g,"%27");
    let searchableArtist = artistSearch.length === 0 ? '' : encodeURIComponent(` artist:"${artistSearch}"`).replace(/\s|'/g,"%27");

    try {
        let match = null;
        for (let page = 0; page < pages && !match; page++) {
            const url = `https://api.spotify.com/v1/search?q=${searchableSong}${searchableArtist}&type=track&market=US&limit=${SPOTIFY_PAGE_LIMIT}&offset=${page * SPOTIFY_PAGE_LIMIT}`;
            console.log('Fetching from spotify:' + url);
            const data = await spotifyGet(url);
            const items = data.tracks.items;
            match = items.find(song => normalizeTitle(song.name) === searchName
                && song.artists.some(artist => normalizeTitle(artist.name) === searchArtist)) || null;
            if (items.length < SPOTIFY_PAGE_LIMIT) {
                break;
            }
        }

        if (!match) {
            return res.json({name: artistSearch, popularity: -1, preview_url: ''});
        }
        if (typeof match.popularity !== 'number') {
            match.popularity = await estimatePopularity(artistSearch, match.name);
        }
        res.json(match);
    } catch (error) {
        console.error('Error during encoding search: ', error.message);
        res.status(500).send('Error during search');
    }
});

// Endpoint to update leaderboard after game completion
// Body: { name, score, lb_id, player_id?, board? }. Older clients that only
// send name/score/lb_id still work.
app.post('/submit-score', async (req, res) => {
    try {
        const lbId = req.body.lb_id;
        const score = Number(req.body.score);
        if (lbId === undefined || lbId === null || !Number.isFinite(score) || score < 0 || score > MAX_GRID_SCORE) {
            return res.status(400).json({ error: 'Invalid score' });
        }
        const playerId = validPlayerId(req.body.player_id);
        const screened = await screenName(req.body.name, playerId);
        if (!screened.name) {
            return res.status(400).json({ error: 'Add a name' });
        }
        if (screened.renamed) {
            console.log(`Renamed leaderboard name (${screened.reason})`);
        }
        if (leaderboardSchemaReady) {
            const daily = req.body.board !== 'custom' && await isDailyGridId(lbId);
            await pool.query(`INSERT INTO leaderboard_playerscores
                (player_name, player_score, owning_grid_id, player_id, board_type, original_name, moderation_reason)
                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [screened.name, score, lbId, playerId, daily ? 'daily' : 'custom', screened.original, screened.reason]);
        } else {
            await pool.query('INSERT INTO leaderboard_playerscores(player_name, player_score, owning_grid_id) VALUES ($1,$2,$3)', [screened.name, score, lbId]);
        }
        res.send({ message: 'Score submitted successfully.', name: screened.name, renamed: screened.renamed });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});


//Endpoint to get leaderboard scores
app.post('/scores', async (req, res) => {
    try {
        const { lb_id } = req.body;
        const query = 'SELECT RANK() OVER (ORDER BY player_score DESC) AS rank, player_name, player_score FROM leaderboard_playerscores WHERE owning_grid_id = $1 ORDER BY player_score DESC';
        const { rows } = await pool.query(query, [lb_id]);
        res.send(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

//Endpoint to get ID of the current grid we should serve
app.get('/latest-grid', async (req, res) => {
    try {
        // The grid with the latest reporting_day on or before today (in
        // GRID_TIMEZONE) plays. "Set live" breaks ties for the same day.
        const query = `SELECT grid_id, to_char(MAX(reporting_day), 'YYYY-MM-DD') AS reporting_day
            FROM musicgrid_templates
            GROUP BY grid_id
            HAVING MAX(reporting_day) <= ${TODAY_SQL}
            ORDER BY MAX(reporting_day) DESC, bool_or(is_live) DESC, grid_id DESC
            LIMIT 1`;
        const result = await pool.query(query);
        if (!result.rows.length) {
            return res.status(404).json({ error: 'No grid is scheduled yet' });
        }
        res.json({ latestGridId: result.rows[0].grid_id, reportingDay: result.rows[0].reporting_day });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching latest grid');
    }
});

//Endpoint to get ID of the current grid we should serve
// "Set live" now means "play this grid today": it takes today's date, and
// grids scheduled for later days still take over on those days.
app.post('/set-grid-live', requireAdmin, async (req, res) => {
    try {
        const { grid_id } = req.body;
        await pool.query('UPDATE musicgrid_templates SET is_live = (grid_id = $1)', [grid_id]);
        await pool.query(`UPDATE musicgrid_templates SET reporting_day = ${TODAY_SQL} WHERE grid_id = $1`, [grid_id]);
        res.json({ grid_id });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error setting grid live');
    }
});

//Endpoint to get contents of current live grid
app.post('/grid-data', async (req, res) => {
    try {
        const { grid_id } = req.body;
        const query = 'SELECT field_type, field, field_value FROM musicgrid_templates WHERE grid_id = $1 ORDER BY field_type ASC, field ASC'; // Replace with your actual query
        const { rows } = await pool.query(query, [grid_id]);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching grid data');
    }
});

//Endpoint to get contents of specific custom grid
app.post('/custom-grid-data', async (req, res) => {
    try {
        const { custom_grid_id } = req.body;
        const query = 'SELECT field_type, field, field_value, grid_title FROM custom_templates WHERE custom_grid_id = $1 ORDER BY field_type ASC, field ASC'; // Replace with your actual query
        const { rows } = await pool.query(query, [custom_grid_id]);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching grid data');
    }
});

//Endpoint to get list of grids for administration
app.get('/fetch-grid-summary', async (req, res) => {
    try {
        const query = "SELECT t.grid_id, MAX(t.create_date) AS create_date, MAX(t.reporting_day) AS post_date, COALESCE(MAX(a.updated_at_pst),'1994-05-31 12:00:00'::TIMESTAMP) AS answers_last_updated_pst, STRING_AGG ( DISTINCT CASE WHEN t.field_type = 'Artist' THEN t.field_value ELSE NULL END,', ' ) AS num_artist_cells, STRING_AGG( DISTINCT CASE WHEN t.field_type = 'Category' THEN t.field_value ELSE NULL END,', ' ) AS num_category_cells, COUNT( DISTINCT CASE WHEN t.field_type = 'Answer' THEN t.field ELSE NULL END ) AS num_raw_answer_cells, COUNT(a.*) AS num_encoded_answer, COUNT(DISTINCT a.field) AS num_fields_w_encoded_answers FROM musicgrid_templates t LEFT JOIN musicgrid_answers a ON t.grid_id = a.grid_id AND t.field = a.field GROUP BY 1 ORDER BY 2 DESC, 1 DESC";
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching grid summary data');
    }
});


//Endpoint to evaluate guesses against the answer list
app.post('/check-answer', async (req, res) => {
    try {
        const { songGuess, fieldGuessed, gridId } = req.body;
        const songGuessIlike = `%${songGuess}%`
        const query = 'SELECT normed_score AS guessScore, 0 AS rn FROM musicgrid_answers WHERE grid_id = $3 AND field = $2 AND (song_name = $1 OR song_name ILIKE $4 OR position(lower(song_name) in lower($1))>0) UNION ALL SELECT 0 AS guess_score, 10 as rn ORDER BY 2 ASC, 1 DESC LIMIT 1';
        const { rows } = await pool.query(query, [songGuess, fieldGuessed, gridId, songGuessIlike]);
        console.log( rows ); 
        res.json(rows);
    } catch (err) {
        console.error('Error updating checking guess:'+err.message);
        res.status(500).send('Error checking a guess answer');
    }
  });


//Endpoint to evaluate custom guesses against the answer list
app.post('/check-custom-answer', async (req, res) => {
    try {
        const { songGuess, fieldGuessed, customGridId } = req.body;
        const songGuessIlike = `%${songGuess}%`
        const query = 'SELECT normed_score AS guessScore, 0 AS rn FROM custom_answers WHERE custom_grid_id = $3 AND field = $2 AND (song_name = $1 OR song_name ILIKE $4 OR position(lower(song_name) in lower($1))>0) UNION ALL SELECT 0 AS guess_score, 10 as rn ORDER BY 2 ASC, 1 DESC LIMIT 1';
        const { rows } = await pool.query(query, [songGuess, fieldGuessed, customGridId, songGuessIlike]);
        console.log( rows ); 
        res.json(rows);
    } catch (err) {
        console.error('Error updating checking guess:'+err.message);
        res.status(500).send('Error checking a guess answer');
    }
  });


//Endpoint to update encoded answers table
app.post('/update-encoded-answers', requireAdmin, async (req, res) => {
    try {
        const { encodedAnswers } = req.body;
        const client = await pool.connect();

        for (const answer of encodedAnswers) {
            const { fieldKey, song, popularity, normedAnswerScore, previewUrl, gridId } = answer;

            // Delete existing entries for the grid IDs
            const delQuery = 'DELETE FROM musicgrid_answers WHERE grid_id = $1 AND field = $2 and song_name = $3';
            await client.query(delQuery, [gridId, fieldKey, song]);

            // Insert new answer data 
            const insertQuery = 'INSERT INTO musicgrid_answers (field, song_name, popularity, normed_score, preview_url, grid_id) VALUES ($1, $2, $3, $4, $5, $6)';
            await client.query(insertQuery, [fieldKey, song, popularity, normedAnswerScore, previewUrl, gridId]);
        }

        client.release();
        res.send('Encoded answers updated successfully');
    } catch (err) {
        console.error('Error updating encoded answers:', err.message);
        client?.release();
        res.status(500).send('Error updating encoded answers');
    }
});

//Endpoint to update encoded answers for custom table
app.post('/update-custom-encoded-answers', async (req, res) => {
    try {
        const { encodedAnswers } = req.body;
        const client = await pool.connect();

        for (const answer of encodedAnswers) {
            const { fieldKey, song, popularity, normedAnswerScore, previewUrl, customGridId } = answer;

            // Delete existing entries for the grid IDs
            const delQuery = 'DELETE FROM custom_answers WHERE custom_grid_id = $1 AND field = $2 and song_name = $3';
            await client.query(delQuery, [customGridId, fieldKey, song]);

            // Insert new answer data 
            const insertQuery = 'INSERT INTO custom_answers (field, song_name, popularity, normed_score, preview_url, custom_grid_id) VALUES ($1, $2, $3, $4, $5, $6)';
            await client.query(insertQuery, [fieldKey, song, popularity, normedAnswerScore, previewUrl, customGridId]);
        }

        client.release();
        res.send('Encoded answers updated successfully');
    } catch (err) {
        console.error('Error updating encoded answers:', err.message);
        client?.release();
        res.status(500).send('Error updating encoded answers');
    }
});

app.post('/get-cheat-preview-url', async (req, res) => {
    try {
        const { gridId, fieldKey } = req.body;
        const client = await pool.connect();

        // Query to find the most popular song's preview URL for a specific fieldKey and gridId
        const query = `
            SELECT preview_url
            FROM musicgrid_answers
            WHERE grid_id = $1 AND field = $2 AND preview_url IS NOT NULL
            ORDER BY normed_score ASC, RANDOM()
            LIMIT 1
        `;

        const result = await client.query(query, [gridId, fieldKey]);

        // Check if a result was found
        if (result.rows.length > 0) {
            const previewUrl = result.rows[0].preview_url;
            res.json({ previewUrl });
        } else {
            res.status(404).send('Preview URL not found for the given field and grid ID.');
        }

        client.release();
    } catch (err) {
        console.error('Error fetching cheat preview URL:', err.message);
        client?.release();
        res.status(500).send('Error fetching cheat preview URL');
    }
});

app.post('/get-custom-cheat-preview-url', async (req, res) => {
    try {
        const { customGridId, fieldKey } = req.body;
        const client = await pool.connect();

        // Query to find the most popular song's preview URL for a specific fieldKey and gridId
        const query = `
            SELECT preview_url
            FROM custom_answers
            WHERE custom_grid_id = $1 AND field = $2 AND preview_url IS NOT NULL
            ORDER BY normed_score ASC, RANDOM()
            LIMIT 1
        `;

        const result = await client.query(query, [customGridId, fieldKey]);

        // Check if a result was found
        if (result.rows.length > 0) {
            const previewUrl = result.rows[0].preview_url;
            res.json({ previewUrl });
        } else {
            res.status(404).send('Preview URL not found for the given field and grid ID.');
        }

        client.release();
    } catch (err) {
        console.error('Error fetching cheat preview URL:', err.message);
        client?.release();
        res.status(500).send('Error fetching cheat preview URL');
    }
});

app.post('/list-songs-by-duration', async (req, res) => {
    try {
        const artistName = req.body.artistName;
        let maxDuration = req.body.maxDurationMs || 1800000; // Default max duration
        let minDuration = req.body.minDurationMs || 0;      // Default min duration
        let debug = false;
        
        const artistSearchComponent = 'artist:"' + artistName + '"';
        let offset = 0;
        let totalResults = 0;
        const songsMatchingDuration = [];
        const accessToken = await getSpotifyAccessToken();

        do {
            const searchResponse = await axios.get(`https://api.spotify.com/v1/search?q=${encodeURIComponent(artistSearchComponent)}&type=track&market=US&offset=${offset}&limit=50`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });
            totalResults = searchResponse.data.tracks.total;
            searchResponse.data.tracks.items.forEach(song => {
                let durationMatch = false;
                let artistMatch = false;
                if (song.duration_ms < maxDuration && song.duration_ms > minDuration) {
                    durationMatch = true;
                    let durationMinutes = Math.round(song.duration_ms/6000,1)/10
                    if(debug) {console.log(`Duration matched for song "${song.name}" of dur ${durationMinutes} minutes (${maxDuration} > ${song.duration_ms} ms > ${minDuration})`)};
                    song.artists.forEach(artist => {
                        if(artist.name.toLowerCase().trim() == artistName.toLowerCase().trim()) {
                            artistMatch = true;
                            if(debug) {console.log(`Artist "${artist}" matched`)};
                        }
                    });
                    if(durationMatch && artistMatch) {
                        songsMatchingDuration.push(song.name);
                    }
                }
            });
            offset += 50;
        } while (offset < totalResults);
        res.json(Array.from(new Set(songsMatchingDuration)));
    } catch (error) {
        console.error('Error during search: ', error);
        res.status(500).send('Error during search');
    }
});

app.post('/list-songs-by-dates', async (req, res) => {
    try {
        const artistName = req.body.artistName;
        let startYear = req.body.startYear || 1450; 
        let endYear = req.body.endYear || 2050;   

        const artistSearchComponent = 'artist:"' + artistName + '"';
        const yearSearchComponent = 'year:'+startYear+'-'+endYear+' ';
        let offset = 0;
        let totalResults = 0;
        const songsMatchingDuration = [];
        const accessToken = await getSpotifyAccessToken();

        do {
            const searchResponse = await axios.get(`https://api.spotify.com/v1/search?q=${encodeURIComponent(yearSearchComponent)}${encodeURIComponent(artistSearchComponent)}&type=track&market=US&offset=${offset}&limit=50`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });
            totalResults = searchResponse.data.tracks.total;
            searchResponse.data.tracks.items.forEach(song => {
                let dateMatch = false;
                let artistMatch = false;
                let releaseYear = parseInt(song.album.release_date.slice(0,4))
                if (releaseYear >= startYear && releaseYear <= endYear) {
                    dateMatch = true;
                    song.artists.forEach(artist => {
                        if(artist.name.toLowerCase().trim() == artistName.toLowerCase().trim()) {
                            artistMatch = true;
                        }
                    });
                    if(dateMatch && artistMatch) {
                        songsMatchingDuration.push(song.name);
                    }
                }
            });
            offset += 50;
        } while (offset < totalResults);
        res.json(Array.from(new Set(songsMatchingDuration)));
    } catch (error) {
        console.error('Error during search: ', error);
        res.status(500).send('Error during search');
    }
});

app.post('/list-songs-by-wordcount', async (req, res) => {
    try {
        const artistName = req.body.artistName;
        let wordCount = req.body.wordCount || 1; 

        const artistSearchComponent = 'artist:"' + artistName + '"';
        let offset = 0;
        let totalResults = 0;
        const songsMatchingWordCount = [];
        const accessToken = await getSpotifyAccessToken();

        do {
            const searchResponse = await axios.get(`https://api.spotify.com/v1/search?q=${encodeURIComponent(artistSearchComponent)}&type=track&market=US&offset=${offset}&limit=50`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });
            totalResults = searchResponse.data.tracks.total;
            searchResponse.data.tracks.items.forEach(song => {
                let lengthMatch = false;
                let artistMatch = false;
                if (song.name.split(" ").length == wordCount) {
                    lengthMatch = true;
                    song.artists.forEach(artist => {
                        if(artist.name.toLowerCase().trim() == artistName.toLowerCase().trim()) {
                            artistMatch = true;
                        }
                    });
                    if(lengthMatch && artistMatch) {
                        songsMatchingWordCount.push(song.name);
                    }
                }
            });
            offset += 50;
        } while (offset < totalResults);
        res.json(Array.from(new Set(songsMatchingWordCount)));
    } catch (error) {
        console.error('Error during search: ', error);
        res.status(500).send('Error during search');
    }
});

app.post('/fetch-top-artists', async (req, res) => {
    try {
        const accessToken = req.body.accessToken;
        const timeRangeParsed = req.body.timeRange || 'medium_term';
        let debug = true;
        if(debug) {console.log("Bearer token for user is "+accessToken)};
        let topArtists = [];

        const resultArtists = await axios.get(`https://api.spotify.com/v1/me/top/artists?time_range=${timeRangeParsed}`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });
        resultArtists.data.items.forEach(artist => {
            let artistPic = "/img/noArtist.png";
            let artistPicArray = [];
            let found160 = false;
            let foundAnyPics = false;
            artist.images.forEach(artistImage => {
                if (artistImage.height == 160) {
                    artistPic = artistImage.url;
                    found160 = true;
                } else if ( !found160 && artistImage.height >= 160 ) {
                    artistPicArray.push(artistImage.url);
                    foundAnyPics = true;
                }
            });
            if (!found160 && foundAnyPics) {
                artistPic = artistPicArray[artistPicArray.length - 1];
            }
            topArtists.push({id: artist.id, name: artist.name, img:artistPic});
        });
        
        res.json(Array.from(new Set(topArtists )));
    } catch (error) {
        console.error('Error looking up top artists: ', error);
        res.status(500).send('Error looking up top artists');
    }
});

app.post('/rich-artist-lookup', async (req, res) => {
    try {
        const artistId = req.body.artistId;
        let searchGroups = "single,album";
        let durations = req.body.durations || [60000, 120000, 180000, 240000, 300000, 360000]; // Default max duration
        let wordCounts = req.body.wordCounts || [1,2,3,4,5]
        const bannedWords = ["live at", "live from", "live on", "- live", "- demo", "remix", "radio edit", "rmx", "anniversary", "deluxe", "instrumental"]
        let debug = true;
        
        let albumOffset = 0;
        let trackOffset = 0;
        let totalResults = 0;
        const songsByDurationSumm = {};
        const songsByWordcountSumm = {};
        const songsByDurationDetails = {};
        const songsByWordcountDetails = {};
        const songsByReleaseDateSumm = {};
        const songsByReleaseDateDetails = {};
        let albumArr = [];
        let tracksArr = [];
        durations.forEach( duration => {
            songsByDurationSumm[duration] = 0;
            songsByDurationDetails[duration] = [];
        });
        wordCounts.forEach( wordCount => {
            songsByWordcountSumm[wordCount] = 0;
            songsByWordcountDetails[wordCount] = [];
        });
        const accessToken2 = await getSpotifyAccessToken();

        // Pull all albums to later pull all tracks
        await albumPull();
        if(debug) {console.log(`Album list at: ${albumArr}`);}

        async function albumPull(albumOffset) {
            const albumList = await axios.get(`https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}/albums?include_groups=${encodeURIComponent(searchGroups)}&market=US&limit=50&albumOffset=${albumOffset}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken2}`
                }
            });
            totalAlbums = albumList.data.total;
            albumList.data.items.forEach(album => {
                if(debug) {console.log("Checking album "+album.name);}
                //First we check if the album contains any banned words (filtering for alternate versions and remixes)
                let skip = false;
                bannedWords.forEach(word => {
                    if (album.name.toLowerCase().includes(word.toLowerCase())) {
                        skip = true;
                        if(debug) {console.log(album.name+" removed for invalid term in title.");}
                    }
                });
                if(!skip) {
                    albumArr.push(album.id);
                    let currKeys = Object.keys(songsByReleaseDateSumm);
                    let currYear = album.release_date.slice(0,4) 
                    if(currKeys.length >= 0 && currKeys.includes(currYear)) {
                        if(debug) {console.log(currYear+" already exists in year index, count now at "+(songsByReleaseDateSumm[currYear]+album.total_tracks));}
                        songsByReleaseDateSumm[currYear]+=album.total_tracks;
                        // album.tracks.items.forEach(albumTrack => {
                        //     songsByReleaseDateDetails[currYear].push({id:albumTrack.id, name:albumTrack.name}); // TODO: This isn't exhaustive we should actually search Album tracks or hit existing endpoint
                        // });
                    } else {
                        if(debug) {console.log(currYear+" added fresh to year index with "+album.total_tracks+" tracks");}
                        songsByReleaseDateSumm[currYear]=album.total_tracks;
                        songsByReleaseDateDetails[currYear] = [];
                        // album.tracks.items.forEach(albumTrack => {
                        //     songsByReleaseDateDetails[currYear].push({id:albumTrack.id, name:albumTrack.name}); // TODO: This isn't exhaustive we should actually search Album tracks or hit existing endpoint
                        // });
                    }
                }
            });
        }
        
        // Now count releases by year for each response date
        // We can search up to 20 albums at once
        for(let j = 0; j < albumArr.length; j+=1) {   
            let albumId = albumArr[j];
            await albumTrackPull(albumId);
        }

        async function albumTrackPull(albumId) {
            setTimeout(async function() {
                const albumTrackList = await axios.get(`https://api.spotify.com/v1/albums/${encodeURIComponent(albumId)}/tracks?market=US&limit=50&offset=${tracksOffset}`, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
                    }
                });
                totalAlbumTracks = albumTrackList.data.total;
                albumTrackList.data.items.forEach(albumTrack => {
                    let skip = false;
                    bannedWords.forEach(word => {
                        if (albumTrack.name.toLowerCase().includes(word.toLowerCase())) {
                            skip = true;
                            if(debug) {console.log(albumTrack.name+" removed for invalid term in title.");}
                        }
                    });
                    if(!skip) {
                        lowestDurationFound = false;
                        wordCountFound = false;
                        durations.forEach(duration => {
                            if (!lowestDurationFound && (duration == durations[durations.length-1] || albumTrack.duration_ms < duration)) { 
                                songsByDurationSumm[duration] += 1;
                                songsByDurationDetails[duration].push({id: albumTrack.id, name: albumTrack.name});
                                lowestDurationFound = true;
                            }
                        });
                        wordCounts.forEach(wordCount => {
                            if (!wordCountFound && albumTrack.name.split(" ").length == wordCount) { 
                                songsByWordcountSumm[wordCount] += 1;
                                songsByWordcountDetails[wordCount].push({id: albumTrack.id, name: albumTrack.name});
                                wordCountFound = true;
                            }
                        });
                    }
                });
            }, 50*trackOffset);
        }
            
        let songSummary = { duration: songsByDurationSumm, wordcount: songsByWordcountSumm, releasedate: songsByReleaseDateSumm }
        let songDetails = { duration: songsByDurationDetails, wordcount: songsByWordcountDetails, releasedate: songsByReleaseDateDetails }
        res.json({summary: songSummary, details: songDetails});
    } catch (error) {
        console.error('Error during search: ', error);
        res.status(500).send('Error during search');
    }
});


app.post('/rich-artist-lookup-v2', async (req, res) => {
    try {
        const artistId = req.body.artistId;
        let searchGroups = "single,album";
        let durations = req.body.durations || [60000, 120000, 180000, 240000, 300000, 360000]; // Default max duration
        let wordCounts = req.body.wordCounts || [1,2,3,4,5]
        const bannedWords = ["live at", "live from", "live on", "- live", "- demo", "remix", "radio edit", "rmx", "anniversary", "deluxe", "instrumental"]
        let debug = true;
        
        let albumOffset = 0;
        let tracksOffset = 0;
        let totalResults = 0;
        let totalAlbums = 1;
        const songsByDurationSumm = {};
        const songsByWordcountSumm = {};
        const songsByDurationDetails = {};
        const songsByWordcountDetails = {};
        const songsByReleaseDateSumm = {};
        const songsByReleaseDateDetails = {};
        let albumsObj = {};
        let tracksArr = [];
        durations.forEach( duration => {
            songsByDurationSumm[duration] = 0;
            songsByDurationDetails[duration] = [];
        });
        wordCounts.forEach( wordCount => {
            songsByWordcountSumm[wordCount] = 0;
            songsByWordcountDetails[wordCount] = [];
        });
        console.log("Fetching /artists/artistId/albums for "+artistId);
        // Page through up to 50 albums, 10 at a time (Spotify's current cap).
        const albumItems = [];
        for (albumOffset = 0; albumOffset < Math.min(totalAlbums, MAX_ARTIST_ALBUMS); albumOffset += SPOTIFY_PAGE_LIMIT) {
            const albumPage = await spotifyGet(`https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}/albums?include_groups=${encodeURIComponent(searchGroups)}&market=US&limit=${SPOTIFY_PAGE_LIMIT}&offset=${albumOffset}`);
            totalAlbums = albumPage.total;
            albumItems.push(...albumPage.items);
        }
        console.log("Total albums now at:"+totalAlbums);
        albumItems.forEach(album => {
            if(debug) {console.log("Checking album "+album.name);}
            //First we check if the album contains any banned words (filtering for alternate versions and remixes)
            let skip = false;
            bannedWords.forEach(word => {
                if (album.name.toLowerCase().includes(word.toLowerCase())) {
                    skip = true;
                    if(debug) {console.log(album.name+" removed for invalid term in title.");}
                }
            });
            if(!skip) {
                let currKeys = Object.keys(songsByReleaseDateSumm);
                let currYear = album.release_date.slice(0,4); 
                albumsObj[album.id] = currYear;
                if(currKeys.length >= 0 && currKeys.includes(currYear)) {
                    if(debug) {console.log(currYear+" already exists in year index, count now at "+(songsByReleaseDateSumm[currYear]+album.total_tracks));}
                    songsByReleaseDateSumm[currYear]+=album.total_tracks;
                    // album.tracks.items.forEach(albumTrack => {
                    //     songsByReleaseDateDetails[currYear].push({id:albumTrack.id, name:albumTrack.name}); // TODO: This isn't exhaustive we should actually search Album tracks or hit existing endpoint
                    // });
                } else {
                    if(debug) {console.log(currYear+" added fresh to year index with "+album.total_tracks+" tracks");}
                    songsByReleaseDateSumm[currYear]=album.total_tracks;
                    songsByReleaseDateDetails[currYear] = [];
                    // album.tracks.items.forEach(albumTrack => {
                    //     songsByReleaseDateDetails[currYear].push({id:albumTrack.id, name:albumTrack.name}); // TODO: This isn't exhaustive we should actually search Album tracks or hit existing endpoint
                    // });
                }
            }
        });
        
        // Now count releases by year for each response date
        // We can search up to 20 albums at once
        let albumArr = Object.keys(albumsObj);
        if(debug) {console.log(`Album list at: ${albumArr}`);}
        for(let j = 0; j < albumArr.length; j+=1) {
            let albumId = albumArr[j];
            console.log("Fetching /albums/albumid/tracks for artist "+artistId+" album "+albumId);
            const albumTrackList = { data: await spotifyGet(`https://api.spotify.com/v1/albums/${encodeURIComponent(albumId)}/tracks?market=US&limit=50&offset=${tracksOffset}`) };
            let totalAlbumTracks = albumTrackList.data.total;
            albumTrackList.data.items.forEach(albumTrack => {
                let skip = false;
                bannedWords.forEach(word => {
                    if (albumTrack.name.toLowerCase().includes(word.toLowerCase())) {
                        skip = true;
                        if(debug) {console.log(albumTrack.name+" removed for invalid term in title.");}
                    }
                });
                if(!skip) {
                    let lowestDurationFound = false;
                    let wordCountFound = false;
                    let currKeys = Object.keys(songsByReleaseDateSumm);
                    let currYear = albumsObj[albumId];
                    
                    durations.forEach(duration => {
                        if (!lowestDurationFound && (duration == durations[durations.length-1] || albumTrack.duration_ms < duration)) { 
                            songsByDurationSumm[duration] += 1;
                            songsByDurationDetails[duration].push({id: albumTrack.id, name: albumTrack.name});
                            lowestDurationFound = true;
                        }
                    });
                    
                    wordCounts.forEach(wordCount => {
                        if (!wordCountFound && albumTrack.name.split(" ").length == wordCount) { 
                            songsByWordcountSumm[wordCount] += 1;
                            songsByWordcountDetails[wordCount].push({id: albumTrack.id, name: albumTrack.name});
                            wordCountFound = true;
                        }
                    });
                    
                    if(currKeys.length >= 0 && currKeys.includes(currYear)) {
                            songsByReleaseDateDetails[currYear].push({id:albumTrack.id, name:albumTrack.name}); // TODO: This isn't exhaustive we should actually search Album tracks or hit existing endpoint
                    } else {
                        songsByReleaseDateDetails[currYear] = [];
                            songsByReleaseDateDetails[currYear].push({id:albumTrack.id, name:albumTrack.name}); // TODO: This isn't exhaustive we should actually search Album tracks or hit existing endpoint
                    }
                }
            }); 
        }
            
        let songSummary = { duration: songsByDurationSumm, wordcount: songsByWordcountSumm, releasedate: songsByReleaseDateSumm }
        let songDetails = { duration: songsByDurationDetails, wordcount: songsByWordcountDetails, releasedate: songsByReleaseDateDetails }
        res.json({summary: songSummary, details: songDetails});
    } catch (error) {
        console.error('~~~~~Error during search: '+error);
        res.status(500).send('Error during search');
    }
});

app.post('/create-custom-table', async (req, res) => {
    try {
        const gridOutline = req.body;
        console.log(gridOutline);
        console.dir(gridOutline);
        const client = await pool.connect();
        let gridContents = gridOutline.content;
        let categoryContents = gridOutline.categories;
        let artists = Object.keys(gridContents);
        let categories = Object.keys(categoryContents);
        let gridTitle = gridOutline.gridTitle || 'Placeholder Title';
        
        // Get the next available ID for a custom grid here
        const nextIdQuery = 'SELECT custom_grid_id FROM custom_templates ORDER BY custom_grid_id DESC LIMIT 1';
        const latestGridId = await client.query(nextIdQuery);

        let customGridId = 1;
        if (latestGridId.rows.length > 0) {
            customGridId = parseInt(latestGridId.rows[0].custom_grid_id)+1;
        } 
        console.log("Assigning grid custom id "+customGridId);

        let categoryNum = 1;
        let artistNum = 1;
        let insertRows = [];
        artists.forEach(artistName => {
            let artistAnswers = gridContents[artistName];
            insertRows.push({custom_grid_id: customGridId, field_type: "Artist", field: "A"+artistNum, field_value: artistName, grid_title: gridTitle, owner_id: "shester"});
            artistNum++;
        });
        categories.forEach(categoryTag => {
            let categoryTitle = "";
            let categoryData = categoryContents[categoryTag];
            if(categoryTag == "wordCount") {
                categoryTitle = "Songs with "+categoryData+" word titles";
            } else if(categoryTag == "songLength") {
                categoryTitle = "Songs "+categoryData.type+" "+categoryData.durmin+" minutes long";
            } else if(categoryTag == "yearRange") {
                categoryTitle = "Songs released from "+categoryData+" to "+(parseInt(categoryData)+5);
            }
            insertRows.push({custom_grid_id: customGridId, field_type: "Category", field: "C"+categoryNum, field_value: categoryTitle, grid_title: gridTitle, owner_id: "shester"});
            categoryNum++;
        });
        let artistAnswerNum = 1;
        let categoryAnswerNum = 1;
        artists.forEach(artistName => {
            categories.forEach(categoryTag => {
                let artistAnswers = gridContents[artistName];
                let artCatAnswersArr = artistAnswers[categoryTag];
                let songAnswers = "";
                for (j =0; j<artCatAnswersArr.length; j++) {
                    songAnswerObj = artCatAnswersArr[j];
                    songName = songAnswerObj.name;
                    if(j==artCatAnswersArr.length-1) {
                        songAnswers+=`"${songName}"`;
                    } else {
                        songAnswers+=`"${songName}", `;
                    }
                }
                insertRows.push({custom_grid_id: customGridId, field_type: "Answer", field: "C"+categoryAnswerNum+" A"+artistAnswerNum, field_value: songAnswers, grid_title: gridTitle, owner_id: "shester"});
                categoryAnswerNum++;
            });
            artistAnswerNum++;
            categoryAnswerNum = 1;
        });

        for(var x=0;x<insertRows.length;x++) {
            insertRow = insertRows[x];
            const insertQuery = 'INSERT INTO custom_templates (custom_grid_id, field_type, field, field_value, grid_title, owner_id) VALUES ($1, $2, $3, $4, $5, $6)';
            await client.query(insertQuery, [insertRow.custom_grid_id, insertRow.field_type, insertRow.field, insertRow.field_value, insertRow.grid_title, insertRow.owner_id]);
        }

        client.release();
        res.json({customGridId: customGridId});
    } catch (err) {
        console.error('Error updating encoded answers:', err.message);
        res.status(500).send('Error storing custom table');
    }
});

app.post('/fetch-ai-gridname', async (req, res) => {
    const artistsJoined = String(req.body.artists || '');
    console.log("Generating AI title from ", artistsJoined);
    const title = await generateGridTitle(artistsJoined) || fallbackTitle(artistsJoined);
    // Same shape as before: the builder reads message.content
    res.json({ message: { content: title } });
});

app.post('/fetch-ai-weddingresponse', async (req, res) => {
  console.log('initializing wedding response');
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,  
  });

   const POLL_INTERVAL = 500; 
   
   async function waitForRunCompletion(runId, threadId) {
       let runStatus = 'queued';
       
       while (runStatus !== 'completed' && runStatus !== 'failed') {
           await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
   
           const run = await openai.beta.threads.runs.retrieve(threadId, runId );
           runStatus = run.status;
           
           console.log(`Run status: ${runStatus}`);
       }
   }

  async function createThread() {
    try {
      console.log('creating thread!!!');
      const thread = await openai.beta.threads.create();
      return thread;  
    } catch (error) {
      console.error('Error creating thread: ', error);
      throw error;  
    }
  }


  async function runThread(questAsked, threadId, wedding_assistant_id) {
    try {
       console.log('creating message with new question '+questAsked+' for assistant '+wedding_assistant_id);
      let mcr = await openai.beta.threads.messages.create(
      threadId,
      {
        role: 'user',
        content: questAsked,
      });
      
      console.log("msg create return below");
       // console.dir(mcr);
       
      console.log('creating run with wedding assistant');

      const run = await openai.beta.threads.runs.create(
        threadId,
      {
        assistant_id: wedding_assistant_id,
      });
       console.log('waiting for compleition of run id: '+run.id);
      await waitForRunCompletion(run.id, threadId);
      console.log("run return below");
       // console.dir(runr);

      console.log('pulling back messages and returning');
      const messages = await openai.beta.threads.messages.list(
         threadId,
      {
        order: 'desc',
      });

      return messages;
    } catch (error) {
      console.error('Error running thread: ', error);
      throw error;  
    }
  }


  const questAsked = req.body.question;
  const threadExistsBool = req.body.threadExists;
  let threadId = req.body.threadId;

  try {
     console.log('checking if thread already exists');
    if (!threadExistsBool) {
       console.log('it doesnt - making new one');
      const threadObj = await createThread();
      threadId = threadObj.id;
       console.log('new one created, id: '+threadId);
    }
    console.log('asking question to thread through runThread()');
    const responseMessages = await runThread(questAsked, threadId, 'asst_Y5rS18YInoTu350lp5G4r1uY');
    console.log('storing messages!');
    const allMsgObjs = responseMessages.data;
    let allMsgsTxt = [];
    console.log('created AllMsgObjs, empty array for AllMsgsTxt setup. AllMsgObjs len is: '+allMsgObjs.length);
    console.log('first MsgObj is:');
     console.dir(allMsgObjs[0]);
     let numobjs = 0;
    allMsgObjs.forEach((msgObj) => {
      console.log('Msgobj '+numobjs+' below:');
       numobjs+=1;
       console.dir(msgObj);
      let allContObjs = msgObj.content;
      console.log('creating allContObjs for first message obj, see output below');
      console.dir(allContObjs);
       // console.log('iterating through AllContObjs w/ len: '+allContObjs.length);
      allContObjs.forEach((contObj) => {
          console.log('Outputting next contObj below');
          console.dir(contObj);
          console.log('adding '+contObj.text.value+' to arr');
          allMsgsTxt.push(contObj.text.value);
      });
    });
    const latestResponse = allMsgsTxt[0];
    console.dir(responseMessages);
    console.dir(allMsgObjs);
    console.dir(allMsgsTxt);
    console.log(latestResponse);
    return res.json({ msg: latestResponse, threadId: threadId });
  } catch (error) {
     console.log(error);
    return res.status(500).json({ error: 'An error occurred while processing your request.' });
  }
});
