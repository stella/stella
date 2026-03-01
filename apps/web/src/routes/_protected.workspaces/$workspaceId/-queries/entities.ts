import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

export const entitiesKeys = {
  all: (workspaceId: string) => ["entities", workspaceId],
};

export const entitiesOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: entitiesKeys.all(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .entities({ workspaceId })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
