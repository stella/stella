import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { WORKSPACE_ACCESS_MODE } from "@/api/db/rls";
import {
  auditLogs,
  BILLING_ARRANGEMENT_MODES,
  billingArrangements,
  timeTimers,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  REVIEW_RESET_CLEARED_TABLES,
  sweepReviewOrganization,
} from "@/api/lib/review-organization/reset-scope";
import { closeRemovedMemberActiveTimer } from "@/api/lib/time-entry-offboarding";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { withLegacyWorkspaceFixture } from "@/api/tests/helpers/workspace-creation";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)(
  "timer offboarding with a non-bypassing owner",
  () => {
    test("pauses the clock, clears both matters, and preserves the aggregate role context", async () => {
      if (databaseUrl === undefined) {
        panic("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db, sql: client } = openClient();
        const suffix = Bun.randomUUIDv7().replaceAll("-", "");
        const schema = `timer_cleanup_${suffix}`;
        const ownerRole = `timer_owner_${suffix}`;
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const timerId = createSafeId<"timeTimer">();
        await client.unsafe(`CREATE SCHEMA ${schema}`);
        try {
          await client.unsafe(`CREATE ROLE ${ownerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS;
          GRANT ${ownerRole} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
          GRANT stella TO ${ownerRole} WITH INHERIT FALSE, SET TRUE;
          GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${ownerRole};
          GRANT USAGE ON SCHEMA ${schema} TO stella;
          SET search_path TO ${schema}, public`);
          for (const table of ["time_entries", "time_timers", "audit_logs"]) {
            await client.unsafe(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL);
            ALTER TABLE ${table} OWNER TO ${ownerRole};
            GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO stella`);
          }
          await client.unsafe(`CREATE TABLE member (organization_id text, user_id text);
          INSERT INTO member VALUES ('${organizationId}', '${userId}');
          GRANT SELECT ON member TO stella;
          ALTER TABLE ${schema}.time_timers ENABLE ROW LEVEL SECURITY;
          ALTER TABLE ${schema}.time_timers FORCE ROW LEVEL SECURITY`);
          const migration = await Bun.file(
            new URL(
              "../../drizzle/20261003122300_global_timers/migration.sql",
              import.meta.url,
            ),
          ).text();
          for (const statement of migration.split("--> statement-breakpoint")) {
            if (
              statement.includes("CREATE POLICY") &&
              statement.includes('ON "time_timers"')
            ) {
              await client.unsafe(statement);
            }
          }
          const scopedDb = createScopedDb(
            markRlsDatabase(db),
            [],
            organizationId,
            userId,
          );
          await scopedDb(
            async (tx) =>
              await tx.insert(timeTimers).values({
                id: timerId,
                organizationId,
                userId,
                state: "running",
                startedAt: new Date(Date.now() - 120_000),
                lastResumedAt: new Date(Date.now() - 120_000),
                accumulatedSeconds: 60,
              }),
          );
          await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT set_config('role', ${ownerRole}, true),
            set_config('app.organization_id', 'aggregate-sentinel', true),
            set_config('app.workspace_access_mode', ${WORKSPACE_ACCESS_MODE.membership}, true)`);
            const [posture] = await tx
              .select({
                superuser: sql<boolean>`(SELECT rolsuper FROM pg_roles WHERE rolname = current_user)`,
                bypass: sql<boolean>`(SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)`,
              })
              .from(sql`(SELECT 1) AS owner_posture`);
            expect(posture).toEqual({ superuser: false, bypass: false });
            expect(await tx.select().from(timeTimers)).toHaveLength(0);
            const closed = await closeRemovedMemberActiveTimer({
              tx,
              organizationId,
              userId,
            });
            expect(Result.isOk(closed)).toBe(true);
            const [context] = await tx
              .select({
                role: sql<string>`current_user`,
                organizationId: sql<string>`current_setting('app.organization_id')`,
                mode: sql<string>`current_setting('app.workspace_access_mode')`,
              })
              .from(sql`(SELECT 1) AS aggregate_context`);
            expect(context).toEqual({
              role: ownerRole,
              organizationId: "aggregate-sentinel",
              mode: WORKSPACE_ACCESS_MODE.membership,
            });
          });
          const [paused] = await scopedDb(
            async (tx) =>
              await tx
                .select()
                .from(timeTimers)
                .where(eq(timeTimers.id, timerId)),
          );
          expect(paused?.state).toBe("paused");
          expect(paused?.lastResumedAt).toBeNull();
          expect(paused?.accumulatedSeconds).toBeGreaterThanOrEqual(180);
          const events = await db
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.resourceId, timerId));
          expect(events).toHaveLength(1);
          const firstWorkspaceId = createSafeId<"workspace">();
          const secondWorkspaceId = createSafeId<"workspace">();
          const workspaceIds = [firstWorkspaceId, secondWorkspaceId];
          const login = (await client`SELECT current_user AS role`).at(0)?.role;
          if (typeof login !== "string") {
            panic("Fixture login required");
          }
          const PRE_VISIBILITY_SCHEMA = `CREATE TABLE workspaces (id uuid PRIMARY KEY, organization_id text);
            ALTER TABLE workspaces OWNER TO ${ownerRole};
            CREATE TABLE billing_arrangements (LIKE public.billing_arrangements INCLUDING ALL);
            ALTER TABLE billing_arrangements OWNER TO ${ownerRole};
            ALTER TABLE billing_arrangements ENABLE ROW LEVEL SECURITY;
            ALTER TABLE billing_arrangements FORCE ROW LEVEL SECURITY;
            GRANT SELECT, INSERT, UPDATE, DELETE ON billing_arrangements TO stella;
            CREATE POLICY reset_census ON billing_arrangements FOR SELECT TO "${login.replaceAll('"', '""')}" USING (true)`;
          await client.unsafe(PRE_VISIBILITY_SCHEMA);
          const billingMigration = await Bun.file(
            new URL(
              "../../drizzle/20261003122900_billing_modes/migration.sql",
              import.meta.url,
            ),
          ).text();
          for (const statement of billingMigration.split(
            "--> statement-breakpoint",
          )) {
            if (
              statement.includes("CREATE POLICY") &&
              statement.includes('ON "billing_arrangements"')
            ) {
              await client.unsafe(statement);
            }
          }
          await withLegacyWorkspaceFixture({
            tx: db,
            insert: async () =>
              await client`INSERT INTO workspaces VALUES (${firstWorkspaceId}, ${organizationId}), (${secondWorkspaceId}, ${organizationId})`,
          });
          await createScopedDb(
            markRlsDatabase(db),
            workspaceIds,
            organizationId,
            userId,
          )(
            async (tx) =>
              await tx.insert(billingArrangements).values(
                workspaceIds.map((workspaceId) => ({
                  workspaceId,
                  organizationId,
                  mode: BILLING_ARRANGEMENT_MODES[0],
                  currency: "USD",
                })),
              ),
          );
          const existingTables = new Set([
            "time_entries",
            "time_timers",
            "billing_arrangements",
          ]);
          // Unrelated reset tables are empty FK targets; the clock and its
          // forced policies retain their shipped definitions above.
          await client.unsafe(
            REVIEW_RESET_CLEARED_TABLES.filter(
              (name) => !existingTables.has(name),
            )
              .map(
                (name) =>
                  `CREATE TABLE ${schema}.${name} (id uuid, organization_id text); ALTER TABLE ${schema}.${name} OWNER TO ${ownerRole}`,
              )
              .join("; "),
          );
          await client.unsafe(
            `CREATE TABLE user_files (id uuid, thread_id uuid); ALTER TABLE user_files OWNER TO ${ownerRole}`,
          );
          await db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT set_config('role', ${ownerRole}, true)`,
            );
            const swept = await sweepReviewOrganization(
              tx,
              organizationId,
              userId,
            );
            expect(swept.get("time_timers")).toBe(1);
            expect(swept.get("billing_arrangements")).toBe(2);
          });
          const census = openClient().sql;
          const remaining = await census.unsafe<{ count: number }[]>(
            `SELECT count(*)::int AS count FROM ${schema}.billing_arrangements`,
          );
          expect(remaining.at(0)?.count).toBe(0);
          expect(
            await scopedDb(async (tx) => await tx.select().from(timeTimers)),
          ).toHaveLength(0);
        } finally {
          await client.unsafe(
            `RESET ROLE; RESET search_path; DROP SCHEMA ${schema} CASCADE; DROP ROLE IF EXISTS ${ownerRole}`,
          );
        }
      });
    });
  },
);
