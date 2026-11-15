import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config/settings.js';
import { logger } from '../config/logger.js';
import { detectPage, toTextLines } from './detect.js';
import { renderPage } from './render.js';
import { isLocalJunk, loadGlossary, needsWork, polishRegions, saveGlossary, translateRegions, type Item } from './translate.js';
import type { PageResult } from './types.js';

const IMAGE_EXT = /\.(webp|png|jpe?g)$/i;

export interface ChapterOptions {
    /** Re-run OCR and translation even if JSON already exists. */
    force?: boolean;
    /** Only run local OCR, skip translation. */
    detectOnly?: boolean;
    /** Keep cached OCR but redo classification + translation from scratch. */
    retranslate?: boolean;
    /** Skip drawing the translated images. */
    noRender?: boolean;
}

async function listDirs(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export const listSeries = () => listDirs(config.storage.downloads);
export const listChapters = (series: string) => listDirs(path.join(config.storage.downloads, series));

interface LoadedChapter {
    chapter: string;
    srcDir: string;
    outDir: string;
    files: string[];
    pages: PageResult[];
    jsonPath: (file: string) => string;
}

/** Local OCR (GPU) of every page of one chapter, one page at a time. Cached pages are reused. */
async function ocrChapter(series: string, chapter: string, opts: ChapterOptions): Promise<LoadedChapter> {
    const srcDir = path.join(config.storage.downloads, series, chapter);
    const outDir = path.join(config.storage.translations, series, chapter);
    const workDir = path.join(config.storage.translationWork, series, chapter);
    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });

    const files = (await fs.readdir(srcDir)).filter(f => IMAGE_EXT.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const jsonPath = (file: string) => path.join(workDir, file.replace(IMAGE_EXT, '.json'));
    const pages: PageResult[] = [];

    const started = Date.now();
    let fresh = 0;
    for (const file of files) {
        if (!opts.force) {
            try {
                const cached = JSON.parse(await fs.readFile(jsonPath(file), 'utf8')) as PageResult;
                if (cached.version === 2) {
                    pages.push(cached);
                    continue;
                }
            } catch { /* not done yet */ }
        }
        const page = await detectPage(path.join(srcDir, file), file.replace(IMAGE_EXT, ''));
        await fs.writeFile(jsonPath(file), JSON.stringify(page, null, 2) + '\n', 'utf8');
        pages.push(page);
        fresh++;
        logger.info(`[${series}/${chapter}] OCR ${file}: ${page.regions.length} text blocks`);
    }
    logger.info(`[${series}/${chapter}] OCR done in ${Math.round((Date.now() - started) / 1000)}s (${fresh} new, ${files.length - fresh} cached)`);
    return { chapter, srcDir, outDir, files, pages, jsonPath };
}

/**
 * Several chapters of one series, translated together:
 *  1. local OCR (GPU) reads every page of every chapter;
 *  2. obvious junk (credits, URLs, colour bars, OCR noise) is skipped locally, for free;
 *  3. the rest goes to the model in a few text-only requests that span chapters, so names, voice
 *     and context carry from one chapter to the next (no images are ever sent);
 *  4. each chapter's pages are drawn.
 * Translated pages go to translations/<series>/<chapter>/ (images only, ready to upload); the
 * per-page OCR/translation data and the series glossary live in translation-work/<series>/.
 */
export async function processChapters(series: string, chapters: string[], opts: ChapterOptions = {}): Promise<void> {
    const seriesWork = path.join(config.storage.translationWork, series);
    const loaded: LoadedChapter[] = [];
    for (const chapter of chapters) {
        loaded.push(await ocrChapter(series, chapter, opts));
    }
    if (opts.detectOnly) {
        return;
    }

    const items: Item[] = [];
    for (const ch of loaded) {
        const all = ch.pages.flatMap(p => p.regions);
        if (opts.retranslate || opts.force) {
            for (const r of all) {
                r.type = 'unknown';
                r.lines = toTextLines(r.ocr);
                delete r.translation;
            }
        }
        let junk = 0;
        for (const r of all) {
            if (r.type === 'unknown' && isLocalJunk(r)) {
                r.type = 'skip';
                r.translation = [];
                junk++;
            }
        }
        const pending = all.filter(needsWork);
        items.push(...pending.map(region => ({ region, chapter: ch.chapter })));
        logger.info(`[${series}/${ch.chapter}] ${pending.length} blocks to translate, ${junk} skipped locally`);
    }

    if (items.length) {
        const glossary = await loadGlossary(seriesWork);
        const label = loaded.length > 1 ? `${loaded[0].chapter} … ${loaded.at(-1)!.chapter}` : loaded[0].chapter;
        logger.info(`[${series}/${label}] translating ${items.length} blocks from ${loaded.length} chapter(s) with ${config.translator.translateModel}, text only (glossary: ${glossary.terms.length} terms)`);
        const requests = await translateRegions(items, glossary);
        await saveGlossary(seriesWork, glossary);
        logger.info(`[${series}/${label}] translated in ${requests} request(s)`);
        if (config.translator.polish) {
            const changed = await polishRegions(items.map(i => i.region));
            logger.info(`[${series}/${label}] polish pass rewrote ${changed} lines`);
        }
        const now = new Date().toISOString();
        for (const ch of loaded) {
            for (const p of ch.pages) {
                p.translateModel = config.translator.translateModel;
                p.translatedAt = now;
            }
        }
    }

    for (const ch of loaded) {
        const all = ch.pages.flatMap(p => p.regions);
        const counts = all.reduce<Record<string, number>>((m, r) => ((m[r.type] = (m[r.type] ?? 0) + 1), m), {});
        logger.info(`[${series}/${ch.chapter}] blocks: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        const missing = all.filter(needsWork);
        if (missing.length) {
            logger.warn(`[${series}/${ch.chapter}] ${missing.length} blocks still untranslated — re-run to retry: ${missing.map(r => r.id).join(', ')}`);
        }

        // Draw the translated images (local, free). Same file names/format as downloads/<series>/<chapter>/.
        if (!opts.noRender) {
            const t = Date.now();
            let overflow = 0;
            for (const [i, file] of ch.files.entries()) {
                const res = await renderPage(path.join(ch.srcDir, file), ch.pages[i], path.join(ch.outDir, file));
                overflow += res.overflow.length;
            }
            logger.info(`[${series}/${ch.chapter}] rendered ${ch.files.length} pages in ${Math.round((Date.now() - t) / 1000)}s` + (overflow ? ` (${overflow} blocks needed the minimum font size)` : ''));
        }

        for (const [i, file] of ch.files.entries()) {
            await fs.writeFile(ch.jsonPath(file), JSON.stringify(ch.pages[i], null, 2) + '\n', 'utf8');
        }
        logger.info(`[${series}/${ch.chapter}] done → ${ch.outDir}`);
    }
}

/** One chapter on its own (see processChapters). */
export const processChapter = (series: string, chapter: string, opts: ChapterOptions = {}) => processChapters(series, [chapter], opts);
