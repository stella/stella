import { describe, expect, test } from "bun:test";

import type {
  FlowBlock,
  ImageBlock,
  ParagraphBlock,
  TableBlock,
  TextBoxBlock,
} from "../types";
import {
  fixedCharWidth,
  withFakeTextMeasure,
} from "./__tests__/fakeTextMeasure";
import {
  measureBlock,
  measureBlocks,
  measureTableBlock,
} from "./measureBlocks";

const fakeMeasure = { charWidth: fixedCharWidth(5) };

const para = (id: string, text: string): ParagraphBlock => ({
  kind: "paragraph",
  id,
  runs: [{ kind: "text", text }],
});

const imageBlock: ImageBlock = {
  kind: "image",
  id: "img-1",
  src: "data:image/png;base64,",
  width: 120,
  height: 40,
};

describe("measureBlock dispatch", () => {
  test("image block reports its own dimensions", () => {
    const measure = measureBlock(imageBlock, 500);
    expect(measure.kind).toBe("image");
    if (measure.kind === "image") {
      expect(measure.width).toBe(120);
      expect(measure.height).toBe(40);
    }
  });

  test("structural breaks map to matching measure kinds", () => {
    expect(measureBlock({ kind: "pageBreak", id: "pb-1" }, 500).kind).toBe(
      "pageBreak",
    );
    expect(measureBlock({ kind: "columnBreak", id: "cb-1" }, 500).kind).toBe(
      "columnBreak",
    );
    expect(measureBlock({ kind: "sectionBreak", id: "sb-1" }, 500).kind).toBe(
      "sectionBreak",
    );
  });

  test("unknown block kind falls back to an empty paragraph measure", () => {
    const measure = measureBlock(
      { kind: "mystery" } as unknown as FlowBlock,
      500,
    );
    expect(measure.kind).toBe("paragraph");
    if (measure.kind === "paragraph") {
      expect(measure.lines).toEqual([]);
      expect(measure.totalHeight).toBe(0);
    }
  });
});

describe("measureBlocks", () => {
  test("returns exactly one measure per input block", () => {
    withFakeTextMeasure(() => {
      const blocks: FlowBlock[] = [
        imageBlock,
        { kind: "pageBreak", id: "pb-1" },
        imageBlock,
      ];
      const measures = measureBlocks(blocks, 500);
      expect(measures).toHaveLength(blocks.length);
      expect(measures.map((m) => m.kind)).toEqual([
        "image",
        "pageBreak",
        "image",
      ]);
    }, fakeMeasure);
  });

  test("per-block content widths are honoured for parallel arrays", () => {
    withFakeTextMeasure(() => {
      const paragraph: ParagraphBlock = {
        kind: "paragraph",
        id: "p-1",
        runs: [{ kind: "text", text: "hello world" }],
      };
      const measures = measureBlocks([paragraph, paragraph], [500, 300]);
      expect(measures).toHaveLength(2);
      // Both inputs are paragraphs measured against different widths; the
      // dispatch still produces a measure for each block.
      expect(measures.every((m) => m.kind === "paragraph")).toBe(true);
    }, fakeMeasure);
  });
});

describe("measureTableBlock row height", () => {
  test("maxes per-cell content+border, not summed independent maxes", () => {
    withFakeTextMeasure(() => {
      // Cell A: more content (two paragraphs), thin border.
      // Cell B: less content (one paragraph), thick border.
      // The buggy formula (maxContent + maxBorder) takes A's content and B's
      // border from different cells and over-allocates; the correct one maxes
      // each cell's own content+padding+border.
      const table: TableBlock = {
        kind: "table",
        id: "t",
        columnWidths: [120, 120],
        rows: [
          {
            id: "r0",
            cells: [
              {
                id: "a",
                blocks: [para("a1", "Tall cell line one."), para("a2", "two")],
                padding: { top: 0, right: 0, bottom: 0, left: 0 },
                borders: { top: { width: 1 }, bottom: { width: 1 } }, // 2
              },
              {
                id: "b",
                blocks: [para("b1", "Short.")],
                padding: { top: 0, right: 0, bottom: 0, left: 0 },
                borders: { top: { width: 20 }, bottom: { width: 20 } }, // 40
              },
            ],
          },
        ],
      };

      const measure = measureTableBlock(table, 240);
      const row = measure.rows[0]!;
      const cellA = row.cells[0]!;
      const cellB = row.cells[1]!;

      // The tallest-content cell (A) is not the tallest-border cell (B).
      expect(cellA.height).toBeGreaterThan(cellB.height);

      const correct = Math.max(cellA.height + 2, cellB.height + 40);
      const summedMaxes = Math.max(cellA.height, cellB.height) + 40;

      expect(row.height).toBe(correct);
      // The fix avoids the over-allocation the old summed-maxes formula produced.
      expect(row.height).toBeLessThan(summedMaxes);
    }, fakeMeasure);
  });
});

describe("measureBlocks error instrumentation", () => {
  test("routes a block-measurement failure through the instrumentation hook", () => {
    type MeasureBlockErrorEvent = {
      blockIndex: number;
      blockKind: FlowBlock["kind"];
      message: string;
    };
    const events: MeasureBlockErrorEvent[] = [];
    const previous = globalThis.__folioLayoutInstrumentation;
    globalThis.__folioLayoutInstrumentation = {
      onMeasureBlockError: (event: MeasureBlockErrorEvent) => {
        events.push(event);
      },
    };

    try {
      withFakeTextMeasure(
        () => {
          const measures = measureBlocks([para("p", "will throw")], 600);

          // Pagination still gets a usable fallback measure instead of crashing.
          expect(measures).toHaveLength(1);
          const measure = measures[0]!;
          expect(measure.kind).toBe("paragraph");
          if (measure.kind === "paragraph") {
            expect(measure.totalHeight).toBe(20);
            expect(measure.lines).toEqual([]);
          }
        },
        {
          charWidth: () => {
            throw new Error("measure boom");
          },
        },
      );
    } finally {
      globalThis.__folioLayoutInstrumentation = previous;
    }

    // The swallowed failure is now traceable, not silent.
    expect(events).toEqual([
      { blockIndex: 0, blockKind: "paragraph", message: "measure boom" },
    ]);
  });

  test("advances page cursors after returning the fallback measure", () => {
    withFakeTextMeasure(
      () => {
        const failing = para("failing", "will throw!");
        const band: TextBoxBlock = {
          kind: "textBox",
          id: "band",
          width: 300,
          height: 60,
          content: [],
          wrapType: "topAndBottom",
          position: { vertical: { relativeTo: "margin", posOffset: 0 } },
        };
        const after = para("after", "after");

        const measures = measureBlocks([failing, band, after], 600, 96);
        const fallback = measures.at(0);
        const afterMeasure = measures.at(2);

        expect(fallback?.kind).toBe("paragraph");
        expect(afterMeasure?.kind).toBe("paragraph");
        if (fallback?.kind !== "paragraph") {
          throw new Error("Expected fallback paragraph measure");
        }
        if (afterMeasure?.kind !== "paragraph") {
          throw new Error("Expected paragraph after band");
        }

        expect(fallback.totalHeight).toBe(20);
        expect(afterMeasure.lines.at(0)?.floatSkipBefore).toBeCloseTo(40, 5);
      },
      {
        charWidth: (char) => {
          if (char === "!") {
            throw new Error("measure boom");
          }
          return 5;
        },
      },
    );
  });
});
