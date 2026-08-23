import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  stella,
  stellaCaseLawReader,
  stellaPublicLawReader,
} from "@/api/db/rls";
import {
  publicLawDatabaseRolePermissionsSql,
  type PublicLawDatabaseRolePermissions,
} from "@/api/lib/public-law-read-db";
import {
  PUBLIC_LAW_COLUMNS_BY_RELATION,
  ROLLOUT_CASE_LAW_RELATIONS,
  ROLLOUT_CASE_LAW_SOURCE_COLUMNS,
  ROLLOUT_CASE_LAW_SOURCE_RELATION,
  ROLLOUT_CASE_LAW_WHOLE_RELATIONS,
} from "@/api/lib/public-law-relations";
import { getCollator } from "@/api/lib/collation";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
const READER_ROLE = stellaPublicLawReader.name;
const ROLLOUT_READER_ROLE = stellaCaseLawReader.name;
const WRITE_PRIVILEGES = "INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER";

const quoted = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const expectedQualifiedColumns = Object.entries(
  PUBLIC_LAW_COLUMNS_BY_RELATION,
)
  .flatMap(([relation, columns]) =>
    columns.map((column) => `${relation}.${column}`),
  )
  .toSorted();

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

describe("public-law reader role", () => {
  test("can read exactly the allowlisted columns", async () => {
    const result = await testDb.execute<{ qualified: string }>(sql`
      SELECT tables.relname || '.' || columns.attname AS qualified
      FROM pg_attribute AS columns
      INNER JOIN pg_class AS tables ON tables.oid = columns.attrelid
      INNER JOIN pg_namespace AS schemas ON schemas.oid = tables.relnamespace
      WHERE schemas.nspname = 'public'
        AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND columns.attnum > 0
        AND NOT columns.attisdropped
        AND has_column_privilege(
          ${READER_ROLE},
          columns.attrelid,
          columns.attnum,
          'SELECT'
        )
      ORDER BY qualified
    `);

    expect(result.rows.map(({ qualified }) => qualified)).toEqual(
      expectedQualifiedColumns,
    );
  });

  test("has no table-level SELECT and cannot write or create", async () => {
    const result = await testDb.execute<{
      canCreate: boolean;
      readableTables: string[];
      writableTables: string[];
    }>(sql`
      SELECT
        has_schema_privilege(${READER_ROLE}, 'public', 'CREATE') AS "canCreate",
        ARRAY(
          SELECT tables.relname
          FROM pg_class AS tables
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname = 'public'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND has_table_privilege(${READER_ROLE}, tables.oid, 'SELECT')
          ORDER BY tables.relname
        ) AS "readableTables",
        ARRAY(
          SELECT tables.relname
          FROM pg_class AS tables
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname = 'public'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND has_table_privilege(
              ${READER_ROLE},
              tables.oid,
              ${WRITE_PRIVILEGES}
            )
          ORDER BY tables.relname
        ) AS "writableTables"
    `);

    expect(result.rows.at(0)).toEqual({
      canCreate: false,
      readableTables: [],
      writableTables: [],
    });
  });

  test("passes startup attestation, while the application role does not", async () => {
    const asRole = async (role: string) =>
      await testDb.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(role)}`));
        const result = await tx.execute<PublicLawDatabaseRolePermissions>(
          publicLawDatabaseRolePermissionsSql(),
        );
        return result.rows.at(0);
      });

    expect(await asRole(READER_ROLE)).toEqual({
      canConnect: true,
      canReadPublicLaw: true,
      canReadOtherData: false,
      canUseSchema: true,
      canWritePublicLaw: false,
    });
    expect(await asRole(stella.name)).toMatchObject({
      canReadOtherData: true,
    });
  });

  test("SET ROLE can SELECT every surface and rejects an operational column", async () => {
    await testDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(READER_ROLE)}`));
      for (const [relation, columns] of Object.entries(
        PUBLIC_LAW_COLUMNS_BY_RELATION,
      )) {
        // oxlint-disable-next-line no-await-in-loop -- each statement proves the active role can resolve and read one exact relation projection
        await tx.execute(
          sql.raw(
            `SELECT ${columns.map(quoted).join(", ")} FROM ${quoted(relation)} LIMIT 0`,
          ),
        );
      }
    });
    await expect(
      testDb.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(READER_ROLE)}`));
        await tx.execute(
          sql.raw('SELECT "config" FROM "legislation_sources"'),
        );
      }),
    ).rejects.toThrow();
  });

  test("preserves the v0.7.22 reader during the rollout window", async () => {
    await testDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(ROLLOUT_READER_ROLE)}`));
      for (const relation of ROLLOUT_CASE_LAW_WHOLE_RELATIONS) {
        // oxlint-disable-next-line no-await-in-loop -- each statement proves the previous reader contract still resolves after the additive migration
        await tx.execute(sql.raw(`SELECT * FROM ${quoted(relation)} LIMIT 0`));
      }
      await tx.execute(
        sql.raw(
          `SELECT ${ROLLOUT_CASE_LAW_SOURCE_COLUMNS.map(quoted).join(", ")} FROM ${quoted(ROLLOUT_CASE_LAW_SOURCE_RELATION)} LIMIT 0`,
        ),
      );
    });
    await expect(
      testDb.transaction(async (tx) => {
        await tx.execute(
          sql.raw(`SET LOCAL ROLE ${quoted(ROLLOUT_READER_ROLE)}`),
        );
        await tx.execute(sql.raw('SELECT "id" FROM "legislation_documents"'));
      }),
    ).rejects.toThrow();
  });

  test("has a SELECT policy on every allowlisted relation and no other", async () => {
    const result = await testDb.execute<{ tablename: string }>(sql`
      SELECT tablename
      FROM pg_policies
      WHERE schemaname = 'public'
        AND ${READER_ROLE} = ANY (roles)
        AND cmd = 'SELECT'
      ORDER BY tablename
    `);

    expect(result.rows.map(({ tablename }) => tablename)).toEqual(
      Object.keys(PUBLIC_LAW_COLUMNS_BY_RELATION).toSorted(),
    );
  });

  test("keeps the previous reader policies during rollout", async () => {
    const result = await testDb.execute<{ tablename: string }>(sql`
      SELECT tablename
      FROM pg_policies
      WHERE schemaname = 'public'
        AND ${ROLLOUT_READER_ROLE} = ANY (roles)
        AND cmd = 'SELECT'
      ORDER BY tablename
    `);

    expect(result.rows.map(({ tablename }) => tablename)).toEqual(
      [...ROLLOUT_CASE_LAW_RELATIONS].toSorted(),
    );
  });
});

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
  /^(?<verb>GRANT|REVOKE) SELECT(?: \((?<columns>[^)]+)\))? ON TABLE (?<tables>.+?) (?:TO|FROM) "?(?<role>stella_(?:caselaw_reader|public_law_reader))"?$/iu;

const foldReaderSelectGrants = (
  sqlSources: readonly string[],
  readerRole: string,
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
      if (match.groups["role"] !== readerRole) {
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

describe("public-law reader migrations", () => {
  test("effective grants equal the source-of-truth map", () => {
    const sources = readdirSync(DRIZZLE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        nodePath.resolve(DRIZZLE_DIR, entry.name, "migration.sql"),
      )
      .filter((path) => existsSync(path))
      .toSorted()
      .map((path) => readFileSync(path, "utf-8"));

    const grants = foldReaderSelectGrants(sources, READER_ROLE);
    const expected = Object.fromEntries(
      Object.entries(PUBLIC_LAW_COLUMNS_BY_RELATION).map(
        ([relation, columns]) => [relation, [...columns].toSorted()],
      ),
    );

    expect([...grants.tables]).toEqual([]);
    expect(sortedColumns(grants)).toEqual(expected);
  });

  test("keeps the previous reader grants unchanged during rollout", () => {
    const sources = readdirSync(DRIZZLE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        nodePath.resolve(DRIZZLE_DIR, entry.name, "migration.sql"),
      )
      .filter((path) => existsSync(path))
      .toSorted()
      .map((path) => readFileSync(path, "utf-8"));

    const grants = foldReaderSelectGrants(sources, ROLLOUT_READER_ROLE);

    expect([...grants.tables].toSorted()).toEqual([
      ...ROLLOUT_CASE_LAW_WHOLE_RELATIONS,
    ]);
    expect(sortedColumns(grants)).toEqual({
      [ROLLOUT_CASE_LAW_SOURCE_RELATION]: [
        ...ROLLOUT_CASE_LAW_SOURCE_COLUMNS,
      ].toSorted(),
    });
  });

  test("a later REVOKE undoes table and column grants", () => {
    const grants = foldReaderSelectGrants(
      [
        `GRANT SELECT ON TABLE "a", "b" TO stella_public_law_reader;
         GRANT SELECT (x, y) ON TABLE "c" TO stella_public_law_reader;`,
        `REVOKE SELECT ON TABLE "b" FROM stella_public_law_reader;
         REVOKE SELECT (y) ON TABLE "c" FROM stella_public_law_reader;`,
      ],
      READER_ROLE,
    );

    expect([...grants.tables].toSorted()).toEqual(["a"]);
    expect(sortedColumns(grants)).toEqual({ c: ["x"] });
  });
});
