import { panic } from "better-result";

import { withLongRunningConnection } from "@/api/db/long-running-connection";
import { refreshCaseLawSourceArrivals } from "@/api/lib/case-law/source-arrivals-refresh";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const REFRESH_CASE_LAW_SOURCE_ARRIVALS_TASK =
  "caseLaw.refreshSourceArrivals" as const;

/**
 * The recount runs in one transaction over the decision table's newest rows,
 * so its snapshot holds back vacuum there for as long as it runs. Two minutes
 * bounds that; a recount that cannot finish in it fails, and the stored rows
 * age into "unknown" rather than holding vacuum back during a bulk ingest.
 */
const REFRESH_STATEMENT_TIMEOUT_MS = 2 * 60_000;
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
  const started = performance.now();
  const { sources } = await withLongRunningConnection(
    {
      lockTimeout: REFRESH_LOCK_TIMEOUT_MS,
      statementTimeout: REFRESH_STATEMENT_TIMEOUT_MS,
      signal,
    },
    async ({ db }) => await refreshCaseLawSourceArrivals(db, { now, signal }),
  );
  const durationMs = Math.round(performance.now() - started);
  await recordSystemAudit(
    schedulerDb,
    "system:case-law-source-arrivals-refresh",
    { subject: runId, counts: { sources } },
  );
  logger.info("scheduler.case_law_source_arrivals_refreshed", {
    "caseLawSourceArrivals.sources": sources,
    "caseLawSourceArrivals.durationMs": durationMs,
  });
};
