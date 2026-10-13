import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import {
  assertCallerOrg,
  proveOrgScope,
  withOrgScope,
} from "@/api/db/org-scope";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import {
  entities,
  flowDefinitions,
  flowUploadTriggerIntents,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { readBounded } from "@/api/lib/db/read-bounded";
import { mutateRecoveryReceipt } from "@/api/lib/db/recovery-bookkeeping/receipts";
import { errorTag } from "@/api/lib/errors/utils";
import {
  deriveFileExtension,
  fileUploadTriggerMatches,
} from "@/api/lib/flows/flow-trigger-logic";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import { recoverUploadFlowTriggerIntents } from "@/api/lib/scheduler/tasks/upload-flow-trigger-recovery";

export type MaybeStartUploadTriggeredFlowsArgs = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  fileName: string;
};

/** Called inside the document creation transaction; admission never drops a receipt. */
export const recordUploadTriggeredFlowIntents = async (
  tx: Transaction,
  {
    entityId,
    workspaceId,
    organizationId,
    fileName,
  }: MaybeStartUploadTriggeredFlowsArgs,
): Promise<void> => {
  const scope = await proveOrgScope(tx, {
    table: "entities",
    where: sql`${and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId))}`,
  });
  if (scope.isErr() || assertCallerOrg(scope.value, organizationId).isErr()) {
    return;
  }
  const definitions = await readBounded(
    tx
      .select({ id: flowDefinitions.id, trigger: flowDefinitions.trigger })
      .from(flowDefinitions)
      .where(
        and(
          eq(flowDefinitions.organizationId, organizationId),
          eq(flowDefinitions.enabled, true),
        ),
      ),
    LIMITS.flowDefinitionsCount,
  );
  if (definitions.type === "overflow") {
    panic("Organization flow definitions exceeded their admission cap");
  }
  const extension = deriveFileExtension(fileName);
  const matching = definitions.rows.filter(
    ({ trigger }) =>
      trigger.type === "file-upload" &&
      fileUploadTriggerMatches({ trigger, workspaceId, extension }),
  );
  if (matching.length === 0) {
    return;
  }
  await withOrgScope({
    tx,
    scope: scope.value,
    actor: { type: "system" },
    fn: async (scopedTx) => {
      await mutateRecoveryReceipt({
        type: "create-upload",
        tx: scopedTx,
        table: flowUploadTriggerIntents,
        rows: matching.map(({ id }) => ({
          definitionId: id,
          entityId,
          workspaceId,
          organizationId: scope.value.organizationId,
          fileExtension: extension,
        })),
      });
    },
  });
};

/** Best-effort prompt dispatch; the scheduler owns recovery after crashes or revocation. */
export const maybeStartUploadTriggeredFlows = async ({
  entityId,
  workspaceId,
  organizationId,
}: MaybeStartUploadTriggeredFlowsArgs): Promise<void> => {
  const dispatched = await Result.tryPromise(async () => {
    const admitted = await withAggregateTransaction(rootDb, async (tx) => {
      const scope = await proveOrgScope(tx, {
        table: "entities",
        where: sql`${and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId))}`,
      });
      return (
        scope.isOk() && assertCallerOrg(scope.value, organizationId).isOk()
      );
    });
    if (!admitted) {
      return;
    }
    await recoverUploadFlowTriggerIntents({
      database: rootDb,
      now: new Date(),
      entityId,
    });
  });
  if (Result.isError(dispatched)) {
    captureError(dispatched.error, { entityId, workspaceId });
    logger.error("flow.upload_trigger_dispatch_failed", {
      entityId,
      workspaceId,
      "error.type": errorTag(dispatched.error),
    });
  }
};
