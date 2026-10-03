import { expect, test } from "bun:test";
import fc from "fast-check";

import { PROVISION_CITATION_PROFILES } from "@stll/legal-atlas/provision-citation-profiles";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { caseLawCorpusQueryFields } from "./corpus-index-read-contract";
import { readCorpusProvisionMentions } from "./corpus-provision-mentions";
import {
  CORPUS_QUERY_LEAF_BUDGET,
  corpusFreeTextClause,
  partitionCorpusFunctionWords,
  tokenizeCorpusFreeText,
} from "./corpus-query";

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
        "„",
        "“",
        "\n",
        "\u0000",
      ),
    ),
    { maxLength: 12 },
  )
  .map((parts) => parts.join(" "));
const queryPart = fc.oneof(
  hostileText,
  fc.stringMatching(/^[a-z]{1,10}$/u),
  fc.integer({ min: 1, max: 9999 }).map(String),
  fc.constantFrom(
    '"bezdôvodné obohatenie"',
    "„občanského zákoníku“",
    "§ 451 Občianskeho zákonníka",
    "§ 451 obcianskeho zakonnika",
    "§ 106 ods. 1 OZ",
    "§ 2079 občanského zákoníku",
    "§ 2079 NOZ",
    "§ 451 Občianskeho súdneho poriadku",
    "§ 451 zákona č. 40/1964 Zb.",
  ),
);
const queryText = fc
  .array(queryPart, { maxLength: 12 })
  .map((parts) => parts.join(" "));
const options = fc.record({
  jurisdiction: fc.constantFrom(...(["SVK", "CZE"] as const)),
  match: fc.constantFrom(...(["all", "any"] as const)),
  expand: fc.array(hostileText, { maxLength: 4 }),
  legal: fc.array(hostileText, { maxLength: 3 }),
  includeFunctionWords: fc.boolean(),
});

const leafPattern = /(?:[a-z_]+:)?"(?:[^"\\]|\\["\\])*"/gu;

test(
  "corpus-query-variant/off-and-no-mention-byte-identical",
  () => {
    assertProperty(
      "corpus-query-variant/off-and-no-mention-byte-identical",
      fc.property(
        queryText,
        options,
        (
          text,
          { jurisdiction, match, expand, legal, includeFunctionWords },
        ) => {
          const fields = caseLawCorpusQueryFields({
            generation: "case_law_v7",
            jurisdiction,
            language: undefined,
          });
          const clauseOptions = {
            ...fields,
            jurisdiction,
            match,
            expand: () => expand,
            legalAlternatives: () => legal,
            functionWords: includeFunctionWords ? fields.functionWords : null,
          };
          const baseline = corpusFreeTextClause(text, clauseOptions);
          expect(
            corpusFreeTextClause(text, {
              ...clauseOptions,
              queryVariant: "off",
            }),
          ).toBe(baseline);
          const { required } = partitionCorpusFunctionWords(
            tokenizeCorpusFreeText(text),
            clauseOptions.functionWords,
          );
          const mentions = readCorpusProvisionMentions(
            required,
            PROVISION_CITATION_PROFILES[jurisdiction],
          );
          if (mentions.length === 0) {
            expect(
              corpusFreeTextClause(text, {
                ...clauseOptions,
                queryVariant: "provision-refs",
              }),
            ).toBe(baseline);
          }
        },
      ),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "corpus-query-variant/leaves-stay-budgeted-and-quoted",
  () => {
    assertProperty(
      "corpus-query-variant/leaves-stay-budgeted-and-quoted",
      fc.property(
        queryText,
        options,
        (
          text,
          { jurisdiction, match, expand, legal, includeFunctionWords },
        ) => {
          const fields = caseLawCorpusQueryFields({
            generation: "case_law_v7",
            jurisdiction,
            language: undefined,
          });
          const clauseOptions = {
            ...fields,
            jurisdiction,
            match,
            expand: () => expand,
            legalAlternatives: () => legal,
            functionWords: includeFunctionWords ? fields.functionWords : null,
          };
          const clause = corpusFreeTextClause(text, {
            ...clauseOptions,
            queryVariant: "provision-refs",
          });
          if (clause === null) {
            return;
          }
          const baseline = corpusFreeTextClause(text, clauseOptions);
          const { required } = partitionCorpusFunctionWords(
            tokenizeCorpusFreeText(text),
            clauseOptions.functionWords,
          );
          const leaves = Array.from(
            clause.matchAll(leafPattern),
            ([leaf]) => leaf,
          );
          // Unchanged all-token queries retain their baseline even above the expansion budget.
          const limit =
            clause === baseline && match === "all"
              ? Math.max(CORPUS_QUERY_LEAF_BUDGET, required.length)
              : CORPUS_QUERY_LEAF_BUDGET;
          expect(leaves.length).toBeGreaterThan(0);
          expect(leaves.length).toBeLessThanOrEqual(limit);
          // Removing whole quoted leaves leaves only the clause's trusted grammar.
          expect(clause.replace(leafPattern, "")).toMatch(
            /^(?:\s|AND|OR|\(|\))*$/u,
          );
        },
      ),
    );
  },
  propertyTestTimeout(5000),
);
