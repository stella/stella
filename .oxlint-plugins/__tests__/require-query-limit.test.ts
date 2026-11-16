import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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

describe.serial("cursor reads through the bounded owner", () => {
  const pageOwner =
    'import { readCursorPage } from "@/api/lib/db/read-bounded";';
  const options = "{ limit: 100, cursorForItem: row => row.id }";
  test("accepts cursor pages from the same owner and its aliases", async () => {
    expect(
      await lint(`${pageOwner}\nreadCursorPage(${QUERY}, ${options});`),
    ).toEqual([]);
    expect(
      await lint(
        `import { readCursorPage as page } from "@/api/lib/db/read-bounded";\npage(${QUERY}, ${options});`,
      ),
    ).toEqual([]);
  });
  test("rejects a non-bounded export from the owner module", async () => {
    expect(
      await lint(
        `import { BOUNDED_READ_EXPORTS } from "@/api/lib/db/read-bounded";\nBOUNDED_READ_EXPORTS(${QUERY}, ${options});`,
      ),
    ).toEqual([2]);
  });
  test("cursor ownership does not bless an unbounded sibling", async () => {
    expect(
      await lint(
        `${pageOwner}\nconst query = ${QUERY};\nreadCursorPage(query, ${options});\nawait query;`,
      ),
    ).toEqual([2]);
  });
  test("rejects cursor namesakes, shadowing and the wrong query argument", async () => {
    expect(
      await lint(
        `const readCursorPage = q => q;\nreadCursorPage(${QUERY}, ${options});`,
      ),
    ).toEqual([2]);
    expect(
      await lint(
        `${pageOwner}\nconst run = readCursorPage => readCursorPage(${QUERY}, ${options});`,
      ),
    ).toEqual([2]);
    expect(
      await lint(`${pageOwner}\nreadCursorPage(other, ${QUERY});`),
    ).toEqual([2]);
  });
});

describe.serial("grouped lateral reads through the bounded owner", () => {
  const groupedOwner =
    'import { readBoundedByGroup } from "@/api/lib/db/read-bounded";';
  const options =
    "{ cap: 500, readRows: limited => execute(limited), groupKeyOf: row => row.group }";
  test("accepts the canonical grouped owner query argument", async () => {
    expect(
      await lint(`${groupedOwner}\nreadBoundedByGroup(${QUERY}, ${options});`),
    ).toEqual([]);
    expect(
      await lint(
        `${groupedOwner}\nconst query = ${QUERY};\nreadBoundedByGroup(query, ${options});\nawait query;`,
      ),
    ).toEqual([2]);
    expect(
      await lint(
        `const readBoundedByGroup = q => q;\nreadBoundedByGroup(${QUERY}, ${options});`,
      ),
    ).toEqual([2]);
  });
  test("production lateral source queries cannot leave their bounded owner", async () => {
    const source = readFileSync(
      new URL(
        "../../apps/api/src/lib/billing/invoice-prefill-operation.ts",
        import.meta.url,
      ),
      "utf-8",
    );
    expect(source.match(/readBoundedByGroup\(/gu)).toHaveLength(2);
    expect(await lint(source)).toEqual([]);
    const unbounded = source.replaceAll(
      "readBoundedByGroup(",
      "readWithoutBound(",
    );
    expect(unbounded).not.toBe(source);
    expect(await lint(unbounded)).toHaveLength(2);
  });
});
