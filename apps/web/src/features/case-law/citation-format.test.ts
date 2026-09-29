import { describe, expect, test } from "bun:test";

import { CASE_LAW_BROWSER_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { formatDecisionCitation } from "@/features/case-law/citation-format";
import type { CitationInput } from "@/features/case-law/citation-format";

describe("decision citation jurisdiction", () => {
  test("route and corpus country forms select the same style", () => {
    for (const country of CASE_LAW_BROWSER_COUNTRIES) {
      const input = {
        caseNumber: "56 Co 24/2026",
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
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
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
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

describe("a USA citation follows what the primary reference is", () => {
  const supremeCourt = {
    country: "USA",
    court: "Supreme Court of the United States",
    decisionType: null,
    ecli: null,
  } as const satisfies Partial<CitationInput>;

  test("a reporter citation is cited with its page and year", () => {
    expect(
      formatDecisionCitation({
        ...supremeCourt,
        caseNumber: "347 U.S. 483",
        caseNumberType: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        decisionDate: "1954-05-17",
        name: "Brown v. Board of Education",
        pincite: "495",
      }),
    ).toBe("Brown v. Board of Education, 347 U.S. 483, 495 (1954)");
  });

  test("a docket is cited as a slip opinion, never as a reporter", () => {
    expect(
      formatDecisionCitation({
        ...supremeCourt,
        caseNumber: "17-1618",
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        decisionDate: "2020-06-15",
        name: "Bostock v. Clayton County",
        pincite: "12",
      }),
    ).toBe("Bostock v. Clayton County, No. 17-1618 (U.S. June 15, 2020)");
  });

  test("a docket that already says No. is not prefixed twice", () => {
    expect(
      formatDecisionCitation({
        ...supremeCourt,
        caseNumber: "No. 22-451",
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        decisionDate: "2024-09-03",
        name: null,
        pincite: null,
      }),
    ).toBe("No. 22-451 (U.S. Sept. 3, 2024)");
  });

  test("an undated docket names the court alone", () => {
    expect(
      formatDecisionCitation({
        ...supremeCourt,
        caseNumber: "22-451",
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        decisionDate: null,
        name: "Loper Bright Enterprises v. Raimondo",
        pincite: null,
      }),
    ).toBe("Loper Bright Enterprises v. Raimondo, No. 22-451 (U.S.)");
  });
});
