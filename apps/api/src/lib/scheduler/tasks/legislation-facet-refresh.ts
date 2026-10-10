import { panic } from "better-result";

import { withLongRunningConnection } from "@/api/db/long-running-connection";
import { refreshLegislationFacetCounts } from "@/api/lib/legal-search/legislation-facet-refresh";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const REFRESH_LEGISLATION_FACETS_TASK =
  "legislation.refreshFacetCounts" as const;

const REFRESH_STATEMENT_TIMEOUT_MS = 5 * 60_000;
const REFRESH_LOCK_TIMEOUT_MS = 10_000;

export const refreshLegislationFacetsTask: SchedulerTask = async ({
  db: schedulerDb,
  logger,
  runId,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const { buckets } = await withLongRunningConnection(
    {
      lockTimeout: REFRESH_LOCK_TIMEOUT_MS,
      statementTimeout: REFRESH_STATEMENT_TIMEOUT_MS,
      signal,
    },
    async ({ db }) => await refreshLegislationFacetCounts(db, { signal }),
  );
  await recordSystemAudit(schedulerDb, "system:legislation-facet-refresh", {
    subject: runId,
    counts: { buckets },
  });
  logger.info("scheduler.legislation_facets_refreshed", {
    "legislationFacets.buckets": buckets,
  });
};
