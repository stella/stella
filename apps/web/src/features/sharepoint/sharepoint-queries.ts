import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { Result } from "better-result";

import { SHAREPOINT_ROOT_ITEM_ID } from "@stll/api-contract/sharepoint";

import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError, unwrapApiResponse } from "@/lib/errors/api";
import { readQueryResult } from "@/lib/errors/query-result";
import { stringCursorSeed } from "@/lib/infinite-query";
import { prefetchRouteQuery } from "@/lib/react-query";

import {
  SHAREPOINT_ACCESS,
  type SharepointAccess,
  sharepointAccessFromRefusal,
} from "./sharepoint-access.logic";

/** The member whose delegated Microsoft grant answers every read here. */
export type SharepointViewer = { organizationId: string; userId: string };

// Every read is answered with the signed-in member's own Microsoft grant, so
// each key names that member.
export const sharepointKeys = {
  root: () => ["sharepoint"] as const,
  viewer: ({ organizationId, userId }: SharepointViewer) =>
    [...sharepointKeys.root(), organizationId, userId] as const,
  connection: ({ organizationId, userId }: SharepointViewer) =>
    [
      ...sharepointKeys.viewer({ organizationId, userId }),
      "connection",
    ] as const,
  browse: ({ organizationId, userId }: SharepointViewer) =>
    [...sharepointKeys.viewer({ organizationId, userId }), "browse"] as const,
};

type ReadConnectionFn = typeof api.sharepoint.connection.get;

export type SharepointConnection = NonNullable<
  NonNullable<Awaited<ReturnType<ReadConnectionFn>>["data"]>["connection"]
>;

/** Whether SharePoint is offered, allowed, and connected for this member. */
export const sharepointAccessOptions = ({
  organizationId,
  userId,
}: SharepointViewer) =>
  queryOptions({
    queryKey: sharepointKeys.connection({ organizationId, userId }),
    queryFn: async ({ signal }): Promise<SharepointAccess> => {
      const response = await api.sharepoint.connection.get({
        fetch: { signal },
      });
      if (response.error) {
        const failure = toAPIError(response.error);
        const gate = sharepointAccessFromRefusal({
          status: failure.status,
          transport: failure.transportKind !== undefined,
        });
        return gate ?? readQueryResult(Result.err(failure));
      }
      return {
        type: SHAREPOINT_ACCESS.enabled,
        connection: response.data.connection,
      };
    },
  });

/**
 * Warms the gate while a settings page loads, so its SharePoint section
 * renders with the page instead of after it. A failure only loses the warmup.
 */
export const prefetchSharepointAccess = ({
  queryClient,
  viewer: { organizationId, userId },
  routeTemplate,
}: {
  queryClient: QueryClient;
  viewer: SharepointViewer;
  routeTemplate: string;
}) =>
  detached(
    prefetchRouteQuery(
      queryClient,
      sharepointAccessOptions({ organizationId, userId }),
      (error: unknown) => {
        getAnalytics().captureError(error, {
          fingerprintKey: "prefetchSharepointAccess:failure",
          scope: { type: "request", method: "GET", routeTemplate },
        });
      },
    ),
    "sharepoint.prefetch-access",
  );

/**
 * How long a listing serves from cache, so going back up the breadcrumb does
 * not ask Microsoft for a folder the picker just showed.
 */
const SHAREPOINT_BROWSE_STALE_TIME_MS = 60_000;

type PageRequest = { cursor: string | undefined; signal: AbortSignal };

const cursorQuery = (cursor: string | undefined) =>
  cursor === undefined ? {} : { cursor };

const fetchSitesPage = async ({
  search,
  cursor,
  signal,
}: PageRequest & { search: string }) =>
  unwrapApiResponse(
    await api.sharepoint.sites.get({
      query: {
        ...(search.length === 0 ? {} : { search }),
        ...cursorQuery(cursor),
      },
      fetch: { signal },
    }),
  );

/** Followed sites, or the sites a search finds. */
export const sharepointSitesOptions = (
  { organizationId, userId }: SharepointViewer,
  search: string,
) =>
  infiniteQueryOptions({
    queryKey: [
      ...sharepointKeys.browse({ organizationId, userId }),
      "sites",
      { search },
    ],
    initialPageParam: stringCursorSeed(),
    staleTime: SHAREPOINT_BROWSE_STALE_TIME_MS,
    queryFn: async ({ pageParam, signal }) =>
      await fetchSitesPage({ search, cursor: pageParam, signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

const fetchDrivesPage = async ({
  siteId,
  cursor,
  signal,
}: PageRequest & { siteId: string | null }) =>
  unwrapApiResponse(
    await api.sharepoint.drives.get({
      query: {
        ...(siteId === null ? {} : { siteId }),
        ...cursorQuery(cursor),
      },
      fetch: { signal },
    }),
  );

/** A site's document libraries, or the member's own OneDrive when `siteId` is null. */
export const sharepointDrivesOptions = (
  { organizationId, userId }: SharepointViewer,
  siteId: string | null,
) =>
  infiniteQueryOptions({
    queryKey: [
      ...sharepointKeys.browse({ organizationId, userId }),
      "drives",
      { siteId },
    ],
    initialPageParam: stringCursorSeed(),
    staleTime: SHAREPOINT_BROWSE_STALE_TIME_MS,
    queryFn: async ({ pageParam, signal }) =>
      await fetchDrivesPage({ siteId, cursor: pageParam, signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

type FolderLocation = {
  driveId: string;
  /** A folder's item id; `null` is the drive's top level. */
  folderId: string | null;
};

const fetchChildrenPage = async ({
  driveId,
  folderId,
  cursor,
  signal,
}: PageRequest & FolderLocation) =>
  unwrapApiResponse(
    await api.sharepoint
      .drives({ driveId })
      .items({ itemId: folderId ?? SHAREPOINT_ROOT_ITEM_ID })
      .children.get({ query: cursorQuery(cursor), fetch: { signal } }),
  );

/** The files and folders directly inside one folder of a drive. */
export const sharepointChildrenOptions = (
  { organizationId, userId }: SharepointViewer,
  { driveId, folderId }: FolderLocation,
) =>
  infiniteQueryOptions({
    queryKey: [
      ...sharepointKeys.browse({ organizationId, userId }),
      "children",
      { driveId, folderId },
    ],
    initialPageParam: stringCursorSeed(),
    staleTime: SHAREPOINT_BROWSE_STALE_TIME_MS,
    queryFn: async ({ pageParam, signal }) =>
      await fetchChildrenPage({ driveId, folderId, cursor: pageParam, signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
