import { panic, Result } from "better-result";

import { isUuid } from "@stll/uuid-codec";

import { reconcilePublisherRemovals } from "@/api/handlers/case-law/ingestion/removal-reconciliation";
import { getCaseLawIngestionDb } from "@/api/lib/case-law-ingestion-db";
import { brandPersistedCaseLawSourceId } from "@/api/lib/safe-id-boundaries";
import {
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";

export const RECONCILE_PUBLISHER_REMOVALS_TASK =
  "caseLaw.reconcilePublisherRemovals" as const;

/** A source-scoped task; registration creates no schedule or source configuration. */
export const reconcilePublisherRemovalsTask: SchedulerTask = async ({
  payload,
  signal,
  scheduleContinuation,
  logger,
  dueAt,
}) => {
  const sourceId = payload?.["sourceId"];
  if (typeof sourceId !== "string" || !isUuid(sourceId)) {
    panic("Publisher removal task requires a source UUID");
  }
  const result = await reconcilePublisherRemovals({
    scopedDb: getCaseLawIngestionDb(),
    sourceId: brandPersistedCaseLawSourceId(sourceId),
    signal,
    now: () => dueAt.claimedAtDate(),
  });
  if (result.isErr()) {
    return Result.err(
      new SchedulerTaskFailure({
        message: "Publisher removal sweep did not complete",
        cause: result.error,
      }),
    );
  }
  logger.info("scheduler.publisher_removals", {
    outcome: result.value.type,
    checked: result.value.checked,
  });
  if (result.value.type === "budget" || result.value.type === "contended") {
    scheduleContinuation(new Date(dueAt.claimedAtDate().getTime() + 1000));
  }
  if (result.value.type === "retry") {
    scheduleContinuation(new Date(dueAt.claimedAtDate().getTime() + 60_000));
  }
  return Result.ok();
};
