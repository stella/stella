import { describe, expect, test } from "bun:test";

import { CASE_LAW_BROWSER_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import { formatDecisionCitation } from "@/features/case-law/citation-format";

describe("decision citation jurisdiction", () => {
  test("route and corpus country forms select the same style", () => {
    for (const country of CASE_LAW_BROWSER_COUNTRIES) {
      const input = {
        caseNumber: "56 Co 24/2026",
        country,
        court: "Krajský soud v Plzni",
        decisionDate: "2026-03-18",
        decisionType: "rozsudek",
        ecli: null,
        name: null,
        pincite: null,
      };

      expect(
        formatDecisionCitation({ ...input, country: country.toLowerCase() }),
      ).toBe(formatDecisionCitation(input));
    }
  });

  test("a route-form country code keeps the jurisdiction's citation style", () => {
    expect(
      formatDecisionCitation({
        caseNumber: "56 Co 24/2026",
        country: "cze",
        court: "Krajský soud v Plzni",
        decisionDate: "2026-03-18",
        decisionType: "rozsudek",
        ecli: null,
        name: null,
        pincite: null,
      }),
    ).toBe(
      "rozsudek Krajského soudu v Plzni ze dne 18. 3. 2026, sp. zn. 56 Co 24/2026",
    );
  });
});
