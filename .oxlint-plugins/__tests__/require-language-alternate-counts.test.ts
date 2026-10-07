import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("requires both public search implementations to invoke alternate reads", async () => {
  expect(
    await lintSingleRule(
      "require-language-alternate-counts",
      "function searchPostgresDecisions() { return []; }\nconst searchCorpusIndexDecisions = () => [];",
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([1, 2]);
});

test("rejects references and deferred callbacks instead of direct search-path reads", async () => {
  expect(
    await lintSingleRule(
      "require-language-alternate-counts",
      "function searchPostgresDecisions() { return readPublicDecisionLanguageAlternatesByGroup; }\nconst searchCorpusIndexDecisions = () => { const later = () => readPublicDecisionLanguageAlternatesByGroup(); return later; };",
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([1, 2]);
});

test("accepts direct calls in declaration arrow and function-expression implementations", async () => {
  expect(
    await lintSingleRule(
      "require-language-alternate-counts",
      "function searchPostgresDecisions() { return readPublicDecisionLanguageAlternatesByGroup(); }\nconst searchCorpusIndexDecisions = function() { return readPublicDecisionLanguageAlternatesByGroup(); };",
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([]);
});

test("reports the absent search implementation at the program boundary", async () => {
  expect(
    await lintSingleRule(
      "require-language-alternate-counts",
      "const searchPostgresDecisions = () => readPublicDecisionLanguageAlternatesByGroup();",
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([1]);
});
