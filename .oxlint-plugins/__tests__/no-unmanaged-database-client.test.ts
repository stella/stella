import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

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

  test("flags the SQL client owner's factory like the Bun constructor it wraps", async () => {
    expect(
      await lint(
        'import { createDatabase, createSqlClient } from "@/api/db/sql-client";',
        "declare const url: string;",
        "export const opened = createSqlClient({ url });",
        "export const wrapped = createDatabase({ client: opened });",
      ),
    ).toEqual([3]);
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

describe.serial("shared-process database clients", () => {
  test("rejects imported singleton closure through database, client and method aliases", async () => {
    expect(
      await lint(
        'import { rootDb as shared } from "@/api/db/root";',
        'import * as databases from "@/api/db/root";',
        "shared.$client.close();",
        "const database = shared;",
        'database.$client["close"]();',
        "const client = database.$client;",
        "client.close();",
        "const { $client: selectedClient } = databases.rootDb;",
        "selectedClient.close();",
        "const { close: closeAlias } = selectedClient;",
        "closeAlias();",
        "const { $client: { close: nestedCloseAlias } } = shared;",
        "nestedCloseAlias();",
      ),
    ).toEqual([3, 5, 7, 9, 11, 13]);
  });

  test("resolves a relative singleton import without a database-directory hint", async () => {
    expect(
      await lintSingleRule(
        "no-unmanaged-database-client",
        [
          'import { rootDb as shared } from "../root";',
          "shared.$client.close();",
        ].join("\n"),
        {
          plugin: "bun-test-hygiene",
          sourcePath: "apps/api/src/db/__tests__/suite.test.ts",
          cwd: "scratch",
        },
      ),
    ).toEqual([2]);
  });

  test("rejects the shared client passed to its pool-closing helper", async () => {
    expect(
      await lint(
        'import { rootDb } from "@/api/db/root";',
        'import { forceClosePool as force } from "@/api/db/sql-close";',
        "force(rootDb.$client);",
        "const client = rootDb.$client;",
        "const dispose = force;",
        "dispose(client);",
      ),
    ).toEqual([3, 6]);
  });

  test("retains shared-client provenance through a dynamically imported namespace", async () => {
    expect(
      await lint(
        'const databases = await import("@/api/db/root");',
        "const { rootDb: shared } = databases;",
        "const client = shared.$client;",
        "const finish = client.close;",
        "finish();",
      ),
    ).toEqual([5]);
  });

  test("allows fixture-owned clients, shared reads and shadowed locals", async () => {
    expect(
      await lint(
        'import { rootDb } from "@/api/db/root";',
        'import { forceClosePool } from "@/api/db/sql-close";',
        'import { openGatedTestDatabase, withGatedTestClients } from "@/api/tests/gated-test-database";',
        "declare const url: string;",
        "const fixture = openGatedTestDatabase(url);",
        "fixture.sql.close();",
        "fixture.db.$client.close();",
        "forceClosePool(fixture.sql);",
        "await withGatedTestClients(url, async ({ openClient }) => {",
        "  const owned = openClient();",
        "  await owned.sql.close();",
        "});",
        "rootDb.$client`SELECT 1`;",
        "const local = { $client: { close: () => undefined } };",
        "local.$client.close();",
        "export const closeLocal = (rootDb: typeof local) => rootDb.$client.close();",
      ),
    ).toEqual([]);
  });
});
