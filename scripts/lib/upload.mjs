/**
 * Uploads a translated chapter to Montoon as a new, unreleased episode, then
 * removes that chapter's local folders.
 *
 *   storage/translations/<series>/<chapter>/   finished pages (uploaded)
 *   storage/downloads/<series>/<chapter>/      original pages   } removed after
 *   storage/translation-work/<series>/<chapter>/  OCR/text data } a good upload
 *
 * The episode is created as a draft with no release date (same as an admin
 * upload), so it stays hidden until it's released or scheduled in admin.
 * The series glossary in translation-work/<series>/ is kept.
 */
import path from 'node:path';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { ROOT, c, sleep, status } from './cli.mjs';
import { log, mt } from './montoon-api.mjs';

const STORAGE = process.env.STORAGE_PATH ? path.resolve(ROOT, process.env.STORAGE_PATH) : path.join(ROOT, 'storage');
export const DIRS = {
    downloads: path.join(STORAGE, 'downloads'),
    translations: path.join(STORAGE, 'translations'),
    work: path.join(STORAGE, 'translation-work'),
};

const TYPES = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

export function translatedPages(series, chapter) {
    const dir = path.join(DIRS.translations, series, chapter);
    if (!existsSync(dir)) return { dir, files: [] };
    const files = readdirSync(dir)
        .filter(f => TYPES[path.extname(f).toLowerCase()])
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return { dir, files };
}

/** "chapter-333" → 333, "chapter-12.5" → 12.5 */
export const numberFromFolder = chapter => {
    const m = String(chapter).match(/(\d+(?:\.\d+)?)\s*$/);
    return m ? Number(m[1]) : NaN;
};

/** Removes a chapter's local folders (and empty series folders, except the glossary's). */
export function removeLocalChapter(series, chapter) {
    const removed = [];
    for (const [kind, root] of Object.entries(DIRS)) {
        const dir = path.join(root, series, chapter);
        if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
            removed.push(path.relative(STORAGE, dir));
        }
        const seriesDir = path.join(root, series);
        if (kind !== 'work' && existsSync(seriesDir) && readdirSync(seriesDir).length === 0) {
            rmSync(seriesDir, { recursive: true, force: true });
        }
    }
    return removed;
}

/**
 * Upload one translated chapter. Returns { episodeId, pages } or, when the
 * episode already exists on Montoon, { exists: true }.
 */
export async function uploadChapter({ series, chapter, contentId, episodeNumber, title = null, keep = false, indent = '  ' }) {
    const { dir, files } = translatedPages(series, chapter);
    if (!files.length) throw new Error(`No translated pages in ${dir}. Translate the chapter first.`);
    const number = episodeNumber ?? numberFromFolder(chapter);
    if (!Number.isFinite(number)) throw new Error(`Can't tell the episode number from "${chapter}". Pass --episode <n>.`);

    log(`${indent}${c.cyan('⇪')} Uploading ${c.bold(`${series} ${chapter}`)} → Montoon #${contentId}, episode ${number} ${c.gray(`(${files.length} pages)`)}`);
    let prepared;
    try {
        prepared = (await mt('POST', '/episodes/prepare', {
            content_id: contentId,
            episode_number: number,
            files: files.map(f => ({ ext: path.extname(f).slice(1).toLowerCase(), content_type: TYPES[path.extname(f).toLowerCase()] })),
        }, { waitOffline: false })).data;
    } catch (error) {
        if (error.code === 'episode_exists') {
            log(`${indent}${c.yellow('↷')} ${error.message} Nothing uploaded.`);
            return { exists: true };
        }
        throw error;
    }
    log(`${indent}${c.gray(`↳ Montoon title: "${prepared.content.title}" · storage folder ${prepared.folder}/`)}`);

    const token = process.env.MONTOON_SYNC_TOKEN;
    let bytes = 0;
    for (const [i, target] of prepared.files.entries()) {
        const body = readFileSync(path.join(dir, files[i]));
        status(`${indent}${c.gray('↳ Uploading pages')} ${i + 1}/${files.length}`);
        const headers = target.via === 'api'
            ? { ...target.headers, 'X-Sync-Token': token, 'Content-Type': 'application/octet-stream' }
            : target.headers;
        for (let attempt = 1; ; attempt++) {
            try {
                const response = await fetch(target.url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(120_000) });
                if (response.ok) break;
                throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
            } catch (error) {
                if (attempt >= 3) throw new Error(`Upload of ${files[i]} failed: ${error.message}`);
                await sleep(3000 * attempt);
            }
        }
        bytes += body.length;
    }
    log(`${indent}${c.gray(`↳ ${files.length} pages uploaded (${(bytes / 1048576).toFixed(1)} MB)`)}`);

    const episode = (await mt('POST', '/episodes', {
        content_id: contentId,
        episode_number: number,
        title,
        paths: prepared.files.map(f => f.path),
    }, { waitOffline: false })).data;
    log(`${indent}${c.green(`✔ Created episode #${episode.episode_id} "${episode.title}"`)} ${c.gray('as an unreleased draft. Release or schedule it in Montoon admin.')}`);

    if (!keep) {
        const removed = removeLocalChapter(series, chapter);
        if (removed.length) log(`${indent}${c.gray(`↳ Removed local copies: ${removed.join(', ')}`)}`);
    }
    return { episodeId: episode.episode_id, pages: files.length, bytes };
}
