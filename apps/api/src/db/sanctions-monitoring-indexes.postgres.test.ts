import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { ONLINE_MIGRATION_INDEXES } from "./online-migrations";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];

if (!runPostgresTests) {
  describe.skip("monitoring tenant retry access path", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("the installed tenant retry index bounds an ordered page among other tenants' due marks", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL is required");
    }
    const indexName = "sanctions_contact_marks_organization_retry_idx";
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      await openClient().db.transaction(async (tx) => {
        const installed = await tx.execute(sql`
          SELECT i.indisvalid, i.indisready
          FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ${indexName}
        `);
        expect(installed).toEqual([{ indisvalid: true, indisready: true }]);
        await tx.execute(sql`
          CREATE TEMP TABLE monitoring_retry_index_plan (
            organization_id text NOT NULL, contact_id uuid NOT NULL,
            next_attempt_at timestamptz NOT NULL, scheduled_at timestamptz NOT NULL
          ) ON COMMIT DROP
        `);
        const definitions = ONLINE_MIGRATION_INDEXES.filter(
          ({ tableName }) => tableName === "sanctions_contact_marks",
        ).map(({ createSql }) => {
          if (createSql === undefined) {
            return panic("Retry indexes declare their creation SQL");
          }
          return createSql
            .replace("CREATE INDEX CONCURRENTLY", "CREATE INDEX")
            .replace(
              'public."sanctions_contact_marks"',
              'pg_temp."monitoring_retry_index_plan"',
            );
        });
        await tx.execute(sql.raw(definitions.join(";")));
        // A substantial tenant backlog exercises LIMIT's ordered index path;
        // a nearly exhausted queue can legitimately favor a bitmap scan and sort.
        await tx.execute(sql`
          INSERT INTO monitoring_retry_index_plan
          SELECT CASE WHEN n <= 2000 THEN 'target' ELSE 'other-' || (n % 10)::text END,
                 gen_random_uuid(),
                 TIMESTAMPTZ '2026-10-05 12:00:00+00' - ((n * 7919) % 20000) * interval '1 minute',
                 TIMESTAMPTZ '2026-10-05 12:00:00+00' - ((n * 3571) % 20000) * interval '1 minute'
          FROM generate_series(1, 20000) n
        `);
        await tx.execute(sql`ANALYZE monitoring_retry_index_plan`);
        const plan = await tx.execute(sql`
          EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
          SELECT contact_id FROM monitoring_retry_index_plan
          WHERE organization_id = 'target'
            AND next_attempt_at <= TIMESTAMPTZ '2026-10-05 12:00:00+00'
            AND scheduled_at <= TIMESTAMPTZ '2026-10-05 12:00:00+00'
          ORDER BY next_attempt_at, scheduled_at, contact_id LIMIT 101
        `);
        const text = plan.map((row) => String(row["QUERY PLAN"])).join("\n");
        expect(text).toContain(indexName);
        expect(text).toContain("Index Cond:");
        expect(text).toContain("organization_id = 'target'");
        expect(text).not.toContain("Sort");
      });
    });
  });
}
