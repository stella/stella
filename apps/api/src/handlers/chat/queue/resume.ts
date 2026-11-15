import { Result } from "better-result";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { lockOwnQueueThreadOnTx } from "@/api/handlers/chat/queue/chat-queue-store";
import {
  chatQueueThreadParams,
  chatThreadNotFound,
} from "@/api/handlers/chat/queue/shared";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ringChatQueue } from "@/api/lib/chat/chat-queue-doorbell";
import { releaseChatQueueOnTx } from "@/api/lib/chat/chat-queue-gate";

const config = {
  contract: "patch",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  description:
    "Resume the thread's queue, whatever held it. The next queued message " +
    "goes once the thread's turn has ended.",
  params: chatQueueThreadParams,
} satisfies HandlerConfig;

const resumeChatQueue = createSafeRootHandler(
  config,
  async function* ({ params: { threadId }, safeDb, session, user }) {
    const resumed = yield* Result.await(
      safeDb(async (tx) => {
        const thread = await lockOwnQueueThreadOnTx({
          organizationId: session.activeOrganizationId,
          threadId,
          tx,
          userId: user.id,
        });
        if (thread === undefined) {
          return false;
        }
        await releaseChatQueueOnTx({ threadId, tx });
        return true;
      }),
    );
    if (!resumed) {
      return Result.err(chatThreadNotFound());
    }
    ringChatQueue(threadId);
    return Result.ok({});
  },
);

export default resumeChatQueue;
