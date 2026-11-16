import { Result } from "better-result";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import {
  lockOwnQueueThreadOnTx,
  readQueuedChatSendOnTx,
} from "@/api/handlers/chat/queue/chat-queue-store";
import {
  chatQueuedMessageParams,
  chatThreadNotFound,
  queuedMessageNotFound,
} from "@/api/handlers/chat/queue/shared";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  contract: "patch",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  description:
    "One message queued in one of your chat threads, whole as it was " +
    "queued (the queue's read shows only its beginning), with its revision.",
  params: chatQueuedMessageParams,
} satisfies HandlerConfig;

const readQueuedChatMessage = createSafeRootHandler(
  config,
  async function* ({ params: { messageId, threadId }, safeDb, session, user }) {
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const thread = await lockOwnQueueThreadOnTx({
          organizationId: session.activeOrganizationId,
          threadId,
          tx,
          userId: user.id,
        });
        return thread === undefined
          ? ({ type: "no-thread" } as const)
          : ({
              type: "read",
              queued: await readQueuedChatSendOnTx({
                id: messageId,
                threadId,
                tx,
              }),
            } as const);
      }),
    );
    if (outcome.type === "no-thread") {
      return Result.err(chatThreadNotFound());
    }
    if (outcome.queued === undefined) {
      return Result.err(queuedMessageNotFound());
    }
    return Result.ok({
      message: outcome.queued.send.message,
      revision: outcome.queued.revision,
    });
  },
);

export default readQueuedChatMessage;
