import { panic, Result } from "better-result";
import * as v from "valibot";

import { QUEUED_MESSAGE_FILES_ON_REMOVE } from "@stll/api-contract/chat-queue";
import { numberFromString } from "@stll/api-contract/http-input";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import {
  lockOwnQueueThreadOnTx,
  parseQueuedChatSend,
} from "@/api/handlers/chat/queue/chat-queue-store";
import {
  chatQueuedMessageParams,
  chatThreadNotFound,
  queuedMessageChanged,
  queuedMessageSent,
} from "@/api/handlers/chat/queue/shared";
import {
  deleteChatFilesOnTx,
  handOffChatFileCleanup,
} from "@/api/handlers/chat/upload-files";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { announceChatQueueChange } from "@/api/lib/chat/chat-queue-announcement";
import { ringChatQueue } from "@/api/lib/chat/chat-queue-doorbell";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { removeQueuedChatMessageOnTx } from "@/api/lib/db/chat-queue-gate";

const config = {
  contract: "patch",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  description:
    "Remove a queued message and answer it as it was queued (`message`), " +
    "so it can be written again, only at the `revision` you read (409 " +
    "`queued_message_changed` once it was edited since). `files`: " +
    "`delete` removes the files its queueing stored; `keep` leaves them in " +
    "the chat, to be sent again by reference. Idempotent: a message no " +
    "longer queued answers as removed with `message: null`, except one " +
    "that was sent (409 `queued_message_sent`).",
  params: chatQueuedMessageParams,
  query: v.object({
    files: v.picklist(Object.values(QUEUED_MESSAGE_FILES_ON_REMOVE)),
    revision: numberFromString(v.pipe(v.number(), v.integer(), v.minValue(0))),
  }),
} satisfies HandlerConfig;

const NO_FILES_DELETED = { type: "deleted", cleanup: [] } as const;

const cancelQueuedChatMessage = createSafeRootHandler(
  config,
  async function* ({
    params: { messageId, threadId },
    query: { files, revision },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const thread = await lockOwnQueueThreadOnTx({
          organizationId: session.activeOrganizationId,
          threadId,
          tx,
          userId: user.id,
        });
        if (thread === undefined) {
          return undefined;
        }
        const removed = await removeQueuedChatMessageOnTx({
          id: messageId,
          revision,
          threadId,
          tx,
        });
        if (removed.type !== "removed") {
          return { removed, deletion: NO_FILES_DELETED };
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
          resourceId: messageId,
          workspaceId: thread.workspaceId,
          metadata: { threadId, queued: true },
        });
        // Remove deletes the files its enqueue stored (Edit keeps them for
        // the composer); files it named that were stored before are never
        // its own.
        const deletion = await deleteChatFilesOnTx({
          fileIds:
            files === QUEUED_MESSAGE_FILES_ON_REMOVE.delete
              ? removed.uploadedFileIds
              : [],
          organizationId: session.activeOrganizationId,
          recordAuditEvent,
          threadId,
          tx,
          userId: user.id,
          workspaceId: thread.workspaceId,
        });
        return { removed, deletion };
      }),
    );
    if (result === undefined) {
      return Result.err(chatThreadNotFound());
    }
    if (result.deletion.type === "deleted") {
      await handOffChatFileCleanup(result.deletion.cleanup);
    }
    const outcome = result.removed;
    switch (outcome.type) {
      case "removed":
      case "not-found": {
        announceChatQueueChange({
          organizationId: session.activeOrganizationId,
          userId: user.id,
        });
        // Removing the head, or the last message with its hold, may let
        // the queue go.
        ringChatQueue(threadId);
        return Result.ok({
          message:
            outcome.type === "removed"
              ? parseQueuedChatSend(outcome.request).message
              : null,
        });
      }
      case "changed":
        return Result.err(queuedMessageChanged());
      case "sent":
        return Result.err(queuedMessageSent());
      default:
        outcome satisfies never;
        return panic("Unhandled queued message removal");
    }
  },
);

// Every queue change locks the member's thread first, the row its turns
// lock, and writes only that thread's queue.
declareAggregateMutation(cancelQueuedChatMessage, {
  type: "aggregate",
  aggregates: ["chatThread"],
});

export default cancelQueuedChatMessage;
