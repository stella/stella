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
  lockMatterStewardship,
  lockTimerOwnerIdentities,
  withBillingMatterAdvisoryLocks,
} from "@/api/lib/db/aggregate-lock";
import type { AcquiredInvoiceMatterLocks } from "@/api/lib/db/aggregate-lock";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

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
        /** Other matters the write touches, such as the one an entry moves to. */
        additionalWorkspaceIds?: readonly SafeId<"workspace">[];
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

type MatterScopedGuardOptions = Extract<
  OtherRunningGuardOptions,
  { workspaceId: SafeId<"workspace"> }
>;

/**
 * Every matter a matter-scoped write touches, in the shared sorted key order,
 * so a move between two matters cannot deadlock with one the other way.
 */
const lockSelectedMatters = async (
  tx: RunningGuardBase["tx"],
  { workspaceId, additionalWorkspaceIds }: MatterScopedGuardOptions,
) => {
  const workspaceIds =
    additionalWorkspaceIds === undefined
      ? [workspaceId]
      : [workspaceId, ...additionalWorkspaceIds];
  await withBillingMatterAdvisoryLocks(
    tx,
    sql`
      SELECT DISTINCT hashtext(matter_id::text) AS lock_key
      FROM unnest(ARRAY[${sql.join(
        workspaceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]) AS matter_id
    `,
  );
};

const readSelectedEntryScope = (
  tx: RunningGuardBase["tx"],
  condition: Parameters<typeof lockBillingTimeEntrySources>[1],
) =>
  tx
    .select({
      id: timeEntries.id,
      organizationId: timeEntries.organizationId,
      workspaceId: timeEntries.workspaceId,
      userId: timeEntries.userId,
    })
    .from(timeEntries)
    .where(condition)
    .limit(LIMITS.timeEntriesPerWorkspace + 1);

type LockRunningEntryPrefixOptions = {
  options: GuardRunningTimeEntriesOptions;
  snapshot: Awaited<ReturnType<typeof readSelectedEntryScope>>;
  invoiceMatters: { workspaceId: SafeId<"workspace"> }[];
};
const lockRunningEntryPrefix = async ({
  options,
  snapshot,
  invoiceMatters,
}: LockRunningEntryPrefixOptions) => {
  const { tx, actorUserId } = options;
  const additionalWorkspaceIds =
    "additionalWorkspaceIds" in options &&
    options.additionalWorkspaceIds !== undefined
      ? options.additionalWorkspaceIds
      : [];
  const explicitWorkspaceIds = [
    ...("workspaceId" in options ? [options.workspaceId] : []),
    ...additionalWorkspaceIds,
    ...invoiceMatters.map((matter) => matter.workspaceId),
  ];
  const explicitMatters =
    "organizationId" in options
      ? explicitWorkspaceIds.map((id) => ({
          id,
          organizationId: options.organizationId,
        }))
      : await tx
          .select({
            id: workspaces.id,
            organizationId: workspaces.organizationId,
          })
          .from(workspaces)
          .where(inArray(workspaces.id, explicitWorkspaceIds))
          .limit(explicitWorkspaceIds.length);
  const rowsByOrganization = Map.groupBy(snapshot, (row) => row.organizationId);
  for (const matter of explicitMatters) {
    if (!rowsByOrganization.has(matter.organizationId)) {
      rowsByOrganization.set(matter.organizationId, []);
    }
  }
  if (
    "organizationId" in options &&
    !rowsByOrganization.has(options.organizationId)
  ) {
    rowsByOrganization.set(options.organizationId, []);
  }
  await lockMatterStewardship({
    tx,
    requests: [...rowsByOrganization].map(([organizationId, rows]) => ({
      organizationId,
      workspaceIds: [
        ...new Set([
          ...explicitMatters
            .filter((matter) => matter.organizationId === organizationId)
            .map(({ id }) => id),
          ...rows.flatMap((row) =>
            row.workspaceId === null ? [] : [row.workspaceId],
          ),
        ]),
      ],
      userIds: [
        ...new Set([
          actorUserId,
          ...rows.flatMap((row) => (row.userId === null ? [] : [row.userId])),
        ]),
      ],
    })),
    mode: "update",
  });
  await lockTimerOwnerIdentities({
    tx,
    owners: snapshot.flatMap((row) =>
      row.userId === null
        ? []
        : [
            {
              organizationId: row.organizationId,
              userId: brandPersistedUserId(row.userId),
            },
          ],
    ),
  });
};

type LockRunningBillingMattersOptions = LockRunningEntryPrefixOptions & {
  condition: Parameters<typeof lockBillingTimeEntrySources>[1];
};
const lockRunningBillingMatters = async ({
  options,
  snapshot,
  invoiceMatters,
  condition,
}: LockRunningBillingMattersOptions): Promise<
  Result<AcquiredInvoiceMatterLocks | null, HandlerError>
> => {
  const { tx } = options;
  if ("organizationId" in options) {
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
        return Result.err(
          new HandlerError({
            status: 409,
            code: "invoice_participation_changed",
            message: "Invoice matters changed; reload and try again",
          }),
        );
      }
      return Result.ok({
        type: "acquired",
        invoiceId: options.selection.invoiceId,
        workspaceIds,
      } as const);
    }
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
  } else {
    await lockSelectedMatters(tx, options);
  }
  return Result.ok(null);
};

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
  const snapshot = await readSelectedEntryScope(tx, condition);
  if (snapshot.length > LIMITS.timeEntriesPerWorkspace) {
    return refuse(
      new HandlerError({
        status: 409,
        message: "Time entry selection exceeds the matter limit",
      }),
    );
  }
  const ids = snapshot.map(({ id }) => id);
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
  await lockRunningEntryPrefix({ options, snapshot, invoiceMatters });
  const matterLocks = await lockRunningBillingMatters({
    options,
    snapshot,
    invoiceMatters,
    condition,
  });
  if (matterLocks.isErr()) {
    return refuse(matterLocks.error);
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
  const currentScope = await readSelectedEntryScope(tx, condition);
  const snapshotById = new Map(snapshot.map((row) => [row.id, row]));
  if (
    locked.length !== snapshot.length ||
    currentScope.length !== snapshot.length ||
    currentScope.some((row) => {
      const previous = snapshotById.get(row.id);
      return (
        previous === undefined ||
        previous.organizationId !== row.organizationId ||
        previous.workspaceId !== row.workspaceId ||
        previous.userId !== row.userId
      );
    })
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
      matterLocks.value ??
        panic("Invoice guard did not acquire its matter set"),
    );
  }
  return null;
}
