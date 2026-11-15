import { panic, Result } from "better-result";
import * as v from "valibot";

import { CHAT_QUEUE_ERROR_CODE } from "@stll/api-contract/chat-queue";

import { queuedChatSendSchema } from "@/api/handlers/chat/chat-schema";
import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import {
  enqueueChatMessageOnTx,
  hasOnlyStoredAttachments,
  lockOwnQueueThreadOnTx,
} from "@/api/handlers/chat/queue/chat-queue-store";
import {
  chatQueueThreadParams,
  chatThreadNotFound,
  queuedMessageInlineFile,
  queuedMessageSent,
} from "@/api/handlers/chat/queue/shared";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { ringChatQueue } from "@/api/lib/chat/chat-queue-doorbell";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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
    "409 once it was sent. Its files must be stored files of yours.",
  params: chatQueueThreadParams,
  body: v.object({ send: queuedChatSendSchema }),
} satisfies HandlerConfig;

const chatQueueFull = () =>
  new HandlerError({
    status: 409,
    code: CHAT_QUEUE_ERROR_CODE.full,
    message: "This chat already has as many queued messages as it can hold",
  });

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
    if (!hasOnlyStoredAttachments(send)) {
      return Result.err(queuedMessageInlineFile());
    }
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
        const enqueued = await enqueueChatMessageOnTx({
          id: send.message.id,
          send,
          threadId,
          tx,
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
      }),
    );
    if (outcome === undefined) {
      return Result.err(chatThreadNotFound());
    }
    switch (outcome.type) {
      case "queued":
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

export default enqueueChatMessage;
