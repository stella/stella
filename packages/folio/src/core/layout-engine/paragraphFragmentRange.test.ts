import { describe, expect, test } from "bun:test";

import { layoutDocument } from "./index";
import type {
  FlowBlock,
  Measure,
  ParagraphBlock,
  ParagraphFragment,
  MeasuredLine,
  LayoutOptions,
} from "./types";

function makeLine(
  fromRun: number,
  fromChar: number,
  toRun: number,
  toChar: number,
  width: number,
  lineHeight: number,
): MeasuredLine {
  return {
    fromRun,
    fromChar,
    toRun,
    toChar,
    width,
    ascent: lineHeight * 0.8,
    descent: lineHeight * 0.2,
    lineHeight,
  };
}

function makeParagraphMeasure(lines: MeasuredLine[]): Measure {
  const totalHeight = lines.reduce((sum, line) => sum + line.lineHeight, 0);
  return {
    kind: "paragraph",
    lines,
    totalHeight,
  };
}

function makeLayoutOptions(
  overrides: Partial<LayoutOptions> = {},
): LayoutOptions {
  return {
    pageSize: { w: 300, h: 80 },
    margins: { top: 20, right: 20, bottom: 20, left: 20 },
    pageGap: 20,
    ...overrides,
  };
}

function splitParagraph(): ParagraphBlock {
  return {
    kind: "paragraph",
    id: 1,
    runs: [
      { kind: "text", text: "alpha ", pmStart: 10, pmEnd: 16 },
      { kind: "text", text: "bravo ", pmStart: 16, pmEnd: 22 },
      { kind: "text", text: "charlie", pmStart: 22, pmEnd: 29 },
    ],
    pmStart: 9,
    pmEnd: 30,
  };
}

function singleRunSplitParagraph(): ParagraphBlock {
  return {
    kind: "paragraph",
    id: 1,
    runs: [
      {
        kind: "text",
        text: "alpha bravo charlie delta echo",
        pmStart: 10,
        pmEnd: 40,
      },
    ],
    pmStart: 9,
    pmEnd: 41,
  };
}

describe("paragraph fragment PM ranges", () => {
  test("split paragraph fragments carry only their visible line ranges", () => {
    const blocks: FlowBlock[] = [splitParagraph()];
    const measures: Measure[] = [
      makeParagraphMeasure([
        makeLine(0, 0, 0, 6, 80, 20),
        makeLine(1, 0, 1, 6, 80, 20),
        makeLine(2, 0, 2, 7, 80, 20),
      ]),
    ];

    const layout = layoutDocument(
      blocks,
      measures,
      makeLayoutOptions({
        pageSize: { w: 300, h: 80 },
        margins: { top: 20, right: 20, bottom: 20, left: 20 },
      }),
    );

    const fragments = layout.pages.flatMap(
      (p) => p.fragments,
    ) as ParagraphFragment[];
    expect(fragments).toHaveLength(2);
    expect(fragments[0]!.fromLine).toBe(0);
    expect(fragments[0]!.toLine).toBe(2);
    expect(fragments[0]!.pmStart).toBe(9);
    expect(fragments[0]!.pmEnd).toBe(22);
    expect(fragments[1]!.fromLine).toBe(2);
    expect(fragments[1]!.toLine).toBe(3);
    expect(fragments[1]!.pmStart).toBe(22);
    expect(fragments[1]!.pmEnd).toBe(30);
  });

  test("split paragraph fragments use line character offsets within one text run", () => {
    const blocks: FlowBlock[] = [singleRunSplitParagraph()];
    const measures: Measure[] = [
      makeParagraphMeasure([
        makeLine(0, 0, 0, 12, 80, 20),
        makeLine(0, 12, 0, 24, 80, 20),
        makeLine(0, 24, 0, 30, 80, 20),
      ]),
    ];

    const layout = layoutDocument(
      blocks,
      measures,
      makeLayoutOptions({
        pageSize: { w: 300, h: 80 },
        margins: { top: 20, right: 20, bottom: 20, left: 20 },
      }),
    );

    const fragments = layout.pages.flatMap(
      (p) => p.fragments,
    ) as ParagraphFragment[];
    expect(fragments).toHaveLength(2);
    expect(fragments[0]!.pmStart).toBe(9);
    expect(fragments[0]!.pmEnd).toBe(34);
    expect(fragments[1]!.pmStart).toBe(34);
    expect(fragments[1]!.pmEnd).toBe(41);
  });
});
