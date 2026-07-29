import { expect, test } from "bun:test";

import { pgFtsLegalProvider } from "@/api/lib/legal-search/pg-fts-legal-provider";
import { getLegalSearchProvider } from "@/api/lib/legal-search/provider";

test("defaults to the pg-fts provider (the cutover-safe default)", () => {
  // LEGAL_SEARCH_PROVIDER defaults to "pg-fts"; the corpus index branch is
  // selected only after the deliberate config flip.
  expect(getLegalSearchProvider()).toBe(pgFtsLegalProvider);
});

test("every pg-fts case-law projection read rechecks redistribution", async () => {
  const source = await Bun.file(
    `${import.meta.dir}/pg-fts-legal-provider.ts`,
  ).text();
  const projectionReads =
    source.match(/\bFROM case_law_search_documents\b/gu) ?? [];
  const redistributionGates =
    source.match(/\$\{redistributableSourceJoin\}/gu) ?? [];

  expect(projectionReads.length).toBeGreaterThan(0);
  expect(redistributionGates).toHaveLength(projectionReads.length);
});
