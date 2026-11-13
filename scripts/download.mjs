#!/usr/bin/env node
/**
 * download --asurascans "solo leveling"
 * download --montoon
 *
 * One-shot downloader on top of the engine-v2 API. Starts the API itself
 * when it isn't already running and stops it again afterwards.
 */
import path from 'node:path';
import readline from 'node:readline/promises';
import { ROOT, api, c, ensureServer, fail, follow, normalize, say, status, chapterNumber } from './lib/cli.mjs';
import { editLinks, syncMontoon } from './lib/montoon.mjs';
import { runWorker, setWorkerEnabled, stopLocalWorker, workerStatus } from './lib/worker.mjs';
import { DIRS, translatedPages, uploadChapter } from './lib/upload.mjs';
import { montoonConfig } from './lib/montoon.mjs';
import { readdirSync, existsSync } from 'node:fs';

const HELP = `Download a series, what's trending, or new episodes for Montoon.

  download --asurascans "solo leveling"             every chapter
  download --asurascans "solo leveling" --latest 5  newest 5 chapters
  download --asurascans "solo leveling" --chapters 10-20
  download --asurascans https://asurascans.com/comics/solo-leveling-f212c582
  download --asurascans                             trending: first 5 chapters of 10 series
  download --asurascans --3                         trending: 3 series

  download --montoon                    new episodes for every Montoon comic
  download --montoon --dry-run          only report what's new
  download --montoon --5                stop after 5 titles with new episodes
  download --montoon --only "solo"      one title (name or Montoon ID)
  download --montoon --link 1234 <url>  set which series a Montoon title is
  download --montoon --unlink 1234      forget that link

  download --upload "Nano Machine" chapter-333 --to 1006
                                        upload a translated chapter to Montoon title 1006
                                        as an unreleased draft, then delete its local folders
                                        (--episode <n> to set the number, --keep to keep files)

  download --preview-title asurascans <series url>
                                        what the worker would create on Montoon for a new
                                        title: metadata, cover and banner (storage/title-previews)

  download --work                       nonstop worker: plans, downloads, translates, uploads
  download --work --once                plan now, work through the queue, then exit
  download --work --no-plan             only take jobs, never plan
  download --work --status              queue, workers and settings
  download --work --pause | --resume    stop or start every worker (each finishes its job first)
  download --stop                       shut down the worker on this PC now, with everything it started
                                        (Ctrl+C in the worker's window does the same)

Options
  --<source>          website ID, e.g. --asurascans (or --source <id>)
  --latest <n>        only the newest n chapters
  --chapters <a-b>    chapter range, or one chapter number
  --format <f>        images (default) or cbz
  --out <dir>         output folder (default: engine-v2/storage/downloads)
  --list              show the chapters and stop
  --<n>, --limit <n>  cap: Montoon titles to update, or trending series
  --from <a,b>        with --montoon: episode sites, searched in order (default asurascans,manga18fx,weebcentral,mangaread,kingofshojo)
  -h, --help          this help`;

// ------------------------------------------------------------- arguments

function parseArgs(argv) {
    const opts = { format: 'images', from: 'asurascans,manga18fx,weebcentral,mangaread,kingofshojo', words: [] };
    const takesValue = new Set(['source', 'latest', 'chapters', 'format', 'out', 'only', 'link', 'unlink', 'from', 'limit', 'upload', 'preview-title', 'to', 'episode', 'title']);
    const flags = {
        help: 'help', list: 'list', all: 'all', 'dry-run': 'dryRun', montoon: 'montoon',
        work: 'work', once: 'once', keep: 'keep', 'no-plan': 'noPlan', plan: 'planNow', status: 'status', pause: 'pause', resume: 'resume', stop: 'stop',
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-h') { opts.help = true; continue; }
        if (!arg.startsWith('--')) { opts.words.push(arg); continue; }
        const [name, inline] = arg.slice(2).split(/=(.*)/s);
        if (/^\d+$/.test(name)) {
            opts.limit = name; // --5
        } else if (flags[name]) {
            opts[flags[name]] = true;
        } else if (takesValue.has(name)) {
            const value = inline ?? argv[++i];
            if (value === undefined) fail(`--${name} needs a value.`);
            opts[name] = value;
        } else if (opts.source) {
            fail(`Unknown option --${name}. Run "download --help".`);
        } else {
            opts.source = name; // --asurascans
        }
    }
    opts.query = opts.words.join(' ').trim();
    if (opts.limit !== undefined) {
        if (!(Number(opts.limit) > 0)) fail('The cap must be a number above 0, like --5.');
        opts.limit = Number(opts.limit);
    }
    if (!['images', 'cbz'].includes(opts.format)) fail('--format must be images or cbz.');
    if (opts.latest !== undefined && !(Number(opts.latest) > 0)) fail('--latest needs a number above 0.');
    if (opts.chapters !== undefined) {
        const m = String(opts.chapters).match(/^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/);
        if (!m) fail('--chapters takes a number or a range like 10-20.');
        opts.range = [Number(m[1]), Number(m[2] ?? m[1])];
    }
    return opts;
}

// --------------------------------------------------------------- series

async function resolveSeries(source, query) {
    if (/^https?:\/\//i.test(query)) {
        // Old domain links (asuracomic.net) all redirect to the home page, so
        // move the path onto the source's current address.
        const given = new URL(query);
        return { url: new URL(given.pathname, source.url).href, title: null };
    }

    status(`Searching ${source.title} for "${query}"…`);
    const results = await api('GET', `/api/v1/sources/${source.id}/search?q=${encodeURIComponent(query)}&limit=50`);
    if (!results.length) fail(`Nothing on ${source.title} matches "${query}".`);

    const wanted = normalize(query);
    const exact = results.filter(r => normalize(r.title) === wanted);
    let pick = exact.length === 1 ? exact[0] : results.length === 1 ? results[0] : null;

    if (!pick) {
        const shown = results.slice(0, 15);
        say(`Several series match "${query}":`);
        shown.forEach((r, i) => say(`  ${String(i + 1).padStart(2)}. ${r.title}`));
        if (!process.stdin.isTTY) fail('Add more of the title, or pass the series URL.');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question('Pick a number (Enter to cancel): ')).trim();
        rl.close();
        const index = Number(answer) - 1;
        if (!answer || !shown[index]) fail('Cancelled.');
        pick = shown[index];
    }
    return { url: new URL(pick.id, source.url).href, title: pick.title };
}

function selectChapters(chapters, opts) {
    // Chapters arrive newest first.
    if (opts.range) {
        const [from, to] = opts.range;
        return chapters.filter(c => {
            const n = chapterNumber(c);
            return n >= Math.min(from, to) && n <= Math.max(from, to);
        });
    }
    if (opts.latest) return chapters.slice(0, Number(opts.latest));
    return chapters;
}

async function downloadFromSource(opts, outDir) {
    const stopServer = await ensureServer();
    try {
        const source = await api('GET', `/api/v1/sources/${encodeURIComponent(opts.source)}`)
            .catch(() => fail(`Unknown website "${opts.source}". Try --asurascans or --montoon.`));

        // No title: grab what's trending.
        if (!opts.query) {
            status(`Fetching trending series from ${source.title}…`);
            const result = await api('POST', '/api/v1/downloads/trending', {
                sourceId: source.id,
                titleLimit: Math.min(opts.limit || 10, 10),
                chapterLimit: Math.min(Number(opts.latest) || 5, 5),
                format: opts.format,
                downloadPath: outDir,
            });
            say(`Trending on ${source.title}: ${result.downloads.length} series, up to ${result.chapterLimit} chapters each.`);
            const done = await follow(result.downloads.map(d => d.id), 'trending');
            const ok = done.filter(d => d.status === 'completed').length;
            say(`\n${ok}/${done.length} series downloaded to ${outDir}`);
            if (ok !== done.length) process.exitCode = 1;
            return;
        }

        const series = await resolveSeries(source, opts.query);
        status('Reading the chapter list…');
        const chapters = await api('GET', `/api/v1/sources/${source.id}/manga/${encodeURIComponent(series.url)}/chapters`);
        if (!chapters.length) fail(`No chapters found at ${series.url}`);
        const title = series.title || series.url.split('/').filter(Boolean).pop();

        if (opts.list) {
            say(`${title}: ${chapters.length} chapters`);
            chapters.forEach(c => say(`  ${c.title}`));
            return;
        }

        const picked = selectChapters(chapters, opts);
        if (!picked.length) fail(`None of the ${chapters.length} chapters match that selection.`);
        const newest = picked[0].title, oldest = picked[picked.length - 1].title;
        say(`${title}: ${picked.length} of ${chapters.length} chapters (${oldest}${picked.length > 1 ? ` → ${newest}` : ''}), ${opts.format}`);

        const download = await api('POST', '/api/v1/downloads', {
            sourceId: source.id,
            mangaUrl: series.url,
            chapterIds: picked.map(c => c.id),
            format: opts.format,
            downloadPath: outDir,
        });
        const [result] = await follow([download.id], title);
        if (result.status !== 'completed') {
            process.exitCode = 1;
            return;
        }
        say(`Saved to ${path.join(outDir, result.mangaTitle || '')}`);
    } finally {
        stopServer();
    }
}

// ----------------------------------------------------------------- main

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.source === 'montoon') opts.montoon = true;
    if (opts.montoon && opts.source === 'montoon') delete opts.source;
    if (opts.upload !== undefined) return uploadCommand(opts);
    if (opts['preview-title'] !== undefined) return previewTitleCommand(opts);
    if (opts.stop) return stopLocalWorker();
    if (opts.work) {
        if (opts.status) return workerStatus();
        if (opts.pause || opts.resume) return setWorkerEnabled(Boolean(opts.resume));
        if (opts.once) opts.planNow = true;
        return runWorker(opts);
    }
    if (opts.help || (!opts.source && !opts.montoon)) {
        console.log(HELP);
        if (!opts.help) process.exitCode = 1;
        return;
    }

    process.on('SIGINT', () => {
        say('\nStopped.');
        process.exit(130);
    });

    if (opts.montoon) {
        if (opts.link || opts.unlink) return editLinks(opts);
        const outDir = path.resolve(opts.out || path.join(ROOT, 'storage', 'downloads', 'montoon'));
        return syncMontoon(opts, outDir);
    }

    const outDir = path.resolve(opts.out || path.join(ROOT, 'storage', 'downloads'));
    return downloadFromSource(opts, outDir);
}

main().catch(error => {
    say();
    console.error(c.red(`✖ ${error.message}`));
    process.exitCode = 1;
});

/** download --upload "<series>" <chapter> --to <montoon id> */
async function uploadCommand(opts) {
    const series = opts.upload;
    const chapter = opts.words[0];
    if (!series || !chapter || !opts.to) {
        const ready = existsSync(DIRS.translations)
            ? readdirSync(DIRS.translations).flatMap(s => readdirSync(`${DIRS.translations}/${s}`).filter(ch => translatedPages(s, ch).files.length).map(ch => `  "${s}" ${ch}`))
            : [];
        const list = ready.length ? `\nTranslated chapters ready to upload:\n${ready.join('\n')}` : '';
        fail(`Usage: download --upload "<series>" <chapter> --to <montoon title id>${list}`);
    }
    if (!/^\d+$/.test(opts.to)) fail('--to takes the Montoon title ID (a number), e.g. --to 1006.');
    montoonConfig(); // needs MONTOON_SYNC_TOKEN
    const result = await uploadChapter({
        series,
        chapter,
        contentId: Number(opts.to),
        episodeNumber: opts.episode !== undefined ? Number(opts.episode) : undefined,
        title: opts.title || null,
        keep: Boolean(opts.keep),
        indent: '',
    });
    if (result.exists) process.exitCode = 1;
}

/** download --preview-title <source> <series url> */
async function previewTitleCommand(opts) {
    const sourceId = opts['preview-title'];
    const seriesUrl = opts.words[0];
    if (!sourceId || !/^https?:\/\//.test(seriesUrl || '')) fail('Usage: download --preview-title <source> <series url>');
    const { previewTitle } = await import('./lib/title-maker.mjs');
    const stop = await ensureServer();
    try {
        const outDir = path.join(ROOT, 'storage', 'title-previews', (new URL(seriesUrl).pathname.split('/').filter(Boolean).pop() || 'title').replace(/[^\w.-]+/g, '-'));
        const { info, meta, image } = await previewTitle({ sourceId, seriesUrl, title: opts.title, outDir });
        say(`${info.title}  →  ${meta.title_mn || '(no Mongolian title)'}`);
        say(`  ${meta.type} · ${meta.status} · ${meta.age_limit}+ · metadata by ${meta.by}`);
        say(`  cover ${image.width}×${image.height} from ${image.url}`);
        say(`  ${meta.description_mn}`);
        say(`Saved cover.jpg, landscape.jpg and metadata.json to ${outDir}`);
    } finally {
        stop();
    }
}
