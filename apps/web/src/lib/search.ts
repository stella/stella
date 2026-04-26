import { infiniteQueryOptions } from "@tanstack/react-query";

import type { EntityKind } from "@stella/api/types";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

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
          ...(params.workspaceId !== undefined && {
            workspaceId: toSafeId<"workspace">(params.workspaceId),
          }),
          ...(params.kinds !== undefined && { kinds: params.kinds }),
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
    enabled: params.query.length > 0,
  });
