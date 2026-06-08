import { describe, expect, test } from "bun:test";

import type { FlowBlock, ImageBlock, ParagraphBlock } from "../types";
import {
  fixedCharWidth,
  withFakeTextMeasure,
} from "./__tests__/fakeTextMeasure";
import { measureBlock, measureBlocks } from "./measureBlocks";

const fakeMeasure = { charWidth: fixedCharWidth(5) };

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
