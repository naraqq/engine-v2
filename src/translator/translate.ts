import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config/settings.js';
import { generateJson } from './llm.js';
import type { Glossary, GlossaryTerm, Region, RegionType } from './types.js';

/** Chinese characters and Japanese kana. */
const CJK_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
/** Chinese scanlation group credits: 汉化 (fan translation), 翻译 (translator), 嵌字 (typesetting), 校对 (proofreading), 图源 (raw source)… */
const CJK_CREDITS = /汉化|漢化|翻译|翻譯|嵌字|校对|校對|图源|圖源|修图|修圖|微博|QQ群|禁止转载|禁止轉載/;

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
The source is an English scanlation, but scanlators sometimes leave a few bubbles in Chinese or Japanese: translate those directly from the Chinese/Japanese, the same way, as part of the same scene.

INPUT: OCR text blocks in reading order, often several consecutive chapters of one series ("=== <chapter> ===" marks where each starts). Use the whole story for context: keep names, tone, running jokes and how characters address each other (чи/та) consistent across chapters.
Each block is one line: "<id> | <text>". " / " separates the OCR lines of one block. A tag like [art], [gradient #1a2b4c] or [flat #20232a] gives the background when it isn't a plain white bubble.

For every block decide:
- skip: sound effects / onomatopoeia lettering (BOOM, HUFF, ARGHHH, and Chinese/Japanese ones drawn into the art like 轰, 砰, ドン, ゴゴゴ), signs, labels, logos, watermarks, scanlator/publisher credits and their URLs (also Chinese ones: 汉化, 翻译, 嵌字, 图源…), staff roles, page numbers, OCR garbage.
  NOT skip: character introduction cards (name, age, job), translator notes (TL note: ...), "To be continued...", time/place captions (narration).
  When unsure between dialogue and skip, prefer dialogue if it reads as words someone says.
- otherwise kind = speech (bubble), thought (inner monologue), narration (caption box), or system (game-style status/notification window, often a dark/blue/gradient box or [BRACKETS]), and translate it:
  - The OCR merges words ("BECAUSEI" = "BECAUSE I") and misreads letters (0/O, 1/I/l, rn/m); read past those errors.
  - Natural, colloquial Mongolian, true to each character's voice; not word-for-word. Correct spelling, including Ө ө and Ү ү. Do not add meaning that is not in the source.
  - Translate every English, Chinese and Japanese word; only product/model names, codes and stat abbreviations (ARK-2020, HP, STR) may stay Latin. Never leave Chinese or Japanese characters in "mn".
  - The GLOSSARY is mandatory. Transliterate new names consistently and list them in new_terms.
  - system: one Mongolian line per OCR line, joined with "\\n"; keep brackets, numbers, colons and stat layout.
  - character cards and lists ("NAME (27)" / "JOB: ..."): one line per logical line, joined with "\\n".
  - everything else: one plain string (it is re-wrapped to fit).

Answer with every id exactly once: in "skip", or in "lines" with its kind and Mongolian text. Nothing else.`;

const SCHEMA = {
    type: 'object',
    properties: {
        skip: { type: 'array', items: { type: 'string' } },
        lines: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    kind: { type: 'string', enum: ['speech', 'thought', 'narration', 'system'] },
                    mn: { type: 'string' },
                },
                required: ['id', 'kind', 'mn'],
            },
        },
        new_terms: {
            type: 'array',
            items: {
                type: 'object',
                properties: { en: { type: 'string' }, mn: { type: 'string' } },
                required: ['en', 'mn'],
            },
        },
    },
    required: ['skip', 'lines', 'new_terms'],
};

interface TranslateResult {
    skip: string[];
    lines: { id: string; kind: Exclude<RegionType, 'unknown' | 'skip'>; mn: string }[];
    new_terms: GlossaryTerm[];
}

/** A block to translate and the chapter it belongs to (blocks of several chapters go out together). */
export interface Item {
    region: Region;
    chapter: string;
}

/**
 * Text per request (characters of OCR text). Several chapters fit in one request, so the model
 * sees the story across chapters and the instructions/glossary are paid for once per batch.
 */
const BATCH_CHARS = Math.max(2000, Number(process.env.TRANSLATE_BATCH_CHARS) || 14000);
const BATCH_BLOCKS = 450;

/** Background tag for anything that isn't a plain light bubble (helps spot system windows and SFX on art). */
function backgroundTag(r: Region): string {
    const { background, backgroundColor } = r.style;
    const light = backgroundColor ? luminance(backgroundColor) > 0.75 : false;
    if (background === 'flat' && light) {
        return '';
    }
    return background === 'art' || !backgroundColor ? ` [${background}]` : ` [${background} ${backgroundColor}]`;
}

function luminance(hex: string): number {
    const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
    if (!Number.isFinite(n)) {
        return 1;
    }
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

const blockText = (r: Region) => r.lines.join(' / ');

const needsWork = (r: Region) =>
    r.type === 'unknown' || (r.type !== 'skip' && (!r.translation?.length || (r.type === 'system' && r.translation.length !== r.lines.length)));

/** Splits items into requests of about BATCH_CHARS of text, in reading order. */
function batches(items: Item[]): Item[][] {
    const out: Item[][] = [];
    let current: Item[] = [];
    let chars = 0;
    for (const item of items) {
        const size = blockText(item.region).length + 12;
        if (current.length && (chars + size > BATCH_CHARS || current.length >= BATCH_BLOCKS)) {
            out.push(current);
            current = [];
            chars = 0;
        }
        current.push(item);
        chars += size;
    }
    if (current.length) {
        out.push(current);
    }
    return out;
}

/**
 * Classifies and translates the given blocks (one or more chapters of a series, in reading order).
 * Sets region.type and region.translation. Returns the number of requests made.
 */
export async function translateRegions(items: Item[], glossary: Glossary, model = config.translator.translateModel): Promise<number> {
    let requests = await translatePass(items, glossary, model);

    // Retry once for anything missing or a system window whose line count came back wrong.
    const bad = items.filter(i => needsWork(i.region));
    if (bad.length) {
        requests += await translatePass(bad, glossary, model);
        for (const { region: r } of bad) {
            if (r.type === 'system' && r.translation && r.translation.length !== r.lines.length) {
                const t = r.translation;
                r.translation = r.lines.map((_, i) => (i < r.lines.length - 1 ? t[i] ?? '' : t.slice(i).join(' ')));
            }
        }
    }
    return requests;
}

async function translatePass(items: Item[], glossary: Glossary, model: string): Promise<number> {
    const system = SYSTEM + (await styleSection());
    const groups = batches(items);
    const recent: string[] = []; // last translated lines, carried into the next request
    for (const group of groups) {
        const ids = new Map<string, Region>();
        const body: string[] = [];
        let chapter = '';
        for (const [n, item] of group.entries()) {
            if (item.chapter !== chapter) {
                chapter = item.chapter;
                body.push(`=== ${chapter} ===`);
            }
            const id = String(n + 1);
            ids.set(id, item.region);
            body.push(`${id}${backgroundTag(item.region)} | ${blockText(item.region)}`);
        }
        const user = [
            glossary.terms.length ? `GLOSSARY (mandatory):\n${glossary.terms.map(t => `${t.en} = ${t.mn}${t.note ? ` (${t.note})` : ''}`).join('\n')}` : '',
            recent.length ? `STORY SO FAR (already translated, context only):\n${recent.join('\n')}` : '',
            `BLOCKS:\n${body.join('\n')}`,
        ].filter(Boolean).join('\n\n');

        const res = await generateJson<TranslateResult>({ model, system, schema: SCHEMA, user, maxOutputTokens: 32768 });

        for (const id of res.skip ?? []) {
            const r = ids.get(String(id).trim());
            if (r) {
                r.type = 'skip';
                r.translation = [];
            }
        }
        for (const line of res.lines ?? []) {
            const r = ids.get(String(line.id).trim());
            if (!r || !line.mn?.trim()) {
                continue;
            }
            r.type = line.kind;
            const parts = line.mn.split('\n').map(t => t.trim()).filter(Boolean);
            // System windows keep one line per OCR line; a card/list keeps the lines the model split it
            // into; everything else is one string that the renderer re-wraps.
            r.translation = r.type === 'system' || (parts.length > 1 && parts.length <= r.lines.length) ? parts : [parts.join(' ')];
        }

        for (const term of res.new_terms ?? []) {
            if (term.en?.trim() && term.mn?.trim() && !glossary.terms.some(t => t.en.toLowerCase() === term.en.toLowerCase())) {
                glossary.terms.push({ en: term.en.trim(), mn: term.mn.trim() });
            }
        }

        const translated = group.filter(i => i.region.type !== 'skip' && i.region.translation?.length);
        recent.push(...translated.slice(-15).map(i => `${blockText(i.region)} → ${i.region.translation!.join(' ')}`));
        recent.splice(0, Math.max(0, recent.length - 15));
    }
    return groups.length;
}

/**
 * Obvious non-dialogue the model doesn't need to see: scanlator credits and URLs, printer colour
 * bars (cyan/magenta), letter soup, and short low-confidence readings without any punctuation.
 * Measured on 6,173 blocks the model had classified: catches ~2/3 of its "skip" answers and
 * <0.2% of real lines (mostly grunts like "HMM", which then simply stay in English).
 */
export function isLocalJunk(r: Region): boolean {
    const text = r.lines.join(' ');
    // Chinese/Japanese lines: a character is a word, there are no spaces, and two characters
    // (什么, ええ) are a whole line, so the English rules below would throw them away.
    const cjk = text.match(CJK_CHARS)?.length ?? 0;
    if (cjk) {
        return CJK_CREDITS.test(text) || /https?:\/\/|www\./i.test(text);
    }
    const letters = text.replace(/[^\p{L}\p{N}]/gu, '');
    if (letters.length < 3) {
        return true;
    }
    if (/https?:\/\/|www\.|\.(com|net|org|gg|io|xyz)\b|scans\b|discord|patreon|ko-?fi|\b(translator|proofreader|typesetter|cleaner|redrawer|editor|raws?)\s*:/i.test(text)) {
        return true;
    }
    if (/c?yan\s*m|magenta|ma\s*gen/i.test(text)) {
        return true;
    }
    if (/[?!.…,~\-—]/.test(text)) {
        return false; // punctuation: reads like someone talking
    }
    const words = text.split(/\s+/).filter(Boolean);
    const tiny = words.filter(w => w.replace(/[^\p{L}\p{N}]/gu, '').length <= 2).length;
    const conf = r.ocr.length ? r.ocr.reduce((a, o) => a + o.confidence, 0) / r.ocr.length : 1;
    return conf < 0.6
        || (words.length >= 2 && tiny / words.length >= 0.75)
        || (words.length === 1 && text.replace(/[^\p{L}]/gu, '').length <= 4 && conf < 0.85)
        || (r.style.background === 'art' && words.length <= 2 && conf < 0.8);
}

const POLISH_SYSTEM = `You are a native Mongolian editor for webtoon scanlations. You receive a chapter's draft Mongolian lines (machine translated) with the original (English, or sometimes Chinese/Japanese) for meaning only.

Rewrite every draft so it reads like a Mongolian reader actually talks, following the MONGOLIAN VOICE below:
- Read the draft as Mongolian first. If it sounds translated, rewrite it from scratch; do not just swap words.
- Keep the meaning and the speaker's attitude (anger, sarcasm, laziness, swearing), not the original's sentence structure.
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
    const CHUNK_SIZE = 120;
    const system = POLISH_SYSTEM + (await styleSection());
    let changed = 0;
    for (let i = 0; i < todo.length; i += CHUNK_SIZE) {
        const chunk = todo.slice(i, i + CHUNK_SIZE);
        const res = await generateJson<{ blocks: { id: string; mn: string[] }[] }>({
            model,
            system,
            schema: POLISH_SCHEMA,
            user: JSON.stringify({ blocks: chunk.map((r, n) => ({ id: String(n + 1), kind: r.type, en: r.lines.join(' '), draft: r.translation })) }),
            maxOutputTokens: 32768,
        });
        const byId = new Map(res.blocks.map(b => [String(b.id), b.mn]));
        for (const [n, r] of chunk.entries()) {
            const mn = byId.get(String(n + 1))?.filter(t => t.trim());
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
