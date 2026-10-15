import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("reports unclassified dependencies", async () => {
  expect(
    await lintSingleRule(
      "docs-source-policy",
      'docSourcePolicyCase({"dependencies": ["package-a"], "sources": {}, "exclusions": [], "now": "2026-08-27T00:00:00.000Z"});',
      {
        sourcePath:
          ".oxlint-plugins/__fixtures__/docs-source-policy.fixture.ts",
      },
    ),
  ).toEqual([1]);
});

test("reports stale classifications for removed dependencies", async () => {
  expect(
    await lintSingleRule(
      "docs-source-policy",
      'docSourcePolicyCase({"dependencies": [], "sources": {"Example": {"dependencies": ["package-a"], "url": "https://example.com/llms.txt"}}, "exclusions": [], "now": "2026-08-27T00:00:00.000Z"});',
      {
        sourcePath:
          ".oxlint-plugins/__fixtures__/docs-source-policy.fixture.ts",
      },
    ),
  ).toEqual([1]);
});

test("accepts exhaustive sources and a current bounded quarantine", async () => {
  expect(
    await lintSingleRule(
      "docs-source-policy",
      'docSourcePolicyCase({"dependencies": ["package-a", "package-b"], "sources": {"Example": {"dependencies": ["package-a"], "url": "https://example.com/llms.txt"}}, "exclusions": [{"dependency": "package-b", "reason": "no-llms-txt", "explanation": "Canonical documentation does not publish llms.txt.", "checkedAt": "2026-08-26T00:00:00.000Z", "expiresAt": "2026-09-25T00:00:00.000Z"}], "now": "2026-08-27T00:00:00.000Z"});',
      {
        sourcePath:
          ".oxlint-plugins/__fixtures__/docs-source-policy.fixture.ts",
      },
    ),
  ).toEqual([]);
});

test("rejects expired quarantine on its expiration boundary", async () => {
  expect(
    await lintSingleRule(
      "docs-source-policy",
      'docSourcePolicyCase({"dependencies": ["package-b"], "sources": {}, "exclusions": [{"dependency": "package-b", "reason": "no-llms-txt", "explanation": "Canonical documentation does not publish llms.txt.", "checkedAt": "2026-08-26T00:00:00.000Z", "expiresAt": "2026-08-27T00:00:00.000Z"}], "now": "2026-08-27T00:00:00.000Z"});',
      {
        sourcePath:
          ".oxlint-plugins/__fixtures__/docs-source-policy.fixture.ts",
      },
    ),
  ).toEqual([1]);
});

test("rejects unreadable policy marker arguments", async () => {
  expect(
    await lintSingleRule("docs-source-policy", "docSourcePolicyCase(policy);", {
      sourcePath: ".oxlint-plugins/__fixtures__/docs-source-policy.fixture.ts",
    }),
  ).toEqual([1]);
});

test("does not treat marker names in unrelated files as policy", async () => {
  expect(
    await lintSingleRule("docs-source-policy", "docSourcePolicyCase(policy);"),
  ).toEqual([]);
});
