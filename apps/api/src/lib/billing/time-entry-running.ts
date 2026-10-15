import { panic } from "better-result";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  invoiceLines,
  invoices,
  timeEntries,
  timeEntryTimerStates,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withBillingMatterAdvisoryLocks } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const RUNNING_TIMER_STATE = "running";
export const timeEntryIsRunning = () => sql<boolean>`COALESCE((
  SELECT ${timeEntryTimerStates.state} = ${RUNNING_TIMER_STATE}
  FROM ${timeEntryTimerStates}
  WHERE ${timeEntryTimerStates.entryId} = ${timeEntries.id}
    AND ${timeEntryTimerStates.organizationId} = ${timeEntries.organizationId}
    AND ${timeEntryTimerStates.userId} = ${timeEntries.userId}
), ${timeEntries.timerStartedAt} IS NOT NULL AND ${timeEntries.timerStoppedAt} IS NULL)`;

type InvoiceRunningSelection = {
  type: "invoice";
  invoiceId: SafeId<"invoice">;
  additionalIds?: SafeId<"timeEntry">[];
  runningCheck?: "all" | "additional";
};

type GuardRunningTimeEntriesOptions = {
  tx: Pick<PgAsyncDatabase<PgQueryResultHKT>, "select" | "execute">;
  actorUserId: SafeId<"user">;
} & (
  | {
      workspaceId: SafeId<"workspace">;
      selection:
        | { type: "entries"; ids: SafeId<"timeEntry">[] }
        | InvoiceRunningSelection
        | { type: "none" };
    }
  | {
      organizationId: SafeId<"organization">;
      additionalWorkspaceIds?: readonly SafeId<"workspace">[];
      selection:
        | { type: "approval_batch"; ids: SafeId<"timeEntry">[] }
        | InvoiceRunningSelection;
    }
);

export const guardRunningTimeEntries = async (
  options: GuardRunningTimeEntriesOptions,
) => {
  const { tx, selection, actorUserId } = options;
  const selectedEntries = (() => {
    switch (selection.type) {
      case "approval_batch":
      case "entries":
        return inArray(timeEntries.id, selection.ids);
      case "invoice":
        // sql-perf-allow: bounded by invoice ID and the time_entries_invoice_idx source index.
        return sql`((${timeEntries.invoiceId} = ${selection.invoiceId} AND EXISTS (SELECT 1 FROM ${invoices} visible_invoice WHERE visible_invoice.id = ${selection.invoiceId})) OR ${inArray(timeEntries.id, selection.additionalIds ?? [])})`;
      case "none":
        return sql`false`;
      default:
        selection satisfies never;
        return panic("Unknown time entry selection");
    }
  })();
  const condition = and(
    "organizationId" in options
      ? eq(timeEntries.organizationId, options.organizationId)
      : eq(timeEntries.workspaceId, options.workspaceId),
    selectedEntries,
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
      WHERE ${condition}
        AND ${inArray(timeEntries.id, ids)}
        AND ${timeEntries.userId} IS NOT NULL
      ORDER BY lock_key
    ) AS owner_locks
    ORDER BY owner_locks.lock_key
  `);
  if ("organizationId" in options) {
    const invoiceMatters =
      selection.type === "invoice"
        ? sql`UNION SELECT hashtext(${invoiceLines.workspaceId}::text) AS lock_key FROM ${invoiceLines} WHERE ${invoiceLines.invoiceId}=${selection.invoiceId}`
        : sql``;
    const selectedMatters = sql`UNION SELECT hashtext(${workspaces.id}::text) AS lock_key FROM ${workspaces} WHERE ${inArray(workspaces.id, [...(options.additionalWorkspaceIds ?? [])])} AND ${workspaces.organizationId}=${options.organizationId}`;
    await withBillingMatterAdvisoryLocks(
      tx,
      sql`SELECT DISTINCT hashtext(${timeEntries.workspaceId}::text) AS lock_key FROM ${timeEntries} WHERE ${condition} AND ${timeEntries.workspaceId} IS NOT NULL ${invoiceMatters} ${selectedMatters}`,
    );
  } else {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${options.workspaceId}))`,
    );
  }
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
  // Approval batches report running refusals per row under these same locks.
  if (selection.type === "approval_batch") {
    return null;
  }
  const runningIds =
    selection.type === "invoice" && selection.runningCheck === "additional"
      ? (selection.additionalIds ?? [])
      : ids;
  const [blocked] = await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(
      and(
        condition,
        inArray(timeEntries.id, runningIds),
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
