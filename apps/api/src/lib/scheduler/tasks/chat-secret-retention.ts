import {
  CHAT_SECRET_PURGE_BATCH_SIZE,
  purgeExpiredChatSecrets,
} from "@/api/handlers/chat/chat-secrets";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const PURGE_CHAT_SECRETS_TASK = "chat.purgeSecrets" as const;

export const purgeChatSecrets: SchedulerTask = async ({
  db,
  logger,
  signal,
}) => {
  signal.throwIfAborted();
  let purged = 0;
  for (let batch = 0; batch < 16 && !signal.aborted; batch += 1) {
    const count = await db.transaction(
      async (tx) => await purgeExpiredChatSecrets(tx),
    );
    purged += count;
    if (count < CHAT_SECRET_PURGE_BATCH_SIZE) {
      break;
    }
  }
  logger.info("scheduler.chat_secrets_purged", {
    privateInputReceiptCount: purged,
  });
};
