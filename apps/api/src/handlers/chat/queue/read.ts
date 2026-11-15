import { Result } from "better-result";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import {
  lockOwnQueueThreadOnTx,
  readChatQueueOnTx,
} from "@/api/handlers/chat/queue/chat-queue-store";
import {
  chatQueueThreadParams,
  chatThreadNotFound,
} from "@/api/handlers/chat/queue/shared";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  contract: "patch",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  description:
    "The messages queued in one of your chat threads, in the order they " +
    "will be sent, and what holds the queue, if anything.",
  params: chatQueueThreadParams,
} satisfies HandlerConfig;

const readChatQueue = createSafeRootHandler(
  config,
  async function* ({ params: { threadId }, safeDb, session, user }) {
    const queue = yield* Result.await(
      safeDb(async (tx) => {
        const thread = await lockOwnQueueThreadOnTx({
          organizationId: session.activeOrganizationId,
          threadId,
          tx,
          userId: user.id,
        });
        return thread === undefined
          ? undefined
          : await readChatQueueOnTx({ threadId, tx });
      }),
    );
    if (queue === undefined) {
      return Result.err(chatThreadNotFound());
    }
    return Result.ok(queue);
  },
);

export default readChatQueue;
