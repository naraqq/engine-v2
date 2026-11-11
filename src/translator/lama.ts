import { existsSync } from 'fs';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { config } from '../config/settings.js';
import { logger } from '../config/logger.js';

/**
 * LaMa inpainting (big-lama, ONNX export by Carve: fixed 512x512 input).
 * Runs on CPU: DirectML can't execute the model's Fourier-convolution MatMuls (~1.6 s per window on CPU).
 */
const SIZE = 512;
let session: ort.InferenceSession | null = null;
let unavailable = false;

async function getSession(): Promise<ort.InferenceSession | null> {
    if (session || unavailable) {
        return session;
    }
    const file = config.translator.lamaModel;
    if (!existsSync(file)) {
        unavailable = true;
        logger.warn(`LaMa model not found at ${file} — using simple background blending for text on artwork.`);
        return null;
    }
    const t = Date.now();
    session = await ort.InferenceSession.create(file, { executionProviders: ['cpu'] });
    logger.info(`LaMa inpainting ready (${Math.round((Date.now() - t) / 1000)}s to load)`);
    return session;
}

export interface RgbaImage {
    data: Buffer;
    width: number;
    height: number;
}

/** Runs LaMa on one window of the page (native resolution when the page is ≥ 512 px in both directions). */
async function runWindow(s: ort.InferenceSession, img: RgbaImage, mask: Uint8Array, wx: number, wy: number, ww: number, wh: number): Promise<void> {
    const crop = Buffer.alloc(ww * wh * 3);
    const cropMask = Buffer.alloc(ww * wh);
    let holes = 0;
    for (let j = 0; j < wh; j++) {
        for (let i = 0; i < ww; i++) {
            const p = (wy + j) * img.width + (wx + i);
            crop[(j * ww + i) * 3] = img.data[p * 4];
            crop[(j * ww + i) * 3 + 1] = img.data[p * 4 + 1];
            crop[(j * ww + i) * 3 + 2] = img.data[p * 4 + 2];
            cropMask[j * ww + i] = mask[p] ? 255 : 0;
            holes += mask[p];
        }
    }
    if (!holes) {
        return;
    }

    const native = ww === SIZE && wh === SIZE;
    const rgb = native ? crop : await sharp(crop, { raw: { width: ww, height: wh, channels: 3 } }).resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer();
    // extractChannel: sharp turns 1-channel raw input into 3 channels on resize.
    const m = native ? cropMask : await sharp(cropMask, { raw: { width: ww, height: wh, channels: 1 } }).resize(SIZE, SIZE, { fit: 'fill' }).extractChannel(0).raw().toBuffer();

    const plane = SIZE * SIZE;
    const imageT = new Float32Array(3 * plane);
    const maskT = new Float32Array(plane);
    for (let k = 0; k < plane; k++) {
        // The holes must be blanked out — LaMa reconstructs whatever it can still see.
        const hole = m[k] > 0;
        maskT[k] = hole ? 1 : 0;
        imageT[k] = hole ? 0 : rgb[k * 3] / 255;
        imageT[plane + k] = hole ? 0 : rgb[k * 3 + 1] / 255;
        imageT[2 * plane + k] = hole ? 0 : rgb[k * 3 + 2] / 255;
    }

    const out = await s.run({
        [s.inputNames[0]]: new ort.Tensor('float32', imageT, [1, 3, SIZE, SIZE]),
        [s.inputNames[1]]: new ort.Tensor('float32', maskT, [1, 1, SIZE, SIZE]),
    });
    const o = out[s.outputNames[0]].data as Float32Array; // 0..255, CHW

    const res = Buffer.alloc(plane * 3);
    for (let k = 0; k < plane; k++) {
        res[k * 3] = Math.max(0, Math.min(255, Math.round(o[k])));
        res[k * 3 + 1] = Math.max(0, Math.min(255, Math.round(o[plane + k])));
        res[k * 3 + 2] = Math.max(0, Math.min(255, Math.round(o[2 * plane + k])));
    }
    const back = native ? res : await sharp(res, { raw: { width: SIZE, height: SIZE, channels: 3 } }).resize(ww, wh, { fit: 'fill' }).raw().toBuffer();

    for (let j = 0; j < wh; j++) {
        for (let i = 0; i < ww; i++) {
            const p = (wy + j) * img.width + (wx + i);
            if (mask[p]) {
                img.data[p * 4] = back[(j * ww + i) * 3];
                img.data[p * 4 + 1] = back[(j * ww + i) * 3 + 1];
                img.data[p * 4 + 2] = back[(j * ww + i) * 3 + 2];
                img.data[p * 4 + 3] = 255;
            }
        }
    }
}

/** Window start positions covering [from, to] with 512-px windows overlapping by 128 px. */
function windowStarts(from: number, to: number, limit: number): number[] {
    const size = Math.min(SIZE, limit);
    const centre = Math.round((from + to) / 2 - size / 2);
    if (to - from <= size - 128) {
        return [Math.max(0, Math.min(limit - size, centre))];
    }
    const starts: number[] = [];
    for (let s = Math.max(0, from - 64); ; s += size - 128) {
        const clamped = Math.min(limit - size, s);
        starts.push(clamped);
        if (clamped + size >= Math.min(limit, to + 64)) {
            break;
        }
    }
    return starts;
}

/**
 * Inpaints `mask` (1 = remove, page-sized) inside `area` of `img`, in place, at native resolution
 * using overlapping 512x512 windows. Returns false if LaMa isn't available (caller falls back).
 */
export async function inpaint(img: RgbaImage, mask: Uint8Array, area: { x: number; y: number; w: number; h: number }): Promise<boolean> {
    const s = await getSession();
    if (!s) {
        return false;
    }
    const ww = Math.min(SIZE, img.width), wh = Math.min(SIZE, img.height);
    for (const wy of windowStarts(area.y, area.y + area.h, img.height)) {
        for (const wx of windowStarts(area.x, area.x + area.w, img.width)) {
            await runWindow(s, img, mask, wx, wy, ww, wh);
        }
    }
    return true;
}
