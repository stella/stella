import { tasksQueryRoot } from "@/lib/resource-query-roots.logic";

export const taskKeys = {
  all: tasksQueryRoot,
  detail: (workspaceId: string, taskId: string) => [
    ...taskKeys.all(workspaceId),
    taskId,
  ],
};
