import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { ACTIVE_CHAT_TURN_STATUSES } from "@/api/handlers/chat/chat-turn-state";
import type { SafeId } from "@/api/lib/branded-types";
import { readThreadStoredContentSendModeOnTx } from "@/api/lib/chat/thread-stored-content-send-mode";

type ReadEditableMessageOptions = {
  tx: Transaction;
  threadId: SafeId<"chatThread">;
  messageId: SafeId<"chatMessage">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

export const readEditableMessageOnTx = async ({
  tx,
  threadId,
  messageId,
  organizationId,
  userId,
}: ReadEditableMessageOptions) => {
  const row = (
    await tx
      .select({ message: chatMessages, thread: chatThreads })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatThreads.id, threadId),
          eq(chatThreads.organizationId, organizationId),
          eq(chatThreads.userId, userId),
        ),
      )
      .limit(1)
  ).at(0);
  if (!row) {
    return null;
  }
  const active = (
    await tx
      .select({ id: chatTurns.id })
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.threadId, threadId),
          inArray(chatTurns.status, ACTIVE_CHAT_TURN_STATUSES),
        ),
      )
      .limit(1)
  ).at(0);
  // The send mode is read after the answer, so a newly anonymized turn is
  // never disclosed through this stored-content model request.
  const sendMode = await readThreadStoredContentSendModeOnTx({ tx, threadId });
  return { ...row, active: active !== undefined, sendMode };
};
