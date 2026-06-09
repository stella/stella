import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type {
  FlowBlock,
  Measure,
  ParagraphBlock,
} from "../core/layout-engine/types";
import {
  findDirtyBlockIndexes,
  mergeDirtyRanges,
  tryBuildIncrementalMeasures,
} from "./incrementalMeasure";
import type { DirtyRange } from "./incrementalMeasure";

type ParagraphSpec = {
  text: string;
};

const paragraphSpec = fc.record({
  text: fc.string({ minLength: 0, maxLength: 120 }),
});

describe("incremental paragraph measurement", () => {
  test("remeasures only blocks touched by arbitrary edit ranges", () => {
    fc.assert(
      fc.property(
        fc.array(paragraphSpec, { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.integer({ min: 0, max: 20_000 }),
        (paragraphs, firstPosition, secondPosition) => {
          const previousBlocks = makeParagraphBlocks(paragraphs);
          const nextBlocks = previousBlocks.map((block) => ({ ...block }));
          const previousMeasures = previousBlocks.map(fakeMeasureBlock);
          const fullNextMeasures = nextBlocks.map(fakeMeasureBlock);
          const widths = Array.from({ length: nextBlocks.length }, () => 624);
          const dirtyRange = normalizeDirtyRange({
            from: firstPosition,
            to: secondPosition,
          });
          const expectedDirtyIndexes = findDirtyBlockIndexes(
            nextBlocks,
            dirtyRange,
          );

          const result = tryBuildIncrementalMeasures({
            previousBlocks,
            previousMeasures,
            previousBlockWidths: widths,
            nextBlocks,
            nextBlockWidths: widths,
            dirtyRange,
            measureBlock: fakeMeasureBlock,
          });

          if (expectedDirtyIndexes.length === 0) {
            expect(result).toBeNull();
            return;
          }

          expect(result?.measuredBlockIndexes).toEqual(expectedDirtyIndexes);
          expect(result?.measures).toEqual(fullNextMeasures);
        },
      ),
      { numRuns: 1000 },
    );
  });

  test("matches full measurement after a localized paragraph edit shifts later positions", () => {
    fc.assert(
      fc.property(
        fc.array(paragraphSpec, { minLength: 2, maxLength: 200 }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.string({ minLength: 0, maxLength: 160 }),
        (paragraphs, dirtyIndexSeed, replacementText) => {
          const previousBlocks = makeParagraphBlocks(paragraphs);
          const dirtyIndex = dirtyIndexSeed % paragraphs.length;
          const nextParagraphs = paragraphs.map((paragraph, index) =>
            index === dirtyIndex ? { text: replacementText } : paragraph,
          );
          const nextBlocks = makeParagraphBlocks(nextParagraphs);
          const previousMeasures = previousBlocks.map(fakeMeasureBlock);
          const fullNextMeasures = nextBlocks.map(fakeMeasureBlock);
          const widths = Array.from({ length: nextBlocks.length }, () => 624);
          const dirtyBlock = nextBlocks[dirtyIndex];
          if (!dirtyBlock) {
            return;
          }

          const result = tryBuildIncrementalMeasures({
            previousBlocks,
            previousMeasures,
            previousBlockWidths: widths,
            nextBlocks,
            nextBlockWidths: widths,
            dirtyRange: {
              from: dirtyBlock.pmStart,
              to: dirtyBlock.pmEnd,
            },
            measureBlock: fakeMeasureBlock,
          });

          expect(result?.measuredBlockIndexes).toEqual([dirtyIndex]);
          expect(result?.measures).toEqual(fullNextMeasures);
        },
      ),
      { numRuns: 1000 },
    );
  });

  test("coalesces arbitrary edit ranges without shrinking invalidation", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            from: fc.integer({ min: 0, max: 50_000 }),
            to: fc.integer({ min: 0, max: 50_000 }),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        (ranges) => {
          let merged: DirtyRange | null = null;
          for (const range of ranges) {
            merged = mergeDirtyRanges(merged, normalizeDirtyRange(range));
          }

          expect(merged).not.toBeNull();
          if (!merged) {
            return;
          }

          for (const range of ranges.map(normalizeDirtyRange)) {
            expect(merged.from).toBeLessThanOrEqual(range.from);
            expect(merged.to).toBeGreaterThanOrEqual(range.to);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

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

function normalizeDirtyRange(range: DirtyRange): DirtyRange {
  return {
    from: Math.min(range.from, range.to),
    to: Math.max(range.from, range.to),
  };
}

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
