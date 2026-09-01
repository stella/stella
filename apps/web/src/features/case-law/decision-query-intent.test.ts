import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  exactDecisionMatches,
  parseDecisionQuery,
} from "@/features/case-law/decision-query-intent";

/** Dockets as the corpus's courts print them, one per grammar. */
const canonicalDockets = [
  "22 Cdo 2653/2012",
  "29 NSČR 55/2013",
  "1 As 12/2020",
  "65 A 3/2025",
  "Pl. ÚS 1/20",
  "IV. ÚS 23/05",
  "21 Cdo 470/2017-28",
  "1Cdo/12/2020",
  "4Sžf/12/2019",
  "10Co/123/2019",
  "II CSK 123/19",
  "III AKa 198/23",
  "I ACa 1/2020",
  "C-131/12",
  "T-449/14",
  "C-131/12 P",
  "Case C-131/12",
  "5Ob200/20x",
  "6 Ob 123/21k",
  "Ra 2020/01/0001",
  "G 1/2020",
  "E 123/2019-12",
  "RV/7500368/2026",
] as const;

const eclis = [
  "ECLI:CZ:NS:2014:22.CDO.2653.2012.1",
  "ECLI:EU:C:2014:317",
  "ECLI:SK:NSSR:2020:1234567.1",
] as const;

/** A publisher's or a typist's spelling of the same identifier. */
const spellingOf = (identifier: string) =>
  fc
    .record({
      caseFlip: fc.boolean(),
      dash: fc.constantFrom("-", "‑", "–", "−"),
      lead: fc.constantFrom("", " ", " "),
      space: fc.constantFrom(" ", "  ", " ", "  "),
      trail: fc.constantFrom("", " ", "\n"),
    })
    .map(({ caseFlip, dash, lead, space, trail }) => {
      const respaced = identifier
        .replaceAll(" ", () => space)
        .replaceAll("-", () => dash);
      const cased = caseFlip ? respaced.toLowerCase() : respaced;
      return `${lead}${cased}${trail}`;
    });

describe("reading a case-law box entry", () => {
  test("every docket spelling the courts and typists produce is an identifier", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...canonicalDockets).chain(spellingOf),
        (entry) => {
          const intent = parseDecisionQuery(entry);
          expect(intent.type).toBe("identifier");
          if (intent.type === "identifier") {
            expect(intent.kind).toBe("docket");
            expect(intent.value).not.toMatch(/\s{2}| |‑/u);
          }
        },
      ),
      propertyConfig(),
    );
  });

  test("an ECLI in any spacing or case is an ECLI", () => {
    fc.assert(
      fc.property(fc.constantFrom(...eclis).chain(spellingOf), (entry) => {
        const intent = parseDecisionQuery(entry);
        expect(intent).toMatchObject({ type: "identifier", kind: "ecli" });
      }),
      propertyConfig(),
    );
  });

  test("prose is text, verbatim", () => {
    const word = fc.stringMatching(/^[a-záčďéěíňóřšťúůýž]{2,12}$/u);
    fc.assert(
      fc.property(fc.array(word, { minLength: 2, maxLength: 6 }), (words) => {
        const text = words.join(" ");
        expect(parseDecisionQuery(text)).toEqual({ type: "text", text });
      }),
      propertyConfig(),
    );
    expect(parseDecisionQuery("nájemní smlouva výpověď")).toEqual({
      type: "text",
      text: "nájemní smlouva výpověď",
    });
    expect(parseDecisionQuery("§ 2079")).toEqual({
      type: "text",
      text: "§ 2079",
    });
    expect(parseDecisionQuery("   ")).toEqual({ type: "empty" });
  });
});

describe("the hits that are the named decision", () => {
  const hit = (caseNumber: string, ecli: string | null = null) => ({
    caseNumber,
    ecli,
  });

  test("spacing, case, dash style and the sheet number do not change identity", () => {
    fc.assert(
      fc.property(
        fc
          .constantFrom(...canonicalDockets)
          .chain((docket) => fc.tuple(fc.constant(docket), spellingOf(docket))),
        ([stored, typed]) => {
          const hits = [hit(stored), hit("99 Cdo 1/2000")];
          expect(exactDecisionMatches(typed, hits)).toEqual([hit(stored)]);
        },
      ),
      propertyConfig(),
    );
    expect(
      exactDecisionMatches("21 Cdo 470/2017-28", [hit("21 Cdo 470/2017")]),
    ).toHaveLength(1);
  });

  test("the same docket at two courts is two matches, never one", () => {
    const hits = [
      { caseNumber: "65 A 3/2025", court: "Krajský soud v Brně", ecli: null },
      {
        caseNumber: "65 A 3/2025",
        court: "Krajský soud v Ostravě",
        ecli: null,
      },
      { caseNumber: "65 A 4/2025", court: "Krajský soud v Brně", ecli: null },
    ];
    expect(exactDecisionMatches("65 A 3/2025", hits)).toHaveLength(2);
  });

  test("a publisher's parallel case number matches too", () => {
    const hits = [
      {
        caseNumber: "III AKa 198/23",
        ecli: null,
        identifiers: [
          { type: "case-number", value: "III AKa 198/23" },
          { type: "case-number", value: "III AKz 12/23" },
        ],
      },
    ];
    expect(exactDecisionMatches("III AKz 12/23", hits)).toHaveLength(1);
    expect(exactDecisionMatches("III AKz 13/23", hits)).toEqual([]);
  });

  test("an ECLI matches the hit that carries it", () => {
    const hits = [
      hit("22 Cdo 2653/2012", "ECLI:CZ:NS:2014:22.CDO.2653.2012.1"),
    ];
    expect(
      exactDecisionMatches("ecli:cz:ns:2014:22.cdo.2653.2012.1", hits),
    ).toHaveLength(1);
    expect(
      exactDecisionMatches("ECLI:CZ:NS:2014:99.CDO.1.2000.1", hits),
    ).toEqual([]);
  });
});
