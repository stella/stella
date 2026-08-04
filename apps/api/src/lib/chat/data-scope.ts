import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

type ExpandThreadDataScopeInput = {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  newWorkspaceIds: readonly SafeId<"workspace">[];
  recordAuditEvent: AuditRecorder;
  threadWorkspaceId: SafeId<"workspace"> | null;
};

type ExpandThreadDataScopeResult = Result<SafeId<"workspace">[], SafeDbError>;

type ExpandThreadDataScopeOnTxInput = Omit<
  ExpandThreadDataScopeInput,
  "safeDb"
> & { tx: Transaction };

type ReplaceThreadDataScopeOnTxInput = {
  newDataWorkspaceIds: readonly SafeId<"workspace">[];
  observedDataWorkspaceIds: readonly SafeId<"workspace">[];
  recordAuditEvent: AuditRecorder;
  threadId: SafeId<"chatThread">;
  threadWorkspaceId: SafeId<"workspace"> | null;
  tx: Transaction;
};

const lockThreadDataScopeOnTx = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<SafeId<"workspace">[]> => {
  const lockedThread = (
    await tx
      .select({ dataWorkspaceIds: chatThreads.dataWorkspaceIds })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1)
      .for("update")
  ).at(0);
  if (lockedThread === undefined) {
    return panic("Cannot update data scope for a missing chat thread");
  }
  return lockedThread.dataWorkspaceIds;
};

const appendMissingWorkspaceIds = ({
  additions,
  base,
}: {
  additions: readonly SafeId<"workspace">[];
  base: readonly SafeId<"workspace">[];
}): SafeId<"workspace">[] => {
  const result = [...base];
  const ids = new Set<SafeId<"workspace">>(result);
  for (const workspaceId of additions) {
    if (ids.has(workspaceId)) {
      continue;
    }
    ids.add(workspaceId);
    result.push(workspaceId);
  }
  return result;
};

const workspaceIdsEqual = (
  left: readonly SafeId<"workspace">[],
  right: readonly SafeId<"workspace">[],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const leftIds = new Set(left);
  return right.every((candidateId) => leftIds.has(candidateId));
};

const updateThreadDataScopeOnTx = async ({
  lockedDataWorkspaceIds,
  newDataWorkspaceIds,
  recordAuditEvent,
  threadId,
  threadWorkspaceId,
  tx,
}: {
  lockedDataWorkspaceIds: readonly SafeId<"workspace">[];
  newDataWorkspaceIds: readonly SafeId<"workspace">[];
  recordAuditEvent: AuditRecorder;
  threadId: SafeId<"chatThread">;
  threadWorkspaceId: SafeId<"workspace"> | null;
  tx: Transaction;
}): Promise<SafeId<"workspace">[]> => {
  if (workspaceIdsEqual(lockedDataWorkspaceIds, newDataWorkspaceIds)) {
    return [...lockedDataWorkspaceIds];
  }

  const updatedThread = (
    await tx
      .update(chatThreads)
      .set({ dataWorkspaceIds: [...newDataWorkspaceIds] })
      .where(eq(chatThreads.id, threadId))
      .returning({ dataWorkspaceIds: chatThreads.dataWorkspaceIds })
  ).at(0);
  if (updatedThread === undefined) {
    return panic("Locked chat thread disappeared while updating data scope");
  }

  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
    resourceId: threadId,
    workspaceId: threadWorkspaceId,
    changes: {
      dataWorkspaceIds: {
        old: [...lockedDataWorkspaceIds],
        new: [...updatedThread.dataWorkspaceIds],
      },
    },
  });

  return [...updatedThread.dataWorkspaceIds];
};

// Atomically widens a chat thread's `data_workspace_ids`. The row lock makes
// concurrent writers observe and extend the same authoritative scope.
export const expandThreadDataScopeOnTx = async ({
  threadId,
  newWorkspaceIds,
  recordAuditEvent,
  threadWorkspaceId,
  tx,
}: ExpandThreadDataScopeOnTxInput): Promise<SafeId<"workspace">[]> => {
  // The caller may have loaded the thread before another transaction widened
  // it. Locking first gives the audit transition and return value one source
  // of truth: the row this transaction will actually update.
  const lockedDataWorkspaceIds = await lockThreadDataScopeOnTx({
    threadId,
    tx,
  });
  return await updateThreadDataScopeOnTx({
    lockedDataWorkspaceIds,
    newDataWorkspaceIds: appendMissingWorkspaceIds({
      additions: newWorkspaceIds,
      base: lockedDataWorkspaceIds,
    }),
    recordAuditEvent,
    threadId,
    threadWorkspaceId,
    tx,
  });
};

/**
 * Replaces a replay's retained-message scope without erasing workspaces a
 * concurrent writer added after the replay read its thread snapshot. The
 * audit transition always comes from the locked row, never that snapshot.
 */
export const replaceThreadDataScopeOnTx = async ({
  newDataWorkspaceIds,
  observedDataWorkspaceIds,
  recordAuditEvent,
  threadId,
  threadWorkspaceId,
  tx,
}: ReplaceThreadDataScopeOnTxInput): Promise<SafeId<"workspace">[]> => {
  const lockedDataWorkspaceIds = await lockThreadDataScopeOnTx({
    threadId,
    tx,
  });
  const observedIds = new Set(observedDataWorkspaceIds);
  const concurrentAdditions = lockedDataWorkspaceIds.filter(
    (candidateId) => !observedIds.has(candidateId),
  );

  return await updateThreadDataScopeOnTx({
    lockedDataWorkspaceIds,
    newDataWorkspaceIds: appendMissingWorkspaceIds({
      additions: concurrentAdditions,
      base: newDataWorkspaceIds,
    }),
    recordAuditEvent,
    threadId,
    threadWorkspaceId,
    tx,
  });
};

export const expandThreadDataScope = async ({
  safeDb,
  threadId,
  newWorkspaceIds,
  recordAuditEvent,
  threadWorkspaceId,
}: ExpandThreadDataScopeInput): Promise<ExpandThreadDataScopeResult> => {
  const updateResult = await safeDb(
    async (tx) =>
      await expandThreadDataScopeOnTx({
        newWorkspaceIds,
        recordAuditEvent,
        threadId,
        threadWorkspaceId,
        tx,
      }),
  );

  if (Result.isError(updateResult)) {
    return Result.err(updateResult.error);
  }
  return Result.ok(updateResult.value);
};
