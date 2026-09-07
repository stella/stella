import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { stellaCaseLawAnalysisWriter } from "@/api/db/rls";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  CASE_LAW_ANALYSIS_WRITER_SELECT_COLUMNS,
  CASE_LAW_ANALYSIS_WRITER_UPDATE_COLUMNS,
} from "@/api/tests/pglite-test-db";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
const WRITER_ROLE = stellaCaseLawAnalysisWriter.name;

// Tables that hold matter and identity data. The writer role touches the
// public corpus only, so it must hold no privilege of any kind on either.
const FORBIDDEN_RELATIONS = ["workspaces", "user"] as const;
const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
// DELETE is not a column-level privilege in PostgreSQL, so it is table-only.
const COLUMN_PRIVILEGES = ["SELECT", "INSERT", "UPDATE"] as const;

const quoted = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const errorMessageChain = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
};

const qualified = (columnsByRelation: Record<string, readonly string[]>) =>
  Object.entries(columnsByRelation)
    .flatMap(([relation, columns]) =>
      columns.map((column) => `${relation}.${column}`),
    )
    .toSorted();

const expectedSelectColumns = qualified(
  CASE_LAW_ANALYSIS_WRITER_SELECT_COLUMNS,
);
const expectedUpdateColumns = qualified(
  CASE_LAW_ANALYSIS_WRITER_UPDATE_COLUMNS,
);

let testDb: TestDatabase;

/** Every public column the role holds `privilege` on, as `relation.column`. */
const grantedColumns = async (privilege: "SELECT" | "UPDATE") => {
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
        ${WRITER_ROLE},
        columns.attrelid,
        columns.attnum,
        ${privilege}
      )
    ORDER BY qualified
  `);
  return result.rows.map(({ qualified: name }) => name);
};

const rejection = async (
  run: (
    tx: Parameters<Parameters<TestDatabase["transaction"]>[0]>[0],
  ) => Promise<unknown>,
): Promise<unknown> =>
  await testDb
    .transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(WRITER_ROLE)}`));
      await run(tx);
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

beforeAll(
  async () => {
    testDb = await getTestDb();
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseTestDb();
});

describe("case-law analysis writer role", () => {
  test("reads exactly the granted columns and nothing else", async () => {
    expect(await grantedColumns("SELECT")).toEqual(expectedSelectColumns);
  });

  test("writes exactly case_law_decisions.analysis and nothing else", async () => {
    expect(await grantedColumns("UPDATE")).toEqual(expectedUpdateColumns);
  });

  test("has no table-level privilege and cannot create in the schema", async () => {
    const result = await testDb.execute<{
      canCreate: boolean;
      privilegedTables: string[];
    }>(sql`
      SELECT
        has_schema_privilege(${WRITER_ROLE}, 'public', 'CREATE') AS "canCreate",
        ARRAY(
          SELECT tables.relname
          FROM pg_class AS tables
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname = 'public'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND has_table_privilege(
              ${WRITER_ROLE},
              tables.oid,
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            )
          ORDER BY tables.relname
        ) AS "privilegedTables"
    `);

    expect(result.rows.at(0)).toEqual({
      canCreate: false,
      privilegedTables: [],
    });
  });

  test("holds no privilege at all on matter and identity tables", async () => {
    for (const relation of FORBIDDEN_RELATIONS) {
      for (const privilege of TABLE_PRIVILEGES) {
        const result = await testDb.execute<{ onTable: boolean }>(sql`
          SELECT has_table_privilege(
            ${WRITER_ROLE},
            ${relation}::regclass,
            ${privilege}
          ) AS "onTable"
        `);

        expect({ relation, privilege, ...result.rows.at(0) }).toEqual({
          relation,
          privilege,
          onTable: false,
        });
      }

      for (const privilege of COLUMN_PRIVILEGES) {
        const result = await testDb.execute<{ onAnyColumn: boolean }>(sql`
          SELECT EXISTS (
            SELECT 1
            FROM pg_attribute AS columns
            WHERE columns.attrelid = ${relation}::regclass
              AND columns.attnum > 0
              AND NOT columns.attisdropped
              AND has_column_privilege(
                ${WRITER_ROLE},
                columns.attrelid,
                columns.attnum,
                ${privilege}
              )
          ) AS "onAnyColumn"
        `);

        expect({ relation, privilege, ...result.rows.at(0) }).toEqual({
          relation,
          privilege,
          onAnyColumn: false,
        });
      }
    }
  });

  test("SET ROLE can select the granted columns of both relations", async () => {
    await testDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(WRITER_ROLE)}`));
      for (const [relation, columns] of Object.entries(
        CASE_LAW_ANALYSIS_WRITER_SELECT_COLUMNS,
      )) {
        await tx.execute(
          sql.raw(
            `SELECT ${columns.map(quoted).join(", ")} FROM ${quoted(relation)} LIMIT 0`,
          ),
        );
      }
    });
  });

  test("SET ROLE is refused every column outside the grant", async () => {
    const forbidden = [
      ["case_law_decisions", "fulltext"],
      ["case_law_decisions", "source_raw"],
      ["case_law_decisions", "case_number"],
      ["case_law_sources", "sync_cursor"],
      ["case_law_sources", "adapter_key"],
    ] as const;

    for (const [relation, column] of forbidden) {
      const error = await rejection(
        async (tx) =>
          await tx.execute(
            sql.raw(`SELECT ${quoted(column)} FROM ${quoted(relation)}`),
          ),
      );
      expect({ relation, column, isError: error instanceof Error }).toEqual({
        relation,
        column,
        isError: true,
      });
      expect(errorMessageChain(error)).toContain("permission denied");
    }
  });

  test("SET ROLE cannot read a matter or identity table at all", async () => {
    for (const relation of FORBIDDEN_RELATIONS) {
      const error = await rejection(
        async (tx) =>
          await tx.execute(sql.raw(`SELECT "id" FROM ${quoted(relation)}`)),
      );
      expect(error).toBeInstanceOf(Error);
      expect(errorMessageChain(error)).toContain("permission denied");
    }
  });

  test("SET ROLE updates analysis on a live row and is refused any other column", async () => {
    const sourceId = createSafeId<"caseLawSource">();
    const decisionId = createSafeId<"caseLawDecision">();
    let updatedIds: unknown[] = [];

    try {
      await testDb.transaction(async (tx) => {
        await tx.insert(caseLawSources).values({
          id: sourceId,
          adapterKey: `analysis-writer-${sourceId}`,
          name: "Analysis writer role",
        });
        await tx.insert(caseLawDecisions).values({
          id: decisionId,
          sourceId,
          caseNumber: `CASE-${decisionId}`,
          court: "Test Court",
          country: "CZE",
          language: "cs",
        });

        await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(WRITER_ROLE)}`));
        const updated = await tx.execute<{ id: string }>(sql`
          UPDATE "case_law_decisions"
          SET "analysis" = ${sql.raw("'{\"sections\":[]}'::jsonb")}
          WHERE "id" = ${decisionId}
          RETURNING "id"
        `);
        updatedIds = updated.rows.map(({ id }) => id);

        // The role can read back only through the granted columns.
        const readBack = await tx.execute<{ analysis: unknown }>(sql`
          SELECT "analysis" FROM "case_law_decisions" WHERE "id" = ${decisionId}
        `);
        expect(readBack.rows.at(0)?.analysis).toEqual({ sections: [] });

        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) {
        throw error;
      }
    }

    expect(updatedIds).toEqual([decisionId]);

    for (const [column, value] of [
      ["court", "'Other Court'"],
      ["country", "'SVK'"],
      ["fulltext", "'x'"],
      ["redacted_at", "now()"],
    ] as const) {
      const error = await rejection(
        async (tx) =>
          await tx.execute(
            sql.raw(
              `UPDATE "case_law_decisions" SET ${quoted(column)} = ${value}`,
            ),
          ),
      );
      expect({ column, isError: error instanceof Error }).toEqual({
        column,
        isError: true,
      });
      expect(errorMessageChain(error)).toContain("permission denied");
    }
  });

  test("cannot insert into or delete from the decisions table", async () => {
    const insertError = await rejection(
      async (tx) =>
        await tx.execute(
          sql.raw(
            `INSERT INTO "case_law_decisions" ("id") VALUES (gen_random_uuid())`,
          ),
        ),
    );
    expect(insertError).toBeInstanceOf(Error);
    expect(errorMessageChain(insertError)).toContain("permission denied");

    const deleteError = await rejection(
      async (tx) =>
        await tx.execute(sql.raw(`DELETE FROM "case_law_decisions"`)),
    );
    expect(deleteError).toBeInstanceOf(Error);
    expect(errorMessageChain(deleteError)).toContain("permission denied");
  });

  test("is an unprivileged role with no attribute escapes", async () => {
    const result = await testDb.execute<{
      superuser: boolean;
      bypassRls: boolean;
      createRole: boolean;
      createDb: boolean;
      replication: boolean;
      canLogin: boolean;
      inherit: boolean;
      memberships: string[];
    }>(sql`
      SELECT
        rolsuper AS "superuser",
        rolbypassrls AS "bypassRls",
        rolcreaterole AS "createRole",
        rolcreatedb AS "createDb",
        rolreplication AS "replication",
        rolcanlogin AS "canLogin",
        rolinherit AS "inherit",
        ARRAY(
          SELECT granted.rolname
          FROM pg_auth_members AS members
          INNER JOIN pg_roles AS granted ON granted.oid = members.roleid
          WHERE members.member = roles.oid
          ORDER BY granted.rolname
        ) AS "memberships"
      FROM pg_roles AS roles
      WHERE rolname = ${WRITER_ROLE}
    `);

    expect(result.rows.at(0)).toEqual({
      superuser: false,
      bypassRls: false,
      createRole: false,
      createDb: false,
      replication: false,
      canLogin: false,
      inherit: true,
      memberships: [],
    });
  });

  test("has policies on exactly the two granted relations", async () => {
    const result = await testDb.execute<{ tablename: string; cmd: string }>(sql`
      SELECT tablename, cmd
      FROM pg_policies
      WHERE schemaname = 'public'
        AND ${WRITER_ROLE} = ANY (roles)
      ORDER BY tablename, cmd
    `);

    expect(result.rows).toEqual([
      { tablename: "case_law_decisions", cmd: "SELECT" },
      { tablename: "case_law_decisions", cmd: "UPDATE" },
      { tablename: "case_law_sources", cmd: "SELECT" },
    ]);
  });
});

type EffectiveGrants = Map<string, Map<string, Set<string>>>;

const stripLineComments = (contents: string): string =>
  contents
    .split(/\r?\n/u)
    .map((line) => {
      const commentStart = line.indexOf("--");
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join("\n");

const WRITER_STATEMENT_PATTERN =
  /^(?<verb>GRANT|REVOKE) (?<privilege>SELECT|UPDATE) \((?<columns>[^)]+)\) ON TABLE "?(?<table>[a-z_]+)"? (?:TO|FROM) "?stella_case_law_analysis_writer"?$/iu;
const WRITER_ROLE_NAME_PATTERN = /\bstella_case_law_analysis_writer\b/iu;
const WRITER_DDL_PATTERN =
  /^(?:CREATE ROLE|GRANT USAGE|CREATE POLICY|DROP POLICY|DROP ROLE)\b/iu;

/** Fold every migration's column grants for the role into one effective map. */
const foldWriterGrants = (sqlSources: readonly string[]): EffectiveGrants => {
  const effective: EffectiveGrants = new Map();
  for (const source of sqlSources) {
    for (const raw of stripLineComments(source).split(";")) {
      const statement = raw.replaceAll(/\s+/gu, " ").trim();
      const match = WRITER_STATEMENT_PATTERN.exec(statement);
      if (match?.groups === undefined) {
        if (
          WRITER_ROLE_NAME_PATTERN.test(statement) &&
          !WRITER_DDL_PATTERN.test(statement)
        ) {
          throw new Error(`Unsupported writer grant statement: ${statement}`);
        }
        continue;
      }
      const privilege = (match.groups["privilege"] ?? "").toUpperCase();
      const table = match.groups["table"] ?? "";
      const byPrivilege =
        effective.get(privilege) ?? new Map<string, Set<string>>();
      const columns = byPrivilege.get(table) ?? new Set<string>();
      for (const column of (match.groups["columns"] ?? "")
        .split(",")
        .map((entry) => entry.trim().replaceAll('"', ""))) {
        if (match.groups["verb"]?.toUpperCase() === "GRANT") {
          columns.add(column);
        } else {
          columns.delete(column);
        }
      }
      if (columns.size === 0) {
        byPrivilege.delete(table);
      } else {
        byPrivilege.set(table, columns);
      }
      effective.set(privilege, byPrivilege);
    }
  }
  return effective;
};

const asRecord = (grants: EffectiveGrants, privilege: string) =>
  Object.fromEntries(
    [...(grants.get(privilege) ?? new Map<string, Set<string>>()).entries()]
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(([table, columns]) => [table, [...columns].toSorted()]),
  );

const expectedRecord = (columnsByRelation: Record<string, readonly string[]>) =>
  Object.fromEntries(
    Object.entries(columnsByRelation).map(([relation, columns]) => [
      relation,
      [...columns].toSorted(),
    ]),
  );

describe("case-law analysis writer migrations", () => {
  test("effective migration grants equal the source-of-truth map", () => {
    const sources = readdirSync(DRIZZLE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        nodePath.resolve(DRIZZLE_DIR, entry.name, "migration.sql"),
      )
      .filter((path) => existsSync(path))
      .toSorted()
      .map((path) => readFileSync(path, "utf-8"));

    const grants = foldWriterGrants(sources);

    expect(asRecord(grants, "SELECT")).toEqual(
      expectedRecord(CASE_LAW_ANALYSIS_WRITER_SELECT_COLUMNS),
    );
    expect(asRecord(grants, "UPDATE")).toEqual(
      expectedRecord(CASE_LAW_ANALYSIS_WRITER_UPDATE_COLUMNS),
    );
  });

  test("rejects writer grant syntax outside the audited grammar", () => {
    expect(() =>
      foldWriterGrants([
        'GRANT SELECT ON TABLE "case_law_decisions" TO stella_case_law_analysis_writer;',
      ]),
    ).toThrow("Unsupported writer grant statement");
    expect(() =>
      foldWriterGrants([
        "GRANT ALL ON ALL TABLES IN SCHEMA public TO stella_case_law_analysis_writer;",
      ]),
    ).toThrow("Unsupported writer grant statement");
  });
});
