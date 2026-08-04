/**
 * MIME-type classification shared by the extraction gate and the
 * sandboxed extraction worker.
 *
 * The parent process decides whether spawning the worker is worth
 * it; the worker dispatches on the same classification to pick a
 * parser. Both must agree, so the sets live here rather than being
 * restated on either side.
 *
 * Pure constants and predicates only: the worker imports this
 * module at startup, so it must stay free of side effects.
 */

import { EMAIL_MIME_TYPES } from "@/api/lib/files/email-to-html";
import {
  DOC_MIME_TYPE,
  DOCM_MIME_TYPE,
  DOCX_MIME_TYPE,
  EPUB_MIME_TYPE,
  ODP_MIME_TYPE,
  ODS_MIME_TYPE,
  ODT_MIME_TYPE,
  PDF_MIME_TYPE,
  PPSX_MIME_TYPE,
  PPT_MIME_TYPE,
  PPTX_MIME_TYPE,
  RTF_MIME_TYPE,
  XLS_MIME_TYPE,
  XLSB_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";

export const normalizeMimeType = (mimeType: string): string =>
  mimeType.split(";").at(0)?.trim().toLowerCase() ?? "";

/**
 * Membership is always tested against a normalized MIME type, so the
 * set has to hold normalized values. Several registered office types
 * are spelled with capitals (`...macroEnabled.12`), which would
 * otherwise sit in the set unmatchable while the canonical spelling
 * stays correct everywhere it is emitted.
 */
const mimeTypeSet = (mimeTypes: readonly string[]): Set<string> =>
  new Set(mimeTypes.map(normalizeMimeType));

export const DIRECT_TEXT_MIME_TYPES = mimeTypeSet([
  "application/json",
  "text/calendar",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
]);

/**
 * Formats parsed to Markdown by anydoc.
 *
 * Deliberately excludes DOCX: Folio owns that format and also
 * recovers comments and tracked-change notes, which a plain
 * Markdown conversion drops. PDF stays on `@libpdf/core`, and CSV
 * stays on the direct-text path, where the bytes are already text.
 *
 * Limited to the extensions anydoc documents. Anything outside the
 * set (macro-enabled spreadsheets, Apple iWork, ...) keeps falling
 * back to the Gotenberg PDF derivative.
 */
export const OFFICE_DOCUMENT_MIME_TYPES = mimeTypeSet([
  DOC_MIME_TYPE,
  DOCM_MIME_TYPE,
  EPUB_MIME_TYPE,
  ODP_MIME_TYPE,
  ODS_MIME_TYPE,
  ODT_MIME_TYPE,
  PPSX_MIME_TYPE,
  PPT_MIME_TYPE,
  PPTX_MIME_TYPE,
  RTF_MIME_TYPE,
  XLS_MIME_TYPE,
  XLSB_MIME_TYPE,
  XLSX_MIME_TYPE,
]);

export const isDirectTextMimeType = (mimeType: string): boolean =>
  DIRECT_TEXT_MIME_TYPES.has(normalizeMimeType(mimeType));

export const isOfficeDocumentMimeType = (mimeType: string): boolean =>
  OFFICE_DOCUMENT_MIME_TYPES.has(normalizeMimeType(mimeType));

export const canExtractMimeType = (mimeType: string): boolean => {
  const normalized = normalizeMimeType(mimeType);
  return (
    normalized === PDF_MIME_TYPE ||
    normalized === DOCX_MIME_TYPE ||
    isOfficeDocumentMimeType(normalized) ||
    isDirectTextMimeType(normalized) ||
    normalized in EMAIL_MIME_TYPES
  );
};
