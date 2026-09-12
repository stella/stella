import { describe, expect, test } from "bun:test";

import {
  facetSectionView,
  type FacetSourceBucket,
} from "@/features/case-law/facet-rail.logic";

const buckets = (count: number): FacetSourceBucket[] =>
  Array.from({ length: count }, (_, index) => ({
    value: `court-${index}`,
    label: `Court ${index}`,
    count: count - index,
  }));

describe("trimming a facet section", () => {
  test("shows every bucket when there are no more than the limit", () => {
    const view = facetSectionView({
      buckets: buckets(3),
      expanded: false,
      limit: 8,
      selectedValue: undefined,
    });

    expect(view.items).toHaveLength(3);
    expect(view.hiddenCount).toBe(0);
  });

  test("keeps the head and reports how many it left out", () => {
    const view = facetSectionView({
      buckets: buckets(20),
      expanded: false,
      limit: 8,
      selectedValue: undefined,
    });

    expect(view.items.map((item) => item.value)).toEqual([
      "court-0",
      "court-1",
      "court-2",
      "court-3",
      "court-4",
      "court-5",
      "court-6",
      "court-7",
    ]);
    expect(view.hiddenCount).toBe(12);
  });

  test("expanding shows every bucket and leaves nothing behind", () => {
    const view = facetSectionView({
      buckets: buckets(20),
      expanded: true,
      limit: 8,
      selectedValue: undefined,
    });

    expect(view.items).toHaveLength(20);
    expect(view.hiddenCount).toBe(0);
  });

  test("falls back to the value when a bucket carries no label", () => {
    const view = facetSectionView({
      buckets: [{ value: "NSCR" }],
      expanded: false,
      limit: 8,
      selectedValue: undefined,
    });

    expect(view.items.at(0)).toEqual({
      value: "NSCR",
      label: "NSCR",
      count: null,
    });
  });
});

describe("keeping the reader's own choice reachable", () => {
  test("shows a selection that ranks below the trim", () => {
    const view = facetSectionView({
      buckets: buckets(20),
      expanded: false,
      limit: 8,
      selectedValue: "court-15",
    });

    expect(view.items).toHaveLength(9);
    expect(view.items.map((item) => item.value)).toContain("court-15");
    expect(view.hiddenCount).toBe(11);
  });

  test("shows a selection the result set no longer reports, without a count", () => {
    const view = facetSectionView({
      buckets: buckets(3),
      expanded: false,
      limit: 8,
      selectedValue: "court-missing",
    });

    const selected = view.items.find((item) => item.value === "court-missing");
    expect(selected).toEqual({
      value: "court-missing",
      label: "court-missing",
      count: null,
    });
    expect(view.items).toHaveLength(4);
  });

  test("shows a selection when the page carries no facets at all", () => {
    const view = facetSectionView({
      buckets: [],
      expanded: false,
      limit: 8,
      selectedValue: "NSCR",
    });

    expect(view.items.map((item) => item.value)).toEqual(["NSCR"]);
    expect(view.hiddenCount).toBe(0);
  });

  test("does not duplicate a selection the buckets already carry", () => {
    const view = facetSectionView({
      buckets: buckets(3),
      expanded: false,
      limit: 8,
      selectedValue: "court-1",
    });

    expect(view.items.filter((item) => item.value === "court-1")).toHaveLength(
      1,
    );
  });
});
