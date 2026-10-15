import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("no-bare-jsonb-cast", () => {
  test("reports direct parenthesized and ANSI bound casts", async () => {
    expect(
      await lintSingleRule(
        "no-bare-jsonb-cast",
        `sql\`x = \${json}::jsonb\`;\nsql\`x = (\${payload.astJson})::pg_catalog.jsonb\`;\nsql\`x = CAST(\${json} AS "jsonb")\`;`,
      ),
    ).toEqual([1, 2, 3]);
  });
  test("reports positional casts split by comments", async () => {
    expect(
      await lintSingleRule(
        "no-bare-jsonb-cast",
        [
          'db.unsafe("UPDATE t SET body = $1',
          '::/* cast */jsonb", [json]);',
        ].join(""),
      ),
    ).toEqual([1]);
  });
  test("accepts text intermediates and function result casts", async () => {
    expect(
      await lintSingleRule(
        "no-bare-jsonb-cast",
        `sql\`x = \${json}::text::jsonb\`;\nsql\`x = to_jsonb(\${json})::jsonb\`;\ndb.unsafe("UPDATE t SET body = $1::text::jsonb", [json]);`,
      ),
    ).toEqual([]);
  });
  test("accepts explicitly reviewed column expressions", async () => {
    expect(
      await lintSingleRule(
        "no-bare-jsonb-cast",
        `sql\`x = \${table.column}::jsonb\`;`,
        { ruleOptions: { allowedColumnExpressions: ["table.column"] } },
      ),
    ).toEqual([]);
  });
  test("does not infer column exemptions from member access", async () => {
    expect(
      await lintSingleRule(
        "no-bare-jsonb-cast",
        `sql\`x = \${payload.astJson}::jsonb\`;`,
        { ruleOptions: { allowedColumnExpressions: ["table.column"] } },
      ),
    ).toEqual([1]);
  });
});
