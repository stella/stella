import { panic } from "better-result";
import { and, asc, eq, lte, sql } from "drizzle-orm";

import { chatTurns } from "@/api/db/schema";
import { reapOwnerlessChatTurnOnTx } from "@/api/handlers/chat/chat-turn-persistence";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const REAP_OWNERLESS_CHAT_TURNS_TASK =
  "chat.reapOwnerlessTurns" as const;

/** Turns ended per run; a larger backlog continues on the next run. */
const REAP_BATCH_SIZE = 100;

/**
 * End every running chat turn whose owner stopped renewing its lease (its
 * process died or hung) as `owner-lost`, through the same settlement a new
 * message on the thread would apply. Each turn ends in its own short
 * transaction under its thread lock, so a live owner renewing at that moment
 * either keeps the turn or loses it, never half of it.
 *
 * Crosses organizations by design, so it runs on the scheduler's system
 * connection; it reads turn ids only and writes through the turn's own
 * settlement.
 */
export const reapOwnerlessChatTurns: SchedulerTask = async ({
  db,
  logger,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const expired = await db
    .select({ threadId: chatTurns.threadId })
    .from(chatTurns)
    .where(
      and(
        eq(chatTurns.status, "running"),
        lte(chatTurns.leaseExpiresAt, sql<Date>`now()`),
      ),
    )
    .orderBy(asc(chatTurns.leaseExpiresAt))
    .limit(REAP_BATCH_SIZE);
  let visited = 0;
  for (const { threadId } of expired) {
    if (signal.aborted) {
      break;
    }
    await db.transaction(
      async (tx) => await reapOwnerlessChatTurnOnTx({ threadId, tx }),
    );
    visited += 1;
  }
  logger.info("scheduler.chat_turns_reaped", {
    "chatTurns.expired": expired.length,
    "chatTurns.threadsVisited": visited,
  });
};
