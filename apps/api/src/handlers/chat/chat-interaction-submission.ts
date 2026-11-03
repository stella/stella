import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";

type ChatInteractionScope = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  threadId: SafeId<"chatThread">;
};

/** Acquire the thread fence before reading the interaction's turn. */
export const lockChatInteractionThread = async ({
  tx,
  organizationId,
  userId,
  threadId,
}: ChatInteractionScope): Promise<boolean> => {
  await withAggregateLock({
    aggregate: "chatThread",
    mode: "update",
    tx,
    id: {
      id: threadId,
      organizationId,
      userId,
    },
  });
  const thread = (
    await tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.organizationId, organizationId),
          eq(chatThreads.userId, userId),
        ),
      )
      .limit(1)
  ).at(0);
  return thread !== undefined;
};

type ChatInteractionRequestScope = ChatInteractionScope & {
  toolCallId: string;
};

/** The caller holds the thread fence; the turn fence follows in rank order. */
export const readLockedChatInteractionTurn = async ({
  tx,
  organizationId,
  userId,
  threadId,
  toolCallId,
}: ChatInteractionRequestScope) => {
  await withAggregateLock({
    aggregate: "chatTurn",
    mode: "update",
    tx,
    id: { organizationId, userId, threadId, toolCallId },
  });
  const turn = (
    await tx
      .select({ content: chatMessages.content, status: chatTurns.status })
      .from(chatTurns)
      .innerJoin(
        chatMessages,
        eq(chatMessages.id, chatTurns.assistantMessageId),
      )
      .where(
        and(
          eq(chatTurns.threadId, threadId),
          eq(chatTurns.organizationId, organizationId),
          eq(chatTurns.userId, userId),
          eq(chatTurns.interactionToolCallId, toolCallId),
        ),
      )
      .limit(1)
  ).at(0);
  return turn;
};
