import { panic, TaggedError } from "better-result";

import type { Document } from "@stll/folio-core";
import {
  createDocx,
  createEmptyDocument,
  createStellaStyleDocumentPreset,
} from "@stll/folio-core/server";

/** A DOCX could not be composed, serialised, or edited. */
export class DocxAuthoringError extends TaggedError("DocxAuthoringError")<{
  message: string;
  cause: unknown;
}> {}

/**
 * An empty document on stella's house preset: its styles, numbering, font
 * table, and A4 geometry. Builders append to `package.document.content`.
 */
export const stellaDocument = (): Document =>
  createEmptyDocument({ preset: createStellaStyleDocumentPreset() });

/**
 * The house document turned on its side: same margins and styles, A4
 * landscape. For a wide table that would otherwise wrap every cell into a
 * column of single words.
 */
export const stellaLandscapeDocument = (): Document => {
  const doc = stellaDocument();
  const portrait = doc.package.document.finalSectionProperties;
  if (portrait?.pageWidth === undefined || portrait.pageHeight === undefined) {
    return panic("The house preset must declare a page size.");
  }
  doc.package.document.finalSectionProperties = {
    ...portrait,
    orientation: "landscape",
    pageWidth: portrait.pageHeight,
    pageHeight: portrait.pageWidth,
  };
  return doc;
};

/**
 * Serialise a document model to DOCX bytes. The model comes from a builder
 * in this repository, so a failure here is a defect rather than bad input;
 * the text entry points that take untrusted input return a `Result` instead.
 */
export const documentToDocx = async (
  document: Document,
): Promise<ArrayBuffer> => await createDocx(document);
