import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

export const playbooksKeys = {
  all: (workspaceId: string) => ["playbooks", workspaceId],
};

export const playbooksOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: playbooksKeys.all(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .playbooks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .get({ query: {}, fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.items;
    },
  });
