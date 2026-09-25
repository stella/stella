import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (...body: readonly string[]) =>
  await lintSingleRule(
    "no-db-await-in-loop",
    [
      "declare const database: { select: () => Promise<unknown> };",
      "declare const transaction: { select: () => Promise<unknown> };",
      "declare const items: string[];",
      "declare function rebuild(id: string, handle: unknown): Promise<void>;",
      "export const run = async () => {",
      ...body,
      "};",
      "",
    ].join("\n"),
  );

// Worker and repair code names its injected handle `database` (or
// `transaction`); a loop over it is the same N+1 as one over `db` or `tx`.
describe.serial("no-db-await-in-loop injected handle names", () => {
  test("flags a query chained on `database` or `transaction`", async () => {
    expect(
      await lint(
        "  for (const item of items) {",
        "    await database.select();",
        "    await transaction.select();",
        "  }",
      ),
    ).toEqual([7, 8]);
  });

  test("flags a helper handed `database`, as an argument or a property", async () => {
    expect(
      await lint(
        "  while (items.length > 0) {",
        "    const item = items.pop() ?? '';",
        "    await rebuild(item, database);",
        "    await rebuild(item, { database });",
        "  }",
      ),
    ).toEqual([8, 9]);
  });

  test("allows one statement on `database` outside a loop", async () => {
    expect(await lint("  await database.select();")).toEqual([]);
  });
});
