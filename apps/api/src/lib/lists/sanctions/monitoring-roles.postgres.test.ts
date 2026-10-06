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
      const drainDue = new Date(Date.now() - 1000);
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

  test("a failed tenant backs off without blocking another tenant, then retries", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const failedOrganizationId = mintAuthProviderId<"organization">();
      const healthyOrganizationId = mintAuthProviderId<"organization">();
      const organizations = [failedOrganizationId, healthyOrganizationId];
      const base = new Date();
      const runId = toSafeId<"schedulerJobRun">(Bun.randomUUIDv7());
      const rollbackRunId = toSafeId<"schedulerJobRun">(Bun.randomUUIDv7());
      const generationRunId = toSafeId<"schedulerJobRun">(Bun.randomUUIDv7());
      const retryRunId = toSafeId<"schedulerJobRun">(Bun.randomUUIDv7());
      let failedContactId: typeof contacts.$inferSelect.id | undefined;
      let healthyContactId: typeof contacts.$inferSelect.id | undefined;
      const taskContext = (at: Date, taskRunId = runId) => ({
        db: asTestRaw<SchedulerDb>(db),
        signal: new AbortController().signal,
        logger,
        scheduleContinuation: () => {},
        job: asTestRaw<SchedulerTaskContext["job"]>({}),
        payload: null,
        dueAt: DueSlot.of({ nextRunAt: at, lockedAt: at }),
        runId: taskRunId,
      });
      try {
        await db.insert(organization).values(
          organizations.map((id) => ({
            id,
            name: "Sanctions retry fixture",
            slug: id,
            createdAt: base,
          })),
        );
        const seeded = await db
          .insert(contacts)
          .values([
            {
              organizationId: failedOrganizationId,
              type: "person",
              displayName: "Retry failure subject",
            },
            {
              organizationId: healthyOrganizationId,
              type: "person",
              displayName: "Retry healthy subject",
            },
          ])
          .returning();
        failedContactId = seeded.find(
          ({ organizationId }) => organizationId === failedOrganizationId,
        )?.id;
        healthyContactId = seeded.find(
          ({ organizationId }) => organizationId === healthyOrganizationId,
        )?.id;
        if (failedContactId === undefined || healthyContactId === undefined) {
          panic("Sanctions retry fixture contacts missing");
        }
        await db
          .update(sanctionsContactMarks)
          .set({ scheduledAt: new Date(base.getTime() - 1000) })
          .where(
            inArray(sanctionsContactMarks.contactId, [
              failedContactId,
              healthyContactId,
            ]),
          );
        await db.execute(
          sql`CREATE FUNCTION reject_retry_fixture_screening() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT display_name FROM public.contacts WHERE id = NEW.contact_id) LIKE 'Retry failure%subject' THEN RAISE EXCEPTION 'synthetic tenant screening failure'; END IF; RETURN NEW; END $$`,
        );
        await db.execute(
          sql`CREATE TRIGGER reject_retry_fixture_screening BEFORE INSERT ON public.sanctions_contact_screenings FOR EACH ROW EXECUTE FUNCTION public.reject_retry_fixture_screening()`,
        );

        const firstRun = await drainSanctionsMonitoringTask(taskContext(base));
        expect(firstRun.isOk()).toBe(true);
        expect(
          await db
            .select()
            .from(sanctionsContactMarks)
            .where(eq(sanctionsContactMarks.contactId, healthyContactId)),
        ).toEqual([]);
        const failedMark =
          (
            await db
              .select()
              .from(sanctionsContactMarks)
              .where(eq(sanctionsContactMarks.contactId, failedContactId))
          ).at(0) ?? panic("Failed tenant mark missing");
        expect(failedMark.attemptCount).toBe(1);
        expect(failedMark.nextAttemptAt.getTime()).toBeGreaterThan(
          base.getTime(),
        );
        expect(
          await db
            .select()
            .from(sanctionsContactScreenings)
            .where(eq(sanctionsContactScreenings.contactId, healthyContactId)),
        ).toHaveLength(7);
        const failedAudit = await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.organizationId, failedOrganizationId));
        expect(failedAudit).toHaveLength(1);
        expect(failedAudit.at(0)?.metadata).toMatchObject({
          kind: "sanctions-monitoring-drain-attempt-failed",
          attempted: 1,
        });

        await db.execute(
          sql`CREATE FUNCTION reject_retry_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'kind' = 'sanctions-monitoring-drain-attempt-failed' AND EXISTS (SELECT 1 FROM public.contacts WHERE organization_id = NEW.organization_id AND display_name = 'Retry failure subject') THEN RAISE EXCEPTION 'synthetic retry audit failure'; END IF; RETURN NEW; END $$`,
        );
        await db.execute(
          sql`CREATE TRIGGER reject_retry_fixture_audit BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.reject_retry_fixture_audit()`,
        );
        const rollbackRun = await drainSanctionsMonitoringTask(
          taskContext(
            new Date(failedMark.nextAttemptAt.getTime() + 1),
            rollbackRunId,
          ),
        );
        expect(rollbackRun.isErr()).toBe(true);
        const unadvancedMark =
          (
            await db
              .select()
              .from(sanctionsContactMarks)
              .where(eq(sanctionsContactMarks.contactId, failedContactId))
          ).at(0) ?? panic("Failed tenant mark missing after audit rollback");
        expect(unadvancedMark).toMatchObject({
          attemptCount: 1,
          nextAttemptAt: failedMark.nextAttemptAt,
        });
        expect(
          await db
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, failedOrganizationId)),
        ).toHaveLength(1);

        await db.execute(
          sql`DROP TRIGGER reject_retry_fixture_audit ON public.audit_logs`,
        );
        await db.execute(
          sql`DROP FUNCTION public.reject_retry_fixture_audit()`,
        );
        await db
          .update(contacts)
          .set({ displayName: "Retry failure changed subject" })
          .where(eq(contacts.id, failedContactId));
        const resetMark =
          (
            await db
              .select()
              .from(sanctionsContactMarks)
              .where(eq(sanctionsContactMarks.contactId, failedContactId))
          ).at(0) ??
          panic("Generation change did not preserve the queued mark");
        expect(resetMark.generation).toBe(failedMark.generation + 1n);
        expect(resetMark.attemptCount).toBe(0);
        expect(resetMark.nextAttemptAt).toEqual(
          new Date("1970-01-01T00:00:00.000Z"),
        );
        const generationRun = await drainSanctionsMonitoringTask(
          taskContext(new Date(base.getTime() + 10_000), generationRunId),
        );
        expect(generationRun.isOk()).toBe(true);
        const newBackoffMark =
          (
            await db
              .select()
              .from(sanctionsContactMarks)
              .where(eq(sanctionsContactMarks.contactId, failedContactId))
          ).at(0) ?? panic("Generation retry mark missing");
        expect(newBackoffMark.attemptCount).toBe(1);
        expect(newBackoffMark.generation).toBe(resetMark.generation);
        expect(newBackoffMark.nextAttemptAt.getTime()).toBeGreaterThan(
          base.getTime() + 10_000,
        );
        await db.execute(
          sql`DROP TRIGGER reject_retry_fixture_screening ON public.sanctions_contact_screenings`,
        );
        await db.execute(
          sql`DROP FUNCTION public.reject_retry_fixture_screening()`,
        );
        const retryAt = new Date(newBackoffMark.nextAttemptAt.getTime() + 1);
        const retryRun = await drainSanctionsMonitoringTask(
          taskContext(retryAt, retryRunId),
        );
        expect(retryRun.isOk()).toBe(true);
        expect(
          await db
            .select()
            .from(sanctionsContactMarks)
            .where(eq(sanctionsContactMarks.contactId, failedContactId)),
        ).toEqual([]);
        expect(
          await db
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, failedOrganizationId)),
        ).toHaveLength(3);
      } finally {
        await db.execute(
          sql`DROP TRIGGER IF EXISTS reject_retry_fixture_screening ON public.sanctions_contact_screenings`,
        );
        await db.execute(
          sql`DROP FUNCTION IF EXISTS public.reject_retry_fixture_screening()`,
        );
        await db.execute(
          sql`DROP TRIGGER IF EXISTS reject_retry_fixture_audit ON public.audit_logs`,
        );
        await db.execute(
          sql`DROP FUNCTION IF EXISTS public.reject_retry_fixture_audit()`,
        );
        if (failedContactId !== undefined && healthyContactId !== undefined) {
          await db
            .delete(sanctionsContactMarks)
            .where(
              inArray(sanctionsContactMarks.contactId, [
                failedContactId,
                healthyContactId,
              ]),
            );
          await db
            .delete(sanctionsContactScreenings)
            .where(
              inArray(sanctionsContactScreenings.organizationId, organizations),
            );
          await db
            .delete(auditLogs)
            .where(inArray(auditLogs.organizationId, organizations));
          await db
            .delete(contacts)
            .where(inArray(contacts.id, [failedContactId, healthyContactId]));
        }
        await db
          .delete(organization)
          .where(inArray(organization.id, organizations));
        await db
          .delete(systemAuditRuns)
          .where(
            inArray(systemAuditRuns.subject, [
              runId,
              rollbackRunId,
              generationRunId,
              retryRunId,
            ]),
          );
      }
    });
  }, 120_000);
}
