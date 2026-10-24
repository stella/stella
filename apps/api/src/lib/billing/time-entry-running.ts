import { panic, Result } from "better-result";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  invoiceLines,
  invoices,
  timeEntries,
  timeEntryTimerStates,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockBillingTimeEntrySources,
  withBillingMatterAdvisoryLocks,
} from "@/api/lib/db/aggregate-lock";
import type { AcquiredInvoiceMatterLocks } from "@/api/lib/db/aggregate-lock";
import { readBounded } from "@/api/lib/db/read-bounded";
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
  additionalIds?: SafeId<"timeEntry">[] | undefined;
  runningCheck?: "all" | "additional";
};

type RunningGuardBase = {
  tx: Pick<PgAsyncDatabase<PgQueryResultHKT>, "select" | "execute">;
  actorUserId: SafeId<"user">;
};
type InvoiceRunningGuardOptions = RunningGuardBase & {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  selection: InvoiceRunningSelection;
};
type OtherRunningGuardOptions = RunningGuardBase &
  (
    | {
        workspaceId: SafeId<"workspace">;
        selection:
          { type: "entries"; ids: SafeId<"timeEntry">[] } | { type: "none" };
      }
    | {
        organizationId: SafeId<"organization">;
        additionalWorkspaceIds?: readonly SafeId<"workspace">[];
        selection: { type: "approval_batch"; ids: SafeId<"timeEntry">[] };
      }
  );
type GuardRunningTimeEntriesOptions =
  InvoiceRunningGuardOptions | OtherRunningGuardOptions;

export function guardRunningTimeEntries(
  options: InvoiceRunningGuardOptions,
): Promise<Result<AcquiredInvoiceMatterLocks, HandlerError>>;
export function guardRunningTimeEntries(
  options: OtherRunningGuardOptions,
): Promise<HandlerError | null>;
export async function guardRunningTimeEntries(
  options: GuardRunningTimeEntriesOptions,
): Promise<
  Result<AcquiredInvoiceMatterLocks, HandlerError> | HandlerError | null
> {
  const { tx, selection, actorUserId } = options;
  const refuse = (error: HandlerError) =>
    selection.type === "invoice" ? Result.err(error) : error;
  let acquiredInvoiceMatters: AcquiredInvoiceMatterLocks | undefined;
  const selectedEntries = (() => {
    switch (selection.type) {
      case "approval_batch":
      case "entries":
        return inArray(timeEntries.id, selection.ids);
      case "invoice": {
        const additional =
          selection.additionalIds === undefined
            ? sql`false`
            : inArray(timeEntries.id, selection.additionalIds);
        // sql-perf-allow: bounded by invoice ID and the time_entries_invoice_idx source index.
        return sql`((${timeEntries.invoiceId} = ${selection.invoiceId} AND EXISTS (SELECT 1 FROM ${invoices} visible_invoice WHERE visible_invoice.id = ${selection.invoiceId})) OR ${additional})`;
      }
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
    .select({ id: timeEntries.id, workspaceId: timeEntries.workspaceId })
    .from(timeEntries)
    .where(condition)
    .limit(LIMITS.timeEntriesPerWorkspace + 1);
  if (snapshot.length > LIMITS.timeEntriesPerWorkspace) {
    return refuse(
      new HandlerError({
        status: 409,
        message: "Time entry selection exceeds the matter limit",
      }),
    );
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
        ? await tx
            .select({ workspaceId: invoiceLines.workspaceId })
            .from(invoiceLines)
            .where(eq(invoiceLines.invoiceId, selection.invoiceId))
            .limit(LIMITS.invoiceLinesPerInvoice + 1)
        : [];
    if (invoiceMatters.length > LIMITS.invoiceLinesPerInvoice) {
      return refuse(
        new HandlerError({
          status: 409,
          message: "Invoice line selection exceeds the invoice limit",
        }),
      );
    }
    if ("workspaceId" in options) {
      const workspaceIds = new Set([
        options.workspaceId,
        ...snapshot
          .map((entry) => entry.workspaceId)
          .filter((id) => id !== null),
        ...invoiceMatters.map((line) => line.workspaceId),
      ]);
      await withBillingMatterAdvisoryLocks(
        tx,
        sql`
        SELECT DISTINCT hashtext(matter_id::text) AS lock_key
        FROM unnest(ARRAY[${sql.join(
          [...workspaceIds].map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]) AS matter_id
      `,
      );
      // Validate this snapshot before source-row locks. The returned plan also
      // fences changes between this read and the later invoice lock owner.
      const currentMatterRead = await readBounded(
        tx
          .select({ workspaceId: invoiceLines.workspaceId })
          .from(invoiceLines)
          .where(eq(invoiceLines.invoiceId, options.selection.invoiceId)),
        LIMITS.invoiceLinesPerInvoice,
      );
      if (
        currentMatterRead.type === "overflow" ||
        currentMatterRead.rows.some(
          (line) => !workspaceIds.has(line.workspaceId),
        )
      ) {
        return refuse(
          new HandlerError({
            status: 409,
            code: "invoice_participation_changed",
            message: "Invoice matters changed; reload and try again",
          }),
        );
      }
      acquiredInvoiceMatters = {
        type: "acquired",
        invoiceId: options.selection.invoiceId,
        workspaceIds,
      };
    } else {
      const selectedMatters =
        options.additionalWorkspaceIds === undefined
          ? sql``
          : sql`UNION SELECT hashtext(${workspaces.id}::text) AS lock_key FROM ${workspaces} WHERE ${inArray(workspaces.id, [...options.additionalWorkspaceIds])} AND ${workspaces.organizationId}=${options.organizationId}`;
      await withBillingMatterAdvisoryLocks(
        tx,
        sql`
        SELECT DISTINCT hashtext(${timeEntries.workspaceId}::text) AS lock_key
        FROM ${timeEntries} WHERE ${condition} AND ${timeEntries.workspaceId} IS NOT NULL ${selectedMatters}
      `,
      );
    }
  } else {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${options.workspaceId}))`,
    );
  }
  const lockedRead = await lockBillingTimeEntrySources(tx, condition);
  if (lockedRead.type === "overflow") {
    return refuse(
      new HandlerError({
        status: 409,
        code: "time_entry_selection_changed",
        message: "Time entry selection changed; reload and try again",
      }),
    );
  }
  const locked = lockedRead.rows;
  const snapshotIds = new Set(ids);
  if (
    locked.length !== snapshot.length ||
    locked.some(({ id }) => !snapshotIds.has(id))
  ) {
    return refuse(
      new HandlerError({
        status: 409,
        code: "time_entry_selection_changed",
        message: "Time entry selection changed; reload and try again",
      }),
    );
  }
  // Approval batches report running refusals per row under these same locks.
  if (selection.type === "approval_batch") {
    return null;
  }
  const runningIds =
    selection.type === "invoice" && selection.runningCheck === "additional"
      ? ids.filter((id) => selection.additionalIds?.includes(id) === true)
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
  if (blocked) {
    return refuse(
      new HandlerError({
        status: 409,
        code: "running_timer",
        message: "Another member's running time entry cannot be changed",
        hint: "An organization owner or admin must end the member's timer before editing or deleting this entry.",
      }),
    );
  }
  if (selection.type === "invoice") {
    return Result.ok(
      acquiredInvoiceMatters ??
        panic("Invoice guard did not acquire its matter set"),
    );
  }
  return null;
}
