import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  EU_PROVISION_CITATION_LANGUAGES,
  locateEuProvisionCitations,
} from "./eu-provision-citations";
import type { EuActIdentity } from "./eu-provision-citations";

type SecondaryActKind = Extract<EuActIdentity, { number: number }>["kind"];
type CitationLanguage = (typeof EU_PROVISION_CITATION_LANGUAGES)[number];

const ACT_IDENTIFIERS = {
  directive: { kind: "directive", celexLetter: "L", eliKind: "dir" },
  regulation: { kind: "regulation", celexLetter: "R", eliKind: "reg" },
} as const satisfies Record<
  SecondaryActKind,
  { kind: SecondaryActKind; celexLetter: string; eliKind: string }
>;

const CITATION_TEMPLATES = {
  cs: {
    directive: "čl. {article} směrnice ({marker}) {identifier}",
    regulation: "čl. {article} nařízení ({marker}) {identifier}",
  },
  sk: {
    directive: "čl. {article} smernice ({marker}) {identifier}",
    regulation: "čl. {article} nariadenia ({marker}) {identifier}",
  },
  pl: {
    directive: "art. {article} dyrektywy ({marker}) {identifier}",
    regulation: "art. {article} rozporządzenia ({marker}) {identifier}",
  },
  hu: {
    directive: "{article}. cikk {identifier}/{marker} irányelv",
    regulation: "{article}. cikk {identifier}/{marker} rendelet",
  },
  en: {
    directive: "Article {article} of Directive ({marker}) {identifier}",
    regulation: "Article {article} of Regulation ({marker}) {identifier}",
  },
  de: {
    directive: "Artikel {article} der Richtlinie ({marker}) {identifier}",
    regulation: "Artikel {article} der Verordnung ({marker}) {identifier}",
  },
  fr: {
    directive: "Article {article} de la directive ({marker}) {identifier}",
    regulation: "Article {article} du règlement ({marker}) {identifier}",
  },
} as const satisfies Record<CitationLanguage, Record<SecondaryActKind, string>>;

const NUMBERING_ERAS = {
  legacy: { name: "legacy", year: fc.integer({ min: 1950, max: 2014 }) },
  modern: { name: "modern", year: fc.integer({ min: 2015, max: 2020 }) },
} as const;

const CITATION_MARKERS = {
  cs: { legacy: "ES", modern: "EU" },
  sk: { legacy: "ES", modern: "EÚ" },
  pl: { legacy: "WE", modern: "UE" },
  hu: { legacy: "EK", modern: "EU" },
  en: { legacy: "EC", modern: "EU" },
  de: { legacy: "EG", modern: "EU" },
  fr: { legacy: "CE", modern: "UE" },
} as const satisfies Record<
  CitationLanguage,
  Record<keyof typeof NUMBERING_ERAS, string>
>;

describe("EU provision citation language, act-kind and numbering-era matrix", () => {
  test("eu-provision-matrix-preserves-language-kind-era-identities", () => {
    assertProperty(
      "eu-provision-matrix-preserves-language-kind-era-identities",
      fc.property(
        fc.record({
          legacyYear: NUMBERING_ERAS.legacy.year,
          modernYear: NUMBERING_ERAS.modern.year,
          number: fc.oneof(
            fc.integer({ min: 1, max: 999 }),
            // Numbers resembling modern short years expose legacy-order ambiguity.
            fc.integer({ min: 15, max: 20 }),
          ),
          article: fc.integer({ min: 1, max: 500 }),
        }),
        ({ legacyYear, modernYear, number, article }) => {
          for (const language of EU_PROVISION_CITATION_LANGUAGES) {
            for (const { kind, celexLetter, eliKind } of Object.values(
              ACT_IDENTIFIERS,
            )) {
              for (const { name: era } of Object.values(NUMBERING_ERAS)) {
                const year = era === "legacy" ? legacyYear : modernYear;
                // Modern instruments use a four-digit year; legacy citations
                // must retain the same identity with either year spelling.
                const printedYears =
                  era === "legacy"
                    ? [String(year), String(year % 100).padStart(2, "0")]
                    : [String(year)];
                for (const printedYear of printedYears) {
                  const identifier =
                    era === "legacy" && kind === "regulation"
                      ? `${String(number)}/${printedYear}`
                      : `${printedYear}/${String(number)}`;
                  const printed = CITATION_TEMPLATES[language][kind]
                    .replace("{article}", () => String(article))
                    .replace("{identifier}", () => identifier)
                    .replace("{marker}", () => CITATION_MARKERS[language][era]);
                  const citations = locateEuProvisionCitations(printed, {
                    citedOn: "2020-12-31",
                  });
                  expect(citations).toHaveLength(1);
                  expect(citations.at(0)).toMatchObject({
                    jurisdiction: "EU",
                    start: 0,
                    end: printed.length,
                    act: {
                      kind,
                      number,
                      year,
                      celex: `3${String(year)}${celexLetter}${String(number).padStart(4, "0")}`,
                      eli: `http://data.europa.eu/eli/${eliKind}/${String(year)}/${String(number)}/oj`,
                    },
                    reference: { unit: "article", section: article },
                  });
                  if (era === "modern") {
                    const shortPrinted = printed.replace(String(year), () =>
                      String(year % 100).padStart(2, "0"),
                    );
                    // A short spelling may name legacy law, never a modern year.
                    for (const { act } of locateEuProvisionCitations(
                      shortPrinted,
                      {
                        citedOn: "2020-12-31",
                      },
                    )) {
                      expect(Number(act.celex.slice(1, 5))).toBeLessThan(2015);
                    }
                  }
                }
              }
            }
          }
        },
      ),
    );
  });

  test("a legacy regulation's two short components retain number/year order", () => {
    expect(
      locateEuProvisionCitations("Article 5 of Regulation (EEC) 17/62", {
        citedOn: "2020-12-31",
      }).map(({ act }) => act.celex),
    ).toEqual(["31962R0017"]);
  });

  test("a Hungarian directive follows the article-before-instrument grammar", () => {
    expect(
      locateEuProvisionCitations("5. cikk 2019/1937/EU irányelv", {
        citedOn: "2020-12-31",
      }).map(({ act }) => act.celex),
    ).toEqual(["32019L1937"]);
  });
});
