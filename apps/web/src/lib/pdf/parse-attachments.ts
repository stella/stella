import * as v from "valibot";

export type PDFAttachment = {
  content: Uint8Array;
  filename: string;
};

const pdfAttachmentSchema = v.strictObject({
  content: v.instance(Uint8Array),
  filename: v.pipe(
    v.string(),
    v.trim(),
    v.check((s) => s.toLowerCase().endsWith(".pdf")),
  ),
});
const parsePdfAttachment = v.safeParser(pdfAttachmentSchema);

/**
 * Extracts PDF file attachments from the result of
 * `PDFDocumentProxy.getAttachments()`.
 *
 * pdfjs-dist v5.5+ returns `null` when there are no attachments;
 * older versions returned `undefined`. This function handles both.
 */
export const parseAttachments = (
  attachments?: Record<string, unknown> | null,
): PDFAttachment[] => {
  // eslint-disable-next-line no-eq-null, eqeqeq -- getAttachments() returns null (v5.5) or undefined (older)
  if (attachments == null) {
    return [];
  }

  return Object.values(attachments).flatMap((entry) => {
    const result = parsePdfAttachment(entry);
    return result.success ? [result.output] : [];
  });
};
