import { Result } from "better-result";

import { CHAT_QUEUE_HOLD_REASON } from "@stll/api-contract/chat-queue";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { lockOwnQueueThreadOnTx } from "@/api/handlers/chat/queue/chat-queue-store";
import {
  chatQueueThreadParams,
  chatThreadNotFound,
} from "@/api/handlers/chat/queue/shared";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { announceChatQueueChange } from "@/api/lib/chat/chat-queue-announcement";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { holdChatQueueOnTx } from "@/api/lib/db/chat-queue-gate";

const config = {
  contract: "patch",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  description:
    "Pause the thread's queue: nothing queued is sent until you resume it " +
    "or send a message. A thread with nothing queued has nothing to pause.",
  params: chatQueueThreadParams,
} satisfies HandlerConfig;

const pauseChatQueue = createSafeRootHandler(
  config,
  async function* ({ params: { threadId }, safeDb, session, user }) {
    const paused = yield* Result.await(
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
        await holdChatQueueOnTx({
          hold: { reason: CHAT_QUEUE_HOLD_REASON.member },
          threadId,
          tx,
        });
        return true;
      }),
    );
    if (!paused) {
      return Result.err(chatThreadNotFound());
    }
    announceChatQueueChange({
      organizationId: session.activeOrganizationId,
      userId: user.id,
    });
    return Result.ok({});
  },
);

// Every queue change locks the member's thread first, the row its turns
// lock, and writes only that thread's queue.
declareAggregateMutation(pauseChatQueue, {
  type: "aggregate",
  aggregates: ["chatThread"],
});

export default pauseChatQueue;
