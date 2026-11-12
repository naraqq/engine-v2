import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

/**
 * Application configuration
 */
export const config = {
    // Server
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',

    // API
    apiPrefix: '/api/v1',
    apiVersion: '1.0.0',

    // CORS
    cors: {
        origin: process.env.CORS_ORIGIN || '*',
        credentials: true,
    },

    // Rate limiting
    rateLimit: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    },

    // Storage paths
    storage: {
        root: process.env.STORAGE_PATH || path.join(__dirname, '../../storage'),
        downloads: path.join(process.env.STORAGE_PATH || path.join(__dirname, '../../storage'), 'downloads'),
        temp: path.join(process.env.STORAGE_PATH || path.join(__dirname, '../../storage'), 'temp'),
        database: path.join(process.env.STORAGE_PATH || path.join(__dirname, '../../storage'), 'database'),
        cache: path.join(process.env.STORAGE_PATH || path.join(__dirname, '../../storage'), 'cache'),
        /** Finished translated pages only (what gets uploaded). */
        translations: path.join(process.env.STORAGE_PATH || path.join(__dirname, '../../storage'), 'translations'),
        /** Translator working data: per-page OCR/translation JSON (lets re-runs skip OCR) and per-series glossaries. */
        translationWork: path.join(process.env.STORAGE_PATH || path.join(__dirname, '../../storage'), 'translation-work'),
    },

    // Manga translator (Gemini)
    translator: {
        apiKey: process.env.GEMINI_API_KEY,
        /** Translation model: a Gemini model name, or a claude-* model (needs ANTHROPIC_API_KEY). */
        translateModel: process.env.TRANSLATE_MODEL || process.env.GEMINI_TRANSLATE_MODEL || 'gemini-3.5-flash',
        /** Send a crop of each likely text block with the OCR text, so the model reads the real lettering and sees the scene (TRANSLATOR_VISION=false: text only). */
        vision: process.env.TRANSLATOR_VISION !== 'false',
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        /** Claude thinking depth: low | medium | high. */
        claudeEffort: process.env.CLAUDE_EFFORT || 'low',
        /** Mongolian voice: rules + example pairs used by translation and polish (edit this file to tune the style). */
        styleFile: process.env.TRANSLATOR_STYLE || path.join(__dirname, '../../assets/translation/style.json'),
        /** Run the native-editor polish pass after translating (set TRANSLATOR_POLISH=false to skip). */
        polish: process.env.TRANSLATOR_POLISH !== 'false',
        /** Gemini thinking tokens per call; never more than 256 (cost cap), whatever .env says. */
        thinkingBudget: Math.min(Math.max(parseInt(process.env.GEMINI_THINKING_BUDGET || '256', 10) || 0, 0), 256),
        /** Local OCR runs on the GPU via DirectML ("dml"); "cpu" works everywhere but ~2.5x slower. */
        ocrProvider: process.env.OCR_PROVIDER || 'dml',
        /** Zoom levels OCR reads each tile at; 2x/3x are needed for small or stylised system-window lettering. */
        ocrScales: (process.env.OCR_SCALES || '2,3').split(',').map(Number).filter(n => n > 0),
        /** Font for the Mongolian text; must contain Ө/Ү. Default: Bubble Sans (comic lettering, full Mongolian Cyrillic). */
        font: process.env.TRANSLATOR_FONT || path.join(__dirname, '../../assets/fonts/bubble-sans-1.01.otf'),
        /** LaMa inpainting model (erases text on artwork). https://huggingface.co/Carve/LaMa-ONNX → lama_fp32.onnx */
        lamaModel: process.env.TRANSLATOR_LAMA_MODEL || path.join(process.env.STORAGE_PATH || path.join(__dirname, '../../storage'), 'models', 'lama_fp32.onnx'),
        tileHeight: parseInt(process.env.TRANSLATOR_TILE_HEIGHT || '1440', 10),
        tileOverlap: parseInt(process.env.TRANSLATOR_TILE_OVERLAP || '400', 10),
    },

    // Puppeteer
    puppeteer: {
        headless: process.env.PUPPETEER_HEADLESS !== 'false',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        maxBrowsers: parseInt(process.env.PUPPETEER_MAX_BROWSERS || '5', 10),
        timeout: parseInt(process.env.PUPPETEER_TIMEOUT || '150000', 10), // 2.5 minutes
    },

    // Downloads
    downloads: {
        maxConcurrent: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3', 10),
        defaultFormat: (process.env.DEFAULT_FORMAT || 'cbz') as 'cbz' | 'pdf' | 'epub' | 'images',
        retentionDays: parseInt(process.env.DOWNLOAD_RETENTION_DAYS || '7', 10),
    },

    // Logging
    logging: {
        level: process.env.LOG_LEVEL || 'info',
    },

    // Security
    security: {
        apiKey: process.env.API_KEY,
        requireApiKey: process.env.REQUIRE_API_KEY === 'true',
    },
} as const;

/**
 * Validate configuration
 */
export function validateConfig(): void {
    if (config.security.requireApiKey && !config.security.apiKey) {
        throw new Error('API_KEY must be set when REQUIRE_API_KEY is true');
    }

    if (config.port < 1 || config.port > 65535) {
        throw new Error('PORT must be between 1 and 65535');
    }
}
