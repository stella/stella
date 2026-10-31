/**
 * What a downloaded copy of a matter document's PDF carries of the reader's
 * marks. The server writes the copy from the mode alone, so nothing the
 * client sends can add comment text or names to it.
 *
 * - `highlights`: the plain Download. Highlights only, by style, colour and
 *   position; no comment text, no author names, and no comment-only marks,
 *   so nothing internal leaves the firm by default.
 * - `highlightsWithComments`: highlights and comments, each comment's words
 *   in `/Contents` and every mark's author name in `/T`.
 */
export const MARKED_PDF_EXPORT_MODES = [
  "highlights",
  "highlightsWithComments",
] as const;

export type MarkedPdfExportMode = (typeof MARKED_PDF_EXPORT_MODES)[number];
