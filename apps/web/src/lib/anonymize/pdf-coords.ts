import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

/**
 * Bounding box for a text span in PDF user-space coordinates.
 * Coordinate origin is bottom-left of the page.
 */
export type PdfBBox = {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Font size derived from the text item's transform matrix. */
  fontSize: number;
};

/**
 * Maps character offset ranges in extracted plaintext
 * to PDF page coordinates. Each entry covers one TextItem.
 */
export type CharSpan = {
  /** Inclusive start offset in the concatenated plaintext. */
  start: number;
  /** Exclusive end offset in the concatenated plaintext. */
  end: number;
  /** PDF bounding box for this text fragment. */
  bbox: PdfBBox;
  /** Original text of this TextItem (for font measurement). */
  text: string;
  /** CSS font string for measuring sub-string widths. */
  cssFont: string;
};

/**
 * Result of extracting text with coordinate mapping.
 */
type PdfTextExtractionResult = {
  /** Concatenated plaintext from all pages. */
  text: string;
  /** Character-offset → coordinate spans, sorted by start. */
  spans: CharSpan[];
  /** Number of pages in the document. */
  pageCount: number;
};

/**
 * Type guard to distinguish TextItem from TextMarkedContent.
 */
const isTextItem = (item: { str?: string; type?: string }): item is TextItem =>
  typeof item.str === "string" && !("type" in item);

/**
 * Extract font size from a pdfjs TextItem transform matrix.
 * The transform is [scaleX, skewY, skewX, scaleY, tx, ty].
 * Font size is typically abs(scaleY) or abs(scaleX).
 */
const getFontSize = (transform: number[]): number => {
  const scaleX = transform.at(0) ?? 0;
  const scaleY = transform.at(3) ?? 0;
  return Math.abs(scaleY) || Math.abs(scaleX) || 12;
};

/**
 * Extract text from a PDF with character-offset to page-
 * coordinate mapping. The concatenated text is suitable for
 * feeding into the anonymisation pipeline; the spans array
 * maps pipeline entity offsets back to PDF coordinates.
 *
 * Text items are separated by spaces (or newlines when
 * hasEOL is true) to produce readable plaintext.
 */
export const extractPdfText = async (
  pdf: PDFDocumentProxy,
): Promise<PdfTextExtractionResult> => {
  const spans: CharSpan[] = [];
  const textParts: string[] = [];
  let offset = 0;

  const pageCount = pdf.numPages;

  for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
    const page = await pdf.getPage(pageIdx + 1); // 1-based
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

      // Add separator between items (space or newline)
      if (offset > 0 && textParts.length > 0) {
        const lastChar = textParts.at(-1);
        if (lastChar !== "\n") {
          textParts.push(" ");
          offset += 1;
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- pdfjs transform is typed as any[]
      const transform = item.transform as number[];
      const x = transform.at(4) ?? 0;
      const y = transform.at(5) ?? 0;
      const fontSize = getFontSize(transform);

      // Build CSS font string for sub-string measurement.
      // pdfjs styles map fontName → { fontFamily }.
      const style = content.styles[item.fontName];
      const family = style?.fontFamily ?? "sans-serif";
      const cssFont = `${fontSize}px ${family}`;

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

    // Page separator
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

/**
 * Function signature for measuring rendered text width.
 * The default implementation uses OffscreenCanvas; tests
 * can inject a mock.
 */
export type MeasureWidthFn = (cssFont: string, text: string) => number;

/**
 * Shared offscreen canvas for measuring text widths.
 * Lazily initialised on first use.
 */
let measureCtx: OffscreenCanvasRenderingContext2D | null = null;

/**
 * Measure the rendered width of `text` using the browser's
 * font engine. The result is in CSS pixels (≈ PDF points
 * when the font size matches the PDF's user-space size).
 */
const canvasMeasureWidth: MeasureWidthFn = (cssFont, text): number => {
  // SAFETY: getContext("2d") only returns null if the context
  // type is unsupported; OffscreenCanvas always supports "2d".
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  measureCtx ??= new OffscreenCanvas(1, 1).getContext(
    "2d",
  ) as OffscreenCanvasRenderingContext2D;
  measureCtx.font = cssFont;
  return measureCtx.measureText(text).width;
};

/**
 * Find the PDF bounding boxes for an entity span defined
 * by character offsets. An entity may span multiple text
 * items (e.g., "Jan Novák" split across two TextItems).
 * Returns one PdfBBox per text fragment.
 *
 * For sub-TextItem precision, the browser's font engine
 * (`CanvasRenderingContext2D.measureText`) measures the
 * actual variable-width glyph widths of the prefix and
 * overlap substrings. A scale factor (PDF width / measured
 * width) corrects for differences between the browser font
 * and the PDF's embedded font metrics. A small padding
 * (half a fontSize) absorbs any residual metric mismatch.
 */
export const getEntityBBoxes = (
  spans: CharSpan[],
  entityStart: number,
  entityEnd: number,
  measureWidth: MeasureWidthFn = canvasMeasureWidth,
): PdfBBox[] => {
  const result: PdfBBox[] = [];

  for (const span of spans) {
    // No overlap — skip
    if (span.end <= entityStart || span.start >= entityEnd) {
      continue;
    }

    const spanLength = span.end - span.start;
    if (spanLength === 0) {
      continue;
    }

    const overlapStart = Math.max(span.start, entityStart);
    const overlapEnd = Math.min(span.end, entityEnd);

    // Measure the full TextItem to detect table-layout
    // inflation (pdfjs width includes column gaps).
    const measuredTotal = measureWidth(span.cssFont, span.text);

    // Scale factor: PDF width / browser-measured width.
    // Corrects for font metric differences. Capped at 1.5
    // to prevent table-layout inflation (where pdfjs width
    // includes visual column gaps, pushing ratio to 3x+).
    const MAX_SCALE = 1.5;
    const rawScale = measuredTotal > 0 ? span.bbox.width / measuredTotal : 1;
    const scale = Math.min(rawScale, MAX_SCALE);

    // Effective span width: use measured × scale instead
    // of the raw PDF width when inflated. This ensures
    // boxes only cover actual text, not column gaps.
    const effectiveWidth = measuredTotal * scale;

    // Entity covers the full TextItem: no left padding
    // needed (entity starts at TextItem boundary); right
    // padding absorbs font metric mismatch.
    if (overlapStart === span.start && overlapEnd === span.end) {
      const pad = span.bbox.fontSize * 0.75;
      const paddedEnd = Math.min(
        span.bbox.x + span.bbox.width,
        span.bbox.x + effectiveWidth + pad,
      );
      result.push({
        ...span.bbox,
        width: paddedEnd - span.bbox.x,
      });
      continue;
    }

    // Partial overlap: measure sub-string widths using
    // the browser's font engine. Use the RAW (uncapped)
    // scale here: the ratio measureText(prefix)/
    // measureText(total) * pdfWidth gives the correct
    // proportional position even when pdfWidth includes
    // table column gaps. Capping would compress the
    // prefix width and misplace the box.
    const localStart = overlapStart - span.start;
    const localEnd = overlapEnd - span.start;

    const prefixWidth =
      measureWidth(span.cssFont, span.text.slice(0, localStart)) * rawScale;
    const overlapWidth =
      measureWidth(span.cssFont, span.text.slice(0, localEnd)) * rawScale -
      prefixWidth;

    // Safety padding (0.75 em) absorbs residual mismatch
    // between the PDF's embedded font metrics and the
    // browser's substitute font.
    const pad = span.bbox.fontSize * 0.75;

    const rawX = span.bbox.x + prefixWidth;
    const rawEnd = rawX + overlapWidth;
    const paddedX = Math.max(span.bbox.x, rawX - pad);
    const paddedEnd = Math.min(span.bbox.x + span.bbox.width, rawEnd + pad);

    result.push({
      pageIndex: span.bbox.pageIndex,
      x: paddedX,
      y: span.bbox.y,
      width: paddedEnd - paddedX,
      height: span.bbox.height,
      fontSize: span.bbox.fontSize,
    });
  }

  return mergeAdjacentBBoxes(result);
};

/**
 * Merge adjacent/overlapping bboxes on the same line into
 * single rectangles. When an entity spans multiple TextItems
 * on the same line (e.g., bold text split across font
 * changes), drawing each bbox separately creates a visual
 * mess of overlapping coloured rectangles. Merging produces
 * one clean box per visual line.
 *
 * Two bboxes are "on the same line" if they share the same
 * pageIndex and their y coordinates are within half a
 * fontSize of each other.
 */
const mergeAdjacentBBoxes = (bboxes: PdfBBox[]): PdfBBox[] => {
  if (bboxes.length <= 1) {
    return bboxes;
  }

  // Sort by page, then y (descending — PDF coords), then x
  const sorted = bboxes.toSorted((a, b) => {
    if (a.pageIndex !== b.pageIndex) {
      return a.pageIndex - b.pageIndex;
    }
    const lineThreshold = Math.max(a.fontSize, b.fontSize) * 0.5;
    if (Math.abs(a.y - b.y) > lineThreshold) {
      return b.y - a.y; // descending y = top-to-bottom
    }
    return a.x - b.x;
  });

  const first = sorted[0];
  if (first === undefined) {
    return [];
  }
  const merged: PdfBBox[] = [first];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    // eslint-disable-next-line unicorn/prefer-at -- mutated in-place below
    const prev = merged[merged.length - 1];
    if (current === undefined || prev === undefined) {
      continue;
    }

    const samePage = current.pageIndex === prev.pageIndex;
    const sameLine =
      Math.abs(current.y - prev.y) <=
      Math.max(current.fontSize, prev.fontSize) * 0.5;
    const prevRight = prev.x + prev.width;
    // Adjacent or overlapping: current starts before or
    // at the previous box's right edge (with a small gap
    // tolerance of 2pt for font kerning differences)
    const adjacent = current.x <= prevRight + 2;

    if (samePage && sameLine && adjacent) {
      // Merge: extend prev to cover current
      const newEnd = Math.max(prevRight, current.x + current.width);
      prev.width = newEnd - prev.x;
      prev.height = Math.max(prev.height, current.height);
      prev.fontSize = Math.max(prev.fontSize, current.fontSize);
    } else {
      merged.push(current);
    }
  }

  return merged;
};
