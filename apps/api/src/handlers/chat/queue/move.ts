import { Result } from "better-result";
import * as v from "valibot";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import {
  lockOwnQueueThreadOnTx,
  moveQueuedChatMessageOnTx,
} from "@/api/handlers/chat/queue/chat-queue-store";
import {
  chatQueuedMessageParams,
  chatThreadNotFound,
  queuedMessageNotFound,
} from "@/api/handlers/chat/queue/shared";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ringChatQueue } from "@/api/lib/chat/chat-queue-doorbell";
import { resourceIdSchema } from "@/api/lib/custom-schema";

const config = {
  contract: "patch",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  description:
    "Move a queued message before another queued message of the thread, " +
    "or to the end with `beforeId: null`.",
  params: chatQueuedMessageParams,
  body: v.object({ beforeId: v.nullable(resourceIdSchema("chatMessage")) }),
} satisfies HandlerConfig;

const moveQueuedChatMessage = createSafeRootHandler(
  config,
  async function* ({
    body: { beforeId },
    params: { messageId, threadId },
    safeDb,
    session,
    user,
  }) {
    const moved = yield* Result.await(
      safeDb(async (tx) => {
        const thread = await lockOwnQueueThreadOnTx({
          organizationId: session.activeOrganizationId,
          threadId,
          tx,
          userId: user.id,
        });
        return thread === undefined
          ? undefined
          : await moveQueuedChatMessageOnTx({
              beforeId,
              id: messageId,
              threadId,
              tx,
            });
      }),
    );
    if (moved === undefined) {
      return Result.err(chatThreadNotFound());
    }
    if (moved === "not-found") {
      return Result.err(queuedMessageNotFound());
    }
    ringChatQueue(threadId);
    return Result.ok({});
  },
);

export default moveQueuedChatMessage;
