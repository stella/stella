import { describe, expect, test } from "bun:test";

import { extractCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { citationCoverage } from "@/api/scripts/citation-probe-coverage";

// One decision citing the same docket twice, first with slashes, then with a
// space between registry and number.
const TEXT =
  "Okresný súd rozhodol rozsudkom sp. zn. 8 C/18/2008 zo dňa 1. 2. 2009. " +
  "Proti rozsudku sp. zn. 8 C 18/2008 podal žalovaný odvolanie.";

const extractedTexts = (text: string): string[] =>
  extractCitations([{ index: 0, text }]).map((c) => c.citationText);

describe("citation probe coverage", () => {
  test("a docket spelled with spaces is covered by its slash spelling", () => {
    const extracted = extractedTexts(TEXT);
    // The extractor keeps only the first spelling, so the second one reaches
    // the coverage check with a different separator.
    expect(extracted).toEqual(["sp. zn. 8 C/18/2008"]);

    const covered = citationCoverage(extracted);
    expect(covered("sp. zn. 8 C 18/2008 podal žalovaný odvolanie.")).toBe(true);
    expect(covered("sp. zn. 8 C/18/2008 zo dňa 1. 2. 2009.")).toBe(true);
  });

  test("a docket spelled with slashes is covered by its space spelling", () => {
    const covered = citationCoverage(["sp. zn. 8 C 18/2008"]);
    expect(covered("č. j. 8 C/18/2008-45")).toBe(true);
  });

  test("a different docket number stays uncovered", () => {
    const covered = citationCoverage(extractedTexts(TEXT));
    expect(covered("sp. zn. 8 C 19/2008")).toBe(false);
    expect(covered("sp. zn. 8 Co/18/2008")).toBe(false);
  });

  test("a missing docket/year slash stays visible as a residual", () => {
    const covered = citationCoverage(extractedTexts(TEXT));
    expect(covered("sp. zn. 8 C/18 2008")).toBe(false);
    expect(covered("sp. zn. 8 C/18 2008 sp. zn. 8 C 18/2008")).toBe(false);
  });

  test("covers every extracted spelling of a court-prefixed docket", () => {
    const extracted = extractedTexts(
      "č. j. KSCB 26 INS 8270/2018. č. j. KSCB 26INS/8270/2018.",
    );
    expect(extracted).toEqual(["č. j. KSCB 26 INS 8270/2018"]);
    const covered = citationCoverage(extracted);
    expect(covered("č. j. KSCB 26INS/8270/2018-45")).toBe(true);
  });

  test("a prefixed candidate is covered by its unprefixed extraction", () => {
    const extracted = extractedTexts(
      "podle nálezu sp. zn. II. ÚS 123/45 ze dne",
    );
    expect(extracted).toEqual(["II. ÚS 123/45"]);
    const covered = citationCoverage(extracted);
    expect(covered("sp. zn. II. ÚS 123/45")).toBe(true);
    expect(covered("sp. zn. II. ÚS 123/46")).toBe(false);
  });
});
