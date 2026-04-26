import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceView } from "@/lib/types";

export const viewsKeys = {
  all: (workspaceId: string) => ["views", workspaceId],
};

export const viewsOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: viewsKeys.all(workspaceId),
    queryFn: async ({ signal }): Promise<WorkspaceView[]> => {
      const response = await api
        .views({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
