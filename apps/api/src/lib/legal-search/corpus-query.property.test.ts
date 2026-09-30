import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  caseLawCorpusQuery,
  CORPUS_QUERY_LEAF_BUDGET,
  corpusFreeTextClause,
  quoteCorpusValue,
  tokenizeCorpusFreeText,
} from "./corpus-query";
import { corpusTokens } from "./corpus-tokens";
import { stemCorpusText } from "./morphology/stem-text";

const hostileText = fc
  .array(
    fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.constantFrom(
        '"',
        "\\",
        "AND",
        "OR",
        "NOT",
        ":",
        "*",
        "~",
        "(",
        ")",
        "+",
        "-",
        "„",
        "“",
        "”",
        "«",
        "»",
        "nájem",
        "\n",
        "\u0000",
      ),
    ),
    { maxLength: 30 },
  )
  .map((parts) => parts.join(""));

const quotedTerm = /^"(?:[^"\\]|\\["\\])*"$/su;
const leavesOf = (query: string): string[] =>
  Array.from(
    query.matchAll(/(?:[a-z_]+:)?"(?:[^"\\]|\\["\\])*"/gu),
    ([leaf]) => leaf,
  );
const word = fc.stringMatching(/^[a-z]{1,10}$/u);
const words = fc.array(word, { minLength: 1, maxLength: 48 });
const options = fc.record({
  alternatives: fc.array(
    hostileText.map((value) => `variant ${value}`),
    { maxLength: 6 },
  ),
  surfaceCount: fc.integer({ min: 0, max: 4 }),
  keywordCount: fc.integer({ min: 0, max: 4 }),
  stemCount: fc.integer({ min: 0, max: 3 }),
  legal: fc.array(
    word.map((value) => `legal ${value}`),
    { maxLength: 3 },
  ),
});

test(
  "quoted values occupy one lexical term and retain their content",
  () => {
    fc.assert(
      fc.property(hostileText, (value) => {
        const quoted = quoteCorpusValue(value);
        expect(quoted).toMatch(quotedTerm);
        expect(quoted.slice(1, -1).replace(/\\(["\\])/gu, "$1")).toBe(value);
        const query = caseLawCorpusQuery({
          text: "needle",
          jurisdiction: undefined,
          filters: { source: value },
        });
        expect(query).toBe(
          value ? `("needle") AND source:${quoted}` : '("needle")',
        );
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "free-text tokenization retains the searchable word sequence",
  () => {
    fc.assert(
      fc.property(hostileText, (text) => {
        expect(
          tokenizeCorpusFreeText(text).flatMap(({ value }) =>
            corpusTokens(value),
          ),
        ).toEqual(corpusTokens(text));
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "expansion obeys its budget and preserves complete leaf groups",
  () => {
    fc.assert(
      fc.property(
        words,
        options,
        (
          terms,
          { alternatives, surfaceCount, keywordCount, stemCount, legal },
        ) => {
          const surfaceFields = Array.from(
            { length: surfaceCount },
            (_, index) => `surface_${"a".repeat(index + 1)}`,
          );
          const keywordFields = Array.from(
            { length: keywordCount },
            (_, index) => `keywords_${"a".repeat(index + 1)}`,
          );
          const stemFields = Array.from(
            { length: stemCount },
            (_, index) => `stem_${"a".repeat(index + 1)}`,
          );
          const stemsOf = (value: string) => {
            const stem = stemCorpusText(value, "cs");
            return stem === ""
              ? []
              : stemFields.map((field) => `${field}:${quoteCorpusValue(stem)}`);
          };
          const query = corpusFreeTextClause(terms.join(" "), {
            expand: () => alternatives,
            surfaceFields,
            keywordFields,
            stemming: { language: "cs", fields: stemFields },
            legalAlternatives: () => legal,
          });
          expect(query).not.toBeNull();
          const leaves = leavesOf(query ?? "");
          expect(leaves.length).toBeLessThanOrEqual(
            Math.max(CORPUS_QUERY_LEAF_BUDGET, terms.length),
          );
          if (terms.length >= CORPUS_QUERY_LEAF_BUDGET) {
            expect(leaves).toEqual(terms.map(quoteCorpusValue));
          }
          let offset = 0;
          for (const term of terms) {
            expect(leaves.at(offset)).toBe(quoteCorpusValue(term));
            offset += 1;
            const surface = [
              ...alternatives.map(quoteCorpusValue),
              ...surfaceFields.map(
                (field) => `${field}:${quoteCorpusValue(term)}`,
              ),
            ];
            const keywords = keywordFields.map(
              (field) => `${field}:${quoteCorpusValue(term)}`,
            );
            const legalLeaves = legal.flatMap((value) => [
              quoteCorpusValue(value),
              ...stemsOf(value),
            ]);
            for (const group of [
              surface,
              stemsOf(term),
              keywords,
              legalLeaves,
            ]) {
              if (group.length === 0 || leaves.at(offset) !== group.at(0)) {
                continue;
              }
              expect(leaves.slice(offset, offset + group.length)).toEqual(
                group,
              );
              offset += group.length;
            }
          }
          expect(offset).toBe(leaves.length);
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "keyword leaves preserve alternatives already granted to every token",
  () => {
    fc.assert(
      fc.property(
        words,
        fc.array(word, { maxLength: 8 }),
        (terms, alternatives) => {
          const base = {
            expand: () => alternatives,
            surfaceFields: ["headnote"],
            stemming: { language: "cs", fields: ["text_stem"] },
          } as const;
          const before = leavesOf(
            corpusFreeTextClause(terms.join(" "), base) ?? "",
          );
          const after = leavesOf(
            corpusFreeTextClause(terms.join(" "), {
              ...base,
              keywordFields: ["keywords"],
            }) ?? "",
          );
          expect(after.filter((leaf) => !leaf.startsWith("keywords:"))).toEqual(
            before,
          );
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);
