import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { chatMessages, chatThreads } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type GeneratedDocumentActiveDraftContext = {
  type: "generated-document";
  originChatMessageId: SafeId<"chatMessage">;
  originChatThreadId: SafeId<"chatThread">;
  toolCallId: string;
  version: 1;
};

export type GeneratedDocumentDraftContext = Pick<
  GeneratedDocumentActiveDraftContext,
  "originChatMessageId" | "originChatThreadId" | "toolCallId"
>;

export const createGeneratedDocumentActiveDraftContext = ({
  originChatMessageId,
  originChatThreadId,
  toolCallId,
}: GeneratedDocumentDraftContext): GeneratedDocumentActiveDraftContext => ({
  type: "generated-document",
  originChatMessageId,
  originChatThreadId,
  toolCallId,
  version: 1,
});

export const canUseChatThreadForGeneratedDocumentDraft = ({
  hasPersistedContext,
  threadType,
}: {
  hasPersistedContext: boolean;
  threadType: "created" | "existing";
}): boolean => threadType === "created" || hasPersistedContext;

/**
 * Confirms that a server-stamped message already binds this exact owned chat
 * thread to the generated document draft. The limit keeps this authorization
 * check bounded even for long-running threads.
 */
export const hasPersistedGeneratedDocumentActiveDraftContext = async ({
  generatedDraft,
  organizationId,
  threadId,
  tx,
  userId,
}: {
  generatedDraft: GeneratedDocumentDraftContext;
  organizationId: SafeId<"organization">;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
  userId: SafeId<"user">;
}): Promise<boolean> => {
  const context = createGeneratedDocumentActiveDraftContext(generatedDraft);
  const persisted = await tx
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        eq(chatMessages.userId, userId),
        eq(chatThreads.organizationId, organizationId),
        eq(chatThreads.userId, userId),
        sql`${chatMessages.content} -> 'metadata' -> 'activeDraftContext' @> ${JSON.stringify(context)}::text::jsonb`,
      ),
    )
    .limit(1);
  return persisted.length > 0;
};
