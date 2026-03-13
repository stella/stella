import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

export const taskKeys = {
  all: (workspaceId: string) => ["tasks", workspaceId] as const,
  detail: (workspaceId: string, taskId: string) =>
    ["tasks", workspaceId, taskId] as const,
  links: (workspaceId: string, entityId: string) =>
    ["tasks", workspaceId, entityId, "links"] as const,
};

const getTaskEndpoint = (workspaceId: string, taskId: string) =>
  api.tasks({ workspaceId })({ taskId });

export type TaskDetailAssignee = {
  user: {
    id: string;
    name: string | null;
    image: string | null;
  };
};

export type TaskDetailChild = {
  id: string;
  name: string | null;
  status: string | null;
  priority: string | null;
  dueDate: string | null;
  sortOrder: string | null;
  createdAt: Date;
};

export type TaskDetailLink = {
  targetEntity: {
    id: string;
    name: string | null;
    kind: string;
  };
};

export type TaskDetailLinkReverse = {
  sourceEntity: {
    id: string;
    name: string | null;
    kind: string;
  };
};

export type TaskDetail = {
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
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return response.data as TaskDetail;
    },
    enabled: !!taskId,
  });

export const taskLinksOptions = (workspaceId: string, entityId: string) =>
  queryOptions({
    queryKey: taskKeys.links(workspaceId, entityId),
    queryFn: async ({ signal }) => {
      const endpoint = getTaskEndpoint(workspaceId, entityId);
      const response = await endpoint.links.get({
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    enabled: !!entityId,
  });
