import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import {
  DATA_EXPORT_MAX_FAILURES,
  organizationDataExports,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { DATA_EXPORT_HEARTBEAT_STALE_MS } from "@/api/lib/data-export/queue";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import {
  createMaintainDataExportsTask,
  DATA_EXPORT_HANDOFF_PAGE_SIZE,
} from "@/api/lib/scheduler/tasks/data-export-maintenance";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
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
            const sweeping = Promise.resolve(
              task(
                asTestRaw<SchedulerTaskContext>({
                  db: sweep.db,
                  dueAt: DueSlot.of({ nextRunAt: now }),
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
          }
        });
      },
    );
  },
);
