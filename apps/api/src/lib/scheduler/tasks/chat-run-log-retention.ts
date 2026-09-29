import {
  RETENTION_ENTRY_BATCH_SIZE,
  sweepClosedChatRunLogs,
} from "@/api/lib/chat/run-log";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const SWEEP_CHAT_RUN_LOGS_TASK = "chat.sweepRunLogs" as const;

export const sweepChatRunLogs: SchedulerTask = async ({
  db,
  logger,
  signal,
}) => {
  signal.throwIfAborted();
  let entriesDeleted = 0;
  let logsClosed = 0;
  let logsDeleted = 0;
  for (let batch = 0; batch < 16 && !signal.aborted; batch += 1) {
    // db-await-in-loop: retention drain of at most 16 bounded batches; each batch is its own short transaction so the sweep never holds locks across the whole backlog
    const swept = await sweepClosedChatRunLogs(db);
    entriesDeleted += swept.entriesDeleted;
    logsClosed += swept.logsClosed;
    logsDeleted += swept.logsDeleted;
    if (swept.entriesDeleted < RETENTION_ENTRY_BATCH_SIZE) {
      break;
    }
  }
  logger.info("scheduler.chat_run_logs_swept", {
    "chatRunLogs.closed": logsClosed,
    "chatRunLogs.deleted": logsDeleted,
    "chatRunLogEntries.deleted": entriesDeleted,
  });
};
