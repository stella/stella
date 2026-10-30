import { productionDataInvariants } from "@/api/lib/observability/data-invariants/catalog";
import {
  type DataInvariantOutcome,
  runDataInvariants,
} from "@/api/lib/observability/data-invariants/invariant";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const CHECK_DATA_INVARIANTS_TASK =
  "observability.checkDataInvariants" as const;

/**
 * Evaluate every data invariant and publish each verdict. Read-only: a
 * violated invariant is reported, never repaired here, so a run never fails
 * because the data it judges is wrong.
 */
export const checkDataInvariants: SchedulerTask = async ({
  db,
  dueAt,
  logger,
  signal,
}) => {
  const reports = await runDataInvariants(productionDataInvariants(db), {
    now: dueAt.claimedAtDate(),
    signal,
  });
  const count = (status: DataInvariantOutcome["status"]) =>
    reports.filter(({ outcome }) => outcome.status === status).length;
  logger.info("scheduler.data_invariants_checked", {
    "dataInvariants.held": count("held"),
    "dataInvariants.violated": count("violated"),
    "dataInvariants.skipped": count("skipped"),
    "dataInvariants.errored": count("errored"),
  });
};
