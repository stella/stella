import { panic, Result } from "better-result";

import { Temporal } from "@stll/time";

import {
  countPreviousAgentClientValues,
  runAgentClientCredentialBatch,
} from "@/api/lib/agent-client-credential-storage";
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
  payload,
  signal,
  logger,
}) => {
  const paused = payload?.["paused"] ?? false;
  if (typeof paused !== "boolean") {
    panic("Agent client storage pause setting must be boolean");
  }
  const result = await Result.tryPromise({
    try: async () =>
      paused
        ? 0
        : await runAgentClientCredentialBatch({
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
  if (Result.isError(result) && !signal.aborted) {
    observeFailure(result.error, { sink: backfillFailed });
  }
  if (signal.aborted) {
    return;
  }
  logger.info("scheduler.agent_client_storage", {
    "migration.updated_count": Result.isError(result) ? 0 : result.value,
    "migration.remaining_count": await countPreviousAgentClientValues(db),
    "migration.paused": paused,
  });
};
