# Montoon engine

This PC's part of the Montoon translation pipeline. A **worker** finds chapters on source sites, downloads them, translates them into Mongolian on this PC (local OCR on the GPU, then Gemini), and uploads them to Montoon. It also fixes episodes that readers complained about.

The job queue, the planner lock and the settings all live on montoon.mn, so any number of PCs can run workers at once. If a PC stops, its jobs go back to the queue for the others.

## Setup

Requirements: Node.js 22.13 or newer, Windows with a DirectX 12 GPU (OCR runs through DirectML; CPU works, about 2.5× slower).

```bash
npm install
```

Create `.env` in this folder:

```ini
MONTOON_SYNC_TOKEN=...      # required: same value as on the Montoon server
GEMINI_API_KEY=...          # required: translation, and ranking new titles
WORKER_NAME=office-pc       # optional: how this PC shows on the admin page (default: computer name)
```

For text on artwork to be erased cleanly, put the LaMa model at `storage/models/lama_fp32.onnx` ([Carve/LaMa-ONNX](https://huggingface.co/Carve/LaMa-ONNX), `lama_fp32.onnx`). Without it, a simple background fill is used instead.

That's all. The worker starts the local engine by itself when it needs it.

## Commands

Every command is `npm run download -- <options>`. `npm run download -- --help` lists them all.

| I want to… | Command |
| --- | --- |
| Run nonstop: plan, then download, translate and upload whatever is queued | `--work` |
| Fix the episodes readers complained about first, then keep working | `--fix-reports` |
| See which complaints would be fixed, without doing anything | `--fix-reports --dry-run` |
| Push new titles (under 30 episodes) to the front, then keep working | `--grow-titles` |
| Plan once, finish the whole queue, then exit | `--work --once` |
| Only take jobs, never plan (an extra PC helping out) | `--work --no-plan` |
| Work on one genre only | `--work --genre drama` |
| Translate one title up to its newest chapter, and nothing else | `--translate "solo leveling"` |
| See the queue, the workers and the settings | `--work --status` |
| Pause or resume every worker | `--work --pause` / `--work --resume` |
| Stop the worker on this PC, from any terminal | `--stop` |

`--once` works with `--fix-reports` and `--grow-titles` too: do that work, finish the queue, then exit.

## How the worker works

```bash
npm run download -- --work
```

On each round the worker:

1. **Checks in.** Pause/resume and every shared setting come from the server.
2. **Plans**, if this PC holds the planner lock and a plan is due (every *plan every N minutes*, set on the admin page):
   - **reader complaints:** queues a fix for every reported episode of a renewed title (see [Complaint fixes](#complaint-fixes));
   - **new episodes:** queues the chapters each Montoon title is missing on its source site;
   - **new titles:** picks titles from Asura Scans trending and latest and from reader requests, up to the daily limit, and queues their first chapters.
3. **Handles admin requests**: the *Translate a title* box on the admin page, checked every 2 minutes.
4. **Claims 3 jobs**, then downloads, translates and uploads them. Chapters of the same title are translated together, so names and context carry over.

New episodes are uploaded as **unreleased drafts**. Montoon schedules their release.

### What runs first

Each job has a priority. The worker always takes the highest tier that has jobs:

| Tier | Priority | Jobs | Stays on one title? |
| --- | --- | --- | --- |
| 1 | 300 / 200 | `--translate` runs and admin requests | yes |
| 2 | 170–199 | complaint fixes, most complaints first | **no**: always the most-complained episode next |
| 3 | 120–164 | growing titles: episodes until a title has 30 | yes, until that title has 30 |
| 4 | 6–100 | everything else: new episodes (most-read titles and next episodes first), new titles | yes |

"Stays on one title" means a worker keeps taking the same title's jobs within that tier, so its chapters are batched and translated together.

## Complaint fixes

```bash
npm run download -- --fix-reports --dry-run   # what would be fixed
npm run download -- --fix-reports             # fix them, then keep working
```

Every plan does this too, so a normal `--work` worker fixes complaints on its own. `--fix-reports` just does it right away.

- It reads the open complaints from Montoon that a fresh translation can fix: unreadable or wrong translation, poor, broken or wrong images, missing pages, wrong order, and missing episode. Complaints marked *other* are left for a person.
- Only renewed titles are fixed. Old (v1) translations are skipped.
- Each reported episode is found on the title's source site by its episode number. It's then re-downloaded and **re-translated from scratch**, with fresh OCR and the extra "native editor" polish pass.
- The episode's pages are **replaced in place**, and the change is live right away. Release state, access and price don't change. The episode's complaints are marked resolved.
- The original pages are kept until an admin reviews the fix in **Admin → Fix Reviews**. That screen shows both versions side by side, and the admin keeps one. The other version's files are deleted for good. The sidebar badge counts the fixes waiting for review. Fixes are live whether or not anyone has reviewed them yet.
- An episode number the source doesn't have is listed as *fix by hand* in the activity log.

## Growing titles

```bash
npm run download -- --grow-titles
```

A new title has no readers yet, so on reads alone it would wait behind every popular title's backlog. A **growing title** is a renewed title with fewer than *launch episodes* (default 30) on Montoon. Its next episodes, up to that count, go ahead of normal episodes. A worker fills one growing title to 30, then moves on to the next.

Every plan applies this too. `--grow-titles` just checks the growing titles right away, which is quicker than a full plan.

## One genre: `--work --genre <genre>`

```bash
npm run download -- --work --genre drama
npm run download -- --work --genre "Драма"
```

The same loop as `--work`, limited to one genre: episodes and complaints of that genre's Montoon titles, new titles whose own page lists the genre, and only those jobs. It plans under its own lock (`planner:drama`), so genre workers and normal workers don't block each other.

The genre can be its slug (`drama`, `romance`, `action`, `martial-arts`, …), its Mongolian name or its ID. An unknown genre prints the full list.

## One title: `--translate "<title>"`

```bash
npm run download -- --translate "solo leveling"                  # by name
npm run download -- --translate 1006                             # by Montoon ID
npm run download -- --translate https://asurascans.com/comics/…  # by series link
npm run download -- --translate "solo leveling" --chapters 1-50  # cap it
npm run download -- --translate "solo leveling" --dry-run        # only show what it would do
```

- **On Montoon already:** translates every chapter after Montoon's last episode, up to the newest.
- **Not on Montoon:** translates every chapter, and the title is created on Montoon with its first chapter.
- No planning and no other titles. It runs even while workers are paused.

## Stopping

**Ctrl+C** in the worker's window stops everything right away:

- downloads running in the engine are cancelled, including in an engine you started yourself;
- the translator and the engine the worker started are killed, along with everything they started (Chrome included);
- the current jobs go back to the queue.

`npm run download -- --stop` from another terminal kills the worker and everything it started. Its jobs go back to the queue when their lease runs out (15 minutes). A download inside an engine you started yourself isn't cancelled this way, so prefer Ctrl+C.

If the translator prints nothing for 15 minutes (for example, a stuck GPU driver), the worker kills it and its jobs are retried later.

## Settings

**On the Montoon admin page** (Worker monitor), shared by every PC: on/off, plan every N minutes, new titles per day, first chapters of a new title, launch episodes, and release pacing.

**In `.env`**, per PC:

| Variable | Default | What it does |
| --- | --- | --- |
| `MONTOON_SYNC_TOKEN` | (required) | Access to Montoon's worker API |
| `GEMINI_API_KEY` | (required) | Translation and new-title ranking |
| `WORKER_NAME` | computer name | How this PC appears on the admin page and in the activity log |
| `WORKER_BATCH_CHAPTERS` | `3` | Chapters claimed at once (max 10) |
| `TRANSLATOR_STALL_MINUTES` | `15` | Kill a translator that's silent this long |
| `TRANSLATE_MODEL` | `gemini-3-flash-preview` | Translation model |
| `GEMINI_PICK_MODEL` | `gemini-3.5-flash` | Model that ranks new titles and writes their Montoon metadata |
| `OCR_PROVIDER` | `dml` | `dml` (GPU) or `cpu` |
| `TRANSLATOR_POLISH` | `false` | Polish pass on every chapter (complaint fixes always use it) |
| `MONTOON_API_URL` | `https://montoon.mn/api` | Montoon server |

## Activity and logs

- **Montoon admin → Activity**: plans, uploads, complaint checks, fixes and fix reviews, new titles, releases and failures from every worker, newest first. *Fixes* has its own filter, and *Episodes fixed* is counted for the last 24 hours.
- **This PC:** `logs/combined.log` (translator and engine), `logs/download-cli-server.log` (the engine the worker starts), `logs/error.log`.

## Other commands

```bash
npm run download -- --montoon --dry-run          # which Montoon titles have new episodes
npm run download -- --montoon --only "solo"      # check one title (name or Montoon ID)
npm run download -- --montoon --link 1234 <url>  # tell it which series Montoon title 1234 is
npm run download -- --montoon --unlink 1234      # forget that link
npm run download -- --upload "Nano Machine" chapter-333 --to 1006   # upload one translated chapter by hand (as a draft)
npm run download -- --preview-title asurascans <series url>         # what a new title would look like on Montoon
```

Translate a chapter that's already downloaded, without the worker:

```bash
npm run translate -- "Nano Machine" chapter-333                # OCR + translate + draw
npm run translate -- "Nano Machine" chapter-333 --retranslate  # keep OCR, redo the translation
npm run translate -- "Nano Machine" chapter-333 --force        # redo everything
```

## Files on this PC

All under `storage/` (or `STORAGE_PATH`):

| Folder | What's in it |
| --- | --- |
| `downloads/<title>/<chapter>/` | Downloaded pages |
| `translation-work/<title>/` | OCR and translation data per page, and each title's glossary of names |
| `translations/<title>/<chapter>/` | Translated pages, ready to upload |
| `models/` | LaMa model |

A chapter's folders are deleted once it's uploaded. Glossaries are kept.

## Troubleshooting

- **"MONTOON_SYNC_TOKEN is not set" / "rejected the sync token"**: set it in `.env` to the same value as on the Montoon server.
- **"…is not available. Deploy the backend…" / "no complaint endpoint yet"**: the Montoon backend is older than this engine. Deploy it and run `php artisan migrate`.
- **A title is never updated**: `--montoon --only "<title>"` shows how it's matched on the source sites. If it matches the wrong series, or none, set the series with `--montoon --link <id> <url>`.
- **OCR is slow**: check that the log says `OCR ready (… on dml)`. If it fell back to CPU, update the GPU driver.
- **Nothing seems to happen**: `--work --status` shows the queue and whether workers are paused.

---

Built on the [HakuNeko](https://github.com/manga-download/haruneko) scraping engine. Released under the [Unlicense](https://unlicense.org/).
