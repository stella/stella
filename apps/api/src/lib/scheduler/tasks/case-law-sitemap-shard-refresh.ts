import { panic } from "better-result";

import { refreshCaseLawSitemapShards } from "@/api/lib/case-law/sitemap-shard-refresh";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const REFRESH_CASE_LAW_SITEMAP_SHARDS_TASK =
  "caseLaw.refreshSitemapShards" as const;

/**
 * Recount the public case-law sitemap shards the index is served from. A run
 * that stops between countries continues at once; the snapshot is replaced
 * only by the run that counts the last country.
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
    case "counting":
      logger.info("scheduler.case_law_sitemap_shards_counting", {
        "caseLawSitemap.counted": outcome.counted,
        "caseLawSitemap.pages": outcome.pages,
        "caseLawSitemap.remaining": outcome.remaining,
      });
      scheduleContinuation(dueAt.claimedAtDate());
      return;
    case "swapped":
      await recordSystemAudit(db, "system:case-law-sitemap-refresh", {
        subject: runId,
        counts: { shards: outcome.shards, pages: outcome.pages },
      });
      logger.info("scheduler.case_law_sitemap_shards_refreshed", {
        "caseLawSitemap.largestShard": outcome.largestShard,
        "caseLawSitemap.pages": outcome.pages,
        "caseLawSitemap.shards": outcome.shards,
      });
      return;
    default:
      outcome satisfies never;
      panic("Unknown sitemap refresh outcome");
  }
};
