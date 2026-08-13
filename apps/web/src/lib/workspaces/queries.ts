import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import {
  fetchWorkspaceNavigationPage,
  WORKSPACE_NAVIGATION_STATUS_SCOPE,
} from "@/lib/memory-api";
import type { WorkspaceNavigationItem } from "@/lib/memory-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import {
  type MatterActivityFilters,
  type WorkspaceActivityKey,
  workspacesKeys,
} from "@/lib/workspaces/queries.logic";

export {
  DEFAULT_MATTER_ACTIVITY_FILTERS,
  MATTER_ACTIVITY_ACTIONS,
  MATTER_ACTIVITY_CATEGORIES,
  type MatterActivityAction,
  type MatterActivityCategory,
  type MatterActivityFilters,
  workspacesKeys,
} from "@/lib/workspaces/queries.logic";

type WorkspaceActivityOptions = {
  activeOrganizationId: string;
  key: WorkspaceActivityKey;
};

const WORKSPACE_ACTIVITY_PAGE_SIZE = 3;
const MATTER_ACTIVITY_PAGE_SIZE = 15;
const MATTER_ACTIVITY_EXPORT_LIMIT = 10_000;
const MATTER_ACTIVITY_EXPORT_PAGE_SIZE = 50;
const MATTER_ACTIVITY_EXPORT_PAGE_LIMIT =
  Math.ceil(MATTER_ACTIVITY_EXPORT_LIMIT / MATTER_ACTIVITY_EXPORT_PAGE_SIZE) +
  1;

type ReadOverviewActivityOptions = {
  cursor?: string;
  filters: MatterActivityFilters;
  limit?: number;
  signal?: AbortSignal;
  workspaceId: string;
};

const readOverviewActivity = async ({
  cursor,
  filters,
  limit = MATTER_ACTIVITY_PAGE_SIZE,
  signal,
  workspaceId,
}: ReadOverviewActivityOptions) => {
  const response = await api.workspaces({ workspaceId }).overview.activity.get({
    ...(signal ? { fetch: { signal } } : {}),
    query: {
      action: filters.action,
      actorId: filters.actorId ?? undefined,
      category: filters.category,
      from: filters.from ?? undefined,
      limit,
      toExclusive: filters.toExclusive ?? undefined,
      ...(cursor ? { cursor } : {}),
    },
  });
  return unwrapEden(response);
};

export type MatterActivityItem = Awaited<
  ReturnType<typeof readOverviewActivity>
>["items"][number];

type CollectOverviewActivityOptions = {
  cursor?: string;
  filters: MatterActivityFilters;
  items: MatterActivityItem[];
  pageCount: number;
  workspaceId: string;
};

const collectOverviewActivity = async ({
  cursor,
  filters,
  items,
  pageCount,
  workspaceId,
}: CollectOverviewActivityOptions): Promise<
  { type: "complete"; items: MatterActivityItem[] } | { type: "tooLarge" }
> => {
  if (pageCount >= MATTER_ACTIVITY_EXPORT_PAGE_LIMIT) {
    return { type: "tooLarge" };
  }
  const page = await readOverviewActivity({
    cursor,
    filters,
    limit: MATTER_ACTIVITY_EXPORT_PAGE_SIZE,
    workspaceId,
  });
  if (items.length + page.items.length > MATTER_ACTIVITY_EXPORT_LIMIT) {
    return { type: "tooLarge" };
  }
  items.push(...page.items);
  if (page.nextCursor === null) {
    return { items, type: "complete" };
  }

  return await collectOverviewActivity({
    cursor: page.nextCursor,
    filters,
    items,
    pageCount: pageCount + 1,
    workspaceId,
  });
};

export const exportOverviewActivity = async ({
  filters,
  workspaceId,
}: {
  filters: MatterActivityFilters;
  workspaceId: string;
}) =>
  await collectOverviewActivity({
    filters,
    items: [],
    pageCount: 0,
    workspaceId,
  });

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

type WorkspaceNavigationData = {
  workspaces: WorkspaceNavigationItem[];
};

export const workspacesNavigationOptions = (activeOrganizationId: string) =>
  queryOptions({
    queryKey: workspacesKeys.navigation(activeOrganizationId),
    queryFn: async ({ signal }) => {
      const page = await fetchWorkspaceNavigationPage({
        signal,
        statusScope: WORKSPACE_NAVIGATION_STATUS_SCOPE.ACTIVE,
      });

      return { workspaces: page.workspaces } satisfies WorkspaceNavigationData;
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
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: workspacesKeys.activityAll(workspaceId),
    }),
    queryClient.invalidateQueries({
      queryKey: workspacesKeys.overviewActivityAll(workspaceId),
    }),
  ]);

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

export const overviewActivityOptions = ({
  activeOrganizationId,
  filters,
  workspaceId,
}: {
  activeOrganizationId: string;
  filters: MatterActivityFilters;
  workspaceId: string;
}) =>
  infiniteQueryOptions({
    queryKey: workspacesKeys.overviewActivity(
      activeOrganizationId,
      workspaceId,
      filters,
    ),
    queryFn: async ({ pageParam, signal }) =>
      await readOverviewActivity({
        ...(pageParam ? { cursor: pageParam } : {}),
        filters,
        signal,
        workspaceId,
      }),
    initialPageParam: stringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
