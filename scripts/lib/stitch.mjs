/**
 * Joins a chapter's thin page strips into taller pages.
 *
 * Some sources (manga18fx) cut one chapter into 400+ short strips. Montoon
 * takes at most 300 files per episode, and a speech bubble cut between two
 * strips is OCR'd as two broken halves. Stacking consecutive strips into pages
 * of up to TARGET px fixes both. Pages already taller than that are kept as-is.
 */
import path from 'node:path';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import sharp from 'sharp';

// sharp's cache keeps input files open, and Windows can't delete open files
// (EPERM when the incoming folder is removed afterwards).
sharp.cache(false);

const IMAGE = /\.(webp|png|jpe?g)$/i;
/** Wanted page height. The renderer's canvas and WebP (16383 px) both cap the size. */
const TARGET = 6000;
const HARD_MAX = 12000;
/** Montoon's per-episode file limit, with some room. */
const MAX_PAGES = 280;

/**
 * Stitches every image in `srcDir` (reading order) into `destDir`. Returns { before, after }.
 * opts.keep: copy the images as they are (renumbered), unless the chapter is over the file limit.
 */
export async function stitchChapter(srcDir, destDir, opts = {}) {
    const files = readdirSync(srcDir).filter(f => IMAGE.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    mkdirSync(destDir, { recursive: true });
    if (!files.length) return { before: 0, after: 0 };

    if (opts.keep && files.length <= MAX_PAGES) {
        const digits = Math.max(2, String(files.length).length);
        for (const [i, name] of files.entries()) {
            copyFileSync(path.join(srcDir, name), path.join(destDir, `${String(i + 1).padStart(digits, '0')}${path.extname(name).toLowerCase()}`));
        }
        return { before: files.length, after: files.length };
    }

    const pages = [];
    for (const name of files) {
        const file = path.join(srcDir, name);
        const { width, height } = await sharp(file).metadata();
        pages.push({ file, name, width, height });
    }

    // Common width: the most frequent one. Odd-width strips are scaled to it.
    const counts = new Map();
    for (const p of pages) counts.set(p.width, (counts.get(p.width) ?? 0) + 1);
    const width = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const scaled = p => Math.round(p.height * width / p.width);

    // Taller target if the chapter would still have too many pages.
    const total = pages.reduce((sum, p) => sum + scaled(p), 0);
    const target = Math.min(HARD_MAX, Math.max(TARGET, Math.ceil(total / MAX_PAGES)));

    const groups = [];
    let group = [], height = 0;
    for (const p of pages) {
        const h = scaled(p);
        if (group.length && height + h > target) {
            groups.push(group);
            group = [];
            height = 0;
        }
        group.push(p);
        height += h;
    }
    if (group.length) groups.push(group);

    const ext = path.extname(files[0]).toLowerCase();
    const digits = Math.max(2, String(groups.length).length);
    for (const [i, g] of groups.entries()) {
        const out = path.join(destDir, `${String(i + 1).padStart(digits, '0')}${ext}`);
        if (g.length === 1 && g[0].width === width) {
            copyFileSync(g[0].file, out);
            continue;
        }
        const layers = [];
        let top = 0;
        for (const p of g) {
            const h = scaled(p);
            const input = p.width === width
                ? p.file
                : await sharp(p.file).resize(width, h, { fit: 'fill' }).toBuffer();
            layers.push({ input, top, left: 0 });
            top += h;
        }
        let img = sharp({ create: { width, height: top, channels: 3, background: '#ffffff' } }).composite(layers);
        img = ext === '.png' ? img.png() : ext === '.webp' ? img.webp({ quality: 92 }) : img.jpeg({ quality: 92, mozjpeg: true });
        await img.toFile(out);
    }
    return { before: files.length, after: groups.length };
}
