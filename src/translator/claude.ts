import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/settings.js';
import { usage } from './gemini.js';
import type { LabeledImage } from './llm.js';

let client: Anthropic | null = null;

function getClient(): Anthropic {
    if (!config.translator.anthropicApiKey) {
        throw new Error('ANTHROPIC_API_KEY is not set (add it to .env)');
    }
    client ??= new Anthropic({ apiKey: config.translator.anthropicApiKey, maxRetries: 4 });
    return client;
}

/** Structured outputs need every object closed (additionalProperties: false). */
function strictSchema(schema: unknown): unknown {
    if (Array.isArray(schema)) {
        return schema.map(strictSchema);
    }
    if (schema && typeof schema === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(schema)) {
            out[k] = strictSchema(v);
        }
        if (out.type === 'object' && !('additionalProperties' in out)) {
            out.additionalProperties = false;
        }
        return out;
    }
    return schema;
}

/**
 * Calls Claude and returns the JSON response that follows `schema` (structured outputs).
 * Thinking depth is controlled with effort (CLAUDE_EFFORT, default "low"); current Claude models
 * don't take a token budget for thinking.
 */
export async function generateJsonClaude<T>(opts: { model: string; system: string; user: string; schema: object; maxOutputTokens?: number; images?: LabeledImage[] }): Promise<T> {
    const content: Anthropic.ContentBlockParam[] = [{ type: 'text', text: opts.user }];
    for (const img of opts.images ?? []) {
        content.push({ type: 'text', text: img.label });
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data.toString('base64') } });
    }
    const stream = getClient().messages.stream({
        model: opts.model,
        max_tokens: opts.maxOutputTokens ?? 32000,
        system: opts.system,
        messages: [{ role: 'user', content }],
        output_config: {
            effort: config.translator.claudeEffort as 'low' | 'medium' | 'high',
            format: { type: 'json_schema', schema: strictSchema(opts.schema) as Record<string, unknown> },
        },
    });
    const res = await stream.finalMessage();

    const u = (usage[opts.model] ??= { calls: 0, input: 0, output: 0, thinking: 0 });
    u.calls++;
    u.input += res.usage.input_tokens;
    u.output += res.usage.output_tokens;

    if (res.stop_reason === 'refusal') {
        throw new Error(`Claude declined the request (${res.stop_details?.category ?? 'no category'})`);
    }
    if (res.stop_reason === 'max_tokens') {
        throw new Error('Claude response hit max_tokens — reduce the chunk size');
    }
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return JSON.parse(text) as T;
}
