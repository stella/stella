/**
 * Property-based tests for `mergeDirtyRanges` — the dirty-range fold the layout
 * scheduler uses to coalesce a burst of edits into one pass. The invariants:
 * `null` is the identity, the merge is the tight bounding span of both inputs,
 * the span is commutative, and merging a range with itself is a no-op.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import type {
  FlowBlock,
  Measure,
  ParagraphBlock,
} from "../layout-engine/types";
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

const range = fc
  .record({ from: fc.nat(1000), len: fc.nat(1000) })
  .map(({ from, len }): DirtyRange => ({ from, to: from + len }));

const nullableRange = fc.option(range, { nil: null });

describe("mergeDirtyRanges (properties)", () => {
  test("null is the identity element on both sides", () => {
    fc.assert(
      fc.property(nullableRange, (r) => {
        expect(mergeDirtyRanges(null, r)).toEqual(r);
        expect(mergeDirtyRanges(r, null)).toEqual(r);
      }),
      propertyConfig(),
    );
  });

  test("the merge is the tight bounding span covering both inputs", () => {
    fc.assert(
      fc.property(range, range, (a, b) => {
        const merged = mergeDirtyRanges(a, b);
        expect(merged).not.toBeNull();
        if (!merged) {
          return;
        }
        // Covers both inputs...
        expect(merged.from).toBeLessThanOrEqual(Math.min(a.from, b.from));
        expect(merged.to).toBeGreaterThanOrEqual(Math.max(a.to, b.to));
        // ...and no wider than necessary.
        expect(merged.from).toBe(Math.min(a.from, b.from));
        expect(merged.to).toBe(Math.max(a.to, b.to));
      }),
      propertyConfig(),
    );
  });

  test("the merged span is commutative, including with nulls", () => {
    fc.assert(
      fc.property(nullableRange, nullableRange, (a, b) => {
        expect(mergeDirtyRanges(a, b)).toEqual(mergeDirtyRanges(b, a));
      }),
      propertyConfig(),
    );
  });

  test("merging a range with itself preserves its span", () => {
    fc.assert(
      fc.property(range, (a) => {
        expect(mergeDirtyRanges(a, a)).toEqual({ from: a.from, to: a.to });
      }),
      propertyConfig(),
    );
  });

  test("folding a sequence yields the min-from / max-to of all ranges", () => {
    fc.assert(
      fc.property(fc.array(nullableRange), (ranges) => {
        let folded: DirtyRange | null = null;
        for (const r of ranges) {
          folded = mergeDirtyRanges(folded, r);
        }
        const present = ranges.filter((r): r is DirtyRange => r !== null);
        if (present.length === 0) {
          expect(folded).toBeNull();
          return;
        }
        expect(folded).toEqual({
          from: Math.min(...present.map((r) => r.from)),
          to: Math.max(...present.map((r) => r.to)),
        });
      }),
      propertyConfig(),
    );
  });
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
      propertyConfig({ numRuns: 1000 }),
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
      propertyConfig({ numRuns: 1000 }),
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
          for (const dirtyRange of ranges) {
            merged = mergeDirtyRanges(merged, normalizeDirtyRange(dirtyRange));
          }

          expect(merged).not.toBeNull();
          if (!merged) {
            return;
          }

          for (const dirtyRange of ranges.map(normalizeDirtyRange)) {
            expect(merged.from).toBeLessThanOrEqual(dirtyRange.from);
            expect(merged.to).toBeGreaterThanOrEqual(dirtyRange.to);
          }
        },
      ),
      propertyConfig({ numRuns: 500 }),
    );
  });
});

function normalizeDirtyRange(dirtyRange: DirtyRange): DirtyRange {
  return {
    from: Math.min(dirtyRange.from, dirtyRange.to),
    to: Math.max(dirtyRange.from, dirtyRange.to),
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
