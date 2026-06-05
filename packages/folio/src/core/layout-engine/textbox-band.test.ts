/**
 * A page/margin-pinned topAndBottom text box (e.g. a "For Internal Use" banner)
 * floats to the page top instead of dropping into the flow at its anchor, and it
 * does not consume flow height (the reserved band in the measure pass — see
 * extractFloatingZones in PagedEditor — pushes body text below it). A
 * paragraph-anchored topAndBottom box keeps the in-flow handling.
 * Regression for eigenpal/docx-editor#694.
 */

import { describe, expect, test } from "bun:test";

import { layoutDocument } from "./index";
import type {
  FlowBlock,
  LayoutOptions,
  Measure,
  ParagraphBlock,
  ParagraphMeasure,
  PageMargins,
  TextBoxBlock,
  TextBoxFragment,
  TextBoxMeasure,
} from "./types";

const MARGINS: PageMargins = { top: 96, right: 96, bottom: 96, left: 96 };
const OPTIONS: LayoutOptions = {
  pageSize: { w: 816, h: 1056 },
  margins: MARGINS,
  pageGap: 20,
};

const BOX_HEIGHT = 100;

// 1 inch in EMU = 96px at 96 DPI; equals MARGINS.top, so offsets read cleanly.
const EMU_PER_INCH = 914_400;

function banner(
  relativeTo: "page" | "margin" | undefined,
  posOffset = 0,
): TextBoxBlock {
  return {
    kind: "textBox",
    id: "banner",
    width: 600,
    height: BOX_HEIGHT,
    content: [],
    wrapType: "topAndBottom",
    ...(relativeTo
      ? { position: { vertical: { relativeTo, posOffset } } }
      : {}),
  };
}

const boxMeasure: TextBoxMeasure = {
  kind: "textBox",
  width: 600,
  height: BOX_HEIGHT,
  innerMeasures: [],
};

function para(id: string): ParagraphBlock {
  return { kind: "paragraph", id, runs: [{ kind: "text", text: id }] };
}

const paraMeasure: ParagraphMeasure = {
  kind: "paragraph",
  lines: [
    {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 4,
      width: 40,
      ascent: 16,
      descent: 4,
      lineHeight: 20,
    },
  ],
  totalHeight: 20,
};

function textBoxFragments(blocks: FlowBlock[], measures: Measure[]) {
  const layout = layoutDocument(blocks, measures, OPTIONS);
  return layout.pages[0]!.fragments;
}

describe("topAndBottom band text box layout", () => {
  test("page-relative banner sits at the page top edge and does not consume flow", () => {
    const frags = textBoxFragments(
      [banner("page"), para("p")],
      [boxMeasure, paraMeasure],
    );

    const box = frags.find((f) => f.kind === "textBox") as
      | TextBoxFragment
      | undefined;
    const paragraph = frags.find((f) => f.kind === "paragraph");

    // relativeTo=page, offset 0 → the very top of the page (y=0, in the margin).
    expect(box?.y).toBe(0);
    // Flow not advanced by the banner: the paragraph still starts at the top
    // (the measure pass, not layout, reserves the band that pushes text down).
    expect(paragraph?.y).toBe(MARGINS.top);
  });

  test("margin-relative banner sits at the content top", () => {
    const frags = textBoxFragments(
      [banner("margin"), para("p")],
      [boxMeasure, paraMeasure],
    );
    const box = frags.find((f) => f.kind === "textBox") as
      | TextBoxFragment
      | undefined;
    expect(box?.y).toBe(MARGINS.top);
  });

  test("honors a non-zero vertical offset (layout matches the measure band)", () => {
    // page-relative offset of 1 inch (= MARGINS.top px) → page Y = 96.
    const frags = textBoxFragments(
      [banner("page", EMU_PER_INCH), para("p")],
      [boxMeasure, paraMeasure],
    );
    const box = frags.find((f) => f.kind === "textBox") as
      | TextBoxFragment
      | undefined;
    // y = topMargin + (emuToPixels(offset) - topMargin) = emuToPixels(offset) = 96
    expect(box?.y).toBe(96);
  });

  test("paragraph-anchored topAndBottom box stays in flow (unchanged)", () => {
    const frags = textBoxFragments(
      [banner(undefined), para("p")],
      [boxMeasure, paraMeasure],
    );

    const box = frags.find((f) => f.kind === "textBox") as
      | TextBoxFragment
      | undefined;
    const paragraph = frags.find((f) => f.kind === "paragraph");

    // In-flow box at the top, paragraph pushed below it by the box height.
    expect(box?.y).toBe(MARGINS.top);
    expect(paragraph?.y).toBe(MARGINS.top + BOX_HEIGHT);
  });

  test("band uses the section top margin, not a page's first-page margin", () => {
    // On a title page the first-page top margin can differ from the section
    // margin. The measure pass reserves the band using the section margin, so
    // the box must too — otherwise box and band desync. The box's
    // content-relative top (fragment.y - page top margin) must equal the band's
    // content top (= -section margin for a page-relative offset-0 banner).
    const FIRST_PAGE_TOP = 200;
    const layout = layoutDocument(
      [banner("page"), para("p")],
      [boxMeasure, paraMeasure],
      {
        ...OPTIONS,
        firstPageMargins: { ...MARGINS, top: FIRST_PAGE_TOP },
      },
    );
    const page = layout.pages[0]!;
    const box = page.fragments.find((f) => f.kind === "textBox") as
      | TextBoxFragment
      | undefined;
    // y = firstPageTop + (0 - sectionMarginTop) = 200 - 96 = 104, so the
    // content-relative top is 104 - 200 = -96 = -section margin (band-aligned).
    expect(box?.y).toBe(FIRST_PAGE_TOP - MARGINS.top);
    expect((box?.y ?? 0) - page.margins.top).toBe(-MARGINS.top);
  });
});
