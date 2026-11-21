import { and, inArray, isNotNull, lte, sql } from "drizzle-orm";

import { chatSecrets } from "@/api/db/schema";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";

export const PURGE_CHAT_SECRETS_TASK = "chat.purgeSecrets" as const;

const CHAT_SECRET_PURGE_BATCH_SIZE = 100;

// Receipts stay stable for replay after the encrypted payload has expired.
const purgeExpiredChatSecrets = async (db: SchedulerDb, dueAt: Date) => {
  // audit: skip - Scheduled expiry clears ephemeral payloads under the aggregated scheduler audit.
  // The batch subquery stays in Postgres; only the cleared ids return.
  const rows = await db
    .update(chatSecrets)
    .set({ ciphertext: null, iv: null, remainingUses: 0 })
    .where(
      inArray(
        chatSecrets.id,
        db
          .select({ id: chatSecrets.id })
          .from(chatSecrets)
          .where(
            and(
              lte(
                chatSecrets.expiresAt,
                sql`${dueAt.toISOString()}::timestamptz`,
              ),
              isNotNull(chatSecrets.ciphertext),
            ),
          )
          .orderBy(chatSecrets.expiresAt)
          .limit(CHAT_SECRET_PURGE_BATCH_SIZE),
      ),
    )
    .returning({ id: chatSecrets.id });
  return rows.length;
};

export const purgeChatSecrets: SchedulerTask = async ({
  db,
  dueAt,
  logger,
  signal,
}) => {
  signal.throwIfAborted();
  let purged = 0;
  for (let batch = 0; batch < 16 && !signal.aborted; batch += 1) {
    // One statement per batch; it needs no explicit transaction boundary.
    const count = await purgeExpiredChatSecrets(db, dueAt.toDate());
    purged += count;
    if (count < CHAT_SECRET_PURGE_BATCH_SIZE) {
      break;
    }
  }
  logger.info("scheduler.chat_secrets_purged", {
    privateInputReceiptCount: purged,
  });
};
