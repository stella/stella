import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { timeEntries, timeTimers } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const RUNNING_TIMER_STATE = "running";

const timeEntryIsRunning = () => sql`CASE
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
  selection:
    | { type: "entries"; ids: SafeId<"timeEntry">[] }
    | { type: "invoice"; invoiceId: SafeId<"invoice"> };
  actorUserId: SafeId<"user">;
};

export const guardRunningTimeEntries = async ({
  tx,
  workspaceId,
  selection,
  actorUserId,
}: GuardRunningTimeEntriesOptions) => {
  const condition = and(
    eq(timeEntries.workspaceId, workspaceId),
    selection.type === "entries"
      ? inArray(timeEntries.id, selection.ids)
      : eq(timeEntries.invoiceId, selection.invoiceId),
  );
  const snapshot = await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(condition)
    .limit(LIMITS.timeEntriesPerWorkspace + 1);
  if (snapshot.length > LIMITS.timeEntriesPerWorkspace) {
    return new HandlerError({
      status: 409,
      message: "Time entry selection exceeds the matter limit",
    });
  }
  const ids = snapshot.map(({ id }) => id);
  // Timer transitions acquire the owner lock before touching a matter or entry.
  // Batch acquisition uses sorted keys so overlapping selections cannot deadlock.
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(owner_locks.lock_key)
    FROM (
      SELECT DISTINCT hashtext('timer:' || ${timeEntries.organizationId} || ':' || ${timeEntries.userId}) AS lock_key
      FROM ${timeEntries}
      WHERE ${timeEntries.workspaceId} = ${workspaceId}
        AND ${inArray(timeEntries.id, ids)}
        AND ${timeEntries.userId} IS NOT NULL
      ORDER BY lock_key
    ) AS owner_locks
    ORDER BY owner_locks.lock_key
  `);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
  const locked = await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(condition)
    .orderBy(asc(timeEntries.id))
    .limit(LIMITS.timeEntriesPerWorkspace + 1)
    .for("update");
  const snapshotIds = new Set(ids);
  if (
    locked.length !== snapshot.length ||
    locked.some(({ id }) => !snapshotIds.has(id))
  ) {
    return new HandlerError({
      status: 409,
      code: "time_entry_selection_changed",
      message: "Time entry selection changed; reload and try again",
    });
  }
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
