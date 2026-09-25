import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (condition: string) =>
  await lintSingleRule(
    "require-search-scope",
    [
      'import { sql } from "drizzle-orm";',
      "declare const value: string;",
      "export const read = sql`",
      "  SELECT e.id FROM entities e",
      `  WHERE ${condition}`,
      "`;",
      "",
    ].join("\n"),
    { sourcePath: "apps/api/src/lib/search/example.ts" },
  );

describe.serial("require-search-scope IS DISTINCT FROM operands", () => {
  test.each([
    ["bare", `e.id IS DISTINCT FROM \${value}`],
    ["negated", `e.id IS NOT DISTINCT FROM \${value}::uuid`],
    ["parenthesised", `e.id IS DISTINCT FROM (\${value})`],
    ["nested parentheses", `e.id IS NOT DISTINCT FROM(( \${value} ))`],
  ])("reads a %s operand as a value", async (_label, condition) => {
    expect(await lint(condition)).toEqual([]);
  });

  test("still treats an interpolation after a relation FROM as a relation", async () => {
    expect(await lint(`e.id IN (SELECT x.id FROM \${value} x)`)).not.toEqual(
      [],
    );
  });
});
