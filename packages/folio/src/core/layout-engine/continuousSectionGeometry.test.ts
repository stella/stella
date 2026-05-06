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
});
