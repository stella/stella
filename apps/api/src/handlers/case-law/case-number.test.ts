import { describe, expect, test } from "bun:test";

import { splitCaseReference } from "@/api/handlers/case-law/case-number";

describe("splitCaseReference", () => {
  test("takes the sheet number off a Czech docket", () => {
    expect(splitCaseReference("11 C 153/2025-28")).toEqual({
      caseNumber: "11 C 153/2025",
      sheetNumber: "28",
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
    const sheets = ["-1", "-28", "-145", ""];
    const dockets = new Set(
      sheets.map(
        (sheet) => splitCaseReference(`11 C 153/2025${sheet}`).caseNumber,
      ),
    );

    expect([...dockets]).toEqual(["11 C 153/2025"]);
  });

  test("is idempotent", () => {
    const once = splitCaseReference("11 C 153/2025-28").caseNumber;

    expect(splitCaseReference(once).caseNumber).toBe(once);
  });
});
