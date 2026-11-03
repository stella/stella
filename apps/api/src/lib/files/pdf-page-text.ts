/**
 * A PDF's text page by page, as LibPDF extracts it: each page's `text`, the
 * lines of span characters joined by "\n". Anchors into a PDF (a
 * verification claim, a reader's mark) are UTF-16 offsets into exactly this
 * string, and the web viewer reads the same bytes with the same extractor
 * (`extractPDFPageSearchTexts`), so an offset stored here indexes the same
 * unit there.
 */

import { PDF } from "@libpdf/core";

import { sha256Hex } from "@stll/sha256/bun";

export type PdfPageText = {
  /** 1-based, as the viewer numbers pages. */
  pageNumber: number;
  /** Kept as extracted, never trimmed: offsets index into it. */
  text: string;
};

type ReadPdfPageTextsOptions = {
  bytes: Uint8Array;
  /** The 1-based pages to read; every page when absent. A number past the
   *  last page is skipped. */
  pageNumbers?: ReadonlySet<number>;
};

export const readPdfPageTexts = async ({
  bytes,
  pageNumbers,
}: ReadPdfPageTextsOptions): Promise<PdfPageText[]> => {
  const pdf = await PDF.load(bytes);
  const pages: PdfPageText[] = [];
  for (const [pageIndex, page] of pdf.getPages().entries()) {
    const pageNumber = pageIndex + 1;
    if (pageNumbers !== undefined && !pageNumbers.has(pageNumber)) {
      continue;
    }
    pages.push({ pageNumber, text: page.extractText().text });
  }
  return pages;
};

/** The digest a mark keeps of the page text it was placed on. */
export const pdfPageTextSha256 = (text: string): string => sha256Hex(text);
