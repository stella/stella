import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { hasChatWorkspaceAccess } from "@/api/handlers/chat/chat-scope";
import type { ChatWorkspaceAccess } from "@/api/handlers/chat/chat-scope";
import { ACTIVE_CHAT_TURN_STATUSES } from "@/api/handlers/chat/chat-turn-state";
import type { SafeId } from "@/api/lib/branded-types";
import { readThreadStoredContentSendModeOnTx } from "@/api/lib/chat/thread-stored-content-send-mode";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type ReadEditableMessageOptions = {
  tx: Transaction;
  threadId: SafeId<"chatThread">;
  messageId: SafeId<"chatMessage">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  getWorkspaceAccess: ChatWorkspaceAccess;
};

export const readEditableMessageOnTx = async ({
  tx,
  threadId,
  messageId,
  organizationId,
  userId,
  getWorkspaceAccess,
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
  if (
    !row ||
    !(await hasChatWorkspaceAccess({
      workspaceId: row.thread.workspaceId,
      getWorkspaceAccess,
    }))
  ) {
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
  return {
    message: {
      id: row.message.id,
      threadId: row.message.threadId,
      workspaceId: row.message.workspaceId,
      userId: row.message.userId,
      role: row.message.role,
      content: row.message.content,
      revision: row.message.revision,
      memoryExtractionEligible: row.message.memoryExtractionEligible,
      createdAt: row.message.createdAt,
    },
    thread: {
      id: row.thread.id,
      workspaceId: row.thread.workspaceId,
      userId: row.thread.userId,
      organizationId: row.thread.organizationId,
      title: row.thread.title,
      titleSource: row.thread.titleSource,
      rollbackToken: row.thread.rollbackToken,
      contextMatterIds: row.thread.contextMatterIds,
      dataWorkspaceIds: row.thread.dataWorkspaceIds,
      webSearchEnabled: row.thread.webSearchEnabled,
      chatModel: row.thread.chatModel,
      chatReasoningEffort: row.thread.chatReasoningEffort,
      recapText: row.thread.recapText,
      recapMessageId: row.thread.recapMessageId,
      recapPromptVersion: row.thread.recapPromptVersion,
      recapGeneratedAt: row.thread.recapGeneratedAt,
      usedAnonymization: row.thread.usedAnonymization,
      parentThreadId: row.thread.parentThreadId,
      forkedFromMessageId: row.thread.forkedFromMessageId,
      subjectDecisionId: row.thread.subjectDecisionId,
      compactionScheduledAt: row.thread.compactionScheduledAt,
      compactionAttemptedAt: row.thread.compactionAttemptedAt,
      compactionAttempts: row.thread.compactionAttempts,
      compactionEpoch: row.thread.compactionEpoch,
      createdAt: row.thread.createdAt,
      updatedAt: row.thread.updatedAt,
    },
    active: active !== undefined,
    sendMode,
  };
};

type EditableMessage = NonNullable<
  Awaited<ReturnType<typeof readEditableMessageOnTx>>
>;

true satisfies UnprojectedColumns<
  typeof chatMessages.$inferSelect,
  EditableMessage["message"]
> extends never
  ? true
  : never;
true satisfies UnbackedProjectionKeys<
  typeof chatMessages.$inferSelect,
  EditableMessage["message"]
> extends never
  ? true
  : never;
true satisfies UnprojectedColumns<
  typeof chatThreads.$inferSelect,
  EditableMessage["thread"]
> extends never
  ? true
  : never;
true satisfies UnbackedProjectionKeys<
  typeof chatThreads.$inferSelect,
  EditableMessage["thread"]
> extends never
  ? true
  : never;
