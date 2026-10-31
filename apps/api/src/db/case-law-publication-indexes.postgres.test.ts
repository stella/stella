import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import type { OnlineIndexDeclaration } from "./online-ddl";
import { ONLINE_MIGRATION_INDEXES } from "./online-migrations";

const databaseUrl = process.env["DATABASE_URL"];
const enabled =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" &&
  databaseUrl !== undefined;

describe.skipIf(!enabled)(
  "case-law publication index definitions (postgres)",
  () => {
    test("installed definitions match the canonical publication predicate", async () => {
      if (databaseUrl === undefined) {
        panic("DATABASE_URL is required");
      }
      const definitions: readonly OnlineIndexDeclaration[] =
        ONLINE_MIGRATION_INDEXES.filter(
          ({ name, tableName }) =>
            tableName === "case_law_decisions" &&
            name.includes("published") &&
            name !== "case_law_decisions_republished_ruling_idx",
        );
      expect(definitions.length).toBeGreaterThan(0);

      const schemaName = `case_law_pub_idx_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const schema = sql.identifier(schemaName);
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        await db.execute(sql`CREATE SCHEMA ${schema}`);
        try {
          await db.execute(sql`
            CREATE TABLE ${schema}.publication_index_fixture (
              id uuid NOT NULL,
              country text NOT NULL,
              court text NOT NULL,
              decision_date date,
              citation_key text,
              source_id uuid NOT NULL,
              created_at timestamptz NOT NULL,
              updated_at timestamptz NOT NULL,
              decision_type text,
              language text NOT NULL,
              citation_authority double precision NOT NULL,
              language_group_key text,
              redacted_at timestamptz,
              metadata jsonb NOT NULL
            )
          `);

          for (const definition of definitions) {
            const createSql = definition.createSql;
            if (createSql === undefined) {
              panic(`Publication index ${definition.name} has no create SQL`);
            }
            const fixtureIndexName = `${definition.name}_fixture`;
            const fixtureCreateSql = createSql
              .replace(`"${definition.name}"`, () => `"${fixtureIndexName}"`)
              .replace(
                'ON public."case_law_decisions"',
                () => `ON ${schemaName}."publication_index_fixture"`,
              );
            await db.execute(sql.raw(fixtureCreateSql));

            const [index] = executedRows(
              await db.execute(sql`
                SELECT index_state.indisvalid AS valid,
                       index_state.indisready AS ready,
                       pg_get_indexdef(index_state.indexrelid) AS definition
                FROM pg_index index_state
                JOIN pg_class index_relation
                  ON index_relation.oid = index_state.indexrelid
                JOIN pg_namespace index_schema
                  ON index_schema.oid = index_relation.relnamespace
                WHERE index_schema.nspname = ${schemaName}
                  AND index_relation.relname = ${fixtureIndexName}
              `),
            );
            if (!isRecord(index)) {
              panic(`PostgreSQL did not return ${fixtureIndexName}`);
            }
            const actual = index["definition"];
            const expected = definition.definitionBody;
            if (typeof actual !== "string" || typeof expected !== "string") {
              panic(`Index definition is missing for ${fixtureIndexName}`);
            }
            const normalized = actual.replace(/^CREATE INDEX \S+ ON \S+ /u, "");
            const expectedBody = expected.replace(/^ON \S+ /u, "");
            expect(index["valid"]).toBe(true);
            expect(index["ready"]).toBe(true);
            expect(normalized).toBe(expectedBody);
          }
        } finally {
          await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
        }
      });
    });
  },
);
