import type { Sharp } from 'sharp';
import type { Box, TextStyle } from './types.js';

type RGB = [number, number, number];

const hex = ([r, g, b]: RGB) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
}

/**
 * Measures text/background style from pixels — free, instead of asking Gemini.
 * Background = pixels in a ring just outside the text box; text colour = pixels inside
 * the text box that clearly differ from that background.
 */
export async function measureStyle(image: Sharp, pageW: number, pageH: number, box: Box): Promise<TextStyle> {
    const pad = Math.max(6, Math.round(Math.min(box.w, box.h) * 0.15));
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    const w = Math.min(pageW - x, box.w + pad * 2);
    const h = Math.min(pageH - y, box.h + pad * 2);

    const { data, info } = await image.clone().extract({ left: x, top: y, width: w, height: h }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (i: number): RGB => [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];

    const ring: RGB[] = [];
    const inner: RGB[] = [];
    const ix0 = box.x - x, iy0 = box.y - y, ix1 = ix0 + box.w, iy1 = iy0 + box.h;
    for (let j = 0; j < info.height; j++) {
        for (let i = 0; i < info.width; i++) {
            const inside = i >= ix0 && i < ix1 && j >= iy0 && j < iy1;
            (inside ? inner : ring).push(px(j * info.width + i));
        }
    }

    const bg: RGB = [0, 1, 2].map(c => median(ring.map(p => p[c]))) as RGB;
    // Ignore ink-like pixels (letters, bubble outlines) — they say nothing about the background.
    const paper = ring.filter(p => dist(p, bg) <= 80);
    const nearShare = paper.filter(p => dist(p, bg) <= 12).length / Math.max(1, paper.length);
    const inkShare = 1 - paper.length / Math.max(1, ring.length);

    const ink = inner.filter(p => dist(p, bg) > 80);
    const textColor: RGB = ink.length
        ? ([0, 1, 2].map(c => median(ink.map(p => p[c]))) as RGB)
        : (bg.reduce((a, b) => a + b) / 3 > 128 ? [0, 0, 0] : [255, 255, 255]);

    const background: TextStyle['background'] = nearShare >= 0.9 ? 'flat' : nearShare >= 0.5 && inkShare < 0.35 ? 'gradient' : 'art';

    return {
        textColor: hex(textColor),
        outlineColor: null,
        glow: false,
        bold: false,
        align: 'center',
        background,
        backgroundColor: background === 'art' ? null : hex(bg),
    };
}
