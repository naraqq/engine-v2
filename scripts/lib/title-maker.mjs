/**
 * Adds a new title the worker picked to Montoon, as house content:
 * metadata from the source page, a Mongolian title and description written
 * by Gemini (genres picked from Montoon's own list), a cleaned-up cover and
 * a generated landscape banner. Called once the title's first chapter is
 * translated, so Montoon never shows an empty title.
 */
import sharp from 'sharp';
import { api, c, normalize, status } from './cli.mjs';
import { fetchMontoonTitles, findOnSource, montoonConfig, resultUrl } from './montoon.mjs';
import { log, mt, workerName } from './montoon-api.mjs';

const TYPES = ['manga', 'manhwa', 'manhua'];
const STATUSES = ['ongoing', 'completed', 'hiatus'];

export const geminiKey = () => {
    const key = process.env.GEMINI_API_KEY || '';
    return key && !/your-gemini-api-key/i.test(key) ? key : null;
};

// ---------------------------------------------------------------- cover

export async function fetchImage(url, referer) {
    try {
        const response = await fetch(url, {
            headers: { Referer: referer, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36' },
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) return null;
        const buffer = Buffer.from(await response.arrayBuffer());
        const meta = await sharp(buffer).metadata();
        if (!meta.width || !meta.height) return null;
        return { buffer, width: meta.width, height: meta.height, url };
    } catch {
        return null;
    }
}

/** The page's cover, full size when the site serves a resized one ("…-400.webp"). */
export async function coverFrom(info, pageUrl) {
    if (!info?.cover) return null;
    const fullSize = info.cover.replace(/-\d{3,4}(?=\.(webp|jpe?g|png)(\?|$))/i, '');
    const referer = new URL(pageUrl).origin + '/';
    return (fullSize !== info.cover && await fetchImage(fullSize, referer)) || fetchImage(info.cover, referer);
}

/** Best cover: the source's own, or a bigger one from another site carrying the same title. */
async function bestCover(info, pageUrl, title, sourceId) {
    let best = await coverFrom(info, pageUrl);
    if (best && best.width >= 450) return best;
    for (const id of ['asurascans', 'weebcentral']) {
        if (id === sourceId) continue;
        try {
            const site = await api('GET', `/api/v1/sources/${id}`);
            const { matches } = await findOnSource(site, title);
            if (!matches?.length) continue;
            const url = resultUrl(matches[0].id, site);
            const other = await api('GET', `/api/v1/sources/${id}/info?url=${encodeURIComponent(url)}`);
            const image = await coverFrom(other, url);
            if (image && (!best || image.width > best.width)) best = image;
            if (best && best.width >= 450) break;
        } catch { /* try the next site */ }
    }
    return best;
}

// -------------------------------------------------------------- posters

/** Portrait cover (720 px wide) and a 1280×720 banner for the home hero. */
async function makePosters(buffer) {
    const cover = await sharp(buffer).resize({ width: 720, kernel: 'lanczos3' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();

    const W = 1280, H = 720, fgH = 620;
    const background = await sharp(buffer).resize(W, H, { fit: 'cover', position: 'attention' })
        .blur(30).modulate({ brightness: 0.5, saturation: 1.1 }).toBuffer();
    const foreground = await sharp(buffer).resize({ height: fgH, kernel: 'lanczos3' }).toBuffer();
    const fgW = (await sharp(foreground).metadata()).width;
    const left = W - fgW - 110; // right side: the app draws the title over the left
    const top = Math.round((H - fgH) / 2);
    const shadow = await sharp({ create: { width: fgW + 60, height: fgH + 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.55 } } })
        .blur(22).png().toBuffer();
    const landscape = await sharp(background)
        .composite([
            { input: shadow, left: left - 30 + 12, top: top - 30 + 16 },
            { input: foreground, left, top },
        ])
        .jpeg({ quality: 86, mozjpeg: true })
        .toBuffer();
    return { cover, landscape };
}

// ------------------------------------------------------------- metadata

const guessType = (info, sourceId) => {
    const alt = `${info.alternative} ${info.genres.join(' ')}`;
    if (/[가-힯]/.test(alt) || /manhwa/i.test(alt)) return 'manhwa';
    if (/[぀-ヿ]/.test(alt) || /manga/i.test(alt)) return 'manga';
    if (/[一-鿿]/.test(alt) || /manhua/i.test(alt)) return 'manhua';
    return sourceId === 'weebcentral' ? 'manga' : 'manhwa';
};
const guessStatus = s => (/complet|finish|end/i.test(s) ? 'completed' : /hiatus|pause/i.test(s) ? 'hiatus' : 'ongoing');
const guessAge = genres => {
    const g = genres.join(' ').toLowerCase();
    return /smut|hentai|adult|18\+|pornographic/.test(g) ? 18 : /mature|ecchi/.test(g) ? 16 : 0;
};

function fallbackMetadata(info, title, sourceId, genres) {
    const names = new Map(genres.map(g => [normalize(g.name), g.id]));
    return {
        title_mn: null,
        description_mn: info.description || title,
        type: guessType(info, sourceId),
        status: guessStatus(info.status),
        age_limit: guessAge(info.genres),
        genre_ids: [...new Set(info.genres.map(g => names.get(normalize(g))).filter(Boolean))].slice(0, 6),
        by: 'source',
    };
}

/** How Montoon already names its titles in Mongolian (style examples for Gemini). */
let namingExamples = null;
async function montoonNamingExamples() {
    if (namingExamples) return namingExamples;
    try {
        const all = await fetchMontoonTitles(montoonConfig(), '?renewed=all');
        namingExamples = all.filter(t => t.title && t.title_mn && t.title_mn !== t.title)
            .sort((a, b) => (b.readers_30d || 0) - (a.readers_30d || 0))
            .slice(0, 30)
            .map(t => `${t.title} → ${t.title_mn}`);
    } catch {
        namingExamples = [];
    }
    return namingExamples;
}

const hasLatin = s => /[A-Za-z]{2,}/.test(String(s || ''));
const thinking = () => ({ thinkingBudget: Math.min(Number(process.env.GEMINI_THINKING_BUDGET) || 256, 256) });

// Story synopses mention violence, slavery, death…: only block what is
// clearly harmful, or perfectly normal fiction gets an empty answer.
const SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
    .map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

/**
 * One JSON answer from Gemini (thinking capped at 256), retried when it
 * comes back empty or unparsable; the error names the finish reason.
 */
export async function askJson(ai, model, contents, schema, attempts = 3) {
    let reason = 'no answer';
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await ai.models.generateContent({
                model,
                contents,
                config: {
                    responseMimeType: 'application/json',
                    responseJsonSchema: schema,
                    temperature: 0.2,
                    safetySettings: SAFETY,
                    thinkingConfig: thinking(),
                },
            });
            const text = response.text;
            if (text) return JSON.parse(text);
            reason = `empty answer (finish: ${response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? 'unknown'})`;
        } catch (error) {
            reason = error.message;
        }
    }
    throw new Error(`Gemini: ${reason}`);
}

async function geminiMetadata(info, title, sourceId, genres, apiKey) {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_PICK_MODEL || 'gemini-3.5-flash';
    const examples = await montoonNamingExamples();
    const out = await askJson(ai, model, [
            'You prepare a new comic for Montoon, a Mongolian webcomic app, from its English source page.',
            examples.length ? `How Montoon names its titles in Mongolian (follow this style):\n${examples.join('\n')}` : '',
            `Title: ${title}`,
            `Alternative titles: ${info.alternative || '-'}`,
            `Author: ${info.author || '-'}`,
            `Status on the source: ${info.status || '-'}`,
            `Source genres/tags: ${info.genres.join(', ') || '-'}`,
            `Source site: ${sourceId}`,
            `Synopsis:\n${info.description || '-'}`,
            `Montoon genres (id: name):\n${genres.map(g => `${g.id}: ${g.name}`).join('\n')}`,
            [
                'Return:',
                '- title_mn: the Mongolian (Cyrillic) title readers would expect: translate what the title MEANS (e.g. a "tomb raider" is someone who loots tombs), transliterate personal names, keep it short.',
                '- description_mn: 2-4 sentences of natural, engaging Mongolian (Cyrillic only, no Latin letters) that hook a reader, based only on the synopsis; no invented facts, no spoilers past the setup; correct Ө ө and Ү ү.',
                '- type: manga (Japanese), manhwa (Korean) or manhua (Chinese).',
                '- status: ongoing, completed or hiatus.',
                '- age_limit: 0, 13, 16 or 18 (18 for sexual content).',
                '- genre_ids: 1 to 6 ids from the Montoon list that fit best.',
            ].join('\n'),
        ].filter(Boolean).join('\n\n'), {
        type: 'object',
        properties: {
            title_mn: { type: 'string' },
            description_mn: { type: 'string' },
            type: { type: 'string', enum: TYPES },
            status: { type: 'string', enum: STATUSES },
            age_limit: { type: 'integer' },
            genre_ids: { type: 'array', items: { type: 'integer' } },
        },
        required: ['title_mn', 'description_mn', 'type', 'status', 'age_limit', 'genre_ids'],
    });

    // Editor pass: a native-speaker check of the title and description,
    // retried once if Latin letters are still in there.
    let titleMn = String(out.title_mn || '').trim();
    let descriptionMn = String(out.description_mn || '').trim();
    for (let attempt = 1; attempt <= 2; attempt++) {
        const edited = await askJson(ai, model, [
                'You are a native Mongolian editor at a webcomic app. Check this draft for a new comic and return the corrected version.',
                `English title: ${title}`,
                `English synopsis (for meaning only):\n${info.description || '-'}`,
                `Draft Mongolian title: ${titleMn}`,
                `Draft Mongolian description:\n${descriptionMn}`,
                [
                    'Fix anything that is wrong: a title that does not convey what the English title means, misspelled or non-existent words,',
                    'Latin letters (write everything in Cyrillic; transliterate names), unnatural or machine-sounding phrasing, odd capital letters,',
                    'facts that are not in the synopsis. Keep what is already good. The description stays 2-4 sentences.',
                    attempt > 1 ? 'The previous answer still contained Latin letters. Use Cyrillic only.' : '',
                ].join(' '),
            ].join('\n\n'), {
            type: 'object',
            properties: { title_mn: { type: 'string' }, description_mn: { type: 'string' } },
            required: ['title_mn', 'description_mn'],
        }, 2).catch(() => null); // the draft is still usable if the editor fails
        if (edited?.title_mn) titleMn = edited.title_mn.trim();
        if (edited?.description_mn) descriptionMn = edited.description_mn.trim();
        if (!hasLatin(titleMn) && !hasLatin(descriptionMn)) break;
    }

    const known = new Set(genres.map(g => g.id));
    return {
        title_mn: titleMn || null,
        description_mn: descriptionMn || info.description || title,
        type: TYPES.includes(out.type) ? out.type : guessType(info, sourceId),
        status: STATUSES.includes(out.status) ? out.status : guessStatus(info.status),
        age_limit: [0, 13, 16, 18].includes(out.age_limit) ? out.age_limit : guessAge(info.genres),
        genre_ids: [...new Set((out.genre_ids || []).filter(id => known.has(id)))].slice(0, 6),
        by: model,
    };
}

// ----------------------------------------------------------------- main

/**
 * Creates the title on Montoon (or finds the one already made for this
 * pick) and returns its content id.
 */
export async function ensureTitleOnMontoon({ workerTitleId, sourceId, seriesUrl, title }) {
    log(`  ${c.cyan('✚')} Adding ${c.bold(`"${title}"`)} to Montoon as a house title…`);

    status(c.gray('  ↳ Reading the series page…'));
    const info = await api('GET', `/api/v1/sources/${sourceId}/info?url=${encodeURIComponent(seriesUrl)}`);
    status(c.gray('  ↳ Getting the cover…'));
    const image = await bestCover(info, seriesUrl, title, sourceId);
    if (!image) throw new Error(`No usable cover found for "${title}" on ${sourceId}.`);

    const genres = (await mt('GET', '/genres')).data;
    let meta;
    const key = geminiKey();
    if (key) {
        status(c.gray('  ↳ Writing the Mongolian title and description…'));
        meta = await geminiMetadata(info, title, sourceId, genres, key).catch(error => {
            log(c.yellow(`  ⚠ Gemini couldn't write the metadata (${error.message}); using the source's.`));
            return null;
        });
    }
    meta ||= fallbackMetadata(info, title, sourceId, genres);

    status(c.gray('  ↳ Making the cover and banner…'));
    const posters = await makePosters(image.buffer);

    const form = new FormData();
    const fields = {
        worker_title_id: workerTitleId ?? '',
        source_id: sourceId,
        source_url: seriesUrl,
        title,
        title_mn: meta.title_mn ?? '',
        description: meta.description_mn,
        original_description: info.description || '',
        type: meta.type,
        status: meta.status,
        author: info.author || '',
        age_limit: String(meta.age_limit),
    };
    for (const [name, value] of Object.entries(fields)) if (value !== '') form.append(name, String(value));
    for (const alt of String(info.alternative || '').split(/[,;/|]/).map(s => s.trim()).filter(Boolean).slice(0, 20)) form.append('alt_titles[]', alt.slice(0, 120));
    for (const id of meta.genre_ids) form.append('genre_ids[]', String(id));
    form.append('worker', workerName());
    form.append('cover', new Blob([posters.cover], { type: 'image/jpeg' }), 'cover.jpg');
    form.append('landscape', new Blob([posters.landscape], { type: 'image/jpeg' }), 'landscape.jpg');

    const { base, token } = montoonConfig();
    const response = await fetch(`${base}/v2/worker/contents`, {
        method: 'POST',
        headers: { 'X-Sync-Token': token, Accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(120_000),
    });
    const isJson = (response.headers.get('content-type') || '').includes('json');
    const payload = isJson ? await response.json().catch(() => ({})) : {};
    if (!isJson) throw new Error('The Montoon backend has no title-creation endpoint yet. Deploy it, then retry.');
    if (!response.ok || !payload.success) {
        const detail = payload.errors ? ` ${JSON.stringify(payload.errors).slice(0, 300)}` : '';
        throw new Error(`Montoon refused the new title: ${payload.message || `HTTP ${response.status}`}${detail}`);
    }

    const d = payload.data;
    if (d.existing) {
        log(`  ${c.gray(`↳ Already on Montoon as #${d.content_id} "${d.title}"`)}`);
    } else {
        const genreNames = meta.genre_ids.map(id => genres.find(g => g.id === id)?.name).filter(Boolean).join(', ');
        log(`  ${c.green(`✔ Added #${d.content_id} "${d.title_mn || d.title}"`)} ${c.gray(`(${meta.type}, ${meta.status}, ${meta.age_limit}+, ${genreNames || 'no genres'}; cover ${image.width}px; metadata by ${meta.by})`)}`);
    }
    return d.content_id;
}

/** For trying it out without Montoon: metadata and posters only. */
export async function previewTitle({ sourceId, seriesUrl, title, outDir, genres: givenGenres = null }) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const path = (await import('node:path')).default;
    const info = await api('GET', `/api/v1/sources/${sourceId}/info?url=${encodeURIComponent(seriesUrl)}`);
    const image = await bestCover(info, seriesUrl, title || info.title, sourceId);
    if (!image) throw new Error('No usable cover found.');
    let genres = givenGenres || [];
    if (!genres.length) {
        try { genres = (await mt('GET', '/genres', undefined, { waitOffline: false })).data; } catch { /* backend not deployed yet */ }
    }
    const key = geminiKey();
    const meta = (key && genres.length ? await geminiMetadata(info, title || info.title, sourceId, genres, key).catch(error => { console.warn('Gemini metadata failed:', error.message); return null; }) : null)
        || fallbackMetadata(info, title || info.title, sourceId, genres);
    const posters = await makePosters(image.buffer);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'cover.jpg'), posters.cover);
    writeFileSync(path.join(outDir, 'landscape.jpg'), posters.landscape);
    writeFileSync(path.join(outDir, 'metadata.json'), JSON.stringify({ info, meta, cover: { url: image.url, width: image.width, height: image.height } }, null, 2));
    return { info, meta, image, genres };
}
