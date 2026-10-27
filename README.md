# MusicGrid

The daily music trivia grid at [musicgrid.stevenhester.com](https://musicgrid.stevenhester.com). Name a song for every square that fits both its artist and its category. Deeper cuts score more.

Static site on GitHub Pages. All data comes from the MusicGrid API on Heroku (`music-grid-io-42616e204fd3.herokuapp.com`).

## Pages

| URL | File | Script |
| --- | --- | --- |
| `/` | `index.html` | `js/grid-game.js` (daily mode) |
| `/play-custom-grid?custom_grid_id=N` | `play-custom-grid.html` | `js/grid-game.js` (custom mode) |
| `/grid-builder/` | `grid-builder/index.html` | none |
| `/grid-builder/spotify-login` | `grid-builder/spotify-login.html` | `js/gb-spotifyLogin.js` |
| `/grid-builder/artist-selection` | `grid-builder/artist-selection.html` | `js/gb-artistSelect.js` |

All of these share one stylesheet, `css/mg.css`, and the self-hosted Archivo font in `fonts/` (SIL Open Font License, see `fonts/ARCHIVO-OFL.txt`).

Older pages (`old.html`, `v2.html`, `admin.html`, `grid-builder/manual-artist-pick.html`, `grid-builder/interactTest.html`) still use their original CSS and scripts.

## How the game talks to the API

`js/grid-game.js` picks its endpoints from `<body data-mode="...">`:

| | Daily | Custom |
| --- | --- | --- |
| Grid id | `GET /latest-grid` | `custom_grid_id` URL param |
| Grid data | `POST /grid-data` | `POST /custom-grid-data` |
| Check a guess | `POST /check-answer` | `POST /check-custom-answer` |
| Easy-mode hint | `POST /get-cheat-preview-url` | `POST /get-custom-cheat-preview-url` |
| Leaderboard id | grid id | `custom_grid_id + 100` (string concatenation, kept for existing leaderboards) |

Search (`POST /search`), scores (`POST /scores`) and score submission (`POST /submit-score`) are shared.

Game progress is saved in `localStorage` under `musicgrid:<mode>:<gridId>`, so a refresh doesn't lose a game in progress.

## Local development

Any static server works, but GitHub Pages resolves extensionless URLs (`/play-custom-grid`) to `.html` files, so use one that does the same, or open the `.html` paths directly.

```
npx eslint .
```
