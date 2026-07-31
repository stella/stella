import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import {
  type WorkspaceActivityKey,
  workspacesKeys,
} from "@/routes/_protected.workspaces/-queries.logic";

export { workspacesKeys } from "@/routes/_protected.workspaces/-queries.logic";

type WorkspaceActivityOptions = {
  activeOrganizationId: string;
  key: WorkspaceActivityKey;
};

const WORKSPACE_ACTIVITY_PAGE_SIZE = 3;

const getInitialWorkspaceActivityCursor = (): string | undefined => undefined;

const readWorkspaces = async (signal?: AbortSignal) => {
  const response = await api.workspaces.get(
    signal ? { fetch: { signal } } : {},
  );

  return unwrapEden(response);
};

export type WorkspacesData = Awaited<ReturnType<typeof readWorkspaces>>;

export const workspacesOptions = (activeOrganizationId: string) =>
  queryOptions({
    queryKey: workspacesKeys.list(activeOrganizationId),
    queryFn: async ({ signal }) => await readWorkspaces(signal),
    staleTime: 0,
    refetchOnMount: "always",
  });

export const workspacesRouteOptions = (activeOrganizationId: string) =>
  queryOptions({
    queryKey: workspacesKeys.list(activeOrganizationId),
    queryFn: async ({ signal }) => await readWorkspaces(signal),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export const workspacesNavigationOptions = (activeOrganizationId: string) =>
  queryOptions({
    queryKey: workspacesKeys.navigation(activeOrganizationId),
    queryFn: async ({ signal }) => {
      const response = await api.workspaces.navigation.get({
        fetch: { signal },
      });

      return unwrapEden(response);
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export const workspaceOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: workspacesKeys.byId(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .get({ fetch: { signal } });

      return unwrapEden(response);
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export const workspaceActivityOptions = ({
  activeOrganizationId,
  key,
}: WorkspaceActivityOptions) =>
  infiniteQueryOptions({
    queryKey: workspacesKeys.activity(activeOrganizationId, key),
    queryFn: async ({ pageParam, signal }) => {
      const query =
        pageParam === undefined
          ? { limit: WORKSPACE_ACTIVITY_PAGE_SIZE }
          : { cursor: pageParam, limit: WORKSPACE_ACTIVITY_PAGE_SIZE };
      const response = await api
        .workspaces({ workspaceId: key.workspaceId })
        .activity.get({
          fetch: { signal },
          query,
        });

      return unwrapEden(response);
    },
    initialPageParam: getInitialWorkspaceActivityCursor(),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export const invalidateWorkspaceActivity = async (
  queryClient: QueryClient,
  workspaceId: string,
) =>
  await queryClient.invalidateQueries({
    queryKey: workspacesKeys.activityAll(workspaceId),
  });

export const overviewOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: workspacesKeys.overview(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .overview.get({ fetch: { signal } });

      return unwrapEden(response);
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
