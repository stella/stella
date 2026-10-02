import { describe, expect } from "bun:test";
import { sql } from "drizzle-orm";

import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { registerExpressionBackfillCases } from "@/api/tests/helpers/legislation-expression-id-backfill-cases";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("expression backfill on PostgreSQL 18", () => {
  if (databaseUrl === undefined) {
    return;
  }
  const fixture = openGatedTestDatabase(databaseUrl, { max: 1 });
  const { db } = fixture;
  const testSchema = `expression_backfill_${Bun.randomUUIDv7().replaceAll("-", "")}`;
  fixture.cleanUp(async () => {
    await db.execute(sql.raw(`DROP SCHEMA ${testSchema} CASCADE`));
  });
  registerExpressionBackfillCases({
    engine: "postgres",
    openDatabase: async () => {
      const version = await db.execute(
        sql`SELECT current_setting('server_version_num')::int AS version`,
      );
      expect(version.at(0)?.["version"]).toBeGreaterThanOrEqual(180_000);
      expect(version.at(0)?.["version"]).toBeLessThan(190_000);
      await db.execute(sql.raw(`CREATE SCHEMA ${testSchema}`));
      for (const table of [
        "legislation_sources",
        "legislation_documents",
        "legislation_work_names",
        "scheduler_jobs",
        "scheduler_job_runs",
        "database_backfill_states",
        "corpus_index_generations",
        "corpus_index_projection_states",
      ]) {
        // db-await-in-loop: clone only the fixture's tables before selecting its schema.
        await db.execute(
          sql.raw(
            `CREATE TABLE ${testSchema}.${table} (LIKE public.${table} INCLUDING ALL)`,
          ),
        );
      }
      await db.execute(sql.raw(`SET search_path TO ${testSchema}, public`));
      return db;
    },
  });
});
