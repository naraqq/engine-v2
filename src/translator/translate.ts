import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config/settings.js';
import { generateJson, type LabeledImage } from './llm.js';
import type { Glossary, GlossaryTerm, Region, RegionType } from './types.js';

/** Starter terms for game-system text. Edit glossary.json per series to change them. */
const DEFAULT_TERMS: GlossaryTerm[] = [
    { en: 'Level', mn: 'Түвшин' },
    { en: 'Skill', mn: 'Ур чадвар' },
    { en: 'Quest', mn: 'Даалгавар' },
    { en: 'Status', mn: 'Төлөв' },
    { en: 'EXP', mn: 'Туршлага' },
    { en: 'HP', mn: 'HP', note: 'keep as-is' },
    { en: 'MP', mn: 'MP', note: 'keep as-is' },
];

export async function loadGlossary(seriesDir: string): Promise<Glossary> {
    const file = path.join(seriesDir, 'glossary.json');
    try {
        return JSON.parse(await fs.readFile(file, 'utf8')) as Glossary;
    } catch {
        const glossary = { terms: DEFAULT_TERMS };
        await fs.mkdir(seriesDir, { recursive: true });
        await fs.writeFile(file, JSON.stringify(glossary, null, 2) + '\n', 'utf8');
        return glossary;
    }
}

export async function saveGlossary(seriesDir: string, glossary: Glossary): Promise<void> {
    await fs.writeFile(path.join(seriesDir, 'glossary.json'), JSON.stringify(glossary, null, 2) + '\n', 'utf8');
}

interface StyleGuide {
    rules: string[];
    examples: { en: string; ai?: string; natural: string }[];
}

/** The Mongolian voice (assets/translation/style.json): rules + "avoid → write" example pairs. Re-read every run so edits apply immediately. */
async function styleSection(): Promise<string> {
    let style: StyleGuide;
    try {
        style = JSON.parse(await fs.readFile(config.translator.styleFile, 'utf8')) as StyleGuide;
    } catch {
        return '';
    }
    const rules = style.rules.map(r => `- ${r}`).join('\n');
    const examples = style.examples
        .map(e => `EN: ${e.en}\n${e.ai ? `  ✗ ${e.ai}\n` : ''}  ✓ ${e.natural}`)
        .join('\n');
    return `\n\nMONGOLIAN VOICE (mandatory — this matters more than literal accuracy):\n${rules}\n\nExamples of the voice (✗ = sounds machine-translated, ✓ = how it should read):\n${examples}`;
}

const SYSTEM = `You are a professional manga/webtoon translator from English into Mongolian (Cyrillic script).

INPUT: text blocks from an OCR engine, in reading order, for a whole chapter. Each block has OCR lines plus layout hints:
bg = background colour behind the text, bgType = flat/gradient/art, ink = text colour, size = block width x height in px, x = horizontal position.

1. CLASSIFY each block ("kind"):
   - speech: dialogue bubble   - thought: inner monologue   - narration: caption box / narration
   - system: game-style system/status/notification window (often gradient/blue/dark backgrounds, brackets like [QUEST])
   - skip: sound effects / onomatopoeia (e.g. BOOM, HUFF, ARGHHH as SFX lettering), signs, labels, logos, watermarks, scanlator/publisher credits and their URLs, staff roles (Translator, Editor, Proofreader), page numbers, OCR garbage.
   NOT skip (treat as narration): character introduction cards (name, age, job), translator notes like *Note: ..., "To be continued...", time/place captions.
   When unsure between dialogue and skip, prefer dialogue if it reads as words someone says.

2. FIX OCR ERRORS ("source") — always return the corrected text, never copy OCR mistakes:
   - The OCR very often MERGES neighbouring words: "BECAUSEI" → "BECAUSE I", "THROWIT" → "THROW IT", "WILLINGTO" → "WILLING TO", "WASI" → "WAS I".
   - It misreads letters (0/O, 1/I/l, rn/m), drops letters at line ends ("AUTOMATICALL" → "AUTOMATICALLY"), and may split one bubble into two blocks.
   - Use the chapter context to restore the intended English. Keep one entry per visual line. For skip blocks return source = [].

3. TRANSLATE ("mn"), unless kind is skip (then mn = []):
   - Natural, colloquial Mongolian, true to each character's voice; not word-for-word. Correct spelling, including Ө ө and Ү ү.
   - Translate every English word; only product/model names, codes and stat abbreviations (ARK-2020, H-SOFT, HP, STR) may stay Latin.
   - Do not add meaning that is not in the source.
   - The GLOSSARY is mandatory. Transliterate new names consistently and report them in new_terms.
   - system: exactly one mn line per source line; keep brackets, numbers, colons and stat layout.
   - everything else: a single string in mn (it is re-wrapped to fit) — except character cards and lists (e.g. "NAME (27)" / "JOB: ..."), which keep one mn entry per logical line.

IMAGES: blocks marked "crop": true come with a picture of that spot on the page, sent after the JSON and labelled with the block id.
   - Trust the picture over the OCR text: read the actual lettering (stylised fonts often fool the OCR), and use "source" for what is really written.
   - The OCR often MISSES whole lines of a bubble, usually the first or the last. The crop shows the area around the block: if the same bubble/box has more lines than the OCR gave you, put the complete text in "source" and translate all of it. Ignore text that belongs to a different bubble.
   - Use the art for tone: who is speaking, their expression, shouting vs. whispering, a machine or system voice.
   - If the picture shows no real text there (art, texture, a watermark), the block is skip.

Return one entry for every id.`;

/** Cuts a picture of a region out of its page (JPEG), or null when unavailable. */
export type CropRegion = (region: Region) => Promise<Buffer | null>;

/** Most crops per request; the largest likely-text blocks get one first. */
const MAX_CROPS = 60;

/** Blocks big and wordy enough that a picture can help (not 3-px specks). */
const worthCrop = (r: Region) =>
    r.box.w >= 24 && r.box.h >= 12 && r.lines.join('').replace(/[^p{L}]/gu, '').length >= 3;

const SCHEMA = {
    type: 'object',
    properties: {
        blocks: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    kind: { type: 'string', enum: ['speech', 'thought', 'narration', 'system', 'skip'] },
                    source: { type: 'array', items: { type: 'string' } },
                    mn: { type: 'array', items: { type: 'string' } },
                },
                required: ['id', 'kind', 'source', 'mn'],
            },
        },
        new_terms: {
            type: 'array',
            items: {
                type: 'object',
                properties: { en: { type: 'string' }, mn: { type: 'string' }, note: { type: 'string' } },
                required: ['en', 'mn'],
            },
        },
    },
    required: ['blocks', 'new_terms'],
};

interface BlockResult {
    id: string;
    kind: Exclude<RegionType, 'unknown'>;
    source: string[];
    mn: string[];
}

/** Regions are sent in chunks so very long chapters don't hit output limits. */
const CHUNK_SIZE = 80;

/** Compact description of a block for the model (OCR text + measured layout hints). */
function describe(r: Region, pageWidth: number, crop = false) {
    const cx = (r.box.x + r.box.w / 2) / pageWidth;
    return {
        ...(crop ? { crop: true } : {}),
        id: r.id,
        ocr: r.lines,
        bg: r.style.backgroundColor ?? 'mixed',
        bgType: r.style.background,
        ink: r.style.textColor,
        size: `${r.box.w}x${r.box.h}`,
        x: cx < 0.35 ? 'left' : cx > 0.65 ? 'right' : 'center',
    };
}

const needsWork = (r: Region) =>
    r.type === 'unknown' || (r.type !== 'skip' && (!r.translation?.length || (r.type === 'system' && r.translation.length !== r.lines.length)));

/**
 * Classifies, corrects and translates all given regions (whole chapter, reading order).
 * Sets region.type, region.lines (corrected source) and region.translation.
 */
export async function translateRegions(
    regions: Region[],
    pageWidths: Map<string, number>,
    glossary: Glossary,
    model = config.translator.translateModel,
    crop?: CropRegion,
): Promise<void> {
    await translatePass(regions, pageWidths, glossary, model, crop);

    // Retry once for anything missing or a system window whose line count came back wrong.
    const bad = regions.filter(needsWork);
    if (bad.length) {
        await translatePass(bad, pageWidths, glossary, model, crop);
        for (const r of bad) {
            if (r.type === 'system' && r.translation && r.translation.length !== r.lines.length) {
                const t = r.translation;
                r.translation = r.lines.map((_, i) => (i < r.lines.length - 1 ? t[i] ?? '' : t.slice(i).join(' ')));
            }
        }
    }
}

async function translatePass(regions: Region[], pageWidths: Map<string, number>, glossary: Glossary, model: string, crop?: CropRegion): Promise<void> {
    const system = SYSTEM + (await styleSection());
    for (let i = 0; i < regions.length; i += CHUNK_SIZE) {
        const chunk = regions.slice(i, i + CHUNK_SIZE);
        const context = regions
            .slice(Math.max(0, i - 30), i)
            .filter(r => r.type !== 'skip')
            .map(r => `${r.lines.join(' ')} → ${(r.translation ?? []).join(' ')}`);

        // Pictures for the blocks most likely to be real text, largest first.
        const images: LabeledImage[] = [];
        const withCrop = new Set<string>();
        if (crop) {
            const picks = chunk.filter(worthCrop).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h).slice(0, MAX_CROPS);
            for (const r of chunk.filter(r => picks.includes(r))) {
                const data = await crop(r).catch(() => null);
                if (data) {
                    images.push({ label: `Crop for block ${r.id}:`, data, mime: 'image/jpeg' });
                    withCrop.add(r.id);
                }
            }
        }

        const payload = {
            glossary: glossary.terms,
            previous_context: context,
            blocks: chunk.map(r => describe(r, pageWidths.get(r.id.split('#')[0]) ?? 720, withCrop.has(r.id))),
        };

        const res = await generateJson<{ blocks: BlockResult[]; new_terms: GlossaryTerm[] }>({
            model,
            system,
            schema: SCHEMA,
            user: JSON.stringify(payload),
            images,
            maxOutputTokens: 32768,
        });

        const byId = new Map(res.blocks.map(b => [b.id, b]));
        for (const r of chunk) {
            const b = byId.get(r.id);
            if (!b) {
                continue;
            }
            r.type = b.kind;
            if (b.source?.length) {
                r.lines = b.source;
            }
            r.translation = b.kind === 'skip' ? [] : b.mn;
        }

        for (const term of res.new_terms ?? []) {
            if (!glossary.terms.some(t => t.en.toLowerCase() === term.en.toLowerCase())) {
                glossary.terms.push(term);
            }
        }
    }
}

const POLISH_SYSTEM = `You are a native Mongolian editor for webtoon scanlations. You receive a chapter's draft Mongolian lines (machine translated) with the English original for meaning only.

Rewrite every draft so it reads like a Mongolian reader actually talks, following the MONGOLIAN VOICE below:
- Read the draft as Mongolian first. If it sounds translated, rewrite it from scratch; do not just swap words.
- Keep the meaning and the speaker's attitude (anger, sarcasm, laziness, swearing), not the English sentence structure.
- Shorter is usually better. Drop words the scene makes obvious.
- Keep names exactly as in the draft, and keep glossary terms.
- kind "system": return exactly the same number of lines as the draft, keep brackets/numbers/colons.
- Other kinds: return one string (keep separate entries only if the draft has several for a card/list).
- If a draft is already natural, return it unchanged.
Return one entry for every id.`;

const POLISH_SCHEMA = {
    type: 'object',
    properties: {
        blocks: {
            type: 'array',
            items: {
                type: 'object',
                properties: { id: { type: 'string' }, mn: { type: 'array', items: { type: 'string' } } },
                required: ['id', 'mn'],
            },
        },
    },
    required: ['blocks'],
};

/**
 * Second pass: a "native editor" rewrites the draft translations into natural spoken Mongolian
 * (the main cure for translated-sounding text). Only replaces lines it returns in the right shape.
 */
export async function polishRegions(regions: Region[], model = config.translator.translateModel): Promise<number> {
    const todo = regions.filter(r => r.type !== 'skip' && r.type !== 'unknown' && r.translation?.some(t => t.trim()));
    const system = POLISH_SYSTEM + (await styleSection());
    let changed = 0;
    for (let i = 0; i < todo.length; i += CHUNK_SIZE) {
        const chunk = todo.slice(i, i + CHUNK_SIZE);
        const res = await generateJson<{ blocks: { id: string; mn: string[] }[] }>({
            model,
            system,
            schema: POLISH_SCHEMA,
            user: JSON.stringify({ blocks: chunk.map(r => ({ id: r.id, kind: r.type, en: r.lines.join(' '), draft: r.translation })) }),
            maxOutputTokens: 32768,
        });
        const byId = new Map(res.blocks.map(b => [b.id, b.mn]));
        for (const r of chunk) {
            const mn = byId.get(r.id)?.filter(t => t.trim());
            if (!mn?.length || (r.type === 'system' && mn.length !== r.translation!.length)) {
                continue;
            }
            if (mn.join(' ') !== r.translation!.join(' ')) {
                changed++;
            }
            r.translation = mn;
        }
    }
    return changed;
}

export { needsWork };
