import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  auditLogs,
  organizationDataExports,
  requestIdempotencyReceipts as receipts,
  systemAuditRuns,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { QUEUE_REQUEUE_OUTCOME } from "@/api/lib/bullmq-requeue";
import {
  DATA_EXPORT_HANDOFF_PAGE_SIZE,
  DATA_EXPORT_MAX_HANDOFF_PAGES,
  MAINTAIN_DATA_EXPORTS_TASK,
} from "@/api/lib/scheduler/tasks/data-export-maintenance";
import { SWEEP_REQUEST_RECEIPTS_TASK } from "@/api/lib/scheduler/tasks/request-receipt-retention";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";

import { seedDataExportScenario } from "./data-export-seed";
import { withQueryPerfFixture } from "./fixture";
import { measureScheduledJobRun } from "./scheduled-run";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("scheduled receipt measurement (postgres)", () => {
  test("measures the task's committed retention once and retains a live receipt", async () => {
    await withGatedTestClients(
      process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
      async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await flowReviewGateFixture(db, {
          intermediate: false,
        });
        const expiredId = createSafeId<"requestIdempotencyReceipt">();
        const liveId = createSafeId<"requestIdempotencyReceipt">();
        const now = new Date("2026-01-10T12:00:00Z");
        try {
          const scopedDb = createScopedDb(
            markRlsDatabase(db),
            [],
            fixture.organizationId,
            fixture.userId,
          );
          await scopedDb(
            async (tx) =>
              await tx.insert(receipts).values([
                {
                  id: expiredId,
                  organizationId: fixture.organizationId,
                  userId: fixture.userId,
                  idempotencyKey: expiredId,
                  route: "/measurement",
                  requestFingerprint: "a".repeat(64),
                  state: "completed",
                  responseCode: 200,
                  claimedAt: new Date("2026-01-01T12:00:00Z"),
                  completedAt: new Date("2026-01-01T12:00:00Z"),
                },
                {
                  id: liveId,
                  organizationId: fixture.organizationId,
                  userId: fixture.userId,
                  idempotencyKey: liveId,
                  route: "/measurement",
                  requestFingerprint: "b".repeat(64),
                  state: "pending",
                  claimedAt: now,
                },
              ]),
          );
          const measured = await measureScheduledJobRun({
            database: db,
            jobId: "requests.sweepReceipts.hourly",
            task: SWEEP_REQUEST_RECEIPTS_TASK,
            now,
          });
          expect(
            measured.statements.some(({ statement }) =>
              /^delete\s/iu.test(statement),
            ),
          ).toBe(true);
          expect(await db.$count(receipts, eq(receipts.id, expiredId))).toBe(0);
          expect(await db.$count(receipts, eq(receipts.id, liveId))).toBe(1);
          expect(measured.metrics.sharedBlocks).toBeGreaterThan(0);
        } finally {
          await fixture.cleanup();
        }
      },
    );
  });
});

describe.skipIf(!enabled)("scheduled export measurement (postgres)", () => {
  test("export measurement executes every cohort once without replaying writes", async () => {
    await withQueryPerfFixture({
      databaseUrl:
        process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
      profileId: "corpus",
      run: async (db) => {
        const exportRows = async () =>
          await db
            .select({
              id: organizationDataExports.id,
              status: organizationDataExports.status,
              attempt: organizationDataExports.attempt,
              failures: organizationDataExports.failures,
            })
            .from(organizationDataExports)
            .orderBy(asc(organizationDataExports.id))
            .limit(600);
        for (const cohort of ["quiet", "transitions", "queued"] as const) {
          const scenario = { type: "data-exports", rows: 600, cohort } as const;
          await seedDataExportScenario(db, scenario);
          const original = await exportRows();
          let enqueued = 0;
          const measured = await measureScheduledJobRun({
            database: db,
            jobId: "dataExports.maintain.fiveMinute",
            task: MAINTAIN_DATA_EXPORTS_TASK,
            now: new Date("2026-01-10T12:00:00Z"),
            dataExportMaintenance: {
              handoffPageSize: DATA_EXPORT_HANDOFF_PAGE_SIZE,
              enqueue: async () => {
                enqueued += 1;
                return QUEUE_REQUEUE_OUTCOME.REQUEUED;
              },
            },
          });
          expect(
            measured.planViolations.filter(
              ({ kind }) =>
                kind === "large-scan" || kind === "deadline-missing",
            ),
          ).toEqual([]);
          expect(await db.$count(systemAuditRuns)).toBe(1);
          const changed = await exportRows();
          const audits = await db.$count(auditLogs);
          if (cohort === "transitions") {
            expect(changed).not.toEqual(original);
            expect(audits).toBeGreaterThan(0);
            for (const row of changed) {
              const before = original.find(({ id }) => id === row.id);
              expect(before).toBeDefined();
              if (before !== undefined) {
                expect(row.attempt - before.attempt).toBeLessThanOrEqual(1);
                expect(row.failures - before.failures).toBeLessThanOrEqual(1);
              }
            }
          } else {
            expect(changed).toEqual(original);
            expect(audits).toBe(0);
          }
          expect(measured.statements.length).toBeGreaterThan(0);
          expect(
            measured.statements.some(({ statement }) =>
              /^\s*explain\b/iu.test(statement),
            ),
          ).toBe(false);
          if (cohort === "queued") {
            expect(enqueued).toBe(
              DATA_EXPORT_HANDOFF_PAGE_SIZE * DATA_EXPORT_MAX_HANDOFF_PAGES,
            );
          }
          if (cohort === "quiet") {
            expect(enqueued).toBe(0);
          }
          if (cohort === "transitions") {
            expect(enqueued).toBeGreaterThan(0);
          }
        }
        expect(
          await rejectionOf(
            measureScheduledJobRun({
              database: db,
              jobId: "dataExports.maintain.fiveMinute",
              task: "requests.sweepReceipts",
            }),
          ),
        ).toMatchObject({
          message: expect.stringContaining("dataExports.maintain"),
        });
      },
    });
  });
});
