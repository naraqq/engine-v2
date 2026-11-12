import { generateJsonClaude } from './claude.js';
import { generateJson as generateJsonGemini } from './gemini.js';

/** An image sent with the request, introduced by a short label (e.g. "Crop for block 02#6:"). */
export interface LabeledImage {
    label: string;
    data: Buffer;
    mime: 'image/jpeg' | 'image/png' | 'image/webp';
}

/** JSON call to whichever provider the model name belongs to (claude-* → Anthropic, else Gemini), optionally with images. */
export function generateJson<T>(opts: { model: string; system: string; user: string; schema: object; maxOutputTokens?: number; images?: LabeledImage[] }): Promise<T> {
    if (opts.model.startsWith('claude-')) {
        return generateJsonClaude<T>(opts);
    }
    const imageParts = (opts.images ?? []).flatMap(img => [
        { text: img.label },
        { inlineData: { mimeType: img.mime, data: img.data.toString('base64') } },
    ]);
    return generateJsonGemini<T>({
        model: opts.model,
        system: opts.system,
        schema: opts.schema,
        maxOutputTokens: opts.maxOutputTokens,
        contents: [{ role: 'user', parts: [{ text: opts.user }, ...imageParts] }],
    });
}
