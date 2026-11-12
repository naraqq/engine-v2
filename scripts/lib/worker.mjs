/**
 * download --work
 *
 * Nonstop content worker. All shared state (job queue, planner lock, title
 * decisions, settings) lives on montoon.mn, so any number of PCs can run
 * this at once, and a PC that switches off or loses its connection just
 * lets its jobs expire back into the queue for another worker.
 *
 * Each round:
 *   1. Check in with the server (settings, on/off switch).
 *   2. If this worker gets the planner lock and a plan is due:
 *      - queue new episodes of Montoon's titles (same checks as --montoon),
 *      - pick new titles from Asura trending, Asura latest and readers'
 *        requests (ranked by Gemini when GEMINI_API_KEY is set), and queue
 *        their first chapters.
 *   3. Claim one job: download the chapter, upload its pages to Montoon's
 *      storage (worker-raw/…), keep a local copy, report the result.
 */
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { ROOT, api, c, chapterNumber, childPids, ensureServer, follow, killChildren, killTree, normalize, say, sleep, status, track } from './cli.mjs';
import { fetchMontoonTitles, findOnSource, montoonConfig, resultUrl, syncMontoon } from './montoon.mjs';
import { LostJobError, log, mt } from './montoon-api.mjs';
import { DIRS, removeLocalChapter, translatedPages, uploadChapter } from './upload.mjs';
import { stitchChapter } from './stitch.mjs';

const WORKER = (process.env.WORKER_NAME || os.hostname()).replace(/[^\w.-]+/g, '-').slice(0, 56);
const JOB_TTL = 900; // seconds a claimed job stays ours without a heartbeat
const EPISODE_SITES = 'asurascans,manga18fx';

const count = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- planner

async function maybePlan(settings, opts) {
    const lease = (await mt('POST', '/lease', { name: 'planner', worker: WORKER, ttl: 3600 })).data;
    if (!lease.acquired) return;
    const lastRun = lease.value?.last_run ? Date.parse(lease.value.last_run) : 0;
    const due = Date.now() - lastRun >= settings.plan_every_minutes * 60_000;
    if (!due && !opts.planNow) {
        await mt('POST', '/lease/release', { name: 'planner', worker: WORKER });
        return;
    }
    opts.planNow = false;

    say('');
    log(c.bold(c.cyan(`▶ Planning (this worker holds the planner lock; next plan in ${settings.plan_every_minutes} min)`)));
    const summary = {};
    try {
        summary.episodes = await planEpisodes();
    } catch (error) {
        log(c.red(`✖ Episode check failed: ${error.message}`));
    }
    try {
        summary.new_titles = await planNewTitles(settings);
    } catch (error) {
        log(c.red(`✖ New-title search failed: ${error.message}`));
    }
    await mt('POST', '/lease/release', {
        name: 'planner',
        worker: WORKER,
        value: { last_run: new Date().toISOString(), by: WORKER, summary },
    });
    log(c.bold(c.cyan('▶ Planning done. Back to downloading.')));
    say('');
}

async function queueJobs(jobs) {
    let created = 0, existing = 0, updated = 0;
    for (let i = 0; i < jobs.length; i += 400) {
        const result = (await mt('POST', '/jobs', { jobs: jobs.slice(i, i + 400) })).data;
        created += result.created;
        existing += result.existing;
        updated += result.updated ?? 0; // older servers don't refresh existing jobs
    }
    return { created, existing, updated };
}

/**
 * Removes queued jobs the plan no longer wants (episodes Montoon now has, or
 * jobs from a series link that turned out wrong), for the titles this plan
 * read successfully. Running, failed and finished jobs are kept.
 */
async function pruneJobs(checked) {
    let removed = 0;
    try {
        for (let i = 0; i < checked.length; i += 200) {
            removed += (await mt('POST', '/jobs/prune', { titles: checked.slice(i, i + 200) })).data.removed;
        }
    } catch (error) {
        log(c.yellow(`  ⚠ Couldn't remove outdated jobs (${error.message}). The Montoon backend may need deploying.`));
        return 0;
    }
    if (removed) log(c.gray(`  ↳ Removed ${count(removed, 'outdated queued job')}.`));
    return removed;
}

const chapterJob = ({ site, url, chapter, title, contentId = null, workerTitleId = null, priority, reason }) => ({
    key: `${site.id}:${chapter.id}`,
    priority,
    content_id: contentId,
    worker_title_id: workerTitleId,
    payload: {
        source_id: site.id,
        series_url: url,
        chapter_id: chapter.id,
        chapter_number: chapter.number,
        title,
        reason,
    },
});

/**
 * A title's readership from Montoon's sync feed: unique readers in the last
 * 7 days, plus a little of the last 30 so a quiet week doesn't sink a title
 * people follow. null from an older server that doesn't send it.
 */
const readsOf = t => {
    if (t.readers_7d === undefined && t.readers_30d === undefined) return null;
    return (Number(t.readers_7d) || 0) + (Number(t.readers_30d) || 0) / 4;
};

/**
 * Job priority for a title's new episodes (higher runs first), always above
 * the new-title jobs (5):
 *   - popular titles first: up to +50 by reads, relative to the most-read title;
 *   - next episode first: up to +44 for the first missing episode, falling off
 *     with its place in the backlog, so a title with 100+ waiting can't hold
 *     the queue while other titles wait for their next one.
 * Without read counts every title gets the middle popularity score.
 */
function episodePriority(title, titles, position) {
    const reads = readsOf(title);
    const max = Math.max(0, ...titles.map(readsOf).filter(v => v !== null));
    const popularity = reads === null || max === 0 ? 0.5 : Math.sqrt(reads / max);
    return 6 + Math.round(50 * popularity + 44 / (1 + position / 2));
}

/** New episodes of Montoon's own titles: the --montoon check, queued. */
async function planEpisodes() {
    log(c.cyan('▶ Checking Montoon titles for new episodes'));
    const checked = [];
    const totals = await syncMontoon({
        from: EPISODE_SITES,
        format: 'images',
        onChecked: ({ title, site, chapters }) => checked.push({
            content_id: title.id,
            keep: chapters.map(chapter => `${site.id}:${chapter.id}`),
        }),
        enqueue: ({ title, titles, site, url, chapters }) => queueJobs(chapters.map((chapter, position) => chapterJob({
            site, url, chapter,
            title: title.title || title.title_mn,
            contentId: title.id,
            priority: episodePriority(title, titles, position),
            reason: 'new episode',
        }))),
    }, DIRS.downloads);
    const removed = await pruneJobs(checked);
    if (totals.notFoundTitles.length) log(c.yellow(`  Not on ${EPISODE_SITES}: ${totals.notFoundTitles.join(', ')}`));
    if (totals.failedTitles.length) log(c.yellow(`  Couldn't check (retried next plan): ${totals.failedTitles.join(', ')}`));
    return {
        titles: totals.updated,
        episodes: totals.pending,
        not_found: totals.notFound,
        failed: totals.failed,
        removed_jobs: removed,
        not_found_titles: totals.notFoundTitles,
        failed_titles: totals.failedTitles,
    };
}

/** Pick new titles to start, within today's limit, and queue their first chapters. */
async function planNewTitles(settings) {
    const registry = await mt('GET', '/titles?limit=2000');
    const quota = settings.new_titles_per_day - registry.picked_today;
    log(c.cyan(`▶ Looking for new titles (${registry.picked_today}/${settings.new_titles_per_day} picked today)`));
    if (quota <= 0) {
        log(c.gray('  Today\'s limit is reached. Skipping.'));
        return { picked: 0 };
    }

    // Everything Montoon has, old translations included, and every title
    // already picked or rejected, so nothing is suggested twice.
    const montoon = await fetchMontoonTitles(montoonConfig(), '?renewed=all');
    const known = new Set(montoon.flatMap(t => [normalize(t.title), normalize(t.title_mn)]).filter(Boolean));
    const decided = new Set(registry.data.filter(t => t.decision !== 'candidate').map(t => t.series_url));

    const asura = await api('GET', '/api/v1/sources/asurascans');
    const manga18fx = await api('GET', '/api/v1/sources/manga18fx');
    const candidates = new Map();
    const add = (site, info, signal) => {
        const url = resultUrl(info.id, site);
        if (known.has(normalize(info.title)) || decided.has(url)) return;
        const entry = candidates.get(url) || { site, url, title: info.title, origins: [], trendingRank: null, latest: false, requests: 0 };
        Object.assign(entry, signal(entry));
        candidates.set(url, entry);
    };

    status(c.gray('  ↳ Reading Asura Scans trending…'));
    const trending = await api('GET', '/api/v1/sources/asurascans/discover?list=trending&limit=20').catch(() => []);
    trending.forEach((info, i) => add(asura, info, e => ({ trendingRank: i + 1, origins: [...new Set([...e.origins, 'trending'])] })));
    status(c.gray('  ↳ Reading Asura Scans latest updates…'));
    const latest = await api('GET', '/api/v1/sources/asurascans/discover?list=latest&limit=30').catch(() => []);
    latest.forEach(info => add(asura, info, e => ({ latest: true, origins: [...new Set([...e.origins, 'latest'])] })));
    log(c.gray(`  ↳ Asura Scans: ${trending.length} trending, ${latest.length} recently updated.`));

    const requests = (await mt('GET', '/requests')).data.slice(0, 20);
    let matchedRequests = 0;
    for (const request of requests) {
        if (known.has(normalize(request.title))) continue;
        for (const site of [asura, manga18fx]) {
            status(c.gray(`  ↳ Looking up reader request "${request.title}" on ${site.title}…`));
            const { matches } = await findOnSource(site, request.title).catch(() => ({ matches: [] }));
            if (matches.length) {
                add(site, matches[0], e => ({ requests: e.requests + request.count, origins: [...new Set([...e.origins, 'request'])] }));
                matchedRequests++;
                break;
            }
        }
    }
    log(c.gray(`  ↳ Reader requests: ${requests.length} asked for, ${matchedRequests} found on Asura Scans or Manga18fx.`));

    // Chapter counts for the strongest candidates (each is a page load).
    const pool = [...candidates.values()]
        .sort((a, b) => formulaScore(b) - formulaScore(a))
        .slice(0, 15);
    const usable = [];
    for (const entry of pool) {
        status(c.gray(`  ↳ Checking chapters of "${entry.title}"…`));
        const chapters = await api('GET', `/api/v1/sources/${entry.site.id}/manga/${encodeURIComponent(entry.url)}/chapters`).catch(() => []);
        const numbered = chapters.map(ch => ({ ...ch, number: chapterNumber(ch) }))
            .filter(ch => Number.isFinite(ch.number))
            .sort((a, b) => a.number - b.number);
        if (numbered.length < 3) continue; // nothing to start with
        usable.push({ ...entry, chapters: numbered, chapterCount: numbered.length, newest: numbered.at(-1).number });
    }
    if (!usable.length) {
        log(c.gray('  No new candidates this round.'));
        return { picked: 0 };
    }

    const ranked = await rank(usable, montoon);
    const picks = ranked.filter(r => r.score >= (r.by === 'gemini' ? 50 : 0)).slice(0, quota);
    const pickedUrls = new Set(picks.map(p => p.entry.url));

    const saved = (await mt('POST', '/titles', {
        items: ranked.map(r => ({
            source_id: r.entry.site.id,
            series_url: r.entry.url,
            title: r.entry.title,
            origin: r.entry.origins[0] || 'trending',
            decision: pickedUrls.has(r.entry.url) ? 'picked' : 'candidate',
            score: r.score,
            reason: r.reason,
            meta: {
                origins: r.entry.origins,
                trending_rank: r.entry.trendingRank,
                requests: r.entry.requests,
                chapters: r.entry.chapterCount,
                newest: r.entry.newest,
                ranked_by: r.by,
            },
        })),
    })).data;
    const idByUrl = new Map(saved.map(t => [t.series_url, t.id]));

    for (const r of ranked.slice(0, 8)) {
        const picked = pickedUrls.has(r.entry.url);
        const line = `${picked ? c.green('★ Picked') : c.gray('· Passed')} ${c.bold(r.entry.title)} ${c.gray(`(${r.entry.site.title}, ${r.entry.chapterCount} ch, score ${Math.round(r.score)})`)}`;
        log(`  ${line}${r.reason ? c.gray(` ${r.reason}`) : ''}`);
    }

    let queued = 0;
    for (const pick of picks) {
        const first = pick.entry.chapters.slice(0, settings.first_chapters);
        const result = await queueJobs(first.map(chapter => chapterJob({
            site: pick.entry.site,
            url: pick.entry.url,
            chapter,
            title: pick.entry.title,
            workerTitleId: idByUrl.get(pick.entry.url) ?? null,
            priority: 5,
            reason: 'new title',
        })));
        queued += result.created;
        log(c.cyan(`  ⇢ Queued the first ${count(first.length, 'chapter')} of "${pick.entry.title}".`));
    }
    return { picked: picks.length, queued, considered: usable.length };
}

/** Score without AI: reader demand first, then trending, activity and length. */
function formulaScore(e) {
    return e.requests * 15
        + (e.trendingRank ? (21 - e.trendingRank) * 3 : 0)
        + (e.latest ? 8 : 0)
        + Math.min(e.chapterCount ?? 0, 150) / 5;
}

const geminiKey = () => {
    const key = process.env.GEMINI_API_KEY || '';
    return key && !/your-gemini-api-key/i.test(key) ? key : null;
};

async function rank(entries, montoon) {
    const key = geminiKey();
    if (key) {
        try {
            return await rankWithGemini(entries, montoon, key);
        } catch (error) {
            log(c.yellow(`  ⚠ Gemini ranking failed (${error.message}). Using the built-in score.`));
        }
    } else {
        log(c.gray('  ↳ No GEMINI_API_KEY set; ranking with the built-in score.'));
    }
    return entries
        .map(entry => ({ entry, score: formulaScore(entry), reason: null, by: 'formula' }))
        .sort((a, b) => b.score - a.score);
}

async function rankWithGemini(entries, montoon, apiKey) {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_PICK_MODEL || 'gemini-3.5-flash';
    status(c.gray(`  ↳ Asking ${model} which titles will attract readers…`));

    const library = montoon.filter(t => t.translation_renewed).map(t => t.title || t.title_mn).slice(0, 80);
    const list = entries.map((e, i) => [
        `${i}. "${e.title}" on ${e.site.title}`,
        `${e.chapterCount} chapters (newest ${e.newest})`,
        e.trendingRank ? `#${e.trendingRank} trending on Asura Scans` : null,
        e.latest ? 'recently updated' : null,
        e.requests ? `requested ${e.requests} times by our readers` : null,
    ].filter(Boolean).join('; ')).join('\n');

    const response = await ai.models.generateContent({
        model,
        contents: [
            'Montoon is a Mongolian webcomic app. We translate manhwa, manhua and manga into Mongolian.',
            `Series our readers already have:\n${library.join(', ')}`,
            `Candidate series to add next:\n${list}`,
            'Score every candidate from 0 to 100 for how well it would attract and keep Mongolian readers on Montoon: '
            + 'broad appeal and popularity, a strong hook in the first chapters, enough chapters to binge, fit with what our readers already like, '
            + 'and reader requests (weigh these heavily). Give a one-sentence reason in English for each.',
        ].join('\n\n'),
        config: {
            responseMimeType: 'application/json',
            responseJsonSchema: {
                type: 'object',
                properties: {
                    ratings: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                index: { type: 'integer' },
                                score: { type: 'integer' },
                                reason: { type: 'string' },
                            },
                            required: ['index', 'score', 'reason'],
                        },
                    },
                },
                required: ['ratings'],
            },
            temperature: 0.3,
            // Same cap as the translator: never more than 256 thinking tokens.
            thinkingConfig: { thinkingBudget: Math.min(Number(process.env.GEMINI_THINKING_BUDGET) || 256, 256) },
        },
    });
    const { ratings } = JSON.parse(response.text);
    const byIndex = new Map(ratings.map(r => [r.index, r]));
    log(c.gray(`  ↳ Ranked by ${model}.`));
    return entries
        .map((entry, i) => ({
            entry,
            score: byIndex.get(i)?.score ?? 0,
            reason: byIndex.get(i)?.reason ?? null,
            by: 'gemini',
        }))
        .sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------------- jobs

/** Each job downloads into its own empty folder, so nothing from an earlier try can be mistaken for it. */
const INCOMING = path.join(path.dirname(DIRS.downloads), 'incoming');

/**
 * Deletes a temporary folder without ever failing the job. Windows refuses
 * while a file inside is still open (antivirus, image cache); retry briefly,
 * then leave it. A leftover folder is harmless: the next try of that job
 * empties it first, and a download always lands in a fresh one.
 */
function removeQuietly(dir) {
    try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (error) {
        log(c.yellow(`  ⚠ Could not remove ${dir} (${error.code || error.message}). Leaving it.`));
    }
}

/** The chapter folder the engine wrote inside a job's incoming folder: <series>/chapter-<n>. */
function findIncomingChapter(root, number) {
    for (const series of existsSync(root) ? readdirSync(root) : []) {
        const seriesDir = path.join(root, series);
        if (!statSync(seriesDir).isDirectory()) continue;
        const exact = path.join(seriesDir, `chapter-${number}`);
        if (existsSync(exact)) return { series, chapter: `chapter-${number}`, dir: exact };
        const [only] = readdirSync(seriesDir).filter(d => statSync(path.join(seriesDir, d)).isDirectory());
        if (only) return { series, chapter: only, dir: path.join(seriesDir, only) };
    }
    return null;
}

/**
 * Moves a fresh download into storage/downloads/<series>/<chapter>, joining thin
 * strips into taller pages. Earlier tries' pages, rendered output and OCR cache
 * for that chapter are removed, since their page files no longer match.
 */
async function placeChapter(found) {
    const dest = path.join(DIRS.downloads, found.series, found.chapter);
    for (const root of [DIRS.downloads, DIRS.translations, DIRS.work]) {
        rmSync(path.join(root, found.series, found.chapter), { recursive: true, force: true });
    }
    const { before, after } = await stitchChapter(found.dir, dest);
    if (after !== before) log(`  ${c.gray(`↳ Joined ${before} strips into ${after} pages`)}`);
    return dest;
}

/**
 * Runs the translator on one downloaded chapter (OCR on this PC's GPU, then
 * Gemini). Its main steps are shown in the worker log.
 */
function translateChapter(series, chapter) {
    return new Promise((resolve, reject) => {
        const child = track(spawn(process.execPath, ['--no-warnings', '--import', 'tsx', 'src/translator/cli.ts', series, chapter], {
            cwd: ROOT,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        }));
        writePidFile();
        let lastError = '';
        const onData = chunk => {
            for (const raw of chunk.toString().split(/\r?\n/)) {
                const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
                const m = line.match(/\[(info|warn|error)\]:\s*(.*)$/);
                if (!m) {
                    if (/error/i.test(line)) lastError = line;
                    continue;
                }
                const msg = m[2].replace(/^\[[^\]]+\]\s*/, '');
                if (m[1] === 'error') lastError = msg;
                if (/^OCR \S+: \d+/.test(msg)) status(`  ${c.gray(`↳ ${msg}`)}`);
                else if (/OCR done|translating|polish pass|^blocks:|rendered|still untranslated/.test(msg) || m[1] !== 'info') {
                    log(`  ${m[1] === 'info' ? c.gray(`↳ ${msg}`) : c.yellow(`⚠ ${msg}`)}`);
                }
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', reject);
        child.on('exit', code => (code === 0
            ? resolve()
            : reject(new Error(`Translation failed (exit ${code})${lastError ? `: ${lastError.slice(0, 300)}` : ''}`))));
    });
}

let currentJob = null;

async function processJob(job) {
    currentJob = job;
    const p = job.payload;
    say('');
    log(`${c.bold(c.cyan('⬇'))} ${c.bold(p.title)} chapter ${c.bold(p.chapter_number)} ${c.gray(`from ${p.source_id} · job #${job.id} · ${p.reason} · try ${job.attempts}/${job.max_attempts}`)}`);

    let lost = false;
    const keepAlive = setInterval(() => {
        mt('POST', `/jobs/${job.id}/heartbeat`, { worker: WORKER, ttl: JOB_TTL }, { waitOffline: false })
            .catch(error => { if (error.lost) lost = true; });
    }, 120_000);
    mt('POST', '/heartbeat', { worker: WORKER, info: { current: `${p.title} ch ${p.chapter_number}` } }, { waitOffline: false }).catch(() => {});

    try {
        // 1. Download.
        await ensureServer();
        const incoming = path.join(INCOMING, String(job.id));
        removeQuietly(incoming);
        const download = await api('POST', '/api/v1/downloads', {
            sourceId: p.source_id,
            mangaUrl: p.series_url,
            chapterIds: [p.chapter_id],
            format: 'images',
            downloadPath: incoming,
        });
        const [result] = await follow([download.id], p.title, '  ');
        if (result.status !== 'completed') throw new Error(result.error || `Download ${result.status}`);
        const found = findIncomingChapter(incoming, p.chapter_number);
        if (!found) throw new Error(`Downloaded, but no chapter folder was written under ${incoming}.`);
        const dir = await placeChapter(found);
        removeQuietly(incoming);
        const series = found.series;
        const chapter = found.chapter;
        if (lost) throw new LostJobError('Lease lost while downloading.');

        // 2. Translate.
        log(`  ${c.cyan('✎')} Translating ${series} ${chapter}…`);
        const translateStarted = Date.now();
        await translateChapter(series, chapter);
        const { dir: translatedDir, files } = translatedPages(series, chapter);
        if (!files.length) throw new Error('The translator produced no pages.');
        log(`  ${c.gray(`↳ Translated in ${Math.round((Date.now() - translateStarted) / 1000)} s`)}`);
        if (lost) throw new LostJobError('Lease lost while translating.');

        // 3. Upload as an unreleased draft episode, or keep (new titles).
        let summary;
        if (job.content_id) {
            const uploaded = await uploadChapter({ series, chapter, contentId: job.content_id, episodeNumber: p.chapter_number });
            if (uploaded.exists) {
                removeLocalChapter(series, chapter);
                summary = { worker: WORKER, skipped: 'episode already on Montoon' };
            } else {
                summary = { worker: WORKER, title: series, episode_id: uploaded.episodeId, pages: uploaded.pages, bytes: uploaded.bytes };
            }
        } else {
            log(`  ${c.gray(`↳ New title, not on Montoon yet: kept in ${translatedDir}`)}`);
            summary = { worker: WORKER, title: series, pages: files.length, local_dir: translatedDir };
        }

        await mt('POST', `/jobs/${job.id}/complete`, { worker: WORKER, result: summary });
        log(c.green(`  ✔ Job #${job.id} done.`));
        return true;
    } catch (error) {
        if (error.lost) {
            log(c.yellow('  ↷ Another worker took this job over (our lease expired). Moving on.'));
            return false;
        }
        log(c.red(`  ✖ ${error.message}`));
        await mt('POST', `/jobs/${job.id}/fail`, { worker: WORKER, error: String(error.message).slice(0, 1900) })
            .then(r => log(c.gray(r.data.status === 'failed'
                ? '  ↳ Out of attempts; marked failed.'
                : '  ↳ Will be retried later.')))
            .catch(() => {});
        return false;
    } finally {
        currentJob = null;
        clearInterval(keepAlive);
        mt('POST', '/heartbeat', { worker: WORKER, info: { current: null } }, { waitOffline: false }).catch(() => {});
    }
}

// ------------------------------------------------------------- stopping

/** storage/worker.pid: this worker and its child processes, for `download --stop`. */
const PID_FILE = path.join(path.dirname(DIRS.downloads), 'worker.pid');

function writePidFile() {
    try {
        writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, children: childPids(), worker: WORKER, at: new Date().toISOString() }));
    } catch { /* not critical */ }
}

function removePidFile() {
    try {
        const saved = JSON.parse(readFileSync(PID_FILE, 'utf8'));
        if (saved.pid === process.pid) unlinkSync(PID_FILE);
    } catch { /* already gone */ }
}

/**
 * download --stop: ends the worker on this PC and everything it started,
 * from any terminal. Its current job goes back to the queue when its lease
 * runs out (or right away if the worker could still report it).
 */
export function stopLocalWorker() {
    let saved;
    try {
        saved = JSON.parse(readFileSync(PID_FILE, 'utf8'));
    } catch {
        say(c.gray('No worker is running on this PC (no storage/worker.pid).'));
        return;
    }
    for (const pid of [saved.pid, ...(saved.children || [])]) killTree(pid);
    try { unlinkSync(PID_FILE); } catch { /* fine */ }
    say(c.green(`Stopped worker "${saved.worker}" (process ${saved.pid}) and its child processes.`));
}

/**
 * Ctrl+C (or closing the window): stop now. Kill the translator and engine
 * process trees, hand the current job back to the queue, and exit. Waiting
 * for the job to finish isn't an option: with `npm run`, npm exits on the
 * first Ctrl+C and PowerShell takes the keyboard back, so a second Ctrl+C
 * would never reach this process.
 */
function installStopHandler() {
    let stopping = false;
    const stop = async signal => {
        if (stopping) return;
        stopping = true;
        say('');
        log(c.yellow(`Stopping now (${signal})…`));
        killChildren();
        const job = currentJob;
        if (job) {
            // Back to the queue right away instead of after the lease expires.
            await Promise.race([
                mt('POST', `/jobs/${job.id}/fail`, { worker: WORKER, error: `Stopped on ${WORKER} (${signal}).` }, { waitOffline: false })
                    .then(() => log(c.gray(`  ↳ Job #${job.id} returned to the queue.`)))
                    .catch(() => {}),
                sleep(4000),
            ]);
        }
        removePidFile();
        process.exit(130);
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(signal, () => stop(signal));
}

// ------------------------------------------------------------- commands

export async function workerStatus() {
    const { data } = await mt('GET', '/status', undefined, { waitOffline: false });
    const jobs = data.jobs || {};
    say(c.bold(c.cyan('▶ Montoon worker status')));
    say(`  ${data.settings.enabled ? c.green('Running') : c.yellow('Paused')} · plan every ${data.settings.plan_every_minutes} min · `
        + `${data.settings.new_titles_per_day} new titles/day (${data.picked_today} today) · first ${data.settings.first_chapters} chapters · storage ${data.storage}`);
    say(`  Jobs: ${c.yellow(jobs.queued || 0)} queued · ${c.cyan(jobs.running || 0)} running · ${c.green(jobs.done || 0)} done · ${c.red(jobs.failed || 0)} failed`);
    for (const w of data.workers) {
        const ago = Math.round((Date.now() - Date.parse(w.last_seen)) / 60000);
        say(`  ${ago <= 5 ? c.green('●') : c.gray('○')} ${c.bold(w.name)} ${c.gray(`last seen ${ago} min ago`)}`);
    }
}

export async function setWorkerEnabled(enabled) {
    await mt('PUT', '/settings', { enabled }, { waitOffline: false });
    say(enabled ? c.green('Workers resumed.') : c.yellow('Workers paused. They finish their current job, then wait.'));
}

export async function runWorker(opts) {
    montoonConfig(); // fails early without a token
    say(c.bold(c.cyan(`▶ Montoon worker "${WORKER}"`)) + c.gray(` · files in ${DIRS.downloads}`));
    say(c.gray('  Ctrl+C stops it now (the current job goes back to the queue). From another terminal: download --stop'));

    installStopHandler();
    writePidFile();
    process.once('exit', removePidFile);

    const stopEngine = await ensureServer();
    writePidFile();
    let idle = false, paused = false, done = 0;
    try {
        for (;;) {
            const settings = (await mt('POST', '/heartbeat', { worker: WORKER, info: { platform: process.platform, done } })).data.settings;
            if (!settings.enabled) {
                if (!paused) log(c.yellow('⏸ Paused from the server. Waiting…'));
                paused = true;
                await sleep(60_000);
                continue;
            }
            if (paused) log(c.green('▶ Resumed.'));
            paused = false;

            if (!opts.noPlan) {
                await maybePlan(settings, opts).catch(error => log(c.red(`✖ Planning failed: ${error.message}`)));
            }

            const claimed = await mt('POST', '/jobs/claim', { worker: WORKER, limit: 1, ttl: JOB_TTL });
            const job = claimed.data[0];
            if (!job) {
                if (opts.once) break;
                if (!idle) log(c.gray('Queue is empty. Checking again every minute…'));
                idle = true;
                await sleep(60_000);
                continue;
            }
            idle = false;
            if (await processJob(job)) done++;
        }
    } finally {
        stopEngine();
    }
    log(c.bold(`Stopped. ${count(done, 'chapter')} done this session.`));
}
