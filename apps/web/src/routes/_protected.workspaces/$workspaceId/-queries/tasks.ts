import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

export const taskKeys = {
  all: (workspaceId: string) => ["tasks", workspaceId] as const,
  detail: (workspaceId: string, taskId: string) =>
    ["tasks", workspaceId, taskId] as const,
};

const getTaskEndpoint = (workspaceId: string, taskId: string) =>
  api.tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })({
    taskId: toSafeId<"entity">(taskId),
  });

type TaskDetailAssignee = {
  user: {
    id: string;
    name: string | null;
    image: string | null;
  };
};

type TaskDetailChild = {
  id: string;
  name: string | null;
  status: string | null;
  priority: string | null;
  dueDate: string | null;
  sortOrder: string | null;
  createdAt: Date;
};

type TaskDetailLink = {
  targetEntity: {
    id: string;
    name: string | null;
    kind: string;
  };
};

type TaskDetailLinkReverse = {
  sourceEntity: {
    id: string;
    name: string | null;
    kind: string;
  };
};

type TaskDetail = {
  id: string;
  name: string | null;
  kind: string;
  status: string | null;
  priority: string | null;
  dueDate: string | null;
  sortOrder: string | null;
  createdAt: Date;
  assignees: TaskDetailAssignee[];
  children: TaskDetailChild[];
  linksAsSource: TaskDetailLink[];
  linksAsTarget: TaskDetailLinkReverse[];
};

export const taskDetailOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: taskKeys.detail(workspaceId, taskId),
    queryFn: async ({ signal }) => {
      const endpoint = getTaskEndpoint(workspaceId, taskId);
      const response = await endpoint.get({
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
      return response.data as TaskDetail;
    },
    enabled: !!taskId,
  });
