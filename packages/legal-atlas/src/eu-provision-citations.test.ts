import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { formatProvisionKey } from "@stll/api-contract/provision-key";
import { assertProperty } from "@stll/property-testing";

import {
  EU_ACT_ALIASES,
  EU_PRIMARY_WORKS,
  euProvisionAnchor,
  euProvisionSourceUrl,
  locateEuProvisionCitations,
  parseEuWorkIdentifier,
} from "./eu-provision-citations";
import { parseProvisionKey, provisionRefOf } from "./provision-key";

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
  test.each([
    "článek 6 GDPR",
    "článku 6 GDPR",
    "článkem 6 GDPR",
    "článok 6 GDPR",
    "článkom 6 GDPR",
    "článek 6 odst. 1 nařízení (EU) 2016/679",
  ])("reads the full Czech and Slovak article word in %s", (text) => {
    const citation = locateEuProvisionCitations(text).at(0);
    expect(citation?.act.celex).toBe("32016R0679");
    expect(citation?.reference).toMatchObject({ unit: "article", section: 6 });
  });

  test("does not read an article marker from the end of a word", () => {
    expect(locateEuProvisionCitations("Part 6 GDPR")).toEqual([]);
  });

  test("never truncates a longer act number into another instrument", () => {
    expect(
      locateEuProvisionCitations("Article 1 of Regulation (EU) 2024/12345"),
    ).toEqual([]);
    expect(
      locateEuProvisionCitations("Article 1 of Regulation (EU) 12024/123"),
    ).toEqual([]);
  });

  for (const sentence of fixtures) {
    test(`reads ${sentence}`, () => {
      const citation = locateEuProvisionCitations(sentence).at(0);
      expect(citation?.act.celex).toBe("32016R0679");
      expect(citation?.source).toBe("number");
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
      expect(
        locateEuProvisionCitations(`čl. 6 odst. 1 ${alias}`).at(0)?.source,
      ).toBe("alias");
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

  test("eu-citation-spans-resolve-one-celex", () => {
    assertProperty(
      "eu-citation-spans-resolve-one-celex",
      fc.property(
        fc.constantFrom(...fixtures),
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        (fixture, prefix, suffix) => {
          const text = `${prefix} ${fixture} ${suffix}`;
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

describe("EU primary-law work identity", () => {
  const primaryFixtures = [
    ["Article 6 TEU", "teu"],
    ["Article 267 TFEU", "tfeu"],
    ["čl. 267 SFEU", "tfeu"],
    ["čl. 267 ZFEÚ", "tfeu"],
    ["art. 267 TFUE", "tfeu"],
    ["267. cikk EUMSZ", "tfeu"],
    ["Artikel 267 AEUV", "tfeu"],
    ["Article 267 TFUE", "tfeu"],
    ["Article 47 Charter of Fundamental Rights", "charter"],
  ] as const;
  test.each(primaryFixtures)("reads primary law %s", (printed, kind) => {
    expect(locateEuProvisionCitations(printed).at(0)?.act).toEqual(
      EU_PRIMARY_WORKS[kind],
    );
  });

  test("a stated treaty edition changes version evidence while the work key stays fixed", () => {
    for (const edition of ["2008", "2010", "2012", "2016"]) {
      const printed = `Article 267 TFEU (${edition})`;
      const citation = locateEuProvisionCitations(printed).at(0);
      expect(citation?.act.celex).toBe("12016E/TXT");
      expect(citation?.appliedVersion).toEqual({
        type: "stated_version",
        amendmentWorkIdentifier: `1${edition}E/TXT`,
        evidence: { start: 0, end: printed.length, kind: "stated_version" },
      });
    }
    expect(
      locateEuProvisionCitations("Article 267 TFEU").at(0)?.appliedVersion,
    ).toEqual({ type: "not_stated" });
  });

  test("eu-provision-celex-key-roundtrip", () => {
    assertProperty(
      "eu-provision-celex-key-roundtrip",
      fc.property(
        fc.constantFrom(
          ...primaryFixtures,
          ...fixtures.map((printed) => [printed, "gdpr"] as const),
        ),
        ([printed]) => {
          const citation = locateEuProvisionCitations(printed).at(0);
          expect(citation).toBeDefined();
          if (citation === undefined) {
            return;
          }
          const result = provisionRefOf({
            jurisdiction: "EU",
            workIdentifier: citation.act.celex,
            reference: citation.reference,
          });
          expect(result.status).toBe("resolved");
          if (result.status !== "resolved") {
            return;
          }
          expect(result.provision.workEli).toBe(citation.act.eli);
          expect(result.provision.anchor).toBe(
            euProvisionAnchor(citation.reference),
          );
          expect(
            parseProvisionKey(formatProvisionKey(result.provision)),
          ).toMatchObject({
            jurisdiction: "EU",
            workIdentifier: citation.act.celex,
            anchor: result.provision.anchor,
          });
          expect(
            euProvisionSourceUrl(citation.act.celex, citation.reference),
          ).toContain("eur-lex.europa.eu");
        },
      ),
    );
  });

  test("invalid work identities and zero articles are refused", () => {
    for (const value of [
      "32016R0000",
      "30000R0679",
      "12012E/TXT",
      "GDPR",
      "https://evil.test",
    ]) {
      expect(parseEuWorkIdentifier(value)).toBeNull();
      expect(euProvisionSourceUrl(value)).toBeNull();
    }
    expect(locateEuProvisionCitations("Article 0 TFEU")).toEqual([]);
  });
});

const legacyRegulationSpellings = {
  en: "Article 5 of Regulation (EC) {number}/{year}",
  cs: "čl. 5 nařízení (ES) {number}/{year}",
  sk: "čl. 5 nariadenia (ES) {number}/{year}",
  pl: "art. 5 rozporządzenia (WE) {number}/{year}",
  hu: "5. cikk {number}/{year}/EK rendelet",
  de: "Artikel 5 der Verordnung (EG) {number}/{year}",
  fr: "Article 5 du règlement (CE) {number}/{year}",
} as const;

describe("EU act numbering with a citing date", () => {
  for (const [language, spelling] of Object.entries(
    legacyRegulationSpellings,
  )) {
    test(`unmarked pre-2015 regulations keep number/year order in ${language}`, () => {
      for (const [number, year, celex] of [
        [44, 2001, "32001R0044"],
        [1, 2003, "32003R0001"],
        [2201, 2003, "32003R2201"],
        [1408, 1971, "31971R1408"],
      ] as const) {
        const printed = spelling
          .replace("{number}", () => String(number))
          .replace("{year}", () => String(year));
        expect(
          locateEuProvisionCitations(printed, { citedOn: "2020-01-01" }).map(
            ({ act }) => act.celex,
          ),
        ).toEqual([celex]);
      }
    });
  }

  test("eu-secondary-law-year-never-follows-citing-date", () => {
    assertProperty(
      "eu-secondary-law-year-never-follows-citing-date",
      fc.property(
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1950, max: 2020 }),
        fc.integer({ min: 1950, max: 2020 }),
        (number, year, citingYear) => {
          for (const spelling of Object.values(legacyRegulationSpellings)) {
            const printed = spelling
              .replace("{number}", () => String(year < 2015 ? number : year))
              .replace("{year}", () => String(year < 2015 ? year : number));
            const citations = locateEuProvisionCitations(printed, {
              citedOn: `${citingYear}-12-31`,
            });
            for (const { act } of citations) {
              expect(Number(act.celex.slice(1, 5))).toBeLessThanOrEqual(
                citingYear,
              );
              expect(act).toMatchObject({ year, number });
            }
            if (year > citingYear) {
              expect(citations).toEqual([]);
            }
            if (year <= citingYear) {
              expect(citations).toHaveLength(1);
            }
          }
        },
      ),
    );
  });

  test("future and implausible identities are refused instead of reinterpreted", () => {
    for (const printed of [
      "Article 5 of Regulation (EU) 2021/44",
      "Article 5 of Regulation (EC) 44/2021",
      "Article 5 of Regulation (EC) 0/2001",
      "Article 5 of Regulation (EC) 44/1800",
      "Article 5 GDPR",
    ]) {
      expect(
        locateEuProvisionCitations(printed, { citedOn: "2010-01-01" }),
      ).toEqual([]);
    }
    expect(
      locateEuProvisionCitations("Article 5 of Regulation 2016/2001", {
        citedOn: "2020-01-01",
      }),
    ).toEqual([]);
    expect(
      locateEuProvisionCitations("Article 5 of Regulation (EC) No 2016/2001", {
        citedOn: "2020-01-01",
      }).at(0)?.act.celex,
    ).toBe("32001R2016");
  });

  test("two-digit years use the act kind and explicit number marker", () => {
    const cases = [
      ["Article 5 of Regulation (EC) 44/01", "32001R0044"],
      ["Article 5 of Directive 95/46/EC", "31995L0046"],
      ["Article 5 of Directive No 46/95/EC", "31995L0046"],
    ] as const;
    for (const [printed, celex] of cases) {
      expect(
        locateEuProvisionCitations(printed, { citedOn: "2020-01-01" }).at(0)
          ?.act.celex,
      ).toBe(celex);
    }
  });

  test("an unmarked four-digit regulation number keeps an unambiguous legacy year", () => {
    expect(
      locateEuProvisionCitations("Article 6 of Regulation (EEC) 1408/71", {
        citedOn: "2020-01-01",
      }).map(({ act }) => act.celex),
    ).toEqual(["31971R1408"]);
    expect(
      locateEuProvisionCitations("Article 6 of Regulation (EEC) 2001/01", {
        citedOn: "2020-01-01",
      }),
    ).toEqual([]);
  });
});

test("eu-explicit-number-marker-preserves-legacy-two-digit-years", () => {
  assertProperty(
    "eu-explicit-number-marker-preserves-legacy-two-digit-years",
    fc.property(
      fc.integer({ min: 1, max: 9999 }),
      fc.integer({ min: 1950, max: 2014 }),
      fc.constantFrom("No", "Nr.", "č."),
      (number, year, marker) => {
        const printed = `Article 5 of Regulation (EC) ${marker} ${number}/${String(year % 100).padStart(2, "0")}`;
        const citations = locateEuProvisionCitations(printed, {
          citedOn: "2020-01-01",
        });
        expect(citations).toHaveLength(1);
        expect(citations.at(0)?.act).toMatchObject({ number, year });
      },
    ),
  );
});
