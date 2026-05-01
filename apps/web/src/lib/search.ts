import type { EntityKind, GlobalSearchResultType } from "@stll/api/types";
import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { stripUndefined } from "@/lib/utils";

export const TIME_PRESETS = ["day", "week", "month", "year"] as const;
export type TimePreset = (typeof TIME_PRESETS)[number];

const TIME_PRESET_DURATIONS_MS = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
} as const satisfies Record<TimePreset, number>;

/**
 * Compute the ISO timestamp `now() - preset duration`. Callers should
 * resolve this once per logical search (when filters or the query
 * change) and reuse it across pagination, so the cutoff stays stable
 * for the duration of a `useInfiniteQuery` session.
 */
export const presetUpdatedFrom = (preset: TimePreset): string =>
  new Date(Date.now() - TIME_PRESET_DURATIONS_MS[preset]).toISOString();

export type SearchableFacet = "editor" | "workspace" | "mimeType";

export type SearchParams = {
  query: string;
  workspaceIds: string[];
  types: GlobalSearchResultType[];
  kinds: EntityKind[];
  editedByUserIds: string[];
  mimeTypes: string[];
  updatedFrom?: string | undefined;
  updatedTo?: string | undefined;
  limit?: number | undefined;
};

type SearchFacetParams = {
  facet: SearchableFacet;
  search: string;
  query: string;
  workspaceIds: string[];
  types: GlobalSearchResultType[];
  editedByUserIds: string[];
  mimeTypes: string[];
  updatedFrom?: string | undefined;
  updatedTo?: string | undefined;
  limit?: number | undefined;
};

export type SearchAISummaryParams = {
  query: string;
  locale: string;
  originalQuery?: string | undefined;
  workspaceIds: string[];
  types: GlobalSearchResultType[];
  editedByUserIds: string[];
  mimeTypes: string[];
  updatedFrom?: string | undefined;
  updatedTo?: string | undefined;
  limit?: number | undefined;
};

const searchKeys = {
  all: ["search"] as const,
  query: (params: SearchParams) => [...searchKeys.all, params] as const,
};

export const searchInfiniteOptions = (params: SearchParams) =>
  infiniteQueryOptions({
    queryKey: searchKeys.query(params),
    queryFn: async ({ signal, pageParam }) => {
      const response = await api.search.post(
        stripUndefined({
          query: params.query,
          workspaceIds: params.workspaceIds.map((id) =>
            toSafeId<"workspace">(id),
          ),
          kinds: params.kinds,
          types: params.types,
          editedByUserIds: params.editedByUserIds,
          mimeTypes: params.mimeTypes,
          updatedFrom: params.updatedFrom,
          updatedTo: params.updatedTo,
          cursor: pageParam,
          limit: params.limit,
        }),
        { fetch: { signal } },
      );

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: params.query.length > 0,
  });

export const searchFacetOptions = (params: SearchFacetParams) =>
  queryOptions({
    queryKey: [...searchKeys.all, "facet", params] as const,
    queryFn: async ({ signal }) => {
      const response = await api.search.facets.post(
        stripUndefined({
          facet: params.facet,
          search: params.search,
          query: params.query,
          workspaceIds: params.workspaceIds.map((id) =>
            toSafeId<"workspace">(id),
          ),
          types: params.types,
          editedByUserIds: params.editedByUserIds,
          mimeTypes: params.mimeTypes,
          updatedFrom: params.updatedFrom,
          updatedTo: params.updatedTo,
          limit: params.limit,
        }),
        { fetch: { signal } },
      );

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    enabled: params.query.length > 0,
    placeholderData: keepPreviousData,
  });
