import { Result, TaggedError } from "better-result";

import { mapWithConcurrency } from "@stll/concurrency";

import { HOSTED_CUSTOMER_ERASURE_STATUS } from "@/api/db/schema";
import {
  claimHostedCustomerErasures,
  withAggregateTransaction,
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

export class HostedCustomerErasureTerminalError extends TaggedError(
  "HostedCustomerErasureTerminalError",
)<{ message: string }> {}

const claimDueErasures = async (
  db: SchedulerTaskContext["db"],
  runId: SchedulerTaskContext["runId"],
) =>
  await claimHostedCustomerErasures({
    database: db,
    limit: BATCH_SIZE,
    leaseMilliseconds: CLAIM_LEASE_MS,
    maximumAttempts: HOSTED_CUSTOMER_ERASURE_MAX_ATTEMPTS,
    recordTransitionAuditEvent: async (tx, rows) => {
      await recordSystemAudit(tx, "system:hosted-customer-erasure", {
        subject: runId,
        counts: {
          claimed: rows.length,
          erased: 0,
          failed: 0,
          terminalFailures: 0,
        },
      });
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

type FailureGroup = {
  attempts: number;
  code: string;
  ids: string[];
};

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
  const failureGroups = new Map<number, FailureGroup>();
  for (const { row, result } of outcomes) {
    if (Result.isOk(result)) {
      erasedIds.push(row.id);
      continue;
    }
    const code = errorCode(result.error);
    const group = failureGroups.get(row.attempts) ?? {
      attempts: row.attempts,
      code,
      ids: [],
    };
    if (group.code !== code) {
      group.code = "request_failed";
    }
    group.ids.push(row.id);
    failureGroups.set(row.attempts, group);
  }

  let erased = 0;
  let failed = 0;
  const groups = [...failureGroups.values()];
  let terminalFailures = 0;
  for (const group of groups) {
    if (group.attempts >= HOSTED_CUSTOMER_ERASURE_MAX_ATTEMPTS) {
      terminalFailures += group.ids.length;
    }
  }
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
          set: { lastErrorCode: null },
        },
        recordTransitionAuditEvent: (_tx, rows) => {
          erased += rows.length;
        },
      });
    }
    const transitionFailureGroup = async (
      group: FailureGroup | undefined,
    ): Promise<void> => {
      if (group !== undefined) {
        const { attempts, code, ids } = group;
        await transitionBatch({
          tx,
          spec: HOSTED_CUSTOMER_ERASURE_TRANSITIONS,
          ids,
          options: {
            from: [
              HOSTED_CUSTOMER_ERASURE_STATUS.pending,
              HOSTED_CUSTOMER_ERASURE_STATUS.failed,
            ],
            to: HOSTED_CUSTOMER_ERASURE_STATUS.failed,
            set: {
              lastErrorCode: code,
              nextAttemptAt: new Date(
                dependencies.now().getTime() + 60_000 * 2 ** (attempts - 1),
              ),
            },
          },
          recordTransitionAuditEvent: (_tx, rows) => {
            failed += rows.length;
          },
        });
      }
    };
    await Promise.all([
      transitionFailureGroup(failureGroups.get(1)),
      transitionFailureGroup(failureGroups.get(2)),
      transitionFailureGroup(failureGroups.get(3)),
      transitionFailureGroup(failureGroups.get(4)),
      transitionFailureGroup(failureGroups.get(5)),
    ]);
    await recordSystemAudit(tx, "system:hosted-customer-erasure", {
      subject: runId,
      counts: { claimed: 0, erased, failed, terminalFailures },
    });
  });

  const terminalGroups = groups.filter(
    ({ attempts }) => attempts >= HOSTED_CUSTOMER_ERASURE_MAX_ATTEMPTS,
  );
  for (const { code, ids } of terminalGroups) {
    for (const id of ids) {
      dependencies.observe(
        new HostedCustomerErasureTerminalError({ message: code }),
        { sink: ERASURE_FAILED, ctx: { jobId: id } },
      );
    }
  }
};

export const eraseHostedCustomers: SchedulerTask = runHostedCustomerErasures;
