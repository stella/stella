import { panic } from "better-result";

import { refreshCaseLawSitemapShards } from "@/api/lib/case-law/sitemap-shard-refresh";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const REFRESH_CASE_LAW_SITEMAP_SHARDS_TASK =
  "caseLaw.refreshSitemapShards" as const;

/** Recount the public case-law sitemap shards the index is served from. */
export const refreshCaseLawSitemapShardsTask: SchedulerTask = async ({
  db,
  logger,
  runId,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const { largestShard, pages, shards } = await refreshCaseLawSitemapShards(
    db,
    {
      signal,
    },
  );
  await recordSystemAudit(db, "system:case-law-sitemap-refresh", {
    subject: runId,
    counts: { shards, pages },
  });
  logger.info("scheduler.case_law_sitemap_shards_refreshed", {
    "caseLawSitemap.largestShard": largestShard,
    "caseLawSitemap.pages": pages,
    "caseLawSitemap.shards": shards,
  });
};
