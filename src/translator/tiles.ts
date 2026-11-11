import sharp from 'sharp';

export interface Tile {
    /** Offset of this tile from the top of the page, in page pixels. */
    top: number;
    width: number;
    height: number;
    data: Buffer;
    mimeType: string;
}

/**
 * Cuts a (possibly very tall) page into overlapping horizontal tiles.
 * The overlap should be larger than the tallest bubble so every bubble
 * appears whole in at least one tile.
 */
export async function sliceTiles(file: string, tileHeight: number, overlap: number): Promise<{ width: number; height: number; tiles: Tile[] }> {
    const meta = await sharp(file).metadata();
    const width = meta.width!;
    const height = meta.height!;
    const step = tileHeight - overlap;
    const tiles: Tile[] = [];

    for (let top = 0; ; top += step) {
        const h = Math.min(tileHeight, height - top);
        const data = await sharp(file)
            .extract({ left: 0, top, width, height: h })
            .png()
            .toBuffer();
        tiles.push({ top, width, height: h, data, mimeType: 'image/png' });
        if (top + h >= height) {
            break;
        }
    }
    return { width, height, tiles };
}
