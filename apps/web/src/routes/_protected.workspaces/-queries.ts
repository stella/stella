import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

export const workspacesKeys = {
  all: ["workspaces"],
  navigation: () => [...workspacesKeys.all, "navigation"],
  byId: (workspaceId: string) => [...workspacesKeys.all, workspaceId],
  overview: (workspaceId: string) => [
    ...workspacesKeys.byId(workspaceId),
    "overview",
  ],
};

export const workspacesOptions = queryOptions({
  queryKey: workspacesKeys.all,
  queryFn: async ({ signal }) => {
    const response = await api.workspaces.get({ fetch: { signal } });

    if (response.error) {
      throw toAPIError(response.error);
    }

    return response.data;
  },
});

export const workspacesNavigationOptions = queryOptions({
  queryKey: workspacesKeys.navigation(),
  queryFn: async ({ signal }) => {
    const response = await api.workspaces.navigation.get({
      fetch: { signal },
    });

    if (response.error) {
      throw toAPIError(response.error);
    }

    return response.data;
  },
});

export const workspaceOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: workspacesKeys.byId(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });

export const overviewOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: workspacesKeys.overview(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .overview.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
