import type { PDF, PDFPage } from "@libpdf/core";

/**
 * Bounding box for a text span in PDF user-space coordinates.
 * Coordinate origin is bottom-left of the page.
 */
export type PDFBBox = {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
};

/**
 * Maps character offset ranges in extracted plaintext
 * to PDF page coordinates. Each entry covers one TextSpan.
 */
export type CharSpan = {
  start: number;
  end: number;
  bbox: PDFBBox;
  text: string;
  cssFont: string;
};

type PDFTextExtractionResult = {
  text: string;
  spans: CharSpan[];
  pageCount: number;
};

/** Derived from PDFPage.extractText() return type. */
type PageTextResult = ReturnType<PDFPage["extractText"]>;
type Span = PageTextResult["lines"][number]["spans"][number];

const buildCssFont = (span: Span): string => {
  const isBold = /bold/i.test(span.fontName);
  const isItalic = /italic|oblique/i.test(span.fontName);
  const weight = isBold ? "bold" : "normal";
  const fontStyle = isItalic ? "italic" : "normal";
  return `${fontStyle} ${weight} ${span.fontSize}px sans-serif`;
};

/**
 * Extract text from a @libpdf/core PDF instance with
 * character-offset to page-coordinate mapping. The concatenated
 * text is suitable for the anonymisation pipeline; the spans
 * array maps pipeline entity offsets back to PDF coordinates.
 */
export const extractPDFText = (pdf: PDF): PDFTextExtractionResult => {
  const pages: PageTextResult[] = pdf
    .getPages()
    .map((page) => page.extractText());
  return buildResult(pages);
};

const buildResult = (pages: PageTextResult[]): PDFTextExtractionResult => {
  const spans: CharSpan[] = [];
  const textParts: string[] = [];
  let offset = 0;

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];
    if (!page) {
      continue;
    }

    for (const line of page.lines) {
      for (const span of line.spans) {
        if (span.text.length === 0) {
          continue;
        }

        if (offset > 0 && textParts.length > 0) {
          const lastChar = textParts.at(-1);
          if (lastChar !== "\n") {
            textParts.push(" ");
            offset += 1;
          }
        }

        spans.push({
          start: offset,
          end: offset + span.text.length,
          text: span.text,
          cssFont: buildCssFont(span),
          bbox: {
            pageIndex: pageIdx,
            x: span.bbox.x,
            y: span.bbox.y,
            width: span.bbox.width,
            height: span.bbox.height || span.fontSize,
            fontSize: span.fontSize,
          },
        });

        textParts.push(span.text);
        offset += span.text.length;
      }

      // End of line
      textParts.push("\n");
      offset += 1;
    }

    // Page separator (except last page)
    if (pageIdx < pages.length - 1 && !textParts.at(-1)?.endsWith("\n")) {
      textParts.push("\n");
      offset += 1;
    }
  }

  return {
    text: textParts.join(""),
    spans,
    pageCount: pages.length,
  };
};
