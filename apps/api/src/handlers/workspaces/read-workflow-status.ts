import type { SafeId } from "@/api/lib/branded-types";
import { isWorkflowRunning } from "@/api/lib/workflow-queue";

export const readWorkflowHandler = async (
  workspaceId: SafeId<"workspace">,
) => ({
  running: await isWorkflowRunning(workspaceId),
});
