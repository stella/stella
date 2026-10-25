import { Result, TaggedError } from "better-result";
import { inArray, sql } from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";

import {
  HOSTED_CUSTOMER_ERASURE_STATUS,
  hostedCustomerErasures,
} from "@/api/db/schema";
import {
  withAggregateTransaction,
  withSkipLockedBatch,
} from "@/api/lib/db/aggregate-lock";
import { HOSTED_CUSTOMER_ERASURE_TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionBatch } from "@/api/lib/db/transitions";
import { eraseHostedCustomer } from "@/api/lib/hosted-usage-provider/client";
import type { HostedUsageProviderApiCredentials } from "@/api/lib/hosted-usage-provider/config";
import {
  getApiCredentials,
  getHostedUsageProviderKind,
} from "@/api/lib/hosted-usage-provider/config";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type {
  SchedulerTask,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const ERASE_HOSTED_CUSTOMERS_TASK =
  "usage.eraseHostedCustomers" as const;
export const HOSTED_CUSTOMER_ERASURE_MAX_ATTEMPTS = 5;
const BATCH_SIZE = 25;
const PROVIDER_CONCURRENCY = 5;
const CLAIM_LEASE_MS = 10 * 60 * 1000;
const ERASURE_FAILED = failureSink({
  event: "usage_provider.customer_erasure_failed",
  expected: [],
});

class HostedCustomerErasureTerminalError extends TaggedError(
  "HostedCustomerErasureTerminalError",
)<{ message: string }> {}

/**
 * Leases due erasures: the lease and the claim audit commit with the row
 * locks. Attempts count only settled outcomes, so an interrupted run leaves
 * the row retryable once the lease lapses.
 */
const claimDueErasures = async (
  db: SchedulerTaskContext["db"],
  runId: SchedulerTaskContext["runId"],
) =>
  await withSkipLockedBatch({
    database: db,
    limit: BATCH_SIZE,
    select: (tx) =>
      tx
        .select({ id: hostedCustomerErasures.id })
        .from(hostedCustomerErasures)
        .where(
          sql`${hostedCustomerErasures.status} IN (${HOSTED_CUSTOMER_ERASURE_STATUS.pending}, ${HOSTED_CUSTOMER_ERASURE_STATUS.failed})
            AND ${hostedCustomerErasures.attempts} < ${HOSTED_CUSTOMER_ERASURE_MAX_ATTEMPTS}
            AND ${hostedCustomerErasures.nextAttemptAt} <= now()`,
        )
        .$dynamic(),
    run: async (tx, rows) => {
      if (rows.length === 0) {
        return [];
      }
      const claimed = await tx
        .update(hostedCustomerErasures)
        .set({
          nextAttemptAt: sql`now() + (${CLAIM_LEASE_MS} * interval '1 millisecond')`,
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            hostedCustomerErasures.id,
            rows.map(({ id }) => id),
          ),
        )
        .returning({
          id: hostedCustomerErasures.id,
          externalCustomerRef: hostedCustomerErasures.externalCustomerRef,
          attempts: hostedCustomerErasures.attempts,
        });
      await recordSystemAudit(tx, "system:hosted-customer-erasure", {
        subject: runId,
        counts: {
          claimed: claimed.length,
          erased: 0,
          failed: 0,
          terminalFailures: 0,
        },
      });
      return claimed;
    },
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

type ErasureDependencies = {
  credentials: HostedUsageProviderApiCredentials | null;
  provider: "neutral" | "polar";
  erase: typeof eraseHostedCustomer;
  observe: typeof observeFailure;
  now: () => Date;
};

const productionDependencies = (now: Date): ErasureDependencies => ({
  credentials: getApiCredentials(),
  provider: getHostedUsageProviderKind(),
  erase: eraseHostedCustomer,
  observe: observeFailure,
  now: () => now,
});

export const runHostedCustomerErasures = async (
  context: SchedulerTaskContext,
  dependencies: ErasureDependencies = productionDependencies(
    context.dueAt.claimedAtDate(),
  ),
): Promise<void> => {
  const { db, runId, signal } = context;
  const { credentials } = dependencies;
  if (credentials === null || dependencies.provider !== "polar") {
    return;
  }
  const claimed = await claimDueErasures(db, runId);
  if (claimed.length === 0 || signal.aborted) {
    return;
  }

  const outcomes = await mapWithConcurrency({
    items: claimed,
    limit: PROVIDER_CONCURRENCY,
    operation: async (row) => ({
      row,
      result: await dependencies.erase({
        credentials,
        externalCustomerRef: row.externalCustomerRef,
      }),
    }),
  });
  const erasedIds: string[] = [];
  const failures: { id: string; attempts: number; code: string }[] = [];
  for (const { row, result } of outcomes) {
    if (Result.isOk(result)) {
      erasedIds.push(row.id);
    } else {
      failures.push({
        id: row.id,
        attempts: row.attempts + 1,
        code: errorCode(result.error),
      });
    }
  }
  const terminal = failures.filter(
    ({ attempts }) => attempts >= HOSTED_CUSTOMER_ERASURE_MAX_ATTEMPTS,
  );

  let erased = 0;
  let failed = 0;
  await withAggregateTransaction(db, async (tx) => {
    if (erasedIds.length > 0) {
      await transitionBatch({
        tx,
        spec: HOSTED_CUSTOMER_ERASURE_TRANSITIONS,
        ids: erasedIds,
        options: {
          from: [
            HOSTED_CUSTOMER_ERASURE_STATUS.pending,
            HOSTED_CUSTOMER_ERASURE_STATUS.failed,
          ],
          to: HOSTED_CUSTOMER_ERASURE_STATUS.erased,
          set: {
            attempts: sql`${hostedCustomerErasures.attempts} + 1`,
            lastErrorCode: null,
          },
        },
        recordTransitionAuditEvent: (_tx, rows) => {
          erased += rows.length;
        },
      });
    }
    if (failures.length > 0) {
      // One statement for the batch: each row keeps its own error code and
      // backs off from its own attempt count.
      await transitionBatch({
        tx,
        spec: HOSTED_CUSTOMER_ERASURE_TRANSITIONS,
        ids: failures.map(({ id }) => id),
        options: {
          from: [
            HOSTED_CUSTOMER_ERASURE_STATUS.pending,
            HOSTED_CUSTOMER_ERASURE_STATUS.failed,
          ],
          to: HOSTED_CUSTOMER_ERASURE_STATUS.failed,
          set: {
            attempts: sql`${hostedCustomerErasures.attempts} + 1`,
            lastErrorCode: sqlCaseFragment({
              operand: sql`${hostedCustomerErasures.id}`,
              branches: failures.map(
                ({ id, code }) => sql`WHEN ${id}::uuid THEN ${code}`,
              ),
              fallback: sql`${hostedCustomerErasures.lastErrorCode}`,
            }),
            nextAttemptAt: sql`${dependencies.now().toISOString()}::timestamptz + interval '1 minute' * power(2, ${hostedCustomerErasures.attempts})`,
          },
        },
        recordTransitionAuditEvent: (_tx, rows) => {
          failed += rows.length;
        },
      });
    }
    await recordSystemAudit(tx, "system:hosted-customer-erasure", {
      subject: runId,
      counts: { claimed: 0, erased, failed, terminalFailures: terminal.length },
    });
  });

  for (const { id, code } of terminal) {
    dependencies.observe(
      new HostedCustomerErasureTerminalError({ message: code }),
      { sink: ERASURE_FAILED, ctx: { jobId: id } },
    );
  }
};

export const eraseHostedCustomers: SchedulerTask = runHostedCustomerErasures;
