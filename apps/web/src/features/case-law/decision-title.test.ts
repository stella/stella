import { describe, expect, test } from "bun:test";

import {
  DECISION_TITLE_SEPARATOR,
  decisionTitle,
} from "@/features/case-law/decision-title";

describe("decisionTitle", () => {
  test("qualifies the case number with the court", () => {
    expect(
      decisionTitle({ caseNumber: "I. ÚS 281/97", court: "Ústavní soud" }),
    ).toBe("I. ÚS 281/97 · Ústavní soud");
  });

  test("never trails a separator when no court is known", () => {
    for (const court of [undefined, null, "", "   ", "\t\n"]) {
      const title = decisionTitle({ caseNumber: "I. ÚS 281/97", court });
      expect(title).toBe("I. ÚS 281/97");
      expect(title).not.toInclude(DECISION_TITLE_SEPARATOR);
    }
  });
});
