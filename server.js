const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
const app = express();

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
        const query = 'SELECT grid_id FROM musicgrid_templates WHERE reporting_day <= CURRENT_DATE ORDER BY is_live DESC, reporting_day DESC, grid_id DESC LIMIT 1';
        const result = await pool.query(query);
        const latestGridId = result.rows[0].grid_id; 
        res.json({ latestGridId });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching latest grid');
    }
});

//Endpoint to get ID of the current grid we should serve
app.post('/set-grid-live', async (req, res) => {
    try {
        const { grid_id } = req.body;
        const setOffQuery = 'UPDATE musicgrid_templates SET is_live = FALSE WHERE grid_id <> $1';
        const setLiveQuery = 'UPDATE musicgrid_templates SET is_live = TRUE WHERE grid_id = $1';
        const { rows } = await pool.query(setOffQuery, [grid_id]);
        const { rows2 } = await pool.query(setLiveQuery, [grid_id]);
        res.json( rows2);
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
        const accessToken = await getSpotifyAccessToken();


        console.log("Fetching /artists/artistId/albums for "+artistId);
        console.log(`Postman - 'Authorization': 'Bearer ${accessToken}'`);
        console.log(`Postman - https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}/albums?include_groups=${encodeURIComponent(searchGroups)}&market=US&limit=50&albumOffset=${albumOffset}`);
        const albumList = await axios.get(`https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}/albums?include_groups=${encodeURIComponent(searchGroups)}&market=US&limit=50&albumOffset=${albumOffset}`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });
        totalAlbums = albumList.data.total;
        console.log("Total albums now at:"+totalAlbums);
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
    try {
        const artistsJoined = req.body.artists;
        console.log("Generating AI title from ",artistsJoined);
        const aiBody = {
           model: "gpt-4-turbo-preview",
           messages: [
              {
                 role: "user",
                 content: `Your job is to create a clever, witty name for a custom trivia grid a user just created in my game, MusicGrid. The larger game is to guess songs that match categories and artists. There's 3 columns, each with one artist, and three columns, each with one category; users guess a song that matches the column's artist and the row's category. You need to name the title for a user's custom grid, with artists and categories they select. The name should be focused on the shared vibe of the artists; e.g. for Green Day/Linkin Park/My Chemical Romance, a clever version of Millenial Childhood Alt Rock would work. The name should be unique to the special vibe shared by the selected artists, always with as much specificity as possible for those three artists. Your suggestion should fit each of the three artists always. You can use vibes, genre, identity, time period, and more. Avoid cringey titles that feel uncool at all costs. You can either give it a summary title, or a funny prompt that describes the artists - a title of Artists Your Parents Would Hate or a title of Hyper-Pop Havoc would work if the artists were 100 gecs, Dorian Electra, and ElyOtto. Do not suggest titles that have a subtitle embedded with a colon, semicolon, hyphen, or other delimiter in any output. The title you are generating now is for the artists:  ${artistsJoined}`
              }
           ],
           temperature: 0.6
        };
        console.log("Body for request to OpenAI:");
        console.log(aiBody);       
        const aiHeaders = {
           'Authorization': `Bearer ${OPENAI_SECRET}`,
           'Content-Type': 'application/json'
         };
        console.log("Headers for request to OpenAI:");
        console.log(aiHeaders);
        console.log("Submitting request");
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',aiBody,
            {
                headers: aiHeaders
            }
        );
       
        console.log("Response received:");
        console.log(response);
        console.log("Parsed relevant response data is:");
        console.log(response.data.choices[0]);
        console.log("More specifically: ");
        console.log(response.data.choices[0].message.content.trim());
        res.json(response.data.choices[0]);
    } catch (error) {
        console.log("Error hit! ", error);
        console.error(`Error generating music grid name: ${error.message}`);
        let fallback = { message: { content: "AI Failure Fallback Title" } }
        res.json(fallback); // Default name
    }
});
