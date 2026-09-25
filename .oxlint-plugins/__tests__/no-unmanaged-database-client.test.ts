import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (...lines: readonly string[]) =>
  await lintSingleRule(
    "no-unmanaged-database-client",
    [...lines, ""].join("\n"),
    { plugin: "bun-test-hygiene", sourcePath: "suite.test.ts" },
  );

// The fixture covers the `bun` and bun-sql forms; these drivers are not
// installed here, so their imports only resolve by name.
describe.serial("no-unmanaged-database-client", () => {
  test("flags the postgres and pg client constructors", async () => {
    expect(
      await lint(
        'import postgres from "postgres";',
        'import { Client, Pool } from "pg";',
        "declare const url: string;",
        "export const first = postgres(url);",
        "export const second = new Pool({ connectionString: url });",
        "export const third = new Client({ connectionString: url });",
      ),
    ).toEqual([4, 5, 6]);
  });

  test("flags a network drizzle driver opening its own client, not one wrapping a client", async () => {
    expect(
      await lint(
        'import { drizzle } from "drizzle-orm/postgres-js";',
        'import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";',
        "declare const url: string;",
        "declare const client: never;",
        "export const opened = drizzle(url);",
        "export const empty = drizzle();",
        "export const wrapped = drizzle({ client });",
        "export const inMemory = pgliteDrizzle({ client });",
      ),
    ).toEqual([5, 6]);
  });

  test("leaves a local function named like a constructor alone", async () => {
    expect(
      await lint(
        "const drizzle = (value: unknown) => value;",
        "class SQL {}",
        'export const wrapped = drizzle("postgres://example");',
        "export const local = new SQL();",
      ),
    ).toEqual([]);
  });
});
