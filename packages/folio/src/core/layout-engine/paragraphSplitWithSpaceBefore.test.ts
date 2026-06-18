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

  test("first fragment reserves collapsed trailing spacing so a page-end line still fits", () => {
    // Regression (eigenpal/docx-editor#782): the line-fit loop reserved only
    // this paragraph's own `spaceBefore`, while `addFragment` reserves
    // `max(spaceBefore, trailingSpacing)` — the spacing collapsed with the
    // previous block's `spaceAfter`. When the previous block's trailing
    // spacing exceeded this paragraph's `spaceBefore`, the loop over-counted
    // the lines that fit; `addFragment` then refused the oversized fragment
    // and bumped the WHOLE first fragment to the next page, stranding the
    // paragraph below a page-end gap.
    const layoutOptions: LayoutOptions = {
      pageSize: { w: 600, h: 200 },
      margins: MARGINS,
      pageGap: 0,
    };

    // First paragraph: 170 px tall with 15 px space-after. That trailing
    // spacing collapses into the next paragraph's (zero) space-before,
    // leaving 30 px at the bottom of page 1.
    const first = makePara(0, "filler", { after: 15 }, 17, 10);
    // Second paragraph: no own space-before, 5 lines of 10 px.
    const second = makePara(1, "splitMe", { before: 0 }, 5, 10);

    const layout = layoutDocument(
      [first.block, second.block],
      [first.measure, second.measure],
      layoutOptions,
    );

    // With the collapsed 15 px reserved, exactly one line of the second
    // paragraph fits the 30 px page-end (15 spacing + 10 line + the line is
    // forced once the remaining lines no longer fit), so its first fragment
    // lands on page 1 instead of jumping wholesale to page 2.
    const page1 = layout.pages[0]!;
    const page1Second = page1.fragments.find(
      (f) => f.kind === "paragraph" && f.blockId === 1,
    );
    expect(page1Second).toBeDefined();

    expect(layout.pages.length).toBeGreaterThanOrEqual(2);
    const page2Second = layout.pages[1]!.fragments.find(
      (f) => f.kind === "paragraph" && f.blockId === 1,
    );
    expect(page2Second).toBeDefined();
  });

  test("a paragraph blocked only by shed-able trailing spacing moves whole to the next page", () => {
    // Regression (eigenpal/docx-editor#782 follow-up): when the previous block's
    // collapsed trailing spacing alone exceeds the page-end space, the next
    // paragraph cannot start there — but it sheds that spacing on the next page
    // and fits whole. The fit loop must advance first; otherwise the
    // `fittingLines === 0` fallback strands its first line and `addFragment`
    // carries it to the next page alone, splitting the paragraph into two
    // same-page fragments (an artificial intra-page continuation).
    const layoutOptions: LayoutOptions = {
      pageSize: { w: 600, h: 200 },
      margins: MARGINS,
      pageGap: 0,
    };

    // First paragraph fills 160 px with 50 px space-after, leaving 40 px on
    // page 1. The 50 px trailing spacing alone overflows that 40 px.
    const first = makePara(0, "filler", { after: 50 }, 16, 10);
    // Second paragraph: no own space-before, 4 lines of 10 px (40 px) — fits
    // whole on a fresh page.
    const second = makePara(1, "wholePara", { before: 0 }, 4, 10);

    const layout = layoutDocument(
      [first.block, second.block],
      [first.measure, second.measure],
      layoutOptions,
    );

    const block1Fragments = layout.pages.flatMap((page) =>
      page.fragments.filter((f) => f.kind === "paragraph" && f.blockId === 1),
    );
    expect(block1Fragments).toHaveLength(1);
    const fragment = block1Fragments[0]!;
    if (fragment.kind === "paragraph") {
      expect(fragment.fromLine).toBe(0);
      expect(fragment.toLine).toBe(4);
      expect(fragment.continuesOnNext).toBeUndefined();
      expect(fragment.continuesFromPrev).toBeUndefined();
    }
    // Nothing from block 1 should land on page 1.
    const page1Block1 = layout.pages[0]!.fragments.find(
      (f) => f.kind === "paragraph" && f.blockId === 1,
    );
    expect(page1Block1).toBeUndefined();
  });

  test("trailing spacing larger than a page at a fresh page top terminates (no infinite loop)", () => {
    // Regression (eigenpal/docx-editor#782 follow-up): a zero-height block at
    // the top of a page can leave a `trailingSpacing` larger than a whole
    // column. At a fresh page top `ensureFits` will not advance oversized
    // content, so the advance-first branch must NOT `continue` there — it
    // would re-enter forever. The `cursorY !== topMargin` guard prevents it;
    // the fallback places the line instead.
    const layoutOptions: LayoutOptions = {
      pageSize: { w: 600, h: 200 },
      margins: MARGINS,
      pageGap: 0,
    };

    // Zero-height first paragraph (single 0px line) with 250px space-after —
    // larger than the 200px page — leaves the cursor at the page top.
    const zeroHeight = makePara(0, "x", { after: 250 }, 1, 0);
    const follower = makePara(1, "y", { before: 0 }, 4, 10);

    const layout = layoutDocument(
      [zeroHeight.block, follower.block],
      [zeroHeight.measure, follower.measure],
      layoutOptions,
    );

    // It must terminate and place block 1 somewhere (the assertion only
    // matters because the pre-fix engine never returned).
    const block1 = layout.pages.flatMap((page) =>
      page.fragments.filter((f) => f.kind === "paragraph" && f.blockId === 1),
    );
    expect(block1.length).toBeGreaterThanOrEqual(1);
  }, 2000);

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
