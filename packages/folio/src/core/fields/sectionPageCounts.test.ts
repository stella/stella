import { describe, expect, test } from "bun:test";

import type { Page, PageMargins } from "../layout-engine/types";
import { buildSectionPageCounts } from "./sectionPageCounts";

const MARGINS: PageMargins = { top: 96, right: 96, bottom: 96, left: 96 };

const page = (number: number, sectionIndex?: number): Page => ({
  number,
  fragments: [],
  margins: MARGINS,
  size: { w: 816, h: 1056 },
  ...(sectionIndex === undefined ? {} : { sectionIndex }),
});

describe("buildSectionPageCounts", () => {
  test("counts pages per section index", () => {
    const counts = buildSectionPageCounts([
      page(1, 0),
      page(2, 0),
      page(3, 1),
      page(4, 1),
      page(5, 1),
    ]);
    expect(counts.get(0)).toBe(2);
    expect(counts.get(1)).toBe(3);
  });

  test("pages without a section index fall into section 0", () => {
    const counts = buildSectionPageCounts([page(1), page(2)]);
    expect(counts.get(0)).toBe(2);
  });
});
