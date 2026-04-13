import { isWorkflowRunning } from "@/api/lib/workflow-queue";

export const readWorkflowHandler = async (workspaceId: string) => ({
  running: await isWorkflowRunning(workspaceId),
});
