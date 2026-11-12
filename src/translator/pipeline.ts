import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config/settings.js';
import { logger } from '../config/logger.js';
import { detectPage, toTextLines } from './detect.js';
import { renderPage } from './render.js';
import { loadGlossary, needsWork, polishRegions, saveGlossary, translateRegions } from './translate.js';
import type { PageResult, Region } from './types.js';

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

/**
 * Phase 1 for one chapter:
 *  1. local OCR (GPU) reads every page;
 *  2. one text-only Gemini pass classifies the blocks, fixes OCR errors and translates
 *     (no images are ever sent to the model).
 * Translated pages go to translations/<series>/<chapter>/ (images only, ready to upload); the
 * per-page OCR/translation data and the series glossary live in translation-work/<series>/.
 */
export async function processChapter(series: string, chapter: string, opts: ChapterOptions = {}): Promise<void> {
    const srcDir = path.join(config.storage.downloads, series, chapter);
    const seriesOut = path.join(config.storage.translations, series);
    const outDir = path.join(seriesOut, chapter);
    const seriesWork = path.join(config.storage.translationWork, series);
    const workDir = path.join(seriesWork, chapter);
    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });

    const files = (await fs.readdir(srcDir)).filter(f => IMAGE_EXT.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const jsonPath = (file: string) => path.join(workDir, file.replace(IMAGE_EXT, '.json'));
    const pages: PageResult[] = [];

    // 1. Local OCR, one page at a time (the GPU session is shared). Cached pages are reused.
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

    if (opts.detectOnly) {
        return;
    }

    // 2. Classify + correct + translate everything not done yet, as one chapter (keeps context and names consistent).
    const all = pages.flatMap(p => p.regions);
    if (opts.retranslate) {
        for (const r of all) {
            r.type = 'unknown';
            r.lines = toTextLines(r.ocr);
            delete r.translation;
        }
    }
    // OCR fragments with almost no letters ("5", "J", "1E" — usually SFX or borders read at high zoom) are
    // skipped here instead of paying to send them to the model.
    const junk = new Set(all.filter(r => r.type === 'unknown' && r.lines.join('').replace(/[^\p{L}\p{N}]/gu, '').length < 3));
    for (const r of junk) {
        r.type = 'skip';
        r.translation = [];
    }
    const pending = (opts.force || opts.retranslate ? all : all.filter(needsWork)).filter(r => !junk.has(r));
    if (pending.length === 0) {
        logger.info(`[${series}/${chapter}] already translated`);
    } else {
        const glossary = await loadGlossary(seriesWork);
        const widths = new Map(pages.map(p => [p.source, p.width]));
        logger.info(`[${series}/${chapter}] translating ${pending.length} blocks with ${config.translator.translateModel}, text only (glossary: ${glossary.terms.length} terms)`);
        await translateRegions(pending, widths, glossary);
        await saveGlossary(seriesWork, glossary);
        if (config.translator.polish) {
            const changed = await polishRegions(pending);
            logger.info(`[${series}/${chapter}] polish pass rewrote ${changed} lines`);
        }

        const now = new Date().toISOString();
        for (const p of pages) {
            p.translateModel = config.translator.translateModel;
            p.translatedAt = now;
        }

        const counts = all.reduce<Record<string, number>>((m, r) => ((m[r.type] = (m[r.type] ?? 0) + 1), m), {});
        logger.info(`[${series}/${chapter}] blocks: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        const missing = all.filter(needsWork);
        if (missing.length) {
            logger.warn(`[${series}/${chapter}] ${missing.length} blocks still untranslated — re-run to retry: ${missing.map(r => r.id).join(', ')}`);
        }
    }

    // 3. Draw the translated images (local, free). Same file names/format as downloads/<series>/<chapter>/.
    if (!opts.noRender) {
        const t = Date.now();
        let overflow = 0;
        for (const [i, file] of files.entries()) {
            const res = await renderPage(path.join(srcDir, file), pages[i], path.join(outDir, file));
            overflow += res.overflow.length;
        }
        logger.info(`[${series}/${chapter}] rendered ${files.length} pages in ${Math.round((Date.now() - t) / 1000)}s` + (overflow ? ` (${overflow} blocks needed the minimum font size)` : ''));
    }

    for (const [i, file] of files.entries()) {
        await fs.writeFile(jsonPath(file), JSON.stringify(pages[i], null, 2) + '\n', 'utf8');
    }
    logger.info(`[${series}/${chapter}] done → ${outDir}`);
}

