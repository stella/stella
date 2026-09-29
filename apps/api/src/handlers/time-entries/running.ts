import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { timeEntries, timeTimers } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const RUNNING_TIMER_STATE = "running";

export const timeEntryIsRunning = () => sql`CASE
  WHEN ${timeEntries.timerStartedAt} IS NOT NULL AND ${timeEntries.timerStoppedAt} IS NULL THEN true
  ELSE EXISTS (
    SELECT 1 FROM ${timeTimers}
    WHERE ${timeTimers.organizationId} = ${timeEntries.organizationId}
      AND ${timeTimers.legacyTimeEntryId} = ${timeEntries.id}
      AND ${timeTimers.state} = ${RUNNING_TIMER_STATE}
  ) END`;

type GuardRunningTimeEntriesOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  ids: SafeId<"timeEntry">[];
  actorUserId: SafeId<"user">;
};

export const guardRunningTimeEntries = async ({
  tx,
  workspaceId,
  ids,
  actorUserId,
}: GuardRunningTimeEntriesOptions) => {
  // Timer transitions acquire the owner lock before touching a matter or entry.
  // Batch acquisition uses sorted keys so overlapping selections cannot deadlock.
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtext(owner_locks.lock_key))
    FROM (
      SELECT DISTINCT 'timer:' || ${timeEntries.organizationId} || ':' || ${timeEntries.userId} AS lock_key
      FROM ${timeEntries}
      WHERE ${timeEntries.workspaceId} = ${workspaceId}
        AND ${inArray(timeEntries.id, ids)}
        AND ${timeEntries.userId} IS NOT NULL
      ORDER BY lock_key
    ) AS owner_locks
    ORDER BY owner_locks.lock_key
  `);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
  await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        inArray(timeEntries.id, ids),
      ),
    )
    .orderBy(asc(timeEntries.id))
    .limit(ids.length)
    .for("update");
  const [blocked] = await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        inArray(timeEntries.id, ids),
        ne(timeEntries.userId, actorUserId),
        timeEntryIsRunning(),
      ),
    )
    .limit(1);
  return blocked
    ? new HandlerError({
        status: 409,
        code: "running_timer",
        message: "Another member's running time entry cannot be changed",
        hint: "An organization owner or admin must end the member's timer before editing or deleting this entry.",
      })
    : null;
};
