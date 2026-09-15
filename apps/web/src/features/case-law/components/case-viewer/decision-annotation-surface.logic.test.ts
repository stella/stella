import { describe, expect, test } from "bun:test";

import { annotationsForMarksFilter } from "@/features/case-law/components/case-viewer/decision-annotation-surface.logic";

const marks = [
  { id: "own", mine: true },
  { id: "colleague", mine: false },
];

describe("marks filter", () => {
  test("keeps every mark, the reader's own, or none of them", () => {
    expect(annotationsForMarksFilter(marks, "all")).toEqual(marks);
    expect(
      annotationsForMarksFilter(marks, "mine").map(({ id }) => id),
    ).toEqual(["own"]);
    expect(annotationsForMarksFilter(marks, "none")).toEqual([]);
  });

  test("a filtered view never reorders what it keeps", () => {
    const shared = [
      { id: "a", mine: true },
      { id: "b", mine: false },
      { id: "c", mine: true },
    ];

    expect(
      annotationsForMarksFilter(shared, "mine").map(({ id }) => id),
    ).toEqual(["a", "c"]);
  });
});
