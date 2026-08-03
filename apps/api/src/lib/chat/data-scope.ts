import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

type ExpandThreadDataScopeInput = {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  currentDataWorkspaceIds: readonly SafeId<"workspace">[];
  newWorkspaceIds: readonly SafeId<"workspace">[];
  recordAuditEvent: AuditRecorder;
  threadWorkspaceId: SafeId<"workspace"> | null;
};

type ExpandThreadDataScopeResult = Result<SafeId<"workspace">[], SafeDbError>;

type ExpandThreadDataScopeOnTxInput = Omit<
  ExpandThreadDataScopeInput,
  "safeDb"
> & { tx: Transaction };

// Atomically widens a chat thread's `data_workspace_ids`; SQL appends and
// deduplicates so concurrent message persistence cannot lose an entry.
export const expandThreadDataScopeOnTx = async ({
  threadId,
  currentDataWorkspaceIds,
  newWorkspaceIds,
  recordAuditEvent,
  threadWorkspaceId,
  tx,
}: ExpandThreadDataScopeOnTxInput): Promise<SafeId<"workspace">[]> => {
  if (newWorkspaceIds.length === 0) {
    return [...currentDataWorkspaceIds];
  }
  const currentSet = new Set<SafeId<"workspace">>(currentDataWorkspaceIds);
  const additions = newWorkspaceIds.filter((id) => !currentSet.has(id));
  if (additions.length === 0) {
    return [...currentDataWorkspaceIds];
  }
  const additionsArray = sql`ARRAY[${sql.join(
    additions.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;

  await tx
    .update(chatThreads)
    .set({
      dataWorkspaceIds: sql`(
        SELECT ARRAY(
          SELECT DISTINCT unnest(
            ${chatThreads.dataWorkspaceIds} || ${additionsArray}
          )
        )
      )`,
    })
    .where(eq(chatThreads.id, threadId));

  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
    resourceId: threadId,
    workspaceId: threadWorkspaceId,
    changes: {
      dataWorkspaceIds: {
        old: [...currentDataWorkspaceIds],
        new: [...currentSet, ...additions],
      },
    },
  });

  return [...currentSet, ...additions];
};

export const expandThreadDataScope = async ({
  safeDb,
  threadId,
  currentDataWorkspaceIds,
  newWorkspaceIds,
  recordAuditEvent,
  threadWorkspaceId,
}: ExpandThreadDataScopeInput): Promise<ExpandThreadDataScopeResult> => {
  const updateResult = await safeDb(
    async (tx) =>
      await expandThreadDataScopeOnTx({
        currentDataWorkspaceIds,
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
