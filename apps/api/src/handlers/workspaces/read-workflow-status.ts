import { Result } from "better-result";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { isWorkflowRunning } from "@/api/lib/workflow-queue";

export const readWorkflowHandler = async (
  workspaceId: SafeId<"workspace">,
) => ({
  running: await isWorkflowRunning(workspaceId),
});

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  access: "read",
} satisfies HandlerConfig;

const readWorkflow = createSafeHandler(
  config,
  async function* ({ workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(async () => await readWorkflowHandler(workspaceId)),
    );

    return Result.ok(response);
  },
);

export default readWorkflow;
