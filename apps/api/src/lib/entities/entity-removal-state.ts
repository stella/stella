import { Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  desktopEditSessions,
  documentProcessingRuns,
  expenses,
  folioCollabRooms,
  pdfSigningSessions,
  timeEntries,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS } from "@/api/lib/folio-collab-room-contract";

type EntityRemovalStateOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  entityIds: SafeId<"entity">[];
  operation: "delete" | "move";
};

export const validateEntityRemovalState = async ({
  tx,
  workspaceId,
  entityIds,
  operation,
}: EntityRemovalStateOptions): Promise<Result<void, HandlerError>> => {
  if (entityIds.length === 0) {
    return Result.ok(undefined);
  }
  const runningProcessing = await tx
    .select({ id: documentProcessingRuns.id })
    .from(documentProcessingRuns)
    .where(
      and(
        eq(documentProcessingRuns.workspaceId, workspaceId),
        inArray(documentProcessingRuns.entityId, entityIds),
        eq(documentProcessingRuns.status, "running"),
      ),
    )
    .limit(1);
  const inUse = () =>
    Result.err(
      new HandlerError({
        status: 409,
        code: "entity_transfer_source_in_use",
        retryable: true,
        message:
          "Wait for document processing, editing, collaboration, or signing to finish before moving",
      }),
    );
  // Deletion owns cancellation and stored-room cleanup; a transfer cannot
  // carry those states, so its stricter refusal is deliberately separate.
  if (operation === "delete") {
    return runningProcessing.at(0)
      ? Result.err(
          new HandlerError({
            status: 409,
            message: "Wait for document processing to finish before deleting",
          }),
        )
      : Result.ok(undefined);
  }
  if (runningProcessing.at(0)) {
    return inUse();
  }
  const desktop = await tx
    .select({ id: desktopEditSessions.id })
    .from(desktopEditSessions)
    .where(
      and(
        eq(desktopEditSessions.workspaceId, workspaceId),
        inArray(desktopEditSessions.entityId, entityIds),
        eq(desktopEditSessions.status, "open"),
      ),
    )
    .limit(1);
  if (desktop.at(0)) {
    return inUse();
  }
  const collaboration = await tx
    .select({ id: folioCollabRooms.id })
    .from(folioCollabRooms)
    .where(
      and(
        eq(folioCollabRooms.workspaceId, workspaceId),
        inArray(folioCollabRooms.entityId, entityIds),
        sql`${folioCollabRooms.lastActivityAt} > now() - (${FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS} * interval '1 millisecond')`,
      ),
    )
    .limit(1);
  if (collaboration.at(0)) {
    return inUse();
  }
  const signing = await tx
    .select({ id: pdfSigningSessions.id })
    .from(pdfSigningSessions)
    .where(
      and(
        eq(pdfSigningSessions.workspaceId, workspaceId),
        inArray(pdfSigningSessions.entityId, entityIds),
        eq(pdfSigningSessions.status, "open"),
      ),
    )
    .limit(1);
  if (signing.at(0)) {
    return inUse();
  }
  const time = await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        inArray(timeEntries.workItemId, entityIds),
      ),
    )
    .limit(1);
  const expense = await tx
    .select({ id: expenses.id })
    .from(expenses)
    .where(
      and(
        eq(expenses.workspaceId, workspaceId),
        inArray(expenses.matterId, entityIds),
      ),
    )
    .limit(1);
  if (time.at(0) || expense.at(0)) {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "entity_transfer_source_referenced",
        retryable: false,
        message:
          "Entities referenced by time entries or expenses cannot be moved",
      }),
    );
  }
  return Result.ok(undefined);
};
