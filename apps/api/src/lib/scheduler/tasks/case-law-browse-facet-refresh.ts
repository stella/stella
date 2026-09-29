import { panic } from "better-result";

import { withLongRunningConnection } from "@/api/db/long-running-connection";
import { refreshPgFtsBrowseFacets } from "@/api/lib/legal-search/pg-fts-browse-facet-refresh";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const REFRESH_CASE_LAW_BROWSE_FACETS_TASK =
  "caseLaw.refreshBrowseFacets" as const;

const REFRESH_STATEMENT_TIMEOUT_MS = 15 * 60_000;
const REFRESH_LOCK_TIMEOUT_MS = 10_000;

export const refreshCaseLawBrowseFacetsTask: SchedulerTask = async ({
  logger,
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
    async ({ db }) => await refreshPgFtsBrowseFacets(db, signal),
  );
  logger.info("scheduler.case_law_browse_facets_refreshed", {
    "caseLawBrowseFacets.buckets": buckets,
  });
};
