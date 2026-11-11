import { GoogleGenAI, type ContentListUnion } from '@google/genai';
import { config } from '../config/settings.js';
import { logger } from '../config/logger.js';

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
    if (!config.translator.apiKey) {
        throw new Error('GEMINI_API_KEY is not set (add it to .env)');
    }
    client ??= new GoogleGenAI({ apiKey: config.translator.apiKey });
    return client;
}

/** Token usage per model, so each run can report what it cost. */
export const usage: Record<string, { calls: number; input: number; output: number; thinking: number }> = {};

function record(model: string, meta: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined) {
    const u = (usage[model] ??= { calls: 0, input: 0, output: 0, thinking: 0 });
    u.calls++;
    u.input += meta?.promptTokenCount ?? 0;
    u.output += meta?.candidatesTokenCount ?? 0;
    u.thinking += meta?.thoughtsTokenCount ?? 0;
}

const RETRYABLE = /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|fetch failed|ECONNRESET/i;

/**
 * Calls Gemini and parses a JSON response that follows `schema`.
 * Thinking is capped by GEMINI_THINKING_BUDGET (default 256 tokens).
 */
export async function generateJson<T>(opts: {
    model: string;
    system: string;
    contents: ContentListUnion;
    schema: object;
    maxOutputTokens?: number;
}): Promise<T> {
    const ai = getClient();
    const maxAttempts = 5;

    for (let attempt = 1; ; attempt++) {
        try {
            const res = await ai.models.generateContent({
                model: opts.model,
                contents: opts.contents,
                config: {
                    systemInstruction: opts.system,
                    responseMimeType: 'application/json',
                    responseJsonSchema: opts.schema,
                    temperature: 0.2,
                    maxOutputTokens: opts.maxOutputTokens ?? 16384,
                    thinkingConfig: { thinkingBudget: config.translator.thinkingBudget },
                },
            });
            record(opts.model, res.usageMetadata);

            const text = res.text;
            if (!text) {
                throw new Error(`Empty response (finishReason: ${res.candidates?.[0]?.finishReason ?? 'unknown'})`);
            }
            return JSON.parse(text) as T;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Billing / auth problems won't fix themselves — fail fast instead of retrying.
            const fatal = /"code":\s*(400|401|402|403|404)\b|credits are depleted|API key not valid|PERMISSION_DENIED/i.test(msg);
            const retryable = !fatal && (RETRYABLE.test(msg) || err instanceof SyntaxError || msg.startsWith('Empty response'));
            if (!retryable || attempt >= maxAttempts) {
                throw err;
            }
            const delay = Math.min(60_000, 2_000 * 2 ** (attempt - 1)) + Math.random() * 1_000;
            logger.warn(`Gemini call failed (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(delay / 1000)}s: ${msg.slice(0, 200)}`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}
