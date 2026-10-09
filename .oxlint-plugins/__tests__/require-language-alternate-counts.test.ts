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
      'import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";\nfunction searchPostgresDecisions() { return readPublicDecisionLanguageAlternatesByGroup(); }\nconst searchCorpusIndexDecisions = function() { return readPublicDecisionLanguageAlternatesByGroup(); };',
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([]);
});

test("reports the absent search implementation at the program boundary", async () => {
  expect(
    await lintSingleRule(
      "require-language-alternate-counts",
      'import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";\nconst searchPostgresDecisions = () => readPublicDecisionLanguageAlternatesByGroup();',
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([1]);
});

test("requires the canonical reader binding rather than a local spelling", async () => {
  for (const setup of [
    'import { readPublicDecisionLanguageAlternatesByGroup } from "./other-reader";',
    "const readPublicDecisionLanguageAlternatesByGroup = () => [];",
  ]) {
    expect(
      await lintSingleRule(
        "require-language-alternate-counts",
        `${setup}\nfunction searchPostgresDecisions() { return readPublicDecisionLanguageAlternatesByGroup(); }\nconst searchCorpusIndexDecisions = () => readPublicDecisionLanguageAlternatesByGroup();`,
        { plugin: "public-law-read-boundary" },
      ),
    ).toEqual([2, 3]);
  }
});

test("resolves canonical reader aliases and lexical shadowing", async () => {
  expect(
    await lintSingleRule(
      "require-language-alternate-counts",
      'import { readPublicDecisionLanguageAlternatesByGroup as read } from "@/api/lib/case-law/language-alternates";\nfunction searchPostgresDecisions() { return read(); }\nconst searchCorpusIndexDecisions = read => read();',
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([3]);
});
