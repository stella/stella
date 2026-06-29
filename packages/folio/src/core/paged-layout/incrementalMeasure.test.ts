import { describe, expect, test } from "bun:test";

import type {
  FlowBlock,
  Measure,
  ParagraphBlock,
} from "../layout-engine/types";
import { tryBuildIncrementalMeasures } from "./incrementalMeasure";

type ParagraphSpec = {
  text: string;
};

describe("incremental paragraph measurement", () => {
  test("bails out for unsupported layout features", () => {
    const previousBlocks = makeParagraphBlocks([{ text: "a" }, { text: "b" }]);
    const nextBlocks: FlowBlock[] = [
      previousBlocks[0]!,
      {
        ...previousBlocks[1]!,
        attrs: {
          listMarker: "1.",
        },
      },
    ];
    const widths = [624, 624];

    const result = tryBuildIncrementalMeasures({
      previousBlocks,
      previousMeasures: previousBlocks.map(fakeMeasureBlock),
      previousBlockWidths: widths,
      nextBlocks,
      nextBlockWidths: widths,
      dirtyRange: { from: 0, to: 10 },
      measureBlock: fakeMeasureBlock,
    });

    expect(result).toBeNull();
  });

  test("bails out when a paragraph contains live fields", () => {
    const previousBlocks = makeParagraphBlocks([{ text: "See page " }]);
    const nextBlock = previousBlocks[0];
    if (!nextBlock) {
      throw new Error("Expected test block");
    }
    const nextBlocks: FlowBlock[] = [
      {
        ...nextBlock,
        runs: [
          ...nextBlock.runs,
          {
            kind: "field",
            fieldType: "OTHER",
            instruction: "PAGEREF _target",
            fallback: "1",
            pmStart: nextBlock.pmEnd - 1,
            pmEnd: nextBlock.pmEnd,
          },
        ],
      },
    ];
    const widths = [624];

    const result = tryBuildIncrementalMeasures({
      previousBlocks,
      previousMeasures: previousBlocks.map(fakeMeasureBlock),
      previousBlockWidths: widths,
      nextBlocks,
      nextBlockWidths: widths,
      dirtyRange: { from: 0, to: 10 },
      measureBlock: fakeMeasureBlock,
    });

    expect(result).toBeNull();
  });
});

function makeParagraphBlocks(specs: ParagraphSpec[]): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  let pmStart = 0;

  for (let i = 0; i < specs.length; i += 1) {
    const text = specs[i]?.text ?? "";
    const pmEnd = pmStart + text.length + 2;
    blocks.push({
      kind: "paragraph",
      id: `block-${i}`,
      runs: [
        {
          kind: "text",
          text,
          pmStart: pmStart + 1,
          pmEnd: pmStart + 1 + text.length,
        },
      ],
      pmStart,
      pmEnd,
    });
    pmStart = pmEnd + 1;
  }

  return blocks;
}

function fakeMeasureBlock(block: FlowBlock): Measure {
  if (block.kind !== "paragraph") {
    throw new Error("Expected paragraph block");
  }

  const textLength = block.runs.reduce(
    (sum, run) => sum + (run.kind === "text" ? run.text.length : 1),
    0,
  );
  const lineCount = Math.max(1, Math.ceil(textLength / 60));

  return {
    kind: "paragraph",
    lines: Array.from({ length: lineCount }, (_, index) => ({
      ascent: 12,
      descent: 4,
      fromChar: index * 60,
      fromRun: 0,
      lineHeight: 16,
      toChar: Math.min((index + 1) * 60, textLength),
      toRun: 0,
      width: Math.min(624, textLength * 7),
    })),
    totalHeight: lineCount * 16,
  };
}
