import { Result } from "better-result";
import { and, eq, notExists } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import type { ChatThreadState } from "@/api/handlers/chat/send-message-thread";
import type { PersistableChatMessage } from "@/api/handlers/chat/types";
import {
  deleteUploadedChatFiles,
  uploadMessageFiles,
} from "@/api/handlers/chat/upload-files";
import type { UploadedChatFile } from "@/api/handlers/chat/upload-files";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";

type UploadMessageFilesWithRollbackProps = {
  message: PersistableChatMessage;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  threadState: ChatThreadState;
  userId: SafeId<"user">;
};

type UploadMessageFilesWithRollbackResult = Result<
  {
    message: PersistableChatMessage;
    uploadedFiles: UploadedChatFile[];
  },
  HandlerError<400 | 422 | 500> | SafeDbError
>;

export const uploadMessageFilesWithRollback = async ({
  message,
  recordAuditEvent,
  safeDb,
  threadId,
  threadState,
  userId,
}: UploadMessageFilesWithRollbackProps): Promise<UploadMessageFilesWithRollbackResult> => {
  const uploadResult = await uploadMessageFiles({
    message,
    recordAuditEvent,
    safeDb,
    threadId,
    userId,
    workspaceId: threadState.data.workspaceId,
  });

  if (Result.isOk(uploadResult)) {
    return uploadResult;
  }

  if (threadState.type !== "created") {
    return uploadResult;
  }

  const rollbackResult = await rollbackUnpersistedChatSideEffects({
    recordAuditEvent,
    safeDb,
    threadId,
    threadState,
    uploadedFiles: [],
    userId,
  });

  if (Result.isOk(rollbackResult)) {
    return Result.err(uploadResult.error);
  }

  captureError(uploadResult.error, { threadId });
  return Result.err(rollbackResult.error);
};

export const rollbackUnpersistedChatSideEffects = async ({
  recordAuditEvent,
  safeDb,
  threadId,
  threadState,
  uploadedFiles,
  userId,
}: {
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  threadState: ChatThreadState;
  uploadedFiles: UploadedChatFile[];
  userId: SafeId<"user">;
}): Promise<Result<void, HandlerError<500> | SafeDbError>> => {
  const fileRollbackResult = await deleteUploadedChatFiles({
    files: uploadedFiles,
    recordAuditEvent,
    safeDb,
    threadId,
    userId,
    workspaceId: threadState.data.workspaceId,
  });
  if (Result.isError(fileRollbackResult)) {
    return fileRollbackResult;
  }

  if (threadState.type !== "created") {
    return Result.ok();
  }

  const threadRollbackResult = await safeDb(async (tx) => {
    const deletedThreads = await tx
      .delete(chatThreads)
      .where(
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.rollbackToken, threadState.rollbackToken),
          notExists(
            tx
              .select({ id: chatMessages.id })
              .from(chatMessages)
              .where(eq(chatMessages.threadId, chatThreads.id)),
          ),
        ),
      )
      .returning({ id: chatThreads.id });

    if (deletedThreads.length === 0) {
      return;
    }

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
      resourceId: threadId,
      workspaceId: threadState.data.workspaceId,
      metadata: { reason: "rollback_unpersisted_chat_side_effects" },
    });
  });

  return threadRollbackResult;
};
