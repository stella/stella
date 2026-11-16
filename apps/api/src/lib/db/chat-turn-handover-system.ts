import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { chatTurns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

/** A handed-over turn waiting for an adopter, and whose it is. */
export type HandedOverChatTurn = {
  organizationId: SafeId<"organization">;
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
  userId: SafeId<"user">;
};

/**
 * The handed-over turns an adopter may still take, the soonest to lapse
 * first. Crosses organizations by design, as the turn reaper does: it reads
 * ids and owners only, before the member is proved again, and the adoption
 * itself runs on that member's own connection under the thread lock. Only
 * the owner connection's door in `db/root.ts` runs it.
 */
export const sweepHandedOverChatTurnsOnTx = async ({
  limit,
  tx,
}: {
  limit: number;
  tx: Transaction;
}): Promise<HandedOverChatTurn[]> =>
  (
    await tx
      .select({
        organizationId: chatTurns.organizationId,
        threadId: chatTurns.threadId,
        turnId: chatTurns.id,
        userId: chatTurns.userId,
      })
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.status, "handed-over"),
          isNull(chatTurns.executionId),
          gt(chatTurns.leaseExpiresAt, sql<Date>`now()`),
        ),
      )
      .orderBy(asc(chatTurns.leaseExpiresAt), asc(chatTurns.id))
      .limit(limit)
  ).map((turn) => ({
    organizationId: turn.organizationId,
    threadId: turn.threadId,
    turnId: turn.turnId,
    userId: brandPersistedUserId(turn.userId),
  }));
