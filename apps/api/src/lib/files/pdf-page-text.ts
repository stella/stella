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

/** Where one extracted line sits on its page, in PDF points. */
export type PdfLineBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PdfPageText = {
  /** 1-based, as the viewer numbers pages. */
  pageNumber: number;
  /** Kept as extracted, never trimmed: offsets index into it. */
  text: string;
  /**
   * One box per line of `text` (its "\n"-separated lines, in order), so a
   * reader of paragraphs can weigh indents and gaps. Null when the
   * extractor's lines do not spell `text` exactly, so a box is never paired
   * with the wrong line.
   */
  lineBoxes: readonly PdfLineBox[] | null;
};

const lineBoxesOf = ({
  text,
  lines,
}: {
  text: string;
  lines: readonly { text: string; bbox: PdfLineBox }[];
}): PdfLineBox[] | null =>
  lines.map((line) => line.text).join("\n") === text
    ? lines.map(({ bbox }) => ({
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height,
      }))
    : null;

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
    const extracted = page.extractText();
    pages.push({
      pageNumber,
      text: extracted.text,
      lineBoxes: lineBoxesOf(extracted),
    });
  }
  return pages;
};

/** The digest a mark keeps of the page text it was placed on. */
export const pdfPageTextSha256 = (text: string): string => sha256Hex(text);
