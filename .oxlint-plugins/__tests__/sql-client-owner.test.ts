import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects building Bun SQL clients and bun-sql drizzle databases outside the owner", async () => {
  expect(
    await lintSingleRule(
      "sql-client-owner",
      [
        'import { SQL } from "bun";',
        'import * as bun from "bun";',
        'import { drizzle } from "drizzle-orm/bun-sql";',
        'import { drizzle as pg } from "drizzle-orm/bun-sql/postgres";',
        "export const client = new SQL({ max: 1 });",
        "export const viaNamespace = new bun.SQL({ max: 1 });",
        "export const viaGlobal = new Bun.SQL({ max: 1 });",
        "export const db = drizzle({ client });",
        "export const other = pg({ client });",
        "export const builder = drizzle.mock();",
        "const Client = SQL;",
        "export { Client, SQL };",
      ].join("\n"),
    ),
  ).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
});

test("allows driver errors, instanceof, type positions and other exports", async () => {
  expect(
    await lintSingleRule(
      "sql-client-owner",
      [
        'import { SQL } from "bun";',
        'import { randomUUIDv7 } from "bun";',
        'import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";',
        'export const error = new SQL.PostgresError("idle", { code: "57P01" });',
        "export const isClient = (value: unknown) => value instanceof SQL;",
        "export const globalError = Bun.SQL.SQLError;",
        "export type Client = SQL;",
        "export type Options = SQL.Options;",
        "export type Database = BunSQLDatabase;",
        "export const id = randomUUIDv7();",
        "const SQLKey = { SQL: 1 };",
        "export const read = SQLKey.SQL;",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("allows the owner module", async () => {
  expect(
    await lintSingleRule(
      "sql-client-owner",
      'import { SQL } from "bun";\nimport { drizzle } from "drizzle-orm/bun-sql/postgres";\nexport const make = () => drizzle({ client: new SQL({}) });\nexport const mock = () => drizzle.mock();',
      { cwd: "scratch", sourcePath: "apps/api/src/db/sql-client.ts" },
    ),
  ).toEqual([]);
});
