import { describe, expect, test } from "bun:test";

import { splitCaseReference } from "@/api/handlers/case-law/case-number";

describe("splitCaseReference", () => {
  test("takes the sheet number off a Czech docket", () => {
    expect(splitCaseReference("11 C 153/2025-28")).toEqual({
      caseNumber: "11 C 153/2025",
      sheetNumber: "28",
    });
  });

  test("takes the sheet number off however the court spaces the separator", () => {
    for (const reference of [
      "10 A 46/2015-66",
      "10 A 46/2015 - 66",
      "10 A 46/2015 -66",
      "10 A 46/2015- 66",
    ]) {
      expect(splitCaseReference(reference)).toEqual({
        caseNumber: "10 A 46/2015",
        sheetNumber: "66",
      });
    }
  });

  test("keeps a dash inside the docket itself", () => {
    expect(splitCaseReference("C-123/20-5")).toEqual({
      caseNumber: "C-123/20",
      sheetNumber: "5",
    });
    expect(splitCaseReference("C-123/20 - 5")).toEqual({
      caseNumber: "C-123/20",
      sheetNumber: "5",
    });
  });

  test("leaves references that carry no sheet number", () => {
    for (const reference of [
      "0T/42/2019",
      "II AKa 198/23",
      "28 Cdo 5171/2008",
      "C-123/20",
      "ECLI:CZ:NS:2009:28.CDO.5171.2008.1",
    ]) {
      expect(splitCaseReference(reference)).toEqual({
        caseNumber: reference,
        sheetNumber: undefined,
      });
    }
  });

  /**
   * The property that matters downstream: a citation names the docket, so
   * every reference must reduce to the same docket whatever sheet it carries.
   */
  test("references differing only by sheet share one docket", () => {
    const sheets = ["-1", "-28", " - 28", " -145", "- 145", ""];
    const dockets = new Set(
      sheets.map(
        (sheet) => splitCaseReference(`11 C 153/2025${sheet}`).caseNumber,
      ),
    );

    expect([...dockets]).toEqual(["11 C 153/2025"]);
  });

  test("is idempotent", () => {
    for (const reference of ["11 C 153/2025-28", "11 C 153/2025 - 28"]) {
      const once = splitCaseReference(reference).caseNumber;

      expect(splitCaseReference(once).caseNumber).toBe(once);
    }
  });

  /**
   * Adapters store the reference exactly as published beside the split halves,
   * so the split has to be a read of that string and nothing else: the docket
   * opens it, the sheet closes it, and only the separator lies between them.
   * A docket that kept the spacing would break that read.
   */
  test("splits a published reference into its own two ends", () => {
    for (const published of [
      "11 C 153/2025-28",
      "10 A 46/2015 - 66",
      "10 A 46/2015 -66",
    ]) {
      const { caseNumber, sheetNumber } = splitCaseReference(published);

      expect(published.startsWith(caseNumber)).toBe(true);
      expect(published.endsWith(sheetNumber ?? "")).toBe(true);
      expect(caseNumber.trim()).toBe(caseNumber);
      expect(
        published.slice(
          caseNumber.length,
          published.length - (sheetNumber ?? "").length,
        ),
      ).toMatch(/^ ?- ?$/u);
    }
  });
});
