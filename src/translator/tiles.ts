import sharp from 'sharp';

export interface Tile {
    /** Offset of this tile from the top of the page, in page pixels. */
    top: number;
    width: number;
    height: number;
}

export interface TiledPage {
    width: number;
    height: number;
    tiles: Tile[];
    /** PNG of one tile, scaled by `scale` (lanczos3). Cut from the page decoded once, in memory. */
    encode(tile: Tile, scale: number): Promise<Buffer>;
}

/**
 * Cuts a (possibly very tall) page into overlapping horizontal tiles.
 * The overlap should be larger than the tallest bubble so every bubble
 * appears whole in at least one tile.
 *
 * The page is decoded once; tiles are cut from the raw pixels (decoding a 15000-px JPEG per tile
 * was most of the CPU time). PNG is lossless, so the fast compression level changes nothing the
 * OCR sees.
 */
export async function sliceTiles(file: string, tileHeight: number, overlap: number): Promise<TiledPage> {
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const step = tileHeight - overlap;
    const tiles: Tile[] = [];

    for (let top = 0; ; top += step) {
        const h = Math.min(tileHeight, height - top);
        tiles.push({ top, width, height: h });
        if (top + h >= height) {
            break;
        }
    }

    const rowBytes = width * channels;
    const encode = (tile: Tile, scale: number) => {
        // Rows are contiguous, so a full-width tile is a plain slice of the buffer (no copy).
        const pixels = data.subarray(tile.top * rowBytes, (tile.top + tile.height) * rowBytes);
        let img = sharp(pixels, { raw: { width, height: tile.height, channels } });
        if (scale !== 1) {
            img = img.resize({ width: Math.round(width * scale), kernel: 'lanczos3' });
        }
        return img.png({ compressionLevel: 1 }).toBuffer();
    };
    return { width, height, tiles, encode };
}
