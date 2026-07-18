import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { flowDefinitions } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { errorTag } from "@/api/lib/errors/utils";
import {
  deriveFileExtension,
  fileUploadTriggerMatches,
} from "@/api/lib/flows/flow-trigger-logic";
import { startAutomatedFlowRun } from "@/api/lib/flows/start-automated-flow-run";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

/**
 * File-upload automation trigger. Invoked fire-and-forget from the USER upload
 * handlers right after a new document entity is created (the same layer that
 * kicks `processExtraction`), it starts any enabled flow whose `file-upload`
 * trigger matches the workspace + extension.
 *
 * STRUCTURAL LOOP GUARD: this hook is wired ONLY into user-facing upload
 * handlers. Documents produced by the `create-document` flow step are written
 * through `createEntityFromBuffer` (see `flow-executor.ts`), which never calls
 * this hook, so a flow-created document can never re-enter and spawn another
 * run. The guard is call-site separation, not a runtime flag.
 *
 * EXTRACTION RACE: an `ai` step with `includeDocuments` reads
 * `extractedContent`, which `processExtraction` populates asynchronously after
 * the same upload. Step 0 is therefore enqueued with a fixed
 * `FLOW_UPLOAD_TRIGGER_DELAY_MS` delay so extraction usually finishes first.
 * This is a pragmatic best-effort, not a completion-event guarantee: a very
 * large or slow document may still miss its content on the first step. Deferring
 * only the first step keeps later steps prompt.
 *
 * Never throws and never blocks or fails the upload: DB failures are captured
 * through the structured logger; per-definition skips / errors are handled by
 * `startAutomatedFlowRun`.
 */
export const FLOW_UPLOAD_TRIGGER_DELAY_MS = 30_000;

export type MaybeStartUploadTriggeredFlowsArgs = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  fileName: string;
};

export const maybeStartUploadTriggeredFlows = async ({
  entityId,
  workspaceId,
  organizationId,
  fileName,
}: MaybeStartUploadTriggeredFlowsArgs): Promise<void> => {
  const definitionsResult = await Result.tryPromise({
    try: () =>
      rootDb
        .select({
          id: flowDefinitions.id,
          trigger: flowDefinitions.trigger,
          createdByUserId: flowDefinitions.createdByUserId,
        })
        .from(flowDefinitions)
        .where(
          and(
            eq(flowDefinitions.organizationId, organizationId),
            eq(flowDefinitions.enabled, true),
            sql`${flowDefinitions.trigger}->>'type' = 'file-upload'`,
          ),
        )
        .limit(LIMITS.flowDefinitionsCount),
    catch: (cause) => cause,
  });

  if (Result.isError(definitionsResult)) {
    captureError(definitionsResult.error, { entityId, workspaceId });
    logger.error("flow.upload_trigger_scan_failed", {
      entityId,
      workspaceId,
      "error.type": errorTag(definitionsResult.error),
    });
    return;
  }

  const extension = deriveFileExtension(fileName);

  for (const definition of definitionsResult.value) {
    if (definition.trigger.type !== "file-upload") {
      continue;
    }
    if (
      !fileUploadTriggerMatches({
        trigger: definition.trigger,
        workspaceId,
        extension,
      })
    ) {
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- sequential starts bound concurrent run inserts; the set is capped at LIMITS.flowDefinitionsCount and each start is independent
    await startAutomatedFlowRun({
      definitionId: definition.id,
      organizationId,
      workspaceId,
      createdByUserId: definition.createdByUserId,
      triggerSource: { type: "file-upload", entityId },
      inputEntityIds: [entityId],
      enqueueDelayMs: FLOW_UPLOAD_TRIGGER_DELAY_MS,
      logContext: {
        definitionId: definition.id,
        workspaceId,
        trigger: "file-upload",
      },
    });
  }
};
