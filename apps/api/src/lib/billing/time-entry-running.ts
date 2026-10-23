import { panic } from "better-result";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { timeEntries, timeEntryTimerStates, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockMatterStewardship,
  lockTimerOwnerIdentities,
} from "@/api/lib/db/aggregate-lock";
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

type GuardRunningTimeEntriesOptions = {
  tx: Pick<PgAsyncDatabase<PgQueryResultHKT>, "select" | "execute">;
  actorUserId: SafeId<"user">;
} & (
  | {
      workspaceId: SafeId<"workspace">;
      selection:
        | { type: "entries"; ids: SafeId<"timeEntry">[] }
        | { type: "invoice"; invoiceId: SafeId<"invoice"> }
        | { type: "none" };
    }
  | {
      organizationId: SafeId<"organization">;
      selection: { type: "approval_batch"; ids: SafeId<"timeEntry">[] };
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
        return eq(timeEntries.invoiceId, selection.invoiceId);
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
    .select({
      id: timeEntries.id,
      organizationId: timeEntries.organizationId,
      workspaceId: timeEntries.workspaceId,
      userId: timeEntries.userId,
    })
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
  const scopedMatter =
    "workspaceId" in options
      ? (
          await tx
            .select({ organizationId: workspaces.organizationId })
            .from(workspaces)
            .where(eq(workspaces.id, options.workspaceId))
            .limit(1)
        ).at(0)
      : undefined;
  const rowsByOrganization = Map.groupBy(snapshot, (row) => row.organizationId);
  if (scopedMatter && !rowsByOrganization.has(scopedMatter.organizationId)) {
    rowsByOrganization.set(scopedMatter.organizationId, []);
  }
  await lockMatterStewardship({
    tx,
    requests: [...rowsByOrganization].map(([organizationId, rows]) => ({
      organizationId,
      workspaceIds: [
        ...new Set([
          ...(scopedMatter?.organizationId === organizationId &&
          "workspaceId" in options
            ? [options.workspaceId]
            : []),
          ...rows.flatMap((row) => (row.workspaceId ? [row.workspaceId] : [])),
        ]),
      ],
      userIds: [
        ...new Set([
          actorUserId,
          ...rows.flatMap((row) => (row.userId ? [row.userId] : [])),
        ]),
      ],
    })),
    mode: "update",
  });
  // Lock the discovered owner identities, never a changed owner read below the
  // prefix. The locked row comparison rejects any changed scope for a retry.
  await lockTimerOwnerIdentities({
    tx,
    owners: snapshot.flatMap((row) =>
      row.userId
        ? [
            {
              organizationId: row.organizationId,
              userId: brandPersistedUserId(row.userId),
            },
          ]
        : [],
    ),
  });
  const locked = await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(condition)
    .orderBy(asc(timeEntries.id))
    .limit(LIMITS.timeEntriesPerWorkspace + 1)
    .for("update");
  const currentScope = await tx
    .select({
      id: timeEntries.id,
      organizationId: timeEntries.organizationId,
      workspaceId: timeEntries.workspaceId,
      userId: timeEntries.userId,
    })
    .from(timeEntries)
    .where(condition)
    .limit(LIMITS.timeEntriesPerWorkspace + 1);
  const snapshotById = new Map(snapshot.map((row) => [row.id, row]));
  if (
    locked.length !== snapshot.length ||
    currentScope.some((row) => {
      const previous = snapshotById.get(row.id);
      return (
        !previous ||
        previous.organizationId !== row.organizationId ||
        previous.workspaceId !== row.workspaceId ||
        previous.userId !== row.userId
      );
    })
  ) {
    return new HandlerError({
      status: 409,
      code: "time_entry_selection_changed",
      message: "Time entry selection changed; reload and try again",
    });
  }
  // Approval batches report running refusals per row under these same locks.
  if ("organizationId" in options) {
    return null;
  }
  const [blocked] = await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, options.workspaceId),
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
