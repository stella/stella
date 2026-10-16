import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { formatProvisionKey } from "@stll/api-contract/provision-key";
import { assertProperty } from "@stll/property-testing";

import {
  EU_ACT_ALIASES,
  EU_PRIMARY_WORKS,
  euProvisionAnchor,
  parseEuWorkIdentifier,
  euProvisionSourceUrl,
  locateEuProvisionCitations,
} from "./eu-provision-citations";
import { provisionRefOf, parseProvisionKey } from "./provision-key";

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

  test("EU provision references round-trip their CELEX identity independently of hosted text", () => {
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
