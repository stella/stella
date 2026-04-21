import type { CharSpan, PDFBBox } from "@/lib/anonymize/pdf-coords";
import { ClientCapabilityError } from "@/lib/errors";

export type MeasureWidthFn = (cssFont: string, text: string) => number;

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;

const getOrCreateCtx = (): OffscreenCanvasRenderingContext2D => {
  if (measureCtx) {
    return measureCtx;
  }
  const ctx = new OffscreenCanvas(1, 1).getContext("2d");
  if (!ctx) {
    throw new ClientCapabilityError({
      capability: "OffscreenCanvas2D",
      message: "OffscreenCanvas 2d context unavailable",
    });
  }
  measureCtx = ctx;
  return ctx;
};

const canvasMeasureWidth: MeasureWidthFn = (cssFont, text): number => {
  const ctx = getOrCreateCtx();
  ctx.font = cssFont;
  return ctx.measureText(text).width;
};

/**
 * Find the PDF bounding boxes for an entity span defined
 * by character offsets. Uses OffscreenCanvas measureText
 * for sub-TextItem precision. Used by the redaction export
 * path where no DOM text layer is available.
 */
export const getEntityBBoxes = ({
  spans,
  entityStart,
  entityEnd,
  measureWidth = canvasMeasureWidth,
}: {
  spans: readonly CharSpan[];
  entityStart: number;
  entityEnd: number;
  measureWidth?: MeasureWidthFn;
}): PDFBBox[] => {
  const result: PDFBBox[] = [];

  for (const span of spans) {
    if (span.end <= entityStart || span.start >= entityEnd) {
      continue;
    }

    const spanLength = span.end - span.start;
    if (spanLength === 0) {
      continue;
    }

    const overlapStart = Math.max(span.start, entityStart);
    const overlapEnd = Math.min(span.end, entityEnd);

    const measuredTotal = measureWidth(span.cssFont, span.text);

    // Capped at 1.5 to prevent table-layout inflation
    // (pdfjs width includes visual column gaps, pushing
    // ratio to 3x+).
    const MAX_SCALE = 1.5;
    const rawScale = measuredTotal > 0 ? span.bbox.width / measuredTotal : 1;
    const scale = Math.min(rawScale, MAX_SCALE);
    const effectiveWidth = measuredTotal * scale;

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

    // Partial overlap: use RAW (uncapped) scale so
    // measureText(prefix)/measureText(total) * pdfWidth
    // gives correct proportional position even when
    // pdfWidth includes table column gaps.
    const localStart = overlapStart - span.start;
    const localEnd = overlapEnd - span.start;

    const prefixWidth =
      measureWidth(span.cssFont, span.text.slice(0, localStart)) * rawScale;
    const overlapWidth =
      measureWidth(span.cssFont, span.text.slice(0, localEnd)) * rawScale -
      prefixWidth;

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
 * single rectangles. Two bboxes are "on the same line" if
 * they share the same pageIndex and their y coordinates are
 * within half a fontSize of each other.
 */
export const mergeAdjacentBBoxes = (bboxes: readonly PDFBBox[]): PDFBBox[] => {
  if (bboxes.length <= 1) {
    return bboxes.map((bbox) => ({ ...bbox }));
  }

  const sorted = bboxes.toSorted((a, b) => {
    if (a.pageIndex !== b.pageIndex) {
      return a.pageIndex - b.pageIndex;
    }
    const lineThreshold = Math.max(a.fontSize, b.fontSize) * 0.5;
    if (Math.abs(a.y - b.y) > lineThreshold) {
      return b.y - a.y;
    }
    return a.x - b.x;
  });

  const first = sorted[0];
  if (first === undefined) {
    return [];
  }
  const merged: PDFBBox[] = [{ ...first }];

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
    // 2pt gap tolerance for font kerning differences
    const adjacent = current.x <= prevRight + 2;

    if (samePage && sameLine && adjacent) {
      const newEnd = Math.max(prevRight, current.x + current.width);
      prev.width = newEnd - prev.x;
      prev.height = Math.max(prev.height, current.height);
      prev.fontSize = Math.max(prev.fontSize, current.fontSize);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
};
