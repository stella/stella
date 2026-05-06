import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

export const workspacesKeys = {
  all: ["workspaces"],
  list: (activeOrganizationId: string) => [
    ...workspacesKeys.all,
    activeOrganizationId,
  ],
  navigation: () => [...workspacesKeys.all, "navigation"],
  byId: (workspaceId: string) => [...workspacesKeys.all, workspaceId],
  overview: (workspaceId: string) => [
    ...workspacesKeys.byId(workspaceId),
    "overview",
  ],
};

const readWorkspaces = async (signal?: AbortSignal) => {
  const response = await api.workspaces.get(
    signal ? { fetch: { signal } } : {},
  );

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data;
};

export type WorkspacesData = Awaited<ReturnType<typeof readWorkspaces>>;

export const workspacesOptions = (activeOrganizationId: string) =>
  queryOptions({
    queryKey: workspacesKeys.list(activeOrganizationId),
    queryFn: async ({ signal }) => await readWorkspaces(signal),
    staleTime: 0,
    refetchOnMount: "always",
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
