import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { workspaceAnonymizationTermsQueryRoot } from "@/lib/resource-query-roots.logic";
import { toSafeId } from "@/lib/safe-id";

export const anonymizationTermsKeys = {
  all: workspaceAnonymizationTermsQueryRoot,
};

export const anonymizationTermsOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: anonymizationTermsKeys.all(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["anonymization-terms"].get({ fetch: { signal } });

      return unwrapEden(response);
    },
  });
