import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  await lintSingleRule("require-query-limit", source, {
    sourcePath: "apps/api/src/handlers/example.ts",
  });

const OWNER = 'import { readBounded } from "@/api/lib/db/read-bounded";';
const QUERY = "tx.select().from(table).orderBy(table.id)";

describe.serial("bounded ordered reads", () => {
  test("accepts the imported owner around a sorted query", async () => {
    expect(await lint(`${OWNER}\nreadBounded(${QUERY}, 100);`)).toEqual([]);
  });

  test("accepts owner aliases and mixed bounded branches", async () => {
    expect(
      await lint(`
      import { readBounded as read } from "@/api/lib/db/read-bounded";
      const query = ${QUERY};
      const result = exporting ? await read(query, 100) : await query.limit(11);
    `),
    ).toEqual([]);
  });

  test("rejects an unbounded sibling use of an assigned query", async () => {
    const found = await lint(
      `${OWNER}\nconst query = ${QUERY};\nreadBounded(query, 100);\nawait query;`,
    );
    expect(found).toEqual([2]);
  });

  test("rejects a local namesake and a shadowed owner", async () => {
    expect(
      await lint(`const readBounded = q => q;\nreadBounded(${QUERY}, 100);`),
    ).toEqual([2]);
    expect(
      await lint(
        `${OWNER}\nconst run = readBounded => readBounded(${QUERY}, 100);`,
      ),
    ).toEqual([2]);
  });

  test("rejects a query passed outside the owner query argument", async () => {
    expect(await lint(`${OWNER}\nreadBounded(other, ${QUERY});`)).toEqual([2]);
  });
});
