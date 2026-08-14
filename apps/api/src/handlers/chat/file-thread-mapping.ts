import { and, eq } from "drizzle-orm";

import type { ReasoningEffort } from "@stll/ai-catalog";

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

/** The thread columns consumed by file-thread resolution paths. */
export type FileThreadMetadata = {
  chatModel: string | null;
  chatReasoningEffort: ReasoningEffort | null;
  contextMatterIds: SafeId<"workspace">[];
  id: SafeId<"chatThread">;
  usedAnonymization: boolean;
  webSearchEnabled: boolean;
};

type FileThreadMapping = {
  id: SafeId<"fileChatThread">;
  mappedChatThreadId: SafeId<"chatThread">;
  thread: FileThreadMetadata | null;
};

const fileChatThreadMappingQuery = (
  tx: Transaction,
  {
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  }: FileThreadLookupInput,
) =>
  tx
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
    .limit(1);

/** Row-locking variant for the materializing POST: fences the unique mapping
 *  slot for the duration of its transaction. */
export const lockFileChatThreadMapping = async (
  tx: Transaction,
  input: FileThreadLookupInput,
): Promise<FileThreadMapping | undefined> =>
  (
    await fileChatThreadMappingQuery(tx, input).for("update", {
      of: fileChatThreads,
    })
  ).at(0);

/** Lock-free variant for the read-only GET: same shape, no row lock, so a
 *  document open never contends with a concurrent materialization. */
export const readFileChatThreadMapping = async (
  tx: Transaction,
  input: FileThreadLookupInput,
): Promise<FileThreadMapping | undefined> =>
  (await fileChatThreadMappingQuery(tx, input)).at(0);
