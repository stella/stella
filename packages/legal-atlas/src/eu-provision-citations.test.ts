import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  EU_ACT_ALIASES,
  locateEuProvisionCitations,
} from "./eu-provision-citations";

const fixtures = [
  "Article 6(1)(a) of Regulation (EU) 2016/679",
  "čl. 6 odst. 1 písm. a) nařízení (EU) 2016/679",
  "čl. 6 ods. 1 písm. a) nariadenia (EÚ) 2016/679",
  "art. 6 ust. 1 lit. a) rozporządzenia 2016/679",
  "6. cikk (1) bekezdés a) pont 2016/679/EU rendelet",
  "Artikel 6 Abs. 1 Buchst. a) der Verordnung (EU) 2016/679",
  "Article 6 paragraphe 1 lettre a) du règlement (UE) 2016/679",
] as const;

describe("EU provision citations", () => {
  for (const sentence of fixtures) {
    test(`reads ${sentence}`, () => {
      const citation = locateEuProvisionCitations(sentence).at(0);
      expect(citation?.act.celex).toBe("32016R0679");
      expect(citation?.act.eli).toBe(
        "http://data.europa.eu/eli/reg/2016/679/oj",
      );
      expect(citation?.reference).toMatchObject({
        letter: "a",
        section: 6,
        subsection: "1",
        unit: "article",
      });
    });
  }

  test("reads old directive numbering and common aliases", () => {
    expect(
      locateEuProvisionCitations("Article 7 of Directive 95/46/EC").at(0)?.act
        .celex,
    ).toBe("31995L0046");
    for (const alias of [
      "GDPR",
      "RODO",
      "obecné nařízení o ochraně osobních údajů",
    ]) {
      expect(
        locateEuProvisionCitations(`čl. 6 odst. 1 ${alias}`).at(0)?.act.celex,
      ).toBe("32016R0679");
    }
  });

  test("applies the numbering order for each act kind and era", () => {
    const cases = [
      ["Article 7 of Directive 95/46/EC", "31995L0046"],
      ["Article 5 of Regulation (EC) No 1/2003", "32003R0001"],
      ["Artikel 5 der Verordnung (EHS) Nr. 17/1962", "31962R0017"],
      ["Article 6 of Regulation (EU) 2016/679", "32016R0679"],
      ["Article 2 of Directive (EU) 2019/1937", "32019L1937"],
    ] as const;
    for (const [printed, celex] of cases) {
      expect(locateEuProvisionCitations(printed).at(0)?.act.celex).toBe(celex);
    }
  });

  test("located spans resolve to exactly one CELEX", () => {
    assertProperty(
      "eu-citation-spans-resolve-one-celex",
      fc.property(
        fc.constantFrom(...fixtures),
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        (fixture, prefix, suffix) => {
          const text = `${prefix}${fixture}${suffix}`;
          const citations = locateEuProvisionCitations(text);
          expect(citations).toHaveLength(1);
          const citation = citations.at(0);
          expect(citation).toBeDefined();
          if (citation === undefined) {
            return;
          }
          expect(text.slice(citation.start, citation.end)).toContain("6");
          expect(citation.act.celex).toMatch(/^3\d{4}[LR]\d{4}$/u);
        },
      ),
    );
  });

  test("aliases cannot shadow a printed act number", () => {
    const aliasPatterns = Object.values(EU_ACT_ALIASES).flatMap(
      ({ patterns }) => patterns,
    );
    for (const pattern of aliasPatterns) {
      expect(pattern).not.toMatch(/\d{2,4}\s*\/\s*\d/u);
    }
    expect(
      locateEuProvisionCitations("Article 6 GDPR Regulation (EU) 2016/679"),
    ).toHaveLength(1);
  });
});
