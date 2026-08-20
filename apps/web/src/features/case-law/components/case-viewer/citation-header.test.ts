import { describe, expect, test } from "bun:test";

import { CASE_LAW_CITATION_TIMELINE_MAX_YEARS } from "@stll/api-contract";

import { citationStripFromYear } from "@/features/case-law/components/case-viewer/citation-header";

describe("citationStripFromYear", () => {
  const currentYear = 2026;
  const spanStart = currentYear - (CASE_LAW_CITATION_TIMELINE_MAX_YEARS - 1);

  test("starts at the earlier of decision year and first citing year", () => {
    expect(
      citationStripFromYear({
        currentYear,
        decidedYear: 2017,
        firstCitedYear: 2018,
      }),
    ).toBe(2017);
    expect(
      citationStripFromYear({
        currentYear,
        decidedYear: null,
        firstCitedYear: 2018,
      }),
    ).toBe(2018);
    expect(
      citationStripFromYear({
        currentYear,
        decidedYear: null,
        firstCitedYear: null,
      }),
    ).toBe(currentYear);
  });

  test("never starts before the span the summary covers", () => {
    expect(1923).toBeLessThan(spanStart);
    expect(
      citationStripFromYear({
        currentYear,
        decidedYear: 1923,
        firstCitedYear: 1930,
      }),
    ).toBe(spanStart);
  });
});
