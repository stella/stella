import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (
  source: string,
  sourcePath = "apps/api/src/handlers/case-law/ingestion/pipeline/example.ts",
) => lintSingleRule("no-independent-fallback-state", source, { sourcePath });

test("rejects fallback state columns written outside their owner", async () => {
  expect(
    await lint("export const partial = { fallbackContentHash: null };"),
  ).toEqual([1]);
  expect(
    await lint(
      "declare const row: { fallbackIdentityKey: string | null };\nrow.fallbackIdentityKey = null;",
    ),
  ).toEqual([2]);
});

test("allows reads, query predicates and the owner module", async () => {
  expect(
    await lint(
      "export const read = { fallbackDocumentHash: true, fallbackIdentityKey: { isNull: true } };",
    ),
  ).toEqual([]);
  expect(
    await lint(
      "export const state = { fallbackContentHash: null };",
      "apps/api/src/lib/case-law/fallback-decision-identity.ts",
    ),
  ).toEqual([]);
});
