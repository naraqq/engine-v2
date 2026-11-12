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
