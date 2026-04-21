import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

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
 * to PDF page coordinates. Each entry covers one TextItem.
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

const isTextItem = (item: { str?: string; type?: string }): item is TextItem =>
  typeof item.str === "string" && !("type" in item);

/**
 * Extract font size from a pdfjs TextItem transform matrix.
 * The transform is [scaleX, skewY, skewX, scaleY, tx, ty].
 */
const getFontSize = (transform: readonly number[]): number => {
  const scaleX = transform.at(0) ?? 0;
  const scaleY = transform.at(3) ?? 0;
  return Math.abs(scaleY) || Math.abs(scaleX) || 12;
};

/**
 * Extract text from a PDF with character-offset to page-
 * coordinate mapping. The concatenated text is suitable for
 * feeding into the anonymisation pipeline; the spans array
 * maps pipeline entity offsets back to PDF coordinates.
 */
export const extractPDFText = async (
  pdf: PDFDocumentProxy,
): Promise<PDFTextExtractionResult> => {
  const spans: CharSpan[] = [];
  const textParts: string[] = [];
  let offset = 0;

  const pageCount = pdf.numPages;

  for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
    const page = await pdf.getPage(pageIdx + 1);
    const content = await page.getTextContent();

    for (const item of content.items) {
      if (!isTextItem(item)) {
        continue;
      }

      if (item.str.length === 0) {
        if (item.hasEOL) {
          textParts.push("\n");
          offset += 1;
        }
        continue;
      }

      if (offset > 0 && textParts.length > 0) {
        const lastChar = textParts.at(-1);
        if (lastChar !== "\n") {
          textParts.push(" ");
          offset += 1;
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, typescript/consistent-type-assertions -- pdfjs transform is typed as any[]
      const transform = item.transform as number[];
      const x = transform.at(4) ?? 0;
      const y = transform.at(5) ?? 0;
      const fontSize = getFontSize(transform);

      const style = content.styles[item.fontName];
      const family = style?.fontFamily ?? "sans-serif";
      const isBold = /bold/i.test(item.fontName);
      const isItalic = /italic|oblique/i.test(item.fontName);
      const weight = isBold ? "bold" : "normal";
      const fontStyle = isItalic ? "italic" : "normal";
      const cssFont = `${fontStyle} ${weight} ${fontSize}px ${family}`;

      spans.push({
        start: offset,
        end: offset + item.str.length,
        text: item.str,
        cssFont,
        bbox: {
          pageIndex: pageIdx,
          x,
          y,
          width: item.width,
          height: item.height || fontSize,
          fontSize,
        },
      });

      textParts.push(item.str);
      offset += item.str.length;

      if (item.hasEOL) {
        textParts.push("\n");
        offset += 1;
      }
    }

    if (pageIdx < pageCount - 1) {
      textParts.push("\n");
      offset += 1;
    }
  }

  return {
    text: textParts.join(""),
    spans,
    pageCount,
  };
};
