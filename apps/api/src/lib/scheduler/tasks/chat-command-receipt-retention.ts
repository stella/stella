import { inArray, lt, sql } from "drizzle-orm";

import { CHAT_COMMAND_RECEIPT_RETENTION_MS } from "@stll/api-contract/chat-command";

import { chatCommandReceipts } from "@/api/db/schema";
import { withSkipLockedBatch } from "@/api/lib/db/aggregate-lock";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";

export const SWEEP_CHAT_COMMAND_RECEIPTS_TASK =
  "chat.sweepCommandReceipts" as const;

const CHAT_COMMAND_RECEIPT_SWEEP_BATCH_SIZE = 500;
const CHAT_COMMAND_RECEIPT_SWEEP_BATCHES = 16;

/**
 * Delete one batch of receipts past their retention: they answer only a
 * retry after a lost response, which a client makes within minutes. The
 * batch is taken through the acceptance-time index and deleted by key, so a
 * run reads the expired receipts only, however many newer ones there are.
 */
const deleteExpiredChatCommandReceipts = async (
  db: SchedulerDb,
  cutoff: string,
) =>
  await withSkipLockedBatch({
    database: db,
    limit: CHAT_COMMAND_RECEIPT_SWEEP_BATCH_SIZE,
    select: (tx) =>
      tx
        .select({ commandId: chatCommandReceipts.commandId })
        .from(chatCommandReceipts)
        .where(lt(chatCommandReceipts.acceptedAt, sql`${cutoff}::timestamptz`))
        .$dynamic(),
    run: async (tx, expired) => {
      if (expired.length === 0) {
        return 0;
      }
      // audit: skip - Scheduled expiry of retry keys under the aggregated scheduler audit.
      const rows = await tx
        .delete(chatCommandReceipts)
        .where(
          inArray(
            chatCommandReceipts.commandId,
            expired.map(({ commandId }) => commandId),
          ),
        )
        .returning({ commandId: chatCommandReceipts.commandId });
      return rows.length;
    },
  });

export const sweepChatCommandReceipts: SchedulerTask = async ({
  db,
  dueAt,
  logger,
  signal,
}) => {
  signal.throwIfAborted();
  const cutoff = new Date(
    dueAt.toDate().getTime() - CHAT_COMMAND_RECEIPT_RETENTION_MS,
  ).toISOString();
  let deleted = 0;
  for (
    let batch = 0;
    batch < CHAT_COMMAND_RECEIPT_SWEEP_BATCHES && !signal.aborted;
    batch += 1
  ) {
    const count = await deleteExpiredChatCommandReceipts(db, cutoff);
    deleted += count;
    if (count < CHAT_COMMAND_RECEIPT_SWEEP_BATCH_SIZE) {
      break;
    }
  }
  logger.info("scheduler.chat_command_receipts_swept", {
    "chatCommandReceipts.deleted": deleted,
  });
};
