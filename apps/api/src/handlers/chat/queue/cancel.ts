import { panic, Result } from "better-result";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import {
  lockOwnQueueThreadOnTx,
  parseQueuedChatSend,
} from "@/api/handlers/chat/queue/chat-queue-store";
import {
  chatQueuedMessageParams,
  chatThreadNotFound,
  queuedMessageSent,
} from "@/api/handlers/chat/queue/shared";
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
    "so it can be written again. Idempotent: a message no longer queued " +
    "answers as removed with `message: null`, except one that was sent " +
    "(409 `queued_message_sent`).",
  params: chatQueuedMessageParams,
} satisfies HandlerConfig;

const cancelQueuedChatMessage = createSafeRootHandler(
  config,
  async function* ({
    params: { messageId, threadId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const outcome = yield* Result.await(
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
          threadId,
          tx,
        });
        if (removed.type === "removed") {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
            resourceId: messageId,
            workspaceId: thread.workspaceId,
            metadata: { threadId, queued: true },
          });
        }
        return removed;
      }),
    );
    if (outcome === undefined) {
      return Result.err(chatThreadNotFound());
    }
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
