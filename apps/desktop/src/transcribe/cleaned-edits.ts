/**
 * The speaker's edits to the cleaned-up text, and which text Copy and Save
 * as take. Edits live as long as the window's result and are never stored.
 */

/** The edited Markdown, with the AI text it was edited from. */
export type CleanedEdits = { base: string; markdown: string };

export type CleanedSource = {
  /** The speaker's text when it differs from the AI's, otherwise the AI's. */
  markdown: string;
  edited: boolean;
};

/**
 * The text every copy and save of the cleaned-up pane takes. Edits count only
 * against the AI text they were made on: once that text changes (a part
 * tried again before any edit), edits made on the earlier text no longer
 * apply, and text edited back to the AI's is no edit at all.
 */
export const cleanedSource = (
  aiMarkdown: string,
  edits: CleanedEdits | null,
): CleanedSource =>
  edits?.base === aiMarkdown && edits.markdown !== aiMarkdown
    ? { markdown: edits.markdown, edited: true }
    : { markdown: aiMarkdown, edited: false };
