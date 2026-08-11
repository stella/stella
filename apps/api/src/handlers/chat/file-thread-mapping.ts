import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { chatThreads, fileChatThreads } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type FileThreadLookupInput = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

export const lockFileChatThreadMapping = async (
  tx: Transaction,
  {
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  }: FileThreadLookupInput,
) =>
  (
    await tx
      .select({
        id: fileChatThreads.id,
        mappedChatThreadId: fileChatThreads.chatThreadId,
        thread: {
          id: chatThreads.id,
          chatModel: chatThreads.chatModel,
          chatReasoningEffort: chatThreads.chatReasoningEffort,
          contextMatterIds: chatThreads.contextMatterIds,
          usedAnonymization: chatThreads.usedAnonymization,
          webSearchEnabled: chatThreads.webSearchEnabled,
        },
      })
      .from(fileChatThreads)
      .leftJoin(chatThreads, eq(fileChatThreads.chatThreadId, chatThreads.id))
      .where(
        and(
          eq(fileChatThreads.entityId, entityId),
          eq(fileChatThreads.fieldId, fieldId),
          eq(fileChatThreads.organizationId, organizationId),
          eq(fileChatThreads.userId, userId),
          eq(fileChatThreads.workspaceId, workspaceId),
        ),
      )
      .limit(1)
      .for("update", { of: fileChatThreads })
  ).at(0);
