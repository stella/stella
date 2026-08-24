import { describe, expect, test } from "bun:test";

import { citedDecisionLabel } from "@/lib/cited-decision-label";

describe("citedDecisionLabel", () => {
  test("two documents of one file get distinct labels", () => {
    const order = citedDecisionLabel({
      caseNumber: "II. ÚS 2766/14",
      decisionDate: "2014-10-08",
      decisionType: "usnesení",
    });
    const merits = citedDecisionLabel({
      caseNumber: "II. ÚS 2766/14",
      decisionDate: "2015-12-01",
      decisionType: "nález",
    });
    expect(order).toBe("II. ÚS 2766/14 (usnesení, 2014)");
    expect(merits).toBe("II. ÚS 2766/14 (nález, 2015)");
    expect(order).not.toBe(merits);
  });

  test("a decision without a stored type keeps the bare case number", () => {
    expect(
      citedDecisionLabel({
        caseNumber: "30 Cdo 292/2014",
        decisionDate: "2014-06-11",
        decisionType: null,
      }),
    ).toBe("30 Cdo 292/2014");
    expect(
      citedDecisionLabel({
        caseNumber: "30 Cdo 292/2014",
        decisionDate: "2014-06-11",
        decisionType: "  ",
      }),
    ).toBe("30 Cdo 292/2014");
  });

  test("a type without a date is still shown", () => {
    expect(
      citedDecisionLabel({
        caseNumber: "Pl. ÚS 11/02",
        decisionDate: null,
        decisionType: "nález",
      }),
    ).toBe("Pl. ÚS 11/02 (nález)");
  });
});
