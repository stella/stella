import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { assertPublicLawApiData } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

const DEFAULT_PAGE_SIZE = 50;
const VERSIONS_PAGE_SIZE = 100;

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
  byId: (documentId: string) => [...statuteKeys.all, documentId],
  versions: (documentId: string) => [
    ...statuteKeys.all,
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

export const statuteVersionsOptions = (documentId: string) =>
  queryOptions({
    queryKey: statuteKeys.versions(documentId),
    queryFn: async ({ signal }) => {
      const response = await api.law
        .statutes({ documentId: toSafeId<"legislationDocument">(documentId) })
        .versions.get({
          query: { limit: VERSIONS_PAGE_SIZE },
          fetch: { signal },
        });

      const data = unwrapEden(response);
      assertPublicLawApiData(data, "listPublicStatuteVersions");

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
