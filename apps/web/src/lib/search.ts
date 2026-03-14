import { infiniteQueryOptions } from "@tanstack/react-query";

import type { EntityKind } from "@stella/api/types";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

type SearchParams = {
  query: string;
  workspaceId?: string;
  kinds?: EntityKind[];
  limit?: number;
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
          workspaceId: params.workspaceId,
          kinds: params.kinds,
          cursor: pageParam,
          limit: params.limit,
        },
        { fetch: { signal } },
      );

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: params.query.length > 0,
  });
