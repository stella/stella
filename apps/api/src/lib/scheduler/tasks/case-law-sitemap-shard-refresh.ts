import { panic } from "better-result";

import { refreshCaseLawSitemapShards } from "@/api/lib/case-law/sitemap-shard-refresh";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const REFRESH_CASE_LAW_SITEMAP_SHARDS_TASK =
  "caseLaw.refreshSitemapShards" as const;

/**
 * Recount the public case-law sitemap months the change log names. A run that
 * stops between months continues at once from the rows still logged.
 */
export const refreshCaseLawSitemapShardsTask: SchedulerTask = async ({
  db,
  dueAt,
  logger,
  runId,
  scheduleContinuation,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const outcome = await refreshCaseLawSitemapShards(db, { signal });
  switch (outcome.type) {
    case "pending":
      logger.info("scheduler.case_law_sitemap_shards_pending", {
        "caseLawSitemap.months": outcome.months,
      });
      scheduleContinuation(dueAt.claimedAtDate());
      return;
    case "refreshed":
      await recordSystemAudit(db, "system:case-law-sitemap-refresh", {
        subject: runId,
        counts: { months: outcome.months, shards: outcome.shards },
      });
      logger.info("scheduler.case_law_sitemap_shards_refreshed", {
        "caseLawSitemap.largestShard": outcome.largestShard,
        "caseLawSitemap.months": outcome.months,
        "caseLawSitemap.shards": outcome.shards,
      });
      return;
    default:
      outcome satisfies never;
      panic("Unknown sitemap refresh outcome");
  }
};
