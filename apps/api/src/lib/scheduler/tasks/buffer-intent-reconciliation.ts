import { Result, panic } from "better-result";
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import {
  BUFFER_INTENT_STALE_MS,
  reconcileStaleBufferIntents,
} from "@/api/lib/buffer-intent-reconciliation";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const RECONCILE_BUFFER_INTENTS_TASK =
  "entityBuffers.reconcileIntents" as const;

const RECONCILE_SCOPE_LIMIT = 50;

type StaleIntentScope = {
  organizationId: SafeId<"organization">;
  purpose: "entity_create" | "entity_version";
  workspaceId: SafeId<"workspace">;
};

const rootSafeDb: SafeDb = async (run) =>
  await Result.tryPromise(async () => await rootDb.transaction(run));

/**
 * Independently drain abandoned server-generated file intents. Request-path
 * reconciliation remains a fast recovery path, while this scheduled sweep
 * guarantees that a workspace never needs another write to reclaim orphaned
 * final-key S3 objects after a hard process death.
 */
export const reconcileBufferIntents: SchedulerTask = async ({
  logger,
  signal,
}) => {
  const timeoutSeconds = Math.floor(BUFFER_INTENT_STALE_MS / 1000);
  const scopes = await rootDb.execute<StaleIntentScope>(sql`
    SELECT DISTINCT
      organization_id AS "organizationId",
      workspace_id AS "workspaceId",
      purpose
    FROM pending_uploads
    WHERE purpose IN ('entity_create', 'entity_version')
      AND purpose_data->>'reservedFileId' IS NOT NULL
      AND status = 'scanning'
      AND claimed_at < NOW() - ${timeoutSeconds} * interval '1 second'
    ORDER BY organization_id, workspace_id, purpose
    LIMIT ${RECONCILE_SCOPE_LIMIT}
  `);

  const reconcileScope = async (index: number): Promise<number> => {
    const scope = scopes[index];
    if (!scope) {
      return index;
    }
    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    await reconcileStaleBufferIntents({
      safeDb: rootSafeDb,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      purpose: scope.purpose,
    });
    return await reconcileScope(index + 1);
  };

  const reconciledScopes = await reconcileScope(0);

  logger.info("scheduler.buffer_intents_reconciled", {
    "bufferIntents.scopes": reconciledScopes,
  });
};
