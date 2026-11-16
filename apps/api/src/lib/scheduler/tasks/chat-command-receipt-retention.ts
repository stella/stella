import { inArray, lt, sql } from "drizzle-orm";

import { CHAT_COMMAND_RECEIPT_RETENTION_MS } from "@stll/api-contract/chat-command";

import { chatCommandReceipts } from "@/api/db/schema";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";

export const SWEEP_CHAT_COMMAND_RECEIPTS_TASK =
  "chat.sweepCommandReceipts" as const;

const CHAT_COMMAND_RECEIPT_SWEEP_BATCH_SIZE = 500;

/**
 * Delete one batch of receipts past their retention: they answer only a
 * retry after a lost response, which a client makes within minutes.
 */
const deleteExpiredChatCommandReceipts = async (
  db: SchedulerDb,
  dueAt: Date,
) => {
  const cutoff = new Date(
    dueAt.getTime() - CHAT_COMMAND_RECEIPT_RETENTION_MS,
  ).toISOString();
  // audit: skip - Scheduled expiry of retry keys under the aggregated scheduler audit.
  const rows = await db
    .delete(chatCommandReceipts)
    .where(
      inArray(
        chatCommandReceipts.commandId,
        db
          .select({ commandId: chatCommandReceipts.commandId })
          .from(chatCommandReceipts)
          .where(
            lt(chatCommandReceipts.acceptedAt, sql`${cutoff}::timestamptz`),
          )
          .orderBy(chatCommandReceipts.acceptedAt)
          .limit(CHAT_COMMAND_RECEIPT_SWEEP_BATCH_SIZE),
      ),
    )
    .returning({ commandId: chatCommandReceipts.commandId });
  return rows.length;
};

export const sweepChatCommandReceipts: SchedulerTask = async ({
  db,
  dueAt,
  logger,
  signal,
}) => {
  signal.throwIfAborted();
  let deleted = 0;
  for (let batch = 0; batch < 16 && !signal.aborted; batch += 1) {
    const count = await deleteExpiredChatCommandReceipts(db, dueAt.toDate());
    deleted += count;
    if (count < CHAT_COMMAND_RECEIPT_SWEEP_BATCH_SIZE) {
      break;
    }
  }
  logger.info("scheduler.chat_command_receipts_swept", {
    "chatCommandReceipts.deleted": deleted,
  });
};
