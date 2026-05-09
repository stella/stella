import { describe, expect, test } from "bun:test";

import { layoutDocument } from "./index";
import type {
  FlowBlock,
  LayoutOptions,
  Measure,
  ParagraphBlock,
  ParagraphMeasure,
  PageMargins,
  TextRun,
} from "./types";

// Single-pass footnote layout: each body line carrying a footnote ref
// reserves space for that fn's content on the same page. Replaces the
// earlier static-reservation + iterative-convergence loop, which
// produced either body-overflow into the footer or large gaps above
// the fn area on documents with multiple long footnotes per page.

const MARGINS: PageMargins = { top: 0, right: 0, bottom: 0, left: 0 };

function makePara(
  id: number,
  runs: TextRun[],
  lineCount: number,
  lineHeight: number,
  fromRunPerLine: number[] = Array.from({ length: lineCount }, () => 0),
  toRunPerLine: number[] = Array.from(
    { length: lineCount },
    () => runs.length - 1,
  ),
): { block: ParagraphBlock; measure: ParagraphMeasure } {
  const block: ParagraphBlock = {
    kind: "paragraph",
    id,
    runs,
    attrs: {},
    pmStart: 1,
    pmEnd: 100,
  };
  const lines = Array.from({ length: lineCount }, (_, i) => ({
    fromRun: fromRunPerLine[i] ?? 0,
    fromChar: 0,
    toRun: toRunPerLine[i] ?? runs.length - 1,
    toChar: 0,
    width: 100,
    ascent: lineHeight * 0.8,
    descent: lineHeight * 0.2,
    lineHeight,
  }));
  const measure: ParagraphMeasure = {
    kind: "paragraph",
    lines,
    totalHeight: lineHeight * lineCount,
  };
  return { block, measure };
}

function textRun(
  pmStart: number,
  text: string,
  footnoteRefId?: number,
): TextRun {
  const run: TextRun = {
    kind: "text",
    text,
    pmStart,
    pmEnd: pmStart + text.length,
  };
  if (footnoteRefId !== undefined) {
    run.footnoteRefId = footnoteRefId;
  }
  return run;
}

describe("footnote line-level reservation", () => {
  test("page reserves fn-content space for each line carrying a fn ref", () => {
    // Page 100 px tall. Line height 10 px. Fn 1 height 30 px.
    // A 5-line para where line 3 carries fn ref 1 should keep all
    // five lines on page 1: 5*10 + 30 = 80 ≤ 100.
    const { block, measure } = makePara(
      0,
      [textRun(1, "Line1Line2"), textRun(20, "fn", 1), textRun(22, "moretext")],
      5,
      10,
      [0, 0, 0, 1, 2],
      [0, 0, 1, 2, 2],
    );
    // Line 2 (index 2) covers runs 0..1 — the fn ref run is in line 2.

    const layoutOptions: LayoutOptions = {
      pageSize: { w: 600, h: 100 },
      margins: MARGINS,
      pageGap: 0,
      footnoteHeightById: new Map([[1, 30]]),
    };

    const blocks: FlowBlock[] = [block];
    const measures: Measure[] = [measure];

    const layout = layoutDocument(blocks, measures, layoutOptions);

    // All 5 lines must be on page 1 (50 px body + 30 px fn = 80 px ≤ 100).
    const page1 = layout.pages[0]!;
    const para = page1.fragments.find(
      (f) => f.kind === "paragraph" && f.blockId === 0,
    );
    expect(para).toBeDefined();
    expect(page1.footnoteReservedHeight).toBeGreaterThanOrEqual(30);
  });

  test("page advances when a fn-bearing line cannot fit alongside its fn", () => {
    // Page 50 px tall. 5 lines × 10 px = 50 px = full page (no fn).
    // Add fn ref of height 40 px to line 4. Line 4 + fn don't fit on
    // page 1 alongside lines 1-3 (3*10 + 10 + 40 = 80 > 50). The line
    // (and the fn) must move to page 2.
    const { block, measure } = makePara(
      0,
      [textRun(1, "Line1"), textRun(10, "fn", 7)],
      5,
      10,
      [0, 0, 0, 0, 1],
      [0, 0, 0, 0, 1],
    );

    const layoutOptions: LayoutOptions = {
      pageSize: { w: 600, h: 50 },
      margins: MARGINS,
      pageGap: 0,
      footnoteHeightById: new Map([[7, 40]]),
    };

    const layout = layoutDocument([block], [measure], layoutOptions);

    expect(layout.pages.length).toBeGreaterThanOrEqual(2);
    // Page 1 has no fn reservation (no fn-bearing line landed there).
    expect(layout.pages[0]!.footnoteReservedHeight ?? 0).toBe(0);
    // Page 2 carries the fn for the moved line.
    const p2Fn = layout.pages[1]!.footnoteReservedHeight ?? 0;
    expect(p2Fn).toBeGreaterThanOrEqual(40);
  });

  test("ignored when footnoteHeightById is not provided", () => {
    // Without the fn-height table, the engine falls back to the static
    // (pre-fix) behaviour: fn refs are treated as ordinary text runs
    // and contribute zero reservation. Layout fits all lines on one
    // page with no `footnoteReservedHeight` set.
    const { block, measure } = makePara(0, [textRun(1, "x", 1)], 3, 10);

    const layoutOptions: LayoutOptions = {
      pageSize: { w: 600, h: 100 },
      margins: MARGINS,
      pageGap: 0,
    };

    const layout = layoutDocument([block], [measure], layoutOptions);

    expect(layout.pages.length).toBe(1);
    expect(layout.pages[0]!.footnoteReservedHeight).toBeUndefined();
  });
});
