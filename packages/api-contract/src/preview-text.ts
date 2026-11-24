import * as v from "valibot";

/**
 * The markup of a contained document's preview text, set by the reader that
 * produced it: converted documents (PDF, office files) arrive as Markdown,
 * text files as the plain text they hold. A viewer renders each as what it
 * is, never Markdown as plain text or plain text as Markdown.
 */
export const PREVIEW_TEXT_FORMATS = ["markdown", "plain"] as const;

export type PreviewTextFormat = (typeof PREVIEW_TEXT_FORMATS)[number];

export const previewTextFormatSchema = v.picklist(PREVIEW_TEXT_FORMATS);

/** A contained document's readable text with the markup it is written in. */
export type PreviewText = { text: string; format: PreviewTextFormat };
