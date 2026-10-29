import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import {
  DATA_EXPORT_MAX_FAILURES,
  organizationDataExports,
  schedulerJobs,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { DATA_EXPORT_HEARTBEAT_STALE_MS } from "@/api/lib/data-export/queue";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import {
  createMaintainDataExportsTask,
  DATA_EXPORT_HANDOFF_PAGE_SIZE,
  DATA_EXPORT_MAX_HANDOFF_PAGES,
} from "@/api/lib/scheduler/tasks/data-export-maintenance";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createLeasedSchedulerJobFixture } from "@/api/tests/helpers/leased-scheduler-job";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "data export heartbeat arbitration",
  () => {
    test.each([0, DATA_EXPORT_MAX_FAILURES - 1])(
      "a refreshed heartbeat retains its running attempt with %s failures",
      async (failures) => {
        const databaseUrl =
          process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const observer = openClient();
          const worker = openClient();
          const sweep = openClient();
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          const exportId = createSafeId<"dataExport">();
          const jobId = `data-export-maintenance-${exportId}`;
          const now = new Date("2026-10-24T12:00:00Z");
          const locked = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          const launched: Promise<unknown>[] = [];
          try {
            await observer.db.insert(organization).values({
              id: organizationId,
              name: "Export fixture",
              slug: organizationId,
              createdAt: now,
            });
            await observer.db.insert(user).values({
              id: userId,
              name: "Export requester",
              email: `${userId}@example.test`,
            });
            const scopedDb = createScopedDb(
              markRlsDatabase(observer.db),
              [],
              organizationId,
              userId,
            );
            await scopedDb(
              async (tx) =>
                await tx.insert(organizationDataExports).values({
                  id: exportId,
                  organizationId,
                  requestedBy: userId,
                  versionScope: "all",
                  status: "running",
                  attempt: 1,
                  failures,
                  heartbeatAt: new Date(
                    now.getTime() - DATA_EXPORT_HEARTBEAT_STALE_MS - 1,
                  ),
                }),
            );
            const [workerSession] = await worker.db.execute<{ pid: number }>(
              sql`select pg_backend_pid() as pid`,
            );
            const [sweepSession] = await sweep.db.execute<{ pid: number }>(
              sql`select pg_backend_pid() as pid`,
            );
            if (workerSession === undefined || sweepSession === undefined) {
              panic("Database session PID required");
            }
            const refreshing = worker.db.transaction(async (tx) => {
              await tx
                .select({ id: organizationDataExports.id })
                .from(organizationDataExports)
                .where(eq(organizationDataExports.id, exportId))
                .for("update");
              locked.resolve(undefined);
              await release.promise;
              await tx
                .update(organizationDataExports)
                .set({ heartbeatAt: now })
                .where(eq(organizationDataExports.id, exportId));
            });
            launched.push(refreshing);
            await Promise.race([
              locked.promise,
              refreshing.then(() =>
                panic("Worker missed its row-lock barrier"),
              ),
            ]);
            const enqueued: string[] = [];
            const task = createMaintainDataExportsTask({
              handoffPageSize: DATA_EXPORT_HANDOFF_PAGE_SIZE,
              enqueue: async ({ exportId: queuedId }) => {
                enqueued.push(queuedId);
                return "requeued";
              },
            });
            await sweep.db.insert(schedulerJobs).values(
              createLeasedSchedulerJobFixture({
                id: jobId,
                task: "dataExports.maintain",
                nextRunAt: now,
                lockedBy: "heartbeat-test",
              }),
            );
            const [job] = await sweep.db
              .select()
              .from(schedulerJobs)
              .where(eq(schedulerJobs.id, jobId));
            if (job === undefined) {
              panic("Scheduler job fixture required");
            }
            const sweeping = Promise.resolve(
              task(
                asTestRaw<SchedulerTaskContext>({
                  runId: createSafeId<"schedulerJobRun">(),
                  db: sweep.db,
                  dueAt: DueSlot.of({ nextRunAt: now }),
                  job,
                  logger,
                  signal: new AbortController().signal,
                  scheduleContinuation: () => {},
                }),
              ),
            );
            launched.push(sweeping);
            await waitForBlockedPid(observer.sql, {
              waitingPid: sweepSession.pid,
              holdingPid: workerSession.pid,
            });
            release.resolve(undefined);
            await refreshing;
            expect(await sweeping).toEqual(Result.ok(undefined));
            expect(enqueued).not.toContain(exportId);
            const [row] = await observer.db
              .select({
                status: organizationDataExports.status,
                attempt: organizationDataExports.attempt,
                heartbeatAt: organizationDataExports.heartbeatAt,
                failures: organizationDataExports.failures,
              })
              .from(organizationDataExports)
              .where(eq(organizationDataExports.id, exportId));
            expect(row).toEqual({
              status: "running",
              attempt: 1,
              heartbeatAt: now,
              failures,
            });
          } finally {
            release.resolve(undefined);
            await Promise.allSettled(launched);
            await observer.db
              .delete(organization)
              .where(eq(organization.id, organizationId));
            await observer.db.delete(user).where(eq(user.id, userId));
            await observer.db
              .delete(schedulerJobs)
              .where(eq(schedulerJobs.id, jobId));
          }
        });
      },
    );

    test("a continuation hands off queued exports beyond the per-run page bound", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const client = openClient();
        const now = new Date("2026-10-24T13:00:00Z");
        const userId = mintAuthProviderId<"user">();
        const jobId = `data-export-maintenance-${Bun.randomUUIDv7()}`;
        const handoffCapacity =
          DATA_EXPORT_HANDOFF_PAGE_SIZE * DATA_EXPORT_MAX_HANDOFF_PAGES;
        const organizations = Array.from(
          { length: handoffCapacity + 1 },
          (_, index) => ({
            id: mintAuthProviderId<"organization">(),
            name: `Export fixture ${index}`,
            slug: `export-fixture-${Bun.randomUUIDv7()}`,
            createdAt: now,
          }),
        );
        const exportIds = organizations.map(() => createSafeId<"dataExport">());
        const lateExportId =
          exportIds.at(-1) ?? panic("Late export id fixture required");
        try {
          await client.db.insert(user).values({
            id: userId,
            name: "Export requester",
            email: `${userId}@example.test`,
          });
          await client.db.insert(organization).values(organizations);
          // Seed all tenants in one round trip under application RLS without changing shared policies.
          await client.db.transaction(async (tx) => {
            await tx.execute(sql`SELECT set_config('test.export_fixture_rows', ${JSON.stringify(
              organizations.map(({ id: organizationId }, index) => ({
                id: exportIds[index] ?? panic("Export id fixture required"),
                organizationId,
              })),
            )}, true), set_config('test.export_fixture_requester', ${userId}, true),
              set_config('test.export_fixture_created_at', ${new Date(now.getTime() - 10 * 60_000).toISOString()}, true)`);
            await tx.execute(sql`SET LOCAL ROLE stella`);
            await tx.execute(sql`DO $$
              DECLARE fixture_row record;
              BEGIN
                FOR fixture_row IN SELECT * FROM jsonb_to_recordset(current_setting('test.export_fixture_rows')::jsonb)
                  AS rows(id uuid, "organizationId" text)
                LOOP
                  PERFORM set_config('app.organization_id', fixture_row."organizationId", true);
                  INSERT INTO organization_data_exports (id, organization_id, requested_by, version_scope, status, created_at)
                  VALUES (fixture_row.id, fixture_row."organizationId", current_setting('test.export_fixture_requester'),
                    'all', 'queued', current_setting('test.export_fixture_created_at')::timestamptz);
                END LOOP;
              END $$`);
          });
          await client.db
            .update(organizationDataExports)
            .set({ createdAt: sql`'2026-10-24T12:00:00.123456Z'::timestamptz` })
            .where(inArray(organizationDataExports.id, exportIds));
          await client.db.insert(schedulerJobs).values(
            createLeasedSchedulerJobFixture({
              id: jobId,
              task: "dataExports.maintain",
              nextRunAt: now,
              lockedBy: "continuation-test",
            }),
          );

          const enqueued: string[] = [];
          const continuations: Date[] = [];
          const task = createMaintainDataExportsTask({
            handoffPageSize: DATA_EXPORT_HANDOFF_PAGE_SIZE,
            enqueue: async ({ exportId }) => {
              enqueued.push(exportId);
              return "requeued";
            },
          });
          const run = async () => {
            const [job] = await client.db
              .select()
              .from(schedulerJobs)
              .where(eq(schedulerJobs.id, jobId));
            if (job === undefined) {
              panic("Scheduler job fixture required");
            }
            return await task(
              asTestRaw<SchedulerTaskContext>({
                runId: createSafeId<"schedulerJobRun">(),
                db: client.db,
                dueAt: DueSlot.of({ nextRunAt: now }),
                job,
                logger,
                signal: new AbortController().signal,
                scheduleContinuation: (at: Date) => continuations.push(at),
              }),
            );
          };

          expect(await run()).toEqual(Result.ok(undefined));
          expect(enqueued).toHaveLength(handoffCapacity);
          expect(continuations).toHaveLength(1);
          expect(await run()).toEqual(Result.ok(undefined));
          expect(enqueued).toContain(lateExportId);
        } finally {
          await client.db.delete(organization).where(
            inArray(
              organization.id,
              organizations.map(({ id }) => id),
            ),
          );
          await client.db.delete(user).where(eq(user.id, userId));
          await client.db
            .delete(schedulerJobs)
            .where(eq(schedulerJobs.id, jobId));
        }
      });
    });
  },
);
