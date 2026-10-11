import { panic, Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import { sanitizeErrorAttributesForOutput } from "@stll/errors";
import { Temporal } from "@stll/time";

import {
  AGENT_CLIENT_LOCK_BUDGET_MS,
  AGENT_CLIENT_STATEMENT_BUDGET_MS,
  countPreviousAgentClientValues,
  runAgentClientCredentialBatch,
} from "@/api/agent-auth/credential-storage";
import { schedulerJobs } from "@/api/db/schema";
import {
  setSharedLockTimeout,
  setSharedStatementTimeout,
} from "@/api/db/shared-pool-timeouts";
import { env } from "@/api/env";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const BACKFILL_AGENT_CLIENT_STORAGE_TASK =
  "agentClients.backfillStorage" as const;
const RUN_BUDGET_MS = 10_000;
const backfillFailed = failureSink({
  event: "scheduler.agent_client_storage_failed",
  expected: [],
});

export const backfillAgentClientStorage: SchedulerTask = async ({
  db,
  job,
  payload,
  signal,
  logger,
}) => {
  if (!env.AGENT_CLIENT_STORAGE_V1_ENABLED) {
    return;
  }
  const paused = payload?.["paused"] ?? false;
  const completed = payload?.["completed"] ?? false;
  if (typeof paused !== "boolean") {
    panic("Agent client storage pause setting must be boolean");
  }
  if (typeof completed !== "boolean") {
    panic("Agent client storage completion setting must be boolean");
  }
  if (paused || completed) {
    return;
  }
  const result = await Result.tryPromise({
    try: async () =>
      await runAgentClientCredentialBatch({
        db,
        signal,
        deadline: Temporal.Now.instant().epochMilliseconds + RUN_BUDGET_MS,
      }),
    catch: () =>
      new HandlerError({
        status: 503,
        message: "Agent client storage update did not complete",
      }),
  });
  const batch = Result.isError(result)
    ? Result.err(result.error)
    : result.value;
  if (Result.isError(batch) && !signal.aborted) {
    observeFailure(batch.error, { sink: backfillFailed });
  }
  if (signal.aborted) {
    return;
  }
  const remainingCount = await countPreviousAgentClientValues(db);
  if (!Result.isError(batch) && remainingCount === 0) {
    await db.transaction(async (tx) => {
      await setSharedStatementTimeout(tx, AGENT_CLIENT_STATEMENT_BUDGET_MS);
      await setSharedLockTimeout(tx, AGENT_CLIENT_LOCK_BUDGET_MS);
      await tx
        .update(schedulerJobs)
        .set({
          enabled: false,
          payload: sql`coalesce(${schedulerJobs.payload}, '{}'::jsonb) || '{"completed":true}'::jsonb`,
        })
        .where(
          and(
            eq(schedulerJobs.id, job.id),
            eq(schedulerJobs.task, BACKFILL_AGENT_CLIENT_STORAGE_TASK),
            payload === null
              ? isNull(schedulerJobs.payload)
              : eq(schedulerJobs.payload, payload),
          ),
        );
    });
  }
  logger.info(
    "scheduler.agent_client_storage",
    sanitizeErrorAttributesForOutput({
      ...(!Result.isError(batch) && { "migration.updated_count": batch.value }),
      "migration.remaining_count": remainingCount,
      "migration.paused": paused,
    }),
  );
};
