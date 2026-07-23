import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { extractionRuns } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { isWorkflowRunning } from "@/api/lib/workflow-queue";

type ReadWorkflowHandlerOptions = {
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  readRunningState?: typeof isWorkflowRunning;
};

export const readWorkflowHandler = async ({
  organizationId,
  scopedDb,
  workspaceId,
  readRunningState = isWorkflowRunning,
}: ReadWorkflowHandlerOptions) => {
  const [running, latestRun] = await Promise.all([
    readRunningState(workspaceId),
    scopedDb(async (tx) => {
      const [run] = await tx
        .select({
          completed: extractionRuns.completed,
          errorCode: extractionRuns.errorCode,
          executionVersion: extractionRuns.executionVersion,
          finishedAt: extractionRuns.finishedAt,
          id: extractionRuns.id,
          scope: extractionRuns.scope,
          startedAt: extractionRuns.startedAt,
          status: extractionRuns.status,
          total: extractionRuns.total,
        })
        .from(extractionRuns)
        .where(
          and(
            eq(extractionRuns.organizationId, organizationId),
            eq(extractionRuns.workspaceId, workspaceId),
          ),
        )
        .orderBy(desc(extractionRuns.createdAt), desc(extractionRuns.id))
        .limit(1);
      return run ?? null;
    }),
  ]);

  return { running, run: latestRun };
};

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  access: "read",
} satisfies HandlerConfig;

const readWorkflow = createSafeHandler(
  config,
  async function* ({ scopedDb, session, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readWorkflowHandler({
            organizationId: session.activeOrganizationId,
            scopedDb,
            workspaceId,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export default readWorkflow;
