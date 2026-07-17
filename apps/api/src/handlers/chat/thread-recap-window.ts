import type { SafeDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";

export const RECAP_RECENT_MESSAGE_LIMIT = 24;

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
 * Load the message window both the recap and suggested-prompt generators run
 * on: the thread's first user message plus its most recent messages, merged
 * into chronological order. `recentCount` is the pre-merge recent-message
 * count the recap uses for its staleness gate; suggested prompts ignore it.
 */
export const loadRecapMessageWindow = ({
  safeDb,
  threadId,
  userId,
}: LoadRecapMessageWindowProps) =>
  safeDb(async (tx) => {
    const firstUserMessages = await tx.query.chatMessages.findMany({
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
    });

    const recentMessagesDesc = await tx.query.chatMessages.findMany({
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
    });

    return {
      recentCount: recentMessagesDesc.length,
      messages: buildRecapMessageWindow({
        firstUserMessage: firstUserMessages.at(0) ?? null,
        recentMessagesDesc,
      }),
    };
  });
