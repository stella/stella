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
  ImageBlock,
  ImageMeasure,
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

function withHorizontal(
  block: TextBoxBlock,
  horizontal: NonNullable<NonNullable<TextBoxBlock["position"]>["horizontal"]>,
): TextBoxBlock {
  return { ...block, position: { ...block.position, horizontal } };
}

function verticalBanner(
  vertical: NonNullable<NonNullable<TextBoxBlock["position"]>["vertical"]>,
): TextBoxBlock {
  return { ...banner(undefined), position: { vertical } };
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

  test("paragraph layout reserves measured float-skip height", () => {
    const baseLine = paraMeasure.lines[0]!;
    const skippedMeasure: ParagraphMeasure = {
      kind: "paragraph",
      lines: [{ ...baseLine, floatSkipBefore: BOX_HEIGHT }],
      totalHeight: BOX_HEIGHT + baseLine.lineHeight,
    };

    const layout = layoutDocument(
      [para("p1"), para("p2")],
      [skippedMeasure, paraMeasure],
      OPTIONS,
    );
    const first = layout.pages[0]?.fragments[0];
    const second = layout.pages[0]?.fragments[1];

    expect(first?.kind).toBe("paragraph");
    expect(first?.height).toBe(BOX_HEIGHT + baseLine.lineHeight);
    expect(second?.kind).toBe("paragraph");
    expect(second?.y).toBe(MARGINS.top + BOX_HEIGHT + baseLine.lineHeight);
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

  test("centers a page-aligned banner within the page frame", () => {
    const frags = textBoxFragments(
      [verticalBanner({ relativeTo: "page", align: "center" }), para("p")],
      [boxMeasure, paraMeasure],
    );
    const box = frags.find((f) => f.kind === "textBox") as
      | TextBoxFragment
      | undefined;
    // page frame [0, 1056], 100px box → (1056 - 100) / 2 = 478.
    expect(box?.y).toBe(478);
  });

  test("pins a bottom-aligned margin banner to the content bottom", () => {
    const frags = textBoxFragments(
      [verticalBanner({ relativeTo: "margin", align: "bottom" }), para("p")],
      [boxMeasure, paraMeasure],
    );
    const box = frags.find((f) => f.kind === "textBox") as
      | TextBoxFragment
      | undefined;
    // content frame [96, 960], 100px box → 960 - 100 = 860.
    expect(box?.y).toBe(860);
  });

  test("places a bottomMargin banner in the bottom margin strip", () => {
    const frags = textBoxFragments(
      [verticalBanner({ relativeTo: "bottomMargin" }), para("p")],
      [boxMeasure, paraMeasure],
    );
    const box = frags.find((f) => f.kind === "textBox") as
      | TextBoxFragment
      | undefined;
    // bottom margin strip [960, 1056] top → 960.
    expect(box?.y).toBe(960);
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

  test("band uses the current section top margin after a section break", () => {
    const nextSectionMargins: PageMargins = { ...MARGINS, top: 144 };
    const sectionBreak: FlowBlock = {
      kind: "sectionBreak",
      id: "section-one",
      type: "nextPage",
      pageSize: OPTIONS.pageSize,
      margins: MARGINS,
    };
    const layout = layoutDocument(
      [sectionBreak, banner("page"), para("p")],
      [{ kind: "sectionBreak" }, boxMeasure, paraMeasure],
      {
        ...OPTIONS,
        finalMargins: nextSectionMargins,
      },
    );
    const page = layout.pages.find((candidate) =>
      candidate.fragments.some((fragment) => fragment.kind === "textBox"),
    );
    if (!page) {
      throw new Error("Expected a page with the section text box");
    }
    const box = page.fragments.find((f) => f.kind === "textBox") as
      | TextBoxFragment
      | undefined;

    expect(page.margins.top).toBe(nextSectionMargins.top);
    expect(box?.y).toBe(0);
  });

  test("defaults to the content left edge without a horizontal anchor", () => {
    const frags = textBoxFragments(
      [banner("page"), para("p")],
      [boxMeasure, paraMeasure],
    );
    const box = frags.find((f) => f.kind === "textBox") as
      | TextBoxFragment
      | undefined;
    // Unchanged behavior: pinned to the column/content left edge.
    expect(box?.x).toBe(MARGINS.left);
  });

  test("honors a margin-relative center horizontal anchor", () => {
    const frags = textBoxFragments(
      [
        withHorizontal(banner("page"), {
          relativeTo: "margin",
          align: "center",
        }),
      ],
      [boxMeasure],
    );
    const box = frags.find((f) => f.kind === "textBox") as
      | TextBoxFragment
      | undefined;
    // content box 624px, 600px banner → 96 + (624 - 600) / 2 = 108.
    expect(box?.x).toBe(108);
  });

  test("honors a page-relative right horizontal anchor", () => {
    const frags = textBoxFragments(
      [withHorizontal(banner("page"), { relativeTo: "page", align: "right" })],
      [boxMeasure],
    );
    const box = frags.find((f) => f.kind === "textBox") as
      | TextBoxFragment
      | undefined;
    // page 816px, 600px banner → 816 - 600 = 216.
    expect(box?.x).toBe(216);
  });

  test("honors a page-relative horizontal posOffset", () => {
    const frags = textBoxFragments(
      [
        withHorizontal(banner("page"), {
          relativeTo: "page",
          posOffset: EMU_PER_INCH,
        }),
      ],
      [boxMeasure],
    );
    const box = frags.find((f) => f.kind === "textBox") as
      | TextBoxFragment
      | undefined;
    // page frame left 0 + 96px offset = 96.
    expect(box?.x).toBe(96);
  });

  test("a non-paragraph block reserves its measured band skip before layout", () => {
    // The measure pass records `bandSkipBefore` on tables/images that follow a
    // page band; layout applies it as leading space so the block lands below the
    // band. eigenpal #694.
    const imageBlock: ImageBlock = {
      kind: "image",
      id: "img",
      src: "data:,",
      width: 80,
      height: 40,
    };
    const imageMeasure: ImageMeasure = {
      kind: "image",
      width: 80,
      height: 40,
      bandSkipBefore: BOX_HEIGHT,
    };

    const layout = layoutDocument([imageBlock], [imageMeasure], OPTIONS);
    const imgFrag = layout.pages[0]?.fragments.find((f) => f.kind === "image");

    // Content top is MARGINS.top; the band skip pushes the image down by it.
    expect(imgFrag?.y).toBe(MARGINS.top + BOX_HEIGHT);
  });
});
