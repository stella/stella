import type { CharSpan } from "@/lib/anonymize/pdf-coords";

export type OverlayRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type SpanSlice = {
  spanIndex: number;
  localStart: number;
  localEnd: number;
};

/**
 * Map an entity's [start, end) offset range to the
 * CharSpan indices and local character offsets within
 * each overlapping span. Pure function; no DOM needed.
 */
export const mapEntityToSpanSlices = ({
  pageSpans,
  entityStart,
  entityEnd,
}: {
  pageSpans: CharSpan[];
  entityStart: number;
  entityEnd: number;
}): SpanSlice[] => {
  const slices: SpanSlice[] = [];

  for (let i = 0; i < pageSpans.length; i++) {
    const span = pageSpans[i];
    if (span === undefined) {
      continue;
    }
    if (span.end <= entityStart || span.start >= entityEnd) {
      continue;
    }

    const localStart = Math.max(0, entityStart - span.start);
    const localEnd = Math.min(span.text.length, entityEnd - span.start);

    if (localEnd > localStart) {
      slices.push({
        spanIndex: i,
        localStart,
        localEnd,
      });
    }
  }

  return slices;
};

/**
 * Merge rects on the same visual line into single
 * rectangles. Two rects are on the same line if their
 * `top` values are within half the rect height.
 */
export const mergeAdjacentRects = (rects: OverlayRect[]): OverlayRect[] => {
  if (rects.length <= 1) {
    return rects;
  }

  const sorted = rects.toSorted((a, b) => {
    const lineThreshold = Math.max(a.height, b.height) * 0.5;
    if (Math.abs(a.top - b.top) > lineThreshold) {
      return a.top - b.top;
    }
    return a.left - b.left;
  });

  const first = sorted[0];
  if (first === undefined) {
    return [];
  }
  const merged: OverlayRect[] = [{ ...first }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const prev = merged.at(-1);

    if (current === undefined || prev === undefined) {
      continue;
    }

    const sameLine =
      Math.abs(current.top - prev.top) <=
      Math.max(current.height, prev.height) * 0.5;
    const prevRight = prev.left + prev.width;
    // Tolerance proportional to font size to bridge
    // word gaps from pdfjs multi-span text layout.
    const gapTolerance = Math.max(current.height, prev.height) * 0.5;
    const adjacent = current.left <= prevRight + gapTolerance;

    if (sameLine && adjacent) {
      const newRight = Math.max(prevRight, current.left + current.width);
      prev.width = newRight - prev.left;
      prev.height = Math.max(prev.height, current.height);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
};
