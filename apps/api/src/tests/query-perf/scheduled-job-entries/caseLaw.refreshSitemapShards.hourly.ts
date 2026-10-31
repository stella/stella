import { REFRESH_CASE_LAW_SITEMAP_SHARDS_TASK } from "@/api/lib/scheduler/tasks/case-law-sitemap-shard-refresh";

import {
  CASE_LAW_SCENARIOS,
  seedSitemapReadBudget,
  sitemapRefreshRetiredChanges,
} from "../corpus-seed";
import type { ScheduledJobMeasurement } from "../measurement-definition";

export default {
  type: "case-law",
  task: REFRESH_CASE_LAW_SITEMAP_SHARDS_TASK,
  prepare: seedSitemapReadBudget,
  executed: sitemapRefreshRetiredChanges,
  scenarios: [
    { size: { type: "case-law", served: CASE_LAW_SCENARIOS.quiet.size } },
  ],
} as const satisfies ScheduledJobMeasurement;
