import { expect, test } from "bun:test";

import { pgFtsLegalProvider } from "@/api/lib/legal-search/pg-fts-legal-provider";
import { getLegalSearchProvider } from "@/api/lib/legal-search/provider";

test("defaults to the pg-fts provider (the cutover-safe default)", () => {
  // LEGAL_SEARCH_PROVIDER defaults to "pg-fts"; the Quickwit branch is
  // selected only after the deliberate config flip.
  expect(getLegalSearchProvider()).toBe(pgFtsLegalProvider);
});
