import { describe, expect, it } from "bun:test";

import { mapEntityToSpanSlices, mergeAdjacentRects } from "./overlay-rects";
import type { OverlayRect } from "./overlay-rects";
import type { CharSpan } from "./pdf-coords";

// ── Helpers ──────────────────────────────────────────

const makeSpan = (start: number, end: number, pageIndex = 0): CharSpan => ({
  start,
  end,
  text: "x".repeat(end - start),
  cssFont: "12px sans-serif",
  bbox: {
    pageIndex,
    x: 0,
    y: 0,
    width: 100,
    height: 12,
    fontSize: 12,
  },
});

// ── mapEntityToSpanSlices ────────────────────────────

describe("mapEntityToSpanSlices", () => {
  it("returns empty for no overlap", () => {
    const spans = [makeSpan(0, 5), makeSpan(6, 11)];
    const result = mapEntityToSpanSlices({
      pageSpans: spans,
      entityStart: 20,
      entityEnd: 25,
    });
    expect(result).toEqual([]);
  });

  it("maps entity within a single span", () => {
    const spans = [makeSpan(0, 10)];
    const result = mapEntityToSpanSlices({
      pageSpans: spans,
      entityStart: 2,
      entityEnd: 7,
    });
    expect(result).toEqual([{ spanIndex: 0, localStart: 2, localEnd: 7 }]);
  });

  it("maps entity covering full span", () => {
    const spans = [makeSpan(0, 5)];
    const result = mapEntityToSpanSlices({
      pageSpans: spans,
      entityStart: 0,
      entityEnd: 5,
    });
    expect(result).toEqual([{ spanIndex: 0, localStart: 0, localEnd: 5 }]);
  });

  it("maps entity spanning multiple spans", () => {
    // "Hello" [0,5) + " " [5,6) separator + "World" [6,11)
    const spans = [makeSpan(0, 5), makeSpan(6, 11)];
    const result = mapEntityToSpanSlices({
      pageSpans: spans,
      entityStart: 0,
      entityEnd: 11,
    });
    expect(result).toEqual([
      { spanIndex: 0, localStart: 0, localEnd: 5 },
      { spanIndex: 1, localStart: 0, localEnd: 5 },
    ]);
  });

  it("handles partial overlap at start", () => {
    const spans = [makeSpan(0, 10)];
    const result = mapEntityToSpanSlices({
      pageSpans: spans,
      entityStart: 5,
      entityEnd: 15,
    });
    expect(result).toEqual([{ spanIndex: 0, localStart: 5, localEnd: 10 }]);
  });

  it("handles partial overlap at end", () => {
    const spans = [makeSpan(10, 20)];
    const result = mapEntityToSpanSlices({
      pageSpans: spans,
      entityStart: 5,
      entityEnd: 15,
    });
    expect(result).toEqual([{ spanIndex: 0, localStart: 0, localEnd: 5 }]);
  });

  it("preserves correct span indices with gaps", () => {
    const spans = [makeSpan(0, 5), makeSpan(10, 15), makeSpan(20, 25)];
    const result = mapEntityToSpanSlices({
      pageSpans: spans,
      entityStart: 12,
      entityEnd: 22,
    });
    expect(result).toEqual([
      { spanIndex: 1, localStart: 2, localEnd: 5 },
      { spanIndex: 2, localStart: 0, localEnd: 2 },
    ]);
  });

  it("skips zero-length overlaps", () => {
    const spans = [makeSpan(0, 5), makeSpan(5, 10)];
    // Entity ends exactly at span boundary
    const result = mapEntityToSpanSlices({
      pageSpans: spans,
      entityStart: 0,
      entityEnd: 5,
    });
    expect(result).toEqual([{ spanIndex: 0, localStart: 0, localEnd: 5 }]);
  });
});

// ── mergeAdjacentRects ───────────────────────────────

describe("mergeAdjacentRects", () => {
  it("returns empty for empty input", () => {
    expect(mergeAdjacentRects([])).toEqual([]);
  });

  it("returns single rect unchanged", () => {
    const rect: OverlayRect = {
      left: 10,
      top: 20,
      width: 50,
      height: 12,
    };
    expect(mergeAdjacentRects([rect])).toEqual([rect]);
  });

  it("merges two adjacent rects on the same line", () => {
    const rects: OverlayRect[] = [
      { left: 10, top: 20, width: 50, height: 12 },
      { left: 60, top: 20, width: 30, height: 12 },
    ];
    const merged = mergeAdjacentRects(rects);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      left: 10,
      top: 20,
      width: 80,
      height: 12,
    });
  });

  it("merges rects with word-spacing gap (within 0.5×height)", () => {
    // Gap of 5px, tolerance = 0.5 * 12 = 6px → merged
    const rects: OverlayRect[] = [
      { left: 10, top: 20, width: 50, height: 12 },
      { left: 65, top: 20, width: 30, height: 12 },
    ];
    const merged = mergeAdjacentRects(rects);
    expect(merged).toHaveLength(1);
  });

  it("keeps rects on different lines separate", () => {
    const rects: OverlayRect[] = [
      { left: 10, top: 20, width: 50, height: 12 },
      { left: 10, top: 40, width: 50, height: 12 },
    ];
    const merged = mergeAdjacentRects(rects);
    expect(merged).toHaveLength(2);
  });

  it("merges rects with slightly different tops (within tolerance)", () => {
    const rects: OverlayRect[] = [
      { left: 10, top: 20, width: 50, height: 12 },
      { left: 60, top: 22, width: 30, height: 12 },
    ];
    const merged = mergeAdjacentRects(rects);
    expect(merged).toHaveLength(1);
  });

  it("uses max height when merging", () => {
    const rects: OverlayRect[] = [
      { left: 10, top: 20, width: 50, height: 12 },
      { left: 60, top: 20, width: 30, height: 16 },
    ];
    const merged = mergeAdjacentRects(rects);
    expect(merged[0]?.height).toBe(16);
  });

  it("handles overlapping rects", () => {
    const rects: OverlayRect[] = [
      { left: 10, top: 20, width: 50, height: 12 },
      { left: 40, top: 20, width: 50, height: 12 },
    ];
    const merged = mergeAdjacentRects(rects);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      left: 10,
      top: 20,
      width: 80,
      height: 12,
    });
  });

  it("handles non-adjacent rects on the same line", () => {
    const rects: OverlayRect[] = [
      { left: 10, top: 20, width: 20, height: 12 },
      { left: 100, top: 20, width: 20, height: 12 },
    ];
    const merged = mergeAdjacentRects(rects);
    expect(merged).toHaveLength(2);
  });
});
