import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { stellaCorpusSampleReader } from "@/api/db/rls";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { CORPUS_SAMPLE_READER_SELECT_COLUMNS } from "@/api/tests/pglite-test-db";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
const READER_ROLE = stellaCorpusSampleReader.name;

// Tables that hold matter and identity data. The reader touches the public
// corpus only, so it must hold no privilege of any kind on them.
const FORBIDDEN_RELATIONS = ["workspaces", "user"] as const;
const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
const COLUMN_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "REFERENCES"] as const;

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

const expectedSelectColumns = Object.entries(
  CORPUS_SAMPLE_READER_SELECT_COLUMNS,
)
  .flatMap(([relation, columns]) =>
    columns.map((column) => `${relation}.${column}`),
  )
  .toSorted();

const expectedRelations = Object.keys(
  CORPUS_SAMPLE_READER_SELECT_COLUMNS,
).toSorted();

let testDb: TestDatabase;

/** Every public column the role holds `privilege` on, as `relation.column`. */
const grantedColumns = async (
  privilege: (typeof COLUMN_PRIVILEGES)[number],
) => {
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
        ${privilege}
      )
    ORDER BY qualified
  `);
  return result.rows.map(({ qualified }) => qualified);
};

const rejection = async (statement: string): Promise<unknown> =>
  await testDb
    .transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(READER_ROLE)}`));
      await tx.execute(sql.raw(statement));
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

describe("corpus sample reader role", () => {
  test("reads exactly the granted columns and nothing else", async () => {
    expect(await grantedColumns("SELECT")).toEqual(expectedSelectColumns);
  });

  test("holds no column-level write or reference privilege", async () => {
    for (const privilege of COLUMN_PRIVILEGES.filter(
      (entry) => entry !== "SELECT",
    )) {
      expect({ privilege, columns: await grantedColumns(privilege) }).toEqual({
        privilege,
        columns: [],
      });
    }
  });

  test("has no table-level privilege and cannot create in the schema", async () => {
    const result = await testDb.execute<{
      canCreate: boolean;
      canUseSchema: boolean;
      privilegedTables: string[];
      privilegedSequences: string[];
      ownedObjects: string[];
    }>(sql`
      SELECT
        has_schema_privilege(${READER_ROLE}, 'public', 'CREATE') AS "canCreate",
        has_schema_privilege(${READER_ROLE}, 'public', 'USAGE') AS "canUseSchema",
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
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            )
          ORDER BY tables.relname
        ) AS "privilegedTables",
        ARRAY(
          SELECT sequences.relname
          FROM pg_class AS sequences
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = sequences.relnamespace
          WHERE schemas.nspname = 'public'
            -- CASE pins the evaluation order: the planner may otherwise call
            -- has_sequence_privilege on a non-sequence and error.
            AND CASE
              WHEN sequences.relkind = 'S' THEN has_sequence_privilege(
                ${READER_ROLE},
                sequences.oid,
                'USAGE,SELECT,UPDATE'
              )
              ELSE false
            END
          ORDER BY sequences.relname
        ) AS "privilegedSequences",
        ARRAY(
          SELECT owned.relname
          FROM pg_class AS owned
          INNER JOIN pg_roles AS owners ON owners.oid = owned.relowner
          WHERE owners.rolname = ${READER_ROLE}
          ORDER BY owned.relname
        ) AS "ownedObjects"
    `);

    expect(result.rows.at(0)).toEqual({
      canCreate: false,
      canUseSchema: true,
      privilegedTables: [],
      privilegedSequences: [],
      ownedObjects: [],
    });
  });

  test("holds no privilege at all on matter and identity tables", async () => {
    for (const relation of FORBIDDEN_RELATIONS) {
      for (const privilege of TABLE_PRIVILEGES) {
        const result = await testDb.execute<{ onTable: boolean }>(sql`
          SELECT has_table_privilege(
            ${READER_ROLE},
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
    }
  });

  test("SET ROLE can select the granted columns of every relation", async () => {
    await testDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(READER_ROLE)}`));
      for (const [relation, columns] of Object.entries(
        CORPUS_SAMPLE_READER_SELECT_COLUMNS,
      )) {
        await tx.execute(
          sql.raw(
            `SELECT ${columns.map(quoted).join(", ")} FROM ${quoted(relation)} LIMIT 0`,
          ),
        );
      }
    });
  });

  test("SET ROLE is refused columns outside the grant and every write", async () => {
    for (const statement of [
      `SELECT "sections" FROM "case_law_decisions"`,
      `SELECT "source_id" FROM "case_law_decisions"`,
      `SELECT "citation_key" FROM "case_law_citations"`,
      `SELECT "polarity_rule_id" FROM "case_law_citations"`,
      `SELECT "decision_id" FROM "case_law_corpus_tombstones"`,
      `SELECT "sections" FROM "legislation_documents"`,
      `SELECT "slug" FROM "legislation_documents"`,
      `SELECT "config" FROM "legislation_sources"`,
      `SELECT "id" FROM "case_law_sources"`,
      `SELECT "id" FROM "case_law_polarity_rules"`,
      `UPDATE "case_law_citations" SET "polarity" = NULL`,
      `UPDATE "legislation_documents" SET "title" = ''`,
      `DELETE FROM "case_law_decisions"`,
      `INSERT INTO "legislation_sources" ("adapter_key") VALUES ('x')`,
      ...FORBIDDEN_RELATIONS.map(
        (relation) => `SELECT "id" FROM ${quoted(relation)}`,
      ),
    ]) {
      const error = await rejection(statement);
      expect({ statement, isError: error instanceof Error }).toEqual({
        statement,
        isError: true,
      });
      expect(errorMessageChain(error)).toContain("permission denied");
    }
  });

  test("is an unprivileged role with no attribute escapes", async () => {
    const result = await testDb.execute<{
      superuser: boolean;
      bypassRls: boolean;
      createRole: boolean;
      createDb: boolean;
      replication: boolean;
      canLogin: boolean;
      memberships: string[];
    }>(sql`
      SELECT
        rolsuper AS "superuser",
        rolbypassrls AS "bypassRls",
        rolcreaterole AS "createRole",
        rolcreatedb AS "createDb",
        rolreplication AS "replication",
        rolcanlogin AS "canLogin",
        ARRAY(
          SELECT granted.rolname
          FROM pg_auth_members AS members
          INNER JOIN pg_roles AS granted ON granted.oid = members.roleid
          WHERE members.member = roles.oid
          ORDER BY granted.rolname
        ) AS "memberships"
      FROM pg_roles AS roles
      WHERE rolname = ${READER_ROLE}
    `);

    expect(result.rows.at(0)).toEqual({
      superuser: false,
      bypassRls: false,
      createRole: false,
      createDb: false,
      replication: false,
      canLogin: false,
      memberships: [],
    });
  });

  test("has a select policy on exactly the granted relations", async () => {
    const result = await testDb.execute<{
      tablename: string;
      cmd: string;
      qual: string;
    }>(sql`
      SELECT tablename, cmd, qual
      FROM pg_policies
      WHERE schemaname = 'public'
        AND ${READER_ROLE} = ANY (roles)
      ORDER BY tablename, cmd
    `);

    expect(result.rows).toEqual(
      expectedRelations.map((tablename) => ({
        tablename,
        cmd: "SELECT",
        qual:
          tablename === "case_law_decisions" ? "(redacted_at IS NULL)" : "true",
      })),
    );
  });

  test("SET ROLE sees unredacted decisions and never redacted ones", async () => {
    const sourceId = createSafeId<"caseLawSource">();
    const visibleId = createSafeId<"caseLawDecision">();
    const redactedId = createSafeId<"caseLawDecision">();
    let seen: string[] = [];

    await testDb
      .transaction(async (tx) => {
        await tx.insert(caseLawSources).values({
          id: sourceId,
          adapterKey: `corpus-sample-reader-${sourceId}`,
          name: "Corpus sample reader role",
        });
        await tx.insert(caseLawDecisions).values([
          {
            id: visibleId,
            sourceId,
            caseNumber: `CASE-${visibleId}`,
            court: "Test Court",
            country: "CZE",
            language: "cs",
          },
          {
            id: redactedId,
            sourceId,
            caseNumber: `CASE-${redactedId}`,
            court: "Test Court",
            country: "CZE",
            language: "cs",
            redactedAt: new Date("2026-09-01T00:00:00.000Z"),
            textS3Key: `text/${redactedId}`,
          },
        ]);

        await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(READER_ROLE)}`));
        const result = await tx.execute<{ id: string }>(sql`
          SELECT id FROM case_law_decisions
          WHERE id IN (${visibleId}, ${redactedId})
        `);
        seen = result.rows.map(({ id }) => id);
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) {
          throw error;
        }
      });

    expect(seen).toEqual([visibleId]);
  });

  test("row security is enabled on every granted relation", async () => {
    const result = await testDb.execute<{ relname: string }>(sql`
      SELECT tables.relname
      FROM pg_class AS tables
      INNER JOIN pg_namespace AS schemas ON schemas.oid = tables.relnamespace
      WHERE schemas.nspname = 'public'
        AND tables.relrowsecurity
        AND tables.relname = ANY (${`{${expectedRelations.join(",")}}`}::text[])
      ORDER BY tables.relname
    `);

    expect(result.rows.map(({ relname }) => relname)).toEqual(
      expectedRelations,
    );
  });
});

const stripLineComments = (contents: string): string =>
  contents
    .split(/\r?\n/u)
    .map((line) => {
      const commentStart = line.indexOf("--");
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join("\n");

const READER_GRANT_PATTERN =
  /^(?<verb>GRANT|REVOKE) SELECT \((?<columns>[^)]+)\) ON TABLE "?(?<table>[a-z_]+)"? (?:TO|FROM) "?stella_corpus_sample_reader"?$/iu;
const READER_ROLE_NAME_PATTERN = /\bstella_corpus_sample_reader\b/iu;
const READER_DDL_PATTERN =
  /^(?:CREATE ROLE "?stella_corpus_sample_reader"? NOLOGIN|GRANT USAGE ON SCHEMA public TO "?stella_corpus_sample_reader"?|CREATE POLICY "\w+" ON "?[a-z_]+"? AS PERMISSIVE FOR SELECT TO "?stella_corpus_sample_reader"? USING \((?:true|redacted_at IS NULL)\)|DROP POLICY (?:IF EXISTS )?"\w+" ON "?[a-z_]+"?)$/iu;

/** Fold every migration's column grants for the role into one effective map. */
const foldReaderGrants = (
  sqlSources: readonly string[],
): Map<string, Set<string>> => {
  const effective = new Map<string, Set<string>>();
  for (const source of sqlSources) {
    for (const raw of stripLineComments(source).split(";")) {
      const statement = raw.replaceAll(/\s+/gu, " ").trim();
      const match = READER_GRANT_PATTERN.exec(statement);
      if (match?.groups === undefined) {
        if (
          READER_ROLE_NAME_PATTERN.test(statement) &&
          !READER_DDL_PATTERN.test(statement)
        ) {
          throw new Error(`Unsupported reader grant statement: ${statement}`);
        }
        continue;
      }
      const table = match.groups["table"] ?? "";
      const columns = effective.get(table) ?? new Set<string>();
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
        effective.delete(table);
      } else {
        effective.set(table, columns);
      }
    }
  }
  return effective;
};

const sortedRecord = (entries: Iterable<[string, Iterable<string>]>) =>
  Object.fromEntries(
    [...entries]
      .map(([table, columns]): [string, string[]] => [
        table,
        [...columns].toSorted(),
      ])
      .toSorted(([a], [b]) => (a < b ? -1 : 1)),
  );

describe("corpus sample reader migrations", () => {
  test("effective migration grants equal the source-of-truth map", () => {
    const sources = readdirSync(DRIZZLE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        nodePath.resolve(DRIZZLE_DIR, entry.name, "migration.sql"),
      )
      .filter((path) => existsSync(path))
      .toSorted()
      .map((path) => readFileSync(path, "utf-8"));

    expect(sortedRecord(foldReaderGrants(sources))).toEqual(
      sortedRecord(Object.entries(CORPUS_SAMPLE_READER_SELECT_COLUMNS)),
    );
  });

  test("rejects reader grant syntax outside the audited grammar", () => {
    for (const statement of [
      'GRANT SELECT ON TABLE "case_law_decisions" TO stella_corpus_sample_reader;',
      "GRANT ALL ON ALL TABLES IN SCHEMA public TO stella_corpus_sample_reader;",
      'GRANT UPDATE (polarity) ON TABLE "case_law_citations" TO stella_corpus_sample_reader;',
      "ALTER ROLE stella_corpus_sample_reader LOGIN;",
      "CREATE ROLE stella_corpus_sample_reader NOLOGIN SUPERUSER;",
      "GRANT USAGE ON SCHEMA public TO stella_corpus_sample_reader WITH GRANT OPTION;",
      'CREATE POLICY "corpus_sample_reader_read" ON "case_law_sources" AS PERMISSIVE FOR SELECT TO "stella_corpus_sample_reader" USING (true) WITH CHECK (true);',
    ]) {
      expect(() => foldReaderGrants([statement])).toThrow(
        "Unsupported reader grant statement",
      );
    }
  });
});
