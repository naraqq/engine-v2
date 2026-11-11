import sharp from 'sharp';
import { OCR_ENGINE, ocrPage } from './ocr.js';
import { measureStyle } from './style.js';
import type { Box, OcrLine, PageResult, Region } from './types.js';

const union = (boxes: Box[]): Box => {
    const x = Math.min(...boxes.map(b => b.x));
    const y = Math.min(...boxes.map(b => b.y));
    return {
        x,
        y,
        w: Math.max(...boxes.map(b => b.x + b.w)) - x,
        h: Math.max(...boxes.map(b => b.y + b.h)) - y,
    };
};

/**
 * Do two OCR lines belong to the same text block (bubble / caption / window)?
 * Same block = similar letter size, small vertical gap, horizontally overlapping.
 */
function sameBlock(a: OcrLine, b: OcrLine): boolean {
    const ha = a.box.h, hb = b.box.h;
    if (Math.max(ha, hb) / Math.min(ha, hb) > 1.6) {
        return false;
    }
    const lineH = (ha + hb) / 2;
    const [top, bottom] = a.box.y <= b.box.y ? [a.box, b.box] : [b.box, a.box];
    const vGap = bottom.y - (top.y + top.h);
    if (vGap > lineH * 0.9) {
        return false;
    }
    // Same row (words split by the detector) → must be close horizontally.
    if (vGap < -lineH * 0.5) {
        const [left, right] = a.box.x <= b.box.x ? [a.box, b.box] : [b.box, a.box];
        return right.x - (left.x + left.w) < lineH * 1.2;
    }
    // Stacked lines → horizontal ranges must overlap, or centres be close (centred bubble text).
    const overlap = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x);
    const centreDist = Math.abs(a.box.x + a.box.w / 2 - (b.box.x + b.box.w / 2));
    return overlap > 0 || centreDist < Math.max(a.box.w, b.box.w) / 2;
}

/** Groups OCR lines into blocks with union-find. */
function groupLines(lines: OcrLine[]): OcrLine[][] {
    const parent = lines.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].box.y > lines[i].box.y + lines[i].box.h * 3) {
                break; // lines are sorted by y; nothing further down can join
            }
            if (sameBlock(lines[i], lines[j])) {
                parent[find(i)] = find(j);
            }
        }
    }
    const groups = new Map<number, OcrLine[]>();
    lines.forEach((l, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), l]));
    return [...groups.values()];
}

/** Joins items on the same visual row into one text line, top to bottom. */
export function toTextLines(block: OcrLine[]): string[] {
    const rows: OcrLine[][] = [];
    for (const l of [...block].sort((a, b) => a.box.y - b.box.y)) {
        const row = rows.find(r => Math.abs(r[0].box.y + r[0].box.h / 2 - (l.box.y + l.box.h / 2)) < l.box.h / 2);
        if (row) {
            row.push(l);
        } else {
            rows.push([l]);
        }
    }
    return rows.map(r => r.sort((a, b) => a.box.x - b.box.x).map(l => l.text).join(' '));
}

/** Finds and reads all text on a page locally (no network). Types are assigned later by the translation step. */
export async function detectPage(file: string, pageName: string): Promise<PageResult> {
    const { width, height, lines } = await ocrPage(file);
    const blocks = groupLines(lines)
        .map(b => ({ ocr: b.sort((a, c) => a.box.y - c.box.y || a.box.x - c.box.x), box: union(b.map(l => l.box)) }))
        // Reading order: top to bottom, then left to right on the same row.
        .sort((a, b) => (Math.abs(a.box.y - b.box.y) < Math.min(a.box.h, b.box.h) / 2 ? a.box.x - b.box.x : a.box.y - b.box.y));

    const image = sharp(file);
    const regions: Region[] = [];
    for (const [i, b] of blocks.entries()) {
        regions.push({
            id: `${pageName}#${i + 1}`,
            type: 'unknown',
            box: b.box,
            container: null,
            ocr: b.ocr,
            lines: toTextLines(b.ocr),
            style: await measureStyle(image, width, height, b.box),
        });
    }

    return {
        version: 2,
        source: pageName,
        width,
        height,
        ocrEngine: OCR_ENGINE,
        detectedAt: new Date().toISOString(),
        regions,
    };
}
