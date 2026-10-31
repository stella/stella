/**
 * Retention projection for a Slovak general court decision's PDF.
 *
 * The `sk-courts` adapter stores listing metadata and builds no document, so
 * its policy is `unparsed` (see `sk-courts.ts`). The decision's text arrives
 * later: the document drain downloads the PDF, parses it and writes the
 * document onto the row outside the pipeline. The drain projects the bytes
 * it fetched through this module and runs the shared retention check on
 * what it stored, so those documents are measured as every pipeline
 * decision is.
 *
 * The projection is every line the PDF states, read with the PDF library
 * directly rather than through the parser's reader. The court's per-page
 * header (court, docket, ECLI) is part of that text and the parser rightly
 * drops it; it repeats identically on every page, so the oracle reads it
 * once and it costs a few words of the missing-word tolerance at most.
 */
import type { RetentionProjection } from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { projectPdfText } from "@/api/handlers/case-law/ingestion/retention/sources/pdf-text";

export const projectSkCourtsDocument = async (
  pdfBytes: Uint8Array,
): Promise<RetentionProjection> => await projectPdfText(pdfBytes);
