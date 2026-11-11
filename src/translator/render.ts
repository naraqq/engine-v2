import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import sharp from 'sharp';
import { config } from '../config/settings.js';
import { logger } from '../config/logger.js';
import type { Box, PageResult, Region } from './types.js';

const FONT_FAMILY = 'MangaMN';
let fontReady = false;

function ensureFont(): void {
    if (!fontReady) {
        if (!GlobalFonts.registerFromPath(config.translator.font, FONT_FAMILY)) {
            throw new Error(`Could not load font ${config.translator.font} (set TRANSLATOR_FONT to a .ttf with Mongolian Cyrillic)`);
        }
        fontReady = true;
    }
}

type RGB = [number, number, number];

const parseHex = (hex: string | null): RGB | null => {
    const m = hex?.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
};
const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const luminance = ([r, g, b]: RGB) => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** RGBA page buffer with helpers. */
class Page {
    constructor(readonly data: Buffer, readonly width: number, readonly height: number) {}

    get(x: number, y: number): RGB {
        const i = (y * this.width + x) * 4;
        return [this.data[i], this.data[i + 1], this.data[i + 2]];
    }

    set(x: number, y: number, [r, g, b]: RGB): void {
        const i = (y * this.width + x) * 4;
        this.data[i] = r;
        this.data[i + 1] = g;
        this.data[i + 2] = b;
        this.data[i + 3] = 255;
    }
}

function padBox(b: Box, pad: number, page: Page): Box {
    const x = clamp(b.x - pad, 0, page.width - 1);
    const y = clamp(b.y - pad, 0, page.height - 1);
    return {
        x,
        y,
        w: clamp(b.x + b.w + pad, 0, page.width) - x,
        h: clamp(b.y + b.h + pad, 0, page.height) - y,
    };
}

/**
 * Picks the background pixel just outside the rectangle at (x,y), stepping outward (dx,dy):
 * of the next few pixels, the one closest to the expected background wins (skips outlines/ink).
 */
function sampleOutside(page: Page, x: number, y: number, dx: number, dy: number, expected: RGB | null): RGB {
    let best: RGB | null = null;
    for (let k = 1; k <= 6; k++) {
        const px = clamp(x + dx * k, 0, page.width - 1);
        const py = clamp(y + dy * k, 0, page.height - 1);
        const c = page.get(px, py);
        if (!best || (expected && dist(c, expected) < dist(best, expected))) {
            best = c;
        }
        if (!expected) {
            break;
        }
    }
    return best!;
}

/** Erases the text in `rect`: flat fill when the background is uniform, otherwise a smooth patch blended from the surrounding pixels. */
function erase(page: Page, rect: Box, region: Region): void {
    const bg = parseHex(region.style.backgroundColor);

    if (region.style.background === 'flat' && bg) {
        for (let y = rect.y; y < rect.y + rect.h; y++) {
            for (let x = rect.x; x < rect.x + rect.w; x++) {
                page.set(x, y, bg);
            }
        }
        return;
    }

    // Coons-patch interpolation from the four borders: reproduces gradients exactly, gives a soft patch on artwork.
    const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.w - 1, y1 = rect.y + rect.h - 1;
    const top = Array.from({ length: rect.w }, (_, i) => sampleOutside(page, x0 + i, y0, 0, -1, bg));
    const bottom = Array.from({ length: rect.w }, (_, i) => sampleOutside(page, x0 + i, y1, 0, 1, bg));
    const left = Array.from({ length: rect.h }, (_, j) => sampleOutside(page, x0, y0 + j, -1, 0, bg));
    const right = Array.from({ length: rect.h }, (_, j) => sampleOutside(page, x1, y0 + j, 1, 0, bg));
    const c00 = top[0], c10 = top[rect.w - 1], c01 = bottom[0], c11 = bottom[rect.w - 1];

    for (let j = 0; j < rect.h; j++) {
        const v = rect.h > 1 ? j / (rect.h - 1) : 0;
        for (let i = 0; i < rect.w; i++) {
            const u = rect.w > 1 ? i / (rect.w - 1) : 0;
            const out = [0, 1, 2].map(c => {
                const h = (1 - u) * left[j][c] + u * right[j][c];
                const vv = (1 - v) * top[i][c] + v * bottom[i][c];
                const corner = (1 - u) * (1 - v) * c00[c] + u * (1 - v) * c10[c] + (1 - u) * v * c01[c] + u * v * c11[c];
                return clamp(Math.round(h + vv - corner), 0, 255);
            }) as RGB;
            page.set(x0 + i, y0 + j, out);
        }
    }
}

/**
 * Finds the bubble/box interior around an erased block by flood-filling the background colour.
 * Returns null if the fill leaks (text sits on open page background, not inside a container).
 */
function findContainer(page: Page, rect: Box, bg: RGB): Box | null {
    const reach = Math.max(rect.w, rect.h);
    const win = padBox(rect, reach, page);
    const seen = new Uint8Array(win.w * win.h);
    const stack: number[] = [];
    const push = (x: number, y: number) => {
        if (x < win.x || y < win.y || x >= win.x + win.w || y >= win.y + win.h) {
            return;
        }
        const k = (y - win.y) * win.w + (x - win.x);
        if (seen[k] || dist(page.get(x, y), bg) > 40) {
            return;
        }
        seen[k] = 1;
        stack.push(x, y);
    };
    push(rect.x + (rect.w >> 1), rect.y + (rect.h >> 1));

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let leaked = false;
    while (stack.length) {
        const y = stack.pop()!, x = stack.pop()!;
        if (x === win.x || y === win.y || x === win.x + win.w - 1 || y === win.y + win.h - 1) {
            leaked = true;
            break;
        }
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
    }
    return leaked || !isFinite(minX) ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Area the Mongolian text may use. */
function textArea(region: Region, page: Page): Box {
    const b = region.box;
    if (region.container && region.type !== 'system') {
        // Usable part of a rounded bubble ≈ inner rectangle; never smaller than the original text box.
        const c = region.container;
        const insetX = c.w * 0.13, insetY = c.h * 0.15;
        const x = Math.min(b.x, c.x + insetX), y = Math.min(b.y, c.y + insetY);
        return { x, y, w: Math.max(b.x + b.w, c.x + c.w - insetX) - x, h: Math.max(b.y + b.h, c.y + c.h - insetY) - y };
    }
    return padBox(b, Math.round(Math.min(b.w, b.h) * 0.08), page);
}

function wrap(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
        const test = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(test).width > maxWidth) {
            lines.push(line);
            line = word;
        } else {
            line = test;
        }
    }
    if (line) {
        lines.push(line);
    }
    return lines;
}

/** Chooses the largest font size (≤ original) at which the text fits the area. */
function layout(ctx: SKRSContext2D, region: Region, area: Box, text: string[], fixedLines: boolean): { size: number; lines: string[] } {
    const lineHeights = region.ocr.map(l => l.box.h).sort((a, b) => a - b);
    const original = lineHeights[lineHeights.length >> 1] ?? 20;
    const maxSize = Math.max(10, Math.round(original * 0.95));
    const minSize = 9;

    for (let size = maxSize; size >= minSize; size -= 0.5) {
        ctx.font = `${size}px "${FONT_FAMILY}"`;
        const lines = fixedLines ? text : wrap(ctx, text.join(' '), area.w);
        const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
        if (widest <= area.w && lines.length * size * 1.15 <= area.h) {
            return { size, lines };
        }
    }
    ctx.font = `${minSize}px "${FONT_FAMILY}"`;
    return { size: minSize, lines: fixedLines ? text : wrap(ctx, text.join(' '), area.w) };
}

/** True when the English source is written in capitals (typical comic lettering). */
const isAllCaps = (lines: string[]) => {
    const letters = lines.join('').replace(/[^A-Za-z]/g, '');
    return letters.length > 0 && letters === letters.toUpperCase();
};

function draw(ctx: SKRSContext2D, region: Region, area: Box): boolean {
    const fixedLines = region.type === 'system';
    const text = isAllCaps(region.lines) ? region.translation!.map(t => t.toLocaleUpperCase('mn')) : region.translation!;
    const { size, lines } = layout(ctx, region, area, text, fixedLines);

    const ink = parseHex(region.style.textColor) ?? [0, 0, 0];
    const needsOutline = region.style.background !== 'flat';
    const lineH = size * 1.15;
    const startY = area.y + (area.h - lines.length * lineH) / 2 + lineH / 2;

    ctx.font = `${size}px "${FONT_FAMILY}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    lines.forEach((line, i) => {
        const x = area.x + area.w / 2;
        const y = startY + i * lineH;
        if (needsOutline) {
            ctx.strokeStyle = luminance(ink) < 128 ? '#ffffff' : '#000000';
            ctx.lineWidth = Math.max(2, size * 0.18);
            ctx.strokeText(line, x, y);
        }
        ctx.fillStyle = `rgb(${ink.join(',')})`;
        ctx.fillText(line, x, y);
    });

    const fits = lines.every(l => ctx.measureText(l).width <= area.w + 1) && lines.length * lineH <= area.h + 1;
    return fits;
}

/**
 * Renders one translated page: erases the English text blocks and draws the Mongolian translation.
 * Also records the detected bubble/box (`region.container`) back into the page JSON.
 */
export async function renderPage(sourceFile: string, page: PageResult, outFile: string): Promise<{ drawn: number; overflow: string[] }> {
    ensureFont();
    const { data, info } = await sharp(sourceFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = new Page(data, info.width, info.height);
    const todo = page.regions.filter(r => r.type !== 'skip' && r.type !== 'unknown' && r.translation?.some(t => t.trim()));

    // 1. Erase all text first (so neighbouring blocks don't sample each other's letters), then find containers.
    const rects = todo.map(r => padBox(r.box, Math.max(3, Math.round((r.ocr[0]?.box.h ?? 20) * 0.15)), px));
    todo.forEach((r, i) => erase(px, rects[i], r));
    todo.forEach((r, i) => {
        const bg = parseHex(r.style.backgroundColor);
        r.container = r.style.background === 'flat' && bg ? findContainer(px, rects[i], bg) : null;
    });

    // 2. Draw the translations.
    const canvas = createCanvas(info.width, info.height);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(info.width, info.height);
    imageData.data.set(data);
    ctx.putImageData(imageData, 0, 0);

    const overflow: string[] = [];
    for (const r of todo) {
        if (!draw(ctx, r, textArea(r, px))) {
            overflow.push(r.id);
        }
    }

    const out = ctx.getImageData(0, 0, info.width, info.height);
    // Same format as the source file (mirrors the downloads folder exactly).
    const img = sharp(Buffer.from(out.data.buffer), { raw: { width: info.width, height: info.height, channels: 4 } });
    const ext = outFile.split('.').pop()!.toLowerCase();
    await (ext === 'png' ? img.png() : ext === 'jpg' || ext === 'jpeg' ? img.flatten().jpeg({ quality: 92 }) : img.webp({ quality: 92 })).toFile(outFile);

    if (overflow.length) {
        logger.debug(`${page.source}: text too long for its box at minimum size: ${overflow.join(', ')}`);
    }
    return { drawn: todo.length, overflow };
}
