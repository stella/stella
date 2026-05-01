import { useMutation } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type { SearchAISummaryParams } from "@/lib/search";
import { stripUndefined } from "@/lib/utils";

type SearchSummaryCitation = {
  id: string;
  number: number;
  title: string;
  type: string;
  reason: string;
};

type CreateSearchSummaryChatVars = SearchAISummaryParams & {
  title: string;
  summary: string;
  citations: SearchSummaryCitation[];
};

export type SearchSummaryData = NonNullable<
  Awaited<ReturnType<typeof api.search.summary.post>>["data"]
>;

export function useSummarizeSearchMutation() {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async (params: SearchAISummaryParams) => {
      const response = await api.search.summary.post(
        stripUndefined({
          query: params.query,
          locale: params.locale,
          originalQuery: params.originalQuery,
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
      );

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
}

export function useRefineSearchMutation() {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({
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
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
}

export function useCreateSearchSummaryChatMutation() {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async (vars: CreateSearchSummaryChatVars) => {
      const response = await api.search.summary.chat.post(
        stripUndefined({
          query: vars.query,
          title: vars.title,
          summary: vars.summary,
          citations: vars.citations.map((citation) => ({
            number: citation.number,
          })),
          originalQuery: vars.originalQuery,
          workspaceIds: vars.workspaceIds.map((id) =>
            toSafeId<"workspace">(id),
          ),
          types: vars.types,
          editedByUserIds: vars.editedByUserIds,
          mimeTypes: vars.mimeTypes,
          updatedFrom: vars.updatedFrom,
          updatedTo: vars.updatedTo,
          limit: vars.limit,
        }),
      );

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
}
