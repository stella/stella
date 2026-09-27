import { describe, expect, test } from "bun:test";

import { extractCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { coverageMatcher } from "@/api/scripts/citation-probe-coverage";

describe("coverageMatcher", () => {
  const covered = coverageMatcher([
    "sp. zn. 7 C 12/2004",
    "sp. zn. 21 Co 90/2006",
  ]);

  test("treats slash and space spellings of one docket as covered", () => {
    expect(covered("sp. zn. 7 C/12/2004")).toBe(true);
    expect(covered("sp. zn. 21 Co/90/2006")).toBe(true);
  });

  test("treats a slash spelling with a sheet suffix as covered", () => {
    expect(covered("sp. zn. 7 C/12/2004-101 zo dňa")).toBe(true);
  });

  test("does not cover a different docket", () => {
    expect(covered("sp. zn. 7 C/13/2004")).toBe(false);
    expect(covered("sp. zn. 8 Co/90/2006")).toBe(false);
  });

  test("covers an extracted court-prefixed docket in its accepted slash spelling", () => {
    const extracted = extractCitations([
      {
        index: 0,
        text: "č. j. KSCB 26 INS 8270/2018. č. j. KSCB 26INS/8270/2018.",
      },
    ]).map((citation) => citation.citationText);
    expect(extracted).toEqual(["č. j. KSCB 26 INS 8270/2018"]);
    expect(coverageMatcher(extracted)("č. j. KSCB 26INS/8270/2018-45")).toBe(
      true,
    );
  });

  test("leaves a missing docket/year slash as a residual", () => {
    expect(
      coverageMatcher(["sp. zn. 8 C/18/2008"])("sp. zn. 8 C/18 2008"),
    ).toBe(false);
    expect(
      coverageMatcher(["sp. zn. 8 C/18/2008"])(
        "sp. zn. 8 C/18 2008 sp. zn. 8 C 18/2008",
      ),
    ).toBe(false);
  });
});
