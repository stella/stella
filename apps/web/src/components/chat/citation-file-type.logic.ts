import { panic } from "better-result";

import type { ChatSourceCitationTarget } from "@stll/api-contract";

import { DOCX_MIME, PDF_MIME, PPTX_MIME, XLSX_MIME } from "@/lib/consts";

/**
 * The file type an inline citation points into, read from the citation's own
 * data. Each citation format exists for exactly one file format, so the chip
 * can draw the same file-type glyph as the source chips without a lookup.
 */
export const sourceCitationMimeType = (
  kind: ChatSourceCitationTarget["type"],
): string => {
  switch (kind) {
    case "docx-folio":
      return DOCX_MIME;
    case "pdf-bates":
      return PDF_MIME;
    default:
      kind satisfies never;
      return panic(`Unhandled source citation kind: ${String(kind)}`);
  }
};

/** `#folio:` citations address blocks of an open DOCX. */
export const FOLIO_CITATION_MIME_TYPE = DOCX_MIME;

/**
 * Office citation block ids carry their format as a prefix
 * (`xlsx-…` or `pptx-…`, enforced by the href parser).
 */
export const officeCitationMimeType = (blockId: string): string => {
  if (blockId.startsWith("xlsx-")) {
    return XLSX_MIME;
  }
  if (blockId.startsWith("pptx-")) {
    return PPTX_MIME;
  }
  return panic(`Unhandled office citation block id: ${blockId}`);
};
