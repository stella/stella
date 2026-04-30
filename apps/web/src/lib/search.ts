import type { EntityKind, GlobalSearchResultType } from "@stll/api/types";
import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

export type SearchableFacet = "editor" | "workspace" | "mimeType";

type SearchFacetParams = {
  facet: SearchableFacet;
  search: string;
  query: string;
  workspaceIds?: string[];
  types?: GlobalSearchResultType[];
  editedByUserIds?: string[];
  mimeTypes?: string[];
  updatedFrom?: string;
  updatedTo?: string;
  limit?: number;
};

type SearchParams = {
  query: string;
  workspaceIds?: string[];
  types?: GlobalSearchResultType[];
  kinds?: EntityKind[];
  editedByUserIds?: string[];
  mimeTypes?: string[];
  updatedFrom?: string;
  updatedTo?: string;
  limit?: number;
};

type SearchAISummaryParams = {
  query: string;
  locale: string;
  originalQuery?: string;
  workspaceIds?: string[];
  types?: GlobalSearchResultType[];
  editedByUserIds?: string[];
  mimeTypes?: string[];
  updatedFrom?: string;
  updatedTo?: string;
  limit?: number;
};

type SearchSummaryCitation = {
  id: string;
  number: number;
  title: string;
  type: string;
  reason: string;
};

type CreateSearchSummaryChatParams = SearchAISummaryParams & {
  title: string;
  summary: string;
  citations: SearchSummaryCitation[];
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
        {
          query: params.query,
          ...(params.workspaceIds !== undefined &&
            params.workspaceIds.length > 0 && {
              workspaceIds: params.workspaceIds.map((id) =>
                toSafeId<"workspace">(id),
              ),
            }),
          ...(params.kinds !== undefined && { kinds: params.kinds }),
          ...(params.types !== undefined && { types: params.types }),
          ...(params.editedByUserIds !== undefined &&
            params.editedByUserIds.length > 0 && {
              editedByUserIds: params.editedByUserIds,
            }),
          ...(params.mimeTypes !== undefined && {
            mimeTypes: params.mimeTypes,
          }),
          ...(params.updatedFrom !== undefined && {
            updatedFrom: params.updatedFrom,
          }),
          ...(params.updatedTo !== undefined && {
            updatedTo: params.updatedTo,
          }),
          ...(pageParam !== undefined && { cursor: pageParam }),
          ...(params.limit !== undefined && { limit: params.limit }),
        },
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
        {
          facet: params.facet,
          search: params.search,
          query: params.query,
          ...(params.workspaceIds !== undefined &&
            params.workspaceIds.length > 0 && {
              workspaceIds: params.workspaceIds.map((id) =>
                toSafeId<"workspace">(id),
              ),
            }),
          ...(params.types !== undefined && { types: params.types }),
          ...(params.editedByUserIds !== undefined &&
            params.editedByUserIds.length > 0 && {
              editedByUserIds: params.editedByUserIds,
            }),
          ...(params.mimeTypes !== undefined && {
            mimeTypes: params.mimeTypes,
          }),
          ...(params.updatedFrom !== undefined && {
            updatedFrom: params.updatedFrom,
          }),
          ...(params.updatedTo !== undefined && {
            updatedTo: params.updatedTo,
          }),
          ...(params.limit !== undefined && { limit: params.limit }),
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

export const refineSearchQuery = async ({
  query,
  locale,
}: {
  query: string;
  locale: string;
}) => {
  const response = await api.search.refine.post({ query, locale });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data;
};

export const summarizeSearchResults = async (params: SearchAISummaryParams) => {
  const response = await api.search.summary.post({
    query: params.query,
    locale: params.locale,
    ...(params.originalQuery !== undefined && {
      originalQuery: params.originalQuery,
    }),
    ...(params.workspaceIds !== undefined &&
      params.workspaceIds.length > 0 && {
        workspaceIds: params.workspaceIds.map((id) =>
          toSafeId<"workspace">(id),
        ),
      }),
    ...(params.types !== undefined && { types: params.types }),
    ...(params.editedByUserIds !== undefined &&
      params.editedByUserIds.length > 0 && {
        editedByUserIds: params.editedByUserIds,
      }),
    ...(params.mimeTypes !== undefined && { mimeTypes: params.mimeTypes }),
    ...(params.updatedFrom !== undefined && {
      updatedFrom: params.updatedFrom,
    }),
    ...(params.updatedTo !== undefined && { updatedTo: params.updatedTo }),
    ...(params.limit !== undefined && { limit: params.limit }),
  });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data;
};

export const createSearchSummaryChatThread = async (
  params: CreateSearchSummaryChatParams,
) => {
  const response = await api.search.summary.chat.post({
    query: params.query,
    title: params.title,
    summary: params.summary,
    citations: params.citations.map((citation) => ({
      number: citation.number,
    })),
    ...(params.originalQuery !== undefined && {
      originalQuery: params.originalQuery,
    }),
    ...(params.workspaceIds !== undefined &&
      params.workspaceIds.length > 0 && {
        workspaceIds: params.workspaceIds.map((id) =>
          toSafeId<"workspace">(id),
        ),
      }),
    ...(params.types !== undefined && { types: params.types }),
    ...(params.editedByUserIds !== undefined &&
      params.editedByUserIds.length > 0 && {
        editedByUserIds: params.editedByUserIds,
      }),
    ...(params.mimeTypes !== undefined && { mimeTypes: params.mimeTypes }),
    ...(params.updatedFrom !== undefined && {
      updatedFrom: params.updatedFrom,
    }),
    ...(params.updatedTo !== undefined && { updatedTo: params.updatedTo }),
    ...(params.limit !== undefined && { limit: params.limit }),
  });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data;
};
