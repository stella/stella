import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

export const viewsKeys = {
  all: (workspaceId: string) => ["views", workspaceId],
};

export const viewsOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: viewsKeys.all(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .views({ workspaceId })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
