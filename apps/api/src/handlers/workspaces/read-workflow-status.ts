import { getWorkflowActorConfig } from "@stella/rivet/actors/workflow-actor-config";
import { withTimeout } from "@stella/rivet/timeout";

import { rivet } from "@/api/handlers/registry";
import type { SafeId } from "@/api/lib/branded-types";

type ReadWorkflowHandlerProps = {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  authToken: string;
};

const WORKFLOW_STATUS_TIMEOUT_MS = 10_000;

export const readWorkflowHandler = async ({
  workspaceId,
  organizationId,
  authToken,
}: ReadWorkflowHandlerProps) => {
  const workflowActorConfig = getWorkflowActorConfig({
    type: "vanilla",
    authToken,
    organizationId,
    workspaceId,
  });

  const workflowActor = rivet.workflow.getOrCreate(...workflowActorConfig);
  const workflowStatus = await withTimeout({
    timeoutMs: WORKFLOW_STATUS_TIMEOUT_MS,
    timeoutMessage: "Workflow actor timed out",
    run: async () => await workflowActor.getWorkflowStatus(),
  });

  return workflowStatus;
};
