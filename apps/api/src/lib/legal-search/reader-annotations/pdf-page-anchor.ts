import { Result } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import {
  READER_PDF_PAGE_ANCHOR_PREFIX,
  READER_PDF_PAGE_NUMBER_MAX,
} from "@stll/api-contract/legal-reader-annotations";

/** A page number as `readerPdfPageAnchorId` writes it: no sign, no zero. */
const PAGE_DIGITS = /^[1-9][0-9]*$/u;

/**
 * The 1-based page a PDF block anchor names (`readerPdfPageAnchorId`), or null
 * for any other anchor. The database check holds a matter document's rows to
 * the same shape.
 */
export const pdfPageNumberOfAnchor = (anchorId: string): number | null => {
  if (!anchorId.startsWith(READER_PDF_PAGE_ANCHOR_PREFIX)) {
    return null;
  }
  const digits = anchorId.slice(READER_PDF_PAGE_ANCHOR_PREFIX.length);
  if (!PAGE_DIGITS.test(digits)) {
    return null;
  }
  const page = parseIntegerToken(digits, {
    sign: "unsigned",
    min: 1,
    max: READER_PDF_PAGE_NUMBER_MAX,
  });
  return Result.isError(page) ? null : page.value;
};
