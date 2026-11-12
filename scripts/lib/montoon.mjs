/**
 * download --montoon
 *
 * Asks montoon.mn which comics it carries (renewed translations only) and the last episode it has of
 * each, finds every title on the source site (Asura Scans by default), and
 * downloads only the chapters newer than Montoon's last episode.
 *
 * Title → source links are kept in storage/montoon-links.json: matched
 * automatically on an exact title match, or set by hand with --link.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, api, c, chapterNumber, describeNumbers, ensureServer, fail, follow, normalize, say, sleep, status } from './cli.mjs';

const LINKS_FILE = path.join(ROOT, 'storage', 'montoon-links.json');

function loadLinks() {
    try {
        return existsSync(LINKS_FILE) ? JSON.parse(readFileSync(LINKS_FILE, 'utf8')) : {};
    } catch {
        fail(`${LINKS_FILE} is not valid JSON. Fix or delete it.`);
    }
}

function saveLinks(links) {
    mkdirSync(path.dirname(LINKS_FILE), { recursive: true });
    writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2) + '\n');
}

export function montoonConfig() {
    const base = (process.env.MONTOON_API_URL || 'https://montoon.mn/api').replace(/\/$/, '');
    const token = process.env.MONTOON_SYNC_TOKEN || '';
    if (!token) {
        fail('MONTOON_SYNC_TOKEN is not set. Add it to engine-v2/.env (same value as on the Montoon server).');
    }
    return { base, token, host: new URL(base).host };
}

/** [query] e.g. "?renewed=all" for every title, old translations included. */
export async function fetchMontoonTitles({ base, token }, query = '') {
    let response;
    try {
        response = await fetch(`${base}/v2/sync/titles${query}`, {
            headers: { 'X-Sync-Token': token, Accept: 'application/json' },
            signal: AbortSignal.timeout(30_000),
        });
    } catch (error) {
        fail(`Could not reach ${base} (${error.cause?.message || error.message}).`);
    }
    // Unknown routes fall through to the website, which answers 200 with HTML.
    const isJson = (response.headers.get('content-type') || '').includes('json');
    if (response.status === 404 || !isJson) fail(`${base}/v2/sync/titles does not exist yet. Deploy the backend first.`);
    const payload = await response.json().catch(() => ({}));
    if (response.status === 503) fail('Sync is not configured on the Montoon server. Set MONTOON_SYNC_TOKEN there.');
    if (response.status === 401) fail('Montoon rejected the sync token. Check MONTOON_SYNC_TOKEN matches the server.');
    if (!response.ok || !payload.success) fail(payload.message || `Montoon answered HTTP ${response.status}.`);
    return payload.data;
}

/**
 * Exact title matches only: a wrong guess would download the wrong series.
 * A site can list the same name twice (re-uploads); the caller tries each.
 */
export async function findOnSource(source, title) {
    const results = await api('GET', `/api/v1/sources/${source.id}/search?q=${encodeURIComponent(title)}&limit=50`);
    const wanted = normalize(title);
    return {
        matches: results.filter(r => normalize(r.title) === wanted),
        candidates: results.slice(0, 3).map(r => r.title),
    };
}

/** --link <montoon id> <url> and --unlink <montoon id>. */
export function editLinks(opts) {
    const links = loadLinks();
    if (opts.unlink) {
        delete links[opts.unlink];
        saveLinks(links);
        say(`Removed the link for Montoon title ${opts.unlink}. The next sync searches for it again.`);
        return;
    }
    const url = opts.query;
    if (!/^https?:\/\//.test(url)) fail('Usage: download --montoon --link <montoon id> <series url>');
    if (!/^\d+$/.test(opts.link)) fail('The Montoon title ID is a number, shown in brackets in the sync output.');
    links[opts.link] = { url, how: 'manual', linkedAt: new Date().toISOString() };
    saveLinks(links);
    say(`Linked Montoon title ${opts.link} to ${url}`);
}

const count = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// Older domains a website has used; links there still belong to it.
const FORMER_HOSTS = { asurascans: ['asuracomic.net', 'asura.gg', 'asuratoon.com'] };
const bareHost = url => {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
};

/**
 * The episode sites, by host name. Montoon's metadata links often point at
 * where a title's details came from (wikis, MangaDex, Reddit…), not where
 * its episodes come from, so only links to these sites are followed.
 */
function episodeSitesByHost(sites) {
    const byHost = new Map();
    for (const site of sites) {
        byHost.set(bareHost(site.url), site);
        for (const former of FORMER_HOSTS[site.id] || []) byHost.set(former, site);
    }
    return byHost;
}

/**
 * The series link on the website's current address: old domains moved over,
 * trailing slash and any chapter part dropped (Montoon sometimes stores a
 * chapter link, e.g. …/milf-exchange-plan-raw/chapter-46).
 */
const seriesUrl = (url, source) => {
    const u = new URL(url);
    const path = u.pathname
        .replace(/\/+$/, '')
        .replace(/\/chapter[-_/][^/]*$/i, '')
        .replace(/\/+$/, '');
    return new URL(path + u.search, source.url).href;
};

/** Search results carry the site's own ID; Madara sites use JSON {slug}. */
export function resultUrl(id, site) {
    let path = id;
    if (id.startsWith('{')) {
        try {
            path = JSON.parse(id).slug || id;
        } catch { /* not JSON after all */ }
    }
    return new URL(path, site.url).href;
}

export async function syncMontoon(opts, outDir) {
    const config = montoonConfig();

    say(c.bold(c.cyan(`▶ Fetching titles from ${config.host}…`)));
    let titles = await fetchMontoonTitles(config);
    // Old (v1) translations are being taken down: only renewed ones get new
    // episodes. The server already filters; this also covers an older server.
    if (titles.length && !('translation_renewed' in titles[0])) {
        fail('The Montoon server is running an older sync endpoint that cannot tell renewed translations apart. Deploy the backend, then run this again.');
    }
    const dropped = titles.filter(t => !t.translation_renewed).length;
    titles = titles.filter(t => t.translation_renewed);
    say(`  ${c.bold(titles.length)} comics with a renewed translation.${dropped ? c.gray(` ${dropped} old translations skipped.`) : ''}`);
    if (opts.only) {
        const needle = normalize(opts.only);
        titles = titles.filter(t => String(t.id) === opts.only
            || normalize(t.title).includes(needle)
            || normalize(t.title_mn).includes(needle));
        say(`  ${c.bold(titles.length)} match "${opts.only}".`);
    }
    if (!titles.length) return { updated: 0, pending: 0, notFound: 0, failed: 0, notFoundTitles: [], failedTitles: [] };

    const stopServer = await ensureServer();
    const totals = { withNew: 0, skipped: 0, upToDate: 0, updated: 0, chapters: 0, notFound: 0, empty: 0, failed: 0, pending: 0 };
    const perSite = new Map(); // site title -> titles checked there
    const unmatched = [];
    const broken = [];

    try {
        // Titles without a usable link are looked up on these, in order.
        const searchSites = [];
        for (const id of String(opts.from).split(',').map(s => s.trim()).filter(Boolean)) {
            searchSites.push(await api('GET', `/api/v1/sources/${encodeURIComponent(id)}`)
                .catch(() => fail(`Unknown website "${id}".`)));
        }
        const searchNames = searchSites.map(s => s.title).join(' or ');
        const sitesByHost = episodeSitesByHost(searchSites);
        const notes = [
            opts.dryRun ? 'dry run: nothing is downloaded' : null,
            opts.limit ? `cap: ${count(opts.limit, 'title')} with new episodes` : null,
        ].filter(Boolean);
        say(c.bold(c.cyan('▶ Checking each title on its own website')) + (notes.length ? c.gray(` (${notes.join(', ')})`) : ''));
        const links = loadLinks();

        for (const [index, t] of titles.entries()) {
            // The cap counts titles that had new episodes, not titles checked.
            if (opts.limit && totals.withNew >= opts.limit) {
                totals.skipped = titles.length - index;
                say('');
                say(c.yellow(`■ Reached the cap of ${count(opts.limit, 'title')}. ${count(totals.skipped, 'title')} not checked this run.`));
                break;
            }
            const name = t.title || t.title_mn;
            const have = t.latest_episode;
            say('');
            say(`${c.gray(`[${index + 1}/${titles.length}]`)} ${c.bold(name)}  ${c.gray(`(Montoon #${t.id}, ${have === null ? 'no episodes yet' : `up to episode ${have}`})`)}`);

            try {
                if (have === null) {
                    say(c.gray('  – Skipped: no episodes on Montoon yet, so there is nothing to continue from.'));
                    totals.empty++;
                    continue;
                }

                /**
                 * Chapter list of a series page; never throws. Errors that look
                 * temporary (Cloudflare, timeouts) are retried, and if they
                 * persist the result is marked `transient`, so the title counts
                 * as failed this round instead of "not found", and its link is kept.
                 */
                const tryRead = async ({ url, site }) => {
                    let last = null;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        status(c.gray(`  ↳ Reading the chapter list on ${site.title}…${attempt > 1 ? ` (try ${attempt}/3)` : ''}`));
                        try {
                            const chapters = await api('GET', `/api/v1/sources/${site.id}/manga/${encodeURIComponent(url)}/chapters`);
                            if (chapters.length || attempt === 3) return { chapters, problem: null, transient: false };
                            last = { chapters: [], problem: null, transient: false };
                        } catch (error) {
                            // Madara sites fail this way when the series page redirects away.
                            if (/is not valid JSON/.test(error.message)) {
                                return { chapters: [], problem: 'its page no longer opens (removed or redirected)', transient: false };
                            }
                            last = { chapters: [], problem: error.message, transient: true };
                        }
                        await sleep(5000 * attempt);
                    }
                    return last;
                };

                /**
                 * Title search on each site in turn. A match only counts if its
                 * page has chapters: search lists can include removed series.
                 */
                const searchAndLink = async () => {
                    const closest = [];
                    const problems = [];
                    for (const site of searchSites) {
                        status(c.gray(`  ↳ Searching ${site.title} for "${name}"…`));
                        const { matches, candidates } = await findOnSource(site, name)
                            .catch(error => (problems.push(`${site.title} search: ${error.message}`), { matches: [], candidates: [] }));
                        if (!matches.length) closest.push(...candidates);
                        for (const match of matches) {
                            const found = resultUrl(match.id, site);
                            const read = await tryRead({ url: found, site });
                            if (read.transient) problems.push(`${site.title}: ${read.problem}`);
                            if (!read.chapters.length) {
                                say(c.yellow(`  ↳ "${match.title}" is listed on ${site.title}, but ${read.problem || 'its page has no chapters'}.`));
                                continue;
                            }
                            links[t.id] = { url: found, title: match.title, how: 'auto', linkedAt: new Date().toISOString() };
                            saveLinks(links);
                            say(`  ${c.green(`✓ Found "${match.title}" on ${site.title}`)} ${c.gray(`→ ${found}`)}`);
                            return { url: found, site, chapters: read.chapters };
                        }
                    }
                    if (problems.length) {
                        // The site didn't answer properly: not the same as "not there".
                        say(c.red(`  ✖ Couldn't check this round (${problems[0]}). Tried again next plan.`));
                        broken.push(t);
                        totals.failed++;
                        return null;
                    }
                    say(c.red(`  ✖ Not available on ${searchNames}.`) + (closest.length ? c.gray(` Closest titles: ${closest.slice(0, 3).join(' · ')}`) : ''));
                    unmatched.push(t);
                    totals.notFound++;
                    return null;
                };

                // 1. Which website, and where on it? A link saved here wins,
                // otherwise a title search. Montoon's own source_url is not
                // used: it records where the title's details came from, which
                // is often not where its episodes are (or a different edition).
                const given = links[t.id]?.url || null;
                const manual = links[t.id]?.how === 'manual';
                let target = null;
                let chapters = [];
                if (given) {
                    const host = bareHost(given);
                    const site = host && sitesByHost.get(host);
                    if (site) {
                        target = { url: seriesUrl(given, site), site };
                        say(`  ${c.magenta(site.title)} ${c.gray(`↳ ${target.url}`)}`);
                        const read = await tryRead(target);
                        chapters = read.chapters;
                        if (!chapters.length && read.transient) {
                            say(c.red(`  ✖ Couldn't read the chapter list (${read.problem}). Link kept; tried again next plan.`));
                            broken.push(t);
                            totals.failed++;
                            continue;
                        }
                        if (!chapters.length) {
                            if (manual) {
                                // Your own link: report it, don't second-guess it.
                                say(c.red(`  ✖ No chapters at your linked page: ${read.problem || 'the list is empty'}.`));
                                broken.push(t);
                                totals.failed++;
                                continue;
                            }
                            say(c.yellow(`  ↳ That link doesn't work (${read.problem || 'no chapters'}). Searching by title instead.`));
                            if (links[t.id]) {
                                delete links[t.id];
                                saveLinks(links);
                            }
                            target = null;
                        }
                    } else {
                        say(c.gray(`  ↳ The saved link is on ${host || given}, which isn't an episode site. Searching instead.`));
                    }
                }
                if (!target) {
                    if (!(target = await searchAndLink())) continue;
                    chapters = target.chapters;
                }

                // 2. What's new?
                perSite.set(target.site.title, (perSite.get(target.site.title) || 0) + 1);

                const numbered = chapters
                    .map(ch => ({ ...ch, number: chapterNumber(ch) }))
                    .filter(ch => Number.isFinite(ch.number));
                const newest = numbered.length ? Math.max(...numbered.map(ch => ch.number)) : null;
                const fresh = numbered.filter(ch => ch.number > have).sort((a, b) => a.number - b.number);
                say(c.gray(`  ↳ ${target.site.title} has ${chapters.length} chapters${newest !== null ? `, newest is ${newest}` : ''}.`));
                // The title was read successfully: tell the caller what it wants now.
                opts.onChecked?.({ title: t, site: target.site, chapters: fresh });

                if (!fresh.length) {
                    say(c.green('  ✓ Up to date.'));
                    totals.upToDate++;
                    continue;
                }
                const plural = fresh.length === 1 ? 'episode' : 'episodes';
                totals.withNew++;
                say(c.bold(c.yellow(`  ★ ${fresh.length} new ${plural} found: ${describeNumbers(fresh.map(ch => ch.number))}`)));
                if (opts.dryRun) {
                    totals.pending += fresh.length;
                    totals.updated++;
                    continue;
                }
                // Worker mode: queue them for whichever worker is free.
                if (opts.enqueue) {
                    const queued = await opts.enqueue({ title: t, titles, site: target.site, url: target.url, chapters: fresh });
                    say(c.cyan(`  ⇢ Queued ${count(queued.created, 'job')}`) + (queued.existing ? c.gray(` (${queued.existing} already queued earlier${queued.updated ? `, ${queued.updated} reprioritised` : ''})`) : ''));
                    totals.pending += fresh.length;
                    totals.updated++;
                    continue;
                }

                // 3. Download them.
                say(c.cyan(`  ⬇ Downloading ${fresh.length} ${plural} from ${target.site.title}…`));
                const download = await api('POST', '/api/v1/downloads', {
                    sourceId: target.site.id,
                    mangaUrl: target.url,
                    chapterIds: fresh.map(ch => ch.id),
                    format: opts.format,
                    downloadPath: outDir,
                });
                const [result] = await follow([download.id], name, '  ');
                if (result.status === 'completed') {
                    totals.updated++;
                    totals.chapters += fresh.length;
                    say(c.gray(`  ↳ Saved to ${path.join(outDir, result.mangaTitle || '')}`));
                } else {
                    totals.failed++;
                }
            } catch (error) {
                say(c.red(`  ✖ ${error.message}`));
                totals.failed++;
            }
        }
    } finally {
        stopServer();
    }

    const n = (value, color) => (value ? color(value) : c.gray(value));
    say('');
    say(c.bold(c.cyan('▶ Summary')));
    if (opts.enqueue) {
        say(`  ${c.bold(c.green(count(totals.updated, 'title')))} with ${c.bold(c.yellow(count(totals.pending, 'new episode')))} handed to the job queue.`);
    } else if (opts.dryRun) {
        say(`  ${c.bold(c.green(count(totals.updated, 'title')))} with ${c.bold(c.yellow(count(totals.pending, 'new episode')))} waiting.`);
    } else {
        say(`  ${c.bold(c.green(count(totals.updated, 'title')))} updated, ${c.bold(c.yellow(count(totals.chapters, 'new episode')))} downloaded to ${c.gray(outDir)}`);
    }
    say('  ' + [
        `${n(totals.upToDate, c.green)} up to date`,
        `${n(totals.notFound, c.yellow)} not found`,
        `${n(totals.empty, c.gray)} without episodes`,
        `${n(totals.failed, c.red)} failed`,
        totals.skipped ? `${c.yellow(totals.skipped)} not checked (cap)` : null,
    ].filter(Boolean).join(c.gray(' · ')));
    if (perSite.size) {
        say(c.gray(`  Checked on: ${[...perSite].map(([site, k]) => `${site} (${k})`).join(', ')}`));
    }
    const fixable = [...broken, ...unmatched];
    if (fixable.length) {
        say('');
        say('  Link the right series once and it is remembered:');
        for (const t of fixable.slice(0, 10)) {
            say(`    ${c.cyan(`download --montoon --link ${t.id} <series url>`)}    ${c.gray(`# ${t.title || t.title_mn}`)}`);
        }
        if (fixable.length > 10) say(c.gray(`    …and ${fixable.length - 10} more.`));
    }
    if (totals.failed && !opts.enqueue) process.exitCode = 1;
    const label = t => `${t.title || t.title_mn} (#${t.id})`;
    return { ...totals, notFoundTitles: unmatched.map(label), failedTitles: broken.map(label) };
}
