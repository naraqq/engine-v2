import { generateJsonClaude } from './claude.js';
import { generateJson as generateJsonGemini } from './gemini.js';

/** Text-only JSON call to whichever provider the model name belongs to (claude-* → Anthropic, else Gemini). No images are ever sent. */
export function generateJson<T>(opts: { model: string; system: string; user: string; schema: object; maxOutputTokens?: number }): Promise<T> {
    if (opts.model.startsWith('claude-')) {
        return generateJsonClaude<T>(opts);
    }
    return generateJsonGemini<T>({
        model: opts.model,
        system: opts.system,
        schema: opts.schema,
        maxOutputTokens: opts.maxOutputTokens,
        contents: [{ role: 'user', parts: [{ text: opts.user }] }],
    });
}
