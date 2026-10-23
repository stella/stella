import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { READER_ANNOTATION_MAX_SPANS } from "@stll/api-contract/legal-reader-annotations";
import { propertyConfig } from "@stll/property-testing";

import { pageLengthKeepingMarksWhole } from "@/api/lib/legal-search/reader-annotations/page.logic";

describe("pageLengthKeepingMarksWhole", () => {
  test("no page boundary falls between two rows of one mark", () => {
    // A listing: marks of 1..MAX_SPANS rows, each multi-row mark one group.
    const marks = fc.array(
      fc.integer({ min: 1, max: READER_ANNOTATION_MAX_SPANS }),
      { minLength: 1, maxLength: 30 },
    );
    fc.assert(
      fc.property(marks, fc.integer({ min: 1, max: 60 }), (sizes, limit) => {
        const rows = sizes.flatMap((size, mark) =>
          Array.from({ length: size }, () => ({
            groupId: size > 1 ? `group-${String(mark)}` : null,
          })),
        );
        const length = pageLengthKeepingMarksWhole(rows, limit);
        const last = rows.at(length - 1)?.groupId ?? null;
        const next = rows.at(length)?.groupId ?? null;
        return (
          length >= limit &&
          length <= limit + READER_ANNOTATION_MAX_SPANS &&
          (last === null || last !== next)
        );
      }),
      propertyConfig(),
    );
  });

  test("a page of whole marks keeps its limit", () => {
    expect(
      pageLengthKeepingMarksWhole(
        [{ groupId: null }, { groupId: "g" }, { groupId: "g" }],
        1,
      ),
    ).toBe(1);
  });

  test("extends only through the mark crossing the requested boundary", () => {
    const rows = [
      { groupId: null },
      { groupId: "first" },
      { groupId: "first" },
      { groupId: "second" },
      { groupId: "second" },
    ];

    expect(pageLengthKeepingMarksWhole(rows, 2)).toBe(3);
    expect(pageLengthKeepingMarksWhole(rows, 3)).toBe(3);
    expect(pageLengthKeepingMarksWhole(rows, 4)).toBe(5);
    expect(pageLengthKeepingMarksWhole(rows, 5)).toBe(5);
  });
});
