import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { WorkspaceProperty } from "@/lib/types";

export const propertiesKeys = {
  all: (workspaceId: string) => ["properties", workspaceId],
};

export const propertiesOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: propertiesKeys.all(workspaceId),
    queryFn: async ({ signal }): Promise<WorkspaceProperty[]> => {
      const response = await api
        .properties({ workspaceId })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    refetchOnMount: false,
  });
