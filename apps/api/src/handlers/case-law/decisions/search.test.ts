import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { bodyPreviewJoin } from "@/api/handlers/case-law/decisions/search-sql";

describe("case-law search body preview SQL", () => {
  test("does not expand non-array sections JSONB values", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(bodyPreviewJoin);

    expect(compiled.sql).toContain("CASE jsonb_typeof(d.sections)");
    expect(compiled.sql).toContain("WHEN 'array' THEN d.sections");
    expect(compiled.sql).toContain("ELSE '[]'::jsonb");
  });
});
