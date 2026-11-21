import { PDF } from "@libpdf/core";
import { Result } from "better-result";

import { PDF_PAGE_SEPARATOR } from "./document-builders/pdf-text-document-ast";

/** Publisher PDFs have already passed the bounded, allowlisted soft-law fetch boundary. */
export const extractSoftLawPdfText = async (bytes: Uint8Array) => {
  const parsed = await Result.tryPromise(async () => {
    const pdf = await PDF.load(bytes);
    const text = pdf
      .extractText()
      .map((page) => page.text)
      .join(PDF_PAGE_SEPARATOR)
      .trim();
    return text.length
      ? { text, extractionQuality: "text_layer" as const }
      : { text: null, extractionQuality: "needs_ocr" as const };
  });
  if (parsed.status === "error") {
    // Keep the publisher bytes repairable; the durable version exposes the failed extraction.
    return {
      text: null,
      extractionQuality: "extraction_failed" as const,
      extractionFailure: "Could not extract publisher PDF text",
    };
  }
  return parsed.value;
};
