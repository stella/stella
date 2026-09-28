import { panic } from "better-result";

import { refreshPgFtsBrowseFacets } from "@/api/lib/legal-search/pg-fts-browse-facet-refresh";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const REFRESH_CASE_LAW_BROWSE_FACETS_TASK =
  "caseLaw.refreshBrowseFacets" as const;

export const refreshCaseLawBrowseFacetsTask: SchedulerTask = async ({
  db,
  logger,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const { buckets } = await refreshPgFtsBrowseFacets(db);
  logger.info("scheduler.case_law_browse_facets_refreshed", {
    "caseLawBrowseFacets.buckets": buckets,
  });
};
