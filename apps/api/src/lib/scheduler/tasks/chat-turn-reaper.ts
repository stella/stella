import { panic } from "better-result";
import { and, asc, inArray, lte, sql } from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";

import type { Transaction } from "@/api/db/root";
import { chatTurns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withChatRunPings } from "@/api/lib/chat/chat-run-pings";
import type { ChatRunPings } from "@/api/lib/chat/chat-run-pings";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const REAP_OWNERLESS_CHAT_TURNS_TASK =
  "chat.reapOwnerlessTurns" as const;

/**
 * The statuses whose lease decides whether the turn goes on: a running turn's
 * owner renews it, and a handed-over turn must be adopted before it lapses.
 */
const LEASED_UNSETTLED_STATUSES = ["running", "handed-over"] as const;

/** Turns ended per run; a larger backlog continues on the next run. */
const REAP_BATCH_SIZE = 100;
const REAP_CONCURRENCY = 4;

/**
 * End every running chat turn whose owner stopped renewing its lease (its
 * process died or hung), and every handed-over turn nobody adopted by its
 * lease, as `owner-lost`, through the same settlement a new
 * message on the thread would apply. Each turn ends in its own short
 * transaction under its thread lock, so a live owner renewing at that moment
 * either keeps the turn or loses it, never half of it.
 *
 * Crosses organizations by design, so it runs on the scheduler's system
 * connection; it reads turn ids only and writes through the turn's own
 * settlement.
 */
export const createReapOwnerlessChatTurnsTask =
  (
    reapOwnerlessChatTurnOnTx: (args: {
      pings: ChatRunPings;
      threadId: SafeId<"chatThread">;
      tx: Transaction;
    }) => Promise<void>,
  ): SchedulerTask =>
  async ({ db, logger, signal }) => {
    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    const expired = await db
      .select({ threadId: chatTurns.threadId })
      .from(chatTurns)
      .where(
        and(
          inArray(chatTurns.status, LEASED_UNSETTLED_STATUSES),
          lte(chatTurns.leaseExpiresAt, sql<Date>`now()`),
        ),
      )
      .orderBy(asc(chatTurns.leaseExpiresAt))
      .limit(REAP_BATCH_SIZE);
    const processed = await mapWithConcurrency({
      items: expired,
      limit: REAP_CONCURRENCY,
      operation: async ({ threadId }) => {
        if (signal.aborted) {
          return 0;
        }
        await withChatRunPings(
          async (pings) =>
            await db.transaction(
              async (tx) =>
                await reapOwnerlessChatTurnOnTx({ pings, threadId, tx }),
            ),
        );
        return 1;
      },
    });
    logger.info("scheduler.chat_turns_reaped", {
      "chatTurns.expired": expired.length,
      "chatTurns.threadsVisited": processed.filter((count) => count === 1)
        .length,
    });
  };
