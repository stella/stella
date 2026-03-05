import { getWorkflowActorConfig } from "@stella/rivet/actors/workflow-actor-config";

import { rivet } from "@/api/handlers/registry";
import type { SafeId } from "@/api/lib/branded-types";

type ReadWorkflowHandlerProps = {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  authToken: string;
};

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
  const workflowStatus = await workflowActor.getWorkflowStatus();

  return workflowStatus;
};
