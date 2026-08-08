import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { buildEntitySortExpressions } from "@/api/lib/entities/query-entities";
import { ENTITY_SORTABLE_FIELD_VALUE_MAX_LENGTH } from "@/api/lib/entities/window-cursor";

describe("queryEntities sort SQL", () => {
  test("custom property sorts preserve empty-string fallback for missing values", () => {
    const [sortExpression] = buildEntitySortExpressions({
      sorts: [{ propertyId: "prop_sparse", desc: false }],
    });
    if (!sortExpression) {
      throw new Error("expected custom property sort expression");
    }

    const compiled = new PgDialect().sqlToQuery(sortExpression);

    expect(compiled.sql.toLowerCase()).toContain("coalesce(");
    expect(compiled.sql.toLowerCase()).toContain("left(");
    expect(compiled.sql).toContain("), '') ASC");
    expect(compiled.params).toContain(ENTITY_SORTABLE_FIELD_VALUE_MAX_LENGTH);
    expect(compiled.sql).not.toContain("\uffff");
    expect(compiled.params).not.toContain("\uffff");
  });
});
