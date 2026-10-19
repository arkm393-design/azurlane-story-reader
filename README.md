# Azur Lane Story Reader

> **Made with AI.** This project was built with **Claude**, an AI model made by Anthropic. Claude wrote the reader,
> its design, the sync service and the pipeline that turns the game's files into scenes. The maintainer directs the
> work and compares each story with the game; until then, a story is listed under **Awaiting human review**.
> The site, the reader and every exported EPUB say so too.

An unofficial, non-commercial fan reader for Azur Lane's event stories (EN server text). Pick a story from the
library and read it the way the game presents it: backgrounds, characters with their expressions, music and sound
effects, title and location cards, choices. Or switch to a plain script view, or export the story as an EPUB.
Reading progress is saved in the browser and can follow you to other devices with a sync key.

## Credits and rights

Azur Lane's story text, art and music belong to Manjuu, Yongshi and Yostar. This project is not affiliated with them.
The game data comes from two community projects: [AzurLaneData](https://github.com/AzurLaneTools/AzurLaneData)
(story scripts and tables) and [AzurAssets](https://github.com/Fernando2603/AzurAssets) (art and audio). The MIT
license below covers this project's own code only, not any game content.

## How it fits together

| Path | What it is |
| --- | --- |
| `site/` | The website: `index.html`, `app.js`, `app.css`. Static, served by GitHub Pages. |
| `site/data/` | `catalog.json` (the library) and one file per story in `events/`. Generated. |
| `site/assets/` | Shared art and music library (backgrounds, characters, expressions, music). Generated. |
| `site/sync-core.js` | Progress format and merge rules, shared by the site and the sync service. |
| `pipeline/` | `build.py` adds stories: reads the game data, works out the staging, processes the art. |
| `pipeline/state/` | What has been processed so far, so each new story only adds what's new. |
| `config/` | Which stories are published (`events.json`) and per-story fixes (`overrides/<id>.json`). |
| `worker/` | The sync service: a Cloudflare Worker with a D1 (SQLite) database. |
| `tests/e2e.py` | Walks two browsers through the library, reader, sync and EPUB export. |

## Adding a story

From the **Actions** tab, run **Add or update a story**:

1. Action **find**, with a word from the title (for example `crimson`). The run's summary lists matching stories
   and their IDs; `*` marks ones already on the site.
2. Action **add**, with the ID. The art is processed on GitHub's machines (a few minutes for a new story, faster
   when its characters are already in the library), the result is committed, and the site redeploys.
3. New stories appear under **Awaiting human review**. Compare the story with the game. If something looks wrong,
   open an issue, fix it in `config/overrides/<id>.json` or the pipeline, then run **rebuild** with the same ID.
4. When it matches the game, run **review** with the ID: the story moves into the regular categories.
   **unreview** moves it back; **remove** takes a story off the site.

The same commands work locally: `python3 pipeline/build.py list crimson`, `add 148`, `rebuild 148`, `review 148`,
`unreview 148`, `remove 148`,
`refresh` (regenerate `site/data` only). Add `--update` to fetch the latest game data first. Requires Python 3.11+,
`pip install -r pipeline/requirements.txt`, git and ffmpeg.

## Setup

### 1. The site (GitHub Pages)

Settings → Pages → Build and deployment → Source: **GitHub Actions**. Then run **Deploy site** from the Actions tab
(it also runs on every change to `site/`). The site appears at `https://<your-name>.github.io/<repo>/`.

### 2. Sync across devices (Cloudflare, free plan)

Sync is optional. Without it the site works fully, and the backup file in the Sync dialog moves progress by hand.

1. In the Cloudflare dashboard: **Storage & databases → D1 → Create database**, named `alsr-sync`. Copy its ID.
2. **Manage account → API tokens → Create token → Custom token** with the account permissions
   *Workers Scripts: Edit* and *D1: Edit*. Copy the token. Your account ID is on the dashboard's home page.
3. In this repo: Settings → Secrets and variables → Actions.
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `KEY_PEPPER` (any long random string; set it
     once and never change it, or existing sync keys stop working).
   - Variables: `D1_DATABASE_ID` (from step 1) and `SITE_ORIGIN` (`https://<your-name>.github.io`, no path).
4. Run **Sync service** from the Actions tab. When it finishes, its log shows the service address, like
   `https://alsr-sync.<something>.workers.dev`. Save that as the variable `SYNC_API`, then run **Deploy site**.

What sync stores: reading positions, choices and reader settings, under a SHA-256 hash of the key. No accounts,
emails or names (other than the Commander name, if you set one). Anyone with a key can read and change that key's
progress, so the site tells readers to keep theirs private. Limits: one write per key per second, 20 new keys per
address per day.

### 3. Art and music on Cloudflare R2 (optional, for a large library)

GitHub Pages sites are limited to 1 GB with a soft 100 GB a month of traffic. When the library outgrows that, serve
`site/assets` from R2 instead (free egress):

1. **R2 → Create bucket**, then in its settings allow public access (the `r2.dev` address or a custom domain), and add
   a CORS policy allowing `GET` from your `SITE_ORIGIN` (the EPUB cover is drawn from the story's art).
2. **R2 → Manage API tokens → Create** with *Object Read & Write* on that bucket.
3. Secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; variables `R2_BUCKET` and `ASSET_BASE` (the bucket's public
   address). From then on **Deploy site** uploads new art to R2 and leaves it out of the Pages site.

## Local development

```sh
python3 -m http.server -d site 8000            # the site, at http://localhost:8000
node worker/test/dev-server.mjs                # sync service at http://127.0.0.1:8787
                                               # (set "syncApi" in site/config.json to try it)
node --no-warnings --test worker/test/worker.test.mjs
python3 tests/e2e.py <path to jszip.min.js> <output dir>   # needs Playwright and epubcheck
```

## License

MIT for this project's code (see `LICENSE`). Game text, art and music are not covered and remain their owners'.
