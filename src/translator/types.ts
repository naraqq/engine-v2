/**
 * Kinds of text. Local OCR can't tell them apart, so blocks start as "unknown" and the
 * translation step classifies them. "skip" = sound effects, signs, credits, noise.
 */
export type RegionType = 'unknown' | 'speech' | 'thought' | 'narration' | 'system' | 'skip';

/** What is behind the text — decides how it will be erased later. */
export type Background = 'flat' | 'gradient' | 'art' | 'translucent';

/** Rectangle in page pixels (top-left origin). */
export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface TextStyle {
    textColor: string;
    outlineColor: string | null;
    glow: boolean;
    bold: boolean;
    align: 'left' | 'center' | 'right';
    background: Background;
    backgroundColor: string | null;
}

/** One OCR'd text line. */
export interface OcrLine {
    text: string;
    box: Box;
    confidence: number;
}

export interface Region {
    /** Stable id within the chapter: `<page>#<n>` */
    id: string;
    type: RegionType;
    /** Bounds of the whole text block. */
    box: Box;
    /** Bounds of the bubble / caption box / system window (found during erasing), or null. */
    container: Box | null;
    /** Raw OCR lines (with per-line boxes), exactly as the OCR read them. */
    ocr: OcrLine[];
    /** Source (English) text, one entry per line — OCR text, corrected by the translation step. */
    lines: string[];
    style: TextStyle;
    /** Mongolian translation. System windows keep the source line count; others are one string to re-wrap. */
    translation?: string[];
}

export interface PageResult {
    version: 2;
    source: string;
    width: number;
    height: number;
    ocrEngine: string;
    detectedAt: string;
    translateModel?: string;
    translatedAt?: string;
    regions: Region[];
}

export interface GlossaryTerm {
    en: string;
    mn: string;
    note?: string;
}

export interface Glossary {
    terms: GlossaryTerm[];
}
