import { Result } from "better-result";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

import { hostedCustomerErasures } from "@/api/db/schema";
import { eraseHostedCustomer } from "@/api/lib/hosted-usage-provider/client";
import {
  getApiCredentials,
  getHostedUsageProviderKind,
} from "@/api/lib/hosted-usage-provider/config";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const ERASE_HOSTED_CUSTOMERS_TASK =
  "usage.eraseHostedCustomers" as const;
export const HOSTED_CUSTOMER_ERASURE_MAX_ATTEMPTS = 5;
const BATCH_SIZE = 25;
const CLAIM_LEASE_MS = 10 * 60 * 1000;
const ERASURE_FAILED = failureSink({
  event: "usage_provider.customer_erasure_failed",
  expected: [],
});

const errorCode = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = error.status;
    if (typeof status === "number") {
      return `http_${status}`;
    }
  }
  return "request_failed";
};

export const eraseHostedCustomers: SchedulerTask = async ({
  db,
  dueAt,
  signal,
}) => {
  const credentials = getApiCredentials();
  if (credentials === null || getHostedUsageProviderKind() !== "polar") {
    return;
  }
  const now = dueAt.claimedAtDate();
  const rows = await db
    .select()
    .from(hostedCustomerErasures)
    .where(
      and(
        or(
          eq(hostedCustomerErasures.status, "pending"),
          eq(hostedCustomerErasures.status, "failed"),
        ),
        // Due rows by the database clock, at the column's own precision.
        sql`${hostedCustomerErasures.nextAttemptAt} <= now()`,
        sql`${hostedCustomerErasures.attempts} < ${HOSTED_CUSTOMER_ERASURE_MAX_ATTEMPTS}`,
      ),
    )
    .orderBy(asc(hostedCustomerErasures.nextAttemptAt))
    .limit(BATCH_SIZE);
  if (rows.length === 0) {
    return;
  }
  // audit: skip - scheduler-owned delivery state is operational bookkeeping.
  await db
    .update(hostedCustomerErasures)
    .set({
      attempts: sql`${hostedCustomerErasures.attempts} + 1`,
      nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      updatedAt: now,
    })
    .where(
      inArray(
        hostedCustomerErasures.id,
        rows.map(({ id }) => id),
      ),
    );
  const claimed = rows.map((row) => ({ ...row, attempts: row.attempts + 1 }));
  if (signal.aborted) {
    return;
  }

  const outcomes = await Promise.all(
    claimed.map(async (row) => ({
      row,
      result: await eraseHostedCustomer({
        credentials,
        externalCustomerRef: row.externalCustomerRef,
      }),
    })),
  );
  const erasedIds = outcomes
    .filter(({ result }) => Result.isOk(result))
    .map(({ row }) => row.id);
  const failures = outcomes.filter(({ result }) => Result.isError(result));
  if (erasedIds.length > 0) {
    // audit: skip - scheduler-owned delivery state is operational bookkeeping.
    await db
      .update(hostedCustomerErasures)
      .set({ status: "erased", lastErrorCode: null, updatedAt: now })
      .where(inArray(hostedCustomerErasures.id, erasedIds));
  }
  await Promise.all(
    failures.map(async ({ row, result }) => {
      if (!Result.isError(result)) {
        return;
      }
      const code = errorCode(result.error);
      const terminal = row.attempts >= HOSTED_CUSTOMER_ERASURE_MAX_ATTEMPTS;
      const backoffMs = 60_000 * 2 ** (row.attempts - 1);
      // audit: skip - scheduler-owned delivery state is operational bookkeeping.
      await db
        .update(hostedCustomerErasures)
        .set({
          status: "failed",
          lastErrorCode: code,
          nextAttemptAt: new Date(now.getTime() + backoffMs),
          updatedAt: now,
        })
        .where(eq(hostedCustomerErasures.id, row.id));
      if (terminal) {
        observeFailure(new Error(code), {
          sink: ERASURE_FAILED,
          ctx: { jobId: row.id },
        });
      }
    }),
  );
};
