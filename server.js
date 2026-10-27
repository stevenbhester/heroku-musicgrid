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
            const loose = 'k:' + matchKey(song.name);
            if (!ranks.has(loose)) ranks.set(loose, page * SPOTIFY_PAGE_LIMIT + index);
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
// x-admin-key header. Without ADMIN_KEY set, admin endpoints refuse.
// ===================================================================
const ADMIN_KEY = process.env.ADMIN_KEY || '';

function requireAdmin(req, res, next) {
    if (!ADMIN_KEY) {
        return res.status(503).json({ error: 'Set ADMIN_KEY in the Heroku config vars to use the admin page' });
    }
    if (req.get('x-admin-key') === ADMIN_KEY) {
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

// Players are a hidden random id saved in their browser, never shown on a
// leaderboard. This moves one browser's scores (and answer flags) onto the
// id from another device, so both count as one player from then on.
// Body: { from_id, to_id } where from_id is this browser's current id.
app.post('/link-player', async (req, res) => {
    const fromId = validPlayerId(req.body.from_id);
    const toId = validPlayerId(req.body.to_id);
    if (!fromId || !toId) return res.status(400).json({ error: 'That player code doesn\'t look right' });
    if (!leaderboardSchemaReady) return res.status(503).json({ error: 'Try again in a moment' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let moved = 0;
        if (fromId !== toId) {
            moved = (await client.query('UPDATE leaderboard_playerscores SET player_id = $2 WHERE player_id = $1', [fromId, toId])).rowCount;
            if (editorSchemaReady) {
                // One flag per player per song per square: drop this browser's copy where both flagged it
                await client.query(`DELETE FROM answer_complaints a WHERE a.player_id = $1 AND EXISTS (
                    SELECT 1 FROM answer_complaints b WHERE b.player_id = $2 AND b.kind = a.kind AND b.grid_id = a.grid_id
                    AND b.field = a.field AND b.song_key = a.song_key)`, [fromId, toId]);
                await client.query('UPDATE answer_complaints SET player_id = $2 WHERE player_id = $1', [fromId, toId]);
            }
        }
        const { rows } = await client.query(`SELECT COUNT(DISTINCT owning_grid_id::text)::int AS grids FROM leaderboard_playerscores
            WHERE player_id = $1 AND board_type = 'daily'`, [toId]);
        await client.query('COMMIT');
        res.json({ moved, daily_grids: rows[0].grids });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error linking players: ', err.message);
        res.status(500).json({ error: 'Could not link this browser' });
    } finally {
        client.release();
    }
});

// ===================================================================
// Spotify sign-in access requests
// Since February 2026 a Development Mode Spotify app only works for a few
// accounts the developer adds by hand in the Spotify Developer Dashboard.
// Players ask for access here; the admin page lists the requests.
// ===================================================================
let accessSchemaReady = false;
const MAX_PENDING_ACCESS = 300;

async function ensureAccessSchema() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS spotify_access_requests (
            id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, email_key TEXT UNIQUE NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now(), decided_at TIMESTAMPTZ)`);
        accessSchemaReady = true;
    } catch (error) {
        console.error('Could not set up Spotify access requests: ', error.message);
    }
}
ensureAccessSchema();

// Body: { name, email, website } (website is a hidden field only bots fill in)
app.post('/spotify-access-request', async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    const email = String(req.body.email || '').trim().slice(0, 120);
    if (req.body.website) return res.json({ status: 'received' });
    if (!name) return res.status(400).json({ error: 'Add your name' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'That email doesn\'t look right' });
    if (!accessSchemaReady) return res.status(503).json({ error: 'Try again in a moment' });
    try {
        const pending = (await pool.query("SELECT COUNT(*)::int AS n FROM spotify_access_requests WHERE status = 'pending'")).rows[0].n;
        if (pending >= MAX_PENDING_ACCESS) return res.status(429).json({ error: 'Too many requests are waiting right now. Try again later.' });
        const { rows } = await pool.query(`INSERT INTO spotify_access_requests (name, email, email_key) VALUES ($1, $2, $3)
            ON CONFLICT (email_key) DO UPDATE SET name = EXCLUDED.name
            RETURNING status, (xmax = 0) AS fresh`, [name, email, email.toLowerCase()]);
        const row = rows[0];
        res.json({ status: row.status === 'added' ? 'added' : row.fresh ? 'received' : 'already' });
    } catch (err) {
        console.error('Error saving access request: ', err.message);
        res.status(500).json({ error: 'Could not send your request' });
    }
});

app.get('/admin/spotify-access-requests', requireAdmin, async (req, res) => {
    try {
        const all = req.query.status === 'all';
        const { rows } = await pool.query(`SELECT id, name, email, status, created_at, decided_at FROM spotify_access_requests
            ${all ? '' : "WHERE status = 'pending'"} ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 200`);
        res.json({ requests: rows });
    } catch (err) {
        console.error('Error loading access requests: ', err.message);
        res.status(500).json({ error: 'Error loading access requests' });
    }
});

// Body: { id, action: 'added' | 'delete' }
app.post('/admin/spotify-access-requests/decide', requireAdmin, async (req, res) => {
    const id = Number(req.body.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'id must be a number' });
    try {
        if (req.body.action === 'delete') {
            await pool.query('DELETE FROM spotify_access_requests WHERE id = $1', [id]);
        } else if (req.body.action === 'added') {
            await pool.query("UPDATE spotify_access_requests SET status = 'added', decided_at = now() WHERE id = $1", [id]);
        } else {
            return res.status(400).json({ error: 'action must be added or delete' });
        }
        res.json({ id, action: req.body.action });
    } catch (err) {
        console.error('Error updating access request: ', err.message);
        res.status(500).json({ error: 'Error updating access request' });
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

// ===================================================================
// Daily rotation
// A day with no grid scheduled replays an older daily grid instead of
// repeating yesterday's. The replay is a copy with its own grid id, so it
// gets a fresh leaderboard and counts as a new day for players. The first
// request after midnight (Central) makes the copy. Turn it off with
// ROTATE_DAILY=off.
// ===================================================================
const ROTATE_DAILY = process.env.ROTATE_DAILY !== 'off';
const RERUN_MIN_GAP_DAYS = Math.max(Number(process.env.RERUN_MIN_GAP_DAYS) || 30, 1);
// After a check, skip the database for a while (the answer only changes at midnight)
const ROTATION_RECHECK_MS = process.env.ROTATION_RECHECK_MS !== undefined ? Number(process.env.ROTATION_RECHECK_MS) : 10 * 60000;
let rotationSchemaReady = false;
let rotationCheckedFor = '';
let rotationCheckedAt = 0;

async function ensureRotationSchema() {
    try {
        await pool.query('ALTER TABLE musicgrid_templates ADD COLUMN IF NOT EXISTS rerun_of INTEGER');
        await pool.query(`CREATE TABLE IF NOT EXISTS artist_clips (
            name_key TEXT PRIMARY KEY, artist TEXT, has_clips BOOLEAN, source TEXT, checked_at TIMESTAMPTZ DEFAULT now())`);
        rotationSchemaReady = true;
        console.log('Rotation schema ready');
    } catch (error) {
        console.error('Could not set up daily rotation: ', error.message);
    }
}
ensureRotationSchema();

// Grids that already played, have answers for every square, and have no
// artist known to lack song clips. Picks the one that played longest ago,
// preferring ones that haven't played in RERUN_MIN_GAP_DAYS.
const RERUN_PICK_SQL = `WITH g AS (
        SELECT grid_id, COALESCE(MAX(rerun_of), grid_id) AS family, MAX(reporting_day) AS day,
            COUNT(DISTINCT field) FILTER (WHERE field_type = 'Artist') AS artists,
            COUNT(DISTINCT field) FILTER (WHERE field_type = 'Category') AS cats,
            ARRAY_AGG(DISTINCT lower(trim(field_value))) FILTER (WHERE field_type = 'Artist') AS artist_keys
        FROM musicgrid_templates GROUP BY grid_id
    ), answered AS (
        SELECT grid_id, COUNT(DISTINCT field) AS cells FROM musicgrid_answers GROUP BY grid_id
    ), fam AS (
        SELECT family, MAX(day) AS last_day FROM g GROUP BY family
    ), ready AS (
        SELECT DISTINCT ON (g.family) g.family, g.grid_id AS source, g.artist_keys
        FROM g JOIN answered a ON a.grid_id = g.grid_id
        WHERE g.artists > 0 AND g.cats > 0 AND a.cells >= g.artists * g.cats
        ORDER BY g.family, g.grid_id DESC
    )
    SELECT r.family, r.source, to_char(f.last_day, 'YYYY-MM-DD') AS last_day
    FROM ready r JOIN fam f ON f.family = r.family
    WHERE f.last_day < ${TODAY_SQL}
        AND NOT EXISTS (SELECT 1 FROM artist_clips c WHERE c.has_clips = FALSE AND c.name_key = ANY(r.artist_keys))
    ORDER BY (f.last_day <= ${TODAY_SQL} - $1::int) DESC, f.last_day ASC, RANDOM()
    LIMIT 1`;

async function ensureTodaysGrid() {
    if (!ROTATE_DAILY || !rotationSchemaReady) return null;
    const today = (await pool.query(`SELECT to_char(${TODAY_SQL}, 'YYYY-MM-DD') AS d`)).rows[0].d;
    if (rotationCheckedFor === today && Date.now() - rotationCheckedAt < ROTATION_RECHECK_MS) return null;
    const markChecked = () => { rotationCheckedFor = today; rotationCheckedAt = Date.now(); };
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(724001)');
        const scheduled = await client.query(`SELECT 1 FROM musicgrid_templates WHERE reporting_day = ${TODAY_SQL} LIMIT 1`);
        if (scheduled.rows.length) {
            await client.query('COMMIT');
            markChecked();
            return null;
        }
        const pick = await client.query(RERUN_PICK_SQL, [RERUN_MIN_GAP_DAYS]);
        if (!pick.rows.length) {
            await client.query('COMMIT');
            markChecked();
            return null;
        }
        const { family, source, last_day: lastDay } = pick.rows[0];
        await client.query('LOCK TABLE musicgrid_templates IN EXCLUSIVE MODE');
        const gridId = Number((await client.query('SELECT COALESCE(MAX(grid_id), 0) AS id FROM musicgrid_templates')).rows[0].id) + 1;
        await client.query(`INSERT INTO musicgrid_templates (grid_id, field_type, field, field_value, create_date, reporting_day, is_live, rerun_of)
            SELECT $1, field_type, field, field_value, ${TODAY_SQL}, ${TODAY_SQL}, FALSE, $2
            FROM musicgrid_templates WHERE grid_id = $3`, [gridId, family, source]);
        await client.query(`INSERT INTO musicgrid_answers (grid_id, field, song_name, popularity, normed_score, preview_url)
            SELECT $1, field, song_name, popularity, normed_score, preview_url FROM musicgrid_answers WHERE grid_id = $2`, [gridId, source]);
        await client.query('COMMIT');
        markChecked();
        console.log(`Nothing scheduled for ${today}: replaying grid ${family} (last played ${lastDay}) as grid ${gridId}`);
        return gridId;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Daily rotation failed, the last grid repeats today: ', error.message);
        return null;
    } finally {
        client.release();
    }
}

// The first day each rerun family played, for "Rerun of the Oct 3 grid"
async function firstDays(gridIds) {
    if (!rotationSchemaReady || !gridIds.length) return new Map();
    const { rows } = await pool.query(`WITH asked AS (
            SELECT grid_id, MAX(rerun_of) AS family FROM musicgrid_templates
            WHERE grid_id::text = ANY($1) GROUP BY grid_id HAVING MAX(rerun_of) IS NOT NULL
        )
        SELECT a.grid_id, to_char(MIN(t.reporting_day), 'YYYY-MM-DD') AS first_day
        FROM asked a JOIN musicgrid_templates t ON (t.grid_id = a.family OR t.rerun_of = a.family)
        GROUP BY a.grid_id`, [gridIds.map(String)]);
    return new Map(rows.map(row => [String(row.grid_id), row.first_day]));
}

// Which grid plays on each day: the one with the latest reporting_day on
// or before that day. With rotation on, an empty future day gets a rerun
// picked at midnight (rerun: true).
app.get('/grid-calendar', async (req, res) => {
    try {
        await ensureTodaysGrid();
        const days = Math.min(Math.max(Number(req.query.days) || 21, 1), 90);
        const isAdmin = !ADMIN_KEY || req.get('x-admin-key') === ADMIN_KEY;
        const today = (await pool.query(`SELECT to_char(${TODAY_SQL}, 'YYYY-MM-DD') AS today`)).rows[0].today;
        const rerunCol = rotationSchemaReady ? 'MAX(rerun_of)' : 'NULL::int';
        const { rows } = await pool.query(`SELECT grid_id, to_char(MAX(reporting_day), 'YYYY-MM-DD') AS day, bool_or(is_live) AS live,
                MAX(CASE WHEN field_type = 'Title' THEN field_value END) AS title,
                STRING_AGG(DISTINCT CASE WHEN field_type = 'Artist' THEN field_value END, ', ') AS artists,
                ${rerunCol} AS rerun_of
            FROM musicgrid_templates WHERE reporting_day IS NOT NULL GROUP BY grid_id`);
        const calendar = [];
        const start = new Date(today + 'T00:00:00Z');
        for (let i = 0; i < days; i++) {
            const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
            const candidates = rows.filter(row => row.day <= date)
                .sort((a, b) => (b.day.localeCompare(a.day)) || ((b.live ? 1 : 0) - (a.live ? 1 : 0)) || (Number(b.grid_id) - Number(a.grid_id)));
            const scheduled = Boolean(candidates[0] && candidates[0].day === date);
            const pending = !scheduled && date > today && ROTATE_DAILY && rotationSchemaReady;
            const pick = pending ? null : candidates[0];
            // Upcoming artists and titles are spoilers, so only the admin page sees them
            const entry = { date, scheduled, rerun: pending || Boolean(scheduled && pick.rerun_of) };
            if (isAdmin) {
                entry.grid_id = pick ? pick.grid_id : null;
                entry.artists = pick ? pick.artists : null;
                entry.title = pick ? pick.title : null;
                entry.rerun_of = pick ? pick.rerun_of : null;
            }
            calendar.push(entry);
        }
        res.json({ today, timezone: GRID_TIMEZONE, rotation: ROTATE_DAILY && rotationSchemaReady, calendar });
    } catch (err) {
        console.error('Error building grid calendar: ', err.message);
        res.status(500).send('Error building grid calendar');
    }
});

// ===================================================================
// Create daily grids from the admin page (paste or upload JSON)
// Body: { grids: [{ date, title?, artists: [3], categories: [3],
//                   answers: { [category]: { [artist]: [songs] } } }] }
// ===================================================================
function validateGridInput(grid, index) {
    const where = `Grid ${index + 1}`;
    if (!grid || typeof grid !== 'object') return `${where} isn't an object`;
    if (!validDay(grid.date)) return `${where}: date must look like 2026-11-03`;
    if (grid.title !== undefined && (typeof grid.title !== 'string' || grid.title.length > 60)) return `${where}: title must be text under 60 characters`;
    for (const key of ['artists', 'categories']) {
        const list = grid[key];
        if (!Array.isArray(list) || list.length !== 3 || list.some(item => typeof item !== 'string' || !item.trim() || item.length > 120)) {
            return `${where}: ${key} must be a list of 3 names`;
        }
        if (new Set(list.map(item => item.trim().toLowerCase())).size !== 3) return `${where}: ${key} has a duplicate`;
    }
    if (!grid.answers || typeof grid.answers !== 'object') return `${where}: answers are missing`;
    for (const category of grid.categories) {
        for (const artist of grid.artists) {
            const songs = grid.answers[category] && grid.answers[category][artist];
            if (!Array.isArray(songs) || !songs.length) return `${where}: no answers for ${artist} / ${category}`;
            const bad = songs.find(song => typeof song !== 'string' || !song.trim() || song.includes('"') || song.length > 150);
            if (bad !== undefined) return `${where}: answer ${JSON.stringify(bad)} for ${artist} / ${category} can't be empty or contain double quotes`;
        }
    }
    return null;
}

app.post('/admin/create-grids', requireAdmin, async (req, res) => {
    const grids = Array.isArray(req.body) ? req.body : req.body.grids;
    if (!Array.isArray(grids) || !grids.length || grids.length > 31) {
        return res.status(400).json({ error: 'Send { "grids": [...] } with 1 to 31 grids' });
    }
    for (let i = 0; i < grids.length; i++) {
        const problem = validateGridInput(grids[i], i);
        if (problem) return res.status(400).json({ error: problem });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE musicgrid_templates IN EXCLUSIVE MODE');
        let nextId = Number((await client.query('SELECT COALESCE(MAX(grid_id), 0) AS id FROM musicgrid_templates')).rows[0].id) + 1;
        const created = [];
        const moved = [];
        const today = (await client.query(`SELECT to_char(${TODAY_SQL}, 'YYYY-MM-DD') AS d`)).rows[0].d;
        const uploadDays = new Set(grids.map(grid => grid.date));
        const dayTaken = async day => uploadDays.has(day)
            || (await client.query('SELECT 1 FROM musicgrid_templates WHERE reporting_day = $1::date LIMIT 1', [day])).rows.length > 0;
        // A new grid for a future day that already has one bumps the old
        // grid to the next open day, so nothing scheduled gets lost.
        for (const day of [...uploadDays].sort()) {
            if (day <= today) continue;
            const existing = await client.query(`SELECT grid_id, MAX(CASE WHEN field_type = 'Title' THEN field_value END) AS title
                FROM musicgrid_templates GROUP BY grid_id HAVING MAX(reporting_day) = $1::date ORDER BY grid_id`, [day]);
            for (const row of existing.rows) {
                let next = new Date(day + 'T00:00:00Z');
                let nextDay;
                do {
                    next = new Date(next.getTime() + 86400000);
                    nextDay = next.toISOString().slice(0, 10);
                } while (await dayTaken(nextDay));
                await client.query('UPDATE musicgrid_templates SET reporting_day = $2::date WHERE grid_id = $1', [row.grid_id, nextDay]);
                moved.push({ grid_id: row.grid_id, title: row.title, from: day, to: nextDay });
            }
        }
        for (const grid of grids) {
            const gridId = nextId++;
            const rows = [];
            if (grid.title && grid.title.trim()) rows.push(['Title', 'T1', grid.title.trim()]);
            grid.artists.forEach((artist, a) => rows.push(['Artist', `A${a + 1}`, artist.trim()]));
            grid.categories.forEach((category, c) => {
                rows.push(['Category', `C${c + 1}`, category.trim()]);
                const kind = grid.kinds && grid.kinds[category];
                if (['ai', 'opinion'].includes(kind)) rows.push(['CategoryKind', `C${c + 1}`, kind]);
            });
            grid.categories.forEach((category, c) => {
                grid.artists.forEach((artist, a) => {
                    const songs = [...new Set(grid.answers[category][artist].map(song => song.trim()))];
                    // Same format as custom grids and the admin encoder: "Song", "Song"
                    rows.push(['Answer', `C${c + 1} A${a + 1}`, songs.map(song => `"${song}"`).join(', ')]);
                });
            });
            for (const [fieldType, field, value] of rows) {
                await client.query(`INSERT INTO musicgrid_templates (grid_id, field_type, field, field_value, create_date, reporting_day, is_live)
                    VALUES ($1, $2, $3, $4, ${TODAY_SQL}, $5::date, FALSE)`, [gridId, fieldType, field, value, grid.date]);
            }
            created.push({ grid_id: gridId, date: grid.date, title: grid.title || null });
        }
        await client.query('COMMIT');
        // score: true scores answers here instead of in the browser. A big
        // upload can take longer than Heroku waits, so after SLOW_REPLY_MS
        // the reply says "pending" and scoring finishes in the background.
        let scored = false;
        if (req.body.score) {
            const scoring = (async () => {
                for (const grid of created) await scoreGrid('daily', grid.grid_id);
                return true;
            })().catch(error => {
                console.error('Scoring new grids failed: ', error.message);
                return false;
            });
            scored = await Promise.race([scoring, sleep(SLOW_REPLY_MS).then(() => 'pending')]);
        }
        res.json({ created, moved, scored });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error creating grids: ', err.message);
        res.status(500).json({ error: 'Error creating grids: ' + err.message });
    } finally {
        client.release();
    }
});

// ===================================================================
// Difficulty for the Browse cards
// Blends what players actually scored with an estimate from the answer
// lists (a square that accepts only one or two songs is hard). The more
// players a grid has, the more their scores count.
// ===================================================================
const DIFFICULTY_LABELS = ['Easy', 'Medium', 'Hard', 'Expert'];

// Rough chance a typical player fills a square that accepts n songs
function squareChance(n) {
    if (n <= 0) return 0;
    if (n === 1) return 0.35;
    if (n === 2) return 0.5;
    if (n <= 4) return 0.62;
    if (n <= 8) return 0.74;
    if (n <= 15) return 0.84;
    return 0.9;
}

function rateDifficulty(counts, squares, scores) {
    const players = scores ? Number(scores.players) || 0 : 0;
    if (!counts.length && !players) return null; // nothing to go on
    const all = counts.slice(0, squares);
    while (all.length < squares) all.push(0);
    const estimate = 1 + all.reduce((sum, n) => sum + squareChance(n), 0) * 8.5;
    const weight = Math.min(players, 8) / 8;
    const score = players ? weight * Number(scores.median) + (1 - weight) * estimate : estimate;
    const level = score >= 60 ? 1 : score >= 45 ? 2 : score >= 30 ? 3 : 4;
    return { level, label: DIFFICULTY_LABELS[level - 1], basis: players >= 3 ? 'scores' : 'answers', players };
}

// { [id]: difficulty } for a page of Browse grids
async function difficultyFor(kind, grids) {
    const ids = grids.map(grid => String(kind === 'daily' ? grid.grid_id : grid.custom_grid_id));
    if (!ids.length) return {};
    const answers = kind === 'daily'
        ? await pool.query(`SELECT grid_id::text AS id, field, COUNT(*) AS n FROM musicgrid_answers
            WHERE grid_id::text = ANY($1) GROUP BY 1, 2`, [ids])
        : await pool.query(`SELECT custom_grid_id::text AS id, field, COUNT(*) AS n FROM custom_answers
            WHERE custom_grid_id::text = ANY($1) GROUP BY 1, 2`, [ids]);
    const counts = {};
    answers.rows.forEach(row => { (counts[row.id] = counts[row.id] || []).push(Number(row.n)); });

    const who = leaderboardSchemaReady ? PLAYER_KEY : 'lower(trim(player_name))';
    let scoreSql;
    if (kind === 'custom') {
        scoreSql = `WITH best AS (
                SELECT a.id, ${who} AS who, MAX(l.player_score) AS s
                FROM unnest($1::text[]) AS a(id)
                JOIN leaderboard_playerscores l ON l.owning_grid_id::text = a.id || '100'
                ${leaderboardSchemaReady ? "AND l.board_type = 'custom'" : ''}
                GROUP BY 1, 2)
            SELECT id, COUNT(*) AS players, percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS median FROM best GROUP BY id`;
    } else {
        // Reruns share scores with the original: it's the same puzzle
        const family = rotationSchemaReady ? 'COALESCE(MAX(rerun_of), grid_id)' : 'grid_id';
        scoreSql = `WITH fams AS (
                SELECT grid_id::text AS id, ${family} AS fam FROM musicgrid_templates GROUP BY grid_id
            ), members AS (
                SELECT a.id AS asked, m.id AS member FROM fams a JOIN fams m ON m.fam = a.fam WHERE a.id = ANY($1)
            ), best AS (
                SELECT m.asked AS id, ${who} AS who, MAX(l.player_score) AS s
                FROM members m JOIN leaderboard_playerscores l ON l.owning_grid_id::text = m.member
                ${leaderboardSchemaReady ? "AND l.board_type = 'daily'" : ''}
                GROUP BY 1, 2)
            SELECT id, COUNT(*) AS players, percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS median FROM best GROUP BY id`;
    }
    const scores = {};
    (await pool.query(scoreSql, [ids])).rows.forEach(row => { scores[row.id] = row; });

    const out = {};
    grids.forEach((grid, i) => {
        const squares = Math.max(1, (Number(grid.artist_count) || 3) * (Number(grid.category_count) || 3));
        out[ids[i]] = rateDifficulty(counts[ids[i]] || [], squares, scores[ids[i]]);
    });
    return out;
}

// ===================================================================
// Browse: past daily grids and player-made grids
// ===================================================================
function playersSql(idExpression, board) {
    if (leaderboardSchemaReady) {
        return `(SELECT COUNT(DISTINCT COALESCE(l.player_id, lower(trim(l.player_name)))) FROM leaderboard_playerscores l
            WHERE l.owning_grid_id::text = ${idExpression} AND l.board_type = '${board}')`;
    }
    return `(SELECT COUNT(DISTINCT lower(trim(l.player_name))) FROM leaderboard_playerscores l WHERE l.owning_grid_id::text = ${idExpression})`;
}

function pageParams(req) {
    const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 60);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    return { limit, offset };
}

// Daily grids that have already played, newest first (one per day).
app.get('/grids/daily', async (req, res) => {
    try {
        await ensureTodaysGrid();
        const { limit, offset } = pageParams(req);
        const { rows } = await pool.query(`WITH grids AS (
                SELECT grid_id, MAX(reporting_day) AS day, bool_or(is_live) AS live,
                    MAX(CASE WHEN field_type = 'Title' THEN field_value END) AS title,
                    ARRAY_AGG(field_value ORDER BY field) FILTER (WHERE field_type = 'Artist') AS artists,
                    ARRAY_AGG(field_value ORDER BY field) FILTER (WHERE field_type = 'Category') AS categories
                FROM musicgrid_templates GROUP BY grid_id
                HAVING MAX(reporting_day) <= ${TODAY_SQL}
            ), played AS (
                SELECT DISTINCT ON (day) * FROM grids ORDER BY day DESC, live DESC, grid_id DESC
            )
            SELECT grid_id, to_char(day, 'YYYY-MM-DD') AS day, title, artists, categories,
                ${playersSql('played.grid_id::text', 'daily')} AS players
            FROM played ORDER BY day DESC LIMIT $1 OFFSET $2`, [limit + 1, offset]);
        const page = rows.slice(0, limit).map(row => ({
            ...row,
            artist_count: (row.artists || []).length,
            category_count: (row.categories || []).length
        }));
        const [difficulty, rerunDays] = await Promise.all([
            difficultyFor('daily', page).catch(error => { console.error('Difficulty failed: ', error.message); return {}; }),
            firstDays(page.map(row => row.grid_id)).catch(() => new Map())
        ]);
        res.json({
            grids: page.map(({ artist_count: _a, category_count: _c, ...row }) => {
                const firstDay = rerunDays.get(String(row.grid_id));
                return {
                    ...row,
                    players: Number(row.players),
                    difficulty: difficulty[String(row.grid_id)] || null,
                    rerun_of_day: firstDay && firstDay !== row.day ? firstDay : null
                };
            }),
            hasMore: rows.length > limit
        });
    } catch (err) {
        console.error('Error listing daily grids: ', err.message);
        res.status(500).send('Error listing daily grids');
    }
});

// Player-made grids that finished building, newest first.
// ?ids=4,9,12 looks up just those grids (the stats page uses it for titles).
app.get('/grids/custom', async (req, res) => {
    try {
        const { limit, offset } = pageParams(req);
        const ids = String(req.query.ids || '').split(',').map(id => id.trim())
            .filter(id => /^\d{1,12}$/.test(id)).slice(0, 100);
        const params = [limit + 1, offset];
        if (ids.length) params.push(ids);
        const { rows } = await pool.query(`WITH grids AS (
                SELECT c.custom_grid_id, MAX(c.grid_title) AS title,
                    ARRAY_AGG(c.field_value ORDER BY c.field) FILTER (WHERE c.field_type = 'Artist') AS artists,
                    COUNT(DISTINCT c.field) FILTER (WHERE c.field_type = 'Category') AS category_count
                FROM custom_templates c
                WHERE EXISTS (SELECT 1 FROM custom_answers a WHERE a.custom_grid_id::text = c.custom_grid_id::text)
                    ${ids.length ? 'AND c.custom_grid_id::text = ANY($3)' : ''}
                GROUP BY c.custom_grid_id
            )
            SELECT custom_grid_id, title, artists, category_count,
                ${playersSql("(grids.custom_grid_id::text || '100')", 'custom')} AS players
            FROM grids ORDER BY custom_grid_id DESC LIMIT $1 OFFSET $2`, params);
        const page = rows.slice(0, limit).map(row => ({ ...row, artist_count: (row.artists || []).length }));
        const difficulty = await difficultyFor('custom', page)
            .catch(error => { console.error('Difficulty failed: ', error.message); return {}; });
        res.json({
            grids: page.map(({ artist_count: _a, category_count: _c, ...row }) => ({
                ...row,
                difficulty: difficulty[String(row.custom_grid_id)] || null,
                // Grids built while the title model was broken get their artists as a title
                title: !row.title || BROKEN_TITLES.includes(row.title) ? fallbackTitle((row.artists || []).join(', ')) : row.title,
                players: Number(row.players)
            })),
            hasMore: rows.length > limit
        });
    } catch (err) {
        console.error('Error listing custom grids: ', err.message);
        res.status(500).send('Error listing custom grids');
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

// ===================================================================
// Category engine
// Reads an artist's catalog from Spotify once (albums and singles, then
// every track), then checks it against every category. Three kinds:
//   spotify  - checked from Spotify data, always right
//   ai       - facts an AI checks (charts, awards...), usually right
//   opinion  - judgment calls an AI makes (breakup songs...)
// The AI only sorts the artist's real songs, so it can't invent titles.
// Used by the grid builder and the admin page's daily grid maker.
// ===================================================================
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const catalogCache = new Map();
const MIN_CATEGORY_SONGS = 2;
const SKIP_RELEASE = /\b(live (at|from|in|on)|\(live\)|- live\b|unplugged|remix(es)?|instrumentals?|karaoke|a ?cappella|commentary|sped up|slowed)\b/i;
const SKIP_TRACK = /\b(live (at|from|in|on)|\(live\)|- live\b|remix|instrumental|karaoke|a ?cappella|commentary|sped up|slowed|interlude|intro|outro|skit|voice memo)\b/i;

// The plain song name players will recognize: no "- 2011 Remaster" or "(feat. X)"
function cleanSongName(name) {
    return String(name || '')
        .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|re-?recorded|single version|radio edit|album version|mono|stereo|bonus track|edit)\b.*$/i, '')
        .replace(/\s*[([](feat\.?|ft\.?|with|featuring|from)\s[^)\]]*[)\]]/gi, '')
        .replace(/\s*[([][^)\]]*remaster[^)\]]*[)\]]/gi, '')
        .replace(/"/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

async function artistCatalog(artistId, artistName) {
    const cacheKey = String(artistId);
    const cached = catalogCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.catalog;

    const releases = [];
    let total = 1;
    for (let offset = 0; offset < Math.min(total, MAX_ARTIST_ALBUMS); offset += SPOTIFY_PAGE_LIMIT) {
        const page = await spotifyGet(`https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}/albums?include_groups=album,single&market=US&limit=${SPOTIFY_PAGE_LIMIT}&offset=${offset}`);
        total = page.total || 0;
        releases.push(...(page.items || []));
        if (!page.items || page.items.length < SPOTIFY_PAGE_LIMIT) break;
    }
    const kept = releases.filter(release => release && release.name && !SKIP_RELEASE.test(release.name));
    const albums = kept.filter(release => (release.album_type || 'album') === 'album')
        .sort((a, b) => String(a.release_date).localeCompare(String(b.release_date)));
    const debutId = albums.length ? albums[0].id : null;
    const latestId = albums.length ? albums[albums.length - 1].id : null;

    const songs = new Map();
    for (const release of kept) {
        const data = await spotifyGet(`https://api.spotify.com/v1/albums/${encodeURIComponent(release.id)}/tracks?market=US&limit=50`);
        const tracks = (data.items || []).filter(track => track && track.name && !SKIP_TRACK.test(track.name));
        const type = release.album_type || 'album';
        const year = Number(String(release.release_date || '').slice(0, 4)) || null;
        const totalTracks = release.total_tracks || tracks.length;
        for (const track of tracks) {
            const theirs = (track.artists || []).some(artist => artist.id === artistId || sameArtist(artist.name, artistName));
            if (!theirs) continue;
            const name = cleanSongName(track.name);
            const key = matchKey(name);
            if (!key) continue;
            let song = songs.get(key);
            if (!song) {
                song = { name, raw: track.name, key, year, durationMs: track.duration_ms || 0, explicit: false, features: false, single: false,
                    opener: false, closer: false, titleTrack: false, debut: false, latest: false, soundtrack: false, selfTitled: false, albums: [] };
                songs.set(key, song);
            }
            if (year && (!song.year || year < song.year)) song.year = year;
            if (type === 'album' && song.albums.length === 0) song.durationMs = track.duration_ms || song.durationMs;
            song.explicit = song.explicit || Boolean(track.explicit);
            song.features = song.features || (track.artists || []).length > 1;
            song.single = song.single || type === 'single';
            if (type === 'album') {
                song.albums.push(release.name);
                if (totalTracks >= 4 && track.track_number === 1 && (track.disc_number || 1) === 1) song.opener = true;
                if (totalTracks >= 4 && track.track_number === totalTracks) song.closer = true;
                if (matchKey(release.name) === key) song.titleTrack = true;
                if (release.id === debutId) song.debut = true;
                if (release.id === latestId) song.latest = true;
                if (matchKey(release.name) === matchKey(artistName)) song.selfTitled = true;
            }
            if (/soundtrack|motion picture|original score|music from (the )?(film|movie|series)|\bost\b/i.test(release.name)) song.soundtrack = true;
        }
    }
    const catalog = {
        artistId: cacheKey,
        artist: artistName,
        releases: kept.length,
        albums: albums.length,
        songs: [...songs.values()]
    };
    if (catalogCache.size > 200) catalogCache.delete(catalogCache.keys().next().value);
    catalogCache.set(cacheKey, { at: Date.now(), catalog });
    return catalog;
}

const titleWords = song => cleanSongName(song.name).replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(word => /[a-z0-9]/i.test(word));
const titleHas = (song, pattern) => pattern.test(cleanSongName(song.name));

const SPOTIFY_CATEGORIES = [
    { id: 'debut', label: 'Song from their debut album', test: song => song.debut },
    { id: 'latest', label: 'Song from their latest album', test: song => song.latest },
    { id: 'title-track', label: 'Title track of an album', test: song => song.titleTrack },
    { id: 'opener', label: 'Opening track of an album', test: song => song.opener },
    { id: 'closer', label: 'Closing track of an album', test: song => song.closer },
    { id: 'single', label: 'Released as a single', test: song => song.single },
    { id: 'features', label: 'Features another artist', test: song => song.features },
    { id: 'explicit', label: 'Explicit song', test: song => song.explicit },
    { id: 'self-titled', label: 'From a self-titled album', test: song => song.selfTitled },
    { id: 'soundtrack', label: 'From a soundtrack', test: song => song.soundtrack },
    { id: 'long', label: 'Over 5 minutes long', test: song => song.durationMs > 300000 },
    { id: 'short', label: 'Under 2 minutes 30 seconds', test: song => song.durationMs > 0 && song.durationMs < 150000 },
    { id: 'one-word', label: 'One-word title', test: song => titleWords(song).length === 1 },
    { id: 'long-title', label: 'Title of 5 or more words', test: song => titleWords(song).length >= 5 },
    { id: 'number', label: 'Title with a number', test: song => titleHas(song, /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|hundred|thousand|million|first|second|third)\b/i) },
    { id: 'question', label: 'Title is a question', test: song => /\?\s*$/.test(song.raw.replace(/\s*[([][^)\]]*[)\]]\s*$/, '')) || /\?$/.test(song.name) },
    { id: 'color', label: 'Title with a color', test: song => titleHas(song, /\b(red|orange|yellow|green|blue|purple|violet|pink|black|white|gold(en)?|silver|gr[ae]y|brown|scarlet|crimson|lavender)\b/i) },
    { id: 'love', label: 'Title with the word Love', test: song => titleHas(song, /\blov(e|er|ers|ing|ed|es)\b/i) },
    { id: 'body', label: 'Title with a body part', test: song => titleHas(song, /\b(heart|hearts|eyes?|hands?|head|lips|face|skin|bones?|teeth|mouth|arms?|feet|foot|hair|knees?|shoulders?|fingers?|legs?|neck|chest|tongue|brain|blood|heartbeat)\b/i) },
    { id: 'time', label: 'Title with a time of day', test: song => titleHas(song, /\b(morning|night|nights|midnight|tonight|evening|afternoon|sunrise|sunset|dawn|dusk|noon|daylight|\d{1,2} ?(am|pm|a\.m\.|p\.m\.))\b/i) },
    { id: 'weather', label: 'Title with weather', test: song => titleHas(song, /\b(rain|raining|rainy|sun|sunny|sunshine|snow|storm|stormy|thunder|lightning|wind|windy|cloud|clouds|cloudy|hurricane|fog|rainbow|weather|heatwave|tornado)\b/i) },
    { id: 'holiday', label: 'Holiday song', test: song => titleHas(song, /\b(christmas|xmas|santa|holiday|jingle|mistletoe|sleigh|reindeer|noel|hanukkah|new year)\b/i) || song.albums.some(name => /christmas|holiday/i.test(name)) }
];

const AI_CATEGORIES = [
    { id: 'ai-top10', kind: 'ai', label: 'Top 10 hit on the Hot 100', rule: 'peaked in the top 10 of the US Billboard Hot 100 (as lead or featured artist)' },
    { id: 'ai-no1', kind: 'ai', label: 'Hit #1 on the Hot 100', rule: 'reached number 1 on the US Billboard Hot 100' },
    { id: 'ai-grammy', kind: 'ai', label: 'Grammy-nominated song', rule: 'the song itself (not just its album) was nominated for or won a Grammy Award' },
    { id: 'ai-screen', kind: 'ai', label: 'Heard in a movie or TV show', rule: 'was written for, or prominently used in, a well-known film or TV series' },
    { id: 'ai-cover', kind: 'ai', label: "Cover of another artist's song", rule: 'is a cover of a song first released by a different artist' },
    { id: 'ai-place', kind: 'ai', label: 'Mentions a real place', rule: 'the title or lyrics name a real city, state, country or landmark' },
    { id: 'ai-name', kind: 'ai', label: "Title has a person's name", rule: "the title is or contains a person's first name (real or fictional)" },
    { id: 'ai-tiktok', kind: 'ai', label: 'Went viral on TikTok', rule: 'had a widely reported viral moment on TikTok' }
];

const OPINION_CATEGORIES = [
    { id: 'op-breakup', kind: 'opinion', label: 'Breakup song', rule: 'is about a breakup or the end of a relationship' },
    { id: 'op-love', kind: 'opinion', label: 'Love song', rule: 'is a romantic love song' },
    { id: 'op-party', kind: 'opinion', label: 'Party anthem', rule: 'is an upbeat song made for parties or dancing' },
    { id: 'op-sad', kind: 'opinion', label: 'Sad song', rule: 'is one of their saddest, most heartbreaking songs' },
    { id: 'op-drive', kind: 'opinion', label: 'Road trip song', rule: 'is about driving, cars or the open road, or is a classic sing-in-the-car song' },
    { id: 'op-confidence', kind: 'opinion', label: 'Confidence anthem', rule: 'is an empowering, confident or self-love anthem' },
    { id: 'op-nostalgia', kind: 'opinion', label: 'Nostalgic song', rule: 'is about memories, growing up or looking back' },
    { id: 'op-revenge', kind: 'opinion', label: 'Revenge or kiss-off song', rule: 'is a revenge, diss or kiss-off song aimed at someone' }
];

function decadeCategories(songs) {
    const decades = [...new Set(songs.map(song => song.year).filter(Boolean).map(year => Math.floor(year / 10) * 10))].sort();
    return decades.map(decade => ({ id: `decade-${decade}`, label: `Released in the ${decade}s`, test: song => song.year >= decade && song.year < decade + 10 }));
}

function categoryInfo(category, kind) {
    return { id: category.id, label: category.label, kind: category.kind || kind };
}

// Songs most people know come first, so lists read well and the AI sees hits
async function rankSongs(catalog) {
    let ranks = new Map();
    try {
        ranks = await artistTrackRanks(catalog.artist);
    } catch (error) {
        console.error('Could not rank songs: ', error.message);
    }
    const rankOf = song => {
        const rank = ranks.get(normalizeTitle(song.name));
        return rank === undefined ? 1000 : rank;
    };
    return [...catalog.songs].sort((a, b) => rankOf(a) - rankOf(b) || a.name.localeCompare(b.name));
}

function spotifyCategoryResults(catalog, ranked) {
    const results = {};
    [...SPOTIFY_CATEGORIES, ...decadeCategories(catalog.songs)].forEach(category => {
        results[category.id] = { ...categoryInfo(category, 'spotify'), songs: ranked.filter(category.test).map(song => song.name) };
    });
    return results;
}

// Generic JSON chat call, reusing the title models and their fallbacks
async function chatJSON(prompt, timeout = 60000) {
    if (!OPENAI_SECRET) throw new Error('OPENAI_API_KEY is not set');
    const models = workingTitleModel
        ? [workingTitleModel, ...TITLE_MODELS.filter(model => model !== workingTitleModel)]
        : TITLE_MODELS;
    let lastError = null;
    for (const model of models) {
        for (const jsonMode of [true, false]) {
            try {
                const body = { model, messages: [{ role: 'user', content: prompt }] };
                if (jsonMode) body.response_format = { type: 'json_object' };
                const response = await axios.post('https://api.openai.com/v1/chat/completions', body, {
                    headers: { 'Authorization': `Bearer ${OPENAI_SECRET}`, 'Content-Type': 'application/json' },
                    timeout
                });
                const text = String(response.data.choices[0].message.content || '');
                const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
                workingTitleModel = model;
                return json;
            } catch (error) {
                lastError = error;
                const status = error.response ? error.response.status : null;
                if (status === 401) throw error;
                if (status === 400 && jsonMode) continue; // model may not support JSON mode: try plain
                break;
            }
        }
    }
    throw lastError || new Error('No AI model answered');
}

const aiCache = new Map();

async function aiCategoryResults(catalog, ranked, kinds) {
    const wanted = [...(kinds.includes('ai') ? AI_CATEGORIES : []), ...(kinds.includes('opinion') ? OPINION_CATEGORIES : [])];
    if (!wanted.length || !ranked.length) return {};
    const cacheKey = `${catalog.artistId}|${wanted.map(category => category.id).join(',')}`;
    const cached = aiCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.results;

    const list = ranked.slice(0, 350);
    const prompt = `You are sorting songs for a music trivia game. Artist: ${catalog.artist}.
For each category below, list the songs from the SONG LIST that fit its rule. Copy titles exactly as they appear in the list, and never add songs that aren't in it. For factual categories only include songs you are confident about. For opinion categories pick the songs most fans would agree with. An empty list is fine.
Reply with JSON only, shaped like {"category-id": ["Title", "Title"]}.

CATEGORIES
${wanted.map(category => `${category.id}: ${category.rule}`).join('\n')}

SONG LIST
${list.map(song => song.name).join('\n')}`;
    const json = await chatJSON(prompt);
    const byKey = new Map(list.map(song => [song.key, song.name]));
    const results = {};
    wanted.forEach(category => {
        const picked = Array.isArray(json[category.id]) ? json[category.id] : [];
        const songs = [...new Set(picked.map(title => byKey.get(matchKey(title))).filter(Boolean))].slice(0, 30);
        results[category.id] = { ...categoryInfo(category), songs };
    });
    if (aiCache.size > 300) aiCache.delete(aiCache.keys().next().value);
    aiCache.set(cacheKey, { at: Date.now(), results });
    return results;
}

// ---------- Slow requests ----------
// Heroku drops any request that takes 30 seconds to answer, even though the
// work keeps running. Work that can take that long (reading a whole catalog,
// asking the AI, finding clips, scoring) runs as a job: if it isn't done
// after SLOW_REPLY_MS the reply is 202 { pending: true } and the work keeps
// going. Sending the same request again joins the same job and gets the
// result once it's ready.
const SLOW_REPLY_MS = Number(process.env.SLOW_REPLY_MS) || 20000;
const SLOW_JOB_KEEP_MS = 10 * 60000;
const slowJobs = new Map();

function slowJob(key, work) {
    const now = Date.now();
    for (const [oldKey, old] of slowJobs) {
        if (old.done && now - old.doneAt > SLOW_JOB_KEEP_MS) slowJobs.delete(oldKey);
    }
    let job = slowJobs.get(key);
    if (!job) {
        job = { done: false, doneAt: 0, result: null, error: null };
        job.promise = Promise.resolve().then(work)
            .then(result => { job.result = result; }, error => { job.error = error; })
            .finally(() => { job.done = true; job.doneAt = Date.now(); });
        slowJobs.set(key, job);
    }
    return job;
}

// Waits a while for the job, then answers with send(job), or 202 if it needs
// longer. A failed job is forgotten once reported, so asking again retries
// it. once: true also forgets a finished job (for results that go stale).
async function replyFromJob(res, key, job, send, { once = false } = {}) {
    if (!job.done) await Promise.race([job.promise, sleep(SLOW_REPLY_MS)]);
    if (!job.done) return res.status(202).json({ pending: true, retry_ms: 1000 });
    if ((job.error || once) && slowJobs.get(key) === job) slowJobs.delete(key);
    return send(job);
}

function bodyKey(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value === undefined ? null : value)).digest('hex').slice(0, 24);
}

// Every category the builder can offer, for labels and grouping
app.get('/categories', (req, res) => {
    res.json({
        min_songs: MIN_CATEGORY_SONGS,
        categories: [
            ...SPOTIFY_CATEGORIES.map(category => categoryInfo(category, 'spotify')),
            { id: 'decade-*', label: 'Released in a decade', kind: 'spotify' },
            ...AI_CATEGORIES.map(category => categoryInfo(category)),
            ...OPINION_CATEGORIES.map(category => categoryInfo(category))
        ]
    });
});

// Body: { artistId, artistName, kinds: ['spotify'] | ['ai', 'opinion'] }
// Returns { artist, songs, categories: { id: { id, label, kind, songs: [...] } } },
// or 202 { pending: true } while it's still working (send the same body again)
app.post('/artist-categories', async (req, res) => {
    const artistId = String(req.body.artistId || '').trim();
    const artistName = String(req.body.artistName || '').trim().slice(0, 120);
    const kinds = (Array.isArray(req.body.kinds) ? req.body.kinds : ['spotify']).filter(kind => ['spotify', 'ai', 'opinion'].includes(kind));
    if (!/^[A-Za-z0-9]{1,40}$/.test(artistId) || !artistName) {
        return res.status(400).json({ error: 'Send artistId and artistName' });
    }
    const key = `artist-categories|${artistId}|${artistName.toLowerCase()}|${[...kinds].sort().join(',')}`;
    const job = slowJob(key, async () => {
        const catalog = await artistCatalog(artistId, artistName);
        const ranked = await rankSongs(catalog);
        const out = { artist: artistName, artistId, songs: catalog.songs.length, releases: catalog.releases, categories: {} };
        if (kinds.includes('spotify')) Object.assign(out.categories, spotifyCategoryResults(catalog, ranked));
        const aiKinds = kinds.filter(kind => kind !== 'spotify');
        if (aiKinds.length) {
            try {
                Object.assign(out.categories, await aiCategoryResults(catalog, ranked, aiKinds));
            } catch (error) {
                console.error('AI categories failed: ', error.response ? JSON.stringify(error.response.data).slice(0, 300) : error.message);
                out.aiError = 'AI categories are unavailable right now';
            }
        }
        return out;
    });
    try {
        await replyFromJob(res, key, job, ({ result, error }) => {
            if (!error) return res.json(result);
            console.error('Error checking artist categories: ', error.message);
            res.status(error.response && error.response.status === 404 ? 404 : 500).json({ error: 'Could not read this artist from Spotify' });
        });
    } catch (error) {
        console.error('Error checking artist categories: ', error.message);
        if (!res.headersSent) res.status(500).json({ error: 'Could not read this artist from Spotify' });
    }
});

// ===================================================================
// Scoring and answer editing
// Deeper cuts score more: each square's songs get 6 to 11 points from
// their rank among the artist's top Spotify results (the same scale the
// old encoder used). Answers live twice: a raw "Answer" row in the
// templates table ("Song", "Song") and scored rows in the answers table.
// ===================================================================
const crypto = require('crypto');
let editorSchemaReady = false;

async function ensureEditorSchema() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS custom_grid_editors (
            custom_grid_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`);
        await pool.query(`CREATE TABLE IF NOT EXISTS answer_complaints (
            id SERIAL PRIMARY KEY, kind TEXT NOT NULL, grid_id TEXT NOT NULL, field TEXT NOT NULL,
            song TEXT NOT NULL, song_key TEXT NOT NULL, player_id TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT now(), status TEXT NOT NULL DEFAULT 'pending', decided_at TIMESTAMPTZ,
            UNIQUE (kind, grid_id, field, song_key, player_id))`);
        await pool.query('CREATE INDEX IF NOT EXISTS answer_complaints_grid_idx ON answer_complaints (kind, grid_id)');
        editorSchemaReady = true;
        console.log('Editor and complaints schema ready');
    } catch (error) {
        console.error('Could not set up answer editing tables: ', error.message);
    }
}
ensureEditorSchema();

const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const isAdminRequest = req => Boolean(ADMIN_KEY) && req.get('x-admin-key') === ADMIN_KEY;

async function canEdit(req, kind, gridId) {
    if (isAdminRequest(req)) return true;
    if (kind !== 'custom' || !editorSchemaReady) return false;
    const token = String(req.body.token || '');
    if (!/^[a-f0-9]{32,64}$/.test(token)) return false;
    const { rows } = await pool.query('SELECT 1 FROM custom_grid_editors WHERE custom_grid_id = $1 AND token_hash = $2', [String(gridId), hashToken(token)]);
    return rows.length > 0;
}

function parseRawAnswers(text) {
    return (String(text || '').match(/"[^"]*"/g) || []).map(item => item.slice(1, -1)).filter(Boolean);
}

function cleanAnswerList(songs) {
    const seen = new Set();
    const out = [];
    (Array.isArray(songs) ? songs : []).forEach(song => {
        const name = String(song || '').replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, 150);
        const key = matchKey(name) || name.toLowerCase();
        if (!name || seen.has(key)) return;
        seen.add(key);
        out.push(name);
    });
    return out.slice(0, 80);
}

async function scoreSongs(artistName, songs) {
    let ranks = new Map();
    try {
        ranks = await artistTrackRanks(artistName);
    } catch (error) {
        console.error('Could not rank songs for scoring: ', error.message);
    }
    const pops = songs.map(song => {
        let rank = ranks.get(normalizeTitle(song));
        if (rank === undefined) rank = ranks.get('k:' + matchKey(song));
        return rank === undefined ? 1 : Math.max(1, 100 - rank);
    });
    const min = Math.min(...pops);
    const max = Math.max(...pops);
    return songs.map((song, i) => ({
        song,
        popularity: pops[i],
        normed: min === max ? 11 : 6 + 5 * Math.round(10 * (1 - ((pops[i] - min) / (max - min)))) / 10
    }));
}

// Every daily grid that's the same puzzle (the original and its reruns)
async function familyIds(gridId) {
    if (!rotationSchemaReady) return [String(gridId)];
    const fam = await pool.query(`WITH me AS (SELECT COALESCE(MAX(rerun_of), grid_id) AS fam FROM musicgrid_templates WHERE grid_id::text = $1 GROUP BY grid_id)
        SELECT DISTINCT t.grid_id::text AS id FROM musicgrid_templates t, me WHERE t.grid_id = me.fam OR t.rerun_of = me.fam`, [String(gridId)]);
    return fam.rows.length ? fam.rows.map(row => row.id) : [String(gridId)];
}

async function gridNames(kind, gridId) {
    const src = HINT_SOURCES[kind];
    const { rows } = await pool.query(`SELECT field_type, field, field_value FROM ${src.templates}
        WHERE ${src.templateId}::text = $1::text AND field_type IN ('Artist', 'Category', 'Answer', 'CategoryKind')`, [String(gridId)]);
    const out = { artists: {}, categories: {}, answers: {}, kinds: {} };
    rows.forEach(row => {
        if (row.field_type === 'Artist') out.artists[row.field] = row.field_value;
        if (row.field_type === 'Category') out.categories[row.field] = row.field_value;
        if (row.field_type === 'Answer') out.answers[row.field] = parseRawAnswers(row.field_value);
        if (row.field_type === 'CategoryKind') out.kinds[row.field] = row.field_value;
    });
    return out;
}

// Replace one square's answers (raw list + scored rows) on these grids
async function writeSquare(kind, gridIds, field, songs, artistName) {
    const src = HINT_SOURCES[kind];
    const list = cleanAnswerList(songs);
    const scored = list.length ? await scoreSongs(artistName, list) : [];
    const raw = list.map(song => `"${song}"`).join(', ');
    for (const gridId of gridIds) {
        const saved = await pool.query(`SELECT song_name, preview_url FROM ${src.answers} WHERE ${src.answerId}::text = $1 AND field = $2`, [gridId, field]);
        const clips = new Map(saved.rows.filter(row => row.preview_url).map(row => [row.song_name, row.preview_url]));
        await pool.query(`DELETE FROM ${src.answers} WHERE ${src.answerId}::text = $1 AND field = $2`, [gridId, field]);
        for (const item of scored) {
            await pool.query(`INSERT INTO ${src.answers} (${src.answerId}, field, song_name, popularity, normed_score, preview_url)
                VALUES ($1, $2, $3, $4, $5, $6)`, [kind === 'daily' ? Number(gridId) : gridId, field, item.song, item.popularity, item.normed, clips.get(item.song) || '']);
        }
        const updated = await pool.query(`UPDATE ${src.templates} SET field_value = $3
            WHERE ${src.templateId}::text = $1 AND field_type = 'Answer' AND field = $2`, [gridId, field, raw]);
        if (!updated.rowCount) {
            if (kind === 'daily') {
                await pool.query(`INSERT INTO musicgrid_templates (grid_id, field_type, field, field_value, create_date, reporting_day, is_live${rotationSchemaReady ? ', rerun_of' : ''})
                    SELECT grid_id, 'Answer', $2, $3, create_date, reporting_day, FALSE${rotationSchemaReady ? ', rerun_of' : ''}
                    FROM musicgrid_templates WHERE grid_id::text = $1 LIMIT 1`, [gridId, field, raw]);
            } else {
                await pool.query(`INSERT INTO custom_templates (custom_grid_id, field_type, field, field_value, grid_title, owner_id)
                    SELECT custom_grid_id, 'Answer', $2, $3, grid_title, owner_id FROM custom_templates WHERE custom_grid_id::text = $1 LIMIT 1`, [gridId, field, raw]);
            }
        }
    }
    return list;
}

// Score every square from the raw answer lists (new grids)
async function scoreGrid(kind, gridId) {
    const names = await gridNames(kind, gridId);
    for (const [field, songs] of Object.entries(names.answers)) {
        const artist = names.artists[field.split(' ')[1]];
        if (artist) await writeSquare(kind, [String(gridId)], field, songs, artist);
    }
}

// Pending complaints that now match an accepted answer are approved
async function settleComplaints(kind, gridIds) {
    if (!editorSchemaReady) return;
    const src = HINT_SOURCES[kind];
    await pool.query(`UPDATE answer_complaints c SET status = 'approved', decided_at = now()
        WHERE c.kind = $1 AND c.grid_id = ANY($2) AND c.status = 'pending' AND EXISTS (
            SELECT 1 FROM ${src.answers} a WHERE a.${src.answerId}::text = c.grid_id AND a.field = c.field
            AND ${SQL_TITLE_KEY('a.song_name')} = ${SQL_TITLE_KEY('c.song')})`, [kind, gridIds]);
}

// ---------- Player-made grids built from the category picker ----------
// Body: { artists: [{ id, name }] x3, categories: [{ id, label, kind }] x3,
//         answers: { [categoryId]: { [artistName]: [songs] } } }
// Returns { custom_grid_id, title, edit_token }. The edit token lets the
// creator change answers later; only its hash is stored. Send a request_id:
// sending the same one again (after a 202 or a dropped connection) returns
// the same grid instead of making a second one.
const TITLE_WAIT_MS = Number(process.env.TITLE_WAIT_MS) || 12000;

app.post('/custom-grids', async (req, res) => {
    const artists = Array.isArray(req.body.artists) ? req.body.artists : [];
    const categories = Array.isArray(req.body.categories) ? req.body.categories : [];
    const answers = req.body.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    const nameOk = text => typeof text === 'string' && text.trim() && text.length <= 120 && !text.includes('"');
    if (artists.length !== 3 || categories.length !== 3 || !artists.every(a => a && nameOk(a.name)) || !categories.every(c => c && nameOk(c.label))) {
        return res.status(400).json({ error: 'Send 3 artists and 3 categories' });
    }
    for (const category of categories) {
        for (const artist of artists) {
            const songs = cleanAnswerList(answers[category.id] && answers[category.id][artist.name]);
            if (songs.length < 1) return res.status(400).json({ error: `No answers for ${artist.name} / ${category.label}` });
        }
    }
    const requestId = /^[A-Za-z0-9-]{8,64}$/.test(String(req.body.request_id || '')) ? req.body.request_id : crypto.randomUUID();
    const key = `custom-grids|${requestId}`;
    const job = slowJob(key, () => saveCustomGrid(artists, categories, answers));
    try {
        await replyFromJob(res, key, job, ({ result, error }) => {
            if (!error) return res.json(result);
            console.error('Error creating custom grid: ', error.message);
            res.status(500).json({ error: 'Could not save the grid' });
        });
    } catch (error) {
        console.error('Error creating custom grid: ', error.message);
        if (!res.headersSent) res.status(500).json({ error: 'Could not save the grid' });
    }
});

async function saveCustomGrid(artists, categories, answers) {
    const artistsJoined = artists.map(a => a.name.trim()).join(', ');
    // A slow title isn't worth a slow save: fall back to the artist names
    const aiTitle = await Promise.race([generateGridTitle(artistsJoined).catch(() => null), sleep(TITLE_WAIT_MS).then(() => null)]);
    const title = aiTitle || fallbackTitle(artistsJoined);
    const token = crypto.randomBytes(24).toString('hex');
    const client = await pool.connect();
    let gridId;
    try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE custom_templates IN EXCLUSIVE MODE');
        gridId = Number((await client.query('SELECT COALESCE(MAX(custom_grid_id), 0) AS id FROM custom_templates')).rows[0].id) + 1;
        const rows = [];
        artists.forEach((artist, a) => rows.push(['Artist', `A${a + 1}`, artist.name.trim()]));
        categories.forEach((category, c) => {
            rows.push(['Category', `C${c + 1}`, category.label.trim()]);
            if (['ai', 'opinion'].includes(category.kind)) rows.push(['CategoryKind', `C${c + 1}`, category.kind]);
        });
        categories.forEach((category, c) => artists.forEach((artist, a) => {
            const songs = cleanAnswerList(answers[category.id][artist.name]);
            rows.push(['Answer', `C${c + 1} A${a + 1}`, songs.map(song => `"${song}"`).join(', ')]);
        }));
        for (const [type, field, value] of rows) {
            await client.query('INSERT INTO custom_templates (custom_grid_id, field_type, field, field_value, grid_title, owner_id) VALUES ($1, $2, $3, $4, $5, $6)',
                [gridId, type, field, value, title, 'builder']);
        }
        if (editorSchemaReady) {
            // Ids are max + 1, so a deleted grid's id can come back: clear anything left from it
            await client.query("DELETE FROM answer_complaints WHERE kind = 'custom' AND grid_id = $1", [String(gridId)]);
            await client.query(`INSERT INTO custom_grid_editors (custom_grid_id, token_hash) VALUES ($1, $2)
                ON CONFLICT (custom_grid_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now()`, [String(gridId), hashToken(token)]);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
    try {
        await scoreGrid('custom', gridId);
    } catch (err) {
        console.error('Error scoring custom grid: ', err.message);
    }
    return { custom_grid_id: gridId, title, edit_token: editorSchemaReady ? token : null };
}

// Body: { kind, grid_id, token?, clips? }. Admin key, or the creator's edit
// token for a player-made grid. clips: true also finds (and saves) a hint
// clip for every square.
async function gridAnswersHandler(req, res) {
    try {
        const kind = req.body.kind === 'custom' ? 'custom' : 'daily';
        const gridId = String(req.body.grid_id || '').trim();
        if (!/^\d{1,12}$/.test(gridId)) return res.status(400).json({ error: 'grid_id must be a number' });
        if (!(await canEdit(req, kind, gridId))) return res.status(401).json({ error: 'Not allowed to edit this grid' });
        const withClips = req.body.clips !== false && isAdminRequest(req);
        if (!withClips) return res.json(await loadGridAnswers(kind, gridId, false));
        // Finding clips can take a while (iTunes, then Deezer, per square)
        const key = `grid-answers|${kind}|${gridId}`;
        const job = slowJob(key, () => loadGridAnswers(kind, gridId, true));
        await replyFromJob(res, key, job, ({ result, error }) => {
            if (!error) return res.json(result);
            console.error('Error loading grid answers: ', error.message);
            res.status(500).json({ error: 'Error loading grid answers' });
        }, { once: true });
    } catch (err) {
        console.error('Error loading grid answers: ', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Error loading grid answers' });
    }
}

async function loadGridAnswers(kind, gridId, withClips) {
    const src = HINT_SOURCES[kind];
    const names = await gridNames(kind, gridId);
    const { rows } = await pool.query(`SELECT field, song_name, normed_score FROM ${src.answers}
        WHERE ${src.answerId}::text = $1::text ORDER BY field, normed_score ASC, song_name`, [gridId]);
    const fields = [...new Set([...rows.map(row => row.field), ...Object.keys(names.answers)])].sort();
    const squares = [];
    for (const field of fields) {
        const [category, artist] = field.split(' ');
        const square = {
            field,
            category: names.categories[category] || category,
            kind: names.kinds[category] || 'spotify',
            artist: names.artists[artist] || artist,
            answers: rows.filter(row => row.field === field).map(row => ({ song: row.song_name, points: Number(row.normed_score) }))
        };
        if (withClips) {
            const tried = [];
            const clip = await hintClip(kind, gridId, field, false, tried).catch(() => null);
            square.clip = clip ? { url: clip.url, source: clip.source } : null;
            square.tried = tried;
        }
        squares.push(square);
    }
    let complaints = [];
    if (editorSchemaReady) {
        complaints = (await pool.query(`SELECT field, mode() WITHIN GROUP (ORDER BY song) AS song, song_key, COUNT(*)::int AS players
            FROM answer_complaints WHERE kind = $1 AND grid_id = $2 AND status = 'pending'
            GROUP BY field, song_key ORDER BY players DESC LIMIT 50`, [kind, gridId])).rows;
    }
    return { kind, grid_id: gridId, squares, complaints };
}
app.post('/admin/grid-answers', gridAnswersHandler);
app.post('/grid-answers', gridAnswersHandler);

// Body: { kind, grid_id, token?, cells: { "C1 A2": ["Song", ...] } }
// Rewrites those squares and re-scores them. Daily grids change across the
// original and its reruns.
app.post('/grid-answers/save', async (req, res) => {
    try {
        const kind = req.body.kind === 'custom' ? 'custom' : 'daily';
        const gridId = String(req.body.grid_id || '').trim();
        const cells = req.body.cells && typeof req.body.cells === 'object' ? req.body.cells : {};
        if (!/^\d{1,12}$/.test(gridId)) return res.status(400).json({ error: 'grid_id must be a number' });
        if (!(await canEdit(req, kind, gridId))) return res.status(401).json({ error: 'Not allowed to edit this grid' });
        const names = await gridNames(kind, gridId);
        const changes = [];
        for (const [field, songs] of Object.entries(cells).slice(0, 25)) {
            if (!/^C\d+ A\d+$/.test(field)) continue;
            const artist = names.artists[field.split(' ')[1]];
            if (!artist) continue;
            const list = cleanAnswerList(songs);
            if (!list.length) return res.status(400).json({ error: `Every square needs at least one answer (${field})` });
            changes.push({ field, list, artist });
        }
        // Scoring looks songs up on Spotify, so a big save can run long
        const key = `save|${kind}|${gridId}|${bodyKey(changes)}`;
        const job = slowJob(key, async () => {
            const ids = kind === 'daily' ? await familyIds(gridId) : [gridId];
            const saved = {};
            for (const { field, list, artist } of changes) saved[field] = await writeSquare(kind, ids, field, list, artist);
            await settleComplaints(kind, ids);
            return { saved, grids: ids };
        });
        await replyFromJob(res, key, job, ({ result, error }) => {
            if (!error) return res.json(result);
            console.error('Error saving answers: ', error.message);
            res.status(500).json({ error: 'Error saving answers' });
        }, { once: true });
    } catch (err) {
        console.error('Error saving answers: ', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Error saving answers' });
    }
});

// ---------- "I think it fits": players dispute rejected guesses ----------
async function gridIsPlayable(kind, gridId) {
    if (kind === 'daily') {
        const { rows } = await pool.query(`SELECT 1 FROM musicgrid_templates WHERE grid_id::text = $1 GROUP BY grid_id HAVING MAX(reporting_day) <= ${TODAY_SQL}`, [gridId]);
        return rows.length > 0;
    }
    const { rows } = await pool.query('SELECT 1 FROM custom_templates WHERE custom_grid_id::text = $1 LIMIT 1', [gridId]);
    return rows.length > 0;
}

// Body: { kind, grid_id, field, song, player_id }
app.post('/complaints', async (req, res) => {
    try {
        if (!editorSchemaReady) return res.status(503).json({ error: 'Not ready yet' });
        const kind = req.body.kind === 'custom' ? 'custom' : 'daily';
        const gridId = String(req.body.grid_id || '').trim();
        const field = String(req.body.field || '');
        const song = String(req.body.song || '').replace(/\s+/g, ' ').trim().slice(0, 150);
        const playerId = validPlayerId(req.body.player_id);
        const key = matchKey(song);
        if (!/^\d{1,12}$/.test(gridId) || !/^C\d+ A\d+$/.test(field) || !key || !playerId) {
            return res.status(400).json({ error: 'Send kind, grid_id, field, song and player_id' });
        }
        if (!(await gridIsPlayable(kind, gridId))) return res.status(404).json({ error: 'No such grid' });
        const src = HINT_SOURCES[kind];
        const accepted = await pool.query(`SELECT 1 FROM ${src.answers} WHERE ${src.answerId}::text = $1 AND field = $2
            AND ${SQL_TITLE_KEY('song_name')} = ${SQL_TITLE_KEY('$3')} LIMIT 1`, [gridId, field, song]);
        if (accepted.rows.length) return res.json({ status: 'approved', players: 0 });
        // A group already decided keeps its verdict for late arrivals
        const decided = await pool.query(`SELECT status FROM answer_complaints WHERE kind = $1 AND grid_id = $2 AND field = $3 AND song_key = $4
            AND status <> 'pending' LIMIT 1`, [kind, gridId, field, key]);
        const status = decided.rows.length ? decided.rows[0].status : 'pending';
        await pool.query(`INSERT INTO answer_complaints (kind, grid_id, field, song, song_key, player_id, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`, [kind, gridId, field, song, key, playerId, status]);
        const count = await pool.query(`SELECT COUNT(*)::int AS players FROM answer_complaints WHERE kind = $1 AND grid_id = $2 AND field = $3 AND song_key = $4`,
            [kind, gridId, field, key]);
        res.json({ status, players: count.rows[0].players });
    } catch (err) {
        console.error('Error saving complaint: ', err.message);
        res.status(500).json({ error: 'Error saving complaint' });
    }
});

const COMPLAINT_STATUS_SQL = `CASE WHEN bool_or(status = 'approved') THEN 'approved' WHEN bool_or(status = 'rejected') THEN 'rejected' ELSE 'pending' END`;

// The most-flagged songs for one grid, with verdicts (shown after finishing)
app.get('/complaints', async (req, res) => {
    try {
        if (!editorSchemaReady) return res.json({ complaints: [] });
        const kind = req.query.kind === 'custom' ? 'custom' : 'daily';
        const gridId = String(req.query.grid_id || '').trim();
        if (!/^\d{1,12}$/.test(gridId)) return res.status(400).json({ error: 'grid_id must be a number' });
        const { rows } = await pool.query(`SELECT field, mode() WITHIN GROUP (ORDER BY song) AS song, song_key,
                COUNT(*)::int AS players, ${COMPLAINT_STATUS_SQL} AS status
            FROM answer_complaints WHERE kind = $1 AND grid_id = $2
            GROUP BY field, song_key ORDER BY players DESC, MIN(created_at) LIMIT 20`, [kind, gridId]);
        res.json({ complaints: rows });
    } catch (err) {
        console.error('Error listing complaints: ', err.message);
        res.status(500).json({ error: 'Error listing complaints' });
    }
});

// Review queue for the admin page. ?status=pending (default) or all
app.get('/admin/complaints', requireAdmin, async (req, res) => {
    try {
        if (!editorSchemaReady) return res.json({ complaints: [] });
        const all = req.query.status === 'all';
        const { rows } = await pool.query(`SELECT kind, grid_id, field, song_key, mode() WITHIN GROUP (ORDER BY song) AS song,
                COUNT(*)::int AS players, ${COMPLAINT_STATUS_SQL} AS status,
                to_char(MIN(created_at), 'YYYY-MM-DD') AS first_day, to_char(MAX(created_at), 'YYYY-MM-DD') AS last_day
            FROM answer_complaints GROUP BY kind, grid_id, field, song_key
            ${all ? '' : `HAVING ${COMPLAINT_STATUS_SQL} = 'pending'`}
            ORDER BY players DESC, MAX(created_at) DESC LIMIT 200`);
        const labels = new Map();
        for (const row of rows) {
            const id = `${row.kind}:${row.grid_id}`;
            if (!labels.has(id)) labels.set(id, await gridNames(row.kind, row.grid_id));
            const names = labels.get(id);
            const [category, artist] = row.field.split(' ');
            row.artist = names.artists[artist] || artist;
            row.category = names.categories[category] || category;
            row.answers = names.answers[row.field] || [];
        }
        res.json({ complaints: rows });
    } catch (err) {
        console.error('Error listing complaints for review: ', err.message);
        res.status(500).json({ error: 'Error listing complaints' });
    }
});

// Body: { kind, grid_id, field, song_key, decision: 'approve' | 'reject' }
// Approving adds the song as an answer (and re-scores that square).
app.post('/admin/complaints/decide', requireAdmin, async (req, res) => {
    try {
        const kind = req.body.kind === 'custom' ? 'custom' : 'daily';
        const gridId = String(req.body.grid_id || '').trim();
        const field = String(req.body.field || '');
        const songKey = String(req.body.song_key || '');
        const decision = req.body.decision === 'approve' ? 'approved' : req.body.decision === 'reject' ? 'rejected' : null;
        if (!decision || !/^\d{1,12}$/.test(gridId) || !/^C\d+ A\d+$/.test(field) || !songKey) {
            return res.status(400).json({ error: 'Send kind, grid_id, field, song_key and decision' });
        }
        const group = await pool.query(`SELECT mode() WITHIN GROUP (ORDER BY song) AS song FROM answer_complaints
            WHERE kind = $1 AND grid_id = $2 AND field = $3 AND song_key = $4`, [kind, gridId, field, songKey]);
        const song = group.rows[0] && group.rows[0].song;
        if (!song) return res.status(404).json({ error: 'No such complaint' });
        let added = null;
        if (decision === 'approved') {
            const names = await gridNames(kind, gridId);
            const artist = names.artists[field.split(' ')[1]];
            const current = (await pool.query(`SELECT song_name FROM ${HINT_SOURCES[kind].answers} WHERE ${HINT_SOURCES[kind].answerId}::text = $1 AND field = $2`, [gridId, field]))
                .rows.map(row => row.song_name);
            const base = names.answers[field] && names.answers[field].length ? names.answers[field] : current;
            const ids = kind === 'daily' ? await familyIds(gridId) : [gridId];
            if (artist) {
                const list = await writeSquare(kind, ids, field, [...base, cleanSongName(song) || song], artist);
                added = list.includes(cleanSongName(song) || song) ? (cleanSongName(song) || song) : null;
            }
        }
        await pool.query(`UPDATE answer_complaints SET status = $5, decided_at = now()
            WHERE kind = $1 AND grid_id = $2 AND field = $3 AND song_key = $4`, [kind, gridId, field, songKey, decision]);
        res.json({ status: decision, song, added });
    } catch (err) {
        console.error('Error deciding complaint: ', err.message);
        res.status(500).json({ error: 'Error deciding complaint' });
    }
});

// The admin page's password screen checks the key here
app.post('/admin/verify', requireAdmin, (req, res) => res.json({ ok: true }));

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
        let row;
        if (req.query.grid_id !== undefined) {
            // A specific past grid from the archive. Future grids stay hidden.
            const past = await pool.query(`SELECT grid_id, to_char(MAX(reporting_day), 'YYYY-MM-DD') AS reporting_day
                FROM musicgrid_templates WHERE grid_id::text = $1::text
                GROUP BY grid_id HAVING MAX(reporting_day) <= ${TODAY_SQL}`, [String(req.query.grid_id)]);
            if (!past.rows.length) {
                return res.status(404).json({ error: 'That grid is not available' });
            }
            row = past.rows[0];
        } else {
            await ensureTodaysGrid();
            const result = await pool.query(query);
            if (!result.rows.length) {
                return res.status(404).json({ error: 'No grid is scheduled yet' });
            }
            row = result.rows[0];
        }
        const firstDay = (await firstDays([row.grid_id]).catch(() => new Map())).get(String(row.grid_id));
        const body = { latestGridId: row.grid_id, reportingDay: row.reporting_day };
        if (firstDay && firstDay !== row.reporting_day) body.rerunOf = firstDay;
        res.json(body);
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
        // Scheduled grids stay secret until their day, except for the admin page.
        if (ADMIN_KEY && req.get('x-admin-key') !== ADMIN_KEY) {
            const future = await pool.query(`SELECT 1 FROM musicgrid_templates WHERE grid_id = $1 GROUP BY grid_id HAVING MAX(reporting_day) > ${TODAY_SQL}`, [grid_id]);
            if (future.rows.length) {
                return res.status(404).send('Grid not available yet');
            }
        }
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
app.get('/fetch-grid-summary', requireAdmin, async (req, res) => {
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
// Same loose title match the hint finder uses: ignore case, punctuation,
// spacing and bracketed or " - " tails, so "Self-Care" accepts "Self Care"
const SQL_TITLE_KEY = col => `regexp_replace(regexp_replace(regexp_replace(lower(${col}), '\\s*[\\(\\[][^\\)\\]]*[\\)\\]]', '', 'g'), '\\s+-\\s+.*$', ''), '[^a-z0-9]+', '', 'g')`;
const ANSWER_MATCH_SQL = `(song_name = $1 OR song_name ILIKE $4 OR position(lower(song_name) in lower($1)) > 0
    OR (${SQL_TITLE_KEY('song_name')} <> '' AND ${SQL_TITLE_KEY('song_name')} = ${SQL_TITLE_KEY('$1')}))`;

app.post('/check-answer', async (req, res) => {
    try {
        const { songGuess, fieldGuessed, gridId } = req.body;
        const songGuessIlike = `%${songGuess}%`
        const query = `SELECT normed_score AS guessScore, 0 AS rn FROM musicgrid_answers WHERE grid_id = $3 AND field = $2 AND ${ANSWER_MATCH_SQL} UNION ALL SELECT 0 AS guess_score, 10 as rn ORDER BY 2 ASC, 1 DESC LIMIT 1`;
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
        const query = `SELECT normed_score AS guessScore, 0 AS rn FROM custom_answers WHERE custom_grid_id = $3 AND field = $2 AND ${ANSWER_MATCH_SQL} UNION ALL SELECT 0 AS guess_score, 10 as rn ORDER BY 2 ASC, 1 DESC LIMIT 1`;
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
    let client;
    try {
        const { encodedAnswers } = req.body;
        client = await pool.connect();

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
    let client;
    try {
        const { encodedAnswers } = req.body;
        client = await pool.connect();

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

// ===================================================================
// Song clips for easy mode
// Spotify stopped sending 30-second previews to development-mode apps
// (developer.spotify.com/blog/2024-11-27-changes-to-the-web-api), so grids
// built since then saved empty preview URLs and hints stopped working.
// Clips now come from the iTunes Search API (no key, stable URLs), with
// Deezer as a backup. Clips found on iTunes are saved back onto the answer
// so the next hint for that square is instant.
// ===================================================================
const CLIP_TIMEOUT_MS = 6000;
const CLIP_TTL_MS = { itunes: 7 * 86400000, deezer: 10 * 60000, miss: 30 * 60000 };
const clipCache = new Map();

// Loose title/artist key: no accents, brackets, " - Remastered" tails or punctuation
function matchKey(text) {
    return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
        .replace(/\s+-\s+.*$/, '')
        .replace(/\s(feat|ft)\.?\s.*$/, '')
        .replace(/&/g, ' and ')
        .trim()
        .replace(/^the\s+/, '')
        .replace(/[^a-z0-9]/g, '');
}

function sameArtist(found, wanted) {
    const a = matchKey(found);
    const b = matchKey(wanted);
    if (!a || !b) return false;
    if (a === b) return true;
    return b.length >= 3 && a.includes(b); // "Queen & David Bowie" counts for Queen
}

function asJson(data) {
    if (typeof data !== 'string') return data || {};
    try { return JSON.parse(data); } catch (error) { return {}; }
}

function pickClip(items, song, artist) {
    const want = matchKey(song);
    if (!want) return null;
    const usable = items.filter(item => item.url && sameArtist(item.artist, artist));
    const hit = usable.find(item => matchKey(item.title) === want)
        || usable.find(item => {
            const key = matchKey(item.title);
            return key.length >= 4 && (key.startsWith(want) || want.startsWith(key));
        });
    return hit ? String(hit.url).replace(/^http:/, 'https:') : null;
}

async function itunesSongs(term, extra) {
    const params = new URLSearchParams({ term: term.slice(0, 200), country: 'US', media: 'music', entity: 'song', limit: '25', ...extra });
    const { data } = await axios.get(`https://itunes.apple.com/search?${params}`, { timeout: CLIP_TIMEOUT_MS });
    const results = asJson(data).results;
    return (Array.isArray(results) ? results : [])
        .map(r => ({ title: r.trackName, artist: r.artistName, url: r.previewUrl }));
}

async function deezerSongs(query) {
    const params = new URLSearchParams({ q: query, limit: '25' });
    const { data } = await axios.get(`https://api.deezer.com/search?${params}`, { timeout: CLIP_TIMEOUT_MS });
    const items = asJson(data).data;
    return (Array.isArray(items) ? items : [])
        .map(t => ({ title: t.title, artist: t.artist && t.artist.name, url: t.preview }));
}

// { url, source } for one song, or null if neither service has a clip.
// avoid: a URL the player's browser couldn't play, so look past it.
async function findSongClip(song, artist, avoid) {
    const key = `${matchKey(artist)}|${matchKey(song)}`;
    const cached = clipCache.get(key);
    if (!avoid && cached && Date.now() - cached.at < CLIP_TTL_MS[cached.source || 'miss']) return cached.url ? cached : null;
    let found = null;
    try {
        const url = pickClip(await itunesSongs(`${artist} ${song}`), song, artist);
        if (url && url !== avoid) found = { url, source: 'itunes' };
    } catch (error) {
        console.error('iTunes clip lookup failed: ', error.message);
    }
    if (!found) {
        try {
            const url = pickClip(await deezerSongs(`artist:"${artist}" track:"${song}"`), song, artist);
            if (url) found = { url, source: 'deezer' };
        } catch (error) {
            console.error('Deezer clip lookup failed: ', error.message);
        }
    }
    clipCache.set(key, found ? { ...found, at: Date.now() } : { url: null, source: null, at: Date.now() });
    return found;
}

const HINT_SOURCES = {
    daily: { answers: 'musicgrid_answers', answerId: 'grid_id', templates: 'musicgrid_templates', templateId: 'grid_id' },
    custom: { answers: 'custom_answers', answerId: 'custom_grid_id', templates: 'custom_templates', templateId: 'custom_grid_id' }
};

// A clip of a song that fits the square, most popular answers first.
// fresh=true skips saved URLs (the player's browser couldn't play one).
async function hintClip(kind, gridId, fieldKey, fresh, report) {
    const src = HINT_SOURCES[kind];
    const artistField = String(fieldKey || '').split(' ')[1];
    if (gridId === undefined || gridId === null || !artistField) return null;
    const { rows } = await pool.query(`SELECT song_name, preview_url FROM ${src.answers}
        WHERE ${src.answerId}::text = $1::text AND field = $2
        ORDER BY normed_score ASC, RANDOM() LIMIT 8`, [String(gridId), fieldKey]);
    if (!rows.length) return null;
    if (!fresh) {
        const saved = rows.find(row => row.preview_url && /^https?:\/\//.test(row.preview_url));
        if (saved) return { url: saved.preview_url, source: 'saved' };
    }
    const artist = (await pool.query(`SELECT field_value FROM ${src.templates}
        WHERE ${src.templateId}::text = $1::text AND field_type = 'Artist' AND field = $2 LIMIT 1`, [String(gridId), artistField])).rows[0];
    if (!artist) return null;
    for (const row of rows) {
        const clip = await findSongClip(row.song_name, artist.field_value, fresh ? (row.preview_url || 'none') : null);
        if (report) report.push({ song: row.song_name, found: Boolean(clip), source: clip ? clip.source : null });
        if (!clip) continue;
        if (clip.source === 'itunes') {
            await pool.query(`UPDATE ${src.answers} SET preview_url = $1
                WHERE ${src.answerId}::text = $2::text AND field = $3 AND song_name = $4`, [clip.url, String(gridId), fieldKey, row.song_name])
                .catch(error => console.error('Could not save clip: ', error.message));
        }
        return clip;
    }
    return null;
}

function hintHandler(kind, idKey) {
    return async (req, res) => {
        try {
            const clip = await hintClip(kind, req.body[idKey], req.body.fieldKey, Boolean(req.body.fresh));
            if (!clip) return res.status(404).send('Preview URL not found for the given field and grid ID.');
            res.json({ previewUrl: clip.url, source: clip.source });
        } catch (err) {
            console.error('Error fetching cheat preview URL:', err.message);
            res.status(500).send('Error fetching cheat preview URL');
        }
    };
}

app.post('/get-cheat-preview-url', hintHandler('daily', 'gridId'));
app.post('/get-custom-cheat-preview-url', hintHandler('custom', 'customGridId'));

// ===================================================================
// Admin: see a grid's answers and clips, and remove wrong answers
// ===================================================================
async function gridLabels(src, gridId) {
    const { rows } = await pool.query(`SELECT field_type, field, field_value FROM ${src.templates}
        WHERE ${src.templateId}::text = $1::text AND field_type IN ('Artist', 'Category')`, [String(gridId)]);
    const names = {};
    rows.forEach(row => { names[row.field] = row.field_value; });
    return names;
}

// Body: { kind, grid_id, field, song }. For a daily grid this also removes
// the song from its reruns and original (same puzzle), and from the raw
// answer list so re-scoring doesn't bring it back.
app.post('/admin/remove-answer', requireAdmin, async (req, res) => {
    try {
        const kind = req.body.kind === 'custom' ? 'custom' : 'daily';
        const src = HINT_SOURCES[kind];
        const gridId = String(req.body.grid_id || '').trim();
        const field = String(req.body.field || '');
        const song = String(req.body.song || '');
        if (!/^\d{1,12}$/.test(gridId) || !/^C\d+ A\d+$/.test(field) || !song) {
            return res.status(400).json({ error: 'Send grid_id, field (like "C2 A1") and song' });
        }
        let ids = [gridId];
        if (kind === 'daily' && rotationSchemaReady) {
            const fam = await pool.query(`WITH me AS (SELECT COALESCE(MAX(rerun_of), grid_id) AS fam FROM musicgrid_templates WHERE grid_id::text = $1 GROUP BY grid_id)
                SELECT DISTINCT t.grid_id::text AS id FROM musicgrid_templates t, me WHERE t.grid_id = me.fam OR t.rerun_of = me.fam`, [gridId]);
            if (fam.rows.length) ids = fam.rows.map(row => row.id);
        }
        const removed = await pool.query(`DELETE FROM ${src.answers} WHERE ${src.answerId}::text = ANY($1) AND field = $2 AND song_name = $3`, [ids, field, song]);
        // Raw answer lists look like: "Song", "Song"
        const raw = await pool.query(`SELECT ${src.templateId}::text AS id, field_value FROM ${src.templates}
            WHERE ${src.templateId}::text = ANY($1) AND field_type = 'Answer' AND field = $2`, [ids, field]);
        for (const row of raw.rows) {
            const songs = (String(row.field_value).match(/"[^"]*"/g) || []).map(item => item.slice(1, -1));
            if (!songs.includes(song)) continue;
            const kept = songs.filter(item => item !== song).map(item => `"${item}"`).join(', ');
            await pool.query(`UPDATE ${src.templates} SET field_value = $3 WHERE ${src.templateId}::text = $1 AND field_type = 'Answer' AND field = $2`, [row.id, field, kept]);
        }
        res.json({ removed: removed.rowCount, grids: ids });
    } catch (err) {
        console.error('Error removing answer: ', err.message);
        res.status(500).json({ error: 'Error removing answer' });
    }
});

// Does this artist have song clips anywhere? Daily grids skip artists that
// don't, and the grid builder can leave them out. Results are kept in the
// artist_clips table. clips: true / false, or null if it couldn't be checked.
const artistClipMemo = new Map();

function artistKey(name) {
    return String(name || '').trim().toLowerCase();
}

async function checkArtistClips(name) {
    const key = artistKey(name);
    if (!key) return { name, clips: null };
    const memo = artistClipMemo.get(key);
    if (memo && Date.now() - memo.at < 6 * 3600000) return { name, clips: memo.clips, source: memo.source };
    if (rotationSchemaReady) {
        const saved = await pool.query(`SELECT has_clips, source FROM artist_clips
            WHERE name_key = $1 AND checked_at > now() - interval '30 days'`, [key]).catch(() => ({ rows: [] }));
        if (saved.rows.length) {
            artistClipMemo.set(key, { clips: saved.rows[0].has_clips, source: saved.rows[0].source, at: Date.now() });
            return { name, clips: saved.rows[0].has_clips, source: saved.rows[0].source };
        }
    }
    let clips = null;
    let source = null;
    let answered = 0;
    try {
        const songs = await itunesSongs(name, { attribute: 'artistTerm' });
        answered += 1;
        if (songs.some(song => song.url && sameArtist(song.artist, name))) { clips = true; source = 'itunes'; }
    } catch (error) {
        console.error('iTunes artist check failed: ', error.message);
    }
    if (!clips) {
        try {
            const songs = await deezerSongs(`artist:"${name}"`);
            answered += 1;
            if (songs.some(song => song.url && sameArtist(song.artist, name))) { clips = true; source = 'deezer'; }
        } catch (error) {
            console.error('Deezer artist check failed: ', error.message);
        }
    }
    // Neither service has a playable song by them: hints can't work
    if (!clips && answered) clips = false;
    if (clips !== null) {
        artistClipMemo.set(key, { clips, source, at: Date.now() });
        if (rotationSchemaReady) {
            await pool.query(`INSERT INTO artist_clips (name_key, artist, has_clips, source, checked_at) VALUES ($1, $2, $3, $4, now())
                ON CONFLICT (name_key) DO UPDATE SET artist = $2, has_clips = $3, source = $4, checked_at = now()`, [key, String(name).trim(), clips, source])
                .catch(error => console.error('Could not save artist clip check: ', error.message));
        }
    }
    return { name, clips, source };
}

// Body: { artists: ["Name", ...] } (up to 12). Checked one at a time to stay
// well under iTunes' rate limit.
app.post('/artist-clips', async (req, res) => {
    try {
        const names = (Array.isArray(req.body.artists) ? req.body.artists : [])
            .filter(name => typeof name === 'string' && name.trim() && name.length <= 120).slice(0, 12);
        // Unchecked artists each wait on iTunes (and maybe Deezer), so this can run long
        const key = `artist-clips|${bodyKey(names.map(name => name.trim().toLowerCase()))}`;
        const job = slowJob(key, async () => {
            const results = [];
            for (const name of names) results.push(await checkArtistClips(name.trim()));
            return { artists: results };
        });
        await replyFromJob(res, key, job, ({ result, error }) => {
            if (!error) return res.json(result);
            console.error('Error checking artist clips: ', error.message);
            res.status(500).send('Error checking artist clips');
        });
    } catch (err) {
        console.error('Error checking artist clips: ', err.message);
        if (!res.headersSent) res.status(500).send('Error checking artist clips');
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
