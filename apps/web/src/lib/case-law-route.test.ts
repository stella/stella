import { describe, expect, test } from "bun:test";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import {
  type CaseLawDecisionSearchHit,
  decodeCaseLawDecisionRef,
  pickCaseLawDecisionHit,
  resolveCaseLawRouteCountry,
} from "@/lib/case-law-route";

const DECISION_ID = "019dd47d-f507-7c84-b827-980af11b8980";

const caseLawHit = ({
  caseNumber,
  decisionId,
}: {
  caseNumber: string;
  decisionId: string;
}): CaseLawDecisionSearchHit => ({
  caseNumber,
  country: "CZE",
  court: "Nejvyssi soud",
  decisionDate: "2024-01-31",
  decisionId,
  ecli: null,
});

describe("case-law decision routes", () => {
  test("defaults only an absent public country", () => {
    const publicCountry = publicCaseLawCountry("CZE");
    expect(
      resolveCaseLawRouteCountry({ country: undefined, locale: "cs" }),
    ).toBe(publicCountry);
    expect(resolveCaseLawRouteCountry({ country: "cze", locale: "en" })).toBe(
      publicCountry,
    );
    expect(
      resolveCaseLawRouteCountry({ country: "xaa", locale: "cs" }),
    ).toBeNull();
  });

  test("decodes markdown href payloads that contain case numbers", () => {
    expect(decodeCaseLawDecisionRef("20%20Cdo%20470%2F2017")).toBe(
      "20 Cdo 470/2017",
    );
    expect(decodeCaseLawDecisionRef("20 Cdo 470/2017")).toBe("20 Cdo 470/2017");
    expect(decodeCaseLawDecisionRef(" 100% ")).toBe("100%");
  });

  test("prefers exact case number matches over first search result", () => {
    const hit = pickCaseLawDecisionHit("20 Cdo 470/2017", [
      caseLawHit({
        caseNumber: "20 Cdo 999/2017",
        decisionId: "019dd47e-2d83-7178-8f24-11f2976a01db",
      }),
      caseLawHit({ caseNumber: "20 Cdo 470/2017", decisionId: DECISION_ID }),
    ]);

    expect(hit?.decisionId).toBe(DECISION_ID);
  });
});
