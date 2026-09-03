import { expect, test } from "bun:test";

import {
  caseLawCorpusQueryFields,
  corpusIndexReadContract,
} from "@/api/lib/legal-search/corpus-index-read-contract";
import { corpusFreeTextClause } from "@/api/lib/legal-search/corpus-query";

test("legacy and final case-law reads use their declared schema", () => {
  expect(corpusIndexReadContract("case_law", "case_law_v4")).toEqual({
    family: "case_law",
    openingPassageQuery: "seq:0",
    yearFacetField: "year",
    stemFields: null,
    searchableFields: [],
  });
  expect(corpusIndexReadContract("case_law", "case_law_v5")).toEqual({
    family: "case_law",
    openingPassageQuery: "is_opening:true",
    yearFacetField: "decision_year",
    stemFields: null,
    searchableFields: [],
  });
  // What a *bare* term reaches is the index's decision, not the reader's, so
  // the summary changed nothing here; the stem fields did, because only a
  // query naming them explicitly can reach them.
  expect(corpusIndexReadContract("case_law", "case_law_v6")).toEqual({
    family: "case_law",
    openingPassageQuery: "is_opening:true",
    yearFacetField: "decision_year",
    stemFields: { text: "text_stem", publisherSummary: "headnote_stem" },
    searchableFields: ["headnote"],
  });
});

test("legislation reads derive the final opening marker", () => {
  expect(corpusIndexReadContract("legislation", "legislation_v1")).toEqual({
    family: "legislation",
    openingPassageQuery: "seq:0",
  });
  expect(corpusIndexReadContract("legislation", "legislation_v2")).toEqual({
    family: "legislation",
    openingPassageQuery: "is_opening:true",
  });
});

test("extra fields and stemming both need a generation that maps them", () => {
  expect(
    caseLawCorpusQueryFields({
      generation: "case_law_v6",
      jurisdiction: "CZE",
      language: undefined,
    }),
  ).toEqual({
    surfaceFields: ["headnote"],
    stemming: { language: "cs", fields: ["text_stem", "headnote_stem"] },
  });
  // Slovak has a stemmer but no published expansion dictionary; the two are
  // separate questions and only the dictionary one is answered elsewhere.
  expect(
    caseLawCorpusQueryFields({
      generation: "case_law_v6",
      jurisdiction: "SVK",
      language: undefined,
    }).stemming,
  ).toEqual({ language: "sk", fields: ["text_stem", "headnote_stem"] });
  // A generation whose indexes never mapped the fields: naming one would be
  // an invalid query against a strict mapping, not a narrower one.
  expect(
    caseLawCorpusQueryFields({
      generation: "case_law_v5",
      jurisdiction: "CZE",
      language: undefined,
    }),
  ).toEqual({ surfaceFields: [], stemming: null });
  // The European index carries 24 languages under one jurisdiction, so the
  // jurisdiction alone names none of them.
  expect(
    caseLawCorpusQueryFields({
      generation: "case_law_v6",
      jurisdiction: "EU",
      language: undefined,
    }).stemming,
  ).toBeNull();
  // Unscoped and unfiltered: the index pattern spans every jurisdiction of
  // the generation, so no one language describes the text being matched.
  expect(
    caseLawCorpusQueryFields({
      generation: "case_law_v6",
      jurisdiction: undefined,
      language: undefined,
    }).stemming,
  ).toBeNull();
});

test("the language filter, not the jurisdiction, decides how words stem", () => {
  const stemmingOf = (
    jurisdiction: string | undefined,
    language: string | undefined,
  ) =>
    caseLawCorpusQueryFields({
      generation: "case_law_v6",
      jurisdiction,
      language,
    }).stemming;

  // A filter with no country at all has no jurisdiction to fall back on, and
  // still names the language of the documents it selects.
  expect(stemmingOf(undefined, "cs")).toEqual({
    language: "cs",
    fields: ["text_stem", "headnote_stem"],
  });
  // Agreeing: the same answer either way.
  expect(stemmingOf("CZE", "cs")).toEqual(stemmingOf("CZE", undefined));
  // Disagreeing: the European index carries 24 languages and the jurisdiction
  // names none of them, so only the filter can say what these stems are.
  expect(stemmingOf("EU", "cs")).toEqual({
    language: "cs",
    fields: ["text_stem", "headnote_stem"],
  });
  expect(stemmingOf("CZE", "pl")?.language).toBe("pl");
  // Austria publishes in German, so an unfiltered Austrian search stems the
  // reader's words the way the projection stemmed the decisions.
  expect(stemmingOf("AUT", undefined)?.language).toBe("de");
  // A language no stemmer covers yields none, rather than falling back to the
  // jurisdiction's and stemming against a language the documents are not in.
  // Snowball ships no Bulgarian algorithm.
  expect(stemmingOf("CZE", "bg")).toBeNull();
});

test("a request filtered to German queries the German stems the projection wrote", () => {
  // End to end from the request's language filter to the leaves the engine
  // sees, because the two sides only agree if they pick the same algorithm:
  // the projection stems an Austrian decision with German, so a German
  // filtered query has to emit the same stem.
  const { stemming } = caseLawCorpusQueryFields({
    generation: "case_law_v6",
    jurisdiction: "AUT",
    language: "de",
  });

  expect(corpusFreeTextClause("Mietverträge", { stemming })).toBe(
    '(("Mietverträge" OR text_stem:"mietvertrag" OR headnote_stem:"mietvertrag"))',
  );
});
