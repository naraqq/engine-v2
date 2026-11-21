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
import { ROOT, api, c, chapterNumber, childPids, describeNumbers, ensureServer, fail, follow, killChildren, killTree, normalize, say, sleep, status, track } from './cli.mjs';
import { fetchMontoonTitles, findOnSource, montoonConfig, resultUrl, syncMontoon } from './montoon.mjs';
import { LostJobError, flushEvents, log, logEvent, mt } from './montoon-api.mjs';
import { DIRS, removeLocalChapter, translatedPages, uploadChapter } from './upload.mjs';
import { stitchChapter } from './stitch.mjs';
import { ensureTitleOnMontoon } from './title-maker.mjs';
import { findByOtherNames } from './aliases.mjs';
import { resolveGenre, sourceHasGenre, titleHasGenre } from './genres.mjs';

const WORKER = (process.env.WORKER_NAME || os.hostname()).replace(/[^\w.-]+/g, '-').slice(0, 56);
const JOB_TTL = 900; // seconds a claimed job stays ours without a heartbeat
/** Searched in this order; weebcentral and then mangaread only for titles the first two don't have (mangaread pages carry a watermark). */
const EPISODE_SITES = 'asurascans,manga18fx,weebcentral,mangaread,kingofshojo';

const count = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * How many chapters of a new title to queue up front: enough for its launch
 * (Montoon holds a new title until launch_episodes are translated, then
 * releases launch_drop of them at once), never fewer than first_chapters.
 */
const firstChapterCount = settings => Math.max(settings.first_chapters || 0, settings.launch_episodes || 0) || 5;

// ---------------------------------------------------------------- planner

/**
 * Plans when this worker gets the planner lock and a plan is due. With a
 * genre (--genre drama) it plans that genre only, under its own lock, so
 * genre workers and normal workers each keep their own schedule.
 * Returns true when it planned.
 */
async function maybePlan(settings, opts, genre = null) {
    const name = genre ? `planner:${genre.slug}` : 'planner';
    const lease = (await mt('POST', '/lease', { name, worker: WORKER, ttl: 3600 })).data;
    if (!lease.acquired) return false;
    const lastRun = lease.value?.last_run ? Date.parse(lease.value.last_run) : 0;
    const due = Date.now() - lastRun >= settings.plan_every_minutes * 60_000;
    if (!due && !opts.planNow) {
        await mt('POST', '/lease/release', { name, worker: WORKER });
        return false;
    }
    opts.planNow = false;

    say('');
    log(c.bold(c.cyan(`▶ Planning${genre ? ` ${genre.slug} only` : ''} (this worker holds the ${name} lock; next plan in ${settings.plan_every_minutes} min)`)));
    const summary = genre ? { genre: genre.slug } : {};
    try {
        summary.episodes = await planEpisodes(genre);
    } catch (error) {
        log(c.red(`✖ Episode check failed: ${error.message}`));
    }
    try {
        summary.new_titles = await planNewTitles(settings, genre);
    } catch (error) {
        log(c.red(`✖ New-title search failed: ${error.message}`));
    }
    await mt('POST', '/lease/release', {
        name,
        worker: WORKER,
        value: { last_run: new Date().toISOString(), by: WORKER, summary },
    });
    const ep = summary.episodes, nt = summary.new_titles;
    const parts = [];
    if (ep) {
        parts.push(`${count(ep.titles ?? 0, 'title')} with ${count(ep.episodes ?? 0, 'new episode')} queued`);
        if (ep.not_found) parts.push(`${ep.not_found} not found${ep.not_found_titles?.length ? ` (${ep.not_found_titles.slice(0, 5).join(', ')})` : ''}`);
        if (ep.failed) parts.push(`${ep.failed} couldn't be checked`);
        if (ep.removed_jobs) parts.push(`${count(ep.removed_jobs, 'outdated job')} removed`);
    } else {
        parts.push('episode check failed');
    }
    if (nt) parts.push(nt.picked ? `${count(nt.picked, 'new title')} picked` : 'no new titles picked');
    logEvent('plan', `Plan${genre ? ` (${genre.slug} only)` : ''}: ${parts.join('; ')}`, { level: ep ? 'info' : 'error', data: summary });
    log(c.bold(c.cyan('▶ Planning done. Back to downloading.')));
    say('');
    return true;
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
async function planEpisodes(genre = null) {
    log(c.cyan(`▶ Checking Montoon ${genre ? `${genre.slug} ` : ''}titles for new episodes`));
    const checked = [];
    const totals = await syncMontoon({
        from: EPISODE_SITES,
        format: 'images',
        filter: genre ? { test: t => titleHasGenre(t, genre.slug), label: `in ${genre.slug}` } : undefined,
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
/**
 * Picked titles that aren't on Montoon yet always keep their first-chapter
 * jobs: if those were removed (e.g. "Clear queue"), queue them again.
 * Queuing is idempotent by key, so existing jobs are left alone.
 */
async function requeueOrphanedPicks(registry, settings, genre = null) {
    const waiting = registry.data
        .filter(t => t.decision === 'picked' && !t.content_id && (!genre || t.meta?.genre === genre.slug))
        .slice(0, 30);
    let created = 0;
    for (const t of waiting) {
        try {
            const site = await api('GET', `/api/v1/sources/${t.source_id}`);
            const url = t.series_url.replace(/\/+$/, '');
            const first = (await api('GET', `/api/v1/sources/${site.id}/manga/${encodeURIComponent(url)}/chapters`))
                .map(ch => ({ ...ch, number: chapterNumber(ch) }))
                .filter(ch => Number.isFinite(ch.number))
                .sort((a, b) => a.number - b.number)
                .slice(0, firstChapterCount(settings));
            const result = await queueJobs(first.map(chapter => chapterJob({
                site, url, chapter, title: t.title, workerTitleId: t.id, priority: 60, reason: 'new title',
            })));
            if (result.created) {
                created += result.created;
                log(c.cyan(`  ⇢ Queued the first chapters of "${t.title}" again (${result.created} jobs were missing).`));
            }
        } catch (error) {
            log(c.yellow(`  ⚠ Couldn't requeue "${t.title}": ${error.message}`));
        }
    }
    if (created) logEvent('note', `Requeued ${count(created, 'missing first-chapter job')} for picked titles not on Montoon yet`, { level: 'warning' });
    return created;
}

// ------------------------------------------------------- admin requests

/** The engine source for a site's host name (any connector), or null. */
async function sourceForUrl(url) {
    const host = new URL(url).hostname.replace(/^www\./, '');
    for (let page = 1; page < 20; page++) {
        const batch = await api('GET', `/api/v1/sources?page=${page}&limit=100`);
        const hit = batch.find(s => {
            try { return new URL(s.url).hostname.replace(/^www\./, '') === host; } catch { return false; }
        });
        if (hit) return hit;
        if (batch.length < 100) break;
    }
    if (/asuracomic\.net|asura\.gg|asuratoon\.com/.test(host)) return api('GET', '/api/v1/sources/asurascans');
    return null;
}

/**
 * Where a requested title lives: a pasted link, or an exact title match on
 * the episode sites (whose page has chapters). Returns { site, url, title,
 * chapters } or { candidates } when nothing matches.
 */
export async function resolveTitleRequest(query) {
    const readChapters = async (site, url) => (await api('GET', `/api/v1/sources/${site.id}/manga/${encodeURIComponent(url)}/chapters`))
        .map(ch => ({ ...ch, number: chapterNumber(ch) }))
        .filter(ch => Number.isFinite(ch.number))
        .sort((a, b) => a.number - b.number);

    if (/^https?:\/\//i.test(query)) {
        const site = await sourceForUrl(query);
        if (!site) return { candidates: [], reason: `No connector for ${new URL(query).hostname}.` };
        const u = new URL(query);
        const url = new URL(u.pathname.replace(/\/+$/, '').replace(/\/chapter[-_/][^/]*$/i, '').replace(/\/+$/, ''), site.url).href;
        const chapters = await readChapters(site, url);
        if (!chapters.length) return { candidates: [], reason: `No chapters found at ${url}.` };
        const info = await api('GET', `/api/v1/sources/${site.id}/info?url=${encodeURIComponent(url)}`).catch(() => null);
        return { site, url, title: info?.title || decodeURIComponent(url.split('/').filter(Boolean).pop()), chapters };
    }

    const candidates = [];
    const sites = [];
    for (const id of EPISODE_SITES.split(',')) {
        const site = await api('GET', `/api/v1/sources/${id}`).catch(() => null);
        if (!site) continue;
        sites.push(site);
        const { matches, candidates: closest } = await findOnSource(site, query).catch(() => ({ matches: [], candidates: [] }));
        for (const match of matches) {
            const url = resultUrl(match.id, site);
            const chapters = await readChapters(site, url).catch(() => []);
            if (chapters.length) return { site, url, title: match.title, chapters };
        }
        candidates.push(...closest.slice(0, 3).map(t => `${t} (${site.title})`));
    }

    // Under another name? (MangaUpdates knows them all.) Without a Montoon
    // poster to compare, a hit counts only when one series answers to the name.
    const other = await findByOtherNames({
        names: [query], cover: null, tried: [query], sites,
        read: readChapters,
        search: async (site, name) => (await findOnSource(site, name)).matches,
        toUrl: (match, site) => resultUrl(match.id, site),
        say: text => log(text),
    }).catch(() => null);
    if (other?.url) return { site: other.site, url: other.url, title: other.title, chapters: other.chapters };
    if (other?.candidates?.length) {
        return { candidates: other.candidates, reason: `Found under other names, but several series are called "${query}": ${other.candidates.slice(0, 5).join(' · ')}. Paste the series link to pick one.` };
    }
    return { candidates };
}

/** Pending "Translate a title" requests from admin: find, queue first, report. */
async function handleTitleRequests(settings) {
    let pending;
    try {
        pending = await mt('GET', '/title-requests/pending', undefined, { waitOffline: false });
    } catch {
        return; // backend without this feature, or offline
    }
    const priority = pending.priority || 200;
    for (const r of pending.data || []) {
        const report = body => mt('POST', `/title-requests/${r.id}`, { worker: WORKER, ...body }, { waitOffline: false }).catch(() => {});
        say('');
        log(c.bold(c.cyan(`▶ Admin asked to translate "${r.query}"`)));
        try {
            const found = await resolveTitleRequest(r.query);
            if (!found.site) {
                const message = found.reason || `No exact title match on ${EPISODE_SITES.replace(/,/g, ', ')}.`
                    + (found.candidates?.length ? ` Closest: ${found.candidates.slice(0, 6).join(' · ')}. Paste the series link to be sure.` : ' Paste the series link instead.');
                log(c.red(`  ✖ ${message}`));
                await report({ status: 'not_found', message });
                continue;
            }

            const montoon = await fetchMontoonTitles(montoonConfig(), '?renewed=all');
            const existing = montoon.find(t => normalize(t.title) === normalize(found.title) || normalize(t.title_mn) === normalize(found.title));
            if (existing) {
                const message = `"${found.title}" is already on Montoon as #${existing.id}${existing.latest_episode !== null ? ` (up to episode ${existing.latest_episode})` : ''}. New episodes come through the normal check.`;
                log(c.yellow(`  ↷ ${message}`));
                await report({ status: 'exists', message, source_id: found.site.id, series_url: found.url, title: found.title, content_id: existing.id });
                continue;
            }

            const saved = (await mt('POST', '/titles', {
                items: [{
                    source_id: found.site.id,
                    series_url: found.url,
                    title: found.title,
                    origin: 'admin',
                    decision: 'picked',
                    reason: `Requested by ${r.requested_by || 'admin'}`,
                    meta: { chapters: found.chapters.length, newest: found.chapters.at(-1)?.number, request_id: r.id },
                }],
            })).data[0];
            const first = found.chapters.slice(0, r.chapters || firstChapterCount(settings));
            const queued = await queueJobs(first.map(chapter => chapterJob({
                site: found.site, url: found.url, chapter, title: found.title,
                workerTitleId: saved.id, priority, reason: 'admin request',
            })));
            const message = `Found on ${found.site.title} (${found.chapters.length} chapters). Chapters ${first[0].number}–${first.at(-1).number} queued ahead of everything else.`;
            log(c.green(`  ✔ "${found.title}": ${message}`));
            logEvent('title_picked', `Admin request "${r.query}" → "${found.title}" on ${found.site.title}: ${count(first.length, 'chapter')} queued first`, {
                data: { request_id: r.id, source_id: found.site.id, url: found.url },
            });
            await report({
                status: 'queued', message, source_id: found.site.id, series_url: found.url, title: found.title,
                worker_title_id: saved.id, jobs_queued: queued.created + queued.existing,
            });
        } catch (error) {
            log(c.red(`  ✖ ${error.message}`));
            await report({ status: 'failed', message: String(error.message).slice(0, 900) });
        }
    }
}

async function planNewTitles(settings, genre = null) {
    const registry = await mt('GET', '/titles?limit=2000');
    const requeued = await requeueOrphanedPicks(registry, settings, genre);
    const quota = settings.new_titles_per_day - registry.picked_today;
    log(c.cyan(`▶ Looking for new ${genre ? `${genre.slug} ` : ''}titles (${registry.picked_today}/${settings.new_titles_per_day} picked today)`));
    if (quota <= 0) {
        log(c.gray('  Today\'s limit is reached. Skipping.'));
        return { picked: 0, requeued };
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
    let pool = [...candidates.values()].sort((a, b) => formulaScore(b) - formulaScore(a));
    if (genre) {
        // Only the genre: each candidate's own genre tags, from its page.
        const inGenre = [];
        for (const entry of pool.slice(0, 40)) {
            if (inGenre.length >= 15) break;
            status(c.gray(`  ↳ Reading the genres of "${entry.title}"…`));
            const info = await api('GET', `/api/v1/sources/${entry.site.id}/info?url=${encodeURIComponent(entry.url)}`).catch(() => null);
            entry.genres = info?.genres || [];
            if (sourceHasGenre(entry.genres, genre.slug)) inGenre.push(entry);
        }
        log(c.gray(`  ↳ ${count(inGenre.length, `${genre.slug} title`)} among the ${Math.min(pool.length, 40)} strongest candidates.`));
        pool = inGenre;
    }
    pool = pool.slice(0, 15);
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
                // Picked by a genre worker: its jobs are that worker's to take.
                ...(genre ? { genre: genre.slug, source_genres: r.entry.genres } : {}),
            },
        })),
    })).data;
    const idByUrl = new Map(saved.map(t => [t.series_url, t.id]));

    for (const r of ranked.slice(0, 8)) {
        const picked = pickedUrls.has(r.entry.url);
        const line = `${picked ? c.green('★ Picked') : c.gray('· Passed')} ${c.bold(r.entry.title)} ${c.gray(`(${r.entry.site.title}, ${r.entry.chapterCount} ch, score ${Math.round(r.score)})`)}`;
        log(`  ${line}${r.reason ? c.gray(` ${r.reason}`) : ''}`);
    }

    for (const r of ranked.filter(r => pickedUrls.has(r.entry.url))) {
        logEvent('title_picked', `Picked "${r.entry.title}" (${r.entry.site.title}, ${r.entry.chapterCount} chapters, score ${Math.round(r.score)})${r.reason ? `: ${r.reason}` : ''}`, {
            data: { source_id: r.entry.site.id, url: r.entry.url, origins: r.entry.origins, requests: r.entry.requests, trending_rank: r.entry.trendingRank, ranked_by: r.by },
        });
    }

    let queued = 0;
    for (const pick of picks) {
        const first = pick.entry.chapters.slice(0, firstChapterCount(settings));
        const result = await queueJobs(first.map(chapter => chapterJob({
            site: pick.entry.site,
            url: pick.entry.url,
            chapter,
            title: pick.entry.title,
            workerTitleId: idByUrl.get(pick.entry.url) ?? null,
            // Above the episodes of less-read series, so a new title gets
            // its first chapters within hours instead of after the backlog.
            priority: 60,
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
/** Sources whose images are uploaded as they are, not joined into tall pages. */
const KEEP_IMAGES = new Set(['asurascans']);

async function placeChapter(found, sourceId) {
    const dest = path.join(DIRS.downloads, found.series, found.chapter);
    for (const root of [DIRS.downloads, DIRS.translations, DIRS.work]) {
        rmSync(path.join(root, found.series, found.chapter), { recursive: true, force: true });
    }
    const { before, after } = await stitchChapter(found.dir, dest, { keep: KEEP_IMAGES.has(sourceId) });
    if (after !== before) log(`  ${c.gray(`↳ Joined ${before} strips into ${after} pages`)}`);
    return dest;
}

/**
 * Runs the translator on one downloaded chapter (OCR on this PC's GPU, then
 * Gemini). Its main steps are shown in the worker log.
 */
function translateChapters(series, chapters) {
    return new Promise((resolve, reject) => {
        const child = track(spawn(process.execPath, ['--no-warnings', '--import', 'tsx', 'src/translator/cli.ts', series, ...chapters], {
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
                else if (/OCR done|skipped locally|translating|translated in|polish pass|^blocks:|rendered|still untranslated|calls,/.test(msg) || m[1] !== 'info') {
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

/**
 * Chapters claimed at once. A title's chapters in one claim are translated
 * together (fewer requests, and context carries from chapter to chapter).
 */
const BATCH_CHAPTERS = Math.min(10, Math.max(1, Number(process.env.WORKER_BATCH_CHAPTERS) || 5));

/** Jobs this worker holds right now (handed back on Ctrl+C). */
let currentJobs = [];

/** Downloads one job's chapter into storage/downloads. Returns { series, chapter }. */
async function downloadJob(job) {
    const p = job.payload;
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
    await placeChapter(found, p.source_id);
    removeQuietly(incoming);
    return { series: found.series, chapter: found.chapter };
}

/** The engine's folder name for a series (SanitizeFileName in src/engine/StorageController.ts). */
function seriesFolder(title) {
    const lookup = { '<': '＜', '>': '＞', ':': '꞉', '"': '＂', '/': '／', '\\': '＼', '|': '｜', '?': '？', '*': '＊', '~': '～' };
    return String(title)
        .replace(/[\u0000-\u001F\u007F-\u009F]/gu, '')
        .replace(/./g, ch => lookup[ch] ?? ch)
        .replace(/[\s.]+$/, '')
        .trim() || 'untitled';
}

const IMAGE_FILE = /\.(jpe?g|png|webp|avif|gif)$/i;

/**
 * A chapter this PC already translated in full, kept because its title
 * wasn't on Montoon yet. When the title is created, the server puts such
 * jobs back in the queue; they go straight to upload, with no download and
 * no second (paid) translation. Complete = a translated page for every
 * downloaded page, so a run cut off mid-render is translated again.
 */
function keptChapter(job) {
    const series = seriesFolder(job.payload.title);
    const chapter = `chapter-${job.payload.chapter_number}`;
    const { files } = translatedPages(series, chapter);
    if (!files.length) return null;
    const source = path.join(DIRS.downloads, series, chapter);
    const pages = existsSync(source) ? readdirSync(source).filter(f => IMAGE_FILE.test(f)).length : 0;
    return pages && files.length >= pages ? { series, chapter } : null;
}

/**
 * Uploads one translated chapter as an unreleased draft episode and completes its job.
 * Returns { contentId, titleError }. If adding a new title to Montoon fails, the
 * chapter is kept on this PC and the job completed anyway: the failure is the
 * server's, not the chapter's, so it must not use up the job's tries. The
 * server requeues kept chapters once the title exists.
 */
async function uploadJob(job, series, chapter, settings, { skipTitle = null } = {}) {
    const p = job.payload;
    const { dir: translatedDir, files } = translatedPages(series, chapter);
    if (!files.length) throw new Error('The translator produced no pages.');

    // A new title is first added to Montoon (house content, with metadata and posters).
    let summary;
    let contentId = job.content_id;
    let titleError = skipTitle;
    if (!contentId && !titleError && job.worker_title_id && settings?.auto_create_titles !== false) {
        try {
            contentId = await ensureTitleOnMontoon({
                workerTitleId: job.worker_title_id,
                sourceId: p.source_id,
                seriesUrl: p.series_url,
                title: p.title,
            });
        } catch (error) {
            if (error instanceof LostJobError) throw error;
            titleError = error.message;
            log(c.yellow(`  ⚠ Couldn't add the title to Montoon: ${titleError}`));
        }
    }
    if (contentId) {
        const uploaded = await uploadChapter({ series, chapter, contentId, episodeNumber: p.chapter_number });
        if (uploaded.exists) {
            removeLocalChapter(series, chapter);
            summary = { worker: WORKER, skipped: 'episode already on Montoon' };
        } else {
            summary = { worker: WORKER, title: series, episode_id: uploaded.episodeId, pages: uploaded.pages, bytes: uploaded.bytes };
        }
    } else {
        log(`  ${c.gray(`↳ New title, not on Montoon yet: kept in ${translatedDir}${titleError ? ' (uploads once the title is added)' : ''}`)}`);
        summary = { worker: WORKER, title: series, pages: files.length, local_dir: translatedDir, ...(titleError ? { title_error: String(titleError).slice(0, 500) } : {}) };
    }
    await mt('POST', `/jobs/${job.id}/complete`, { worker: WORKER, result: summary });
    log(c.green(`  ✔ ${p.title} chapter ${p.chapter_number} done (job #${job.id}).`));
    return { contentId, titleError };
}

/**
 * One claim of jobs: download each chapter, translate each title's chapters
 * together (one translator run, chapters in order), then upload them one by
 * one. A job that fails is reported on its own; the rest carry on.
 * Returns the number of chapters finished.
 */
async function processBatch(jobs, settings = null) {
    currentJobs = [...jobs];
    const lost = new Set();
    const keepAlive = setInterval(() => {
        for (const job of currentJobs) {
            mt('POST', `/jobs/${job.id}/heartbeat`, { worker: WORKER, ttl: JOB_TTL }, { waitOffline: false })
                .catch(error => { if (error.lost) lost.add(job.id); });
        }
    }, 120_000);
    const titles = [...new Set(jobs.map(j => j.payload.title))];
    mt('POST', '/heartbeat', { worker: WORKER, info: { current: `${titles.join(', ')} (${count(jobs.length, 'chapter')})` } }, { waitOffline: false }).catch(() => {});

    const release = job => { currentJobs = currentJobs.filter(j => j.id !== job.id); };
    const fail = async (job, error) => {
        release(job);
        if (error.lost || lost.has(job.id)) {
            log(c.yellow(`  ↷ Job #${job.id}: another worker took it over (our lease expired).`));
            return;
        }
        log(c.red(`  ✖ ${job.payload.title} chapter ${job.payload.chapter_number}: ${error.message}`));
        await mt('POST', `/jobs/${job.id}/fail`, { worker: WORKER, error: String(error.message).slice(0, 1900) })
            .then(r => log(c.gray(r.data.status === 'failed' ? '  ↳ Out of attempts; marked failed.' : '  ↳ Will be retried later.')))
            .catch(() => {});
    };

    let done = 0;
    try {
        // 1. Download every chapter (chapters already translated here skip ahead to upload).
        const ready = [];
        const kept = [];
        for (const job of jobs) {
            const p = job.payload;
            say('');
            log(`${c.bold(c.cyan('⬇'))} ${c.bold(p.title)} chapter ${c.bold(p.chapter_number)} ${c.gray(`from ${p.source_id} · job #${job.id} · ${p.reason} · try ${job.attempts}/${job.max_attempts}`)}`);
            const already = keptChapter(job);
            if (already) {
                log(`  ${c.gray('↳ Already translated on this PC: uploading it as is.')}`);
                kept.push({ job, ...already });
                continue;
            }
            try {
                ready.push({ job, ...(await downloadJob(job)) });
            } catch (error) {
                await fail(job, error);
            }
        }

        // 2. Translate each title's chapters together, in chapter order; 3. upload them.
        const bySeries = new Map();
        for (const item of [...kept, ...ready]) bySeries.set(item.series, [...(bySeries.get(item.series) || []), item]);
        for (const [series, items] of bySeries) {
            items.sort((a, b) => Number(a.job.payload.chapter_number) - Number(b.job.payload.chapter_number));
            const fresh = items.filter(i => !kept.includes(i));
            if (fresh.length) {
                say('');
                log(`  ${c.cyan('✎')} Translating ${series}: ${fresh.map(i => i.chapter).join(', ')}…`);
                const started = Date.now();
                try {
                    await translateChapters(series, fresh.map(i => i.chapter));
                } catch (error) {
                    for (const { job } of fresh) await fail(job, error);
                    items.splice(0, items.length, ...items.filter(i => kept.includes(i)));
                }
                if (items.some(i => !kept.includes(i))) {
                    log(`  ${c.gray(`↳ Translated ${count(fresh.length, 'chapter')} in ${Math.round((Date.now() - started) / 1000)} s`)}`);
                }
            }

            // The title is created with the first chapter; the rest of the batch joins it.
            // If creating it fails, the rest are kept too, without asking again.
            let contentId = null;
            let titleError = null;
            for (const { job, chapter } of items) {
                try {
                    if (lost.has(job.id)) throw new LostJobError('Lease lost while translating.');
                    ({ contentId, titleError } = await uploadJob(contentId && !job.content_id ? { ...job, content_id: contentId } : job, series, chapter, settings, { skipTitle: titleError }));
                    release(job);
                    done++;
                } catch (error) {
                    await fail(job, error);
                }
            }
        }
        return done;
    } finally {
        // Anything not reported yet (e.g. an unexpected error) goes back to the queue.
        for (const job of currentJobs) await fail(job, new Error('Batch stopped before this chapter finished.'));
        currentJobs = [];
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
        const jobs = currentJobs;
        if (jobs.length) {
            // Back to the queue right away instead of after the lease expires.
            await Promise.race([
                Promise.all(jobs.map(job => mt('POST', `/jobs/${job.id}/fail`, { worker: WORKER, error: `Stopped on ${WORKER} (${signal}).` }, { waitOffline: false })
                    .then(() => log(c.gray(`  ↳ Job #${job.id} returned to the queue.`)))
                    .catch(() => {}))),
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

/**
 * The titles a genre worker takes jobs for: Montoon titles in the genre, and
 * new titles a genre worker picked for it (not on Montoon yet, or created
 * with other genres by the metadata step).
 */
async function genreScope(genre) {
    const titles = await fetchMontoonTitles(montoonConfig());
    if (titles.length && !('genres' in titles[0])) {
        fail('The Montoon backend does not send title genres yet. Deploy it, then run this again.');
    }
    const picked = (await mt('GET', '/titles?decision=picked&limit=2000')).data;
    return {
        content_ids: titles.filter(t => titleHasGenre(t, genre.slug)).map(t => t.id),
        worker_title_ids: picked.filter(t => t.meta?.genre === genre.slug).map(t => t.id),
    };
}

export async function runWorker(opts) {
    montoonConfig(); // fails early without a token
    const genre = opts.genre ? await resolveGenre(opts.genre) : null;
    say(c.bold(c.cyan(`▶ Montoon worker "${WORKER}"`)) + (genre ? c.bold(c.magenta(` · ${genre.slug} only (${genre.name})`)) : '') + c.gray(` · files in ${DIRS.downloads}`));
    say(c.gray('  Ctrl+C stops it now (the current job goes back to the queue). From another terminal: download --stop'));

    installStopHandler();
    writePidFile();
    process.once('exit', removePidFile);

    const stopEngine = await ensureServer();
    writePidFile();
    let idle = false, paused = false, done = 0, lastRequestCheck = 0;
    let scope = null, scopeAt = 0;
    logEvent('worker', `${WORKER} started${genre ? ` (${genre.slug} only)` : ''}${opts.noPlan ? ' (jobs only, no planning)' : ''}`);
    try {
        for (;;) {
            const settings = (await mt('POST', '/heartbeat', { worker: WORKER, info: { platform: process.platform, done, genre: genre?.slug ?? null } })).data.settings;
            if (!settings.enabled) {
                if (!paused) log(c.yellow('⏸ Paused from the server. Waiting…'));
                paused = true;
                await sleep(60_000);
                continue;
            }
            if (paused) log(c.green('▶ Resumed.'));
            paused = false;

            let planned = false;
            if (!opts.noPlan) {
                planned = await maybePlan(settings, opts, genre).catch(error => (log(c.red(`✖ Planning failed: ${error.message}`)), false));
            }
            // Which titles' jobs to take; refreshed after a plan and every 10 minutes.
            if (genre && (planned || !scope || Date.now() - scopeAt >= 600_000)) {
                scope = await genreScope(genre);
                scopeAt = Date.now();
                if (planned || !idle) log(c.gray(`  ↳ Taking jobs of ${count(scope.content_ids.length, `Montoon ${genre.slug} title`)} and ${count(scope.worker_title_ids.length, 'new pick')}.`));
            }

            // Admin "Translate a title" requests: checked every 2 minutes, between jobs.
            if (Date.now() - lastRequestCheck >= 120_000) {
                lastRequestCheck = Date.now();
                await handleTitleRequests(settings).catch(error => log(c.red(`✖ Title requests failed: ${error.message}`)));
            }

            const claimed = await mt('POST', '/jobs/claim', { worker: WORKER, limit: BATCH_CHAPTERS, ttl: JOB_TTL, ...(scope || {}) });
            const jobs = claimed.data;
            if (scope && jobs.some(j => !scope.content_ids.includes(j.content_id) && !scope.worker_title_ids.includes(j.worker_title_id))) {
                // An older server ignores the filter and hands out anything: give it all back.
                await Promise.all(jobs.map(job => mt('POST', `/jobs/${job.id}/fail`, { worker: WORKER, error: `Handed back: this server cannot claim ${genre.slug} jobs only.` }).catch(() => {})));
                fail(`The Montoon backend cannot claim ${genre.slug} jobs only yet. Deploy it, then run this again.`);
            }
            if (!jobs.length) {
                if (opts.once) break;
                if (!idle) log(c.gray(`${genre ? `No ${genre.slug} jobs queued` : 'Queue is empty'}. Checking again every minute…`));
                idle = true;
                await sleep(60_000);
                continue;
            }
            idle = false;
            done += await processBatch(jobs, settings);
        }
    } finally {
        stopEngine();
        logEvent('worker', `${WORKER} stopped after ${count(done, 'chapter')} this session`);
        await flushEvents().catch(() => {});
    }
    log(c.bold(`Stopped. ${count(done, 'chapter')} done this session.`));
}

// ------------------------------------------------------ one title, all of it

/** Priority of download --translate jobs: above admin requests (200) and everything the planner queues. */
const TRANSLATE_PRIORITY = 300;

/**
 * The Montoon title a query names: its ID, or exactly its English or
 * Mongolian name. null when there is none; fails when several share the name.
 */
function montoonTitleFor(query, titles) {
    if (/^\d+$/.test(query)) {
        return titles.find(t => String(t.id) === query) || fail(`There is no Montoon title #${query}.`);
    }
    if (/^https?:\/\//i.test(query)) return null;
    const wanted = normalize(query);
    const exact = titles.filter(t => normalize(t.title) === wanted || normalize(t.title_mn) === wanted);
    if (exact.length > 1) {
        fail(`Several Montoon titles are called "${query}": ${exact.map(t => `#${t.id} ${t.title || t.title_mn}`).join(' · ')}. Pass the ID instead.`);
    }
    return exact[0] || null;
}

/**
 * Where one title's chapters come from and which of them to translate:
 * everything after Montoon's last episode for a title Montoon has (found the
 * same way as the episode check, saved links included), or every chapter of
 * a new one.
 */
async function titleToTranslate(query) {
    const titles = await fetchMontoonTitles(montoonConfig(), '?renewed=all');
    // `genres` in the feed came with the server's one-title claim: without it,
    // claiming would hand out other titles' jobs.
    if (titles.length && !('genres' in titles[0])) {
        fail('montoon.mn runs an older backend that cannot claim one title\'s jobs. Deploy montoon_backend (0f93ef0 or newer), then run this again.');
    }
    let existing = montoonTitleFor(query, titles);

    if (existing && existing.latest_episode !== null) {
        if (!existing.translation_renewed) {
            fail(`"${existing.title || existing.title_mn}" (#${existing.id}) is an old translation; new episodes aren't added to those.`);
        }
        let found = null;
        await syncMontoon({
            onlyId: existing.id,
            from: EPISODE_SITES,
            format: 'images',
            dryRun: true,
            onChecked: checked => { found = checked; },
        }, DIRS.downloads);
        if (!found) fail(`Couldn't read "${existing.title || existing.title_mn}" on ${EPISODE_SITES}. Link it with: download --montoon --link ${existing.id} <series url>`);
        return { site: found.site, url: found.url, title: existing.title || existing.title_mn, chapters: found.chapters, contentId: existing.id, workerTitleId: null };
    }

    say(c.cyan(`▶ Looking for "${query}" on ${EPISODE_SITES.replace(/,/g, ', ')}…`));
    const found = await resolveTitleRequest(query);
    if (!found.site) {
        fail(found.reason || `No exact title match for "${query}".`
            + (found.candidates?.length ? ` Closest: ${found.candidates.slice(0, 6).join(' · ')}.` : '')
            + ' Pass the series link instead.');
    }
    say(c.green(`  ✓ "${found.title}" on ${found.site.title}: ${count(found.chapters.length, 'chapter')}`) + c.gray(` → ${found.url}`));
    existing ||= titles.find(t => normalize(t.title) === normalize(found.title) || normalize(t.title_mn) === normalize(found.title));
    if (existing) {
        const have = existing.latest_episode;
        say(c.gray(`  ↳ Already on Montoon as #${existing.id} (${have === null ? 'no episodes yet' : `up to episode ${have}`}).`));
        return {
            site: found.site, url: found.url, title: existing.title || found.title,
            chapters: have === null ? found.chapters : found.chapters.filter(ch => ch.number > have),
            contentId: existing.id, workerTitleId: null,
        };
    }
    say(c.gray('  ↳ Not on Montoon yet: added as a new title with its first translated chapter.'));
    return { site: found.site, url: found.url, title: found.title, chapters: found.chapters, contentId: null, workerTitleId: null, isNew: true };
}

/**
 * download --translate "<title, Montoon ID or series link>"
 *
 * Translates one title up to its newest chapter and nothing else: no
 * planning, no other titles. Its chapters go into the shared queue as normal
 * jobs (so the admin page shows them and uploads are scheduled as usual),
 * and this worker claims only those. Other workers may help with them.
 */
export async function translateTitle(opts) {
    const query = String(opts.translate || '').trim();
    if (!query) fail('Usage: download --translate "<title, Montoon ID or series link>"');
    montoonConfig();

    installStopHandler();
    writePidFile();
    process.once('exit', removePidFile);
    const stopEngine = await ensureServer();
    writePidFile();
    let done = 0;
    try {
        const { settings } = (await mt('POST', '/heartbeat', { worker: WORKER, info: { platform: process.platform, done } })).data;
        const target = await titleToTranslate(query);

        let chapters = target.chapters;
        if (opts.range) {
            const [from, to] = opts.range;
            chapters = chapters.filter(ch => ch.number >= Math.min(from, to) && ch.number <= Math.max(from, to));
        }
        say('');
        if (!chapters.length) {
            say(opts.range
                ? c.yellow(`■ None of the ${count(target.chapters.length, 'chapter')} still to translate (${describeNumbers(target.chapters.map(ch => ch.number))}) is in that range.`)
                : c.green(`✓ "${target.title}" has nothing to translate: Montoon is up to date.`));
            return;
        }
        say(c.bold(c.cyan(`▶ ${target.title}: ${count(chapters.length, 'chapter')} to translate (${describeNumbers(chapters.map(ch => ch.number))}) from ${target.site.title}`)));
        if (opts.dryRun) {
            say(c.gray('  Dry run: nothing queued.'));
            return;
        }

        if (target.isNew) {
            // Picked, so the worker creates it on Montoon with its first upload.
            target.workerTitleId = (await mt('POST', '/titles', {
                items: [{
                    source_id: target.site.id,
                    series_url: target.url,
                    title: target.title,
                    origin: 'admin',
                    decision: 'picked',
                    reason: `download --translate on ${WORKER}`,
                    meta: { chapters: target.chapters.length, newest: target.chapters.at(-1)?.number },
                }],
            })).data[0].id;
        }

        const jobs = chapters.map(chapter => chapterJob({
            site: target.site, url: target.url, chapter, title: target.title,
            contentId: target.contentId, workerTitleId: target.workerTitleId,
            priority: TRANSLATE_PRIORITY, reason: 'translate title',
        }));
        const queued = await queueJobs(jobs);
        say(c.gray(`  ↳ ${queued.created} jobs queued${queued.existing ? `, ${queued.existing} were already in the queue (moved to the front if still waiting)` : ''}.`));
        logEvent('note', `${WORKER}: translating "${target.title}" (${count(chapters.length, 'chapter')}) with download --translate`, {
            data: { source_id: target.site.id, url: target.url, content_id: target.contentId },
        });

        const keys = new Set(jobs.map(j => j.key));
        for (;;) {
            const claimed = (await mt('POST', '/jobs/claim', { worker: WORKER, limit: BATCH_CHAPTERS, ttl: JOB_TTL, keys: [...keys] })).data;
            if (claimed.some(job => !keys.has(job.key))) {
                // An older server ignores `keys` and hands out anything: give it all back.
                await Promise.all(claimed.map(job => mt('POST', `/jobs/${job.id}/fail`, { worker: WORKER, error: 'Handed back: this server cannot claim one title\'s jobs.' }).catch(() => {})));
                fail('The Montoon backend cannot claim one title\'s jobs yet. Deploy it, then run this again (the jobs stay queued for every worker meanwhile).');
            }
            if (!claimed.length) break;
            done += await processBatch(claimed, settings);
        }
    } finally {
        stopEngine();
        await flushEvents().catch(() => {});
    }
    say('');
    log(c.bold(`Done: ${count(done, 'chapter')} translated and uploaded on this PC.`));
    say(c.gray('  Chapters that failed, or that another worker is still on, stay in the queue and any worker retries them. See download --work --status.'));
}
