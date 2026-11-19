# Engine V2

A production-grade REST API for downloading manga from 788+ sources with built-in Cloudflare bypass capabilities.

> Engine V2 is a personal manga-downloader API built on the [HakuNeko](https://github.com/manga-download/haruneko) scraping engine.

## 🚀 Features

- **788+ Manga Sources**: Support for hundreds of manga websites
- **Export Formats**: CBZ archives and raw image folders
- **REST API**: Well-documented RESTful API with OpenAPI/Swagger
- **Rate Limiting**: Built-in concurrency control and rate limiting
- **Download Management**: Queue, track, and manage manga downloads
- **Production Ready**: Comprehensive logging, error handling, and security

## 📋 Requirements

- **Node.js**: >= 22.13.0
- **npm**: >= 10.9.2
- **System**: Linux, macOS, or Windows
- **Memory**: Recommended 2GB+ RAM (Puppeteer runs headless browsers)

## 🔧 Installation

#### 1. Clone the Repository

```bash
git clone <your-engine-v2-repository-url>
cd engine-v2
```

#### 2. Install Dependencies

```bash
npm install
```

**Important:** Manga downloads require Chromium/Chrome for Puppeteer. If downloads fail, ensure you have Chrome or Chromium installed and set the `PUPPETEER_EXECUTABLE_PATH` environment variable to its location.

#### 3. Configure Environment

Copy the example environment file and customize:

```bash
cp .env.example .env
```

Edit `.env` with your preferred settings:

```env
# Server Configuration
PORT=3000
HOST=0.0.0.0
NODE_ENV=development

# Storage Paths
STORAGE_PATH=./storage

# Puppeteer Configuration
PUPPETEER_HEADLESS=true
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium  # Or your Chrome path
PUPPETEER_MAX_BROWSERS=5

# Download Configuration
MAX_CONCURRENT_DOWNLOADS=3
DEFAULT_FORMAT=cbz
DOWNLOAD_RETENTION_DAYS=7

# Logging
LOG_LEVEL=info
```

#### 4. Build the Project

```bash
npm run build
```

#### 5. Start the Server

**Development mode (with auto-reload):**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

## 📚 API Documentation

Once the server is running, access the interactive Swagger documentation at:

```
http://localhost:3000/api-docs
```

### Quick API Overview

#### Get All Sources
```bash
GET /api/v1/sources?page=1&limit=20
```

#### Search Manga
```bash
GET /api/v1/sources/{sourceId}/search?q=naruto&page=1&limit=20
```

#### Get Manga Chapters
```bash
GET /api/v1/sources/{sourceId}/manga/{mangaId}/chapters
```

#### Download Chapters
```bash
POST /api/v1/downloads
Content-Type: application/json

{
  "sourceId": "mangadex",
  "mangaId": "manga-id-here",
  "chapterIds": ["chapter-1-id", "chapter-2-id"],
  "format": "cbz",
  "options": {
    "quality": "high",
    "includeMetadata": true
  }
}
```

#### Check Download Status
```bash
GET /api/v1/downloads/{downloadId}
```

#### Download Trending Titles

Queues up to 10 trending titles and their first 5 chapters (named by real chapter number) as image folders:

```bash
npm run download -- asurascans
```

Replace `asurascans` with another website ID whose adapter supports trending titles.

#### Download Completed File
```bash
GET /api/v1/downloads/{downloadId}/file
```

## 🏭 Montoon Worker: Work Modes

The worker finds chapters, downloads them, translates them and uploads them to Montoon as unreleased draft episodes (Montoon then schedules their release). The job queue, the planner lock and the settings all live on montoon.mn, so any number of PCs can run workers at once. If a PC stops, its jobs go back to the queue.

It needs `MONTOON_SYNC_TOKEN` in `.env`. `GEMINI_API_KEY` is used to translate and to rank new titles; without it, new titles are ranked with a built-in score.

All commands below are `npm run download -- <options>`. If the `download` command is installed globally, `download <options>` works too.

### Which mode?

| I want to… | Command |
| --- | --- |
| Run nonstop: plan, then download, translate and upload whatever is queued | `--work` |
| Plan once, finish the whole queue, then exit | `--work --once` |
| Only take jobs, never plan (an extra PC helping out) | `--work --no-plan` |
| Do one genre only: its episodes, new titles in it, and only its jobs | `--work --genre drama` |
| Translate one title up to its newest chapter, and nothing else | `--translate "solo leveling"` |

### `--work`: the normal worker

```bash
npm run download -- --work
```

On each round the worker:

1. Checks in with the server. Pause/resume and every setting come from the server.
2. Plans if it holds the `planner` lock and a plan is due (every *plan every N minutes*, set on the admin page):
   - queues new episodes of Montoon's titles, most-read titles and next episodes first;
   - picks new titles from Asura trending, Asura latest and reader requests, up to the daily limit, and queues their first chapters.
3. Handles **Translate a title** requests from the admin page every 2 minutes.
4. Claims up to 5 jobs (`WORKER_BATCH_CHAPTERS`, max 10), then downloads, translates and uploads them. Chapters of the same title are translated together.

`--once` plans right away and exits when the queue is empty. `--no-plan` never plans, so it only works through the queue.

### `--work --genre <genre>`: one genre only

```bash
npm run download -- --work --genre drama
npm run download -- --work --genre romance --once
npm run download -- --work --genre "Драма"
```

The same loop as `--work`, limited to one genre:

- Episodes are checked only for Montoon titles tagged with that genre.
- New titles are picked only if their own page lists the genre, within the same daily limit. They are marked as that genre's picks.
- The worker takes only jobs for that genre's Montoon titles and its own picks. Normal workers keep doing everything, including these.
- It plans under its own lock (`planner:drama`), so a genre worker and a normal worker don't block each other. You can run several genre workers at once.

The genre can be given as its slug (`drama`, `romance`, `action`, `martial-arts`, `slice-of-life`, `sci-fi`, …), its Mongolian name or its ID. An unknown genre prints the full list.

### `--translate "<title>"`: one title, all of it

```bash
npm run download -- --translate "solo leveling"                 # by name
npm run download -- --translate 1006                            # by Montoon ID
npm run download -- --translate https://asurascans.com/comics/…  # by series link
npm run download -- --translate "solo leveling" --chapters 1-50  # cap it
npm run download -- --translate "solo leveling" --dry-run        # only show what it would do
```

- **On Montoon already:** translates every chapter after Montoon's last episode, up to the newest.
- **Not on Montoon:** translates every chapter. The title is created on Montoon with its first chapter.
- No planning and no other titles. Its chapters go into the shared queue ahead of everything (priority 300), and this PC takes only those. Other workers may help with them.
- It stops when none of its chapters are left to claim. Failed chapters stay in the queue, and any worker retries them.
- It also runs while workers are paused, since you started it on purpose.

### Controlling workers

```bash
npm run download -- --work --status   # queue counts, workers, settings
npm run download -- --work --pause    # every worker finishes its batch, then waits
npm run download -- --work --resume
npm run download -- --stop            # stop the worker on this PC now, from any terminal
```

Ctrl+C in the worker's window stops it right away and sends its jobs back to the queue.

### Settings

- **On the Montoon admin page** (Worker monitor), shared by every PC: on/off, plan every N minutes, new titles per day, first chapters of a new title, release pacing, and the **Translate a title** box.
- **In `.env`**, per PC:
  - `WORKER_NAME`: how this PC appears on the admin page (default: the computer name).
  - `WORKER_BATCH_CHAPTERS`: chapters claimed at once (default 5, max 10).
  - `GEMINI_PICK_MODEL`: the model that ranks new titles.

### Other Montoon commands

```bash
npm run download -- --montoon --dry-run          # which Montoon titles have new episodes
npm run download -- --montoon --link 1234 <url>  # tell it which series a Montoon title is
npm run download -- --upload "Nano Machine" chapter-333 --to 1006   # upload one translated chapter by hand
npm run download -- --preview-title asurascans <series url>         # what a new title would look like on Montoon
```

`npm run download -- --help` lists everything.

## 📊 Monitoring

### Logs

Logs are stored in the `logs/` directory:

- `combined.log`: All logs
- `error.log`: Error logs only

### Health Check

```bash
GET /health
```

Returns server health, uptime, and version information.

## 📝 License

This project is licensed under the [Unlicense](https://unlicense.org/).

## 🙏 Credits

This project is a fork of [HakuNeko](https://github.com/manga-download/haruneko) - the original manga downloader desktop application. The core manga scraping engine and 788+ website scrapers are from HakuNeko, with an added REST API layer to enable programmatic access and integration.

### Download Fails

1. Check source is still active: `GET /api/v1/sources/{sourceId}`
2. Verify chapter IDs are correct
3. Check logs for detailed error messages
4. Ensure sufficient disk space in `storage/` directory

---

**Built with ❤️ for manga enthusiasts worldwide**
