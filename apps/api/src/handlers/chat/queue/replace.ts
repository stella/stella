import { panic, Result } from "better-result";
import * as v from "valibot";

import { CHAT_QUEUE_ERROR_CODE } from "@stll/api-contract/chat-queue";

import { queuedChatSendSchema } from "@/api/handlers/chat/chat-schema";
import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import {
  hasOnlyStoredAttachments,
  lockOwnQueueThreadOnTx,
  replaceQueuedChatMessageOnTx,
} from "@/api/handlers/chat/queue/chat-queue-store";
import {
  chatQueuedMessageParams,
  chatThreadNotFound,
  queuedMessageChanged,
  queuedMessageInlineFile,
  queuedMessageNotFound,
  queuedMessageSent,
} from "@/api/handlers/chat/queue/shared";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "replace",
  precondition: { type: "revision", fields: ["revision"] },
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  description:
    "Replace a queued message, only at the revision you last read: 409 " +
    "`queued_message_changed` when it changed since, `queued_message_sent` " +
    "once it was sent. The message keeps its place in the queue.",
  params: chatQueuedMessageParams,
  body: v.object({
    revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
    send: queuedChatSendSchema,
  }),
} satisfies HandlerConfig;

const replaceQueuedChatMessage = createSafeRootHandler(
  config,
  async function* ({
    body: { revision, send },
    params: { messageId, threadId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    if (send.message.id !== messageId) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: CHAT_QUEUE_ERROR_CODE.idChanged,
          message: "A queued message keeps its id",
        }),
      );
    }
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
        const replaced = await replaceQueuedChatMessageOnTx({
          expectedRevision: revision,
          id: messageId,
          send,
          threadId,
          tx,
        });
        if (replaced.type === "changed") {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
            resourceId: messageId,
            workspaceId: thread.workspaceId,
            metadata: { threadId, queued: true },
          });
        }
        return replaced;
      }),
    );
    if (outcome === undefined) {
      return Result.err(chatThreadNotFound());
    }
    switch (outcome.type) {
      case "changed":
        return Result.ok({ item: outcome.item });
      case "stale":
        return Result.err(queuedMessageChanged());
      case "sent":
        return Result.err(queuedMessageSent());
      case "not-found":
        return Result.err(queuedMessageNotFound());
      default:
        outcome satisfies never;
        return panic("Unhandled queued message change");
    }
  },
);

export default replaceQueuedChatMessage;
