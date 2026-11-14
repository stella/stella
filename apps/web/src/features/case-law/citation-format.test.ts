import { describe, expect, test } from "bun:test";

import {
  CASE_LAW_JURISDICTIONS,
  CASE_LAW_REGION_BY_JURISDICTION,
} from "@stll/api-contract/case-law-jurisdictions";
import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import {
  CASE_LAW_BROWSER_COUNTRIES,
  type CaseLawBrowserCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { quotationMarksFor } from "@/components/legal-reader/citation-copy.logic";
import {
  formatDecisionCitation,
  formatJurisdictionQuotation,
} from "@/features/case-law/citation-format";
import type { CitationInput } from "@/features/case-law/citation-format";
import type { StatuteCountry } from "@/lib/statutes/statute-route";

const EXPECTED_QUOTATIONS = {
  CZE: "„text“",
  EU: "“text”",
  HUN: "„text”",
  POL: "„text”",
  SVK: "„text“",
} as const satisfies Record<CaseLawBrowserCountry, string>;

const EXPECTED_STATUTE_QUOTATIONS = {
  cze: EXPECTED_QUOTATIONS.CZE,
  svk: EXPECTED_QUOTATIONS.SVK,
} as const satisfies Record<StatuteCountry, string>;

const EXPECTED_JURISDICTION_QUOTATIONS = {
  ...EXPECTED_QUOTATIONS,
  AUT: "„text“",
  BRA: "“text”",
  GBR: "“text”",
  USA: "“text”",
} as const satisfies Record<CaseLawJurisdiction, string>;

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
        paragraph: null,
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
        paragraph: null,
        pincite: null,
      }),
    ).toBe(
      "rozsudek Krajského soudu v Plzni ze dne 18. 3. 2026, sp. zn. 56 Co 24/2026",
    );
  });
});

describe("a Czech or Slovak citation pinpoints the court's paragraph", () => {
  test("a located paragraph is cited as bod N", () => {
    expect(
      formatDecisionCitation({
        caseNumber: "III.ÚS 2429/24",
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        country: "CZE",
        court: "Ústavní soud",
        decisionDate: "2026-04-15",
        decisionType: "nález",
        ecli: null,
        name: null,
        paragraph: 27,
        pincite: null,
      }),
    ).toBe(
      "nález Ústavního soudu ze dne 15. 4. 2026, sp. zn. III.ÚS 2429/24, bod 27",
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
        paragraph: null,
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
        paragraph: null,
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
        paragraph: null,
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
        paragraph: null,
        pincite: null,
      }),
    ).toBe("Loper Bright Enterprises v. Raimondo, No. 22-451 (U.S.)");
  });
});

describe("Hungarian citation typography", () => {
  const input = {
    caseNumber: "Pfv.21.123/2019/5.",
    caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    country: "HUN",
    court: "Kúria",
    decisionDate: "2019-03-21",
    decisionType: "ítélet",
    ecli: null,
    name: null,
    paragraph: null,
    pincite: null,
  } satisfies CitationInput;

  test("keeps docket punctuation and Hungarian calendar order", () => {
    expect(formatDecisionCitation(input)).toBe(
      "Kúria, Pfv.21.123/2019/5., 2019. március 21.",
    );
    expect(formatDecisionCitation({ ...input, decisionDate: null })).toBe(
      "Kúria, Pfv.21.123/2019/5.",
    );
  });

  test.each([
    {
      decisionDate: "2019-03-21",
      expected: "Kúria, Pfv.21.123/2019/5., 2019. március 21. [12]",
    },
    { decisionDate: null, expected: "Kúria, Pfv.21.123/2019/5. [12]" },
  ])("preserves a supplied locator", ({ decisionDate, expected }) => {
    expect(
      formatDecisionCitation({ ...input, decisionDate, pincite: "12" }),
    ).toBe(expected);
  });

  test("quotation typography is invariant to route or corpus country form", () => {
    for (const country of CASE_LAW_BROWSER_COUNTRIES) {
      expect(formatJurisdictionQuotation("text", country)).toBe(
        EXPECTED_QUOTATIONS[country],
      );
      expect(formatJurisdictionQuotation("text", country.toLowerCase())).toBe(
        EXPECTED_QUOTATIONS[country],
      );
    }
    expect(formatJurisdictionQuotation("teljesítés", "HUN")).toBe(
      "„teljesítés”",
    );
  });

  test("every statute country uses its jurisdiction marks", () => {
    for (const [country, expected] of Object.entries(
      EXPECTED_STATUTE_QUOTATIONS,
    )) {
      expect(formatJurisdictionQuotation("text", country)).toBe(expected);
    }
  });
});

describe("jurisdiction quotation marks", () => {
  test.each(CASE_LAW_JURISDICTIONS)(
    "%s is quoted in its working language's marks in every country form",
    (jurisdiction) => {
      const marks = quotationMarksFor({
        country: jurisdiction,
        language: null,
      });
      const region = CASE_LAW_REGION_BY_JURISDICTION[jurisdiction];
      for (const form of [
        jurisdiction,
        jurisdiction.toLowerCase(),
        region,
        region.toLowerCase(),
      ]) {
        const quoted = formatJurisdictionQuotation("text", form);
        expect(quoted).toBe(`${marks.open}text${marks.close}`);
        expect(quoted).toBe(EXPECTED_JURISDICTION_QUOTATIONS[jurisdiction]);
      }
    },
  );

  test("a country without a declared language is quoted in English marks", () => {
    expect(formatJurisdictionQuotation("text", "XYZ")).toBe("“text”");
  });
});

describe("British neutral citations", () => {
  test.each(["GBR", "gbr", "GB", "gb"])(
    "%s keeps the neutral citation and adds a paragraph locator",
    (country) => {
      expect(
        formatDecisionCitation({
          caseNumber: "[2024] UKSC 12",
          caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          country,
          court: "UKSC",
          decisionDate: "2024-03-18",
          decisionType: null,
          ecli: null,
          name: "Example v Example",
          paragraph: null,
          pincite: "42",
        }),
      ).toBe("Example v Example [2024] UKSC 12 [42]");
    },
  );

  test("uses English quotation marks for corpus and region codes", () => {
    for (const country of ["GBR", "gbr", "GB"]) {
      expect(formatJurisdictionQuotation("text", country)).toBe("“text”");
    }
  });
});

describe("Brazilian citations", () => {
  test.each(["BRA", "bra", "BR", "br"])(
    "%s cites the court by its sigla with the judgment date",
    (country) => {
      expect(
        formatDecisionCitation({
          caseNumber: "RE 99234567 AgR",
          caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          country,
          court: "Supremo Tribunal Federal",
          decisionDate: "2020-02-03",
          decisionType: "acórdão",
          ecli: null,
          name: null,
          paragraph: null,
          pincite: null,
        }),
      ).toBe("STF, RE 99234567 AgR, j. 03/02/2020");
    },
  );

  test("a court without a sigla keeps its name", () => {
    expect(
      formatDecisionCitation({
        caseNumber: "0701234-56.2099.8.07.0001",
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        country: "BRA",
        court: "Tribunal de Justiça do Estado de São Paulo",
        decisionDate: null,
        decisionType: null,
        ecli: null,
        name: null,
        paragraph: null,
        pincite: null,
      }),
    ).toBe(
      "Tribunal de Justiça do Estado de São Paulo, 0701234-56.2099.8.07.0001",
    );
  });

  test("uses Brazilian quotation marks for corpus and region codes", () => {
    for (const country of ["BRA", "bra", "BR"]) {
      expect(formatJurisdictionQuotation("texto", country)).toBe("“texto”");
    }
  });
});
