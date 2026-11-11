import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config/settings.js';
import { generateJson } from './gemini.js';
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
   - everything else: a single string in mn (it is re-wrapped to fit).

Return one entry for every id.`;

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
function describe(r: Region, pageWidth: number) {
    const cx = (r.box.x + r.box.w / 2) / pageWidth;
    return {
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
export async function translateRegions(regions: Region[], pageWidths: Map<string, number>, glossary: Glossary): Promise<void> {
    await translatePass(regions, pageWidths, glossary);

    // Retry once for anything missing or a system window whose line count came back wrong.
    const bad = regions.filter(needsWork);
    if (bad.length) {
        await translatePass(bad, pageWidths, glossary);
        for (const r of bad) {
            if (r.type === 'system' && r.translation && r.translation.length !== r.lines.length) {
                const t = r.translation;
                r.translation = r.lines.map((_, i) => (i < r.lines.length - 1 ? t[i] ?? '' : t.slice(i).join(' ')));
            }
        }
    }
}

async function translatePass(regions: Region[], pageWidths: Map<string, number>, glossary: Glossary): Promise<void> {
    for (let i = 0; i < regions.length; i += CHUNK_SIZE) {
        const chunk = regions.slice(i, i + CHUNK_SIZE);
        const context = regions
            .slice(Math.max(0, i - 30), i)
            .filter(r => r.type !== 'skip')
            .map(r => `${r.lines.join(' ')} → ${(r.translation ?? []).join(' ')}`);

        const payload = {
            glossary: glossary.terms,
            previous_context: context,
            blocks: chunk.map(r => describe(r, pageWidths.get(r.id.split('#')[0]) ?? 720)),
        };

        const res = await generateJson<{ blocks: BlockResult[]; new_terms: GlossaryTerm[] }>({
            model: config.translator.translateModel,
            system: SYSTEM,
            schema: SCHEMA,
            contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload) }] }],
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

export { needsWork };
