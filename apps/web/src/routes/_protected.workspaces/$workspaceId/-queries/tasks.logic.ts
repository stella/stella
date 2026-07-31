export const taskKeys = {
  all: (workspaceId: string) => ["tasks", workspaceId],
  detail: (workspaceId: string, taskId: string) => [
    ...taskKeys.all(workspaceId),
    taskId,
  ],
};
