import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { DECISION_DOCKET_GRAMMARS } from "./decision-docket-grammar";
import {
  exactDecisionMatches,
  parseDecisionQuery,
} from "./decision-query-intent";
import { decisionReporterGrammarForJurisdiction } from "./us-reporter-citation";

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

  test("a scoped entry is claimed only by that jurisdiction's grammar", () => {
    expect(
      parseDecisionQuery("C-9999/99", {
        grammar: DECISION_DOCKET_GRAMMARS.EU,
      }),
    ).toMatchObject({
      type: "identifier",
      kind: "docket",
    });
    expect(
      parseDecisionQuery("C-9999/99", {
        grammar: DECISION_DOCKET_GRAMMARS.POL,
      }),
    ).toEqual({
      type: "text",
      text: "C-9999/99",
    });
    expect(parseDecisionQuery("C-9999/99", { grammar: null })).toEqual({
      type: "text",
      text: "C-9999/99",
    });
    expect(
      parseDecisionQuery("ECLI:EU:C:2099:999", {
        grammar: DECISION_DOCKET_GRAMMARS.POL,
      }),
    ).toMatchObject({
      type: "identifier",
      kind: "ecli",
    });
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

describe("reading a reporter citation entry", () => {
  const inUsa = { reporters: decisionReporterGrammarForJurisdiction("USA") };

  test("in the reporter jurisdiction a reporter citation is an identifier in its canonical spelling", () => {
    expect(parseDecisionQuery("347 U.S. 483", inUsa)).toEqual({
      type: "identifier",
      kind: "reporter",
      value: "347 U.S. 483",
    });
    expect(parseDecisionQuery("  163 U. S. 537 ", inUsa)).toEqual({
      type: "identifier",
      kind: "reporter",
      value: "163 U.S. 537",
    });
    expect(parseDecisionQuery("87 a. 2d 862", inUsa)).toEqual({
      type: "identifier",
      kind: "reporter",
      value: "87 A.2d 862",
    });
  });

  test("a pin does not change which decision the entry names", () => {
    for (const entry of [
      "347 U.S. 483, 495",
      "347 U. S. 483, at 494-495",
      "347 U.S. 483 at 495",
      "347 U.S. 483, 495, 497",
    ]) {
      expect(parseDecisionQuery(entry, inUsa)).toEqual(
        parseDecisionQuery("347 U.S. 483", inUsa),
      );
    }
  });

  test("elsewhere, and unscoped, a reporter-shaped entry reads as it always did", () => {
    for (const entry of ["347 U.S. 483", "10 S. Ct. 3", "347 U.S. 483, 495"]) {
      for (const options of [
        {},
        { reporters: decisionReporterGrammarForJurisdiction("CZE") },
        { grammar: DECISION_DOCKET_GRAMMARS.CZE, reporters: null },
        {
          grammar: DECISION_DOCKET_GRAMMARS.POL,
          reporters: decisionReporterGrammarForJurisdiction("POL"),
        },
      ]) {
        expect(parseDecisionQuery(entry, options)).toEqual({
          type: "text",
          text: entry,
        });
      }
    }
  });

  test("a statute, a short form, a shared spelling and an unknown reporter are not citations of a decision", () => {
    for (const text of [
      "28 U.S.C. § 1253",
      "42 U.S.C. 1983",
      "347 U.S., at 495",
      "1 Wall. 1",
      "12 Xyz. 34",
    ]) {
      expect(parseDecisionQuery(text, inUsa)).toEqual({ type: "text", text });
    }
  });

  test("no docket the corpus's grammars read is taken for a reporter citation", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...canonicalDockets).chain(spellingOf),
        (entry) => {
          expect(parseDecisionQuery(entry, inUsa)).not.toMatchObject({
            kind: "reporter",
          });
        },
      ),
      propertyConfig(),
    );
  });
});

const docketRef = (value: string) => ({ kind: "docket", value }) as const;
const ecliRef = (value: string) => ({ kind: "ecli", value }) as const;
const reporterRef = (value: string) => ({ kind: "reporter", value }) as const;

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
          expect(exactDecisionMatches(docketRef(typed), hits)).toEqual([
            hit(stored),
          ]);
        },
      ),
      propertyConfig(),
    );
    expect(
      exactDecisionMatches(docketRef("21 Cdo 470/2017-28"), [
        hit("21 Cdo 470/2017"),
      ]),
    ).toHaveLength(1);
  });

  test("structural separators keep otherwise similar dockets distinct", () => {
    expect(
      exactDecisionMatches(docketRef("G 1/2099"), [
        hit("G 1/2099"),
        hit("G/1/2099"),
      ]),
    ).toEqual([hit("G 1/2099")]);
  });

  test("under its own scope a United States docket number is identity, not a sheet", () => {
    const usa = { grammar: DECISION_DOCKET_GRAMMARS.USA };
    const hits = [hit("21-123"), hit("21-456")];
    expect(exactDecisionMatches(docketRef("21-123"), hits, usa)).toEqual([
      hit("21-123"),
    ]);
    expect(exactDecisionMatches(docketRef("No. 21-456"), hits, usa)).toEqual([
      hit("21-456"),
    ]);
    expect(exactDecisionMatches(docketRef("21-789"), hits, usa)).toEqual([]);
    expect(
      exactDecisionMatches(docketRef("10-12"), [hit("10-34")], usa),
    ).toEqual([]);
    expect(
      exactDecisionMatches(
        docketRef("No. 5"),
        [hit("No. 5"), hit("No. 6")],
        usa,
      ),
    ).toEqual([hit("No. 5")]);
    expect(
      parseDecisionQuery("No. 21-123", {
        grammar: DECISION_DOCKET_GRAMMARS.USA,
      }),
    ).toEqual({ type: "identifier", kind: "docket", value: "No. 21-123" });
    expect(
      parseDecisionQuery("2079", { grammar: DECISION_DOCKET_GRAMMARS.USA }),
    ).toEqual({ type: "text", text: "2079" });
  });

  test("unscoped, those forms read and compare as they did before any scope declared them", () => {
    for (const text of ["10-12", "No. 5", "20A87", "No. 8, Orig."]) {
      expect(parseDecisionQuery(text)).toEqual({ type: "text", text });
    }
    // `no.5` against `5`: the generic key keeps the two apart.
    expect(exactDecisionMatches(docketRef("No. 5"), [hit("5")])).toEqual([]);
    // The generic key reads a trailing number as a sheet, so both are `10`.
    expect(exactDecisionMatches(docketRef("10-12"), [hit("10-34")])).toEqual([
      hit("10-34"),
    ]);
  });

  test("a Polish division split across tokens keeps the same identity", () => {
    expect(
      exactDecisionMatches(docketRef("III AUa 999999/99"), [
        hit("III A Ua 999999/99"),
      ]),
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
    expect(exactDecisionMatches(docketRef("65 A 3/2025"), hits)).toHaveLength(
      2,
    );
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
    expect(exactDecisionMatches(docketRef("III AKz 12/23"), hits)).toHaveLength(
      1,
    );
    expect(exactDecisionMatches(docketRef("III AKz 13/23"), hits)).toEqual([]);
  });

  test("an ECLI matches the hit that carries it", () => {
    const hits = [
      hit("22 Cdo 2653/2012", "ECLI:CZ:NS:2014:22.CDO.2653.2012.1"),
    ];
    expect(
      exactDecisionMatches(ecliRef("ecli:cz:ns:2014:22.cdo.2653.2012.1"), hits),
    ).toHaveLength(1);
    expect(
      exactDecisionMatches(ecliRef("ECLI:CZ:NS:2014:99.CDO.1.2000.1"), hits),
    ).toEqual([]);
  });

  describe("typed citations", () => {
    const brown = {
      caseNumber: "1",
      ecli: null,
      identifiers: [
        { type: "case-number", value: "1" },
        { type: "reporter-citation", value: "347 U. S. 483" },
        { type: "reporter-citation", value: "98 Law. Ed. 873" },
      ],
    };
    const reporters = decisionReporterGrammarForJurisdiction("USA");
    const other = {
      caseNumber: "347",
      ecli: null,
      identifiers: [{ type: "reporter-citation", value: "347 U.S. 484" }],
    };

    test("a reporter citation matches its parallel spellings, not a neighbouring page", () => {
      expect(
        exactDecisionMatches(reporterRef("347 U.S. 483"), [brown, other], {
          reporters,
        }),
      ).toEqual([brown]);
      // A variant abbreviation is the same reporter only through the grammar.
      expect(
        exactDecisionMatches(reporterRef("98 L. Ed. 873"), [brown, other], {
          reporters,
        }),
      ).toEqual([brown]);
      expect(
        exactDecisionMatches(reporterRef("98 L. Ed. 873"), [brown, other]),
      ).toEqual([]);
      expect(
        exactDecisionMatches(reporterRef("347 U.S. 485"), [brown], {
          reporters,
        }),
      ).toEqual([]);
    });

    test("a typed reference matches only an identifier of its own type", () => {
      const docketOnly = {
        caseNumber: "347 U.S. 483",
        ecli: null,
        identifiers: [{ type: "case-number", value: "347 U.S. 483" }],
      };
      expect(
        exactDecisionMatches(reporterRef("347 U.S. 483"), [docketOnly]),
      ).toEqual([]);

      const neutral = {
        caseNumber: "1",
        ecli: null,
        identifiers: [{ type: "neutral-citation", value: "[2020] UKSC 1" }],
      };
      expect(
        exactDecisionMatches({ kind: "neutral", value: "[2020] uksc 1" }, [
          neutral,
        ]),
      ).toEqual([neutral]);
      expect(
        exactDecisionMatches(reporterRef("[2020] UKSC 1"), [neutral]),
      ).toEqual([]);
    });
  });
});
