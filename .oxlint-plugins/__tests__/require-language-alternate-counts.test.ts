import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("requires every public search implementation to invoke alternate reads", async () => {
  expect(
    await lintSingleRule(
      "require-language-alternate-counts",
      "function searchPostgresDecisions() { return []; }\nconst searchCorpusIndexDecisions = () => [];\nconst listCaseLawProvisionDecisions = () => [];",
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([1, 2, 3]);
});

test("rejects references and deferred callbacks instead of direct search-path reads", async () => {
  expect(
    await lintSingleRule(
      "require-language-alternate-counts",
      "function searchPostgresDecisions() { return readPublicDecisionLanguageAlternatesByGroup; }\nconst searchCorpusIndexDecisions = () => { const later = () => readPublicDecisionLanguageAlternatesByGroup(); return later; };\nconst listCaseLawProvisionDecisions = () => readPublicDecisionLanguageAlternatesByGroup;",
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([1, 2, 3]);
});

test("accepts direct calls in declaration arrow and function-expression implementations", async () => {
  expect(
    await lintSingleRule(
      "require-language-alternate-counts",
      'import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";\nfunction searchPostgresDecisions() { return readPublicDecisionLanguageAlternatesByGroup(); }\nconst searchCorpusIndexDecisions = function() { return readPublicDecisionLanguageAlternatesByGroup(); };\nconst listCaseLawProvisionDecisions = async () => readPublicDecisionLanguageAlternatesByGroup();',
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([]);
});

test("reports the absent search implementation at the program boundary", async () => {
  expect(
    await lintSingleRule(
      "require-language-alternate-counts",
      'import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";\nconst searchPostgresDecisions = () => readPublicDecisionLanguageAlternatesByGroup();\nconst listCaseLawProvisionDecisions = () => readPublicDecisionLanguageAlternatesByGroup();',
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([1]);
});

test("requires the canonical reader binding rather than a local spelling", async () => {
  const results = await Promise.all(
    [
      'import { readPublicDecisionLanguageAlternatesByGroup } from "./other-reader";',
      "const readPublicDecisionLanguageAlternatesByGroup = () => [];",
    ].map(async (lintCase, index) => {
      const setup = lintCase;

      return {
        label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
        result: await lintSingleRule(
          "require-language-alternate-counts",
          `${setup}\nfunction searchPostgresDecisions() { return readPublicDecisionLanguageAlternatesByGroup(); }\nconst searchCorpusIndexDecisions = () => readPublicDecisionLanguageAlternatesByGroup();\nconst listCaseLawProvisionDecisions = () => readPublicDecisionLanguageAlternatesByGroup();`,
          { plugin: "public-law-read-boundary" },
        ),
        expected: [2, 3, 4],
      };
    }),
  );
  expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
    results.map(({ label, expected }) => ({ label, result: expected })),
  );
});

test("resolves canonical reader aliases and lexical shadowing", async () => {
  expect(
    await lintSingleRule(
      "require-language-alternate-counts",
      'import { readPublicDecisionLanguageAlternatesByGroup as read } from "@/api/lib/case-law/language-alternates";\nfunction searchPostgresDecisions() { return read(); }\nconst searchCorpusIndexDecisions = read => read();\nconst listCaseLawProvisionDecisions = () => read();',
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([3]);
});
