import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { stella, stellaCaseLawReader } from "@/api/db/rls";
import { caseLawDatabaseRolePermissionsSql } from "@/api/lib/case-law-public-read-db";
import {
  PUBLIC_CASE_LAW_RELATIONS,
  PUBLIC_CASE_LAW_SOURCE_COLUMNS,
  PUBLIC_CASE_LAW_SOURCE_TABLE,
  PUBLIC_CASE_LAW_TABLES,
} from "@/api/lib/case-law/public-relations";
import { getCollator } from "@/api/lib/collation";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// The public case-law reader may SELECT exactly PUBLIC_CASE_LAW_TABLES whole
// and PUBLIC_CASE_LAW_SOURCE_COLUMNS of the source table.
// `assertCaseLawDatabaseRolePermissions` enforces that at connection time;
// these guards enforce it at commit time from both directions: the migrated
// database (what the role can actually do) and the migration files (what a
// fresh database will be granted), each against the lists the runtime check
// reads. A table or column added to one side without the other fails here
// instead of at the first request.

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
const READER_ROLE = stellaCaseLawReader.name;
const WHOLE_TABLES = [...PUBLIC_CASE_LAW_TABLES].toSorted();
const SOURCE_COLUMNS = [...PUBLIC_CASE_LAW_SOURCE_COLUMNS].toSorted();
const WRITE_PRIVILEGES = "INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER";

let testDb: TestDatabase;

beforeAll(
  async () => {
    testDb = await getTestDb();
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseTestDb();
});

describe("public case-law reader role", () => {
  test("can SELECT exactly the whole public case-law tables", async () => {
    const result = await testDb.execute<{ relname: string }>(sql`
      SELECT tables.relname
      FROM pg_class AS tables
      INNER JOIN pg_namespace AS schemas
        ON schemas.oid = tables.relnamespace
      WHERE schemas.nspname = 'public'
        AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_table_privilege(${READER_ROLE}, tables.oid, 'SELECT')
      ORDER BY tables.relname
    `);

    expect(result.rows.map((row) => row.relname)).toEqual(WHOLE_TABLES);
  });

  test("can SELECT exactly the public columns of the source table", async () => {
    const result = await testDb.execute<{ attname: string }>(sql`
      SELECT columns.attname
      FROM pg_attribute AS columns
      INNER JOIN pg_class AS tables ON tables.oid = columns.attrelid
      INNER JOIN pg_namespace AS schemas
        ON schemas.oid = tables.relnamespace
      WHERE schemas.nspname = 'public'
        AND tables.relname = ${PUBLIC_CASE_LAW_SOURCE_TABLE}
        AND columns.attnum > 0
        AND NOT columns.attisdropped
        AND has_column_privilege(
          ${READER_ROLE},
          columns.attrelid,
          columns.attnum,
          'SELECT'
        )
      ORDER BY columns.attname
    `);

    expect(result.rows.map((row) => row.attname)).toEqual(SOURCE_COLUMNS);
  });

  test("cannot read any column outside the public set", async () => {
    const publicTables = sql.join(
      PUBLIC_CASE_LAW_TABLES.map((name) => sql`${name}`),
      sql.raw(","),
    );
    const sourceColumns = sql.join(
      PUBLIC_CASE_LAW_SOURCE_COLUMNS.map((name) => sql`${name}`),
      sql.raw(","),
    );
    const result = await testDb.execute<{ qualified: string }>(sql`
      SELECT tables.relname || '.' || columns.attname AS qualified
      FROM pg_attribute AS columns
      INNER JOIN pg_class AS tables ON tables.oid = columns.attrelid
      INNER JOIN pg_namespace AS schemas
        ON schemas.oid = tables.relnamespace
      WHERE schemas.nspname = 'public'
        AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND tables.relname NOT IN (${publicTables})
        AND columns.attnum > 0
        AND NOT columns.attisdropped
        AND NOT (
          tables.relname = ${PUBLIC_CASE_LAW_SOURCE_TABLE}
          AND columns.attname IN (${sourceColumns})
        )
        AND has_column_privilege(
          ${READER_ROLE},
          columns.attrelid,
          columns.attnum,
          'SELECT'
        )
      ORDER BY qualified
    `);

    expect(result.rows).toEqual([]);
  });

  test("cannot write anywhere in public", async () => {
    const result = await testDb.execute<{ relname: string }>(sql`
      SELECT tables.relname
      FROM pg_class AS tables
      INNER JOIN pg_namespace AS schemas
        ON schemas.oid = tables.relnamespace
      WHERE schemas.nspname = 'public'
        AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_table_privilege(${READER_ROLE}, tables.oid, ${WRITE_PRIVILEGES})
      ORDER BY tables.relname
    `);

    expect(result.rows).toEqual([]);
  });

  test("passes the connection validator, and the application role does not", async () => {
    const asRole = async (role: string) =>
      await testDb.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
        const result = await tx.execute<{
          canReadCaseLaw: boolean;
          canReadOtherData: boolean;
          canWriteCaseLaw: boolean;
        }>(caseLawDatabaseRolePermissionsSql());
        return result.rows.at(0);
      });

    expect(await asRole(READER_ROLE)).toEqual({
      canReadCaseLaw: true,
      canReadOtherData: false,
      canWriteCaseLaw: false,
    });
    // `stella` reads the whole source table and tenant data besides.
    expect(await asRole(stella.name)).toMatchObject({
      canReadOtherData: true,
    });
  });

  test("has a SELECT policy on every public relation and no other", async () => {
    const result = await testDb.execute<{ tablename: string }>(sql`
      SELECT tablename
      FROM pg_policies
      WHERE schemaname = 'public'
        AND ${READER_ROLE} = ANY (roles)
        AND cmd = 'SELECT'
      ORDER BY tablename
    `);

    expect(result.rows.map((row) => row.tablename)).toEqual(
      [...PUBLIC_CASE_LAW_RELATIONS].toSorted(),
    );
  });
});

// Static side: the SELECT grants written in migrations, folded in order so a
// later REVOKE undoes an earlier GRANT. The result is the effective grant
// set of a database that has applied every migration.

/** Effective SELECT grants: whole tables, and columns per partially read table. */
type EffectiveSelectGrants = {
  tables: Set<string>;
  columns: Map<string, Set<string>>;
};

const stripLineComments = (contents: string): string =>
  contents
    .split(/\r?\n/u)
    .map((line) => {
      const commentStart = line.indexOf("--");
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join("\n");

const identifiers = (list: string): string[] =>
  list.split(",").map((entry) => entry.trim().replaceAll('"', ""));

const STATEMENT_PATTERN =
  /^(?<verb>GRANT|REVOKE) SELECT(?: \((?<columns>[^)]+)\))? ON TABLE (?<tables>.+?) (?:TO|FROM) "?stella_caselaw_reader"?$/iu;

const foldReaderSelectGrants = (
  sqlSources: readonly string[],
): EffectiveSelectGrants => {
  const effective: EffectiveSelectGrants = {
    tables: new Set(),
    columns: new Map(),
  };
  for (const source of sqlSources) {
    for (const raw of stripLineComments(source).split(";")) {
      const statement = raw.replaceAll(/\s+/gu, " ").trim();
      const match = STATEMENT_PATTERN.exec(statement);
      if (match?.groups === undefined) {
        continue;
      }
      const granting = match.groups["verb"]?.toUpperCase() === "GRANT";
      const tables = identifiers(match.groups["tables"] ?? "");
      const columnList = match.groups["columns"];
      for (const table of tables) {
        if (columnList === undefined) {
          if (granting) {
            effective.tables.add(table);
          } else {
            effective.tables.delete(table);
            effective.columns.delete(table);
          }
          continue;
        }
        const columns = effective.columns.get(table) ?? new Set<string>();
        for (const column of identifiers(columnList)) {
          if (granting) {
            columns.add(column);
          } else {
            columns.delete(column);
          }
        }
        if (columns.size === 0) {
          effective.columns.delete(table);
        } else {
          effective.columns.set(table, columns);
        }
      }
    }
  }
  return effective;
};

const sortedColumns = (grants: EffectiveSelectGrants) =>
  Object.fromEntries(
    [...grants.columns.entries()]
      .toSorted(([a], [b]) => getCollator("en").compare(a, b))
      .map(([table, columns]) => [table, [...columns].toSorted()]),
  );

describe("public case-law reader migrations", () => {
  test("effective SELECT grants equal the public tables and source columns", () => {
    const sources = readdirSync(DRIZZLE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        nodePath.resolve(DRIZZLE_DIR, entry.name, "migration.sql"),
      )
      .filter((path) => existsSync(path))
      .toSorted()
      .map((path) => readFileSync(path, "utf-8"));

    const grants = foldReaderSelectGrants(sources);

    expect([...grants.tables].toSorted()).toEqual(WHOLE_TABLES);
    expect(sortedColumns(grants)).toEqual({
      [PUBLIC_CASE_LAW_SOURCE_TABLE]: SOURCE_COLUMNS,
    });
  });

  test("a later REVOKE undoes an earlier GRANT, table and column alike", () => {
    const grants = foldReaderSelectGrants([
      `GRANT SELECT ON TABLE "a", "b" TO stella_caselaw_reader;
       GRANT SELECT (x, y) ON TABLE "c" TO stella_caselaw_reader;`,
      `REVOKE SELECT ON TABLE "b" FROM stella_caselaw_reader;
       REVOKE SELECT (y) ON TABLE "c" FROM stella_caselaw_reader;
       GRANT SELECT ON TABLE "d" TO "stella_caselaw_reader";
       REVOKE SELECT ON TABLE "d" FROM stella_caselaw_reader;`,
    ]);

    expect([...grants.tables].toSorted()).toEqual(["a"]);
    expect(sortedColumns(grants)).toEqual({ c: ["x"] });
  });
});
