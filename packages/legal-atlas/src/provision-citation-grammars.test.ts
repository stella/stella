import { describe, expect, test } from "bun:test";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { isPublicLegislationCountry } from "@stll/api-contract/legislation-publication";

import {
  createProvisionCitationGrammar,
  PROVISION_CITATION_GRAMMARS,
  locateGazetteCitations,
} from "./provision-citation-grammars";

type GrammarFixture = {
  /** Anchors of the abbreviated provisions, in reading order. */
  anchors: readonly string[];
  /** ELIs of the works cited by gazette number, in reading order. */
  gazette: readonly string[];
  /** A sentence in the jurisdiction's own citation style. */
  text: string;
};

/** One real sentence per grammar; a jurisdiction without a grammar has none. */
const FIXTURES = {
  AUT: null,
  CZE: {
    anchors: ["par_46-odst_1-pism_a", "par_60-odst_3", "par_120"],
    gazette: ["https://www.e-sbirka.cz/eli/cz/sb/2005/485"],
    text: "Soud návrh odmítl podle § 46 odst. 1 písm. a) s. ř. s. a o nákladech rozhodl podle § 60 odst. 3 ve spojení s § 120 s. ř. s.; vyhláška č. 485/2005 Sb. byla zrušena.",
  },
  EU: null,
  POL: null,
  SVK: null,
} as const satisfies Record<CaseLawJurisdiction, GrammarFixture | null>;

const czech = PROVISION_CITATION_GRAMMARS.CZE;

const testGrammar = (
  abbreviations: readonly { eli: string; patternSource: string }[],
) =>
  createProvisionCitationGrammar({
    abbreviations: abbreviations.map((entry) => ({
      canonicalAbbreviation: "test.",
      ...entry,
    })),
    anchor: (reference) => `par_${String(reference.section)}`,
    connectors: [","],
    gazette: {
      eli: ({ number, year }) => `https://example.test/${year}/${number}`,
      source: String.raw`(?<number>\d+)\/(?<year>\d{4}) Gz\.`,
    },
    jurisdiction: "EU",
    provisionSource: String.raw`§\s*(?<section>\d+)`,
    unit: "section",
  });

describe("provision citation grammars", () => {
  test.each([...CASE_LAW_JURISDICTIONS])(
    "%s reads its own fixture, or declares no grammar",
    (jurisdiction) => {
      const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
      const fixture = FIXTURES[jurisdiction];
      if (grammar.status === "unsupported") {
        expect(fixture).toBeNull();
        return;
      }
      if (fixture === null) {
        throw new Error(`${jurisdiction} has a grammar but no fixture`);
      }
      const provisions = grammar.locateAbbreviatedProvisions(fixture.text);
      expect(provisions.map(({ anchor }) => anchor)).toEqual([
        ...fixture.anchors,
      ]);
      expect(
        provisions.every(
          ({ jurisdiction: cited }) => cited === grammar.jurisdiction,
        ),
      ).toBe(true);
      expect(
        grammar.locateGazetteCitations(fixture.text).map(({ eli }) => eli),
      ).toEqual([...fixture.gazette]);
    },
  );

  test("a grammar exists only where the legislation corpus can open the act", () => {
    for (const grammar of Object.values(PROVISION_CITATION_GRAMMARS)) {
      if (grammar.status === "supported") {
        expect(isPublicLegislationCountry(grammar.jurisdiction)).toBe(true);
      }
    }
  });

  test("gazette citations are read with every grammar, whoever cites them", () => {
    const text = "podľa vyhlášky č. 485/2005 Sb. a zákona č. 300/2005 Z. z.";

    expect(
      locateGazetteCitations(text).map(({ eli, jurisdiction }) => ({
        eli,
        jurisdiction,
      })),
    ).toEqual([
      {
        eli: "https://www.e-sbirka.cz/eli/cz/sb/2005/485",
        jurisdiction: "CZE",
      },
    ]);
  });

  test("located spans are the printed provisions, not the chain", () => {
    const text = "podle § 60 odst. 3 ve spojení s § 120 s. ř. s.";

    expect(
      czech
        .locateAbbreviatedProvisions(text)
        .map(({ end, start }) => text.slice(start, end)),
    ).toEqual(["§ 60 odst. 3", "§ 120"]);
  });

  test.each(["s. ř. s.", "s.ř.s.", "s ř s", "S. Ř. S."])(
    "%p resolves to soudní řád správní",
    (printed) => {
      expect(
        czech
          .locateAbbreviatedProvisions(`podle § 46 odst. 1 ${printed}`)
          .map(({ abbreviation }) => abbreviation),
      ).toEqual([
        {
          canonicalAbbreviation: "s. ř. s.",
          eli: "https://www.e-sbirka.cz/eli/cz/sb/2002/150",
        },
      ]);
    },
  );

  test("an unregistered abbreviation or a prefix inside a word links nothing", () => {
    expect(czech.locateAbbreviatedProvisions("podle § 5 o. s. ř.")).toEqual([]);
    expect(
      czech.locateAbbreviatedProvisions("podle § 60 s.ř.sometext"),
    ).toEqual([]);
  });

  test("uppercase provision suffixes normalize to statute anchors", () => {
    expect(
      czech
        .locateAbbreviatedProvisions("podle § 46A odst. 1B písm. C) S. Ř. S.")
        .map(({ anchor }) => anchor),
    ).toEqual(["par_46a-odst_1b-pism_c"]);
  });

  test("case-law reporters and the treaty collection are not statutes", () => {
    expect(
      czech.locateGazetteCitations("č. 12/2020 Sb. NSS; 67/2013 Sb. m. s."),
    ).toEqual([]);
  });

  test("an abbreviation two entries accept resolves to neither", () => {
    const ambiguous = testGrammar([
      { eli: "https://example.test/one", patternSource: String.raw`test\.` },
      { eli: "https://example.test/two", patternSource: String.raw`test\.` },
    ]);

    expect(ambiguous.locateAbbreviatedProvisions("§ 1 test.")).toEqual([]);
  });

  test("NFC-equivalent spellings resolve without changing punctuation", () => {
    const unicode = testGrammar([
      {
        eli: "https://example.test/unicode",
        patternSource: String.raw`tést\.`,
      },
    ]);

    expect(
      unicode
        .locateAbbreviatedProvisions("§ 1 tést.")
        .map(({ abbreviation }) => abbreviation.eli),
    ).toEqual(["https://example.test/unicode"]);
    expect(unicode.locateAbbreviatedProvisions("§ 1 tést")).toEqual([]);
  });

  test("a grammar without abbreviations still reads its gazette", () => {
    const gazetteOnly = testGrammar([]);

    expect(gazetteOnly.locateAbbreviatedProvisions("§ 1 test.")).toEqual([]);
    expect(
      gazetteOnly
        .locateGazetteCitations("see 12/2020 Gz.")
        .map(({ eli }) => eli),
    ).toEqual(["https://example.test/2020/12"]);
  });
});
