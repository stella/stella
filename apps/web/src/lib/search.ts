import type {
  EntityKind,
  GlobalSearchResultType,
  GlobalSearchUpdatedWithin,
} from "@stll/api/types";
import { infiniteQueryOptions, keepPreviousData } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

type SearchParams = {
  query: string;
  workspaceId?: string;
  types?: GlobalSearchResultType[];
  kinds?: EntityKind[];
  editedByUserId?: string;
  mimeTypes?: string[];
  updatedWithin?: GlobalSearchUpdatedWithin;
  limit?: number;
};

type SearchAISummaryParams = {
  query: string;
  locale: string;
  originalQuery?: string;
  workspaceId?: string;
  types?: GlobalSearchResultType[];
  editedByUserId?: string;
  mimeTypes?: string[];
  updatedWithin?: GlobalSearchUpdatedWithin;
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
          ...(params.workspaceId !== undefined && {
            workspaceId: toSafeId<"workspace">(params.workspaceId),
          }),
          ...(params.kinds !== undefined && { kinds: params.kinds }),
          ...(params.types !== undefined && { types: params.types }),
          ...(params.editedByUserId !== undefined && {
            editedByUserId: params.editedByUserId,
          }),
          ...(params.mimeTypes !== undefined && {
            mimeTypes: params.mimeTypes,
          }),
          ...(params.updatedWithin !== undefined && {
            updatedWithin: params.updatedWithin,
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
    ...(params.workspaceId !== undefined && {
      workspaceId: toSafeId<"workspace">(params.workspaceId),
    }),
    ...(params.types !== undefined && { types: params.types }),
    ...(params.editedByUserId !== undefined && {
      editedByUserId: params.editedByUserId,
    }),
    ...(params.mimeTypes !== undefined && { mimeTypes: params.mimeTypes }),
    ...(params.updatedWithin !== undefined && {
      updatedWithin: params.updatedWithin,
    }),
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
    ...(params.workspaceId !== undefined && {
      workspaceId: toSafeId<"workspace">(params.workspaceId),
    }),
    ...(params.types !== undefined && { types: params.types }),
    ...(params.editedByUserId !== undefined && {
      editedByUserId: params.editedByUserId,
    }),
    ...(params.mimeTypes !== undefined && { mimeTypes: params.mimeTypes }),
    ...(params.updatedWithin !== undefined && {
      updatedWithin: params.updatedWithin,
    }),
    ...(params.limit !== undefined && { limit: params.limit }),
  });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data;
};
