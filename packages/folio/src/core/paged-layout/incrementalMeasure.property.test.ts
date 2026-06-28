/**
 * Property-based tests for `mergeDirtyRanges` — the dirty-range fold the layout
 * scheduler uses to coalesce a burst of edits into one pass. The invariants:
 * `null` is the identity, the merge is the tight bounding span of both inputs,
 * the span is commutative, and merging a range with itself is a no-op.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { mergeDirtyRanges, type DirtyRange } from "./incrementalMeasure";

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
