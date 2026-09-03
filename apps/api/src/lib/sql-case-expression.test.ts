import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  SQL_NULL,
  sqlCaseExpression,
  sqlCaseFragment,
} from "@/api/lib/sql-case-expression";

describe("sqlCaseExpression", () => {
  test("an empty branch list renders the fallback alone, not an empty CASE", () => {
    // `CASE ELSE 1 END` is a syntax error, so the expression a registry with
    // no rows renders has to be the value the CASE would have taken.
    expect(sqlCaseExpression({ branches: [], fallback: 1 })).toBe("1");
    expect(sqlCaseExpression({ branches: [], fallback: SQL_NULL })).toBe(
      "NULL",
    );
    expect(sqlCaseExpression({ branches: [], fallback: 1 })).not.toContain(
      "CASE",
    );
  });

  test("branches keep the order given, because the first true one wins", () => {
    const rendered = sqlCaseExpression({
      branches: ["WHEN c ~* 'apex' THEN 10", "WHEN c ~* 'district' THEN 2"],
      fallback: 1,
    });
    expect(rendered.indexOf("THEN 10")).toBeLessThan(
      rendered.indexOf("THEN 2"),
    );
    expect(rendered.startsWith("CASE WHEN c ~* 'apex' THEN 10")).toBe(true);
    expect(rendered).toContain("ELSE 1 END");
  });
});

// The rendered statement, as the driver would send it: the fragment's shape is
// the whole contract here, and a Drizzle SQL object reveals nothing on its own.
const rendered = (fragment: SQL): string =>
  new PgDialect().sqlToQuery(fragment).sql;

describe("sqlCaseFragment", () => {
  test("no branches renders the fallback fragment, not an empty CASE", () => {
    // `CASE id ELSE col END` is as invalid as `CASE ELSE 1 END`, so a batch
    // that turned out to hold no rows has to render the column itself.
    expect(
      rendered(
        sqlCaseFragment({
          branches: [],
          fallback: sql`0::float8`,
          operand: sql`id`,
        }),
      ),
    ).toBe("0::float8");
    expect(
      rendered(sqlCaseFragment({ branches: [], fallback: sql`0::float8` })),
    ).not.toContain("CASE");
  });

  test("branches render in order, between the operand and the ELSE", () => {
    const fragment = sqlCaseFragment({
      branches: [sql`WHEN 'a' THEN 1`, sql`WHEN 'b' THEN 2`],
      fallback: sql`0`,
      operand: sql`id`,
    });
    expect(rendered(fragment)).toBe(
      "CASE id WHEN 'a' THEN 1 WHEN 'b' THEN 2 ELSE 0 END",
    );
  });

  test("a searched CASE omits the operand", () => {
    expect(
      rendered(
        sqlCaseFragment({
          branches: [sql`WHEN x IS NULL THEN 1`],
          fallback: sql`0`,
        }),
      ),
    ).toBe("CASE WHEN x IS NULL THEN 1 ELSE 0 END");
  });
});
