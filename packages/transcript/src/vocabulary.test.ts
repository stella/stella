import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import {
  budgetVocabulary,
  estimateVocabularyTokens,
  VOCABULARY_BUDGETS,
  VocabularyInputError,
} from "./vocabulary";
import type { VocabularyCandidate } from "./vocabulary";

test("vocabulary keeps ranked Czech and Slovak spelling and distinct inflections", () => {
  const candidates = [
    { term: "ZOFIA HRUSKOVA", kind: "person", weight: 1 },
    { term: "Žofia Hrušková", kind: "party", weight: 4 },
    { term: "Žofii Hruškové", kind: "person", weight: 3 },
    { term: "Žofie Hruškové", kind: "person", weight: 3 },
    { term: "  ŽOFIA   HRUŠKOVÁ  ", kind: "glossary", weight: 2 },
    { term: "Řehoř Vřesovec", kind: "person", weight: 3, lastUsedAt: 20 },
    { term: "Řehoř Vřesovec", kind: "person", weight: 3, lastUsedAt: 10 },
  ] as const satisfies readonly VocabularyCandidate[];
  const selection = budgetVocabulary({
    candidates,
    mechanism: "groq-prompt",
  }).unwrap();
  expect(selection.terms).toEqual([
    "Žofia Hrušková",
    "Řehoř Vřesovec",
    "Žofii Hruškové",
    "Žofie Hruškové",
  ]);
  expect(selection.mechanism).toBe("groq-prompt");
  if (selection.mechanism === "groq-prompt") {
    expect(selection.prompt).toBe(selection.terms.join(", "));
  }
  expect(candidates.at(0)?.term).toBe("ZOFIA HRUSKOVA");
});

test("vocabulary deduplicates canonically equivalent Unicode without changing selected spelling", () => {
  const decomposed = "Z\u030cofia Hrus\u030ckova\u0301";
  expect(decomposed).not.toBe("Žofia Hrušková");
  expect(
    budgetVocabulary({
      mechanism: "context-hint",
      candidates: [
        { term: "Žofia Hrušková", kind: "person", weight: 2 },
        { term: decomposed, kind: "person", weight: 1 },
      ],
    }).unwrap().terms,
  ).toEqual(["Žofia Hrušková"]);
});

test("vocabulary skips oversized terms and budgets prompt separators", () => {
  const selection = budgetVocabulary({
    mechanism: "groq-prompt",
    candidates: [
      { term: "ř".repeat(601), kind: "document-title", weight: 3 },
      { term: "č".repeat(597), kind: "document-title", weight: 2 },
      { term: "A", kind: "glossary", weight: 1 },
      { term: "B", kind: "glossary", weight: 0 },
    ],
  }).unwrap();
  expect(selection.terms).toEqual(["č".repeat(597), "A"]);
  expect(selection.estimatedTokens).toBe(200);
});

test("vocabulary disables hints and enforces phrase count limits", () => {
  const candidates = Array.from(
    { length: 510 },
    (_, index) =>
      ({
        term: String(index),
        kind: "case-number",
        weight: 1,
      }) as const,
  );
  expect(budgetVocabulary({ candidates, mechanism: "none" }).unwrap()).toEqual({
    mechanism: "none",
    terms: [],
    estimatedTokens: 0,
  });
  const selection = budgetVocabulary({
    candidates,
    mechanism: "azure-phrase-list",
  }).unwrap();
  expect(selection.terms).toHaveLength(500);
  expect(selection.terms.at(0)).toBe("0");
  expect(selection.terms.at(-1)).toBe("499");
});

test("vocabulary rejects malformed ranking inputs", () => {
  for (const candidate of [
    { term: " ", kind: "person", weight: 1 },
    { term: "Žofia", kind: "person", weight: Number.NaN },
    { term: "Žofia", kind: "person", weight: Number.POSITIVE_INFINITY },
    { term: "Žofia", kind: "person", weight: 1, lastUsedAt: -1 },
    { term: "Žofia", kind: "person", weight: 1, lastUsedAt: 1.5 },
    { term: "Žofia", kind: "person", weight: 1, lastUsedAt: Number.NaN },
  ] as const satisfies readonly VocabularyCandidate[]) {
    const result = budgetVocabulary({
      candidates: [candidate],
      mechanism: "context-hint",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(VocabularyInputError);
      expect(result.error.candidateIndex).toBe(0);
    }
  }
});

const mechanismArbitrary = fc.constantFrom(
  "none",
  "groq-prompt",
  "azure-phrase-list",
  "context-hint",
);
const candidate = fc.record({
  term: fc
    .array(
      fc.constantFrom(
        "Žofia",
        "Hrušková",
        "Hruškovej",
        "Řehoř",
        "Vřesovce",
        "🗂️",
      ),
      {
        minLength: 1,
        maxLength: 12,
      },
    )
    .map((words) => words.join(" ")),
  kind: fc.constant("glossary"),
  weight: fc.integer({ min: -100, max: 100 }),
  lastUsedAt: fc.nat(),
});

test("vocabulary always respects count and token budgets with unique stable terms", () => {
  assertProperty(
    "vocabulary always respects count and token budgets with unique stable terms",
    fc.property(
      fc.array(candidate, { maxLength: 200 }),
      mechanismArbitrary,
      (candidates, mechanism) => {
        const selection = budgetVocabulary({ candidates, mechanism }).unwrap();
        const budget = VOCABULARY_BUDGETS[mechanism];
        expect(selection.terms.length).toBeLessThanOrEqual(budget.countLimit);
        expect(selection.estimatedTokens).toBeLessThanOrEqual(
          budget.tokenLimit,
        );
        expect(selection.estimatedTokens).toBe(
          estimateVocabularyTokens(selection.terms.join(", ")),
        );
        expect(new Set(selection.terms.map(foldSearchMatchText)).size).toBe(
          selection.terms.length,
        );
        expect(budgetVocabulary({ candidates, mechanism }).unwrap()).toEqual(
          selection,
        );
        switch (selection.mechanism) {
          case "groq-prompt":
          case "context-hint":
            expect(selection.prompt).toBe(selection.terms.join(", "));
            break;
          case "azure-phrase-list":
          case "none":
            expect("prompt" in selection).toBe(false);
            break;
          default:
            selection satisfies never;
        }
      },
    ),
  );
});

test("vocabulary accepts an equivalent spelling when the higher-ranked form exceeds budget", () => {
  const decomposed = "e\u0301".repeat(600);
  const composed = "é".repeat(600);
  expect(foldSearchMatchText(decomposed)).toBe(foldSearchMatchText(composed));
  expect(estimateVocabularyTokens(decomposed)).toBeGreaterThan(
    VOCABULARY_BUDGETS["groq-prompt"].tokenLimit,
  );
  expect(estimateVocabularyTokens(composed)).toBe(
    VOCABULARY_BUDGETS["groq-prompt"].tokenLimit,
  );
  const selected = budgetVocabulary({
    mechanism: "groq-prompt",
    candidates: [
      { term: decomposed, kind: "glossary", weight: 2 },
      { term: composed, kind: "glossary", weight: 1 },
    ],
  }).unwrap();
  expect(selected.terms).toEqual([composed]);
  expect(selected.estimatedTokens).toBe(200);
});
