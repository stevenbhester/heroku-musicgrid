const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors({
    origin: 'https://musicgrid.erincullison.com'
}));

const CLIENT_ID = '1d952129111a45b2b86ea1c08dd9c6ca';  
const CLIENT_SECRET = 'c6ddfe3768bf43e092a68bfe0e9f3e6a';  

// PostgreSQL connection using Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Necessary for Heroku
    }
});

// Function to get Spotify access token
async function getSpotifyAccessToken() {
    const tokenResponse = await axios.post('https://accounts.spotify.com/api/token', 'grant_type=client_credentials', {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
        }
    });

    return tokenResponse.data.access_token;
}

// Endpoint to search song guesses on Spotify
app.post('/search', async (req, res) => {
    try {
        const searchTerm = req.body.searchTerm;
        const easyModeBool = req.body.easyModeBool || false;
        const artistSearch = req.body.artistSearch || '';
        const accessToken = await getSpotifyAccessToken();
        let searchTermAppend = `"${searchTerm}"`;
        let artistSearchAppend = '';
        
        if(!easyModeBool) {
            searchTermAppend = `track:"${searchTerm}"`;
        }
        if(artistSearch.length === 0 || artistSearch === null) {
            artistSearchAppend = '';
        } else {
            artistSearchAppend = ` artist:"${artistSearch}"`;
        }
        console.log('Fetching from spotify:' + `https://api.spotify.com/v1/search?q=${encodeURIComponent(searchTermAppend)}${encodeURIComponent(artistSearchAppend)}&type=track&market=US&limit=10`);
        const searchResponse = await axios.get(`https://api.spotify.com/v1/search?q=${encodeURIComponent(searchTermAppend)}${encodeURIComponent(artistSearchAppend)}&type=track&market=US&limit=10`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        res.json(searchResponse.data.tracks.items);
    } catch (error) {
        console.error('Error during search: ', error);
        res.status(500).send('Error during search');
    }
});


// Endpoint to search song answers on Spotify
app.post('/search-encoding-answer', async (req, res) => {
    const searchTerm = req.body.searchTerm;
    const encoderReq = req.body.encoderReq || false;
    const easyModeBool = req.body.easyModeBool || false;
    const artistSearch = req.body.artistSearch || ``;
    let limit = 10;
    let searchResponse = {};
    let searchTermAppend = `"${searchTerm}"`;
    let artistSearchAppend = ``;

    try {
        const accessToken = await getSpotifyAccessToken();
        
        if(encoderReq) {
            limit = 50;
        }
        searchTermAppend = `"${searchTerm}"`;
        if(artistSearch.length === 0 || artistSearch === null) {
            artistSearchAppend = ``;
        } else {
            artistSearchAppend = ` artist:"${artistSearch}"`;
        }
        let searchableSong = encodeURIComponent(searchTermAppend).replace(/\s|'/g,"%27");
        let searchableArtist = encodeURIComponent(artistSearchAppend).replace(/\s|'/g,"%27");
        console.log('Fetching from spotify:' + `https://api.spotify.com/v1/search?q=${searchableSong}${searchableArtist}&type=track&market=US&limit=${limit}`);
        searchResponse = await axios.get(`https://api.spotify.com/v1/search?q=${searchableSong}${searchableArtist}&type=track&market=US&limit=${limit}`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        })
    } catch (error) {
        console.error('Error during search: ', error);
        res.status(500).send('Error during search');
    }

    console.log("Spotify returned "+searchResponse.data.tracks.total+" results to parse");
    
    let matchFound = false;
    let fallbackObj = {};
    searchResponse.data.tracks.items.forEach(song => {
        if(!matchFound) {
            let songMatch = false;
            let artistMatch = false;
            let resultName = song.name.toLowerCase().trim().replace(/\s|'/g, "");
            let searchName = searchTerm.toLowerCase().trim().replace(/\s|'/g, "");
            console.log(`Comparing name result:search of "${resultName}":"${searchName}"`);
            if ( resultName == searchName ) {
                songMatch = true;
                console.log(`NAME MATCH FOUND FOR: ${searchName}!`);
                song.artists.forEach(artist => {
                    let resultArtist = artist.name.toLowerCase().trim().replace(/\s|'/g, "");
                    let searchArtist = artistSearch.toLowerCase().trim().replace(/\s|'/g, "");
                    console.log(`Comparing ARTIST result/search of "${resultArtist}"/"${searchArtist}"`);
                    if( resultArtist == searchArtist ) {
                        artistMatch = true;
                        console.log(`!!!!!!!!NAME AND ARTIST MATCHED FOR "${resultName}"/"${searchName}" by "${resultArtist}"/"${searchArtist}"!!!!!!!!!!!`);
                        matchFound = true;
                        fallbackObj = song;
                    }
                });
            }
        }
    });
    if (Object.keys(fallbackObj).length == 0) {
        const failState = {name: artistSearch, popularity: -1, preview_url: ''};
        res.json(failState);
    } else {
        res.json(fallbackObj);
    }
    
});

// Endpoint to update leaderboard after game completion
app.post('/submit-score', async (req, res) => {
    try {
        const { name, score, lb_id } = req.body;
        const query = 'INSERT INTO leaderboard_playerscores(player_name, player_score, owning_grid_id) VALUES ($1,$2,$3)';
        await pool.query(query, [name, score, lb_id]);
        res.send({ message: 'Score submitted successfully.' });
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
        const query = 'SELECT grid_id FROM musicgrid_templates WHERE reporting_day <= CURRENT_DATE ORDER BY is_live ASC, reporting_day DESC, grid_id DESC LIMIT 1';
        const result = await pool.query(query);
        const latestGridId = result.rows[0].grid_id; 
        res.json({ latestGridId });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching latest grid');
    }
});

//Endpoint to get contents of current live grid
app.post('/grid-data', async (req, res) => {
    try {
        const { grid_id } = req.body;
        const query = 'SELECT field_type, field, field_value FROM musicgrid_templates WHERE grid_id = CAST($1 AS VARCHAR(10)) ORDER BY field_type ASC, field ASC'; // Replace with your actual query
        const { rows } = await pool.query(query, [grid_id]);
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
        const query = 'SELECT normed_score AS guessScore, 0 AS rn FROM musicgrid_answers WHERE grid_id = CAST($3 AS VARCHAR(10)) AND field = $2 AND (song_name = $1 OR position(lower(song_name) in lower($1))>0) UNION ALL SELECT 0 AS guess_score, 10 as rn ORDER BY 2 ASC, 1 DESC LIMIT 1';
        const { rows } = await pool.query(query, [songGuess, fieldGuessed, gridId]);
        console.log( rows ); 
        res.json(rows);
    } catch (err) {
        console.error('Error updating checking guess:'+err.message);
        res.status(500).send('Error checking a guess answer');
    }
  });

//Endpoint to update encoded answers table
app.post('/update-encoded-answers', async (req, res) => {
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

app.post('/list-songs-by-duration', async (req, res) => {
    try {
        const artistName = req.body.artistName;
        let maxDuration = req.body.maxDurationMs || 1800000; // Default max duration
        let minDuration = req.body.minDurationMs || 0;      // Default min duration

        const artistSearchComponent = 'artist:' + artistName;
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
                    console.log(`Duration matched for song "${song.name}" of dur "${durationMinutes}`);
                    song.artists.forEach(artist => {
                        if(artist.name.toLowerCase().trim() == artistName.toLowerCase().trim()) {
                            artistMatch = true;
                            console.log(`Artist "${artist}" matched`);
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

        const artistSearchComponent = 'artist:' + artistName;
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

        const artistSearchComponent = 'artist:' + artistName;
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
