/**
 * Finding a title on a site that lists it under another name.
 *
 * Sites name the same series differently: Montoon's "Plaything" is
 * "A Sense of Amusement" on KingOfShojo and "Her Toys" elsewhere. MangaUpdates
 * keeps every name of a series in one entry, so:
 *
 *   1. look the title up there by each name Montoon knows,
 *   2. search the episode sites for every other name of those entries,
 *   3. accept a hit only if it's provably the same series: its cover looks
 *      like Montoon's (or the MangaUpdates one), or Gemini, shown the covers,
 *      says so. A name alone isn't enough: MangaUpdates has five different
 *      series called "Plaything".
 *
 * MangaUpdates answers are cached in storage/mangaupdates-cache.json.
 */
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { ROOT, api, c, normalize, status } from './cli.mjs';
import { askJson, coverFrom, fetchImage, geminiKey } from './title-maker.mjs';

const MU = 'https://api.mangaupdates.com/v1';
const CACHE_FILE = path.join(ROOT, 'storage', 'mangaupdates-cache.json');
const CACHE_DAYS = 14;
/** Covers this close (of 64 bits) are the same picture, resized or re-encoded. */
const SAME_COVER = 12;
/** Names searched per series, so one lookup can't take an hour. */
const MAX_NAMES = 8;

/** "Plaything (Q-Boy)" → "plaything": MangaUpdates adds the author to tell same-named series apart. */
const bare = s => normalize(String(s ?? '').replace(/\s*\([^)]*\)\s*$/, ''));
/** Sites here are English; names in other scripts can't match their titles. */
const isLatin = s => (String(s).match(/[A-Za-z]/g) || []).length >= Math.max(2, String(s).replace(/\s/g, '').length * 0.6);

// ------------------------------------------------------------ MangaUpdates

let cache = null;
function store() {
    if (!cache) {
        try {
            cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};
        } catch {
            cache = {};
        }
    }
    return cache;
}

async function cached(key, days, load) {
    const hit = store()[key];
    if (hit && Date.now() - hit.at < days * 86_400_000) return hit.value;
    const value = await load();
    store()[key] = { at: Date.now(), value };
    try {
        mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        writeFileSync(CACHE_FILE, JSON.stringify(cache));
    } catch { /* the cache is only a speed-up */ }
    return value;
}

async function mu(route, body) {
    const response = await fetch(MU + route, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`MangaUpdates answered HTTP ${response.status}`);
    return response.json();
}

/**
 * MangaUpdates series one of whose names is exactly one of [names]
 * (ignoring the "(Author)" suffix), each with all its names and its cover.
 */
export async function lookupNames(names) {
    const wanted = new Set(names.map(bare).filter(n => n.length >= 2));
    const ids = new Set();
    for (const name of names.filter(Boolean).slice(0, 4)) {
        const results = await cached(`search:${normalize(name)}`, CACHE_DAYS, async () =>
            ((await mu('/series/search', { search: name, perpage: 50 })).results || []).map(r => ({
                id: String(r.record.series_id),
                title: r.record.title,
                hit: r.hit_title || null,
            })));
        for (const r of results) {
            if (wanted.has(bare(r.title)) || wanted.has(bare(r.hit))) ids.add(r.id);
        }
    }
    const entries = [];
    for (const id of [...ids].slice(0, 8)) {
        const entry = await cached(`series:${id}`, CACHE_DAYS, async () => {
            const x = await mu(`/series/${id}`);
            return {
                id,
                title: x.title,
                names: [x.title, ...(x.associated || []).map(a => a.title)].filter(Boolean),
                authors: [...new Set((x.authors || []).map(a => a.name))],
                image: x.image?.url?.original || null,
                year: x.year || null,
                type: x.type || null,
            };
        }).catch(() => null);
        if (entry && entry.names.some(n => wanted.has(bare(n)))) entries.push(entry);
    }
    return entries;
}

// ------------------------------------------------------------------ covers

/** 64-bit difference hash: survives resizing and recompression, not a different picture. */
async function dhash(buffer) {
    const px = await sharp(buffer).flatten({ background: '#ffffff' }).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
    let bits = '';
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
    }
    return bits;
}
const distance = (a, b) => [...a].reduce((n, bit, i) => n + (bit !== b[i]), 0);

async function hashOf(image) {
    try {
        return image ? await dhash(image.buffer) : null;
    } catch {
        return null;
    }
}

/** Gemini looks at the covers and says which candidate (if any) is the same series. */
async function askGemini(reference, candidates, names) {
    const key = geminiKey();
    if (!key || !reference.length) return -1;
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: key });
    const jpeg = async image => ({
        inlineData: { mimeType: 'image/jpeg', data: (await sharp(image.buffer).flatten({ background: '#ffffff' }).resize(360).jpeg({ quality: 80 }).toBuffer()).toString('base64') },
    });
    const parts = [{ text: `Is one of these candidates the same comic series as the reference? The series is known as: ${names.slice(0, 12).join(' · ')}. Covers can differ between sites (other volume art, crop, text), so judge by the characters and art style. Answer the candidate number, or -1 if none is clearly the same series.` }];
    for (const [i, image] of reference.entries()) parts.push({ text: `Reference cover ${i + 1}:` }, await jpeg(image));
    for (const [i, cand] of candidates.entries()) {
        parts.push({ text: `Candidate ${i}: "${cand.title}" on ${cand.site.title}, ${cand.chapters.length} chapters` });
        if (cand.cover) parts.push(await jpeg(cand.cover));
    }
    const answer = await askJson(ai, process.env.GEMINI_PICK_MODEL || 'gemini-3.5-flash', [{ role: 'user', parts }], {
        type: 'object',
        properties: { candidate: { type: 'integer' }, confident: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['candidate', 'confident'],
    }).catch(() => null);
    return answer?.confident && Number.isInteger(answer.candidate) && answer.candidate >= 0 && answer.candidate < candidates.length
        ? answer.candidate
        : -1;
}

// ------------------------------------------------------------------- search

/**
 * Looks for a title on [sites] under its other names.
 *
 * names     every name Montoon has for it (title first)
 * cover     Montoon's poster URL, the main proof it's the same series
 * minNewest the site must have at least this chapter (what Montoon already has)
 * tried     names already searched by the caller
 * read      (site, url) → chapters (numbers in .number), [] when unreadable
 * search    (site, name) → exact-title matches [{ id, title }]
 * toUrl     (match, site) → series URL
 *
 * Returns { site, url, title, chapters, names, mangaupdatesId, proof } or
 * { candidates: [...] } when the sites carry it under another name but
 * which one is the same series couldn't be proven.
 */
export async function findByOtherNames({ names, cover, minNewest = 0, tried = [], sites, read, search, toUrl, say = () => {} }) {
    status(c.gray('  ↳ Looking up its other names on MangaUpdates…'));
    let entries;
    try {
        entries = await lookupNames(names);
    } catch (error) {
        say(c.gray(`  ↳ MangaUpdates lookup failed (${error.message}).`));
        return null;
    }
    if (!entries.length) return null;

    const done = new Set([...tried, ...names].map(bare));
    const candidates = [];
    for (const entry of entries) {
        const others = [...new Map(entry.names.filter(isLatin).map(n => [bare(n), n.replace(/\s*\([^)]*\)\s*$/, '')])).entries()]
            .filter(([key]) => !done.has(key))
            .slice(0, MAX_NAMES)
            .map(([, name]) => name);
        if (!others.length) continue;
        say(c.gray(`  ↳ MangaUpdates: "${entry.title}"${entry.authors.length ? ` by ${entry.authors.join(', ')}` : ''} is also called ${others.map(n => `"${n}"`).join(', ')}`));
        for (const site of sites) {
            for (const name of others) {
                status(c.gray(`  ↳ Searching ${site.title} for "${name}"…`));
                const matches = await search(site, name).catch(() => []);
                for (const match of matches) {
                    const url = toUrl(match, site);
                    if (candidates.some(x => x.url === url)) continue;
                    const chapters = await read(site, url).catch(() => []);
                    const newest = Math.max(-1, ...chapters.map(ch => ch.number).filter(Number.isFinite));
                    if (!chapters.length || newest < minNewest) continue;
                    candidates.push({ site, url, title: match.title, chapters, entry });
                }
            }
        }
    }
    if (!candidates.length) return null;

    // Proof 1: the covers are the same picture.
    const reference = [];
    if (cover) reference.push(await fetchImage(cover, new URL(cover).origin + '/'));
    for (const entry of entries) if (entry.image) reference.push(await fetchImage(entry.image, 'https://www.mangaupdates.com/'));
    const refs = reference.filter(Boolean);
    const refHashes = (await Promise.all(refs.map(hashOf))).filter(Boolean);
    for (const cand of candidates) {
        status(c.gray(`  ↳ Comparing covers with "${cand.title}" on ${cand.site.title}…`));
        const info = await api('GET', `/api/v1/sources/${cand.site.id}/info?url=${encodeURIComponent(cand.url)}`).catch(() => null);
        cand.cover = await coverFrom(info, cand.url).catch(() => null);
        const hash = await hashOf(cand.cover);
        cand.distance = hash && refHashes.length ? Math.min(...refHashes.map(h => distance(h, hash))) : 64;
        say(c.gray(`  ↳ "${cand.title}" on ${cand.site.title}: ${hash ? `cover differs by ${cand.distance}/64` : 'no cover to compare'}`));
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const result = (cand, proof) => ({
        site: cand.site, url: cand.url, title: cand.title, chapters: cand.chapters, proof,
        names: cand.entry.names, mangaupdatesId: cand.entry.id,
    });
    if (candidates[0].distance <= SAME_COVER) return result(candidates[0], `same cover (${candidates[0].distance}/64 bits differ)`);

    // Proof 2: Gemini compares the covers (different art for the same series).
    const pick = await askGemini(refs, candidates.slice(0, 6), [...new Set(entries.flatMap(e => e.names))]);
    if (pick >= 0) return result(candidates[pick], 'Gemini matched the covers');

    // Proof 3: only one series answers to these names, and only one site page.
    if (entries.length === 1 && candidates.length === 1 && !cover) return result(candidates[0], 'the only series with these names');

    return { candidates: candidates.map(x => `${x.title} (${x.site.title})`) };
}

// ------------------------------------------------------------ misses

const MISS_DAYS = 3;

/** True when [contentId] was searched under its other names recently and not found. */
export function recentlyMissed(contentId) {
    const hit = store()[`miss:${contentId}`];
    return Boolean(hit && Date.now() - hit.at < MISS_DAYS * 86_400_000);
}

export function rememberMiss(contentId) {
    store()[`miss:${contentId}`] = { at: Date.now(), value: true };
    try {
        mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        writeFileSync(CACHE_FILE, JSON.stringify(cache));
    } catch { /* the cache is only a speed-up */ }
}

export { isLatin };
