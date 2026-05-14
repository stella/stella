import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

export const anonymizationTermsKeys = {
  all: (workspaceId: string): string[] => ["anonymization-terms", workspaceId],
};

export const anonymizationTermsOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: anonymizationTermsKeys.all(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["anonymization-terms"].get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
