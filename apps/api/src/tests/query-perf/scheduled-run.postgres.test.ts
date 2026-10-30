import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { requestIdempotencyReceipts as receipts } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { SWEEP_REQUEST_RECEIPTS_TASK } from "@/api/lib/scheduler/tasks/request-receipt-retention";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";

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
