import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";

import { discoverClauseSlots } from "./discover-clause-slots";
import { discoverTemplate } from "./discover-template";
import { extractTextForPreview } from "./extract-text";

/** Render the read-only template preview from a scanned DOCX file. */
export const renderTemplatePreview = async (file: ScannedFile) => {
  const [{ paragraphs, charCount }, { structureErrors }, clauseSlots] =
    await Promise.all([
      extractTextForPreview(file),
      discoverTemplate(file),
      discoverClauseSlots(file),
    ]);

  // Discovery reports section-relative indices; preview paragraphs use one
  // document-wide sequence with headers before the body and footers after it.
  const headerCount = paragraphs.filter((p) => p.source === "header").length;
  const bodyCount = paragraphs.filter((p) => p.source === "body").length;

  for (const error of structureErrors) {
    if (error.source === "body") {
      error.paragraphIndex += headerCount;
    } else if (error.source === "footer") {
      error.paragraphIndex += headerCount + bodyCount;
    }
  }

  return {
    paragraphs,
    charCount,
    structureErrors,
    clauseSlots: clauseSlots.map((slot) => slot.name),
  };
};
