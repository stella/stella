import { panic } from "better-result";

import { withLongRunningConnection } from "@/api/db/long-running-connection";
import { refreshCaseLawSourceArrivals } from "@/api/lib/case-law/source-arrivals-refresh";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const REFRESH_CASE_LAW_SOURCE_ARRIVALS_TASK =
  "caseLaw.refreshSourceArrivals" as const;

const REFRESH_STATEMENT_TIMEOUT_MS = 10 * 60_000;
const REFRESH_LOCK_TIMEOUT_MS = 10_000;

export const refreshCaseLawSourceArrivalsTask: SchedulerTask = async ({
  db: schedulerDb,
  dueAt,
  logger,
  runId,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  // The claim instant, not the slot: the stored week ends when it was counted.
  const now = dueAt.claimedAtDate();
  const { sources } = await withLongRunningConnection(
    {
      lockTimeout: REFRESH_LOCK_TIMEOUT_MS,
      statementTimeout: REFRESH_STATEMENT_TIMEOUT_MS,
      signal,
    },
    async ({ db }) => await refreshCaseLawSourceArrivals(db, { now, signal }),
  );
  await recordSystemAudit(
    schedulerDb,
    "system:case-law-source-arrivals-refresh",
    { subject: runId, counts: { sources } },
  );
  logger.info("scheduler.case_law_source_arrivals_refreshed", {
    "caseLawSourceArrivals.sources": sources,
  });
};
