import { panic, Result } from "better-result";
import { and, asc, eq, inArray } from "drizzle-orm";

import { chatQueuedMessages, chatTurns } from "@/api/db/schema";
import { stopChatTurnOnTx } from "@/api/handlers/chat/chat-turn-persistence";
import { stopLocalChatTurnRun } from "@/api/handlers/chat/chat-turn-run";
import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import {
  releaseChatQueueOnTx,
  wasSentOnTx,
} from "@/api/handlers/chat/queue/chat-queue-gate";
import {
  lockOwnQueueThreadOnTx,
  moveQueuedChatMessageOnTx,
} from "@/api/handlers/chat/queue/chat-queue-store";
import {
  chatQueuedMessageParams,
  chatThreadNotFound,
  queuedMessageNotFound,
  queuedMessageSent,
} from "@/api/handlers/chat/queue/shared";
import { detached } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  ringChatQueue,
  ringChatQueueToReplace,
} from "@/api/lib/chat/chat-queue-doorbell";
import { withChatRunPings } from "@/api/lib/chat/chat-run-pings";

const config = {
  contract: "patch",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  description:
    "Send a queued message next, now: it moves to the front and the queue " +
    "is released. A turn that runs is stopped; a turn that waits on you " +
    "(a question, an approval) is ended and replaced by this message.",
  params: chatQueuedMessageParams,
} satisfies HandlerConfig;

/** What sending a queued message now does to the thread's turn. */
type SendNowPlan =
  | { type: "next" }
  | { type: "stop"; executionId: string | null }
  | { type: "replace" };

const sendQueuedChatMessageNow = createSafeRootHandler(
  config,
  async function* ({ params: { messageId, threadId }, safeDb, session, user }) {
    const outcome = yield* Result.await(
      withChatRunPings(
        async (pings) =>
          await safeDb(async (tx) => {
            const thread = await lockOwnQueueThreadOnTx({
              organizationId: session.activeOrganizationId,
              threadId,
              tx,
              userId: user.id,
            });
            if (thread === undefined) {
              return { type: "no-thread" } as const;
            }
            const queued = await tx
              .select({ id: chatQueuedMessages.id })
              .from(chatQueuedMessages)
              .where(
                and(
                  eq(chatQueuedMessages.id, messageId),
                  eq(chatQueuedMessages.threadId, threadId),
                ),
              )
              .limit(1);
            if (queued.length === 0) {
              return (await wasSentOnTx({ id: messageId, threadId, tx }))
                ? ({ type: "sent" } as const)
                : ({ type: "not-found" } as const);
            }
            const first = (
              await tx
                .select({ id: chatQueuedMessages.id })
                .from(chatQueuedMessages)
                .where(eq(chatQueuedMessages.threadId, threadId))
                .orderBy(asc(chatQueuedMessages.position))
                .limit(1)
            ).at(0);
            if (first !== undefined && first.id !== messageId) {
              await moveQueuedChatMessageOnTx({
                beforeId: first.id,
                id: messageId,
                threadId,
                tx,
              });
            }
            await releaseChatQueueOnTx({ threadId, tx });
            const active = (
              await tx
                .select({ id: chatTurns.id, status: chatTurns.status })
                .from(chatTurns)
                .where(
                  and(
                    eq(chatTurns.threadId, threadId),
                    inArray(chatTurns.status, ["running", "awaiting-user"]),
                  ),
                )
                .limit(1)
            ).at(0);
            const plan: SendNowPlan = await (async () => {
              switch (active?.status) {
                case undefined:
                  return { type: "next" };
                case "awaiting-user":
                  return { type: "replace" };
                case "running": {
                  // Stop sends the next message: the turn's end rings the
                  // queue, and this message is first.
                  const stop = await stopChatTurnOnTx({
                    pings,
                    threadId,
                    tx,
                    turnId: active.id,
                  });
                  return {
                    type: "stop",
                    executionId:
                      stop.type === "requested" ? stop.executionId : null,
                  };
                }
                default:
                  return panic("Unhandled active turn status");
              }
            })();
            return { type: "planned", plan } as const;
          }),
      ),
    );
    switch (outcome.type) {
      case "no-thread":
        return Result.err(chatThreadNotFound());
      case "not-found":
        return Result.err(queuedMessageNotFound());
      case "sent":
        return Result.err(queuedMessageSent());
      case "planned":
        break;
      default:
        outcome satisfies never;
        return panic("Unhandled send-now outcome");
    }
    const { plan } = outcome;
    switch (plan.type) {
      case "next":
        ringChatQueue(threadId);
        break;
      case "replace":
        ringChatQueueToReplace(threadId);
        break;
      case "stop":
        if (plan.executionId !== null) {
          // A run this process produces settles sooner when told directly.
          const { executionId } = plan;
          detached(
            async () => await stopLocalChatTurnRun(executionId),
            "chat-queue.send-now-stop",
          );
        }
        break;
      default:
        plan satisfies never;
        return panic("Unhandled send-now plan");
    }
    return Result.ok({});
  },
);

export default sendQueuedChatMessageNow;
