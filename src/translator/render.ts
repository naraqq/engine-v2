import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import sharp from 'sharp';
import { config } from '../config/settings.js';
import { logger } from '../config/logger.js';
import { inpaint } from './lama.js';
import { measureStyle } from './style.js';
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
const css = (c: RGB) => `rgb(${c.join(',')})`;

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
    const x = clamp(Math.round(b.x - pad), 0, page.width - 1);
    const y = clamp(Math.round(b.y - pad), 0, page.height - 1);
    return {
        x,
        y,
        w: clamp(Math.round(b.x + b.w + pad), 0, page.width) - x,
        h: clamp(Math.round(b.y + b.h + pad), 0, page.height) - y,
    };
}

/**
 * Flat background: erase only the letter shapes. Non-background pixels are grouped into connected
 * components; components touching the rectangle border are bubble outlines/artwork and are kept,
 * enclosed ones are letters and get painted over (plus a small halo for anti-aliasing).
 */
function eraseLetters(
    page: Page,
    rect: Box,
    bg: RGB,
    interior?: (x: number, y: number) => boolean,
    /** Where the OCR found text: anything here is erased; elsewhere only letter-sized shapes (keeps dotted outlines). */
    core?: Box,
    minLetterHeight = 0,
): void {
    const { x: rx, y: ry, w, h } = rect;
    const ink = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
            ink[j * w + i] = dist(page.get(rx + i, ry + j), bg) > 40 ? 1 : 0;
        }
    }

    // 0 = background, 1 = unvisited ink, 2 = letter, 3 = keep (outline/art)
    const queue: number[] = [];
    for (let k = 0; k < w * h; k++) {
        if (ink[k] !== 1) {
            continue;
        }
        const comp: number[] = [];
        let touchesBorder = false;
        // With a known bubble interior, only components lying in that bubble are letters
        // (keeps the text of an overlapping neighbour bubble, which has its own block).
        let inBubble = !interior;
        let minI = Infinity, maxI = -Infinity, minJ = Infinity, maxJ = -Infinity;
        ink[k] = 2;
        queue.push(k);
        while (queue.length) {
            const c = queue.pop()!;
            comp.push(c);
            const ci = c % w, cj = (c - ci) / w;
            minI = Math.min(minI, ci); maxI = Math.max(maxI, ci);
            minJ = Math.min(minJ, cj); maxJ = Math.max(maxJ, cj);
            if (ci === 0 || cj === 0 || ci === w - 1 || cj === h - 1) {
                touchesBorder = true;
            }
            if (!inBubble && interior!(rx + ci, ry + cj)) {
                inBubble = true;
            }
            for (let dj = -1; dj <= 1; dj++) {
                for (let di = -1; di <= 1; di++) {
                    const ni = ci + di, nj = cj + dj;
                    if (ni >= 0 && nj >= 0 && ni < w && nj < h && ink[nj * w + ni] === 1) {
                        ink[nj * w + ni] = 2;
                        queue.push(nj * w + ni);
                    }
                }
            }
        }
        let isLetter = !touchesBorder && inBubble;
        if (isLetter && core) {
            const cx = rx + (minI + maxI) / 2, cy = ry + (minJ + maxJ) / 2;
            const inCore = cx >= core.x && cx < core.x + core.w && cy >= core.y && cy < core.y + core.h;
            isLetter = inCore || maxJ - minJ + 1 >= minLetterHeight;
        }
        if (!isLetter) {
            for (const c of comp) {
                ink[c] = 3;
            }
        }
    }

    // Paint letters + a 2px halo (never over kept outline pixels).
    const R = 2;
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
            if (ink[j * w + i] === 3) {
                continue;
            }
            let near = false;
            for (let dj = -R; dj <= R && !near; dj++) {
                for (let di = -R; di <= R && !near; di++) {
                    const ni = i + di, nj = j + dj;
                    near = ni >= 0 && nj >= 0 && ni < w && nj < h && ink[nj * w + ni] === 2;
                }
            }
            if (near) {
                page.set(rx + i, ry + j, bg);
            }
        }
    }
}

/** Picks the background pixel just outside the rectangle, stepping outward; prefers pixels close to `expected`. */
function sampleOutside(page: Page, x: number, y: number, dx: number, dy: number, expected: RGB | null): RGB {
    let best: RGB | null = null;
    for (let k = 1; k <= 6; k++) {
        const c = page.get(clamp(x + dx * k, 0, page.width - 1), clamp(y + dy * k, 0, page.height - 1));
        if (!best || (expected && dist(c, expected) < dist(best, expected))) {
            best = c;
        }
        if (!expected) {
            break;
        }
    }
    return best!;
}

/** Gradient / artwork fallback: Coons-patch interpolation from the four borders (exact for gradients, soft patch on art). */
function erasePatch(page: Page, rect: Box, bg: RGB | null): void {
    const est = estimateBackground(page, rect, bg);
    for (let j = 0; j < rect.h; j++) {
        for (let i = 0; i < rect.w; i++) {
            page.set(rect.x + i, rect.y + j, est[j * rect.w + i]);
        }
    }
}

/**
 * LaMa mask for text on artwork: each OCR line box, padded to cover the letters' glow/outline
 * (generous above/below, tight on the left so bullets and icons next to the text survive).
 */
function lineMask(page: Page, region: Region): Uint8Array {
    const mask = new Uint8Array(page.width * page.height);
    for (const line of region.ocr) {
        const pv = Math.max(4, Math.round(line.box.h * 0.25));
        const x0 = clamp(line.box.x - 2, 0, page.width), x1 = clamp(line.box.x + line.box.w + 6, 0, page.width);
        const y0 = clamp(line.box.y - pv, 0, page.height), y1 = clamp(line.box.y + line.box.h + pv, 0, page.height);
        for (let y = y0; y < y1; y++) {
            mask.fill(1, y * page.width + x0, y * page.width + x1);
        }
    }
    return mask;
}

/** Coons-patch estimate of the background inside `rect`, from the pixels just outside its four borders. */
function estimateBackground(page: Page, rect: Box, bg: RGB | null): RGB[] {
    const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.w - 1, y1 = rect.y + rect.h - 1;
    const est: RGB[] = new Array(rect.w * rect.h);
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
                const hh = (1 - u) * left[j][c] + u * right[j][c];
                const vv = (1 - v) * top[i][c] + v * bottom[i][c];
                const corner = (1 - u) * (1 - v) * c00[c] + u * (1 - v) * c10[c] + (1 - u) * v * c01[c] + u * v * c11[c];
                return clamp(Math.round(hh + vv - corner), 0, 255);
            }) as RGB;
            est[j * rect.w + i] = out;
        }
    }
    return est;
}

interface Container {
    /** Bounding box of the bubble/box interior. */
    box: Box;
    /** Largest text rectangle that fits inside the interior, grown outward from the original text. */
    inner: Box;
    /** True for pixels in (or within a few px of) this bubble's interior. */
    interior: (x: number, y: number) => boolean;
}

/**
 * Finds the bubble/box interior around a text block by flood-filling its background colour on the
 * UNTOUCHED page (letters are islands the fill flows around; bubble outlines stop it, so overlapping
 * bubbles stay separate). Returns null if the fill leaks (text on open background, not in a container).
 */
function findContainer(page: Page, text: Box, bg: RGB): Container | null {
    const reach = Math.max(text.w, text.h);
    const win = padBox(text, reach, page);
    const inWin = (x: number, y: number) => x >= win.x && y >= win.y && x < win.x + win.w && y < win.y + win.h;
    const mask = new Uint8Array(win.w * win.h);

    // Ink map, thickened by R px so dashed/dotted bubble outlines become closed walls the fill can't leak through.
    const R = 3;
    const ink = new Uint8Array(win.w * win.h);
    for (let j = 0; j < win.h; j++) {
        for (let i = 0; i < win.w; i++) {
            ink[j * win.w + i] = dist(page.get(win.x + i, win.y + j), bg) > 40 ? 1 : 0;
        }
    }
    const rowMax = new Uint8Array(win.w * win.h);
    for (let j = 0; j < win.h; j++) {
        for (let i = 0; i < win.w; i++) {
            let v = 0;
            for (let d = -R; d <= R && !v; d++) {
                const ii = i + d;
                v = ii >= 0 && ii < win.w ? ink[j * win.w + ii] : 0;
            }
            rowMax[j * win.w + i] = v;
        }
    }
    const wall = new Uint8Array(win.w * win.h);
    for (let j = 0; j < win.h; j++) {
        for (let i = 0; i < win.w; i++) {
            let v = 0;
            for (let d = -R; d <= R && !v; d++) {
                const jj = j + d;
                v = jj >= 0 && jj < win.h ? rowMax[jj * win.w + i] : 0;
            }
            wall[j * win.w + i] = v;
        }
    }
    const isBg = (x: number, y: number) => wall[(y - win.y) * win.w + (x - win.x)] === 0;

    // Seed: the background pixel nearest the centre of the text block (the centre itself may be a letter).
    const cx = text.x + text.w / 2, cy = text.y + text.h / 2;
    let seed: [number, number] | null = null;
    let bestD = Infinity;
    for (let y = text.y; y < text.y + text.h; y += 2) {
        for (let x = text.x; x < text.x + text.w; x += 2) {
            const d = (x - cx) ** 2 + (y - cy) ** 2;
            if (d < bestD && inWin(x, y) && isBg(x, y)) {
                bestD = d;
                seed = [x, y];
            }
        }
    }
    if (!seed) {
        return null;
    }

    const stack = [seed[0], seed[1]];
    mask[(seed[1] - win.y) * win.w + (seed[0] - win.x)] = 1;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    while (stack.length) {
        const y = stack.pop()!, x = stack.pop()!;
        if (x === win.x || y === win.y || x === win.x + win.w - 1 || y === win.y + win.h - 1) {
            // Touching the page edge is fine (boxes cut by the page border); the search window edge is not.
            const atPageEdge = x === 0 || y === 0 || x === page.width - 1 || y === page.height - 1;
            if (!atPageEdge) {
                return null;
            }
        }
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
            if (inWin(nx, ny)) {
                const k = (ny - win.y) * win.w + (nx - win.x);
                if (!mask[k] && isBg(nx, ny)) {
                    mask[k] = 1;
                    stack.push(nx, ny);
                }
            }
        }
    }
    if (!isFinite(minX)) {
        return null;
    }

    const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    // A real bubble is at least about as big as the text it holds; tiny fills are gaps between letters.
    if (box.w < text.w * 0.9 || box.h < text.h * 0.9) {
        return null;
    }

    // Interior grown back by R+1 px (the fill stopped R px short of every ink pixel), so letters touch it.
    const near = new Uint8Array(win.w * win.h);
    const G = R + 1;
    for (let j = 0; j < win.h; j++) {
        for (let i = 0; i < win.w; i++) {
            if (!mask[j * win.w + i]) {
                continue;
            }
            for (let dj = -G; dj <= G; dj++) {
                const jj = j + dj;
                if (jj < 0 || jj >= win.h) {
                    continue;
                }
                near.fill(1, jj * win.w + Math.max(0, i - G), jj * win.w + Math.min(win.w, i + G + 1));
            }
        }
    }

    const interior = (x: number, y: number) => inWin(x, y) && near[(y - win.y) * win.w + (x - win.x)] === 1;

    // Grow a rectangle from the original text box until it hits the bubble wall on every side.
    // Uses the restored interior (letters' surroundings count), plus the original text box itself.
    const inside = (x: number, y: number) => interior(x, y) || (x >= text.x && x < text.x + text.w && y >= text.y && y < text.y + text.h);
    const edgeOk = (pts: [number, number][]) => pts.filter(([x, y]) => inside(x, y)).length >= pts.length * 0.97;
    const r = { x0: text.x, y0: text.y, x1: text.x + text.w - 1, y1: text.y + text.h - 1 };
    const col = (x: number): [number, number][] => Array.from({ length: r.y1 - r.y0 + 1 }, (_, i) => [x, r.y0 + i]);
    const row = (y: number): [number, number][] => Array.from({ length: r.x1 - r.x0 + 1 }, (_, i) => [r.x0 + i, y]);
    for (let grew = true; grew;) {
        grew = false;
        if (edgeOk(col(r.x0 - 1))) { r.x0--; grew = true; }
        if (edgeOk(col(r.x1 + 1))) { r.x1++; grew = true; }
        if (edgeOk(row(r.y0 - 1))) { r.y0--; grew = true; }
        if (edgeOk(row(r.y1 + 1))) { r.y1++; grew = true; }
    }

    return {
        box,
        inner: { x: r.x0, y: r.y0, w: r.x1 - r.x0 + 1, h: r.y1 - r.y0 + 1 },
        interior,
    };
}

/** How the original text was aligned (for blocks not inside a bubble). */
function alignmentOf(region: Region, pageWidth: number): 'left' | 'center' {
    const lefts = region.ocr.map(l => l.box.x);
    const rights = region.ocr.map(l => l.box.x + l.box.w);
    if (lefts.length > 1) {
        // Only clearly left-aligned blocks (3+ lines, same left edge, ragged right) stay left; comics centre by default.
        const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
        return lefts.length >= 3 && spread(lefts) < 6 && spread(rights) > 20 ? 'left' : 'center';
    }
    const cx = region.box.x + region.box.w / 2;
    return Math.abs(cx - pageWidth / 2) < pageWidth * 0.1 ? 'center' : 'left';
}

interface Area extends Box {
    align: 'left' | 'center';
}

/** Area the Mongolian text may use. */
/** Grows `text` outward while each new edge is ≥ 97% background-coloured (bounded to 1x its size per side). */
function growInBackground(page: Page, text: Box, bg: RGB): Box {
    const r = { x0: text.x, y0: text.y, x1: text.x + text.w - 1, y1: text.y + text.h - 1 };
    const limX = text.w, limY = text.h;
    const ok = (pts: [number, number][]) =>
        pts.length > 0 &&
        pts.filter(([x, y]) => x >= 0 && y >= 0 && x < page.width && y < page.height && dist(page.get(x, y), bg) <= 40).length >= pts.length * 0.97;
    const col = (x: number): [number, number][] => Array.from({ length: r.y1 - r.y0 + 1 }, (_, i) => [x, r.y0 + i]);
    const row = (y: number): [number, number][] => Array.from({ length: r.x1 - r.x0 + 1 }, (_, i) => [r.x0 + i, y]);
    for (let grew = true; grew;) {
        grew = false;
        if (text.x - r.x0 < limX && ok(col(r.x0 - 1))) { r.x0--; grew = true; }
        if (r.x1 - (text.x + text.w) < limX && ok(col(r.x1 + 1))) { r.x1++; grew = true; }
        if (text.y - r.y0 < limY && ok(row(r.y0 - 1))) { r.y0--; grew = true; }
        if (r.y1 - (text.y + text.h) < limY && ok(row(r.y1 + 1))) { r.y1++; grew = true; }
    }
    return { x: r.x0, y: r.y0, w: r.x1 - r.x0 + 1, h: r.y1 - r.y0 + 1 };
}

function textArea(region: Region, container: Container | null, page: Page): Area {
    const b = region.box;
    if (container) {
        // Largest rectangle inside the bubble, with a little breathing room from the wall.
        const c = container.inner;
        const mx = Math.min(c.w * 0.06, 10), my = Math.min(c.h * 0.06, 8);
        return { x: c.x + mx, y: c.y + my, w: c.w - 2 * mx, h: c.h - 2 * my, align: 'center' };
    }

    // Flat background but the bubble fill leaked (box touches artwork): still find the box by growing
    // from the original text while every edge stays background-coloured. Runs on the erased page.
    const bg = parseHex(region.style.backgroundColor);
    if (region.style.background === 'flat' && bg) {
        const grown = growInBackground(page, b, bg);
        if (grown.w > b.w * 1.05 || grown.h > b.h * 1.05) {
            const mx = Math.min(grown.w * 0.05, 8), my = Math.min(grown.h * 0.06, 6);
            return { x: grown.x + mx, y: grown.y + my, w: grown.w - 2 * mx, h: grown.h - 2 * my, align: 'center' };
        }
    }

    // Free-floating text: allow it to grow sideways (Mongolian runs longer than English), within the page margins.
    const margin = page.width * 0.03;
    const align = alignmentOf(region, page.width);
    const extraH = b.h * 0.15;
    // Modest growth: text outside a detected bubble is likely inside a shape we couldn't see (panel, frame);
    // a little overflow is fine (the halo keeps it readable), a lot looks wrong.
    const grow = b.w * 0.25;
    if (align === 'left') {
        const w = Math.min(b.w + grow, page.width - margin - b.x);
        return { x: b.x, y: b.y - extraH / 2, w, h: b.h + extraH, align };
    }
    const cx = b.x + b.w / 2;
    const half = Math.min((b.w + grow) / 2, cx - margin, page.width - margin - cx);
    return { x: cx - half, y: b.y - extraH / 2, w: half * 2, h: b.h + extraH, align };
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

/** Wraps each paragraph (translation entry) separately, so explicit line breaks are kept. */
function wrapAll(ctx: SKRSContext2D, paragraphs: string[], maxWidth: number, fixed: boolean): string[] {
    return fixed ? paragraphs : paragraphs.flatMap(p => wrap(ctx, p, maxWidth));
}

/** Largest font size (≤ original) at which the text fits; avoids a lone short word on the last line. */
function layout(ctx: SKRSContext2D, region: Region, area: Box, paragraphs: string[], fixed: boolean): { size: number; lines: string[] } {
    const heights = region.ocr.map(l => l.box.h).sort((a, b) => a - b);
    const original = heights[heights.length >> 1] ?? 20;
    const maxSize = Math.max(10, Math.round(original * 0.9));
    const minSize = 9;

    let fallback: { size: number; lines: string[] } | null = null;
    for (let size = maxSize; size >= minSize; size -= 0.5) {
        ctx.font = `${size}px "${FONT_FAMILY}"`;
        const lines = wrapAll(ctx, paragraphs, area.w, fixed);
        const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
        if (widest > area.w || lines.length * size * 1.15 > area.h) {
            continue;
        }
        const last = lines[lines.length - 1];
        const orphan = !fixed && lines.length > 1 && last.length <= 4;
        if (!orphan) {
            return { size, lines };
        }
        fallback ??= { size, lines };
        if (size < maxSize * 0.8) {
            return fallback; // don't shrink too far just to avoid an orphan
        }
    }
    if (fallback) {
        return fallback;
    }
    ctx.font = `${minSize}px "${FONT_FAMILY}"`;
    return { size: minSize, lines: wrapAll(ctx, paragraphs, area.w, fixed) };
}

/** True when the English source is written in capitals (typical comic lettering). */
const isAllCaps = (lines: string[]) => {
    const letters = lines.join('').replace(/[^A-Za-z]/g, '');
    return letters.length > 0 && letters === letters.toUpperCase();
};

function draw(ctx: SKRSContext2D, region: Region, area: Area): boolean {
    const fixed = region.type === 'system';
    const paragraphs = (isAllCaps(region.lines) ? region.translation!.map(t => t.toLocaleUpperCase('mn')) : region.translation!).filter(t => t.trim());
    const { size, lines } = layout(ctx, region, area, paragraphs, fixed);

    const ink = parseHex(region.style.textColor) ?? [0, 0, 0];
    const measuredOutline = parseHex(region.style.outlineColor);
    const bg = parseHex(region.style.backgroundColor);
    // On a flat bubble the outline is the bubble's own colour: invisible inside the bubble, but any text that
    // spills over the edge stays readable (e.g. black text from a white box over a black panel).
    const outline: RGB | null =
        measuredOutline ??
        (region.style.background === 'flat' && bg ? bg : luminance(ink) < 128 ? [255, 255, 255] : [0, 0, 0]);
    const haloOnly = !measuredOutline && region.style.background === 'flat' && !!bg;
    const lineH = size * 1.15;
    const startY = area.y + (area.h - lines.length * lineH) / 2 + lineH / 2;

    ctx.font = `${size}px "${FONT_FAMILY}"`;
    ctx.textAlign = area.align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const x = area.align === 'left' ? area.x : area.x + area.w / 2;
    lines.forEach((line, i) => {
        const y = startY + i * lineH;
        if (outline) {
            ctx.strokeStyle = css(outline);
            // Measured outlines are drawn bold like the original; the fallback outline only adds legibility.
            ctx.lineWidth = Math.max(2, size * (measuredOutline ? 0.2 : haloOnly ? 0.28 : 0.12));
            ctx.strokeText(line, x, y);
        }
        ctx.fillStyle = css(ink);
        ctx.fillText(line, x, y);
    });

    return lines.every(l => ctx.measureText(l).width <= area.w + 1) && lines.length * lineH <= area.h + 1;
}

/**
 * Renders one translated page: erases the English text blocks and draws the Mongolian translation.
 * Also refreshes each block's measured style and records its bubble/box (`region.container`) in the page JSON.
 */
export async function renderPage(sourceFile: string, page: PageResult, outFile: string): Promise<{ drawn: number; overflow: string[] }> {
    ensureFont();
    const source = sharp(sourceFile);
    const { data, info } = await source.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = new Page(data, info.width, info.height);
    const todo = page.regions.filter(r => r.type !== 'skip' && r.type !== 'unknown' && r.translation?.some(t => t.trim()));

    // Re-measure style on the untouched page (keeps old JSON files up to date with the latest measuring code).
    for (const r of todo) {
        r.style = await measureStyle(source, info.width, info.height, r.box);
    }

    // 1. Find bubbles/boxes on the untouched page (erasing first could break the outline between overlapping bubbles).
    const containers = todo.map(r => {
        const bg = parseHex(r.style.backgroundColor);
        return bg && r.style.background !== 'art' ? findContainer(px, r.box, bg) : null;
    });
    todo.forEach((r, i) => (r.container = containers[i]?.box ?? null));

    // 2. Erase all text (before drawing, so neighbouring blocks don't sample each other's letters).
    // Flat bubbles get a generous margin (eraseLetters never touches outlines); patches stay tight sideways
    // so bullets/icons next to the text survive.
    const rects = todo.map(r => {
        const padY = Math.max(4, Math.round((r.ocr[0]?.box.h ?? 20) * 0.2));
        const flat = r.style.background === 'flat' && r.style.backgroundColor;
        const padded = padBox(r.box, padY, px);
        if (flat) {
            return padded;
        }
        const x = clamp(r.box.x - 3, 0, px.width - 1);
        return { ...padded, x, w: clamp(r.box.x + r.box.w + 3, 0, px.width) - x };
    });
    // Flat bubbles: instant letter erase. Gradients/artwork: LaMa inpainting (falls back to blending).
    // Masks for LaMa are taken from the untouched page, so neighbouring erases can't distort them.
    const masks = todo.map((r, i) =>
        r.style.background === 'flat' && r.style.backgroundColor ? null : lineMask(px, r));
    for (const [i, r] of todo.entries()) {
        const bg = parseHex(r.style.backgroundColor);
        if (!masks[i]) {
            // Inside a known bubble, erase every letter in it — also ones the OCR missed.
            const c = containers[i];
            const lineH = r.ocr.map(l => l.box.h).sort((a, b) => a - b)[r.ocr.length >> 1] ?? 20;
            eraseLetters(px, c ? c.box : rects[i], bg!, c?.interior, rects[i], lineH * 0.5);
        } else {
            const ok = await inpaint({ data, width: info.width, height: info.height }, masks[i]!, rects[i]);
            if (process.env.TRANSLATOR_DEBUG_ERASED) {
                logger.info(`${r.id}: mask ${masks[i]!.reduce((a, v) => a + v, 0)} px, rect ${JSON.stringify(rects[i])}, lama ${ok}`);
            }
            if (!ok) {
                erasePatch(px, rects[i], bg);
            }
        }
    }
    if (process.env.TRANSLATOR_DEBUG_ERASED) {
        // Debug aid: the page after erasing, before any Mongolian is drawn.
        await sharp(Buffer.from(data), { raw: { width: info.width, height: info.height, channels: 4 } })
            .png()
            .toFile(outFile.replace(/\.[^.]+$/, '.erased.png'));
    }

    // 3. Draw the translations.
    const canvas = createCanvas(info.width, info.height);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(info.width, info.height);
    imageData.data.set(data);
    ctx.putImageData(imageData, 0, 0);

    const overflow: string[] = [];
    todo.forEach((r, i) => {
        if (!draw(ctx, r, textArea(r, containers[i], px))) {
            overflow.push(r.id);
        }
    });

    // Same format as the source file (mirrors the downloads folder exactly).
    const out = ctx.getImageData(0, 0, info.width, info.height);
    const img = sharp(Buffer.from(out.data.buffer), { raw: { width: info.width, height: info.height, channels: 4 } });
    const ext = outFile.split('.').pop()!.toLowerCase();
    await (ext === 'png' ? img.png() : ext === 'jpg' || ext === 'jpeg' ? img.flatten().jpeg({ quality: 92 }) : img.webp({ quality: 92 })).toFile(outFile);

    if (overflow.length) {
        logger.debug(`${page.source}: text too long for its box at minimum size: ${overflow.join(', ')}`);
    }
    return { drawn: todo.length, overflow };
}
