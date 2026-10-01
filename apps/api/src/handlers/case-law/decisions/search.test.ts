import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { bodyPreviewJoin } from "@/api/lib/case-law/search-sql";

describe("case-law search body preview SQL", () => {
  test("does not expand non-array sections JSONB values", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(bodyPreviewJoin);

    expect(compiled.sql).toContain("CASE jsonb_typeof(d.sections)");
    expect(compiled.sql).toContain("WHEN 'array' THEN d.sections");
    expect(compiled.sql).toContain("ELSE '[]'::jsonb");
  });
});

describe("PostgreSQL metadata filter admission", () => {
  const unreadableDb = Object.assign(
    async () => panic("Rejected metadata filters must not read the database"),
    caseLawPublicReadDb,
  );

  test.each([
    { category: "A" },
    { hasLegalSentence: true },
    { hasLegalSentence: false },
    { category: "B", hasLegalSentence: false },
  ])("refuses unindexed filters before querying (%j)", async (filters) => {
    const result = await searchDecisionsHandler(
      { query: "náhrada škody", country: "CZE", ...filters },
      unreadableDb,
    );
    expect(result).toBeInstanceOf(ElysiaCustomStatusResponse);
    if (!(result instanceof ElysiaCustomStatusResponse)) {
      panic("Expected metadata-filter rejection");
    }
    expect(result.code).toBe(400);
    expect(result.response.message).toContain("require corpus-index search");
    expect(result.response.message).toContain(
      "Remove category and hasLegalSentence",
    );
  });
});
