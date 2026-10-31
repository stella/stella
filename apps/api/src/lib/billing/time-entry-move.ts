import { and, eq, isNull } from "drizzle-orm";

import { BILLING_STATUS } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { invoiceLines, timeEntries, workspaces } from "@/api/db/schema";
import { timeEntryIsRunning } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/** A draft time entry may only move into a matter its editor can use now. */
export const timeEntryMoveTargetError = (
  target: { status: string } | null,
): HandlerError | null =>
  target?.status === "active"
    ? null
    : new HandlerError({
        status: 404,
        code: "not_found",
        message: "Target matter not found",
        hint: "Move the entry to an active matter you can access.",
      });

/** Only a draft moves: submitted or approved time is under review. */
export const timeEntryMoveStatusError = (
  status: string,
): HandlerError | null =>
  status === BILLING_STATUS.DRAFT
    ? null
    : new HandlerError({
        status: 409,
        code: "wrong_status",
        message: "Only a draft time entry can move to another matter",
        hint: "Ask the approver to return the entry to draft, then move it.",
      });

/**
 * Re-checks a move under the caller's matter and entry locks: the entry is
 * still a draft in the source matter, no timer runs on it, no invoice holds
 * it, and the target matter is still active in the organization.
 */
export const guardTimeEntryMove = async (
  tx: Transaction,
  {
    entryId,
    from,
    to,
  }: {
    entryId: SafeId<"timeEntry">;
    from: SafeId<"workspace">;
    to: SafeId<"workspace">;
  },
): Promise<HandlerError | null> => {
  const [entry] = await tx
    .select({
      organizationId: timeEntries.organizationId,
      status: timeEntries.status,
      invoiceId: timeEntries.invoiceId,
      running: timeEntryIsRunning(),
    })
    .from(timeEntries)
    .where(and(eq(timeEntries.id, entryId), eq(timeEntries.workspaceId, from)))
    .limit(1);
  if (!entry) {
    return new HandlerError({
      status: 409,
      message: "Time entry changed; reload and try again",
    });
  }
  const statusError = timeEntryMoveStatusError(entry.status);
  if (statusError) {
    return statusError;
  }
  if (entry.running) {
    return new HandlerError({
      status: 409,
      code: "running_timer",
      message: "A running time entry cannot move to another matter",
      hint: "Stop the timer, then move the entry.",
    });
  }
  const [invoiced] = await tx
    .select({ id: invoiceLines.id })
    .from(invoiceLines)
    .where(
      and(
        eq(invoiceLines.timeEntryId, entryId),
        isNull(invoiceLines.releasedAt),
      ),
    )
    .limit(1);
  if (entry.invoiceId !== null || invoiced) {
    return new HandlerError({
      status: 409,
      code: "time_entry_invoiced",
      message: "A time entry on an invoice cannot move to another matter",
      hint: "Remove the entry from its invoice, then move it.",
    });
  }
  const [target] = await tx
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, to),
        eq(workspaces.organizationId, entry.organizationId),
      ),
    )
    .limit(1);
  return timeEntryMoveTargetError(target ?? null);
};
