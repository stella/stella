import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { assertPublicLawApiData } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

const DEFAULT_PAGE_SIZE = 50;
const VERSIONS_PAGE_SIZE = 200;
/**
 * Consolidated versions are read as a whole, because the switcher offers the
 * whole set. The walk is still bounded: a work that needs more pages than
 * this is a corpus fault, reported rather than silently cut short.
 */
const VERSIONS_MAX_PAGES = 5;

export type StatuteListFilters = {
  country: string;
  language?: string;
  query?: string;
};

export const statuteKeys = {
  all: ["statutes"],
  list: (filters: StatuteListFilters) => [
    ...statuteKeys.all,
    "list",
    {
      country: filters.country,
      language: filters.language,
      query: filters.query,
    },
  ],
  byId: (documentId: string) => [...statuteKeys.all, "detail", documentId],
  versions: (documentId: string) => [
    ...statuteKeys.all,
    "detail",
    documentId,
    "versions",
  ],
};

export const statutesInfiniteOptions = (filters: StatuteListFilters) =>
  infiniteQueryOptions({
    queryKey: statuteKeys.list(filters),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.law.statutes.get({
        query: {
          country: filters.country,
          limit: DEFAULT_PAGE_SIZE,
          ...(pageParam !== null && { cursor: pageParam }),
          ...(filters.language !== undefined && { language: filters.language }),
          ...(filters.query !== undefined && { query: filters.query }),
        },
        fetch: { signal },
      });

      const data = unwrapEden(response);
      assertPublicLawApiData(data, "listPublicStatutes");

      return data;
    },
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export const statuteOptions = (documentId: string) =>
  queryOptions({
    queryKey: statuteKeys.byId(documentId),
    queryFn: async ({ signal }) => {
      const response = await api.law
        .statutes({ documentId: toSafeId<"legislationDocument">(documentId) })
        .get({ fetch: { signal } });

      const data = unwrapEden(response);
      assertPublicLawApiData(data, "readPublicStatute");

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

type ReadVersionsPageOptions = {
  cursor: string | null;
  documentId: string;
  signal: AbortSignal;
};

const readStatuteVersionsPage = async ({
  cursor,
  documentId,
  signal,
}: ReadVersionsPageOptions) => {
  const response = await api.law
    .statutes({ documentId: toSafeId<"legislationDocument">(documentId) })
    .versions.get({
      query: {
        limit: VERSIONS_PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      },
      fetch: { signal },
    });

  const data = unwrapEden(response);
  assertPublicLawApiData(data, "listPublicStatuteVersions");

  return data;
};

type StatuteVersionsPage = Awaited<ReturnType<typeof readStatuteVersionsPage>>;

type ReadVersionsWalkOptions = ReadVersionsPageOptions & {
  collected: StatuteVersionsPage["items"];
  pagesLeft: number;
};

/**
 * A keyset walk is sequential by construction: each request needs the cursor
 * the previous one returned.
 */
const readStatuteVersionsFrom = async ({
  collected,
  cursor,
  documentId,
  pagesLeft,
  signal,
}: ReadVersionsWalkOptions): Promise<StatuteVersionsPage["items"]> => {
  const data = await readStatuteVersionsPage({ cursor, documentId, signal });

  collected.push(...data.items);

  if (data.nextCursor === null) {
    return collected;
  }

  if (pagesLeft <= 1) {
    getAnalytics().captureError(
      new ClientOperationError({
        action: "statutes.versions-walk",
        message: "Statute version walk stopped at the page cap",
      }),
    );

    return collected;
  }

  return await readStatuteVersionsFrom({
    collected,
    cursor: data.nextCursor,
    documentId,
    pagesLeft: pagesLeft - 1,
    signal,
  });
};

/** Every consolidated version of the work, newest window first. */
export const statuteVersionsOptions = (documentId: string) =>
  queryOptions({
    queryKey: statuteKeys.versions(documentId),
    queryFn: async ({ signal }) =>
      await readStatuteVersionsFrom({
        collected: [],
        cursor: null,
        documentId,
        pagesLeft: VERSIONS_MAX_PAGES,
        signal,
      }),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
