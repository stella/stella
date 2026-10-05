import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";
import { readFileSync } from "node:fs";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  contacts,
  sanctionsContactMarks,
  sanctionsContactScreenings,
  sanctionsEditionFanouts,
  sanctionsMonitoringBackfills,
  sanctionsOrganizationMarks,
  sanctionsScreeningEvents,
  sanctionsSources,
  systemAuditRuns,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import { queueSanctionsMonitoringBackfills } from "@/api/lib/lists/sanctions/monitoring-fanout";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { drainSanctionsMonitoringTask } from "@/api/lib/scheduler/tasks/sanctions-monitoring";
import { backfillSanctionsMonitoringTask } from "@/api/lib/scheduler/tasks/sanctions-monitoring-backfill";
import type {
  SchedulerDb,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import { TENANT_SYSTEM_ACTOR } from "@/api/lib/system-audit/actors";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("monitoring roles on PostgreSQL", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("migration and scheduler use explicit ingestion SET membership without tenant grants", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`CREATE ROLE monitoring_role_regression NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`,
          );
          await tx.execute(
            sql`GRANT stella_ingestion, stella TO monitoring_role_regression WITH INHERIT FALSE, SET TRUE`,
          );
          await tx.execute(
            sql`GRANT USAGE, CREATE ON SCHEMA public TO monitoring_role_regression`,
          );
          await tx.execute(
            sql`DROP TRIGGER sanctions_new_source_fanout ON public.sanctions_sources`,
          );
          await tx.execute(
            sql`DROP TRIGGER sanctions_active_edition_fanout ON public.sanctions_sources`,
          );
          await tx.execute(
            sql`DROP FUNCTION public.enqueue_sanctions_edition_fanout()`,
          );
          await tx.execute(
            sql`DROP TABLE public.sanctions_edition_fanouts, public.sanctions_monitoring_backfills`,
          );
          await tx.execute(
            sql`ALTER TABLE public.sanctions_sources OWNER TO monitoring_role_regression`,
          );
          await tx.execute(
            sql`ALTER TABLE public.organization OWNER TO monitoring_role_regression`,
          );
          await tx.execute(
            sql`ALTER TABLE public.sanctions_organization_marks OWNER TO monitoring_role_regression`,
          );
          await tx.execute(
            sql`GRANT REFERENCES ON public.organization, public.sanctions_sources, public.sanctions_editions TO monitoring_role_regression`,
          );
          // The fixture's scheduler identity owns the global audit trail, as the migration owner does.
          await tx.execute(
            sql`ALTER TABLE public.system_audit_runs OWNER TO monitoring_role_regression`,
          );
          await tx.execute(
            sql`SET LOCAL SESSION AUTHORIZATION monitoring_role_regression`,
          );
          const identity =
            (
              await tx.execute<{
                session: string;
                current: string;
                superuser: boolean;
                bypass: boolean;
              }>(sql`
            SELECT session_user AS session, current_user AS current, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user
          `)
            ).at(0) ?? panic("Identity missing");
          expect(identity).toEqual({
            session: "monitoring_role_regression",
            current: "monitoring_role_regression",
            superuser: false,
            bypass: false,
          });
          const migration = readFileSync(
            new URL(
              "../../../../drizzle/20261003123000_sanctions_monitoring_backfills/migration.sql",
              import.meta.url,
            ),
            "utf-8",
          );
          // Execute the committed seed and policies under the same non-bypass creator identity.
          await tx.execute(
            sql.raw(migration.replaceAll("--> statement-breakpoint", "\n")),
          );
          await tx.execute(
            sql`ALTER TABLE public.sanctions_monitoring_backfills ALTER COLUMN scheduled_at SET DEFAULT now() + interval '1 hour'`,
          );
          // Keep tenant execution out of this role test; scoped worker state is covered separately.
          await tx.execute(
            sql`CREATE FUNCTION public.defer_monitoring_role_test_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.scheduled_at := now() + interval '1 hour'; RETURN NEW; END $$`,
          );
          await tx.execute(
            sql`CREATE TRIGGER defer_monitoring_role_test_job BEFORE INSERT OR UPDATE ON public.sanctions_monitoring_backfills FOR EACH ROW EXECUTE FUNCTION public.defer_monitoring_role_test_job()`,
          );
          await tx.execute(
            sql`INSERT INTO public.organization (id, name, slug, created_at) VALUES ('monitoring-role-org', 'Monitoring role', 'monitoring-role-org', now())`,
          );
          await tx.execute(
            sql`INSERT INTO public.sanctions_organization_marks (organization_id) VALUES ('monitoring-role-org')`,
          );
          let continued = false;
          await backfillSanctionsMonitoringTask({
            db: asTestRaw<SchedulerDb>(tx),
            signal: new AbortController().signal,
            logger,
            scheduleContinuation: () => {
              continued = true;
            },
            job: asTestRaw<SchedulerTaskContext["job"]>({}),
            payload: null,
            dueAt: DueSlot.of({ nextRunAt: new Date() }),
            runId: asTestRaw<SchedulerTaskContext["runId"]>(
              "monitoring-role-run",
            ),
          });
          expect(continued).toBe(true);
          expect(
            (
              await tx.execute<{ role: string }>(
                sql`SELECT current_user AS role`,
              )
            ).at(0)?.role,
          ).toBe("monitoring_role_regression");
          // Exhaust fanout discovery and exercise its empty return under a nested savepoint.
          await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
          await tx
            .update(sanctionsEditionFanouts)
            .set({ status: "complete" })
            .where(eq(sanctionsEditionFanouts.status, "pending"));
          await tx.execute(sql`RESET ROLE`);
          await queueSanctionsMonitoringBackfills({
            runId: toSafeId<"schedulerJobRun">(Bun.randomUUIDv7()),
            db: asTestRaw<SchedulerDb>(tx),
            now: new Date(),
          });
          expect(
            (
              await tx.execute<{ role: string }>(
                sql`SELECT current_user AS role`,
              )
            ).at(0)?.role,
          ).toBe("monitoring_role_regression");
          expect(
            await tx.select().from(sanctionsMonitoringBackfills),
          ).not.toHaveLength(0);
          await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
          expect(await tx.select().from(sanctionsEditionFanouts)).toHaveLength(
            7,
          );
          const privilege = (
            await tx.execute<{ tenant: boolean }>(
              sql`SELECT has_table_privilege(current_user, 'public.sanctions_monitoring_backfills', 'INSERT') AS tenant`,
            )
          ).at(0);
          expect(privilege?.tenant).toBe(false);
          tx.rollback();
        });
      } catch (error) {
        if (!(error instanceof TransactionRollbackError)) {
          throw error;
        }
      }
    });
  }, 120_000);

  test("both sanctions scheduler tasks execute through the organization RLS handle", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const organizationId = mintAuthProviderId<"organization">();
      const otherOrganizationId = mintAuthProviderId<"organization">();
      const organizations = [organizationId, otherOrganizationId];
      const drainDue = new Date("1900-01-01T00:00:00.000Z");
      const backfillDue = drainDue;
      const drainRunId = toSafeId<"schedulerJobRun">(Bun.randomUUIDv7());
      const backfillRunId = toSafeId<"schedulerJobRun">(Bun.randomUUIDv7());
      const priorFanouts = await db.select().from(sanctionsEditionFanouts);
      const continued: Date[] = [];
      const context = (runId: typeof drainRunId, due: Date = drainDue) => ({
        db: asTestRaw<SchedulerDb>(db),
        signal: new AbortController().signal,
        logger,
        scheduleContinuation: (nextRunAt: Date) => {
          continued.push(nextRunAt);
        },
        job: asTestRaw<SchedulerTaskContext["job"]>({}),
        payload: null,
        dueAt: DueSlot.of({ nextRunAt: due, lockedAt: due }),
        runId,
      });
      let targetId: typeof contacts.$inferSelect.id | undefined;
      let otherId: typeof contacts.$inferSelect.id | undefined;
      try {
        // Keep global discovery from creating jobs outside this test's tenant fixtures.
        await db
          .update(sanctionsEditionFanouts)
          .set({ status: "complete" })
          .where(eq(sanctionsEditionFanouts.status, "pending"));
        const freshness = await readSanctionsFreshness({
          now: backfillDue,
          db: async (run) =>
            await db.transaction(
              async (tx) => await run(asTestRaw<Transaction>(tx)),
            ),
        });
        await db
          .insert(sanctionsEditionFanouts)
          .values(
            freshness.map(({ source, status, edition }) => ({
              sourceId: source,
              editionId: edition?.id ?? null,
              freshnessStatus: status,
              status: "complete" as const,
            })),
          )
          .onConflictDoUpdate({
            target: sanctionsEditionFanouts.sourceId,
            set: {
              editionId: sql`excluded.edition_id`,
              freshnessStatus: sql`excluded.freshness_status`,
              status: "complete",
            },
          });
        await db.insert(organization).values(
          organizations.map((id) => ({
            id,
            name: "Sanctions scheduler fixture",
            slug: id,
            createdAt: new Date(),
          })),
        );
        const seededContacts = await db
          .insert(contacts)
          .values(
            organizations.map((id) => ({
              organizationId: id,
              type: "person" as const,
              displayName: "Scheduler tenant subject",
            })),
          )
          .returning();
        targetId = seededContacts.find(
          ({ organizationId: id }) => id === organizationId,
        )?.id;
        otherId = seededContacts.find(
          ({ organizationId: id }) => id === otherOrganizationId,
        )?.id;
        if (targetId === undefined || otherId === undefined) {
          panic("Sanctions task contacts missing");
        }
        await db
          .delete(sanctionsContactMarks)
          .where(eq(sanctionsContactMarks.contactId, otherId));
        await db
          .update(sanctionsContactMarks)
          .set({ scheduledAt: drainDue })
          .where(eq(sanctionsContactMarks.contactId, targetId));

        await drainSanctionsMonitoringTask(context(drainRunId));
        expect(
          await db
            .select()
            .from(sanctionsContactMarks)
            .where(eq(sanctionsContactMarks.contactId, targetId)),
        ).toEqual([]);
        expect(
          await db
            .select()
            .from(sanctionsContactScreenings)
            .where(eq(sanctionsContactScreenings.contactId, targetId)),
        ).toHaveLength(7);
        expect(
          await db
            .select()
            .from(sanctionsContactScreenings)
            .where(eq(sanctionsContactScreenings.contactId, otherId)),
        ).toEqual([]);
        const drainAudits = await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.organizationId, organizationId));
        expect(drainAudits).toHaveLength(1);
        expect(drainAudits.at(0)?.userId).toBe(
          TENANT_SYSTEM_ACTOR.sanctionsMonitoringDrain,
        );

        const source =
          (
            await db
              .select({ editionId: sanctionsSources.activeEditionId })
              .from(sanctionsSources)
              .where(eq(sanctionsSources.id, "us-sdn"))
          ).at(0) ?? panic("Sanctions task source missing");
        await db.insert(sanctionsMonitoringBackfills).values({
          organizationId,
          sourceId: "us-sdn",
          editionId: source.editionId,
          cursorContactId: null,
          generation: 1n,
          status: "pending",
          scheduledAt: backfillDue,
        });
        await backfillSanctionsMonitoringTask(
          context(backfillRunId, backfillDue),
        );
        const updatedBackfill = (
          await db
            .select()
            .from(sanctionsMonitoringBackfills)
            .where(
              eq(sanctionsMonitoringBackfills.organizationId, organizationId),
            )
        ).find(({ sourceId }) => sourceId === "us-sdn");
        if (updatedBackfill === undefined) {
          panic("Sanctions task backfill missing");
        }
        expect(updatedBackfill.status).toBe("complete");
        const backfillAudits = await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.organizationId, organizationId));
        expect(backfillAudits).toHaveLength(2);
        expect(
          backfillAudits.some(
            ({ userId }) =>
              userId === TENANT_SYSTEM_ACTOR.sanctionsMonitoringBackfill,
          ),
        ).toBe(true);
        expect(continued.length).toBeGreaterThan(0);
      } finally {
        for (const sourceId of new Set([
          ...sanctionsSourceIds(),
          ...priorFanouts.map((row) => row.sourceId),
        ])) {
          const prior = priorFanouts.find((row) => row.sourceId === sourceId);
          if (prior === undefined) {
            await db
              .delete(sanctionsEditionFanouts)
              .where(eq(sanctionsEditionFanouts.sourceId, sourceId));
            continue;
          }
          await db
            .insert(sanctionsEditionFanouts)
            .values(prior)
            .onConflictDoUpdate({
              target: sanctionsEditionFanouts.sourceId,
              set: {
                editionId: prior.editionId,
                cursorOrganizationId: prior.cursorOrganizationId,
                freshnessStatus: prior.freshnessStatus,
                status: prior.status,
              },
            });
        }
        if (targetId !== undefined && otherId !== undefined) {
          await db
            .delete(sanctionsContactMarks)
            .where(
              inArray(sanctionsContactMarks.contactId, [targetId, otherId]),
            );
          await db
            .delete(sanctionsContactScreenings)
            .where(
              eq(sanctionsContactScreenings.organizationId, organizationId),
            );
          await db
            .delete(sanctionsScreeningEvents)
            .where(eq(sanctionsScreeningEvents.organizationId, organizationId));
          await db
            .delete(auditLogs)
            .where(eq(auditLogs.organizationId, organizationId));
          await db
            .delete(sanctionsMonitoringBackfills)
            .where(
              eq(sanctionsMonitoringBackfills.organizationId, organizationId),
            );
          await db
            .delete(sanctionsOrganizationMarks)
            .where(
              eq(sanctionsOrganizationMarks.organizationId, organizationId),
            );
          await db
            .delete(contacts)
            .where(inArray(contacts.id, [targetId, otherId]));
        }
        await db
          .delete(organization)
          .where(inArray(organization.id, organizations));
        await db
          .delete(systemAuditRuns)
          .where(inArray(systemAuditRuns.subject, [drainRunId, backfillRunId]));
      }
    });
  }, 120_000);
}
