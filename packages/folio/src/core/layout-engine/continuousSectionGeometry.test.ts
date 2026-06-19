import { describe, expect, test } from "bun:test";

import { layoutDocument } from "./index";
import type {
  FlowBlock,
  ParagraphBlock,
  ParagraphMeasure,
  SectionBreakBlock,
} from "./types";

function paragraph(
  id: string,
  height: number,
): { block: ParagraphBlock; measure: ParagraphMeasure } {
  return {
    block: {
      kind: "paragraph",
      id,
      pmStart: 0,
      pmEnd: 0,
      runs: [{ kind: "text", text: id }],
      attrs: {},
    },
    measure: {
      kind: "paragraph",
      lines: [
        {
          fromRun: 0,
          fromChar: 0,
          toRun: 0,
          toChar: 0,
          width: 100,
          ascent: 10,
          descent: 3,
          lineHeight: height,
        },
      ],
      totalHeight: height,
    },
  };
}

describe("continuous section break geometry", () => {
  test("current page keeps old geometry and overflow page picks up new geometry", () => {
    const first = paragraph("a", 200);
    const sectionBreak: SectionBreakBlock = {
      kind: "sectionBreak",
      id: "sb",
      type: "continuous",
      pageSize: { w: 800, h: 1000 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
    };
    const second = paragraph("b", 200);
    const third = paragraph("c", 800);

    const blocks: FlowBlock[] = [
      first.block,
      sectionBreak,
      second.block,
      third.block,
    ];
    const measures = [
      first.measure,
      { kind: "sectionBreak" },
      second.measure,
      third.measure,
    ] as never;

    const result = layoutDocument(blocks, measures, {
      pageSize: { w: 800, h: 1000 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      finalPageSize: { w: 1200, h: 700 },
      finalMargins: { top: 50, right: 50, bottom: 50, left: 50 },
    });

    expect(result.pages[0]?.size.w).toBe(800);
    const lastPage = result.pages.at(-1);
    expect(lastPage?.size).toEqual({ w: 1200, h: 700 });
  });

  test("orientation-changing continuous break is promoted to a page break", () => {
    // Regression (eigenpal/docx-editor#841): a `continuous` break normally
    // defers the new geometry, but a break that changes page size/orientation
    // cannot share a physical sheet with the preceding section. Word and
    // LibreOffice promote it to a page break; match that.
    const first = paragraph("a", 200);
    // The break block describes the section it terminates (the portrait first
    // section, which sets the initial page geometry); the next/body section is
    // landscape via `finalPageSize`.
    const sectionBreak: SectionBreakBlock = {
      kind: "sectionBreak",
      id: "sb",
      type: "continuous",
      pageSize: { w: 800, h: 1000 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
    };
    const second = paragraph("b", 200);

    const blocks: FlowBlock[] = [first.block, sectionBreak, second.block];
    const measures = [
      first.measure,
      { kind: "sectionBreak" },
      second.measure,
    ] as never;

    const result = layoutDocument(blocks, measures, {
      pageSize: { w: 800, h: 1000 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      finalPageSize: { w: 1000, h: 800 },
      finalMargins: { top: 50, right: 50, bottom: 50, left: 50 },
    });

    // "b" must land on a NEW page that already carries the landscape geometry,
    // not share the portrait page with "a" (the pre-fix behavior).
    expect(result.pages.length).toBeGreaterThanOrEqual(2);
    const pageWithB = result.pages.find((page) =>
      page.fragments.some((f) => f.kind === "paragraph" && f.blockId === "b"),
    );
    expect(pageWithB?.size).toEqual({ w: 1000, h: 800 });
    const pageWithA = result.pages.find((page) =>
      page.fragments.some((f) => f.kind === "paragraph" && f.blockId === "a"),
    );
    expect(pageWithA?.size).toEqual({ w: 800, h: 1000 });
    // The promoted break starts the next section, so the new page carries the
    // next section's index (and thus its header/footer references).
    expect(pageWithA?.sectionIndex).toBe(0);
    expect(pageWithB?.sectionIndex).toBe(1);
  });

  test("a leading size-changing continuous break does not strand a blank page", () => {
    // With no content laid out yet there is no sheet to share, so the break
    // defers instead of materializing a blank page just to compare geometry;
    // the first content opens directly on a new-geometry page.
    const sectionBreak: SectionBreakBlock = {
      kind: "sectionBreak",
      id: "sb",
      type: "continuous",
      pageSize: { w: 800, h: 1000 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
    };
    const body = paragraph("b", 200);

    const blocks: FlowBlock[] = [sectionBreak, body.block];
    const measures = [{ kind: "sectionBreak" }, body.measure] as never;

    const result = layoutDocument(blocks, measures, {
      pageSize: { w: 800, h: 1000 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      finalPageSize: { w: 1000, h: 800 },
      finalMargins: { top: 50, right: 50, bottom: 50, left: 50 },
    });

    // Exactly one page, carrying the body — no empty leading page.
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.size).toEqual({ w: 1000, h: 800 });
    expect(result.pages[0]?.sectionIndex).toBe(1);
    expect(
      result.pages[0]?.fragments.some(
        (f) => f.kind === "paragraph" && f.blockId === "b",
      ),
    ).toBe(true);
  });

  test("a promoted continuous break reuses an already blank current page", () => {
    const first = paragraph("a", 200);
    const sectionBreak: SectionBreakBlock = {
      kind: "sectionBreak",
      id: "sb",
      type: "continuous",
      pageSize: { w: 800, h: 1000 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
    };
    const body = paragraph("b", 200);

    const blocks: FlowBlock[] = [
      first.block,
      { kind: "pageBreak", id: "pb" },
      sectionBreak,
      body.block,
    ];
    const measures = [
      first.measure,
      { kind: "pageBreak" },
      { kind: "sectionBreak" },
      body.measure,
    ] as never;

    const result = layoutDocument(blocks, measures, {
      pageSize: { w: 800, h: 1000 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      finalPageSize: { w: 1000, h: 800 },
      finalMargins: { top: 50, right: 50, bottom: 50, left: 50 },
    });

    expect(result.pages).toHaveLength(2);
    expect(
      result.pages[0]?.fragments.some(
        (f) => f.kind === "paragraph" && f.blockId === "a",
      ),
    ).toBe(true);
    expect(result.pages[1]?.size).toEqual({ w: 1000, h: 800 });
    expect(result.pages[1]?.sectionIndex).toBe(1);
    expect(
      result.pages[1]?.fragments.some(
        (f) => f.kind === "paragraph" && f.blockId === "b",
      ),
    ).toBe(true);
  });

  test("a same-size continuous break starts the next section on later pages", () => {
    const first = paragraph("a", 700);
    const sectionBreak: SectionBreakBlock = {
      kind: "sectionBreak",
      id: "sb",
      type: "continuous",
      pageSize: { w: 800, h: 1000 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
    };
    const second = paragraph("b", 150);
    const third = paragraph("c", 700);

    const blocks: FlowBlock[] = [
      first.block,
      sectionBreak,
      second.block,
      third.block,
    ];
    const measures = [
      first.measure,
      { kind: "sectionBreak" },
      second.measure,
      third.measure,
    ] as never;

    const result = layoutDocument(blocks, measures, {
      pageSize: { w: 800, h: 1000 },
      margins: { top: 50, right: 50, bottom: 50, left: 50 },
      finalPageSize: { w: 800, h: 1000 },
      finalMargins: { top: 50, right: 50, bottom: 50, left: 50 },
    });

    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.sectionIndex).toBe(0);
    expect(result.pages[1]?.sectionIndex).toBe(1);
    expect(result.pages[1]?.sectionPageNumber).toBe(1);
    expect(
      result.pages[1]?.fragments.some(
        (f) => f.kind === "paragraph" && f.blockId === "c",
      ),
    ).toBe(true);
  });
});
