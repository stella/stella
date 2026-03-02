/**
 * Extract plain text from uploaded files (PDF, DOCX) and
 * detect the content language for FTS indexing.
 */

import { extractText as extractPdfText } from "unpdf";

import { extractText as extractDocxText } from "@/api/handlers/docx/extract-text";
import { LIMITS } from "@/api/lib/limits";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MIME = "application/pdf";

/**
 * Extract plain text from a file buffer based on MIME type.
 * Returns `null` for unsupported types or empty documents.
 */
export const extractFileText = async (
  buffer: ArrayBuffer,
  mimeType: string,
): Promise<string | null> => {
  let text: string | null = null;

  if (mimeType === PDF_MIME) {
    const result = await extractPdfText(new Uint8Array(buffer), {
      mergePages: true,
    });
    text = result.text;
  } else if (mimeType === DOCX_MIME) {
    const doc = await extractDocxText(Buffer.from(buffer));
    text = doc.paragraphs.map((p) => p.text).join("\n");
  }

  if (!text || text.trim().length === 0) {
    return null;
  }

  return text.slice(0, LIMITS.extractedContentMaxChars);
};
