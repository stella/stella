import { describe, expect, test } from "bun:test";

import {
  createCaseLawDecisionRouteParam,
  decodeCaseLawDecisionRef,
  isCaseLawDecisionId,
  pickCaseLawDecisionHit,
  slugifyCaseLawCaseNumber,
} from "@/lib/case-law-route";

const DECISION_ID = "019dd47d-f507-7c84-b827-980af11b8980";

describe("case-law decision routes", () => {
  test("creates stable slugged route params", () => {
    expect(slugifyCaseLawCaseNumber("20 Cdo 470/2017")).toBe("20-cdo-470-2017");
    expect(
      createCaseLawDecisionRouteParam({
        caseNumber: "20 Cdo 470/2017",
        decisionId: DECISION_ID,
      }),
    ).toBe(`20-cdo-470-2017--${DECISION_ID}`);
  });

  test("decodes markdown href payloads that contain case numbers", () => {
    expect(decodeCaseLawDecisionRef("20%20Cdo%20470%2F2017")).toBe(
      "20 Cdo 470/2017",
    );
    expect(decodeCaseLawDecisionRef("20 Cdo 470/2017")).toBe("20 Cdo 470/2017");
  });

  test("distinguishes decision ids from citation numbers", () => {
    expect(isCaseLawDecisionId(DECISION_ID)).toBe(true);
    expect(isCaseLawDecisionId("20 Cdo 470/2017")).toBe(false);
  });

  test("prefers exact case number matches over first search result", () => {
    const hit = pickCaseLawDecisionHit("20 Cdo 470/2017", [
      {
        caseNumber: "20 Cdo 999/2017",
        decisionId: "019dd47e-2d83-7178-8f24-11f2976a01db",
        ecli: null,
      },
      { caseNumber: "20 Cdo 470/2017", decisionId: DECISION_ID, ecli: null },
    ]);

    expect(hit?.decisionId).toBe(DECISION_ID);
  });
});
