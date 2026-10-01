import { panic } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import {
  readThreadStoredContentSendModeOnTx,
  THREAD_STORED_CONTENT_SEND_MODE,
} from "@/api/lib/chat/thread-stored-content-send-mode";

const RECAP_RECENT_MESSAGE_LIMIT = 24;

type RecapWindowMessage = {
  id: string;
};

type BuildRecapMessageWindowOptions<TMessage extends RecapWindowMessage> = {
  firstUserMessage: TMessage | null;
  recentMessagesDesc: readonly TMessage[];
};

export const buildRecapMessageWindow = <TMessage extends RecapWindowMessage>({
  firstUserMessage,
  recentMessagesDesc,
}: BuildRecapMessageWindowOptions<TMessage>): TMessage[] => {
  const recentMessages = recentMessagesDesc.toReversed();
  if (
    !firstUserMessage ||
    recentMessages.some((message) => message.id === firstUserMessage.id)
  ) {
    return recentMessages;
  }

  return [firstUserMessage, ...recentMessages];
};

type LoadRecapMessageWindowProps = {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
};

/**
 * Load the message window the recap, suggested-prompt and title generators
 * run on: the thread's first user message plus its most recent messages,
 * merged into chronological order. `recentCount` is the pre-merge
 * recent-message count the recap uses for its staleness gate; the others
 * ignore it.
 *
 * The thread's send mode is read after the messages, so a window holding a
 * turn stored in anonymized mode always comes back as `anonymized`, and its
 * messages are not returned: these generators send without an anonymization
 * step.
 */
export const loadRecapMessageWindow = async ({
  safeDb,
  threadId,
  userId,
}: LoadRecapMessageWindowProps) =>
  await safeDb(async (tx) => {
    const [firstUserMessages, recentMessagesDesc] = await Promise.all([
      tx.query.chatMessages.findMany({
        where: {
          threadId: { eq: threadId },
          userId: { eq: userId },
          role: { eq: "user" },
        },
        columns: {
          id: true,
          role: true,
          content: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
        limit: 1,
      }),
      tx.query.chatMessages.findMany({
        where: {
          threadId: { eq: threadId },
          userId: { eq: userId },
        },
        columns: {
          id: true,
          role: true,
          content: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        limit: RECAP_RECENT_MESSAGE_LIMIT,
      }),
    ]);

    const sendMode = await readThreadStoredContentSendModeOnTx({
      threadId,
      tx,
    });
    switch (sendMode) {
      case THREAD_STORED_CONTENT_SEND_MODE.anonymized:
        return { sendMode };
      case THREAD_STORED_CONTENT_SEND_MODE.raw:
        return {
          sendMode,
          recentCount: recentMessagesDesc.length,
          messages: buildRecapMessageWindow({
            firstUserMessage: firstUserMessages.at(0) ?? null,
            recentMessagesDesc,
          }),
        };
      default:
        sendMode satisfies never;
        return panic(`Unhandled thread send mode: ${String(sendMode)}`);
    }
  });
