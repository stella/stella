import { panic } from "better-result";

import { refreshStatuteSitemapShards } from "@/api/lib/legal-search/statute-sitemap-shard-refresh";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const REFRESH_STATUTE_SITEMAP_SHARDS_TASK =
  "legislation.refreshSitemapShards" as const;

export const refreshStatuteSitemapShardsTask: SchedulerTask = async ({
  db,
  logger,
  runId,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const { largestShard, shards } = await refreshStatuteSitemapShards(db);
  await recordSystemAudit(db, "system:statute-sitemap-refresh", {
    subject: runId,
    counts: { shards },
  });
  logger.info("scheduler.statute_sitemap_shards_refreshed", {
    "statuteSitemap.largestShard": largestShard,
    "statuteSitemap.shards": shards,
  });
};
