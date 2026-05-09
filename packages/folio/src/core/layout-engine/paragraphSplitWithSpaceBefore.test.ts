import { describe, expect, test } from "bun:test";

import { layoutDocument } from "./index";
import type {
  FlowBlock,
  LayoutOptions,
  Measure,
  ParagraphBlock,
  ParagraphMeasure,
  PageMargins,
} from "./types";

// Regression: a multi-line paragraph with `spaceBefore` whose first
// fragment lands near the bottom of a page must split at the page
// boundary — *not* jump entirely to the next page.
//
// Pre-fix the line-fitting loop only added `spaceBefore` to the
// `withSpacing <= availableHeight` check on the very first iteration
// (`j === currentLineIndex`). Subsequent iterations compared a bare
// `linesHeight + lineHeight` against the full available height, so the
// loop claimed more lines than would actually fit. `addFragment` then
// summed `spaceBefore + linesHeight` and refused the placement,
// punting the *whole* fragment to the next page. The visible symptom
// was a gap at the bottom of one page and the entire next paragraph
// starting fresh on the page after — even though several of its lines
// could have fit. Hit hard on NVCA-style legal templates with long
// numbered list items (e.g. (iii) Shortfall Closing) sitting after a
// dense (ii) item.

const MARGINS: PageMargins = { top: 0, right: 0, bottom: 0, left: 0 };

function makePara(
  id: number,
  text: string,
  spacing: { before?: number; after?: number },
  lineCount: number,
  lineHeight: number,
): { block: ParagraphBlock; measure: ParagraphMeasure } {
  const block: ParagraphBlock = {
    kind: "paragraph",
    id,
    runs: [{ kind: "text", text, pmStart: 1, pmEnd: 1 + text.length }],
    attrs: { spacing },
    pmStart: 1,
    pmEnd: 1 + text.length + 1,
  };
  const lines = Array.from({ length: lineCount }, () => ({
    fromRun: 0,
    fromChar: 0,
    toRun: 0,
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

describe("paragraph split with spaceBefore", () => {
  test("multi-line paragraph splits at page boundary and fills page-end space", () => {
    // Page content area = 200 px. First paragraph fills 180 px, leaving
    // 20 px below it. Second paragraph has spaceBefore=10 and 5 lines of
    // 10 px each (50 px total). With spaceBefore consumed, 10 px remain
    // for lines — exactly one line fits on the same page; the rest
    // continue on page 2. Pre-fix the engine bumped the entire 5-line
    // paragraph to page 2, leaving the 20 px tail of page 1 empty.
    const layoutOptions: LayoutOptions = {
      pageSize: { w: 600, h: 200 },
      margins: MARGINS,
      pageGap: 0,
    };

    const first = makePara(0, "filler", { after: 0 }, 18, 10);
    const second = makePara(1, "splitMe", { before: 10 }, 5, 10);

    const blocks: FlowBlock[] = [first.block, second.block];
    const measures: Measure[] = [first.measure, second.measure];

    const layout = layoutDocument(blocks, measures, layoutOptions);

    const page1 = layout.pages[0]!;
    const page1SecondPara = page1.fragments.find(
      (f) => f.kind === "paragraph" && f.blockId === 1,
    );
    expect(page1SecondPara).toBeDefined();
    // The first fragment of paragraph 1 must land on page 1, not page 2.
    expect(layout.pages.length).toBeGreaterThanOrEqual(2);
    const page2 = layout.pages[1]!;
    const page2SecondPara = page2.fragments.find(
      (f) => f.kind === "paragraph" && f.blockId === 1,
    );
    // Continuation must exist on page 2.
    expect(page2SecondPara).toBeDefined();
  });

  test("paragraph that does not fit at all still splits a single line on the current page when forced", () => {
    // Sanity: existing `fittingLines === 0` fallback still places at
    // least one line on the current page even when nothing fits, to
    // prevent infinite advancing.
    const layoutOptions: LayoutOptions = {
      pageSize: { w: 600, h: 100 },
      margins: MARGINS,
      pageGap: 0,
    };

    const tall = makePara(0, "tall", {}, 8, 20);
    const blocks: FlowBlock[] = [tall.block];
    const measures: Measure[] = [tall.measure];

    const layout = layoutDocument(blocks, measures, layoutOptions);
    expect(layout.pages.length).toBeGreaterThanOrEqual(2);
  });
});
