import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { TransactionRollbackError } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { requestIdempotencyReceipts as receipts } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { scheduledMeasurementDatabase } from "@/api/tests/query-perf/scheduled-run";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import {
  REQUEST_RECEIPT_RETENTION_BATCH_SIZE,
  sweepExpiredRequestReceipts,
} from "./request-receipts";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
beforeAll(async () => {
  fixture = await getRlsFixture();
});
afterAll(releaseRlsFixture);

test("state-specific retention drains bounded mixed expiry batches and leaves the replay window intact", async () => {
  const { testDb, ids } = fixture;
  const scopedDb = createScopedDb(testDb, [], ids.orgA, ids.userA1);
  const now = new Date("2026-01-10T12:00:00Z");
  const rows = ["completed", "pending"].flatMap((state) =>
    Array.from(
      { length: REQUEST_RECEIPT_RETENTION_BATCH_SIZE + 1 },
      (_, index) => ({
        id: createSafeId<"requestIdempotencyReceipt">(),
        organizationId: ids.orgA,
        userId: ids.userA1,
        idempotencyKey: `${state}-${index}`,
        route: "/retention-test",
        requestFingerprint: "a".repeat(64),
        ...(state === "completed"
          ? {
              state: "completed" as const,
              responseCode: 200,
              completedAt: new Date("2026-01-01T00:00:00Z"),
              claimedAt: new Date("2026-01-01T00:00:00Z"),
            }
          : {
              state: "pending" as const,
              claimedAt: new Date("2026-01-10T11:00:00Z"),
            }),
      }),
    ),
  );
  const live = [
    {
      id: createSafeId<"requestIdempotencyReceipt">(),
      idempotencyKey: "live-completed",
      state: "completed" as const,
      responseCode: 200,
      completedAt: now,
      claimedAt: new Date("2026-01-10T11:00:00Z"),
      organizationId: ids.orgA,
      userId: ids.userA1,
      route: "/retention-test",
      requestFingerprint: "a".repeat(64),
    },
    {
      id: createSafeId<"requestIdempotencyReceipt">(),
      idempotencyKey: "live-pending",
      state: "pending" as const,
      claimedAt: now,
      organizationId: ids.orgA,
      userId: ids.userA1,
      route: "/retention-test",
      requestFingerprint: "a".repeat(64),
    },
  ];
  await scopedDb(
    async (tx) => await tx.insert(receipts).values([...rows, ...live]),
  );
  const sweep = async () =>
    await sweepExpiredRequestReceipts({
      db: asTestRaw<SchedulerDb>(testDb),
      now,
      signal: new AbortController().signal,
      deadline: 100,
      elapsedMs: () => 0,
    });
  const captured = await Result.tryPromise({
    try: async () =>
      await testDb.transaction(async (tx) => {
        const deleted = await sweepExpiredRequestReceipts({
          db: asTestRaw<SchedulerDb>(
            scheduledMeasurementDatabase(asTestRaw<Transaction>(tx)),
          ),
          now,
          signal: new AbortController().signal,
          deadline: 100,
          elapsedMs: () => 0,
        });
        expect(deleted).toEqual({
          deleted: REQUEST_RECEIPT_RETENTION_BATCH_SIZE,
          hasMore: true,
        });
        tx.rollback();
      }),
    catch: (error: unknown) => error,
  });
  expect(
    captured.isErr() && captured.error instanceof TransactionRollbackError,
  ).toBe(true);
  expect(await sweep()).toEqual({
    deleted: REQUEST_RECEIPT_RETENTION_BATCH_SIZE,
    hasMore: true,
  });
  expect(await sweep()).toEqual({
    deleted: REQUEST_RECEIPT_RETENTION_BATCH_SIZE,
    hasMore: true,
  });
  expect(await sweep()).toEqual({ deleted: 2, hasMore: false });
  expect(await sweep()).toEqual({ deleted: 0, hasMore: false });
  const retained = await scopedDb(
    async (tx) => await tx.select({ id: receipts.id }).from(receipts),
  );
  expect(retained.map(({ id }) => id).toSorted()).toEqual(
    live.map(({ id }) => id).toSorted(),
  );
});
