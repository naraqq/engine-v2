import { PaddleOcrService, V5_EN_MOBILE_MODEL, V5_MOBILE_MODEL } from 'ppu-paddle-ocr';
import sharp from 'sharp';
import { config } from '../config/settings.js';
import { logger } from '../config/logger.js';
import { sliceTiles } from './tiles.js';
import type { Box, OcrLine } from './types.js';

/**
 * PaddleOCR v5 running locally through ONNX Runtime, with two recognisers:
 *  - English (main): reads the page. Scanlations are English, and this model is the most
 *    accurate on comic lettering.
 *  - Chinese/Japanese/English (second pass): lines the English model reads badly are cropped and
 *    read again by it. Scanlators sometimes leave a few bubbles in Chinese or Japanese; the English
 *    model reads those as junk, so they were dropped and stayed untranslated on the page.
 * Both models are loaded as plain .onnx: the library's .ort files are CPU-optimised and crash
 * under DirectML (GPU).
 */
const MODELS = {
    en: {
        ...V5_EN_MOBILE_MODEL,
        detection: V5_MOBILE_MODEL.detection,
        recognition: V5_EN_MOBILE_MODEL.recognition.replace(/\.ort$/, '.onnx'),
    },
    cjk: V5_MOBILE_MODEL,
} as const;
type Kind = keyof typeof MODELS;

export const OCR_ENGINE = 'paddleocr-v5-en-mobile+cjk';

/** Chinese characters, Japanese kana, and CJK punctuation/full-width forms. */
export const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;
const CJK_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

const services: Partial<Record<Kind, PaddleOcrService>> = {};

async function getService(kind: Kind): Promise<PaddleOcrService> {
    const cached = services[kind];
    if (cached) {
        return cached;
    }
    const provider = config.translator.ocrProvider;
    const s = new PaddleOcrService({
        model: MODELS[kind],
        detection: { maxSideLength: config.translator.tileHeight * Math.max(...config.translator.ocrScales) },
        session: {
            executionProviders: [provider],
            onSessionFallback: err => logger.warn(`OCR (${kind}): ${provider} unavailable, falling back to CPU (${String(err).slice(0, 120)})`),
        },
    });
    await s.initialize();
    logger.info(`OCR ready (${kind === 'en' ? 'paddleocr-v5-en-mobile' : 'paddleocr-v5-mobile, Chinese/Japanese'} on ${provider})`);
    services[kind] = s;
    return s;
}

export async function closeOcr(): Promise<void> {
    for (const kind of Object.keys(services) as Kind[]) {
        await services[kind]?.destroy();
        delete services[kind];
    }
}

function iou(a: Box, b: Box): number {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (w <= 0 || h <= 0) {
        return 0;
    }
    const i = w * h;
    return i / (a.w * a.h + b.w * b.h - i);
}

/** Share of box [a]'s area that lies inside box [b]. */
function overlapShare(a: Box, b: Box): number {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? (w * h) / (a.w * a.h) : 0;
}

const toArrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/**
 * Second pass on one badly read line: crops it (with a margin, in the tile image the English model
 * saw) and reads it with the Chinese/Japanese model. Returns its reading and its box in tile pixels,
 * if it is mostly Chinese/Japanese and confident enough, else null. Horizontal text only: vertical
 * columns aren't found as lines by the detector (in English scanlations those are almost always
 * sound effects or handwriting drawn into the art, which are skipped anyway).
 */
async function readCjk(tilePng: Buffer, size: { width: number; height: number }, box: { x: number; y: number; width: number; height: number }) {
    const pad = Math.round(Math.max(6, Math.min(box.width, box.height) * 0.35));
    const left = Math.max(0, Math.floor(box.x - pad));
    const top = Math.max(0, Math.floor(box.y - pad));
    const width = Math.min(size.width - left, Math.ceil(box.width + 2 * pad));
    const height = Math.min(size.height - top, Math.ceil(box.height + 2 * pad));
    if (width < 8 || height < 8) {
        return null;
    }
    const crop = await sharp(tilePng).extract({ left, top, width, height }).png({ compressionLevel: 1 }).toBuffer();
    const res = await (await getService('cjk')).recognize(toArrayBuffer(crop), {
        flatten: true,
        minimumConfidence: config.translator.ocrMinConfidence,
    });
    const parts = res.results.filter(r => r.text.trim() && CJK.test(r.text));
    if (!parts.length) {
        return null;
    }
    parts.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const text = parts.map(r => r.text.trim()).join('');
    const chars = text.match(CJK_CHARS)?.length ?? 0;
    // Mostly Chinese/Japanese, not an English line it happened to read too.
    if (!chars || chars < text.replace(/\s/g, '').length / 2) {
        return null;
    }
    const x = Math.min(...parts.map(r => r.box.x)), y = Math.min(...parts.map(r => r.box.y));
    return {
        text,
        confidence: parts.reduce((a, r) => a + r.confidence, 0) / parts.length,
        box: {
            x: left + x,
            y: top + y,
            width: Math.max(...parts.map(r => r.box.x + r.box.width)) - x,
            height: Math.max(...parts.map(r => r.box.y + r.box.height)) - y,
        },
    };
}

/**
 * Does this English-model reading look like Chinese/Japanese it couldn't read? It gives up with a
 * weak or empty reading, or "reads" a line of square characters as a few Latin ones spread wide
 * ("T!" across a whole line). Latin letters are about 0.6x as wide as they are tall, CJK ones 1x.
 * A false alarm only costs a quick second read: its result
 * replaces the English one only if it is mostly Chinese/Japanese.
 */
function looksUnread(text: string, confidence: number, w: number, h: number, minConfidence: number): boolean {
    // A horizontal line of dialogue-sized characters; most weak readings are art texture, specks
    // or speed lines, which aren't shaped like one.
    if (h < 14 || h > 120 || w < h * 0.8) {
        return false;
    }
    if (confidence < minConfidence || !text) {
        return true;
    }
    // A few Latin characters spread across the line. Real English lines (more characters) can
    // come out a little wide too, because of their box padding: only very wide ones count.
    const len = text.replace(/\s/g, '').length;
    const ratio = w / (len * h);
    return (len <= 4 && ratio > 0.8) || ratio > 1.5;
}

/**
 * Reads every text line on a page. Tall strips are processed as overlapping tiles, each read at
 * several zoom levels (OCR_SCALES, default 1,2): big lettering is found at 1x, small or stylised lettering is only
 * readable when enlarged, and the scales catch different lines. The best reading of each line wins.
 * Lines the English model reads badly get a second read for Chinese/Japanese (see MODELS).
 */
export async function ocrPage(file: string): Promise<{ width: number; height: number; lines: OcrLine[]; cjkLines: number }> {
    const ocr = await getService('en');
    const { tileHeight, tileOverlap, ocrScales, ocrMinConfidence } = config.translator;
    const { width, height, tiles, encode } = await sliceTiles(file, tileHeight, tileOverlap);
    const baseScale = Math.min(...ocrScales);

    // Every (tile, scale) image, in order. The next one is encoded (CPU, sharp's thread pool)
    // while the current one is being read (GPU), instead of the two taking turns.
    const jobs = tiles.flatMap(tile => ocrScales.map(scale => ({ tile, scale })));
    let next: Promise<Buffer> | null = jobs.length ? encode(jobs[0].tile, jobs[0].scale) : null;

    const found: (OcrLine & { cjk?: boolean })[] = [];
    for (const [j, { tile, scale }] of jobs.entries()) {
        const isFirst = tile.top === 0;
        const isLast = tile.top + tile.height >= height;

        const png = await next!;
        next = j + 1 < jobs.length ? encode(jobs[j + 1].tile, jobs[j + 1].scale) : null;
        next?.catch(() => {}); // surfaced when awaited; avoids an unhandled rejection meanwhile
        // Everything the English model sees, weak readings too: those get the Chinese/Japanese pass.
        const res = await ocr.recognize(toArrayBuffer(png), { flatten: true, minimumConfidence: 0 });
        const size = { width: Math.round(tile.width * scale), height: Math.round(tile.height * scale) };

        for (const item of res.results) {
            let text = item.text.trim();
            let confidence = item.confidence;
            let cjk = false;
            let box = { x: item.box.x / scale, y: item.box.y / scale, w: item.box.width / scale, h: item.box.height / scale };
            // Lines touching a cut edge are incomplete here; the overlapping tile has them whole.
            const touchesTop = !isFirst && box.y <= 2;
            const touchesBottom = !isLast && box.y + box.h >= tile.height - 2;
            if (touchesTop || touchesBottom) {
                continue;
            }
            // Chinese/Japanese dialogue is readable at the base zoom: the second pass skips the
            // enlarged tiles (most weak readings there are art texture).
            if (scale === baseScale && looksUnread(text, confidence, box.w, box.h, ocrMinConfidence)) {
                const second = await readCjk(png, size, item.box).catch(() => null);
                if (second && second.confidence >= ocrMinConfidence) {
                    ({ text, confidence } = second);
                    box = { x: second.box.x / scale, y: second.box.y / scale, w: second.box.width / scale, h: second.box.height / scale };
                    cjk = true;
                }
            }
            if (!cjk && (confidence < ocrMinConfidence || !text)) {
                continue;
            }
            // A lone dot or comma: the weak readings the English model now also returns, never dialogue.
            if (!cjk && /^[.,'`/\|:;]$/.test(text)) {
                continue;
            }
            found.push({
                text,
                confidence,
                box: { x: Math.round(box.x), y: Math.round(tile.top + box.y), w: Math.round(box.w), h: Math.round(box.h) },
                ...(cjk ? { cjk } : {}),
            });
        }
    }

    // The same line is read by several scales/overlapping tiles: keep the most confident reading.
    // A Chinese/Japanese reading wins over English ones of the same spot (those are the junk the
    // English model made of it, e.g. at the other zoom level), even if they overlap it only partly.
    found.sort((a, b) => Number(Boolean(b.cjk)) - Number(Boolean(a.cjk)) || b.confidence - a.confidence);
    const lines: (OcrLine & { cjk?: boolean })[] = [];
    for (const l of found) {
        if (!lines.some(k => iou(k.box, l.box) > 0.5 || (k.cjk && !l.cjk && overlapShare(l.box, k.box) > 0.4))) {
            lines.push(l);
        }
    }
    lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const cjkLines = lines.filter(l => l.cjk).length;
    return { width, height, lines: lines.map(({ cjk: _cjk, ...l }) => l), cjkLines };
}
