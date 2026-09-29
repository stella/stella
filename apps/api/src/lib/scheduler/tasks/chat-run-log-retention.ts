import { panic } from "better-result";

import { sweepClosedChatRunLogs } from "@/api/lib/chat/run-log";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const SWEEP_CHAT_RUN_LOGS_TASK = "chat.sweepRunLogs" as const;

export const sweepChatRunLogs: SchedulerTask = async ({
  db,
  logger,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const deleted = await sweepClosedChatRunLogs(db);
  logger.info("scheduler.chat_run_logs_swept", {
    "chatRunLogs.deleted": deleted,
  });
};
