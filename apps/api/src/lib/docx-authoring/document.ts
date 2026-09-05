import { TaggedError } from "better-result";

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
 * Serialise a document model to DOCX bytes. The model comes from a builder
 * in this repository, so a failure here is a defect rather than bad input;
 * the text entry points that take untrusted input return a `Result` instead.
 */
export const documentToDocx = async (
  document: Document,
): Promise<ArrayBuffer> => await createDocx(document);
