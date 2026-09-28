import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (lines: readonly string[]) =>
  await lintSingleRule("no-hand-rolled-execute-rows", lines.join("\n"));

describe.serial("no-hand-rolled-execute-rows", () => {
  test("reports shape tests on a bound or inline execute result", async () => {
    expect(
      await lint([
        "const result = await tx.execute(sql`SELECT 1`);",
        "const a = Array.isArray(result) ? result.at(0) : undefined;",
        'const b = isRecord(result) ? result["rows"] : [];',
        "const c = (await db.execute(query)).rows;",
        'const d = "rows" in result;',
        'const e = Reflect.get(result, "rows");',
        "const { rows } = await tx.execute(query);",
        "const f = (await tx.execute(query) as { rows: unknown[] }).rows;",
        "",
      ]),
    ).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  test("follows stable bindings and Result-wrapped calls", async () => {
    expect(
      await lint([
        "const raw = await tx.execute(query);",
        "const alias = raw;",
        "const a = Array.isArray(alias);",
        "const queried = await Result.tryPromise({",
        "  try: async () => await tx.execute(query),",
        "  catch: (cause) => cause,",
        "});",
        "const b = Array.isArray(queried.value);",
        "const settled = await Result.tryPromise(async () => {",
        "  return await tx.execute(query);",
        "});",
        'const c = settled.value["rows"];',
        "",
      ]),
    ).toEqual([3, 8, 12]);
  });

  test("recognises any receiver given a sql query", async () => {
    expect(
      await lint([
        "const a = await client.execute(sql`SELECT 1`);",
        "const b = Array.isArray(a);",
        "const statement = sql.raw(text);",
        "const c = (await pool.execute(statement)).rows;",
        "const d = (await this.db.execute(query)).rows;",
        "const e = (await getDb().execute(query)).rows;",
        "",
      ]),
    ).toEqual([2, 4, 5, 6]);
  });

  test("reports a binding tested both as an array and for rows", async () => {
    expect(
      await lint([
        "const rowsOf = (result: unknown) => {",
        "  if (Array.isArray(result)) {",
        "    return result;",
        "  }",
        '  return isRecord(result) && Array.isArray(result["rows"])',
        '    ? result["rows"]',
        "    : [];",
        "};",
        "const count = (result: unknown) => {",
        "  if (Array.isArray(result)) return result.length;",
        '  const rows = Reflect.get(Object(result), "rows");',
        '  return Array.isArray(Reflect.get(result as object, "rows")) ? 1 : 0;',
        "};",
        "",
      ]),
    ).toEqual([5, 6, 12]);
  });

  test("reports the one-driver and both-driver readers it replaces", async () => {
    expect(
      await lint([
        "const lockResult: unknown = await tx.execute(query);",
        "const lockRow: unknown = Array.isArray(lockResult)",
        "  ? lockResult.at(0)",
        "  : undefined;",
        "const rowsOf = (result: unknown) => {",
        "  let rows: unknown = result;",
        "  if (!Array.isArray(result) && isRecord(result)) {",
        '    rows = result["rows"];',
        "  }",
        "  return rows;",
        "};",
        "",
      ]),
    ).toEqual([2, 8]);
  });

  test("accepts the owner, tool calls, rows fields, and shadowed names", async () => {
    expect(
      await lint([
        "const owned = executedRows(await tx.execute(query)).at(0);",
        "const output = await tool.execute(input, options);",
        "const list = Array.isArray(output);",
        "const called = await tool.execute(args);",
        "const calledRows = called.rows;",
        "const cells = Array.isArray(table.rows) ? table.rows : [];",
        'const listed = isRecord(listing) && Array.isArray(listing["rows"]);',
        "const result = await tx.execute(query);",
        "const read = (result: unknown[]) => Array.isArray(result);",
        "let swapped = await tx.execute(query);",
        "swapped = [];",
        "const again = Array.isArray(swapped);",
        "const other = await queue.run(job);",
        "const rows = Array.isArray(other) ? other : [];",
        "",
      ]),
    ).toEqual([]);
  });
});
