/**
 * Manga translator CLI (phase 1: local OCR + text-only Gemini translation → JSON).
 *
 *   npm run translate                         list downloaded series
 *   npm run translate -- <series>             all chapters of a series
 *   npm run translate -- <series> <ch> [ch…]  specific chapters
 *
 * Flags: --force (redo OCR + translation), --retranslate (keep OCR, redo translation),  --detect-only (OCR only), --no-render (skip drawing images)
 */
import { config } from '../config/settings.js';
import { logger } from '../config/logger.js';
import { usage } from './gemini.js';
import { closeOcr } from './ocr.js';
import { listChapters, listSeries, processChapter } from './pipeline.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const [series, ...chapters] = args.filter(a => !a.startsWith('--'));

async function main() {
    if (!series) {
        console.log('Downloaded series:\n' + (await listSeries()).map(s => `  ${s}`).join('\n'));
        console.log('\nUsage: npm run translate -- <series> [chapter...] [--force] [--retranslate] [--detect-only] [--no-render]');
        return;
    }

    const targets = chapters.length ? chapters : await listChapters(series);
    const started = Date.now();
    for (const chapter of targets) {
        await processChapter(series, chapter, {
            force: flags.has('--force'),
            detectOnly: flags.has('--detect-only'),
            retranslate: flags.has('--retranslate'),
            noRender: flags.has('--no-render'),
        });
    }

    await closeOcr();
    logger.info(`Finished ${targets.length} chapter(s) in ${Math.round((Date.now() - started) / 1000)}s (OCR: ${config.translator.ocrProvider}, thinking budget: ${config.translator.thinkingBudget})`);
    for (const [model, u] of Object.entries(usage)) {
        logger.info(`  ${model}: ${u.calls} calls, ${u.input} input / ${u.output} output / ${u.thinking} thinking tokens`);
    }
}

main().catch(err => {
    const msg = err instanceof Error ? err.message : String(err);
    if (/credits are depleted|"code":\s*402/i.test(msg)) {
        logger.error('Gemini billing: this API key\'s project has no prepaid credit left. Top up at https://ai.studio/projects, or use a key from a free-tier project (no billing) in .env.');
    } else if (/API key not valid|"code":\s*(401|403)/i.test(msg)) {
        logger.error('Gemini rejected the API key. Check GEMINI_API_KEY in .env.');
    } else {
        logger.error(err instanceof Error ? err.stack ?? msg : msg);
    }
    process.exit(1);
});
