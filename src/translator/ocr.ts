import { PaddleOcrService, V5_EN_MOBILE_MODEL, V5_MOBILE_MODEL } from 'ppu-paddle-ocr';
import { config } from '../config/settings.js';
import { logger } from '../config/logger.js';
import { sliceTiles } from './tiles.js';
import type { Box, OcrLine } from './types.js';

/**
 * PaddleOCR v5 (English recogniser) running locally through ONNX Runtime.
 * Both models are loaded as plain .onnx — the library's default .ort files are
 * CPU-optimised and crash under DirectML (GPU).
 */
const MODEL = {
    ...V5_EN_MOBILE_MODEL,
    detection: V5_MOBILE_MODEL.detection,
    recognition: V5_EN_MOBILE_MODEL.recognition.replace(/\.ort$/, '.onnx'),
};

export const OCR_ENGINE = 'paddleocr-v5-en-mobile';

let service: PaddleOcrService | null = null;

async function getService(): Promise<PaddleOcrService> {
    if (service) {
        return service;
    }
    const provider = config.translator.ocrProvider;
    const s = new PaddleOcrService({
        model: MODEL,
        detection: { maxSideLength: config.translator.tileHeight },
        session: {
            executionProviders: [provider],
            onSessionFallback: err => logger.warn(`OCR: ${provider} unavailable, falling back to CPU (${String(err).slice(0, 120)})`),
        },
    });
    await s.initialize();
    logger.info(`OCR ready (${OCR_ENGINE} on ${provider})`);
    service = s;
    return s;
}

export async function closeOcr(): Promise<void> {
    await service?.destroy();
    service = null;
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

/** Reads every text line on a page. Tall strips are processed as overlapping tiles. */
export async function ocrPage(file: string): Promise<{ width: number; height: number; lines: OcrLine[] }> {
    const ocr = await getService();
    const { tileHeight, tileOverlap } = config.translator;
    const { width, height, tiles } = await sliceTiles(file, tileHeight, tileOverlap);

    const found: OcrLine[] = [];
    for (const tile of tiles) {
        const png = tile.data;
        const res = await ocr.recognize(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, { flatten: true, minimumConfidence: 0.5 });
        const isFirst = tile.top === 0;
        const isLast = tile.top + tile.height >= height;

        for (const item of res.results) {
            const text = item.text.trim();
            if (!text) {
                continue;
            }
            // Lines touching a cut edge are incomplete here; the overlapping tile has them whole.
            const touchesTop = !isFirst && item.box.y <= 2;
            const touchesBottom = !isLast && item.box.y + item.box.height >= tile.height - 2;
            if (touchesTop || touchesBottom) {
                continue;
            }
            found.push({
                text,
                confidence: item.confidence,
                box: { x: item.box.x, y: tile.top + item.box.y, w: item.box.width, h: item.box.height },
            });
        }
    }

    // Lines inside the overlap are read twice: keep the more confident reading.
    found.sort((a, b) => b.confidence - a.confidence);
    const lines: OcrLine[] = [];
    for (const l of found) {
        if (!lines.some(k => iou(k.box, l.box) > 0.5)) {
            lines.push(l);
        }
    }
    lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    return { width, height, lines };
}
