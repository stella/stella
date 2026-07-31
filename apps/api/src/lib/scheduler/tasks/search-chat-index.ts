import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { backfillChatThreadSearchIndex } from "@/api/lib/search/index-chat";

export const REPAIR_CHAT_SEARCH_INDEX_TASK = "search.repairChatIndex" as const;

export const repairChatSearchIndex: SchedulerTask = async ({
  logger,
  signal,
}) => {
  // audit: skip — scheduler repairs derived search projections;
  // scheduler_job_runs is the durable execution trail.
  const indexed = await backfillChatThreadSearchIndex({ signal });

  if (indexed === 0) {
    logger.debug("chat_search.repair_clean");
    return;
  }

  logger.info("chat_search.repair_complete", { indexed });
};
