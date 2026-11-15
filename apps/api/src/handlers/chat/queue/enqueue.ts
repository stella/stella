import { panic, Result } from "better-result";
import * as v from "valibot";

import { CHAT_QUEUE_ERROR_CODE } from "@stll/api-contract/chat-queue";

import type { SafeDb } from "@/api/db/safe-db";
import {
  isChatPart,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import {
  type QueuedChatSend,
  queuedChatSendSchema,
} from "@/api/handlers/chat/chat-schema";
import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import {
  enqueueChatMessageOnTx,
  hasOnlyStoredAttachments,
  lockOwnQueueThreadOnTx,
} from "@/api/handlers/chat/queue/chat-queue-store";
import {
  chatQueueThreadParams,
  chatThreadNotFound,
  queuedMessageInvalid,
  queuedMessageSent,
} from "@/api/handlers/chat/queue/shared";
import {
  deleteUploadedChatFiles,
  type UploadedChatFile,
  uploadMessageFiles,
} from "@/api/handlers/chat/upload-files";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { announceChatQueueChange } from "@/api/lib/chat/chat-queue-announcement";
import { ringChatQueue } from "@/api/lib/chat/chat-queue-doorbell";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { LegalHoldActiveError } from "@/api/lib/workspaces/legal-holds/errors";
import { legalHoldRefusal } from "@/api/lib/workspaces/legal-holds/refusal";

const config = {
  contract: "patch",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  description:
    "Queue a message in one of your chat threads. It is sent as you, in " +
    "order, once the thread's turn has ended and nothing holds the queue; " +
    "with nothing ahead of it, that is at once. The message id is the " +
    "idempotency key: queueing it again answers the message as queued, or " +
    "409 once it was sent. Files sent inline are stored with the same " +
    "checks as a send's, and deleted when the message is removed.",
  params: chatQueueThreadParams,
  body: v.object({ send: queuedChatSendSchema }),
} satisfies HandlerConfig;

const chatQueueFull = () =>
  new HandlerError({
    status: 409,
    code: CHAT_QUEUE_ERROR_CODE.full,
    message: "This chat already has as many queued messages as it can hold",
  });

/**
 * The send with its inline files stored as the member's chat files, through
 * the send's own upload (`uploadMessageFiles`: the same scan, size, type and
 * legal-hold checks); a send without inline files is unchanged.
 */
const storeInlineFiles = async ({
  organizationId,
  recordAuditEvent,
  safeDb,
  send,
  threadId,
  userId,
}: {
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  send: QueuedChatSend;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
}) => {
  if (hasOnlyStoredAttachments(send)) {
    return Result.ok({
      send,
      uploadedFiles: [] satisfies UploadedChatFile[],
      workspaceId: null,
    });
  }
  const thread = await safeDb(
    async (tx) =>
      await lockOwnQueueThreadOnTx({ organizationId, threadId, tx, userId }),
  );
  if (Result.isError(thread)) {
    return Result.err(thread.error);
  }
  if (thread.value === undefined) {
    return Result.err(chatThreadNotFound());
  }
  const { parts } = send.message;
  if (!parts.every(isChatPart)) {
    return Result.err(queuedMessageInvalid());
  }
  const uploaded = await uploadMessageFiles({
    message: toPersistableChatMessage({
      id: send.message.id,
      parts,
      role: "user",
    }),
    organizationId,
    recordAuditEvent,
    safeDb,
    threadId,
    userId,
    workspaceId: thread.value.workspaceId,
  });
  if (Result.isError(uploaded)) {
    const { error } = uploaded;
    return Result.err(
      LegalHoldActiveError.is(error) ? legalHoldRefusal(error) : error,
    );
  }
  return Result.ok({
    send: {
      ...send,
      message: { ...send.message, parts: uploaded.value.message.parts },
    },
    uploadedFiles: uploaded.value.uploadedFiles,
    workspaceId: thread.value.workspaceId,
  });
};

const enqueueChatMessage = createSafeRootHandler(
  config,
  async function* ({
    body: { send },
    params: { threadId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const stored = yield* Result.await(
      storeInlineFiles({
        organizationId: session.activeOrganizationId,
        recordAuditEvent,
        safeDb,
        send,
        threadId,
        userId: user.id,
      }),
    );
    const written = await safeDb(async (tx) => {
      const thread = await lockOwnQueueThreadOnTx({
        organizationId: session.activeOrganizationId,
        threadId,
        tx,
        userId: user.id,
      });
      if (thread === undefined) {
        return undefined;
      }
      const enqueued = await enqueueChatMessageOnTx({
        id: send.message.id,
        send: stored.send,
        threadId,
        tx,
        uploadedFileIds: stored.uploadedFiles.map(({ id }) => id),
      });
      if (enqueued.type === "queued") {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
          resourceId: send.message.id,
          workspaceId: thread.workspaceId,
          metadata: { threadId, queued: true },
        });
      }
      return enqueued;
    });
    // Files stored for a message that was not queued now (already queued
    // or sent, the queue full, no such thread, a failed write) belong to
    // nothing.
    if (!Result.isOk(written) || written.value?.type !== "queued") {
      const cleaned = await deleteUploadedChatFiles({
        files: stored.uploadedFiles,
        recordAuditEvent,
        safeDb,
        threadId,
        userId: user.id,
        workspaceId: stored.workspaceId,
      });
      if (Result.isError(cleaned)) {
        captureError(
          cleaned.error,
          handlerErrorContext("chat.queue.enqueue.cleanup", { threadId }),
        );
      }
    }
    const outcome = yield* Result.await(Promise.resolve(written));
    if (outcome === undefined) {
      return Result.err(chatThreadNotFound());
    }
    switch (outcome.type) {
      case "already-queued":
        return Result.ok({ item: outcome.item });
      case "queued":
        announceChatQueueChange({
          organizationId: session.activeOrganizationId,
          userId: user.id,
        });
        ringChatQueue(threadId);
        return Result.ok({ item: outcome.item });
      case "full":
        return Result.err(chatQueueFull());
      case "sent":
        return Result.err(queuedMessageSent());
      default:
        outcome satisfies never;
        return panic("Unhandled enqueue outcome");
    }
  },
);

// Every queue change locks the member's thread first, the row its turns
// lock, and writes only that thread's queue.
declareAggregateMutation(enqueueChatMessage, {
  type: "aggregate",
  aggregates: ["chatThread"],
});

export default enqueueChatMessage;
