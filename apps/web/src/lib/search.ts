import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
} from "@tanstack/react-query";

import type { EntityKind, GlobalSearchResultType } from "@stll/api/types";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { DAY_IN_MS } from "@/lib/time";

export const TIME_PRESETS = ["day", "week", "month", "year"] as const;
export type TimePreset = (typeof TIME_PRESETS)[number];

const TIME_PRESET_DURATIONS_MS = {
  day: DAY_IN_MS,
  week: 7 * DAY_IN_MS,
  month: 30 * DAY_IN_MS,
  year: 365 * DAY_IN_MS,
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
  kinds: EntityKind[];
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

// Query keys are reconstructed field-by-field (never spread) so extra
// properties on a caller-supplied params object cannot leak into the cache
// identity and trigger spurious refetches.
const searchKeys = {
  all: ["search"] as const,
  query: (params: SearchParams) =>
    [
      ...searchKeys.all,
      {
        query: params.query,
        workspaceIds: params.workspaceIds,
        types: params.types,
        kinds: params.kinds,
        editedByUserIds: params.editedByUserIds,
        mimeTypes: params.mimeTypes,
        updatedFrom: params.updatedFrom,
        updatedTo: params.updatedTo,
        limit: params.limit,
      },
    ] as const,
  facet: (params: SearchFacetParams) =>
    [
      ...searchKeys.all,
      "facet",
      {
        facet: params.facet,
        search: params.search,
        query: params.query,
        workspaceIds: params.workspaceIds,
        types: params.types,
        kinds: params.kinds,
        editedByUserIds: params.editedByUserIds,
        mimeTypes: params.mimeTypes,
        updatedFrom: params.updatedFrom,
        updatedTo: params.updatedTo,
        limit: params.limit,
      },
    ] as const,
};

export const searchInfiniteOptions = (params: SearchParams) =>
  infiniteQueryOptions({
    queryKey: searchKeys.query(params),
    queryFn: async ({ signal, pageParam }) => {
      const response = await api.search.post(
        {
          query: params.query,
          workspaceIds: params.workspaceIds.map((id) =>
            toSafeId<"workspace">(id),
          ),
          ...(params.kinds ? { kinds: params.kinds } : {}),
          ...(params.types ? { types: params.types } : {}),
          ...(params.editedByUserIds
            ? { editedByUserIds: params.editedByUserIds }
            : {}),
          ...(params.mimeTypes ? { mimeTypes: params.mimeTypes } : {}),
          ...(params.updatedFrom ? { updatedFrom: params.updatedFrom } : {}),
          ...(params.updatedTo ? { updatedTo: params.updatedTo } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        },
        { fetch: { signal } },
      );

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: params.query.length > 0,
  });

export const searchFacetOptions = (params: SearchFacetParams) =>
  queryOptions({
    queryKey: searchKeys.facet(params),
    queryFn: async ({ signal }) => {
      const response = await api.search.facets.post(
        {
          facet: params.facet,
          search: params.search,
          query: params.query,
          workspaceIds: params.workspaceIds.map((id) =>
            toSafeId<"workspace">(id),
          ),
          ...(params.types ? { types: params.types } : {}),
          ...(params.kinds ? { kinds: params.kinds } : {}),
          ...(params.editedByUserIds
            ? { editedByUserIds: params.editedByUserIds }
            : {}),
          ...(params.mimeTypes ? { mimeTypes: params.mimeTypes } : {}),
          ...(params.updatedFrom ? { updatedFrom: params.updatedFrom } : {}),
          ...(params.updatedTo ? { updatedTo: params.updatedTo } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        },
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
