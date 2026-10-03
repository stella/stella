import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { caseLawCorpusQueryFields } from "./corpus-index-read-contract";
import {
  CORPUS_QUERY_LEAF_BUDGET,
  corpusFreeTextClause,
  quoteCorpusValue,
  partitionCorpusFunctionWords,
  tokenizeCorpusFreeText,
  type CorpusFreeTextOptions,
} from "./corpus-query";
import type { CorpusIndexQueryVariant } from "./corpus-query-variant-policy";
import { stemSlovakUpstream } from "./morphology/slovak";
import { stemCorpusText } from "./morphology/stem-text";

const legacyFields = ["text_stem", "headnote_stem"] as const;
const slovakOptions = {
  ...caseLawCorpusQueryFields({
    generation: "case_law_v7",
    jurisdiction: "SVK",
    language: undefined,
  }),
  jurisdiction: "SVK",
  slovakLegacyStemFields: legacyFields,
} as const;

const clause = (
  text: string,
  queryVariant: CorpusIndexQueryVariant,
  extra: Omit<CorpusFreeTextOptions, "queryVariant"> = {},
) => corpusFreeTextClause(text, { ...slovakOptions, ...extra, queryVariant });

const leavesIn = (text: string): string[] =>
  Array.from(
    text.matchAll(/(?:[a-z_]+:)?"(?:[^"\\]|\\["\\])*"/gu),
    ([leaf]) => leaf,
  );

test("corpus-query-core-stems-first/exact Slovak queries retain primary and faithful core leaves", () => {
  const cases = [
    {
      text: "vydržanie vlastníckeho práva k pozemku dobromyseľnosť",
      faithful: 'text_stem:"vydržani"',
    },
    {
      // This spelling has identical faithful and extended stems.
      text: "§ 63 ods. 1 pism. b) zakonnika prace vypoved pre nadbytocnost",
      faithful: 'text_stem:"nadbytocnost"',
    },
    {
      // Stale projections containing obohateniu need re-projection; this query
      // reserves its same-token obohateni stem without inferring inflections.
      text: "§ 451 Občianskeho zákonníka bezdôvodné obohatenie",
      faithful: 'text_stem:"obohateni"',
    },
  ] as const;

  for (const { text, faithful } of cases) {
    const baseline = clause(text, "off");
    const candidate = clause(text, "sk-core-stems-first");
    expect(baseline).not.toBeNull();
    expect(candidate).not.toBeNull();
    expect(baseline).not.toContain(faithful);
    expect(candidate).toContain(faithful);
    expect(clause(text, "off")).toBe(baseline);
  }

  const single =
    clause("vydržanie", "sk-core-stems-first", {
      expand: (term) => [`${term}alt`],
      legalAlternatives: (term) => [`${term}legal`],
    }) ?? "";
  expect(single.indexOf('text_stem:"vydržani"')).toBeGreaterThan(
    single.indexOf('text_stem:"vydržan"'),
  );
});

test(
  "corpus-query-core-stems-first/budget-and-typed-surface-preserved",
  () => {
    assertProperty(
      "corpus-query-core-stems-first/budget-and-typed-surface-preserved",
      fc.property(
        fc.array(
          fc.constantFrom(
            "vydržanie",
            "vlastníckeho",
            "pozemku",
            "dobromyseľnosť",
            "obohatenie",
            "nadbytocnost",
          ),
          { minLength: 1, maxLength: 40 },
        ),
        fc.constantFrom("all", "any"),
        fc.integer({ min: 0, max: 5 }),
        fc.constantFrom(
          "sk-core-stems-first",
          "provision-refs-sk-core-stems-first",
        ),
        (terms, match, expansionCount, queryVariant) => {
          const text = terms.join(" ");
          const candidate = clause(text, queryVariant, {
            match,
            expand: () =>
              Array.from(
                { length: expansionCount },
                (_, index) => `forma${index}`,
              ),
            legalAlternatives: () => ["premlčanie", "náhrada"],
          });
          expect(candidate).not.toBeNull();
          const leaves = leavesIn(candidate ?? "");
          expect(leaves.length).toBeLessThanOrEqual(
            match === "all"
              ? Math.max(CORPUS_QUERY_LEAF_BUDGET, terms.length)
              : CORPUS_QUERY_LEAF_BUDGET,
          );
          const { required } = partitionCorpusFunctionWords(
            tokenizeCorpusFreeText(text),
            slovakOptions.functionWords,
          );
          for (const token of required.slice(
            0,
            match === "any" ? CORPUS_QUERY_LEAF_BUDGET : required.length,
          )) {
            expect(candidate).toContain(quoteCorpusValue(token.value));
            if (required.length <= CORPUS_QUERY_LEAF_BUDGET / 2) {
              expect(candidate).toContain(
                `text_stem:${quoteCorpusValue(stemCorpusText(token.value, "sk"))}`,
              );
            }
            if (required.length <= CORPUS_QUERY_LEAF_BUDGET / 3) {
              const normalized = token.value.normalize("NFC").toLowerCase();
              const faithful = stemSlovakUpstream(normalized) || normalized;
              expect(candidate).toContain(
                `text_stem:${quoteCorpusValue(faithful)}`,
              );
            }
          }
        },
      ),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "corpus-query-core-stems-first/off non-Slovak and missing-legacy-fields stay byte-identical",
  () => {
    assertProperty(
      "corpus-query-core-stems-first/off non-Slovak and missing-legacy-fields stay byte-identical",
      fc.property(
        fc.array(
          fc.constantFrom("vydržanie", "pozemku", "obohatenie", "náhrada"),
          { minLength: 1, maxLength: 18 },
        ),
        (terms) => {
          const text = terms.join(" ");
          expect(clause(text, "off")).toBe(
            corpusFreeTextClause(text, slovakOptions),
          );
          expect(
            corpusFreeTextClause(text, {
              ...caseLawCorpusQueryFields({
                generation: "case_law_v7",
                jurisdiction: "CZE",
                language: undefined,
              }),
              jurisdiction: "CZE",
              slovakLegacyStemFields: legacyFields,
              queryVariant: "sk-core-stems-first",
            }),
          ).toBe(
            corpusFreeTextClause(text, {
              ...caseLawCorpusQueryFields({
                generation: "case_law_v7",
                jurisdiction: "CZE",
                language: undefined,
              }),
              jurisdiction: "CZE",
              slovakLegacyStemFields: legacyFields,
              queryVariant: "off",
            }),
          );
          expect(
            corpusFreeTextClause(text, {
              ...slovakOptions,
              slovakLegacyStemFields: [],
              queryVariant: "sk-core-stems-first",
            }),
          ).toBe(
            corpusFreeTextClause(text, {
              ...slovakOptions,
              slovakLegacyStemFields: [],
              queryVariant: "off",
            }),
          );
        },
      ),
    );
  },
  propertyTestTimeout(5000),
);

test("corpus-query-core-stems-first/provision behavior composes explicitly", () => {
  const text = "§ 106 ods. 1 zákona OZ premlčanie";
  const options = slovakOptions;
  const provision = corpusFreeTextClause(text, {
    ...options,
    queryVariant: "provision-refs",
  });
  const combined = corpusFreeTextClause(text, {
    ...options,
    queryVariant: "provision-refs-sk-core-stems-first",
  });

  expect(provision).not.toBeNull();
  expect(combined).not.toBeNull();
  expect(provision).toContain('("106"');
  expect(combined).toContain('("106"');
  expect(combined).not.toMatch(/AND \("(?:ods|1|zákona)"/u);
  expect(combined).toContain('"OZ"');
  expect(combined).toContain('"premlčanie"');
  expect(combined).toContain('text_stem:"premlčani"');
});

test("corpus-query-core-stems-first/phrases and exhausted budgets do not gain reserved leaves", () => {
  const phrase = '"vydržanie vlastníckeho"';
  expect(clause(phrase, "sk-core-stems-first")).toBe(clause(phrase, "off"));

  for (const count of [24, 25, 30]) {
    const text = Array.from({ length: count }, () => "vydržanie").join(" ");
    expect(clause(text, "sk-core-stems-first")).toBe(clause(text, "off"));
  }
});
