import { panic } from "better-result";

import { refreshStatuteSitemapShards } from "@/api/lib/legislation/sitemap-shard-refresh";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const REFRESH_STATUTE_SITEMAP_SHARDS_TASK =
  "legislation.refreshSitemapShards" as const;

export const refreshStatuteSitemapShardsTask: SchedulerTask = async ({
  db,
  logger,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const { largestShard, shards } = await refreshStatuteSitemapShards(db);
  logger.info("scheduler.statute_sitemap_shards_refreshed", {
    "statuteSitemap.largestShard": largestShard,
    "statuteSitemap.shards": shards,
  });
};
