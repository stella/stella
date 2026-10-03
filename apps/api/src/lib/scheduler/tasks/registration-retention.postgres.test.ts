import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";

import {
  REGISTRATION_RETENTION_BATCH_SIZE,
  registrationRetentionClientCandidates,
  registrationRetentionRegistrationCandidates,
} from "@/api/lib/scheduler/tasks/registration-retention";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const TABLES = [
  "oauth_client",
  "agent_registration",
  "oauth_consent",
  "oauth_access_token",
  "oauth_refresh_token",
  "verification",
  "oauth_client_assertion",
] as const;
const indexMigration = readFileSync(
  new URL(
    "../../../../drizzle/20261003124700_registration_retention_indexes/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);

describe.skipIf(!enabled)(
  "registration retention access paths (postgres)",
  () => {
    test("bounds separate indexed registration cohorts", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const schemaName = `registration_plan_${Bun.randomUUIDv7().replaceAll("-", "")}`;
        const schema = sql.identifier(schemaName);
        await db.execute(sql`CREATE SCHEMA ${schema}`);
        try {
          for (const table of TABLES) {
            await db.execute(
              sql`CREATE TABLE ${schema}.${sql.identifier(table)} (LIKE public.${sql.identifier(table)} INCLUDING ALL)`,
            );
          }
          await db.execute(sql`SET search_path TO ${schema}, public`);
          await db.execute(
            sql`ALTER TABLE oauth_client ADD COLUMN IF NOT EXISTS registration_origin text NOT NULL DEFAULT 'managed'`,
          );
          const copiedIndexes = await db.execute<{
            name: string;
          }>(sql`SELECT indexname AS name FROM pg_indexes
          WHERE schemaname = ${schemaName} AND (indexdef LIKE '%registration_origin%' OR indexdef LIKE '%expires_at%')`);
          for (const { name } of copiedIndexes) {
            await db.execute(sql`DROP INDEX ${schema}.${sql.identifier(name)}`);
          }
          const creates = indexMigration
            .split("--> statement-breakpoint")
            .map((part) => part.replace(/^\s*--[^\n]*(?:\n|$)/gmu, "").trim())
            .filter((part) => part.startsWith("CREATE INDEX CONCURRENTLY"));
          for (const statement of creates) {
            await db.execute(
              sql.raw(
                statement.replace(
                  "CREATE INDEX CONCURRENTLY",
                  "CREATE INDEX IF NOT EXISTS",
                ),
              ),
            );
          }
          await db.execute(sql`INSERT INTO oauth_client (id, client_id, redirect_uris, registration_origin, created_at, updated_at)
          SELECT 'managed-' || n, 'managed-' || n, '{}', 'managed', '2026-01-01'::timestamptz, '2026-01-01'::timestamptz
          FROM generate_series(1, 10000) n`);
          await db.execute(sql`INSERT INTO oauth_client (id, client_id, redirect_uris, registration_origin, created_at, updated_at)
          SELECT 'open-' || n, 'open-' || n, '{}', 'open-client', '2026-01-01'::timestamptz, '2026-01-01'::timestamptz
          FROM generate_series(1, 150) n`);
          await db.execute(sql`INSERT INTO oauth_client (id, client_id, redirect_uris, registration_origin, created_at, updated_at)
          SELECT 'agent-' || n, 'agent-' || n, '{}', 'agent', '2026-01-01'::timestamptz, '2026-01-01'::timestamptz
          FROM generate_series(1, 10) n`);
          await db.execute(sql`INSERT INTO agent_registration (id, client_id, registration_type, status, claim_token_hash, client_secret_sink, expires_at)
          SELECT 'registration-' || n, 'agent-' || n, 'anonymous', 'pending', 'registration-' || n, 'stored-value', '2026-01-01'::timestamptz
          FROM generate_series(1, 10) n`);
          await db.execute(sql`INSERT INTO agent_registration (id, client_id, registration_type, status, bound_user_id, claim_token_hash, client_secret_sink, expires_at)
          SELECT 'completed-' || n, 'completed-' || n, 'anonymous', 'confirmed', 'member', 'completed-' || n, 'stored-value', '2026-01-01'::timestamptz
          FROM generate_series(1, 10000) n`);
          await db.execute(sql`INSERT INTO verification (id, identifier, value, expires_at)
          SELECT 'value-' || n, 'value-' || n, 'email-value', '2026-01-01'::timestamptz FROM generate_series(1, 10000) n`);
          for (const table of TABLES) {
            await db.execute(sql`ANALYZE ${sql.identifier(table)}`);
          }
          const registrationStatement =
            registrationRetentionRegistrationCandidates(
              new Date("2026-10-03T12:00:00Z"),
            );
          const registrationPlan = explainRoot(
            await db.execute(
              sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${registrationStatement}`,
            ),
          );
          expect(
            scanOccurrences(registrationPlan).map(({ index }) => index),
          ).toContain("agent_registration_expiry_idx");
          const selectedRegistrations = await db.execute<{ client_id: string }>(
            registrationStatement,
          );
          const statement = registrationRetentionClientCandidates(
            new Date("2026-10-03T12:00:00Z"),
            selectedRegistrations.map(({ client_id }) => client_id),
          );
          const plan = explainRoot(
            await db.execute(
              sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
            ),
          );
          const scans = scanOccurrences(plan);
          const indexes = scans.map(({ index }) => index);
          expect(indexes).toContain("oauth_client_registration_retention_idx");
          expect(indexes).toContain("verification_expires_at_idx");
          expect((await db.execute(statement)).length).toBe(
            REGISTRATION_RETENTION_BATCH_SIZE,
          );
        } finally {
          await db.execute(sql`SET search_path TO public`);
          await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
        }
      });
    }, 120_000);
  },
);
