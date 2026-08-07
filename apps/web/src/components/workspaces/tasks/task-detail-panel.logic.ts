import type { TaskStatus } from "@stll/api-contract";

type TaskDetailIdentity = {
  workspaceId: string;
  taskId: string;
};

export const getTaskDetailInstanceKey = ({
  workspaceId,
  taskId,
}: TaskDetailIdentity) => `${workspaceId}:${taskId}`;

export const getTaskStatusUpdate = (
  taskId: string,
  status: TaskStatus,
  workflowReason: string,
) => {
  const reason = workflowReason.trim();
  return {
    taskId,
    status,
    ...(status === "cancelled" && reason ? { workflowReason: reason } : {}),
  };
};
